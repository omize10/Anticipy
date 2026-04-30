"""
Deterministic safety rules and input sanitization. The LLM cannot override these.
"""

from __future__ import annotations

import re

# Actions that are ALWAYS blocked — agent refuses outright.
# Categories: account destruction, credentials, money movement, data exfil,
# system / OS commands, social-engineering harm, retaliatory or illegal acts.
ALWAYS_BLOCKED: list[str] = [
    # Account destruction
    "delete account",
    "delete my account",
    "remove account",
    "close account",
    "deactivate account",
    "terminate account",
    # Credential operations the agent must never perform
    "change password",
    "reset password",
    "share password",
    "give me your password",
    "tell me your password",
    "export passwords",
    "export all passwords",
    "dump passwords",
    "disable two factor",
    "disable 2fa",
    "disable mfa",
    "remove 2fa",
    # Money movement
    "wire transfer",
    "bank transfer",
    "send money",
    "transfer funds",
    "transfer money",
    "venmo someone",
    "send venmo",
    "send zelle",
    "send wire",
    "send cashapp",
    "withdraw funds",
    "withdraw money",
    "sell stock",
    "buy stock",
    "place trade",
    "place a trade",
    "execute trade",
    # System / OS destruction
    "format disk",
    "factory reset",
    "wipe disk",
    "wipe drive",
    "rm -rf",
    "drop database",
    "drop table",
    # Bulk data ops
    "unsubscribe all",
    "delete all",
    "remove all data",
    "delete everything",
    "delete my data",
    "delete all emails",
    "empty trash",
    # Social-engineering harm
    "dox",
    "doxx",
    "expose someone",
    "harass",
    "spam everyone",
    "post my address",
    # Public-content sensitive defaults (safer to block; use specific endpoints)
    "tweet for me",
    "post to instagram",
    "post to facebook",
    "post on linkedin",
]

# Actions that REQUIRE user confirmation before proceeding
ALWAYS_CONFIRM: list[str] = [
    # Commerce
    "purchase",
    "buy",
    "order",
    "checkout",
    "pay",
    "payment",
    "place order",
    "confirm order",
    "add to cart",
    "subscribe",
    "donate",
    "bid",
    "tip",
    # Cancellations
    "cancel",
    "unsubscribe",
    "refund",
    # Communication that's externally visible
    "send email",
    "send message",
    "send dm",
    "send text",
    "reply",
    "reply all",
    "post comment",
    "leave a review",
    "share publicly",
    # Bookings & applications
    "book",
    "reserve",
    "submit application",
    "submit form",
    "schedule meeting",
    # Account creation actions
    "sign up",
    "register",
    "create account",
]

# Patterns that suggest the goal involves entering a password or sensitive
# credential — the agent must never attempt this autonomously.
PASSWORD_INTENT_PATTERNS = [
    r"\benter\s+(?:my\s+)?password\b",
    r"\btype\s+(?:my\s+)?password\b",
    r"\bfill\s+(?:in\s+)?(?:my\s+)?password\b",
    r"\bsign\s+in\s+as\s+me\b",
    r"\blog\s+in\s+as\s+me\b",
    r"\buse\s+my\s+credentials\b",
    r"\bhere'?s\s+my\s+password\b",
]

# Patterns that suggest a financial transfer or trade — confirmation alone is
# insufficient; we want the user to do it themselves.
FINANCIAL_TRANSACTION_PATTERNS = [
    r"\btransfer\s+\$?\d",
    r"\bsend\s+\$?\d+\s+(?:to|via)\b",
    r"\bwire\s+\$?\d",
    r"\bpay\s+\$?\d+\s+to\b",
    r"\bbuy\s+\d+\s+shares?\b",
    r"\bsell\s+\d+\s+shares?\b",
    r"\bplace\s+a?\s*(?:limit|market)\s+order\b",
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

# Prompt injection patterns to strip from user input (V19)
INJECTION_PATTERNS = [
    r"ignore\s+(all\s+)?previous\s+instructions",
    r"ignore\s+all\s+(prior|earlier)\s+instructions",
    r"system\s*:",
    r"assistant\s*:",
    r"<\|.*?\|>",
    r"you\s+are\s+now",
    r"forget\s+everything",
    r"new\s+instructions?\s*:",
    r"disregard\s+(all\s+)?(above|previous)",
    r"override\s+(all\s+)?instructions",
    r"pretend\s+you\s+are",
    r"act\s+as\s+if",
    r"\[INST\]",
    r"\[/INST\]",
    r"<<SYS>>",
    r"<</SYS>>",
    r"developer\s+mode",
    r"jailbreak",
]

# Control characters that frequently appear in copy-pasted prompt injections.
_CONTROL_CHAR_RE = re.compile(r"[\x00-\x08\x0b-\x0c\x0e-\x1f\x7f]")


def sanitize_input(text: str) -> str:
    """Strip prompt injection patterns and control characters from user input."""
    if not isinstance(text, str):
        return ""
    # Strip control characters first
    text = _CONTROL_CHAR_RE.sub("", text)
    for pattern in INJECTION_PATTERNS:
        text = re.sub(pattern, "", text, flags=re.IGNORECASE)
    # Collapse runs of whitespace
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def _normalize(text: str) -> str:
    return re.sub(r"\s+", " ", text.strip().lower())


def _words_present(pattern: str, text: str) -> bool:
    """Check if all words in pattern appear as whole words in text (in any order)."""
    pattern_words = pattern.split()
    return all(bool(re.search(r"\b" + re.escape(w) + r"\b", text)) for w in pattern_words)


def check_blocked(user_text: str) -> bool:
    """Return True if the user request matches a blocked action."""
    if not user_text:
        return False
    norm = _normalize(user_text)

    # Phrase + word-set match for ALWAYS_BLOCKED
    for pattern in ALWAYS_BLOCKED:
        if pattern in norm or _words_present(pattern, norm):
            return True

    # Regex-based intent detection
    for pat in PASSWORD_INTENT_PATTERNS:
        if re.search(pat, norm, re.IGNORECASE):
            return True
    for pat in FINANCIAL_TRANSACTION_PATTERNS:
        if re.search(pat, norm, re.IGNORECASE):
            return True

    return False


def block_reason(user_text: str) -> str:
    """
    Return a short tag describing *why* a request was blocked, so callers
    can surface a more specific message. Returns "" if not blocked.
    """
    if not user_text:
        return ""
    norm = _normalize(user_text)
    for pat in PASSWORD_INTENT_PATTERNS:
        if re.search(pat, norm, re.IGNORECASE):
            return "password"
    for pat in FINANCIAL_TRANSACTION_PATTERNS:
        if re.search(pat, norm, re.IGNORECASE):
            return "financial"
    for pattern in ALWAYS_BLOCKED:
        if pattern in norm or _words_present(pattern, norm):
            return "blocked"
    return ""


def check_needs_confirmation(action_description: str) -> bool:
    """Return True if the action requires user confirmation."""
    if not action_description:
        return False
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
