"""
Goal verification. After task completion, verify outcome matches the goal.
"""

from __future__ import annotations

from app.models import llm_call_json, CostTracker

VERIFY_PROMPT = """You are verifying whether a web task was completed successfully.

Goal: {goal}
Success indicator: {success}
Current URL: {url}
Current page title: {title}
Page content excerpt: {content}
Actions taken: {actions}

Was the goal achieved?
Output ONLY: {{"done": true, "confidence": 0.0-1.0, "reason": "brief explanation"}}
or: {{"done": false, "confidence": 0.0-1.0, "reason": "what's missing"}}"""


async def verify_goal(
    goal: str,
    success_indicator: str,
    url: str,
    title: str,
    page_content: str,
    actions_taken: list[str],
    tracker: CostTracker,
) -> dict:
    """
    Verify if the goal has been achieved.
    Returns {"done": bool, "confidence": float, "reason": str}.
    """
    actions_str = " -> ".join(actions_taken[-10:]) if actions_taken else "none"
    content_excerpt = page_content[:300] if page_content else "no content"

    messages = [
        {
            "role": "user",
            "content": VERIFY_PROMPT.format(
                goal=goal[:120],
                success=success_indicator[:100],
                url=url[:120],
                title=title[:80],
                content=content_excerpt,
                actions=actions_str[:200],
            ),
        }
    ]

    result = await llm_call_json(messages, tracker, temperature=0.0, max_tokens=80)

    if result and "done" in result:
        return {
            "done": bool(result.get("done", False)),
            "confidence": float(result.get("confidence", 0.0)),
            "reason": str(result.get("reason", "")),
        }

    # Default: assume not done if verification fails
    return {"done": False, "confidence": 0.0, "reason": "verification failed"}


async def mid_task_check(
    goal: str,
    url: str,
    title: str,
    actions_taken: list[str],
    tracker: CostTracker,
) -> dict:
    """
    Quick mid-task sanity check: are we on the right track?
    Returns {"on_track": bool, "suggestion": str}.
    """
    actions_str = " -> ".join(actions_taken[-5:]) if actions_taken else "none"

    prompt = f"""Quick check: is this browser session on track?
Goal: {goal[:120]}
Current URL: {url[:120]}
Page title: {title[:80]}
Recent actions: {actions_str[:150]}

Output ONLY: {{"on_track": true/false, "suggestion": "brief suggestion if off track"}}"""

    messages = [{"role": "user", "content": prompt}]
    result = await llm_call_json(messages, tracker, temperature=0.0, max_tokens=60)

    if result and "on_track" in result:
        return {
            "on_track": bool(result.get("on_track", True)),
            "suggestion": str(result.get("suggestion", "")),
        }

    return {"on_track": True, "suggestion": ""}
