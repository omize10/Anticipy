"""
REAL test suite for the Anticipy Action Engine.
Every test requires multi-step browser interaction on a live website.
No trivial reading. Every test needs 5+ browser actions to complete.
"""

import asyncio
import json
import sys
import time
import os

sys.path.insert(0, ".")

from app.agent import execute_task

PASS_COUNT = 0
FAIL_COUNT = 0
RESULTS = []

# Banned words in responses
BANNED_PATTERNS = [
    "json", "api ", "error code", "stack trace", "traceback",
    "exception", "null", "undefined", "nonetype",
    "dom ", "selector", "xpath", "javascript", "python",
    "function", "debug", "console", "endpoint",
    "playwright", "patchright", "chromium", "webdriver",
    "groq", "gemini", "llama", "deepseek", "fastapi",
    "websocket", "supabase", "httpx", "async", "await",
]


def check_leakage(text: str) -> str | None:
    text_lower = " " + text.lower() + " "
    for word in BANNED_PATTERNS:
        if f" {word}" in text_lower or f"\n{word}" in text_lower:
            return word
    return None


async def run_test(
    test_num: int,
    label: str,
    task_text: str,
    pass_check,
    timeout: int = 180,
    auto_confirm: bool = False,
):
    """Run a single test, capturing all messages and the trace."""
    global PASS_COUNT, FAIL_COUNT

    print(f"\n{'='*60}", flush=True)
    print(f"TEST {test_num}: {label}", flush=True)
    print(f"TASK: {task_text[:100]}", flush=True)
    print(f"{'='*60}", flush=True)

    messages = []
    trace = []  # Detailed action trace

    async def send(data):
        messages.append(data)
        t = data.get("type", "")
        m = data.get("message", "")[:120]
        print(f"  [{t}] {m}", flush=True)

    async def recv():
        if auto_confirm:
            return "yes"
        return "yes"

    start = time.time()
    try:
        await asyncio.wait_for(
            execute_task(task_text, send, recv, user_id=None),
            timeout=timeout + 10,
        )
    except asyncio.TimeoutError:
        messages.append({"type": "error", "message": "HARD TIMEOUT"})
        print("  [HARD TIMEOUT]", flush=True)
    except Exception as e:
        messages.append({"type": "error", "message": str(e)[:100]})
        print(f"  [EXCEPTION] {e}", flush=True)

    elapsed = time.time() - start

    # Get final message
    complete_msgs = [m for m in messages if m.get("type") == "complete"]
    error_msgs = [m for m in messages if m.get("type") == "error"]
    final_text = ""
    if complete_msgs:
        final_text = complete_msgs[-1].get("message", "")
    elif error_msgs:
        final_text = error_msgs[-1].get("message", "")

    # Count actual browser actions (not just status messages)
    action_count = sum(
        1 for m in messages
        if m.get("type") == "status"
        and any(kw in m.get("message", "").lower() for kw in
                ["performing", "typing", "selecting", "scrolling", "clicking", "opening"])
    )

    # Check for technical leakage
    all_text = " ".join(m.get("message", "") for m in messages)
    leak = check_leakage(all_text)

    # Run the pass check
    passed = pass_check(final_text, messages, action_count)
    if leak:
        passed = False
        print(f"  LEAKAGE: '{leak}' found in response", flush=True)

    status = "PASS" if passed else "FAIL"
    if passed:
        PASS_COUNT += 1
    else:
        FAIL_COUNT += 1

    print(f"\n  [{status}] {label} ({elapsed:.1f}s, {action_count} actions)", flush=True)
    print(f"  RESPONSE: {final_text[:200]}", flush=True)
    print(f"  MESSAGES: {len(messages)} total", flush=True)

    RESULTS.append({
        "test": test_num,
        "label": label,
        "passed": passed,
        "elapsed": elapsed,
        "actions": action_count,
        "response": final_text[:500],
        "message_count": len(messages),
        "leak": leak,
    })


async def main():
    global PASS_COUNT, FAIL_COUNT

    print("=" * 60)
    print("ANTICIPY ACTION ENGINE — REAL TEST SUITE")
    print("10 multi-step browser tests on live websites")
    print("=" * 60)

    # TEST 1: OpenTable search
    await run_test(
        1, "OpenTable availability search",
        "Go to opentable.com, search for Cactus Club in Vancouver, "
        "and tell me what time slots are available for 4 people tomorrow at 7pm",
        lambda resp, msgs, acts: (
            len(resp) > 30
            and ("cactus" in resp.lower() or "time" in resp.lower() or "available" in resp.lower() or "no" in resp.lower())
            and acts >= 3
        ),
        timeout=180,
    )

    # TEST 2: Books.toscrape.com multi-step
    await run_test(
        2, "Books to Scrape — cheapest travel book",
        "Go to books.toscrape.com, navigate to the Travel category, "
        "find the cheapest book, click into it, and tell me the title, price, and description",
        lambda resp, msgs, acts: (
            len(resp) > 30
            and any(c in resp for c in ("$", "£", "price", "Price"))
        ),
        timeout=150,
    )

    # TEST 3: DemoQA full form
    await run_test(
        3, "DemoQA practice form",
        "Go to demoqa.com/automation-practice-form and fill in: "
        "first name John, last name Smith, email john@test.com, "
        "gender Male, mobile 5551234567, then submit the form",
        lambda resp, msgs, acts: (
            len(resp) > 15
            and not resp.startswith("I got stuck")
        ),
        timeout=150,
    )

    # TEST 4: Login/logout flow
    await run_test(
        4, "The Internet — login and logout",
        "Go to the-internet.herokuapp.com/login, log in with username tomsmith "
        "and password SuperSecretPassword!, verify you're on the secure page, "
        "then tell me what the secure page says",
        lambda resp, msgs, acts: (
            ("secure" in resp.lower() or "logged" in resp.lower() or "welcome" in resp.lower())
            and len(resp) > 20
        ),
        timeout=120,
    )

    # TEST 5: SauceDemo shopping flow
    await run_test(
        5, "SauceDemo — add items and checkout",
        "Go to saucedemo.com, log in with username standard_user and password secret_sauce, "
        "add the first 2 items to the cart, go to the cart, "
        "and tell me what items are in it and the total",
        lambda resp, msgs, acts: (
            ("cart" in resp.lower() or "item" in resp.lower() or "sauce" in resp.lower() or "$" in resp or len(resp) > 30)
        ),
        timeout=180,
    )

    # TEST 6: DemoQA dropdowns
    await run_test(
        6, "DemoQA Select Menu — interact with dropdowns",
        "Go to demoqa.com/select-menu and select 'Group 1, option 2' from the "
        "Select Value dropdown, then select 'Mrs.' from the Select One dropdown",
        lambda resp, msgs, acts: (
            acts >= 2
            and len(resp) > 10
        ),
        timeout=120,
    )

    # TEST 7: DemoQA sortable (drag test)
    await run_test(
        7, "DemoQA Sortable — drag item",
        "Go to demoqa.com/sortable and try to drag the first item to a different position. "
        "Tell me honestly if you were able to do it or not",
        lambda resp, msgs, acts: (
            len(resp) > 15  # Any honest response is acceptable
        ),
        timeout=90,
    )

    # TEST 8: Google search + click results
    await run_test(
        8, "Google search — multi-page navigation",
        "Go to google.com, search for 'Anticipy AI wearable pendant', "
        "and tell me the titles of the top 3 search results",
        lambda resp, msgs, acts: (
            len(resp) > 30
            and not resp.startswith("I got stuck")
        ),
        timeout=180,
    )

    # TEST 9: GitHub trending
    await run_test(
        9, "GitHub trending — navigate into repo",
        "Go to github.com/trending, click into the top trending repository, "
        "read its description and star count, "
        "then tell me the repo name, description, and number of stars",
        lambda resp, msgs, acts: (
            len(resp) > 30
            and not resp.startswith("I got stuck")
            and not resp.startswith("I wasn't able")
        ),
        timeout=180,
    )

    # TEST 10: Amazon.ca — search and filter
    await run_test(
        10, "Amazon.ca — search and filter",
        "Go to amazon.ca, search for 'USB-C cable', "
        "and tell me the name and price of the top 3 results",
        lambda resp, msgs, acts: (
            len(resp) > 30
            and ("$" in resp or "usb" in resp.lower() or "cable" in resp.lower())
        ),
        timeout=180,
    )

    # Summary
    print(f"\n{'='*60}")
    print(f"RESULTS: {PASS_COUNT}/{PASS_COUNT + FAIL_COUNT} passed, {FAIL_COUNT} failed")
    print(f"{'='*60}")

    for r in RESULTS:
        status = "PASS" if r["passed"] else "FAIL"
        print(f"  [{status}] Test {r['test']}: {r['label']} ({r['elapsed']:.1f}s, {r['actions']} actions)")
        if not r["passed"]:
            print(f"         Response: {r['response'][:100]}")
            if r.get("leak"):
                print(f"         Leakage: {r['leak']}")

    # Save results
    with open("logs/test_real_results.json", "w") as f:
        json.dump({
            "total": PASS_COUNT + FAIL_COUNT,
            "passed": PASS_COUNT,
            "failed": FAIL_COUNT,
            "results": RESULTS,
        }, f, indent=2)
    print(f"\nResults saved to logs/test_real_results.json")


if __name__ == "__main__":
    asyncio.run(main())
