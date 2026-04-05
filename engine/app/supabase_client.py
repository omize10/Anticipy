"""
Lightweight Supabase REST client using httpx.
Handles engine_users, browser_profiles, and engine_tasks tables.
"""

from __future__ import annotations

import httpx

from app.config import SUPABASE_URL, SUPABASE_ANON_KEY


def _headers(extra: dict | None = None) -> dict:
    h = {
        "apikey": SUPABASE_ANON_KEY,
        "Authorization": f"Bearer {SUPABASE_ANON_KEY}",
        "Content-Type": "application/json",
        "Prefer": "return=representation",
    }
    if extra:
        h.update(extra)
    return h


def _rest_url(table: str) -> str:
    return f"{SUPABASE_URL}/rest/v1/{table}"


async def insert_row(table: str, data: dict) -> dict | None:
    """Insert a single row and return the created record."""
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.post(
            _rest_url(table),
            headers=_headers(),
            json=data,
        )
        if resp.status_code in (200, 201):
            rows = resp.json()
            return rows[0] if rows else data
        return None


async def select_rows(
    table: str,
    filters: dict | None = None,
    columns: str = "*",
    limit: int = 100,
) -> list[dict]:
    """Select rows with optional eq-filters."""
    params: dict = {"select": columns, "limit": str(limit)}
    if filters:
        for key, value in filters.items():
            params[key] = f"eq.{value}"
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(
            _rest_url(table),
            headers=_headers(),
            params=params,
        )
        if resp.status_code == 200:
            return resp.json()
        return []


async def update_rows(table: str, filters: dict, data: dict) -> list[dict]:
    """Update rows matching eq-filters."""
    params: dict = {}
    if filters:
        for key, value in filters.items():
            params[key] = f"eq.{value}"
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.patch(
            _rest_url(table),
            headers=_headers(),
            params=params,
            json=data,
        )
        if resp.status_code == 200:
            return resp.json()
        return []


async def upsert_row(table: str, data: dict) -> dict | None:
    """Upsert a single row (insert or update on conflict)."""
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.post(
            _rest_url(table),
            headers=_headers({"Prefer": "return=representation,resolution=merge-duplicates"}),
            json=data,
        )
        if resp.status_code in (200, 201):
            rows = resp.json()
            return rows[0] if rows else data
        return None
