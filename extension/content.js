// Anticipy Chrome Extension — Content Script
// Executes DOM actions inside the active tab on behalf of the BrowserAgent.
// All actions arrive as { type: "DOM_ACTION", action: { type, ...params } }.

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== "DOM_ACTION") return;

  const action = message.action;
  executeAction(action).then(sendResponse).catch((err) => {
    sendResponse({ success: false, error: err.message || String(err) });
  });

  return true; // keep channel open for async response
});

async function executeAction(action) {
  switch (action.type) {

    // ── Navigation ────────────────────────────────────────────────────────────
    case "navigate": {
      if (!action.url) return { success: false, error: "No URL provided" };
      window.location.href = action.url;
      return { success: true, message: `Navigating to ${action.url}` };
    }

    // ── Click ─────────────────────────────────────────────────────────────────
    case "click": {
      const el = findElement(action.selector, action.text, action.aria);
      if (!el) {
        return { success: false, error: `Element not found: selector="${action.selector}" text="${action.text}" aria="${action.aria}"` };
      }
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      await sleep(150);
      el.click();
      return { success: true, message: `Clicked: ${action.selector || action.text || action.aria}` };
    }

    // ── Type / Fill ───────────────────────────────────────────────────────────
    case "type":
    case "fill": {
      const input = findElement(action.selector, action.label);
      if (!input) {
        return { success: false, error: `Input not found: selector="${action.selector}" label="${action.label}"` };
      }
      fillInput(input, action.value ?? "");
      return { success: true, message: `Typed into: ${action.selector || action.label}` };
    }

    // ── Keypress ──────────────────────────────────────────────────────────────
    case "keypress": {
      const target = action.selector ? document.querySelector(action.selector) : document.activeElement;
      const el = target || document.body;
      el.dispatchEvent(new KeyboardEvent("keydown",  { key: action.key, bubbles: true, cancelable: true }));
      el.dispatchEvent(new KeyboardEvent("keypress", { key: action.key, bubbles: true, cancelable: true }));
      el.dispatchEvent(new KeyboardEvent("keyup",    { key: action.key, bubbles: true, cancelable: true }));
      return { success: true, message: `Key "${action.key}" pressed` };
    }

    // ── Scroll ────────────────────────────────────────────────────────────────
    case "scroll": {
      const amount = action.amount || 500;
      window.scrollBy({ top: action.direction === "up" ? -amount : amount, behavior: "smooth" });
      return { success: true, message: `Scrolled ${action.direction || "down"} ${amount}px` };
    }

    // ── Read text ─────────────────────────────────────────────────────────────
    case "read_text": {
      const el = action.selector ? document.querySelector(action.selector) : document.body;
      return {
        success: true,
        text: (el?.innerText || el?.textContent || "").trim().substring(0, 5000)
      };
    }

    // ── Wait for element ──────────────────────────────────────────────────────
    case "waitForElement": {
      const timeout = action.timeout || 8000;
      const found = await waitForSelector(action.selector, timeout);
      return found
        ? { success: true, message: `Element appeared: ${action.selector}` }
        : { success: false, error: `Timeout: "${action.selector}" did not appear in ${timeout}ms` };
    }

    // ── Full page state (for the agent's context window) ──────────────────────
    case "getPageState": {
      const visibleText = getVisibleText();
      const elements = getInteractiveElements();
      return {
        success: true,
        data: {
          url: window.location.href,
          title: document.title,
          visibleText,
          elements
        }
      };
    }

    // ── Legacy: get_page_info (kept for backwards compat) ─────────────────────
    case "get_page_info": {
      return {
        success: true,
        data: { url: window.location.href, title: document.title, domain: window.location.hostname }
      };
    }

    // ── Legacy: add_todo ──────────────────────────────────────────────────────
    case "add_todo": {
      const todoInput =
        document.querySelector('input[placeholder*="todo" i]') ||
        document.querySelector('input[placeholder*="task" i]') ||
        document.querySelector('input[placeholder*="add" i]') ||
        document.querySelector('input[type="text"]:not([type="hidden"])');

      if (!todoInput) return { success: false, error: "No TODO input found on page" };

      fillInput(todoInput, action.text || "");
      const form = todoInput.closest("form");
      if (form) {
        form.dispatchEvent(new Event("submit", { bubbles: true }));
      } else {
        todoInput.dispatchEvent(new KeyboardEvent("keydown",  { key: "Enter", keyCode: 13, bubbles: true }));
        todoInput.dispatchEvent(new KeyboardEvent("keypress", { key: "Enter", keyCode: 13, bubbles: true }));
        todoInput.dispatchEvent(new KeyboardEvent("keyup",    { key: "Enter", keyCode: 13, bubbles: true }));
      }
      return { success: true, message: `Added: ${action.text}` };
    }

    default:
      return { success: false, error: `Unknown action type: ${action.type}` };
  }
}

// ─── Element finding ──────────────────────────────────────────────────────────

/**
 * Find an element using multiple strategies in priority order:
 * 1. CSS selector
 * 2. Visible text content (for buttons/links/labels)
 * 3. aria-label
 * 4. placeholder
 */
function findElement(selector, text, aria) {
  // 1. CSS selector
  if (selector) {
    const el = document.querySelector(selector);
    if (el && isVisible(el)) return el;
    // Try even if not visible (some overlapping UI patterns)
    if (el) return el;
  }

  const interactable = "a, button, input, textarea, select, label, [role='button'], [role='link'], [role='menuitem'], [role='option'], [role='tab'], [tabindex]";

  // 2. Visible text match
  if (text) {
    const needle = text.toLowerCase().trim();
    for (const el of document.querySelectorAll(interactable)) {
      const elText = (el.textContent || el.value || "").trim().toLowerCase();
      if (elText.includes(needle)) return el;
    }
  }

  // 3. aria-label match
  if (aria) {
    const needle = aria.toLowerCase().trim();
    for (const el of document.querySelectorAll(interactable)) {
      const label = (el.getAttribute("aria-label") || "").toLowerCase();
      if (label.includes(needle)) return el;
    }
  }

  // 4. placeholder match (useful when only label/text is known)
  if (text) {
    const needle = text.toLowerCase().trim();
    for (const el of document.querySelectorAll("input, textarea")) {
      const ph = (el.getAttribute("placeholder") || "").toLowerCase();
      const titleAttr = (el.getAttribute("title") || "").toLowerCase();
      if (ph.includes(needle) || titleAttr.includes(needle)) return el;
    }
  }

  return null;
}

// ─── Input filling (React / Vue / plain HTML compatible) ──────────────────────

function fillInput(input, value) {
  input.focus();

  // Use the native setter so React's synthetic event system picks up the change
  const nativeSetter =
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set ||
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;

  if (nativeSetter) {
    nativeSetter.call(input, value);
  } else {
    input.value = value;
  }

  input.dispatchEvent(new Event("input",  { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

// ─── Wait for selector ────────────────────────────────────────────────────────

function waitForSelector(selector, timeout) {
  return new Promise((resolve) => {
    if (document.querySelector(selector)) { resolve(true); return; }

    const observer = new MutationObserver(() => {
      if (document.querySelector(selector)) {
        observer.disconnect();
        resolve(true);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => { observer.disconnect(); resolve(false); }, timeout);
  });
}

// ─── Page state extraction ────────────────────────────────────────────────────

function getVisibleText() {
  // Walk the DOM and collect visible text, skipping script/style/hidden nodes
  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        const tag = parent.tagName;
        if (["SCRIPT", "STYLE", "NOSCRIPT", "META", "HEAD"].includes(tag)) return NodeFilter.FILTER_REJECT;
        const style = window.getComputedStyle(parent);
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return NodeFilter.FILTER_REJECT;
        const text = node.textContent?.trim();
        if (!text) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    }
  );

  const parts = [];
  let node;
  while ((node = walker.nextNode())) {
    const t = node.textContent.trim();
    if (t) parts.push(t);
    if (parts.join(" ").length > 4000) break;
  }
  return parts.join(" ").replace(/\s{3,}/g, "  ");
}

function getInteractiveElements() {
  const elements = [];
  const seen = new Set();

  const candidates = document.querySelectorAll(
    'button, input:not([type="hidden"]), textarea, select, a[href], ' +
    '[role="button"], [role="link"], [role="textbox"], [role="combobox"], [role="checkbox"], [role="radio"], ' +
    '[contenteditable="true"]'
  );

  for (const el of candidates) {
    if (!isVisible(el)) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;

    const sel = getBestSelector(el);
    if (seen.has(sel)) continue;
    seen.add(sel);

    elements.push({
      tag: el.tagName.toLowerCase(),
      type: el.type || el.getAttribute("role") || "",
      id: el.id || "",
      name: el.getAttribute("name") || "",
      text: (el.textContent || el.value || "").trim().substring(0, 80),
      placeholder: el.getAttribute("placeholder") || "",
      aria: el.getAttribute("aria-label") || "",
      href: el.tagName === "A" ? (el.getAttribute("href") || "") : "",
      selector: sel
    });

    if (elements.length >= 40) break;
  }

  return elements;
}

function isVisible(el) {
  if (!el.offsetParent && el.tagName !== "BODY") return false;
  const style = window.getComputedStyle(el);
  return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
}

function getBestSelector(el) {
  // id
  if (el.id) return `#${CSS.escape(el.id)}`;
  // name attribute
  const name = el.getAttribute("name");
  if (name) return `${el.tagName.toLowerCase()}[name="${name}"]`;
  // data-testid
  const testId = el.getAttribute("data-testid");
  if (testId) return `[data-testid="${testId}"]`;
  // aria-label
  const aria = el.getAttribute("aria-label");
  if (aria) return `[aria-label="${aria}"]`;
  // class-based (first class only, sanitized)
  const cls = el.className?.toString().split(/\s+/).find(c => c && !/^\d/.test(c));
  if (cls) return `${el.tagName.toLowerCase()}.${CSS.escape(cls)}`;
  // fallback: tag
  return el.tagName.toLowerCase();
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Announce readiness to background
try {
  chrome.runtime.sendMessage({ type: "CONTENT_SCRIPT_READY", url: window.location.href });
} catch {
  // Extension context may be invalidated — ignore
}
