"""
Goal decomposition. Breaks an action task into a starting URL,
sub-goals, and a success indicator.
"""

from __future__ import annotations

from app.models import llm_call_json, CostTracker

PLAN_TEMPLATE = (
    'You are a web task planner. Given a user goal, produce a plan.\n\n'
    'Output ONLY valid JSON with these keys:\n'
    '- "url": the most specific starting URL that gets closest to the goal (use https://). '
    'For example, use en.wikipedia.org/wiki/Main_Page not www.wikipedia.org. '
    'Use the actual content page, not a language picker or homepage splash.\n'
    '- "sub_goals": array of 1-5 short action steps\n'
    '- "success": one sentence describing what success looks like\n\n'
    'User goal: '
)


async def plan_task(goal: str, tracker: CostTracker) -> dict:
    """
    Break a goal into a plan with starting URL, sub-goals, and success indicator.
    Returns a dict with keys: url, sub_goals, success.
    Falls back to a Google search if planning fails.
    """
    messages = [
        {
            "role": "user",
            "content": PLAN_TEMPLATE + goal[:200],
        }
    ]
    result = await llm_call_json(messages, tracker, temperature=0.0, max_tokens=200)

    if result and "url" in result:
        url = result.get("url", "https://www.google.com")
        # Fix common URL issues
        if url == "https://www.wikipedia.org" or url == "https://www.wikipedia.org/":
            url = "https://en.wikipedia.org/wiki/Main_Page"
        if not url.startswith("http"):
            url = "https://" + url
        return {
            "url": url,
            "sub_goals": result.get("sub_goals", [goal]),
            "success": result.get("success", "Task completed"),
        }

    # Fallback: start from Google search
    search_query = goal.replace(" ", "+")[:80]
    return {
        "url": f"https://www.google.com/search?q={search_query}",
        "sub_goals": [goal],
        "success": "Task completed",
    }
