"""
Goal decomposition. Breaks an action task into a starting URL,
sub-goals, and a success indicator.
"""

from __future__ import annotations

import re
from urllib.parse import urlparse

from app.models import llm_call_json, CostTracker

PLAN_TEMPLATE = (
    'You are a web task planner. Given a user goal, produce a plan.\n\n'
    'Output ONLY valid JSON with these keys:\n'
    '- "url": the best starting URL for the task (use https://)\n'
    '- "sub_goals": array of 2-6 short action steps\n'
    '- "success": what the page should show when done\n\n'
    'User goal: '
)

# Schemes the agent is allowed to navigate to. Anything else (javascript:,
# data:, file:, chrome:, about:) is rejected outright and we fall back to a
# Google search.
_ALLOWED_SCHEMES = {"http", "https"}


def _is_safe_url(url: str) -> bool:
    """Return True if the URL is well-formed http(s) with a real host."""
    if not url or not isinstance(url, str):
        return False
    try:
        parsed = urlparse(url)
    except Exception:
        return False
    if parsed.scheme.lower() not in _ALLOWED_SCHEMES:
        return False
    if not parsed.netloc:
        return False
    # Reject loopback / link-local hosts so the agent doesn't poke our own
    # internal services if a user's prompt tricks the LLM into suggesting them.
    host = parsed.hostname or ""
    blocked_hosts = {
        "localhost", "127.0.0.1", "0.0.0.0", "::1",
        "metadata.google.internal", "169.254.169.254",
    }
    if host.lower() in blocked_hosts:
        return False
    if host.startswith("10.") or host.startswith("192.168.") or host.startswith("169.254."):
        return False
    return True


def _extract_url_from_goal(goal: str) -> str | None:
    """Extract an explicit URL or domain from the user's goal text."""
    # Match full URLs
    url_match = re.search(r'https?://\S+', goal)
    if url_match:
        candidate = url_match.group(0).rstrip('.,;)')
        if _is_safe_url(candidate):
            return candidate
        return None

    # Match domain names like "books.toscrape.com" or "opentable.com"
    domain_match = re.search(r'\b([\w-]+\.[\w-]+\.\w+|[\w-]+\.(?:com|org|net|io|ca|co|app|dev))\b', goal, re.IGNORECASE)
    if domain_match:
        candidate = "https://" + domain_match.group(0)
        if _is_safe_url(candidate):
            return candidate

    return None


async def plan_task(goal: str, tracker: CostTracker) -> dict:
    """
    Break a goal into a plan with starting URL, sub-goals, and success indicator.
    Returns a dict with keys: url, sub_goals, success.
    Falls back to a Google search if planning fails or the LLM proposes an
    unsafe URL.
    """
    if not goal or not goal.strip():
        return {
            "url": "https://www.google.com",
            "sub_goals": [],
            "success": "",
        }

    # First: try to extract URL directly from the goal text
    explicit_url = _extract_url_from_goal(goal)

    messages = [
        {
            "role": "user",
            "content": PLAN_TEMPLATE + goal[:200],
        }
    ]
    try:
        result = await llm_call_json(messages, tracker, temperature=0.0, max_tokens=200)
    except Exception:
        result = None

    if result and isinstance(result, dict) and "url" in result:
        url = result.get("url", "") or ""
        if isinstance(url, str) and url and not url.startswith("http"):
            url = "https://" + url
        # Validate URL safety before trusting it
        if not _is_safe_url(url):
            url = ""
        # Prefer explicit URL from goal if LLM gave a different domain
        if explicit_url and url:
            try:
                explicit_domain = urlparse(explicit_url).netloc
                llm_domain = urlparse(url).netloc
                if explicit_domain != llm_domain:
                    url = explicit_url
            except Exception:
                url = explicit_url
        elif explicit_url and not url:
            url = explicit_url
        if not url:
            url = explicit_url or "https://www.google.com"

        sub_goals_raw = result.get("sub_goals", [goal])
        sub_goals = (
            [str(g)[:200] for g in sub_goals_raw[:6]]
            if isinstance(sub_goals_raw, list)
            else [goal]
        )
        success = result.get("success", "Task completed")
        if not isinstance(success, str):
            success = "Task completed"
        return {
            "url": url,
            "sub_goals": sub_goals or [goal],
            "success": success[:200],
        }

    # Fallback: use explicit URL if found, otherwise Google search
    if explicit_url:
        return {
            "url": explicit_url,
            "sub_goals": [goal],
            "success": "Task completed",
        }

    search_query = re.sub(r"\s+", "+", goal.strip())[:80]
    # Strip any non-URL-safe chars defensively
    search_query = re.sub(r"[^\w+\-]", "", search_query)
    return {
        "url": f"https://www.google.com/search?q={search_query}",
        "sub_goals": [goal],
        "success": "Task completed",
    }
