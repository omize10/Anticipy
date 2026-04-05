"""
Core execution loop for the Anticipy Action Engine.
Receives a goal, drives the browser step-by-step, and streams status via callback.
"""

from __future__ import annotations

import asyncio
import time
from typing import Callable, Awaitable
from urllib.parse import urlparse

from app.config import MAX_STEPS, MAX_SECONDS, VERIFY_EVERY_N_STEPS, LOOP_DETECTION_THRESHOLD
from app.models import CostTracker, llm_call_json
from app.browser import BrowserManager
from app.harness import (
    extract_interactive_elements,
    format_prompt,
    describe_action,
    validate_action,
)
from app.safety import (
    check_blocked,
    check_needs_confirmation,
    check_page_for_auto_dismiss,
    sanitize_input,
)
from app.planner import plan_task
from app.verifier import verify_goal, mid_task_check
from app.captcha import detect_captcha_in_tree, attempt_solve
from app.vision import get_page_description
from app import messages as msg


# Callback type: async function that sends a message dict to the client
SendFn = Callable[[dict], Awaitable[None]]

# Maximum silent retries before reporting error to user (V58)
MAX_SILENT_RETRIES = 3

# Status streaming interval in seconds (V59)
STATUS_INTERVAL = 4.0


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


def _detect_login_page(elements: list[dict], url: str) -> bool:
    """Heuristic: detect if current page is a login form."""
    has_password = False
    has_username = False

    for elem in elements:
        name_lower = (elem.get("name") or "").lower()
        role = (elem.get("role") or "").lower()

        if role == "textbox" and any(kw in name_lower for kw in ("password",)):
            has_password = True
        if role == "textbox" and any(
            kw in name_lower for kw in ("email", "username", "user", "login")
        ):
            has_username = True

    url_lower = url.lower()
    url_has_login = any(kw in url_lower for kw in ("login", "signin", "sign-in", "log-in", "auth"))

    return (has_password and has_username) or (has_password and url_has_login)


def _get_domain(url: str) -> str:
    try:
        return urlparse(url).netloc
    except Exception:
        return ""


def _is_duplicate_irreversible(action_desc: str, history: list[str]) -> bool:
    """Check if an irreversible action was already performed (V39)."""
    irreversible_keywords = ("purchase", "buy", "order", "submit", "send", "pay", "delete", "cancel")
    desc_lower = action_desc.lower()
    if not any(kw in desc_lower for kw in irreversible_keywords):
        return False
    # Check if same action already in history
    return action_desc in history


class AgentLoop:
    """
    The main agent loop. Drives a browser to accomplish a goal.
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
        self.browser = BrowserManager()
        self.memory: list[str] = []
        self.action_history: list[str] = []
        self.step = 0
        self.start_time = 0.0
        self._done_answer: str | None = None
        self._last_status_time: float = 0.0
        self._previous_url: str = ""
        self._sub_goals: list[str] = []
        self._current_sub_goal_idx: int = 0

    async def _stream_status_if_due(self, message: str) -> None:
        """Stream status to user at throttled interval (V59)."""
        now = time.time()
        if now - self._last_status_time >= STATUS_INTERVAL:
            await _send_status(self.send, message)
            self._last_status_time = now

    async def _execute_with_retries(self, action: dict, elements: list[dict]) -> bool:
        """Execute action with silent retries (V58)."""
        for attempt in range(MAX_SILENT_RETRIES):
            success = await self.browser.execute_action(action, elements)
            if success:
                return True
            if attempt < MAX_SILENT_RETRIES - 1:
                await asyncio.sleep(0.5 * (attempt + 1))
        return False

    async def run(self) -> None:
        """Execute the full agent loop."""
        self.start_time = time.time()
        self._last_status_time = self.start_time

        try:
            # --- Safety check ---
            if check_blocked(self.goal):
                await _send_error(self.send, msg.BLOCKED_ACTION)
                return

            # --- Plan ---
            await _send_status(self.send, msg.TASK_STARTING)
            plan = await plan_task(self.goal, self.tracker)
            start_url = plan["url"]
            self._sub_goals = plan["sub_goals"]
            success_indicator = plan["success"]

            # --- Launch browser ---
            await self.browser.launch(self.user_id)
            page = await self.browser.new_context(self.user_id)

            # Load saved cookies for domain
            domain = _get_domain(start_url)
            if self.user_id and domain:
                await self.browser.load_cookies(self.user_id, domain)

            # --- Navigate to start ---
            await _send_status(self.send, msg.TASK_NAVIGATING)
            self._previous_url = start_url
            await self.browser.navigate(start_url)

            # --- Main loop ---
            while self.step < MAX_STEPS:
                self.step += 1
                elapsed = time.time() - self.start_time

                # Budget checks
                if elapsed > MAX_SECONDS:
                    await _send_error(self.send, msg.BUDGET_TIME_EXCEEDED)
                    break
                if self.tracker.exceeded:
                    await _send_error(self.send, msg.BUDGET_COST_EXCEEDED)
                    break

                # Get current state
                current_url = await self.browser.get_url()

                # Save URL before navigation for rollback (V38)
                self._previous_url = current_url

                tree = await self.browser.get_accessibility_tree()
                elements = extract_interactive_elements(tree)

                # --- Canvas-heavy page detection (V29-V30) ---
                if await self.browser.detect_canvas_heavy():
                    page_text = await self.browser.get_page_text()
                    if page_text:
                        self.memory.append("canvas-heavy page, using text")
                    # Continue with whatever elements we have, fall back to text

                # --- CAPTCHA detection ---
                captcha_info = detect_captcha_in_tree(tree)
                if captcha_info:
                    await _send_status(self.send, msg.CAPTCHA_DETECTED)
                    solved = await attempt_solve(page, current_url)
                    if solved:
                        await _send_status(self.send, msg.CAPTCHA_SOLVED)
                        continue
                    else:
                        # Ask user to solve manually
                        await _send_status(self.send, msg.CAPTCHA_MANUAL)
                        user_resp = await self.receive_confirmation()
                        continue

                # --- Cookie consent auto-dismiss ---
                dismiss_elem = check_page_for_auto_dismiss(elements)
                if dismiss_elem:
                    await self._execute_with_retries(
                        {"action": "click", "target": dismiss_elem["label"], "value": None},
                        elements,
                    )
                    self.memory.append("dismissed cookie banner")
                    await asyncio.sleep(0.5)
                    continue

                # --- Login detection ---
                if _detect_login_page(elements, current_url):
                    await _send_login(self.send)
                    # Wait for user to log in and signal continuation
                    user_resp = await self.receive_confirmation()
                    # Save cookies after login
                    if self.user_id:
                        await self.browser.save_cookies(self.user_id, _get_domain(current_url))
                    continue

                # --- No elements fallback ---
                if not elements:
                    page_text = await self.browser.get_page_text()
                    suggestion = await get_page_description(
                        page_text, current_url, self.goal, self.tracker
                    )
                    if suggestion:
                        sug_action = suggestion.get("suggestion", "scroll")
                        if sug_action == "scroll":
                            await self._execute_with_retries(
                                {"action": "scroll", "target": None, "value": "down"},
                                [],
                            )
                            self.memory.append("scrolled (no elements)")
                            continue
                        elif sug_action == "navigate" and suggestion.get("url"):
                            await self.browser.navigate(suggestion["url"])
                            self.memory.append("navigated (fallback)")
                            continue
                        elif sug_action == "done":
                            break
                    # Default: scroll down
                    await self._execute_with_retries(
                        {"action": "scroll", "target": None, "value": "down"},
                        [],
                    )
                    self.memory.append("scrolled (empty page)")
                    continue

                # --- Mid-task verification ---
                if self.step > 1 and self.step % VERIFY_EVERY_N_STEPS == 0:
                    await self._stream_status_if_due(msg.MIDTASK_CHECK)
                    title = await self.browser.get_title()
                    check = await mid_task_check(
                        self.goal, current_url, title, self.action_history, self.tracker
                    )
                    if not check.get("on_track", True) and check.get("suggestion"):
                        self.memory.append(f"course-correct: {check['suggestion'][:50]}")

                # --- Loop detection ---
                if len(self.action_history) >= LOOP_DETECTION_THRESHOLD:
                    recent = self.action_history[-LOOP_DETECTION_THRESHOLD:]
                    if len(set(recent)) == 1:
                        await _send_status(self.send, msg.LOOP_DETECTED)
                        self.memory.append("LOOP: tried same action 3x, need different approach")

                # --- Get page text for context ---
                page_text = await self.browser.get_page_text()

                # --- Ask the LLM for next action ---
                await self._stream_status_if_due(
                    msg.STEP_PROGRESS.format(current=self.step, description="deciding next step...")
                )

                prompt_messages = format_prompt(
                    self.goal,
                    current_url,
                    elements,
                    self.memory,
                    self.step,
                    MAX_STEPS,
                    page_text=page_text,
                    sub_goals=self._sub_goals,
                    current_sub_goal_idx=self._current_sub_goal_idx,
                )
                action = await llm_call_json(
                    prompt_messages, self.tracker, temperature=0.0, max_tokens=200
                )

                if not action or "action" not in action:
                    # LLM failed to respond — try scrolling
                    self.memory.append("no response, scrolling")
                    await self._stream_status_if_due(msg.TASK_SCROLLING)
                    await self._execute_with_retries(
                        {"action": "scroll", "target": None, "value": "down"},
                        [],
                    )
                    continue

                # --- Validate action against actual elements (V41) ---
                validated = validate_action(action, elements)
                if not validated:
                    self.memory.append("invalid action, scrolling")
                    await self._execute_with_retries(
                        {"action": "scroll", "target": None, "value": "down"},
                        [],
                    )
                    continue

                action = validated
                act_type = action.get("action", "")
                act_desc = describe_action(action)

                # --- Terminal actions ---
                if act_type == "done":
                    answer = action.get("value")
                    if answer and isinstance(answer, str) and len(answer) > 5:
                        self._done_answer = answer
                    break

                if act_type == "stuck":
                    await _send_error(self.send, msg.TASK_STUCK)
                    break

                if act_type == "need_info":
                    info_needed = action.get("value", "more information")
                    await _send_confirm(self.send, f"I need some information: {info_needed}", "info")
                    user_resp = await self.receive_confirmation()
                    self.memory.append(f"user said: {user_resp[:50]}")
                    self.goal = f"{self.goal} ({user_resp[:100]})"
                    continue

                # --- Duplicate irreversible action check (V39) ---
                if _is_duplicate_irreversible(act_desc, self.action_history):
                    self.memory.append(f"SKIPPED duplicate: {act_desc[:30]}")
                    continue

                # --- Safety confirmation ---
                if check_needs_confirmation(act_desc):
                    confirm_msg = msg.CONFIRM_ACTION.format(action=act_desc)
                    await _send_confirm(self.send, confirm_msg, act_desc)
                    user_resp = await self.receive_confirmation()
                    if user_resp.lower() not in ("yes", "y", "ok", "sure", "go ahead", "confirm"):
                        self.memory.append(f"user declined: {act_desc[:30]}")
                        continue

                # --- Execute action ---
                status_map = {
                    "click": msg.TASK_PERFORMING_ACTION,
                    "type": msg.TASK_TYPING,
                    "select": msg.TASK_SELECTING,
                    "scroll": msg.TASK_SCROLLING,
                    "navigate": msg.TASK_NAVIGATING,
                }
                status_msg = status_map.get(act_type, msg.TASK_PERFORMING_ACTION)
                await self._stream_status_if_due(status_msg)

                success = await self._execute_with_retries(action, elements)
                self.action_history.append(act_desc)
                self.memory.append(act_desc[:40])

                if not success:
                    self.memory.append(f"FAILED: {act_desc[:30]}")

                # Track sub-goal progress
                if success and act_type in ("click", "type", "select", "navigate"):
                    if self._current_sub_goal_idx < len(self._sub_goals) - 1:
                        self._current_sub_goal_idx += 1

                # Small delay for page to settle
                await asyncio.sleep(0.3)

            # --- Final verification ---
            await _send_status(self.send, msg.TASK_VERIFYING)
            current_url = await self.browser.get_url()
            title = await self.browser.get_title()
            page_content = await self.browser.get_page_text()

            verification = await verify_goal(
                self.goal,
                success_indicator,
                current_url,
                title,
                page_content,
                self.action_history,
                self.tracker,
            )

            # Save cookies after task
            if self.user_id:
                domain = _get_domain(current_url)
                if domain:
                    await self.browser.save_cookies(self.user_id, domain)

            # Completion message always includes plain-English summary (V60)
            if self._done_answer:
                await _send_complete(self.send, self._done_answer)
            elif verification.get("done"):
                summary = _build_summary(self.action_history)
                await _send_complete(self.send, f"{msg.TASK_COMPLETE} {summary}")
            else:
                reason = verification.get("reason", "")
                if reason:
                    await _send_complete(
                        self.send,
                        msg.TASK_FAILED.format(reason=reason[:150]),
                    )
                else:
                    await _send_complete(self.send, msg.TASK_STUCK)

        except asyncio.CancelledError:
            await _send_error(self.send, msg.TASK_INTERRUPTED)
        except Exception:
            await _send_error(self.send, msg.CONNECTION_ERROR)
        finally:
            await self.browser.close()


def _build_summary(history: list[str]) -> str:
    """Build a plain-English summary from action history (V60)."""
    if not history:
        return ""
    # Keep it brief: summarize the last few meaningful actions
    meaningful = [h for h in history if not h.startswith("scroll")]
    if not meaningful:
        return ""
    if len(meaningful) <= 3:
        return "I " + ", then ".join(meaningful[:3]) + "."
    return f"I completed {len(meaningful)} steps to get that done."


async def execute_task(
    goal: str,
    send: SendFn,
    receive_confirmation: Callable[[], Awaitable[str]],
    user_id: str | None = None,
) -> None:
    """
    Top-level entry point. Creates an AgentLoop and runs it
    with a hard timeout.
    """
    agent = AgentLoop(goal, send, receive_confirmation, user_id)
    try:
        await asyncio.wait_for(agent.run(), timeout=MAX_SECONDS + 10)
    except asyncio.TimeoutError:
        await _send_error(send, msg.BUDGET_TIME_EXCEEDED)
    finally:
        await agent.browser.close()
