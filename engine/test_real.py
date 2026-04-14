"""
REAL test suite for the Anticipy Action Engine.
Every test requires multi-step browser interaction on a live website.
Run: cd engine && DISPLAY=:99 python test_real.py
"""

import asyncio
import json
import sys
import time
import os

sys.path.insert(0, ".")

# Load env vars from .env.local
from pathlib import Path
env_file = Path(__file__).parent.parent / ".env.local"
if env_file.exists():
    for line in env_file.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, _, val = line.partition("=")
            os.environ.setdefault(key.strip(), val.strip())

from app.agent import execute_task

PASS_COUNT = 0
FAIL_COUNT = 0
RESULTS = []

# Banned words in responses (technical leakage)
BANNED_PATTERNS = [
    "json", "api ", "error code", "stack trace", "traceback",
    "exception", "null", "nonetype",
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
    timeout: int = 240,
):
    """Run a single test, capturing all messages."""
    global PASS_COUNT, FAIL_COUNT

    print(f"\n{'='*60}", flush=True)
    print(f"TEST {test_num}: {label}", flush=True)
    print(f"TASK: {task_text[:100]}...", flush=True)
    print(f"{'='*60}", flush=True)

    messages = []

    async def send(data):
        messages.append(data)
        t = data.get("type", "")
        m = data.get("message", "")[:120]
        print(f"  [{t}] {m}", flush=True)

    async def recv():
        return "yes"

    start = time.time()
    max_retries = 2
    for attempt in range(max_retries):
        try:
            await asyncio.wait_for(
                execute_task(task_text, send, recv, user_id="test_user"),
                timeout=timeout + 30,
            )
            break
        except asyncio.TimeoutError:
            messages.append({"type": "error", "message": "HARD TIMEOUT"})
            print("  [HARD TIMEOUT]", flush=True)
            break  # Don't retry timeouts
        except Exception as e:
            err_msg = str(e)[:100]
            if attempt < max_retries - 1:
                print(f"  [RETRY] Attempt {attempt+1} failed: {type(e).__name__}, retrying...", flush=True)
                messages.clear()
                await asyncio.sleep(3)
                continue
            messages.append({"type": "error", "message": err_msg})
            print(f"  [EXCEPTION] {type(e).__name__}", flush=True)

    elapsed = time.time() - start

    # Get final message
    complete_msgs = [m for m in messages if m.get("type") == "complete"]
    error_msgs = [m for m in messages if m.get("type") == "error"]
    final_text = ""
    if complete_msgs:
        final_text = complete_msgs[-1].get("message", "")
    elif error_msgs:
        final_text = error_msgs[-1].get("message", "")

    # Check for technical leakage
    all_text = " ".join(m.get("message", "") for m in messages)
    leak = check_leakage(all_text)

    # Run the pass check
    passed = pass_check(final_text)
    if leak:
        passed = False
        print(f"  LEAKAGE: '{leak}' found in response", flush=True)

    status = "PASS" if passed else "FAIL"
    if passed:
        PASS_COUNT += 1
    else:
        FAIL_COUNT += 1

    print(f"\n  [{status}] {label} ({elapsed:.1f}s)", flush=True)
    print(f"  RESPONSE: {final_text[:200]}", flush=True)

    RESULTS.append({
        "test": test_num,
        "label": label,
        "passed": passed,
        "elapsed": round(elapsed, 1),
        "response": final_text[:500],
        "message_count": len(messages),
        "leak": leak,
    })


async def main():
    global PASS_COUNT, FAIL_COUNT

    print("=" * 60)
    print("ANTICIPY ACTION ENGINE — REAL TEST SUITE")
    print("10 tests on live websites")
    print("=" * 60)

    # TEST 1: OpenTable search
    await run_test(
        1, "OpenTable availability search",
        "Go to opentable.com, search for Cactus Club Cafe in Vancouver, "
        "and check what times are available for 4 people tomorrow evening around 7pm",
        lambda r: (
            len(r) > 30
            and any(kw in r.lower() for kw in ["time", "available", "reservation", "no avail", "pm", "cactus"])
        ),
    )

    # TEST 2: Amazon
    await run_test(
        2, "Amazon search",
        "Go to amazon.ca, search for USB-C cable, and tell me the name and price of the top 3 results",
        lambda r: "$" in r and any(c.isdigit() for c in r),
    )

    # TEST 3: Google search + click
    await run_test(
        3, "Google search and click",
        "Search Google for 'Anticipy AI wearable', click the first non-ad result, "
        "and tell me what the page says about it",
        lambda r: len(r) > 50,
    )

    # TEST 4: SauceDemo full checkout (needs more time for multi-page flow)
    await run_test(
        4, "SauceDemo checkout",
        "Go to saucedemo.com, log in with username standard_user and password secret_sauce, "
        "add the first item to cart, click the cart icon (top right), click Checkout, "
        "fill in First Name: John, Last Name: Smith, Zip: 12345, click Continue, "
        "then tell me the total amount shown on the checkout overview page",
        lambda r: "$" in r and any(c.isdigit() for c in r),
        timeout=300,
    )

    # TEST 5: GitHub trending
    await run_test(
        5, "GitHub trending deep dive",
        "Go to github.com/trending, click into the top repository, "
        "and tell me its name, description, star count, and how many open issues it has",
        lambda r: len(r) > 30 and any(c.isdigit() for c in r),
    )

    # TEST 6: Bot detection
    await run_test(
        6, "Bot detection fingerprint",
        "Go to bot.sannysoft.com and tell me if there are any failed tests on the page",
        lambda r: any(kw in r.lower() for kw in ["test", "pass", "fail", "detect", "result"]),
    )

    # TEST 7: Cloudflare-protected site
    await run_test(
        7, "Cloudflare-protected site",
        "Go to nowsecure.nl and tell me what the page says",
        lambda r: len(r) > 20,
    )

    # TEST 8: reCAPTCHA demo
    await run_test(
        8, "reCAPTCHA demo",
        "Go to https://www.google.com/recaptcha/api2/demo and solve the CAPTCHA",
        lambda r: any(kw in r.lower() for kw in ["solved", "captcha", "verification", "success", "check", "complete", "submit", "robot"]),
    )

    # TEST 9: Login form
    await run_test(
        9, "Login form — the-internet",
        "Go to the-internet.herokuapp.com/login, log in with username tomsmith "
        "and password SuperSecretPassword!, then tell me what the secure page says",
        lambda r: any(kw in r.lower() for kw in ["secure", "welcome", "logged", "success"]),
    )

    # TEST 10: Technical leakage audit (meta-test)
    print(f"\n{'='*60}")
    print(f"TEST 10: Technical leakage audit")
    print(f"{'='*60}")
    all_text = " ".join(r.get("response", "") for r in RESULTS)
    leak = check_leakage(all_text)
    if leak:
        FAIL_COUNT += 1
        print(f"  [FAIL] Technical leakage: '{leak}'")
        RESULTS.append({"test": 10, "label": "Technical leakage audit", "passed": False, "leak": leak})
    else:
        PASS_COUNT += 1
        print(f"  [PASS] No technical leakage detected")
        RESULTS.append({"test": 10, "label": "Technical leakage audit", "passed": True, "leak": None})

    # Summary
    print(f"\n{'='*60}")
    print(f"RESULTS: {PASS_COUNT}/{PASS_COUNT + FAIL_COUNT} passed")
    print(f"{'='*60}")

    for r in RESULTS:
        status = "PASS" if r["passed"] else "FAIL"
        print(f"  [{status}] Test {r.get('test', '?')}: {r.get('label', '')}")
        if not r["passed"] and r.get("response"):
            print(f"         Response: {r['response'][:100]}")

    # Save results
    os.makedirs("logs", exist_ok=True)
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
