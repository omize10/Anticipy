// Anticipy Chrome Extension — Popup Script

document.addEventListener("DOMContentLoaded", () => {
  const statusDot = document.getElementById("statusDot");
  const statusText = document.getElementById("statusText");
  const actionsContainer = document.getElementById("actionsContainer");
  const emptyState = document.getElementById("emptyState");
  const openEngine = document.getElementById("openEngine");
  const reconnectBtn = document.getElementById("reconnectBtn");

  // Get live status from background service worker
  chrome.runtime.sendMessage({ type: "GET_STATUS" }, (response) => {
    if (chrome.runtime.lastError) {
      updateStatus(false);
      return;
    }
    if (response) {
      updateStatus(response.connected);
      if (response.lastActions && response.lastActions.length > 0) {
        renderActions(response.lastActions);
      }
    }
  });

  // Also check persisted state as backup
  chrome.storage.local.get(["connectionStatus", "lastActions"], (data) => {
    if (data.connectionStatus) {
      updateStatus(data.connectionStatus === "connected");
    }
    if (data.lastActions && data.lastActions.length > 0) {
      renderActions(data.lastActions);
    }
  });

  openEngine.addEventListener("click", () => {
    chrome.tabs.create({ url: "https://www.anticipy.ai/engine" });
    window.close();
  });

  reconnectBtn.addEventListener("click", () => {
    reconnectBtn.textContent = "Reconnecting...";
    chrome.runtime.sendMessage({ type: "RECONNECT" }, () => {
      setTimeout(() => {
        chrome.runtime.sendMessage({ type: "GET_STATUS" }, (response) => {
          if (response) {
            updateStatus(response.connected);
            reconnectBtn.textContent = "Reconnect";
          }
        });
      }, 2000);
    });
  });

  function updateStatus(isConnected) {
    statusDot.className = "status-dot" + (isConnected ? " connected" : "");
    statusText.textContent = isConnected ? "Connected" : "Disconnected";
    reconnectBtn.className = "reconnect-btn" + (isConnected ? "" : " show");
  }

  function renderActions(actions) {
    emptyState.style.display = "none";
    actionsContainer.innerHTML = "";

    // Header with clear button
    const header = document.createElement("div");
    header.className = "actions-header";

    const label = document.createElement("div");
    label.className = "actions-label";
    label.textContent = `Recent Actions (${actions.length})`;

    const clearBtn = document.createElement("button");
    clearBtn.className = "clear-btn";
    clearBtn.textContent = "Clear";
    clearBtn.addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "CLEAR_ACTIONS" }, () => {
        actionsContainer.innerHTML = "";
        emptyState.style.display = "block";
        actionsContainer.appendChild(emptyState);
      });
    });

    header.appendChild(label);
    header.appendChild(clearBtn);
    actionsContainer.appendChild(header);

    for (const action of actions) {
      const item = document.createElement("div");
      item.className = "action-item";

      // Top row: badge + confidence
      const top = document.createElement("div");
      top.className = "action-top";

      const badge = document.createElement("span");
      badge.className = `action-badge badge-${action.importance || "standard"}`;
      badge.textContent = action.importance || "standard";

      const confidence = document.createElement("span");
      confidence.className = "action-confidence";
      confidence.textContent = action.confidence
        ? `${Math.round(action.confidence * 100)}%`
        : "";

      top.appendChild(badge);
      top.appendChild(confidence);

      // Summary
      const summary = document.createElement("div");
      summary.className = "action-summary";
      summary.textContent = action.summary;

      // Meta row: action type + time
      const meta = document.createElement("div");
      meta.className = "action-meta";

      const actionType = document.createElement("span");
      actionType.className = "action-type";
      actionType.textContent = formatActionType(action.action_type);

      const time = document.createElement("span");
      time.className = "action-time";
      time.textContent = formatTime(action.timestamp);

      meta.appendChild(actionType);
      meta.appendChild(time);

      item.appendChild(top);
      item.appendChild(summary);
      item.appendChild(meta);
      actionsContainer.appendChild(item);
    }
  }

  function formatActionType(type) {
    if (!type) return "";
    return type.replace(/_/g, " ");
  }

  function formatTime(isoString) {
    if (!isoString) return "";
    const d = new Date(isoString);
    const now = new Date();
    const diffMs = now - d;
    const diffMin = Math.floor(diffMs / 60000);

    if (diffMin < 1) return "Just now";
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    return d.toLocaleDateString();
  }
});
