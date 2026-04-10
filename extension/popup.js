// Anticipy Chrome Extension — Popup Script

document.addEventListener("DOMContentLoaded", () => {
  const statusDot = document.getElementById("statusDot");
  const statusText = document.getElementById("statusText");
  const actionsContainer = document.getElementById("actionsContainer");
  const emptyState = document.getElementById("emptyState");
  const openEngine = document.getElementById("openEngine");

  // Get status from background
  chrome.runtime.sendMessage({ type: "GET_STATUS" }, (response) => {
    if (response) {
      updateStatus(response.connected);
      if (response.lastActions && response.lastActions.length > 0) {
        renderActions(response.lastActions);
      }
    }
  });

  // Also check storage for persisted state
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

  function updateStatus(isConnected) {
    statusDot.className = "status-dot" + (isConnected ? " connected" : "");
    statusText.textContent = isConnected ? "Connected" : "Disconnected";
  }

  function renderActions(actions) {
    emptyState.style.display = "none";

    const label = document.createElement("div");
    label.className = "actions-label";
    label.textContent = "Recent Actions";

    // Clear existing content
    actionsContainer.innerHTML = "";
    actionsContainer.appendChild(label);

    for (const action of actions) {
      const item = document.createElement("div");
      item.className = "action-item";

      const badge = document.createElement("span");
      badge.className = `action-badge badge-${action.importance || "standard"}`;
      badge.textContent = action.importance || "standard";

      const summary = document.createElement("div");
      summary.className = "action-summary";
      summary.textContent = action.summary;

      const time = document.createElement("div");
      time.className = "action-time";
      time.textContent = formatTime(action.timestamp);

      item.appendChild(badge);
      item.appendChild(summary);
      item.appendChild(time);
      actionsContainer.appendChild(item);
    }
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
