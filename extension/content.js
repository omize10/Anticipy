// Anticipy Chrome Extension — Content Script
// Receives DOM action commands from the service worker and executes them in the page

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== "DOM_ACTION") return;

  const action = message.action;
  let result = { success: false, error: "Unknown action" };

  try {
    switch (action.type) {
      case "click": {
        const el = findElement(action.selector, action.text);
        if (el) {
          el.scrollIntoView({ behavior: "smooth", block: "center" });
          setTimeout(() => {
            el.click();
            result = { success: true, message: `Clicked: ${action.selector || action.text}` };
            sendResponse(result);
          }, 200);
          return true; // async response
        }
        result = { success: false, error: `Element not found: ${action.selector || action.text}` };
        break;
      }

      case "fill": {
        const input = findElement(action.selector, action.label);
        if (input) {
          input.focus();
          // Clear existing value
          input.value = "";
          // Set new value character by character for React compatibility
          const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype, "value"
          )?.set || Object.getOwnPropertyDescriptor(
            window.HTMLTextAreaElement.prototype, "value"
          )?.set;

          if (nativeInputValueSetter) {
            nativeInputValueSetter.call(input, action.value);
          } else {
            input.value = action.value;
          }
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
          result = { success: true, message: `Filled: ${action.selector || action.label}` };
        } else {
          result = { success: false, error: `Input not found: ${action.selector || action.label}` };
        }
        break;
      }

      case "navigate": {
        if (action.url) {
          window.location.href = action.url;
          result = { success: true, message: `Navigating to: ${action.url}` };
        } else {
          result = { success: false, error: "No URL provided" };
        }
        break;
      }

      case "read_text": {
        const target = action.selector
          ? document.querySelector(action.selector)
          : document.body;
        result = {
          success: true,
          text: target ? target.innerText.substring(0, 5000) : "",
        };
        break;
      }

      case "add_todo": {
        const todoInput =
          document.querySelector('input[placeholder*="todo" i]') ||
          document.querySelector('input[placeholder*="task" i]') ||
          document.querySelector('input[placeholder*="add" i]') ||
          document.querySelector('input[type="text"]:not([type="hidden"])');

        if (todoInput) {
          todoInput.focus();
          todoInput.value = action.text;
          todoInput.dispatchEvent(new Event("input", { bubbles: true }));

          // Try to submit
          const form = todoInput.closest("form");
          if (form) {
            form.dispatchEvent(new Event("submit", { bubbles: true }));
          } else {
            todoInput.dispatchEvent(
              new KeyboardEvent("keydown", { key: "Enter", keyCode: 13, bubbles: true })
            );
            todoInput.dispatchEvent(
              new KeyboardEvent("keypress", { key: "Enter", keyCode: 13, bubbles: true })
            );
            todoInput.dispatchEvent(
              new KeyboardEvent("keyup", { key: "Enter", keyCode: 13, bubbles: true })
            );
          }
          result = { success: true, message: `Added TODO: ${action.text}` };
        } else {
          result = { success: false, error: "No TODO input found on page" };
        }
        break;
      }

      case "scroll": {
        const direction = action.direction || "down";
        const amount = action.amount || 500;
        window.scrollBy({
          top: direction === "down" ? amount : -amount,
          behavior: "smooth"
        });
        result = { success: true, message: `Scrolled ${direction} ${amount}px` };
        break;
      }

      case "get_page_info": {
        result = {
          success: true,
          data: {
            url: window.location.href,
            title: document.title,
            domain: window.location.hostname,
          }
        };
        break;
      }

      default:
        result = { success: false, error: `Unknown action type: ${action.type}` };
    }
  } catch (err) {
    result = { success: false, error: err.message };
  }

  sendResponse(result);
  return true;
});

/**
 * Find an element by CSS selector or visible text content
 */
function findElement(selector, text) {
  // Try CSS selector first
  if (selector) {
    const el = document.querySelector(selector);
    if (el) return el;
  }

  // Search by visible text
  if (text) {
    const textLower = text.toLowerCase();
    const candidates = document.querySelectorAll(
      "a, button, input, label, [role='button'], [role='link'], [role='menuitem']"
    );
    for (const el of candidates) {
      // Check text content
      if (el.textContent && el.textContent.trim().toLowerCase().includes(textLower)) {
        return el;
      }
      // Check aria-label
      if (el.getAttribute("aria-label")?.toLowerCase().includes(textLower)) {
        return el;
      }
      // Check placeholder
      if (el.getAttribute("placeholder")?.toLowerCase().includes(textLower)) {
        return el;
      }
      // Check title
      if (el.getAttribute("title")?.toLowerCase().includes(textLower)) {
        return el;
      }
    }
  }

  return null;
}

// Let the background know the content script is ready
try {
  chrome.runtime.sendMessage({ type: "CONTENT_SCRIPT_READY", url: window.location.href });
} catch (e) {
  // Extension context might be invalidated, ignore
}
