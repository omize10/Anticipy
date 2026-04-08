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
from collections import defaultdict
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, Depends, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from app import auth as auth_module
from app import messages as msg
from app.router import classify, handle_chat, handle_question
from app.agent import execute_task
from app.models import CostTracker
from app.safety import check_blocked, sanitize_input
from app.config import (
    MAX_INPUT_LENGTH,
    MAX_TASKS_PER_HOUR,
    MAX_TASKS_PER_DAY,
    REQUIRED_ENV_VARS,
    MODEL_CHAIN,
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
        "model_names": [m["name"] for m in MODEL_CHAIN],
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
                    except Exception:
                        _total_errors += 1
                        await send_msg({"type": "error", "message": msg.CONNECTION_ERROR})
                    finally:
                        task_running = False

                asyncio.create_task(run_task())

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
