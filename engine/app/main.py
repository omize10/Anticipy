"""
FastAPI server with WebSocket task execution, REST auth endpoints, and CORS.
"""

from __future__ import annotations

import asyncio
import json
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, Depends
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from app import auth as auth_module
from app import messages as msg
from app.router import classify, handle_chat, handle_question
from app.agent import execute_task
from app.models import CostTracker
from app.safety import check_blocked
from app import supabase_client


# --- Lifespan ---
@asynccontextmanager
async def lifespan(app: FastAPI):
    yield


app = FastAPI(title="Anticipy Action Engine", version="1.0.0", lifespan=lifespan)

# --- CORS ---
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
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
async def login(req: AuthRequest):
    if not req.username or not req.password:
        return AuthResponse(success=False, message=msg.AUTH_MISSING_FIELDS)

    result = await auth_module.login(req.username.strip(), req.password)
    if result["success"]:
        return AuthResponse(
            success=True,
            token=result["token"],
            user_id=result["user_id"],
            message=msg.AUTH_LOGIN_SUCCESS,
        )
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


# --- WebSocket task execution ---
@app.websocket("/ws/task")
async def ws_task(websocket: WebSocket):
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
                    await send_msg({"type": "error", "message": "A task is already running."})
                    continue

                text = data.get("text", "").strip()
                if not text:
                    await send_msg({"type": "error", "message": msg.AMBIGUOUS_REQUEST})
                    continue

                # Safety check FIRST — before classification
                if check_blocked(text):
                    await send_msg({"type": "complete", "message": msg.BLOCKED_ACTION})
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

                # Run the agent in the background
                task_running = True

                async def run_task():
                    nonlocal task_running
                    try:
                        await execute_task(
                            goal=text,
                            send=send_msg,
                            receive_confirmation=receive_confirmation,
                            user_id=user_id,
                        )
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
