// Anticipy Chrome Extension — Content Script
// Receives DOM action commands from the service worker and executes them

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== "DOM_ACTION") return;

  const action = message.action;
  let result = { success: false, error: "Unknown action" };

  try {
    switch (action.type) {
      case "click": {
        const el = findElement(action.selector, action.text);
        if (el) {
          el.click();
          result = { success: true, message: `Clicked: ${action.selector || action.text}` };
        } else {
          result = { success: false, error: `Element not found: ${action.selector || action.text}` };
        }
        break;
      }

      case "fill": {
        const input = findElement(action.selector, action.label);
        if (input) {
          input.focus();
          input.value = action.value;
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
          result = { success: true, message: `Filled: ${action.selector || action.label}` };
        } else {
          result = { success: false, error: `Input not found: ${action.selector || action.label}` };
        }
        break;
      }

      case "navigate": {
        window.location.href = action.url;
        result = { success: true, message: `Navigating to: ${action.url}` };
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
        // Generic TODO list item addition
        const todoInput =
          document.querySelector('input[placeholder*="todo" i]') ||
          document.querySelector('input[placeholder*="task" i]') ||
          document.querySelector('input[placeholder*="add" i]') ||
          document.querySelector('input[type="text"]');

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
              new KeyboardEvent("keydown", { key: "Enter", bubbles: true })
            );
          }
          result = { success: true, message: `Added TODO: ${action.text}` };
        } else {
          result = { success: false, error: "No TODO input found on page" };
        }
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
  if (selector) {
    const el = document.querySelector(selector);
    if (el) return el;
  }

  if (text) {
    // Search by visible text
    const allElements = document.querySelectorAll("a, button, input, label, [role='button']");
    for (const el of allElements) {
      if (el.textContent && el.textContent.trim().toLowerCase().includes(text.toLowerCase())) {
        return el;
      }
      if (el.getAttribute("aria-label")?.toLowerCase().includes(text.toLowerCase())) {
        return el;
      }
    }
  }

  return null;
}

// Announce presence to background
chrome.runtime.sendMessage({ type: "CONTENT_SCRIPT_READY", url: window.location.href });
