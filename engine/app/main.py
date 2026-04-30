"""
FastAPI server with WebSocket task execution, REST auth endpoints,
rate limiting, input validation, graceful shutdown, and admin stats.
"""

from __future__ import annotations

import asyncio
import json
import logging
import signal
import time
import uuid
from collections import defaultdict
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, Depends, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from app import auth as auth_module
from app import messages as msg
from app.router import classify, handle_chat, handle_question, needs_clarification
from app.agent import execute_task
from app.models import CostTracker
from app.planner import plan_task
from app.safety import check_blocked, sanitize_input
from app.config import (
    MAX_INPUT_LENGTH,
    MAX_SECONDS,
    MAX_TASKS_PER_HOUR,
    MAX_TASKS_PER_DAY,
    REQUIRED_ENV_VARS,
    MODEL_CHAIN,
    ENGINE_INTERNAL_TOKEN,
)
from app import supabase_client
import os

logger = logging.getLogger("engine")


# --- Rate limiting state ---
# Maps user_id -> list of task timestamps
_task_timestamps: dict[str, list[float]] = defaultdict(list)


def _check_task_rate_limit(user_id: str) -> str | None:
    """
    Check task rate limits per user.
    Returns an error message string if rate-limited, None if OK.
    """
    now = time.time()
    timestamps = _task_timestamps.get(user_id, [])

    # Clean old timestamps
    hour_ago = now - 3600
    day_ago = now - 86400
    timestamps = [ts for ts in timestamps if ts > day_ago]
    _task_timestamps[user_id] = timestamps

    hour_count = sum(1 for ts in timestamps if ts > hour_ago)
    day_count = len(timestamps)

    if hour_count >= MAX_TASKS_PER_HOUR:
        return msg.RATE_LIMIT_TASKS
    if day_count >= MAX_TASKS_PER_DAY:
        return msg.BUDGET_DAILY_EXCEEDED
    return None


def _record_task(user_id: str) -> None:
    """Record a task execution for rate limiting."""
    _task_timestamps[user_id].append(time.time())


# --- Startup stats ---
_start_time: float = 0.0
_total_tasks: int = 0
_total_errors: int = 0


def _validate_env_vars() -> list[str]:
    """Check required environment variables. Returns list of missing vars."""
    missing = []
    for var in REQUIRED_ENV_VARS:
        if not os.environ.get(var):
            missing.append(var)
    return missing


# --- Database migration check ---
REQUIRED_TABLES = ["engine_users", "browser_profiles", "engine_tasks"]


async def _check_database_tables() -> list[str]:
    """Check if required database tables are accessible. Returns list of missing/inaccessible tables."""
    missing = []
    for table in REQUIRED_TABLES:
        try:
            await supabase_client.select_rows(table, limit=1)
        except Exception:
            missing.append(table)
    return missing


# --- Lifespan ---
@asynccontextmanager
async def lifespan(app: FastAPI):
    global _start_time
    _start_time = time.time()

    # Validate env vars on startup (V65)
    missing = _validate_env_vars()
    if missing:
        logger.warning(f"Missing environment variables: {', '.join(missing)}")

    # Check model chain
    if not MODEL_CHAIN:
        logger.warning("No LLM API keys configured. The engine will not be able to process tasks.")

    # Check database tables (V67)
    try:
        missing_tables = await _check_database_tables()
        if missing_tables:
            logger.warning(f"Database tables not accessible: {', '.join(missing_tables)}")
    except Exception:
        logger.warning("Could not verify database tables on startup.")

    # Graceful shutdown handler (V64)
    loop = asyncio.get_event_loop()

    def _shutdown_handler():
        logger.info("Received shutdown signal, cleaning up...")
        for task in asyncio.all_tasks(loop):
            task.cancel()

    try:
        loop.add_signal_handler(signal.SIGTERM, _shutdown_handler)
        loop.add_signal_handler(signal.SIGINT, _shutdown_handler)
    except (NotImplementedError, RuntimeError):
        # Signal handlers not supported on this platform (e.g., Windows)
        pass

    logger.info("Anticipy Action Engine started.")
    yield
    logger.info("Anticipy Action Engine shutting down.")


app = FastAPI(title="Anticipy Action Engine", version="1.0.0", lifespan=lifespan)

# --- CORS (restricted to known origins) ---
ALLOWED_ORIGINS = [
    "https://anticipy-beta.vercel.app",
    "https://anticipy.ai",
    "https://www.anticipy.ai",
    "http://localhost:3000",
    "http://localhost:8000",
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)


# --- Pydantic models ---
class AuthRequest(BaseModel):
    username: str
    password: str


class AuthResponse(BaseModel):
    success: bool
    token: str | None = None
    user_id: str | None = None
    message: str


class UserResponse(BaseModel):
    user_id: str
    username: str


# --- Auth dependency ---
async def get_current_user(token: str) -> dict:
    payload = auth_module.verify_token(token)
    if not payload:
        raise HTTPException(status_code=401, detail=msg.AUTH_TOKEN_INVALID)
    return payload


def _get_client_ip(request: Request) -> str:
    """Extract client IP from request."""
    forwarded = request.headers.get("x-forwarded-for")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


# --- REST endpoints ---
@app.post("/auth/signup", response_model=AuthResponse)
async def signup(req: AuthRequest):
    if not req.username or not req.password:
        return AuthResponse(success=False, message=msg.AUTH_MISSING_FIELDS)
    if len(req.password) < 6:
        return AuthResponse(success=False, message="Password must be at least 6 characters.")

    result = await auth_module.signup(req.username.strip(), req.password)
    if result["success"]:
        return AuthResponse(
            success=True,
            token=result["token"],
            user_id=result["user_id"],
            message=msg.AUTH_SIGNUP_SUCCESS,
        )
    if result.get("error") == "exists":
        return AuthResponse(success=False, message=msg.AUTH_USER_EXISTS)
    return AuthResponse(success=False, message=msg.CONNECTION_ERROR)


@app.post("/auth/login", response_model=AuthResponse)
async def login(req: AuthRequest, request: Request):
    if not req.username or not req.password:
        return AuthResponse(success=False, message=msg.AUTH_MISSING_FIELDS)

    client_ip = _get_client_ip(request)

    # Check rate limit (V17)
    if auth_module.check_login_rate_limit(client_ip):
        return AuthResponse(success=False, message=msg.AUTH_RATE_LIMITED)

    result = await auth_module.login(req.username.strip(), req.password, ip=client_ip)
    if result["success"]:
        return AuthResponse(
            success=True,
            token=result["token"],
            user_id=result["user_id"],
            message=msg.AUTH_LOGIN_SUCCESS,
        )
    if result.get("error") == "rate_limited":
        return AuthResponse(success=False, message=msg.AUTH_RATE_LIMITED)
    return AuthResponse(success=False, message=msg.AUTH_INVALID_CREDENTIALS)


@app.get("/auth/me", response_model=UserResponse)
async def me(token: str):
    payload = auth_module.verify_token(token)
    if not payload:
        raise HTTPException(status_code=401, detail=msg.AUTH_TOKEN_INVALID)
    return UserResponse(user_id=payload["user_id"], username=payload["username"])


@app.get("/health")
async def health():
    return {"status": "ok"}


# --- Admin stats endpoint (V66) ---
@app.get("/stats")
async def stats(token: str):
    """Admin monitoring endpoint. Requires valid auth token."""
    payload = auth_module.verify_token(token)
    if not payload:
        raise HTTPException(status_code=401, detail=msg.AUTH_TOKEN_INVALID)

    uptime = time.time() - _start_time if _start_time else 0
    return {
        "uptime_seconds": round(uptime, 1),
        "total_tasks": _total_tasks,
        "total_errors": _total_errors,
        "models_configured": len(MODEL_CHAIN),
    }


# --- Intent execution endpoint ---
# Called by Next.js backend when a user confirms an action.
# Runs the browser agent and returns the result (blocking up to MAX_SECONDS).

class ExecuteIntentRequest(BaseModel):
    task: str
    intent_id: str | None = None
    user_id: str | None = None


@app.post("/execute-intent")
async def execute_intent_endpoint(req: ExecuteIntentRequest, request: Request):
    """
    Execute a browser automation task from a structured intent description.

    Starts the browser agent as a background asyncio task so the browser
    keeps running even if the HTTP client disconnects early.  Waits up to
    25 s for a result before returning a "working" response; the background
    task writes the final outcome to engine_tasks in Supabase either way.

    Requires the X-Engine-Token header to match ENGINE_INTERNAL_TOKEN — this
    is a server-to-server endpoint called by the Next.js backend on behalf of
    a user, not directly by the user. If ENGINE_INTERNAL_TOKEN is not set the
    endpoint refuses all calls (fail-closed).
    """
    if not ENGINE_INTERNAL_TOKEN:
        raise HTTPException(status_code=503, detail="endpoint disabled")
    if request.headers.get("x-engine-token") != ENGINE_INTERNAL_TOKEN:
        raise HTTPException(status_code=401, detail="unauthorized")

    if not req.task or not req.task.strip():
        raise HTTPException(status_code=400, detail="task is required")

    task_text = sanitize_input(req.task.strip())
    if not task_text:
        raise HTTPException(status_code=400, detail="task text is empty after sanitization")

    if check_blocked(task_text):
        return {
            "success": False,
            "message": "This action is not permitted.",
            "data": {},
            "plan": "",
        }

    # Surface a clarifying question to the user instead of silently failing on
    # an under-specified task. The Next.js confirm route relays this `message`
    # back to the user verbatim.
    clarification = needs_clarification(task_text)
    if clarification:
        return {
            "success": False,
            "needs_clarification": True,
            "message": clarification,
            "data": {"reason": "needs_clarification"},
            "plan": "",
        }

    task_id = str(uuid.uuid4())
    messages_log: list[dict] = []
    plan_text: str = ""

    # --- Generate a quick plan so we can return something useful ---
    try:
        tracker = CostTracker()
        plan = await asyncio.wait_for(plan_task(task_text, tracker), timeout=8)
        sub_goals = plan.get("sub_goals", [])
        if sub_goals:
            plan_text = " → ".join(str(g) for g in sub_goals[:3])
    except Exception:
        pass  # Plan is optional; proceed without it

    # --- Result container shared between background task and waiter ---
    result_holder: list[dict] = []  # holds at most one result dict

    async def collect(msg_dict: dict) -> None:
        messages_log.append(msg_dict)

    async def receive_confirmation() -> str:
        return "confirmed"  # Auto-confirm for API-driven executions

    async def run_and_store() -> None:
        """Run the browser agent and persist the result to Supabase."""
        try:
            await execute_task(
                goal=task_text,
                send=collect,
                receive_confirmation=receive_confirmation,
                user_id=req.user_id,
            )
        except Exception:
            logger.exception("execute_intent background task error")

        # Derive final result from collected messages
        final: dict = {"success": False, "message": "No result returned from agent.", "data": {}}
        for m in reversed(messages_log):
            m_type = m.get("type")
            if m_type == "complete":
                final = {"success": True, "message": m.get("message", "Done."), "data": {}}
                break
            if m_type == "error":
                final = {"success": False, "message": m.get("message", "Task failed."), "data": {}}
                break

        result_holder.append(final)

        # Persist to engine_tasks
        try:
            await supabase_client.insert_row(
                "engine_tasks",
                {
                    "id": task_id,
                    "user_id": req.user_id,
                    "goal": task_text,
                    "status": "completed" if final["success"] else "failed",
                    "result": final["message"],
                    "metadata": {
                        "intent_id": req.intent_id,
                        "plan": plan_text,
                        "log_count": len(messages_log),
                    },
                },
            )
        except Exception:
            pass  # Non-critical

        # Update anticipy_actions if intent_id provided
        if req.intent_id:
            try:
                await supabase_client.insert_row(
                    "anticipy_actions",
                    {
                        "intent_id": req.intent_id,
                        "status": "success" if final["success"] else "failed",
                        "result": {"message": final["message"], "task_id": task_id},
                        "external_id": task_id,
                    },
                )
            except Exception:
                pass  # anticipy_actions may not exist in engine db — Next.js handles it too

    # Start the browser task in background (survives HTTP disconnect)
    bg_task = asyncio.create_task(run_and_store())

    # Wait up to 25 s for an early result
    try:
        await asyncio.wait_for(asyncio.shield(bg_task), timeout=25)
    except asyncio.TimeoutError:
        # Task is still running; return a "working" response so Next.js
        # can show the user "Working on it…" without blocking the HTTP response.
        return {
            "success": True,
            "working": True,
            "message": "Working on it — this may take a minute.",
            "data": {"task_id": task_id},
            "plan": plan_text,
        }
    except Exception:
        pass  # Will be captured in result_holder

    if result_holder:
        r = result_holder[0]
        return {
            "success": r["success"],
            "message": r["message"],
            "data": {**r.get("data", {}), "task_id": task_id},
            "plan": plan_text,
        }

    return {
        "success": False,
        "message": "Agent finished without a clear result.",
        "data": {"task_id": task_id},
        "plan": plan_text,
    }


# --- WebSocket task execution ---
@app.websocket("/ws/task")
async def ws_task(websocket: WebSocket):
    global _total_tasks, _total_errors
    await websocket.accept()

    # Confirmation channel: agent blocks on this when it needs user input
    confirm_event = asyncio.Event()
    confirm_value: list[str] = [""]

    async def send_msg(data: dict) -> None:
        """Send a JSON message to the WebSocket client."""
        try:
            await websocket.send_json(data)
        except Exception:
            pass

    async def receive_confirmation() -> str:
        """Block until the client sends a confirm/continue message."""
        confirm_event.clear()
        confirm_value[0] = ""
        try:
            await asyncio.wait_for(confirm_event.wait(), timeout=120)
        except asyncio.TimeoutError:
            return "timeout"
        return confirm_value[0]

    user_id: str | None = None
    task_running = False
    bg_task: asyncio.Task | None = None

    # Extract token from query params
    query_token = websocket.query_params.get("token")
    if query_token:
        payload = auth_module.verify_token(query_token)
        if payload:
            user_id = payload["user_id"]

    try:
        while True:
            raw = await websocket.receive_text()
            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                await send_msg({"type": "error", "message": msg.CONNECTION_ERROR})
                continue

            msg_type = data.get("type", "")

            # --- Authentication (optional, via token field in message body) ---
            if "token" in data and not user_id:
                payload = auth_module.verify_token(data["token"])
                if payload:
                    user_id = payload["user_id"]

            # --- Start task ---
            if msg_type == "start":
                if task_running:
                    await send_msg({"type": "error", "message": msg.CONNECTION_ERROR})
                    continue

                text = data.get("text", "").strip()
                if not text:
                    await send_msg({"type": "error", "message": msg.AMBIGUOUS_REQUEST})
                    continue

                # Input size limit (V27)
                if len(text) > MAX_INPUT_LENGTH:
                    await send_msg({"type": "error", "message": msg.INPUT_TOO_LONG})
                    continue

                # Sanitize input (V19)
                text = sanitize_input(text)
                if not text:
                    await send_msg({"type": "error", "message": msg.AMBIGUOUS_REQUEST})
                    continue

                # Safety check FIRST — before classification
                if check_blocked(text):
                    await send_msg({"type": "complete", "message": msg.BLOCKED_ACTION})
                    continue

                # Rate limiting on task creation (V18)
                rate_user = user_id or "anonymous"
                rate_error = _check_task_rate_limit(rate_user)
                if rate_error:
                    await send_msg({"type": "error", "message": rate_error})
                    continue

                # Classify intent
                tracker = CostTracker()
                category = await classify(text, tracker)

                if category == "chat":
                    response = await handle_chat(text, tracker)
                    await send_msg({"type": "complete", "message": response})
                    continue

                if category == "question":
                    answer = await handle_question(text, tracker)
                    await send_msg({"type": "complete", "message": answer})
                    continue

                if category == "ambiguous":
                    await send_msg({"type": "complete", "message": msg.AMBIGUOUS_REQUEST})
                    continue

                # category == "action"
                # Ask one clarifying question up front for vague requests so we
                # don't burn a 30-second browser session and fail. The user can
                # reply with the missing details and re-issue the task.
                clarification = needs_clarification(text)
                if clarification:
                    await send_msg({"type": "complete", "message": clarification})
                    continue

                _record_task(rate_user)
                _total_tasks += 1

                # Run the agent in the background
                task_running = True

                async def run_task():
                    nonlocal task_running
                    global _total_errors
                    try:
                        await execute_task(
                            goal=text,
                            send=send_msg,
                            receive_confirmation=receive_confirmation,
                            user_id=user_id,
                        )
                    except asyncio.CancelledError:
                        raise
                    except Exception:
                        _total_errors += 1
                        await send_msg({"type": "error", "message": msg.CONNECTION_ERROR})
                    finally:
                        task_running = False

                bg_task = asyncio.create_task(run_task())

            # --- Confirmation / continue ---
            elif msg_type in ("confirm", "continue"):
                value = data.get("value", data.get("text", "continue"))
                confirm_value[0] = str(value)
                confirm_event.set()

            else:
                await send_msg({"type": "error", "message": msg.CONNECTION_ERROR})

    except WebSocketDisconnect:
        pass
    except Exception:
        try:
            await websocket.close()
        except Exception:
            pass
    finally:
        # Cancel any running browser task so we don't leak browser sessions
        # or burn LLM tokens after the client disconnects.
        if bg_task is not None and not bg_task.done():
            bg_task.cancel()
            try:
                await bg_task
            except (asyncio.CancelledError, Exception):
                pass
