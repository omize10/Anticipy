"""
Username/password authentication with bcrypt hashing and JWT tokens.
User records stored in Supabase engine_users table.
Rate limiting on login to prevent brute force.
"""

from __future__ import annotations

import time
import uuid
from collections import defaultdict
from typing import Optional

import bcrypt
import jwt

from app.config import JWT_SECRET, JWT_ALGORITHM, JWT_EXPIRY_HOURS, LOGIN_MAX_FAILURES, LOGIN_BLOCK_MINUTES
from app import supabase_client


# --- Login rate limiting ---
# Maps IP -> list of failure timestamps
_login_failures: dict[str, list[float]] = defaultdict(list)


def _clean_old_failures(ip: str) -> None:
    """Remove failure records older than the block window."""
    cutoff = time.time() - LOGIN_BLOCK_MINUTES * 60
    _login_failures[ip] = [ts for ts in _login_failures[ip] if ts > cutoff]
    if not _login_failures[ip]:
        _login_failures.pop(ip, None)


def check_login_rate_limit(ip: str) -> bool:
    """
    Return True if the IP is rate-limited (too many failed logins).
    """
    _clean_old_failures(ip)
    return len(_login_failures.get(ip, [])) >= LOGIN_MAX_FAILURES


def record_login_failure(ip: str) -> None:
    """Record a failed login attempt for the given IP."""
    _login_failures[ip].append(time.time())


def clear_login_failures(ip: str) -> None:
    """Clear failure records on successful login."""
    _login_failures.pop(ip, None)


def _hash_password(password: str) -> str:
    """Hash a password with bcrypt."""
    salt = bcrypt.gensalt(rounds=12)
    return bcrypt.hashpw(password.encode("utf-8"), salt).decode("utf-8")


def _verify_password(password: str, hashed: str) -> bool:
    """Verify a password against its bcrypt hash."""
    return bcrypt.checkpw(password.encode("utf-8"), hashed.encode("utf-8"))


def _create_token(user_id: str, username: str) -> str:
    """Create a signed JWT with expiry."""
    payload = {
        "user_id": user_id,
        "username": username,
        "exp": int(time.time()) + JWT_EXPIRY_HOURS * 3600,
        "iat": int(time.time()),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


def verify_token(token: str) -> dict | None:
    """
    Validate a JWT and return the payload dict with user_id and username.
    Returns None if invalid or expired.
    """
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
        return {
            "user_id": payload["user_id"],
            "username": payload["username"],
        }
    except (jwt.ExpiredSignatureError, jwt.InvalidTokenError):
        return None


async def signup(username: str, password: str) -> dict:
    """
    Create a new user account.
    Returns {"success": True, "token": ..., "user_id": ...} or
            {"success": False, "error": "exists"|"failed"}.
    """
    # Check if user already exists
    existing = await supabase_client.select_rows(
        "engine_users",
        filters={"username": username},
        limit=1,
    )
    if existing:
        return {"success": False, "error": "exists"}

    user_id = str(uuid.uuid4())
    hashed = _hash_password(password)

    row = await supabase_client.insert_row(
        "engine_users",
        {
            "id": user_id,
            "username": username,
            "password_hash": hashed,
        },
    )
    if row is None:
        return {"success": False, "error": "failed"}

    token = _create_token(user_id, username)
    return {"success": True, "token": token, "user_id": user_id}


async def login(username: str, password: str, ip: str = "unknown") -> dict:
    """
    Authenticate an existing user.
    Returns {"success": True, "token": ..., "user_id": ...} or
            {"success": False, "error": "invalid"|"rate_limited"}.
    """
    # Check rate limit
    if check_login_rate_limit(ip):
        return {"success": False, "error": "rate_limited"}

    rows = await supabase_client.select_rows(
        "engine_users",
        filters={"username": username},
        limit=1,
    )
    if not rows:
        record_login_failure(ip)
        return {"success": False, "error": "invalid"}

    user = rows[0]
    stored_hash = user.get("password_hash", "")

    if not _verify_password(password, stored_hash):
        record_login_failure(ip)
        return {"success": False, "error": "invalid"}

    # Success: clear failures
    clear_login_failures(ip)
    user_id = user.get("id", "")
    token = _create_token(user_id, username)
    return {"success": True, "token": token, "user_id": user_id}
