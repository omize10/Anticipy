"""
CAPTCHA detection and solving.
Primary: 2captcha / capsolver API.
Fallback: Ask user to solve manually.
"""

from __future__ import annotations

import asyncio
import re

import httpx

from app.config import TWOCAPTCHA_API_KEY, CAPSOLVER_API_KEY


def detect_captcha_in_tree(tree: dict | None) -> dict | None:
    """
    Check the accessibility tree for CAPTCHA iframes (reCAPTCHA, hCAPTCHA).
    Returns a dict with 'type' and 'sitekey' if found, else None.
    """
    if not tree:
        return None

    captcha_info: dict | None = None

    def walk(node: dict) -> None:
        nonlocal captcha_info
        if captcha_info:
            return
        name = (node.get("name") or "").lower()
        role = (node.get("role") or "").lower()
        description = (node.get("description") or "").lower()

        combined = f"{name} {role} {description}"

        if any(kw in combined for kw in ["recaptcha", "re-captcha", "g-recaptcha"]):
            captcha_info = {"type": "recaptcha", "sitekey": None}
            return
        if any(kw in combined for kw in ["hcaptcha", "h-captcha"]):
            captcha_info = {"type": "hcaptcha", "sitekey": None}
            return
        if "captcha" in combined and "iframe" in role:
            captcha_info = {"type": "unknown", "sitekey": None}
            return

        for child in node.get("children", []):
            walk(child)

    walk(tree)
    return captcha_info


async def detect_captcha_in_page(page) -> dict | None:
    """
    Check the actual page HTML for CAPTCHA elements and extract sitekey.
    Falls back to accessibility tree detection if JS evaluation fails.
    """
    try:
        result = await page.evaluate("""
        () => {
            // Check for reCAPTCHA
            const recaptcha = document.querySelector('[data-sitekey]');
            if (recaptcha) {
                return {
                    type: recaptcha.classList.contains('h-captcha') ? 'hcaptcha' : 'recaptcha',
                    sitekey: recaptcha.getAttribute('data-sitekey')
                };
            }
            // Check for hCAPTCHA
            const hcaptcha = document.querySelector('.h-captcha[data-sitekey]');
            if (hcaptcha) {
                return { type: 'hcaptcha', sitekey: hcaptcha.getAttribute('data-sitekey') };
            }
            // Check for reCAPTCHA iframe
            const iframe = document.querySelector('iframe[src*="recaptcha"]');
            if (iframe) {
                const src = iframe.getAttribute('src') || '';
                const match = src.match(/[?&]k=([^&]+)/);
                return { type: 'recaptcha', sitekey: match ? match[1] : null };
            }
            // Check for hCAPTCHA iframe
            const hiframe = document.querySelector('iframe[src*="hcaptcha"]');
            if (hiframe) {
                return { type: 'hcaptcha', sitekey: null };
            }
            return null;
        }
        """)
        if result:
            return result
    except Exception:
        pass
    return None


async def solve_with_2captcha(
    captcha_type: str,
    sitekey: str,
    page_url: str,
) -> str | None:
    """
    Use 2captcha API to solve a CAPTCHA.
    Returns the solution token or None on failure.
    """
    if not TWOCAPTCHA_API_KEY or not sitekey:
        return None

    try:
        async with httpx.AsyncClient(timeout=120) as client:
            # Submit task
            if captcha_type == "recaptcha":
                submit_url = (
                    f"https://2captcha.com/in.php?key={TWOCAPTCHA_API_KEY}"
                    f"&method=userrecaptcha&googlekey={sitekey}"
                    f"&pageurl={page_url}&json=1"
                )
            elif captcha_type == "hcaptcha":
                submit_url = (
                    f"https://2captcha.com/in.php?key={TWOCAPTCHA_API_KEY}"
                    f"&method=hcaptcha&sitekey={sitekey}"
                    f"&pageurl={page_url}&json=1"
                )
            else:
                return None

            resp = await client.get(submit_url)
            data = resp.json()
            if data.get("status") != 1:
                return None

            task_id = data["request"]

            # Poll for result (max 120 seconds)
            for _ in range(24):
                await asyncio.sleep(5)
                result_url = (
                    f"https://2captcha.com/res.php?key={TWOCAPTCHA_API_KEY}"
                    f"&action=get&id={task_id}&json=1"
                )
                resp = await client.get(result_url)
                rdata = resp.json()
                if rdata.get("status") == 1:
                    return rdata["request"]
                if rdata.get("request") == "ERROR_CAPTCHA_UNSOLVABLE":
                    return None
    except Exception:
        pass
    return None


async def solve_with_capsolver(
    captcha_type: str,
    sitekey: str,
    page_url: str,
) -> str | None:
    """
    Use capsolver API to solve a CAPTCHA.
    Returns the solution token or None on failure.
    """
    if not CAPSOLVER_API_KEY or not sitekey:
        return None

    try:
        async with httpx.AsyncClient(timeout=120) as client:
            if captcha_type == "recaptcha":
                task_type = "ReCaptchaV2TaskProxyLess"
                task_body = {
                    "type": task_type,
                    "websiteURL": page_url,
                    "websiteKey": sitekey,
                }
            elif captcha_type == "hcaptcha":
                task_type = "HCaptchaTaskProxyLess"
                task_body = {
                    "type": task_type,
                    "websiteURL": page_url,
                    "websiteKey": sitekey,
                }
            else:
                return None

            # Create task
            resp = await client.post(
                "https://api.capsolver.com/createTask",
                json={
                    "clientKey": CAPSOLVER_API_KEY,
                    "task": task_body,
                },
            )
            data = resp.json()
            if data.get("errorId", 1) != 0:
                return None

            task_id = data.get("taskId")
            if not task_id:
                return None

            # Poll for result
            for _ in range(24):
                await asyncio.sleep(5)
                resp = await client.post(
                    "https://api.capsolver.com/getTaskResult",
                    json={
                        "clientKey": CAPSOLVER_API_KEY,
                        "taskId": task_id,
                    },
                )
                rdata = resp.json()
                status = rdata.get("status", "")
                if status == "ready":
                    solution = rdata.get("solution", {})
                    return solution.get("gRecaptchaResponse") or solution.get("token")
                if status == "failed":
                    return None
    except Exception:
        pass
    return None


async def inject_captcha_solution(page, captcha_type: str, token: str) -> bool:
    """Inject a solved CAPTCHA token into the page."""
    try:
        if captcha_type == "recaptcha":
            await page.evaluate(
                f"""
                (token) => {{
                    document.getElementById('g-recaptcha-response').innerHTML = token;
                    if (typeof ___grecaptcha_cfg !== 'undefined') {{
                        Object.entries(___grecaptcha_cfg.clients).forEach(([cid, client]) => {{
                            Object.entries(client).forEach(([_, value]) => {{
                                if (value && value.callback) value.callback(token);
                            }});
                        }});
                    }}
                }}
                """,
                token,
            )
            return True
        elif captcha_type == "hcaptcha":
            await page.evaluate(
                f"""
                (token) => {{
                    const textarea = document.querySelector('[name="h-captcha-response"]');
                    if (textarea) textarea.value = token;
                    const iframe = document.querySelector('iframe[src*="hcaptcha"]');
                    if (iframe) {{
                        const event = new MessageEvent('message', {{
                            data: JSON.stringify({{msgType: 'token', token: token}})
                        }});
                        window.dispatchEvent(event);
                    }}
                }}
                """,
                token,
            )
            return True
    except Exception:
        pass
    return False


async def attempt_solve(page, page_url: str) -> str | None:
    """
    Full CAPTCHA solving pipeline:
    1. Detect CAPTCHA type and sitekey
    2. Try capsolver
    3. Try 2captcha
    4. Return None if both fail (caller should ask user)
    """
    captcha_info = await detect_captcha_in_page(page)
    if not captcha_info:
        return None

    captcha_type = captcha_info.get("type", "")
    sitekey = captcha_info.get("sitekey")

    if not sitekey:
        return None

    # Try capsolver first
    token = await solve_with_capsolver(captcha_type, sitekey, page_url)
    if token:
        injected = await inject_captcha_solution(page, captcha_type, token)
        if injected:
            return "solved"

    # Try 2captcha
    token = await solve_with_2captcha(captcha_type, sitekey, page_url)
    if token:
        injected = await inject_captcha_solution(page, captcha_type, token)
        if injected:
            return "solved"

    return None
