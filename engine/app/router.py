"""
Task classifier: determines if user input is chat, question, ambiguous, or action.
Uses keyword pre-classification for reliability, with LLM fallback for edge cases.
"""

from __future__ import annotations

import re

from app.models import llm_call_json, CostTracker

# Keyword-based pre-classifier for deterministic results on obvious cases
CHAT_PATTERNS = [
    r"^(hi|hello|hey|sup|yo|thanks|thank you|cheers|bye|goodbye|good morning|good evening|good night|howdy|what'?s up)\b",
    r"^(how are you|how'?s it going|nice to meet)",
]

ACTION_KEYWORDS = [
    "go to", "navigate to", "open", "visit", "search for", "search google",
    "book", "reserve", "order", "buy", "purchase", "fill out", "fill in",
    "sign up", "register", "log in", "login", "cancel", "unsubscribe",
    "find me", "look up", "check out", "download", "upload",
]

QUESTION_PATTERNS = [
    r"^(what|who|where|when|why|how|is|are|was|were|do|does|did|can|could|will|would|should)\b",
]

CLASSIFICATION_TEMPLATE = (
    'Classify this user message into exactly one category.\n\n'
    'Categories:\n'
    '- "chat": casual conversation, greeting, thanks, small talk\n'
    '- "question": asking a factual question that can be answered without browsing\n'
    '- "action": wants something done on a website (search, book, buy, fill form, navigate, look up on specific site)\n'
    '- "ambiguous": unclear what they want\n\n'
    'Output ONLY valid JSON: {"category":"chat"} or {"category":"question"} or {"category":"action"} or {"category":"ambiguous"}\n\n'
    'User message: '
)


def _pre_classify(text: str) -> str | None:
    """
    Deterministic keyword pre-classification.
    Returns a category or None if unsure (falls through to LLM).
    """
    text_lower = text.strip().lower()

    # Check chat patterns
    for pat in CHAT_PATTERNS:
        if re.search(pat, text_lower):
            return "chat"

    # Check action keywords
    for kw in ACTION_KEYWORDS:
        if kw in text_lower:
            return "action"

    # Check if it mentions a website
    if re.search(r"\b\w+\.(com|org|net|io|ai|gov|edu)\b", text_lower):
        return "action"

    # Check question patterns (only if no action keywords matched)
    for pat in QUESTION_PATTERNS:
        if re.search(pat, text_lower):
            return "question"

    return None  # Unclear, use LLM


async def classify(text: str, tracker: CostTracker) -> str:
    """
    Classify user input.
    Returns one of: "chat", "question", "action", "ambiguous".
    Uses keyword pre-classification first, LLM fallback for edge cases.
    """
    # Try deterministic classification first
    pre = _pre_classify(text)
    if pre:
        return pre

    # Fall through to LLM for ambiguous cases
    messages = [
        {
            "role": "user",
            "content": CLASSIFICATION_TEMPLATE + text[:200],
        }
    ]
    result = await llm_call_json(messages, tracker, temperature=0.0, max_tokens=32)
    if result and "category" in result:
        cat = result["category"]
        if cat in ("chat", "question", "action", "ambiguous"):
            return cat
    return "ambiguous"


async def handle_chat(text: str, tracker: CostTracker) -> str:
    """Generate a friendly chat response."""
    messages = [
        {
            "role": "system",
            "content": (
                "You are a helpful assistant that can browse the web. "
                "Respond naturally and briefly. If the user seems to want "
                "you to do something on the web, let them know you can help "
                "with that."
            ),
        },
        {"role": "user", "content": text[:300]},
    ]
    from app.models import llm_call_text

    result = await llm_call_text(messages, tracker, temperature=0.7, max_tokens=150)
    return result or "I'm here to help! I can browse the web and complete tasks for you."


async def handle_question(text: str, tracker: CostTracker) -> str:
    """Answer a factual question without browsing."""
    messages = [
        {
            "role": "system",
            "content": (
                "Answer the question briefly and helpfully. "
                "If you're not sure or the question requires current/live information, "
                "say you'd need to look it up on the web and offer to do so."
            ),
        },
        {"role": "user", "content": text[:300]},
    ]
    from app.models import llm_call_text

    result = await llm_call_text(messages, tracker, temperature=0.3, max_tokens=200)
    return result or "I'm not sure about that. Would you like me to look it up online?"
