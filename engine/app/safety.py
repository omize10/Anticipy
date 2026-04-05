"""
Deterministic safety rules. The LLM cannot override these.
"""

from __future__ import annotations

import re

# Actions that are ALWAYS blocked — agent refuses outright
ALWAYS_BLOCKED: list[str] = [
    "delete account",
    "delete my account",
    "remove account",
    "close account",
    "change password",
    "reset password",
    "wire transfer",
    "bank transfer",
    "send money",
    "transfer funds",
    "format disk",
    "factory reset",
    "unsubscribe all",
    "delete all",
    "remove all data",
    "export all passwords",
]

# Actions that REQUIRE user confirmation before proceeding
ALWAYS_CONFIRM: list[str] = [
    "cancel",
    "purchase",
    "buy",
    "order",
    "checkout",
    "pay",
    "payment",
    "send email",
    "send message",
    "book",
    "reserve",
    "subscribe",
    "unsubscribe",
    "submit application",
    "place order",
    "confirm order",
    "add to cart",
    "sign up",
    "register",
    "donate",
    "bid",
]

# Elements to auto-dismiss without asking the user
AUTO_DISMISS_PATTERNS: list[str] = [
    "accept all",
    "accept cookies",
    "accept all cookies",
    "i agree",
    "got it",
    "i understand",
    "ok, got it",
    "dismiss",
    "close",
    "no thanks",
    "maybe later",
    "not now",
    "continue without",
    "reject all",
    "deny",
    "cookie",
    "consent",
]


def _normalize(text: str) -> str:
    return re.sub(r"\s+", " ", text.strip().lower())


def _words_present(pattern: str, text: str) -> bool:
    """Check if all words in pattern appear in text (in any order)."""
    pattern_words = pattern.split()
    return all(w in text for w in pattern_words)


def check_blocked(user_text: str) -> bool:
    """Return True if the user request matches a blocked action."""
    norm = _normalize(user_text)
    for pattern in ALWAYS_BLOCKED:
        # Check both exact substring and word-level matching
        if pattern in norm or _words_present(pattern, norm):
            return True
    return False


def check_needs_confirmation(action_description: str) -> bool:
    """Return True if the action requires user confirmation."""
    norm = _normalize(action_description)
    for pattern in ALWAYS_CONFIRM:
        if pattern in norm:
            return True
    return False


def is_auto_dismiss(element_text: str) -> bool:
    """Return True if the element looks like cookie consent / dismiss button."""
    norm = _normalize(element_text)
    for pattern in AUTO_DISMISS_PATTERNS:
        if pattern in norm:
            return True
    return False


def check_page_for_auto_dismiss(elements: list[dict]) -> dict | None:
    """
    Check a list of labeled page elements for auto-dismissable overlays.
    Returns the first matching element dict or None.
    """
    for elem in elements:
        name = elem.get("name", "") or ""
        role = elem.get("role", "") or ""
        if is_auto_dismiss(name):
            return elem
    return None
