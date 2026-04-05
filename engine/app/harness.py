"""
Observation compression + prompt formatting.
The core IP — makes cheap models work well by constraining the action space.
"""

from __future__ import annotations

from app.config import MAX_LABELED_ELEMENTS, MEMORY_MAX_CHARS

# Labels A through O (15 max)
LABELS = [chr(ord("A") + i) for i in range(MAX_LABELED_ELEMENTS)]

SYSTEM_PROMPT = """You are a browser automation agent. You see labeled interactive elements on a web page and pick one action.

RULES:
- Output ONLY valid JSON. No explanation, no markdown.
- Format: {"action":"<ACTION>","target":"<LABEL>","value":null}
- ACTION is one of: click, type, select, scroll, navigate, done, stuck, need_info
- TARGET is a single letter label (A-O) from the element list, or null for scroll/done/stuck/need_info
- VALUE is the text to type (for type/select/navigate actions), or null
- For navigate: target is null, value is the full URL
- For scroll: target is null, value is "up" or "down"
- For done: target is null, value is a plain English answer/summary of what was accomplished (if the goal asked for information, include the answer here)
- For stuck: target and value are both null
- For need_info: target is null, value describes what info you need
- If you can see the answer to the user's question in the PAGE TEXT, use done immediately with the answer as value
- Pick exactly ONE action per response."""


def extract_interactive_elements(tree: dict | None) -> list[dict]:
    """
    Walk the accessibility tree and extract interactive elements.
    Returns a list of dicts with 'label', 'role', 'name', and 'node' keys.
    Limited to MAX_LABELED_ELEMENTS.
    """
    if not tree:
        return []

    interactive_roles = {
        "link",
        "button",
        "textbox",
        "combobox",
        "listbox",
        "menuitem",
        "menuitemcheckbox",
        "menuitemradio",
        "option",
        "radio",
        "checkbox",
        "searchbox",
        "spinbutton",
        "slider",
        "switch",
        "tab",
        "treeitem",
    }

    # Names to skip — common nav/meta elements that waste label slots
    skip_names = {
        "jump to content", "skip to content", "main menu", "search",
        "log in", "create account", "sign in", "sign up", "donate",
        "view source", "view history", "talk", "read", "tools",
        "appearance", "hide", "show",
    }

    all_elements: list[dict] = []

    def walk(node: dict) -> None:
        role = (node.get("role") or "").lower()
        name = (node.get("name") or "").strip()
        if role in interactive_roles and name:
            all_elements.append(
                {
                    "role": role,
                    "name": name[:80],
                    "node": node,
                }
            )
        for child in node.get("children", []):
            walk(child)

    walk(tree)

    # Partition into content vs nav elements
    content = []
    nav = []
    for elem in all_elements:
        name_lower = elem["name"].lower()
        if name_lower in skip_names or len(elem["name"]) < 2:
            nav.append(elem)
        else:
            content.append(elem)

    # Prioritize content elements, fill remaining slots with nav
    results: list[dict] = []
    for elem in (content + nav)[:MAX_LABELED_ELEMENTS]:
        elem["label"] = LABELS[len(results)]
        results.append(elem)

    return results


def format_elements(elements: list[dict]) -> str:
    """Format labeled elements into a compact string for the prompt."""
    lines = []
    for elem in elements:
        lines.append(f"[{elem['label']}] {elem['role']}: {elem['name']}")
    return "\n".join(lines)


def compress_memory(memory: list[str]) -> str:
    """
    Keep a compressed memory of actions taken.
    Prunes oldest entries to stay under MEMORY_MAX_CHARS.
    """
    combined = " | ".join(memory)
    if len(combined) <= MEMORY_MAX_CHARS:
        return combined
    # Keep only the most recent entries that fit
    trimmed: list[str] = []
    total = 0
    for entry in reversed(memory):
        if total + len(entry) + 3 > MEMORY_MAX_CHARS:
            break
        trimmed.insert(0, entry)
        total += len(entry) + 3
    return " | ".join(trimmed)


def format_prompt(
    goal: str,
    url: str,
    elements: list[dict],
    memory: list[str],
    step: int,
    max_steps: int,
    page_text: str = "",
) -> list[dict]:
    """
    Build the complete message list for the LLM.
    Kept under ~800 tokens by aggressive compression.
    """
    elements_text = format_elements(elements)
    memory_text = compress_memory(memory) if memory else "none"

    # Include page text excerpt for context — skip obvious nav boilerplate
    text_snippet = ""
    if page_text:
        # Try to skip navigation text at the top and get to content
        content = page_text
        for marker in ["Welcome to", "From today", "Featured", "Main content", "Article", "Home"]:
            idx = content.find(marker)
            if idx > 50:
                content = content[idx:]
                break
        text_snippet = f"\nPAGE TEXT (excerpt): {content[:600]}\n"

    user_msg = f"""GOAL: {goal[:120]}
URL: {url[:120]}
STEP: {step}/{max_steps}
HISTORY: {memory_text}{text_snippet}
ELEMENTS:
{elements_text}

Pick ONE action as JSON. If you already have enough information to answer the user's question, use {{"action":"done","target":null,"value":"<your answer here>"}}."""

    return [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": user_msg},
    ]


def describe_action(action: dict) -> str:
    """Human-readable one-liner for an action dict."""
    act = action.get("action", "unknown")
    target = action.get("target")
    value = action.get("value")
    if act == "click" and target:
        return f"click [{target}]"
    if act == "type" and target and value:
        return f"type '{value[:30]}' into [{target}]"
    if act == "select" and target and value:
        return f"select '{value[:30]}' in [{target}]"
    if act == "scroll":
        return f"scroll {value or 'down'}"
    if act == "navigate" and value:
        return f"navigate to {value[:60]}"
    if act == "done":
        return "task completed"
    if act == "stuck":
        return "got stuck"
    if act == "need_info":
        return f"needs info: {value or ''}"[:60]
    return f"{act} {target or ''} {value or ''}".strip()
