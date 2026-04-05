"""
Comprehensive test suite for the Anticipy Action Engine.
Tests classification, safety, browser tasks, and technical leakage.
"""

import asyncio
import json
import sys
import time

sys.path.insert(0, ".")

from app.router import classify, handle_chat, handle_question
from app.models import CostTracker
from app.safety import check_blocked, check_needs_confirmation
from app.agent import execute_task

# Technical terms that must NEVER appear in user-facing messages
# Use word boundary matching to avoid false positives (e.g., "capital" matching "api")
import re

BANNED_PATTERNS = [
    r"\bjson\b", r"\bapi\b", r"\berror code\b", r"\bstack trace\b", r"\btraceback\b",
    r"\bexception\b", r"\bnull\b", r"\bundefined\b", r"\bnonetype\b", r"\btimeout\b",
    r"\b500\b", r"\b429\b", r"\brate limit\b", r"\bparse\b",
    r"\bdom\b", r"\bselector\b", r"\baccessibility tree\b", r"\bxpath\b",
    r"\bcss selector\b", r"\bjavascript\b", r"\btypescript\b", r"\bpython\b",
    r"\bfunction\b", r"\bvariable\b", r"\bdebug\b", r"\bconsole\b",
    r"\bendpoint\b", r"\brequest failed\b",
]

results = []


def check_leakage(text: str) -> str | None:
    """Check for technical term leakage in text using word boundaries."""
    text_lower = text.lower()
    for pattern in BANNED_PATTERNS:
        if re.search(pattern, text_lower):
            return pattern
    return None


async def test_classification():
    """Test that the classifier correctly categorizes inputs."""
    tests = [
        ("Hi, how are you?", "chat"),
        ("What can you help me with?", "chat|ambiguous|question"),  # borderline
        ("Thanks!", "chat"),
        ("What's the weather in Vancouver?", "question"),
        ("What is 2+2?", "question"),
        ("Go to wikipedia.org", "action"),
        ("Book me a flight to Tokyo", "action"),
        ("Search Google for Anticipy", "action"),
        ("handle the thing", "ambiguous"),
    ]

    print("\n--- Classification Tests ---")
    tracker = CostTracker()
    passed = 0
    for text, expected in tests:
        cat = await classify(text, tracker)
        ok = cat in expected.split("|")
        passed += ok
        status = "PASS" if ok else "FAIL"
        print(f"  [{status}] '{text[:40]}' -> {cat} (expected {expected})")
        results.append({"test": f"classify: {text[:30]}", "passed": ok})

    print(f"  Classification: {passed}/{len(tests)} passed (cost: ${tracker.total_usd:.4f})")


async def test_safety():
    """Test deterministic safety rules."""
    blocked_tests = [
        ("Delete my Google account", True),
        ("Close my account on Netflix", True),
        ("Change my password", True),
        ("Wire transfer 1000 to someone", True),
        ("Send money to my friend", True),
        ("Factory reset my phone", True),
        ("Book a restaurant", False),
        ("Search for flights", False),
        ("Tell me the weather", False),
    ]

    confirm_tests = [
        ("buy this item", True),
        ("cancel my subscription", True),
        ("book a table", True),
        ("send email to john", True),
        ("scroll down", False),
        ("search for restaurants", False),
    ]

    print("\n--- Safety Tests ---")
    passed = 0
    for text, expected in blocked_tests:
        result = check_blocked(text)
        ok = result == expected
        passed += ok
        status = "PASS" if ok else "FAIL"
        print(f"  [{status}] blocked('{text[:40]}') = {result} (expected {expected})")
        results.append({"test": f"blocked: {text[:30]}", "passed": ok})

    for text, expected in confirm_tests:
        result = check_needs_confirmation(text)
        ok = result == expected
        passed += ok
        status = "PASS" if ok else "FAIL"
        print(f"  [{status}] confirm('{text[:40]}') = {result} (expected {expected})")
        results.append({"test": f"confirm: {text[:30]}", "passed": ok})

    total = len(blocked_tests) + len(confirm_tests)
    print(f"  Safety: {passed}/{total} passed")


async def test_chat_responses():
    """Test that chat responses have no technical leakage."""
    print("\n--- Chat Response Tests ---")
    tracker = CostTracker()

    messages = [
        "Hi there!",
        "What can you do?",
        "Tell me about yourself",
    ]

    passed = 0
    for text in messages:
        resp = await handle_chat(text, tracker)
        leak = check_leakage(resp)
        ok = leak is None
        passed += ok
        status = "PASS" if ok else "FAIL"
        if not ok:
            print(f"  [{status}] '{text}' -> LEAKAGE: '{leak}' in '{resp[:60]}'")
        else:
            print(f"  [{status}] '{text}' -> '{resp[:60]}'")
        results.append({"test": f"chat_leakage: {text[:20]}", "passed": ok})

    print(f"  Chat responses: {passed}/{len(messages)} passed")


async def test_question_responses():
    """Test that question responses have no technical leakage."""
    print("\n--- Question Response Tests ---")
    tracker = CostTracker()

    questions = [
        "What is the capital of Japan?",
        "How many days in a week?",
    ]

    passed = 0
    for text in questions:
        resp = await handle_question(text, tracker)
        leak = check_leakage(resp)
        ok = leak is None
        passed += ok
        status = "PASS" if ok else "FAIL"
        if not ok:
            print(f"  [{status}] '{text}' -> LEAKAGE: '{leak}' in '{resp[:60]}'")
        else:
            print(f"  [{status}] '{text}' -> '{resp[:60]}'")
        results.append({"test": f"question_leakage: {text[:20]}", "passed": ok})

    print(f"  Question responses: {passed}/{len(questions)} passed")


async def test_browser_task():
    """Test a real browser task end-to-end."""
    print("\n--- Browser Task Test ---")

    messages_received = []

    async def send(data):
        messages_received.append(data)
        t = data.get("type", "")
        m = data.get("message", "")[:80]
        print(f"    [{t}] {m}")

    async def recv():
        return "yes"

    start = time.time()
    await execute_task(
        goal="Go to en.wikipedia.org and tell me what the featured article is about",
        send=send,
        receive_confirmation=recv,
        user_id=None,
    )
    elapsed = time.time() - start

    # Check: got a complete message
    complete_msgs = [m for m in messages_received if m.get("type") == "complete"]
    has_complete = len(complete_msgs) > 0

    # Check: no technical leakage in any message
    leakage_found = None
    for m in messages_received:
        text = m.get("message", "")
        leak = check_leakage(text)
        if leak:
            leakage_found = (leak, text[:60])
            break

    ok = has_complete and leakage_found is None
    status = "PASS" if ok else "FAIL"
    print(f"  [{status}] Wikipedia task (elapsed: {elapsed:.1f}s, messages: {len(messages_received)})")
    if not has_complete:
        print(f"    No complete message received!")
    if leakage_found:
        print(f"    Leakage: '{leakage_found[0]}' in '{leakage_found[1]}'")
    if complete_msgs:
        print(f"    Answer: {complete_msgs[0].get('message', '')[:100]}")

    results.append({"test": "browser: wikipedia", "passed": ok})


async def test_error_handling():
    """Test graceful handling of a nonexistent website."""
    print("\n--- Error Handling Test ---")

    messages_received = []

    async def send(data):
        messages_received.append(data)

    async def recv():
        return "yes"

    await execute_task(
        goal="Go to thiswebsitedoesnotexist99999.com and tell me what's there",
        send=send,
        receive_confirmation=recv,
        user_id=None,
    )

    # Should handle gracefully
    all_text = " ".join(m.get("message", "") for m in messages_received)
    leak = check_leakage(all_text)
    ok = leak is None
    status = "PASS" if ok else "FAIL"
    print(f"  [{status}] Nonexistent website handling")
    if leak:
        print(f"    Leakage: '{leak}'")
    results.append({"test": "error: nonexistent site", "passed": ok})


async def main():
    print("=" * 60)
    print("ANTICIPY ACTION ENGINE — TEST SUITE")
    print("=" * 60)

    await test_classification()
    await test_safety()
    await test_chat_responses()
    await test_question_responses()
    await test_browser_task()
    await test_error_handling()

    # Summary
    total = len(results)
    passed = sum(1 for r in results if r["passed"])
    failed = total - passed

    print("\n" + "=" * 60)
    print(f"RESULTS: {passed}/{total} passed, {failed} failed")
    print("=" * 60)

    if failed > 0:
        print("\nFailed tests:")
        for r in results:
            if not r["passed"]:
                print(f"  - {r['test']}")

    # Save results
    with open("logs/test_results.json", "w") as f:
        json.dump({"total": total, "passed": passed, "failed": failed, "results": results}, f, indent=2)
    print(f"\nResults saved to logs/test_results.json")


if __name__ == "__main__":
    asyncio.run(main())
