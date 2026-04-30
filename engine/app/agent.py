"""
Core execution loop for the Anticipy Action Engine.
Uses Browser Use framework for browser automation.
Receives a goal, drives the browser step-by-step, and streams status via callback.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from typing import Callable, Awaitable
from urllib.parse import urlparse

from browser_use import Agent, BrowserSession, BrowserProfile, AgentHistoryList

from app.config import (
    MAX_STEPS,
    MAX_SECONDS,
    PROFILE_ENCRYPTION_KEY,
    BROWSER_PROFILE_BASE,
)
from app.safety import check_blocked, check_needs_confirmation, sanitize_input
from app.planner import plan_task
from app.models import CostTracker
from app import messages as msg
from app import supabase_client

from cryptography.fernet import Fernet

logger = logging.getLogger("engine")

# Callback type: async function that sends a message dict to the client
SendFn = Callable[[dict], Awaitable[None]]

# Fernet cipher for cookie encryption
_fernet = Fernet(
    PROFILE_ENCRYPTION_KEY.encode()
    if isinstance(PROFILE_ENCRYPTION_KEY, str)
    else PROFILE_ENCRYPTION_KEY
)

# --- Status message mapping ---
# Maps Browser Use action types to user-friendly messages
_ACTION_STATUS_MAP = {
    "go_to_url": msg.TASK_NAVIGATING,
    "navigate": msg.TASK_NAVIGATING,
    "search": msg.TASK_NAVIGATING,
    "click": msg.TASK_PERFORMING_ACTION,
    "input": msg.TASK_TYPING,
    "input_text": msg.TASK_TYPING,
    "type": msg.TASK_TYPING,
    "scroll": msg.TASK_SCROLLING,
    "scroll_down": msg.TASK_SCROLLING,
    "scroll_up": msg.TASK_SCROLLING,
    "select": msg.TASK_SELECTING,
    "select_option": msg.TASK_SELECTING,
    "wait": msg.TASK_WAITING,
    "extract_page_content": msg.TASK_READING_PAGE,
    "done": msg.TASK_COMPLETE,
}


def _get_llm():
    """Return the best available LLM using browser-use's native wrappers."""
    from browser_use import ChatGoogle, ChatGroq

    google_key = os.environ.get("GOOGLE_API_KEY")
    if google_key:
        return ChatGoogle(
            model="gemini-2.5-flash",
            api_key=google_key,
            temperature=0.0,
            thinking_budget=0,
        )

    groq_key = os.environ.get("GROQ_API_KEY")
    if groq_key:
        return ChatGroq(
            model="meta-llama/llama-4-scout-17b-16e-instruct",
            api_key=groq_key,
            temperature=0.0,
        )

    raise RuntimeError("No LLM API key found. Set GOOGLE_API_KEY or GROQ_API_KEY.")


def _sanitize_status(text: str) -> str:
    """
    Strip technical terms from LLM-generated step descriptions before showing to users.
    next_goal can contain words like 'JavaScript', 'JSON', model names, etc.
    """
    import re
    replacements = [
        ("javascript", "a script"),
        ("xpath", "the element"),
        ("css selector", "the element"),
        ("dom element", "the element"),
        ("iframe", "the page section"),
        ("accessibility tree", "the page"),
        ("playwright", "the browser"),
        ("patchright", "the browser"),
        ("chromium", "the browser"),
        ("webdriver", "the browser"),
        ("api call", "a request"),
        ("http request", "a request"),
        ("json response", "the data"),
        ("json", "data"),
        ("groq", "the AI"),
        ("gemini", "the AI"),
        ("llama", "the AI"),
        ("deepseek", "the AI"),
        ("fastapi", "the server"),
        ("supabase", "the database"),
        ("python", "the system"),
        ("async", ""),
        ("await", ""),
    ]
    text_lower = text.lower()
    for term, replacement in replacements:
        if term in text_lower:
            if replacement:
                text = re.sub(re.escape(term), replacement, text, flags=re.IGNORECASE)
            else:
                text = re.sub(r'\b' + re.escape(term) + r'\b', "", text, flags=re.IGNORECASE)
            text_lower = text.lower()
    # Clean up double spaces
    text = re.sub(r"  +", " ", text).strip()
    return text


def _get_domain(url: str) -> str:
    try:
        return urlparse(url).netloc
    except Exception:
        return ""


# URL path fragments that almost always indicate a login/auth wall.
_LOGIN_URL_PATTERNS = (
    "/login", "/signin", "/sign-in", "/sign_in", "/log-in", "/log_in",
    "/auth/", "/account/login", "/users/sign_in", "/accounts/login",
    "/oauth", "/sso", "/checkpoint", "/identifier", "/identifiersignin",
    "/authenticate",
)

# Phrases that strongly suggest a login wall when seen in visible page text.
_LOGIN_PAGE_PHRASES = (
    "sign in to continue",
    "log in to continue",
    "please sign in",
    "please log in",
    "create an account or sign in",
    "you must be logged in",
    "you need to be signed in",
    "enter your password",
    "forgot password",
)


def _looks_like_login(url: str, page_text: str) -> bool:
    """Heuristic: does this look like a login/auth wall?"""
    if not url and not page_text:
        return False
    url_l = (url or "").lower()
    for pat in _LOGIN_URL_PATTERNS:
        if pat in url_l:
            return True
    text_l = (page_text or "").lower()
    for phrase in _LOGIN_PAGE_PHRASES:
        if phrase in text_l:
            return True
    return False


async def _load_cookies(user_id: str, domain: str) -> list[dict] | None:
    """Load saved cookies from Supabase, decrypt."""
    try:
        rows = await supabase_client.select_rows(
            "browser_profiles",
            filters={"user_id": user_id, "site_domain": domain},
            limit=1,
        )
        if rows:
            encrypted = rows[0].get("cookies_json", "")
            if not encrypted:
                return None
            try:
                cookies_json = _fernet.decrypt(encrypted.encode("utf-8")).decode("utf-8")
            except Exception:
                cookies_json = encrypted
            cookies = json.loads(cookies_json)
            if cookies:
                return cookies
    except Exception:
        pass
    return None


async def _save_cookies(user_id: str, domain: str, cookies: list[dict]) -> None:
    """Encrypt and save cookies to Supabase."""
    try:
        # Sanitize cookies — never store passwords or sensitive form data
        safe_cookies = []
        for c in cookies:
            cookie = dict(c)
            # Strip any cookie that looks like it contains credentials
            name_lower = cookie.get("name", "").lower()
            if any(kw in name_lower for kw in ("password", "passwd", "secret", "credit", "card")):
                continue
            safe_cookies.append(cookie)

        cookies_json = json.dumps(safe_cookies)
        encrypted = _fernet.encrypt(cookies_json.encode("utf-8")).decode("utf-8")
        await supabase_client.upsert_row(
            "browser_profiles",
            {
                "user_id": user_id,
                "site_domain": domain,
                "cookies_json": encrypted,
                "updated_at": "now()",
            },
        )
    except Exception:
        pass


async def _send_status(send: SendFn, message: str) -> None:
    await send({"type": "status", "message": message})


async def _send_confirm(send: SendFn, message: str, action: str) -> None:
    await send({"type": "confirm", "message": message, "action": action})


async def _send_login(send: SendFn) -> None:
    await send({"type": "login_needed", "message": msg.LOGIN_NEEDED})


async def _send_complete(send: SendFn, message: str) -> None:
    await send({"type": "complete", "message": message})


async def _send_error(send: SendFn, message: str) -> None:
    await send({"type": "error", "message": message})


class EngineAgent:
    """
    Wraps Browser Use Agent with Anticipy's safety, streaming, and cookie management.
    """

    def __init__(
        self,
        goal: str,
        send: SendFn,
        receive_confirmation: Callable[[], Awaitable[str]],
        user_id: str | None = None,
    ) -> None:
        self.goal = sanitize_input(goal)
        self.send = send
        self.receive_confirmation = receive_confirmation
        self.user_id = user_id
        self.tracker = CostTracker()
        self._session: BrowserSession | None = None
        self._last_status_time: float = 0.0
        self._step_count: int = 0
        self._start_time: float = 0.0
        self._stopped: bool = False
        self._login_notified: bool = False

    async def _on_step(self, browser_state, agent_output, step_num) -> None:
        """Callback fired after each Browser Use step. Streams status to user."""
        self._step_count = step_num
        now = time.time()

        # Budget check — time
        elapsed = now - self._start_time
        if elapsed > MAX_SECONDS:
            self._stopped = True
            return

        # --- Login wall detection (one-shot per task) ---
        if not self._login_notified:
            current_url = ""
            page_text = ""
            try:
                current_url = getattr(browser_state, "url", "") or ""
            except Exception:
                pass
            try:
                # Browser Use exposes page snapshot under different attrs across versions —
                # try common ones, fall through quietly if not present
                snap = getattr(browser_state, "elements_text", "") or ""
                if not snap:
                    snap = getattr(browser_state, "page_text", "") or ""
                page_text = (snap or "")[:1500].lower()
            except Exception:
                pass

            if _looks_like_login(current_url, page_text):
                self._login_notified = True
                await _send_login(self.send)
                # Don't stop — the agent may still be able to complete via guest checkout,
                # or the user may sign in inside the browser window and we keep going.

        # Throttle status updates to every 2 seconds
        if now - self._last_status_time < 2.0:
            return
        self._last_status_time = now

        # Determine status message from the agent's actions
        status_msg = msg.TASK_PERFORMING_ACTION
        if agent_output and agent_output.action:
            for action in agent_output.action:
                try:
                    # ActionModel is dynamic — dump to dict to inspect
                    action_dict = action.model_dump(exclude_none=True)
                    for action_name in action_dict.keys():
                        action_lower = action_name.lower()
                        for key, val in _ACTION_STATUS_MAP.items():
                            if key in action_lower:
                                status_msg = val
                                break
                except Exception:
                    pass

        # Use next_goal for more descriptive status if available
        description = status_msg.rstrip(".")
        if agent_output and agent_output.next_goal:
            # Use a simplified version of next_goal, sanitized to remove technical terms
            goal_text = agent_output.next_goal[:80]
            if len(agent_output.next_goal) > 80:
                goal_text += "..."
            description = _sanitize_status(goal_text)

        progress = msg.STEP_PROGRESS.format(current=step_num, description=description)
        await _send_status(self.send, progress)

    async def _should_stop(self) -> bool:
        """Check if agent should stop (budget exceeded)."""
        if self._stopped:
            return True
        elapsed = time.time() - self._start_time
        if elapsed > MAX_SECONDS:
            self._stopped = True
            return True
        return False

    async def run(self) -> None:
        """Execute the full agent loop using Browser Use."""
        self._start_time = time.time()
        self._last_status_time = self._start_time

        try:
            # --- Safety check ---
            if check_blocked(self.goal):
                await _send_error(self.send, msg.BLOCKED_ACTION)
                return

            # --- Plan (get starting URL) ---
            await _send_status(self.send, msg.TASK_STARTING)
            plan = await plan_task(self.goal, self.tracker)
            start_url = plan["url"]

            # --- Configure browser session ---
            profile_dir = os.path.join(
                BROWSER_PROFILE_BASE, self.user_id or "_anonymous"
            )
            os.makedirs(profile_dir, exist_ok=True)

            # Build chrome args for stealth and stability
            chrome_args = [
                "--disable-blink-features=AutomationControlled",
                "--no-sandbox",
                "--disable-dev-shm-usage",
                "--disable-infobars",
                "--window-size=1920,1080",
                # Software WebGL fallback to prevent crashes on GPU-intensive pages
                "--use-gl=swiftshader",
                "--no-first-run",
                "--no-default-browser-check",
            ]

            # NopeCHA extension for CAPTCHA solving
            nopecha_dir = os.path.join(os.path.dirname(__file__), "..", "nopecha")
            if os.path.isdir(nopecha_dir):
                chrome_args.extend([
                    f"--disable-extensions-except={nopecha_dir}",
                    f"--load-extension={nopecha_dir}",
                ])

            self._session = BrowserSession(
                headless=False,
                user_data_dir=profile_dir,
                args=chrome_args,
                no_viewport=True,
                user_agent=(
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) "
                    "Chrome/120.0.0.0 Safari/537.36"
                ),
                wait_between_actions=0.5,
                minimum_wait_page_load_time=0.5,
                wait_for_network_idle_page_load_time=3.0,
            )

            # --- Load saved cookies ---
            domain = _get_domain(start_url)
            cookies = None
            if self.user_id and domain:
                cookies = await _load_cookies(self.user_id, domain)

            # Start session and inject cookies before agent runs
            await self._session.start()
            if cookies and self._session._browser_context:
                try:
                    await self._session._browser_context.add_cookies(cookies)
                except Exception:
                    pass

            # --- Get LLM ---
            llm = _get_llm()

            # --- Build task with starting URL hint ---
            task = self.goal
            if start_url and not start_url.startswith("https://www.google.com/search"):
                task = f"Go to {start_url} and {self.goal}"

            # --- Create Browser Use agent ---
            await _send_status(self.send, msg.TASK_NAVIGATING)

            agent = Agent(
                task=task,
                llm=llm,
                browser_session=self._session,
                max_actions_per_step=3,
                max_failures=5,
                use_vision=True,
                register_new_step_callback=self._on_step,
                register_should_stop_callback=self._should_stop,
                generate_gif=False,
                enable_planning=True,
                loop_detection_enabled=True,
            )

            # --- Run with hard timeout ---
            try:
                history: AgentHistoryList = await asyncio.wait_for(
                    agent.run(max_steps=MAX_STEPS),
                    timeout=MAX_SECONDS + 30,
                )
            except asyncio.TimeoutError:
                await _send_error(self.send, msg.BUDGET_TIME_EXCEEDED)
                await self._save_session_cookies(start_url)
                return

            # --- Process result ---
            await self._save_session_cookies(start_url)

            if history.is_done():
                result_text = history.final_result()
                if result_text and len(result_text.strip()) > 2:
                    # Clean any technical leakage from the result
                    clean_result = _sanitize_output(result_text)
                    await _send_complete(self.send, clean_result)
                else:
                    await _send_complete(
                        self.send,
                        "I completed the task but couldn't get a clear answer. Can you check?"
                    )
            elif self._stopped:
                await _send_error(self.send, msg.BUDGET_TIME_EXCEEDED)
            else:
                # Try to extract any partial result
                result_text = history.final_result()
                if result_text:
                    clean_result = _sanitize_output(result_text)
                    await _send_complete(self.send, clean_result)
                else:
                    await _send_complete(self.send, msg.TASK_STUCK)

        except asyncio.CancelledError:
            await _send_error(self.send, msg.TASK_INTERRUPTED)
        except Exception:
            logger.exception("Agent execution error")
            # If we hit a login wall *and* errored, surface that instead of the
            # generic connection error — it's far more actionable for the user.
            if self._login_notified:
                await _send_error(
                    self.send,
                    "I couldn't get past the sign-in screen. Try signing in to "
                    "the site in your browser first, then ask me again.",
                )
            else:
                await _send_error(self.send, msg.CONNECTION_ERROR)
        finally:
            await self._close()

    async def _save_session_cookies(self, start_url: str) -> None:
        """Save cookies from the current browser session."""
        if not self.user_id or not self._session:
            return
        try:
            domain = _get_domain(start_url)
            # Also save cookies for current URL domain
            current_url = await self._session.get_current_page_url()
            current_domain = _get_domain(current_url) if current_url else ""

            cookies = await self._session.cookies()
            if cookies and domain:
                # Filter cookies for this domain
                domain_cookies = [
                    c for c in cookies
                    if domain in (c.get("domain", "") or "")
                ]
                if domain_cookies:
                    await _save_cookies(self.user_id, domain, domain_cookies)

            if current_domain and current_domain != domain and cookies:
                current_cookies = [
                    c for c in cookies
                    if current_domain in (c.get("domain", "") or "")
                ]
                if current_cookies:
                    await _save_cookies(self.user_id, current_domain, current_cookies)
        except Exception:
            pass

    async def _close(self) -> None:
        """Close browser session."""
        try:
            if self._session:
                await self._session.stop()
        except Exception:
            pass
        self._session = None


# --- Technical leakage sanitization ---

_BANNED_PATTERNS = [
    "json", "api", "error", "model", "token", "null", "undefined",
    "traceback", "timeout", "500", "429", "dom", "selector",
    "accessibility", "xpath", "css", "javascript", "python",
    "function", "debug", "console", "http", "endpoint", "exception",
]


def _sanitize_output(text: str) -> str:
    """
    Remove technical terms from agent output that users should never see.
    Strip markdown code blocks and JSON formatting.
    """
    if not text:
        return text

    import re

    # Strip markdown code blocks (```json ... ```)
    had_code_blocks = '```' in text
    text = re.sub(r'```(?:json)?\s*', '', text)
    text = re.sub(r'```\s*', '', text)

    # Convert JSON array/object formatting to plain text
    # Replace {"name": "X", "price": "Y"} patterns with readable format
    def _json_to_plain(match):
        try:
            import json as _json
            data = _json.loads(match.group(0))
            if isinstance(data, list):
                lines = []
                for i, item in enumerate(data, 1):
                    if isinstance(item, dict):
                        parts = []
                        for k, v in item.items():
                            parts.append(str(v))
                        lines.append(f"{i}. {' — '.join(parts)}")
                    else:
                        lines.append(f"{i}. {item}")
                return '\n'.join(lines)
            elif isinstance(data, dict):
                return ', '.join(f"{k}: {v}" for k, v in data.items())
        except Exception:
            pass
        return match.group(0)

    # Only convert JSON if markdown code blocks were present
    if had_code_blocks:
        text = re.sub(r'\[\s*\{[^]]+\}\s*\]', _json_to_plain, text, flags=re.DOTALL)

    # Technical terms that should never appear in user-facing output
    tech_terms_to_strip = [
        "javascript", "xpath", "css selector", "dom element", "iframe",
        "accessibility tree", "playwright", "patchright", "chromium", "webdriver",
        "api call", "http request", "json response",
        "groq", "gemini", "llama", "deepseek",
        "supabase", "fastapi", "httpx",
    ]

    text_lower = text.lower()

    # Replace technical terms with user-friendly alternatives
    for term in tech_terms_to_strip:
        if term in text_lower:
            text = re.sub(re.escape(term), "a different method", text, flags=re.IGNORECASE)
            text_lower = text.lower()

    # These are only problematic when they appear in error-like contexts
    error_indicators = [
        "traceback", "exception", "stack trace", "status code",
        "api error", "http error", "500 internal", "429 too many",
        "null pointer", "undefined is not",
    ]

    for indicator in error_indicators:
        if indicator in text_lower:
            return "I ran into a problem completing that. Want to try again?"

    return text.strip()


# --- Public entry point ---

async def execute_task(
    goal: str,
    send: SendFn,
    receive_confirmation: Callable[[], Awaitable[str]],
    user_id: str | None = None,
) -> None:
    """
    Top-level entry point. Creates an EngineAgent and runs it
    with a hard timeout. Called by main.py WebSocket handler.
    """
    agent = EngineAgent(goal, send, receive_confirmation, user_id)
    try:
        await asyncio.wait_for(agent.run(), timeout=MAX_SECONDS + 60)
    except asyncio.TimeoutError:
        await _send_error(send, msg.BUDGET_TIME_EXCEEDED)
    finally:
        await agent._close()


# PHASE 2: User device fallback
# If datacenter IP is blocked, offer to run the browser on the user's device instead.
# Architecture: Browser Use connects to a remote Chrome instance on user's machine
# via Chrome DevTools Protocol. The user installs a lightweight bridge app that
# exposes their local Chrome to the cloud agent. This gives residential IP + real
# browser fingerprint. Implementation deferred to post-raise.
