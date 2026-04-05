"""
Playwright browser management.
Launches Chromium with stealth settings, manages contexts and cookies,
executes actions, and extracts accessibility trees.
"""

from __future__ import annotations

import json
from typing import Any

from playwright.async_api import async_playwright, Browser, BrowserContext, Page, Playwright

from app import supabase_client


class BrowserManager:
    """Manages a single Chromium instance with isolated contexts."""

    def __init__(self) -> None:
        self._playwright: Playwright | None = None
        self._browser: Browser | None = None
        self._context: BrowserContext | None = None
        self._page: Page | None = None

    async def launch(self) -> None:
        """Launch Chromium with stealth flags."""
        self._playwright = await async_playwright().start()
        self._browser = await self._playwright.chromium.launch(
            headless=True,
            args=[
                "--disable-blink-features=AutomationControlled",
                "--no-sandbox",
                "--disable-dev-shm-usage",
                "--disable-infobars",
                "--disable-extensions",
                "--disable-gpu",
                "--window-size=1920,1080",
            ],
        )

    async def new_context(self, user_id: str | None = None) -> Page:
        """Create a fresh browser context with optional saved cookies."""
        if not self._browser:
            await self.launch()

        self._context = await self._browser.new_context(
            viewport={"width": 1920, "height": 1080},
            user_agent=(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/120.0.0.0 Safari/537.36"
            ),
            java_script_enabled=True,
            locale="en-US",
        )

        # Stealth: override navigator.webdriver
        await self._context.add_init_script(
            "Object.defineProperty(navigator, 'webdriver', {get: () => undefined})"
        )

        self._page = await self._context.new_page()
        return self._page

    @property
    def page(self) -> Page | None:
        return self._page

    async def navigate(self, url: str) -> None:
        """Navigate to URL and wait for network idle."""
        if not self._page:
            return
        try:
            await self._page.goto(url, wait_until="networkidle", timeout=15000)
        except Exception:
            # Fallback: just wait for load
            try:
                await self._page.goto(url, wait_until="load", timeout=15000)
            except Exception:
                pass

    async def get_accessibility_tree(self) -> dict | None:
        """Get the page accessibility snapshot."""
        if not self._page:
            return None
        try:
            tree = await self._page.accessibility.snapshot()
            return tree
        except Exception:
            return None

    async def get_url(self) -> str:
        """Return current page URL."""
        if not self._page:
            return ""
        return self._page.url

    async def get_title(self) -> str:
        """Return current page title."""
        if not self._page:
            return ""
        try:
            return await self._page.title()
        except Exception:
            return ""

    async def execute_action(self, action: dict, elements: list[dict]) -> bool:
        """
        Execute a parsed action dict against the page.
        Returns True on success, False on failure.
        """
        if not self._page:
            return False

        act = action.get("action", "")
        target_label = action.get("target")
        value = action.get("value")

        try:
            if act == "click" and target_label:
                node = self._find_element(target_label, elements)
                if node:
                    name = node.get("name", "")
                    role = node.get("role", "")
                    locator = self._build_locator(name, role)
                    if locator:
                        await locator.click(timeout=5000)
                        await self._wait_stable()
                        return True
                return False

            elif act == "type" and target_label and value is not None:
                node = self._find_element(target_label, elements)
                if node:
                    name = node.get("name", "")
                    role = node.get("role", "")
                    locator = self._build_locator(name, role)
                    if locator:
                        await locator.click(timeout=5000)
                        await locator.fill(str(value), timeout=5000)
                        await self._wait_stable()
                        return True
                return False

            elif act == "select" and target_label and value is not None:
                node = self._find_element(target_label, elements)
                if node:
                    name = node.get("name", "")
                    role = node.get("role", "")
                    locator = self._build_locator(name, role)
                    if locator:
                        await locator.select_option(label=str(value), timeout=5000)
                        await self._wait_stable()
                        return True
                return False

            elif act == "scroll":
                direction = str(value or "down").lower()
                delta = -500 if direction == "up" else 500
                await self._page.mouse.wheel(0, delta)
                await self._wait_stable()
                return True

            elif act == "navigate" and value:
                url = str(value)
                if not url.startswith("http"):
                    url = "https://" + url
                await self.navigate(url)
                return True

            elif act == "go_back":
                await self._page.go_back(wait_until="networkidle", timeout=10000)
                await self._wait_stable()
                return True

            elif act in ("done", "stuck", "need_info"):
                return True

        except Exception:
            return False

        return False

    def _find_element(self, label: str, elements: list[dict]) -> dict | None:
        """Find the element dict by its label letter."""
        for elem in elements:
            if elem.get("label") == label:
                return elem
        return None

    def _build_locator(self, name: str, role: str):
        """Build a Playwright locator from element name and role."""
        if not self._page or not name:
            return None

        role_map = {
            "button": "button",
            "link": "link",
            "textbox": "textbox",
            "searchbox": "searchbox",
            "combobox": "combobox",
            "checkbox": "checkbox",
            "radio": "radio",
            "switch": "switch",
            "tab": "tab",
            "menuitem": "menuitem",
            "option": "option",
            "slider": "slider",
            "spinbutton": "spinbutton",
        }

        aria_role = role_map.get(role)
        if aria_role:
            return self._page.get_by_role(aria_role, name=name, exact=False)

        # Fallback: use text-based locator
        return self._page.get_by_text(name, exact=False)

    async def _wait_stable(self) -> None:
        """Brief wait for page to settle after an action."""
        try:
            await self._page.wait_for_load_state("domcontentloaded", timeout=3000)
        except Exception:
            pass

    async def take_screenshot(self) -> bytes | None:
        """Take a screenshot of the current page. Returns PNG bytes."""
        if not self._page:
            return None
        try:
            return await self._page.screenshot(type="png")
        except Exception:
            return None

    async def get_page_text(self) -> str:
        """Get visible text content of the page (limited)."""
        if not self._page:
            return ""
        try:
            text = await self._page.inner_text("body", timeout=3000)
            return text[:2000]
        except Exception:
            return ""

    async def save_cookies(self, user_id: str, domain: str) -> None:
        """Save context cookies to Supabase browser_profiles table."""
        if not self._context:
            return
        try:
            cookies = await self._context.cookies()
            cookies_json = json.dumps(cookies)
            await supabase_client.upsert_row(
                "browser_profiles",
                {
                    "user_id": user_id,
                    "site_domain": domain,
                    "cookies_json": cookies_json,
                    "updated_at": "now()",
                },
            )
        except Exception:
            pass

    async def load_cookies(self, user_id: str, domain: str) -> None:
        """Load saved cookies from Supabase into the current context."""
        if not self._context:
            return
        try:
            rows = await supabase_client.select_rows(
                "browser_profiles",
                filters={"user_id": user_id, "site_domain": domain},
                limit=1,
            )
            if rows:
                cookies_json = rows[0].get("cookies_json", "[]")
                cookies = json.loads(cookies_json)
                if cookies:
                    await self._context.add_cookies(cookies)
        except Exception:
            pass

    async def close(self) -> None:
        """Close browser and all contexts."""
        try:
            if self._context:
                await self._context.close()
        except Exception:
            pass
        try:
            if self._browser:
                await self._browser.close()
        except Exception:
            pass
        try:
            if self._playwright:
                await self._playwright.stop()
        except Exception:
            pass
        self._page = None
        self._context = None
        self._browser = None
        self._playwright = None
