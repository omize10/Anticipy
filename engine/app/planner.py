"""
Goal decomposition. Breaks an action task into a starting URL,
sub-goals, and a success indicator.
"""

from __future__ import annotations

import re

from app.models import llm_call_json, CostTracker

PLAN_TEMPLATE = (
    'You are a web task planner. Given a user goal, produce a plan.\n\n'
    'Output ONLY valid JSON with these keys:\n'
    '- "url": the best starting URL for the task (use https://)\n'
    '- "sub_goals": array of 2-6 short action steps\n'
    '- "success": what the page should show when done\n\n'
    'User goal: '
)


def _extract_url_from_goal(goal: str) -> str | None:
    """Extract an explicit URL or domain from the user's goal text."""
    # Match full URLs
    url_match = re.search(r'https?://\S+', goal)
    if url_match:
        return url_match.group(0).rstrip('.,;')

    # Match domain names like "books.toscrape.com" or "opentable.com"
    domain_match = re.search(r'\b([\w-]+\.[\w-]+\.\w+|[\w-]+\.(?:com|org|net|io|ca|co|app|dev))\b', goal, re.IGNORECASE)
    if domain_match:
        return "https://" + domain_match.group(0)

    return None


async def plan_task(goal: str, tracker: CostTracker) -> dict:
    """
    Break a goal into a plan with starting URL, sub-goals, and success indicator.
    Returns a dict with keys: url, sub_goals, success.
    Falls back to a Google search if planning fails.
    """
    # First: try to extract URL directly from the goal text
    explicit_url = _extract_url_from_goal(goal)

    messages = [
        {
            "role": "user",
            "content": PLAN_TEMPLATE + goal[:200],
        }
    ]
    result = await llm_call_json(messages, tracker, temperature=0.0, max_tokens=200)

    if result and "url" in result:
        url = result.get("url", "")
        if not url.startswith("http"):
            url = "https://" + url if url else ""
        # Prefer explicit URL from goal if LLM gave a different domain
        if explicit_url and url:
            # Use explicit URL unless LLM gave a more specific path on the same domain
            from urllib.parse import urlparse
            explicit_domain = urlparse(explicit_url).netloc
            llm_domain = urlparse(url).netloc
            if explicit_domain != llm_domain:
                url = explicit_url
        elif explicit_url and not url:
            url = explicit_url
        if not url:
            url = explicit_url or "https://www.google.com"
        return {
            "url": url,
            "sub_goals": result.get("sub_goals", [goal]),
            "success": result.get("success", "Task completed"),
        }

    # Fallback: use explicit URL if found, otherwise Google search
    if explicit_url:
        return {
            "url": explicit_url,
            "sub_goals": [goal],
            "success": "Task completed",
        }

    search_query = goal.replace(" ", "+")[:80]
    return {
        "url": f"https://www.google.com/search?q={search_query}",
        "sub_goals": [goal],
        "success": "Task completed",
    }
