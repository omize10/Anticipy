"""
LLM API wrapper with automatic retry, fallback chain, JSON extraction,
and cumulative cost tracking. Uses raw httpx — no SDK imports.
"""

from __future__ import annotations

import asyncio
import json
import re
import time
from dataclasses import dataclass, field

import httpx

from app.config import MODEL_CHAIN, MAX_COST_USD


@dataclass
class CostTracker:
    """Tracks cumulative cost for a single task."""
    total_usd: float = 0.0
    calls: int = 0

    def add(self, input_tokens: int, output_tokens: int, cost_in: float, cost_out: float) -> None:
        self.total_usd += (input_tokens / 1000) * cost_in + (output_tokens / 1000) * cost_out
        self.calls += 1

    @property
    def exceeded(self) -> bool:
        return self.total_usd >= MAX_COST_USD


def _strip_json(text: str) -> str:
    """Extract the first JSON object from potentially wrapped text."""
    # Strip markdown code fences
    text = re.sub(r"```(?:json)?\s*", "", text)
    text = re.sub(r"```\s*$", "", text)
    text = text.strip()

    # Find first { and last }
    start = text.find("{")
    end = text.rfind("}")
    if start != -1 and end != -1 and end > start:
        return text[start : end + 1]

    # If no closing }, the response was truncated — try to close it
    if start != -1 and end == -1:
        partial = text[start:]
        # Try adding a closing quote + }
        for suffix in ['"}', '"}', 'null}', '}']:
            attempt = partial + suffix
            try:
                json.loads(attempt)
                return attempt
            except (json.JSONDecodeError, ValueError):
                continue
    return text


def _validate_json(text: str) -> dict | None:
    """Try to parse as JSON dict. Return None on failure."""
    try:
        obj = json.loads(text)
        if isinstance(obj, dict):
            return obj
    except (json.JSONDecodeError, ValueError):
        pass
    return None


async def _call_openai_compatible(
    base_url: str,
    api_key: str,
    model: str,
    messages: list[dict],
    temperature: float = 0.0,
    max_tokens: int = 256,
) -> tuple[str, int, int]:
    """Call an OpenAI-compatible chat completions endpoint. Returns (text, input_tokens, output_tokens)."""
    url = f"{base_url}/chat/completions"
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    body = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
    }
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(url, headers=headers, json=body)
        resp.raise_for_status()
        data = resp.json()
        text = data["choices"][0]["message"]["content"]
        usage = data.get("usage", {})
        return text, usage.get("prompt_tokens", 0), usage.get("completion_tokens", 0)


async def _call_gemini(
    base_url: str,
    api_key: str,
    model: str,
    messages: list[dict],
    temperature: float = 0.0,
    max_tokens: int = 256,
) -> tuple[str, int, int]:
    """Call Google Gemini REST API. Returns (text, input_tokens, output_tokens)."""
    url = f"{base_url}/models/{model}:generateContent?key={api_key}"

    # Convert OpenAI-style messages to Gemini contents format
    contents = []
    system_text = ""
    for msg in messages:
        role = msg["role"]
        text = msg["content"]
        if role == "system":
            system_text = text
            continue
        gemini_role = "user" if role == "user" else "model"
        contents.append({"role": gemini_role, "parts": [{"text": text}]})

    # Prepend system text to first user message if present
    if system_text and contents:
        first = contents[0]
        first["parts"][0]["text"] = system_text + "\n\n" + first["parts"][0]["text"]

    body = {
        "contents": contents,
        "generationConfig": {
            "temperature": temperature,
            "maxOutputTokens": max_tokens,
        },
    }

    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(url, json=body)
        resp.raise_for_status()
        data = resp.json()
        text = data["candidates"][0]["content"]["parts"][0]["text"]
        usage = data.get("usageMetadata", {})
        return (
            text,
            usage.get("promptTokenCount", 0),
            usage.get("candidatesTokenCount", 0),
        )


async def _call_model(
    model_cfg: dict,
    messages: list[dict],
    temperature: float = 0.0,
    max_tokens: int = 256,
) -> tuple[str, int, int]:
    """Dispatch to the correct backend based on model name."""
    if model_cfg["name"] == "gemini":
        return await _call_gemini(
            model_cfg["base_url"],
            model_cfg["api_key"],
            model_cfg["model"],
            messages,
            temperature,
            max_tokens,
        )
    return await _call_openai_compatible(
        model_cfg["base_url"],
        model_cfg["api_key"],
        model_cfg["model"],
        messages,
        temperature,
        max_tokens,
    )


async def llm_call(
    messages: list[dict],
    tracker: CostTracker,
    temperature: float = 0.0,
    max_tokens: int = 256,
    require_json: bool = False,
    retries_per_model: int = 2,
) -> str | dict | None:
    """
    Call LLMs with retry and fallback.
    If require_json=True, strips fences and validates JSON, returning a dict.
    Otherwise returns raw text.
    Returns None only if every model in the chain fails.
    """
    if tracker.exceeded:
        return None

    for model_cfg in MODEL_CHAIN:
        for attempt in range(retries_per_model):
            try:
                text, in_tok, out_tok = await _call_model(
                    model_cfg, messages, temperature, max_tokens
                )
                tracker.add(
                    in_tok,
                    out_tok,
                    model_cfg["cost_input"],
                    model_cfg["cost_output"],
                )

                if require_json:
                    cleaned = _strip_json(text)
                    parsed = _validate_json(cleaned)
                    if parsed is not None:
                        return parsed
                    # JSON parse failed — retry
                    if attempt < retries_per_model - 1:
                        await asyncio.sleep(0.5 * (attempt + 1))
                        continue
                    # Last attempt on this model — try next model
                    break
                else:
                    return text.strip()

            except Exception:
                if attempt < retries_per_model - 1:
                    await asyncio.sleep(1.0 * (attempt + 1))
                    continue
                break  # move to next model

    return None


async def llm_call_text(
    messages: list[dict],
    tracker: CostTracker,
    temperature: float = 0.0,
    max_tokens: int = 256,
) -> str:
    """Convenience: call LLM and always return a string (empty on failure)."""
    result = await llm_call(messages, tracker, temperature, max_tokens, require_json=False)
    if result is None:
        return ""
    return str(result)


async def llm_call_json(
    messages: list[dict],
    tracker: CostTracker,
    temperature: float = 0.0,
    max_tokens: int = 256,
) -> dict | None:
    """Convenience: call LLM and return parsed JSON dict or None."""
    result = await llm_call(messages, tracker, temperature, max_tokens, require_json=True)
    if isinstance(result, dict):
        return result
    return None
