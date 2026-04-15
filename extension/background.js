// Anticipy Chrome Extension — Service Worker (Manifest V3)
// Connects to Supabase Realtime to receive intent notifications in real-time

const SUPABASE_URL = "https://ogbxpqkmsdrcuilafycn.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9nYnhwcWttc2RyY3VpbGFmeWNuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ4NDI3NDksImV4cCI6MjA5MDQxODc0OX0.PNfKYanSXJTfrYXWGZoUBFaZVE_jnsV4cqBXgxrRJ-0";

let realtimeWs = null;
let connected = false;
let lastActions = [];
let heartbeatRef = 0;
let joinRef = 0;

// Keep service worker alive with alarm (MV3 kills SW after ~30s of inactivity)
chrome.alarms.create("keepalive", { periodInMinutes: 0.4 }); // every 24 seconds

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "keepalive") {
    if (realtimeWs && realtimeWs.readyState === WebSocket.OPEN) {
      // Send Phoenix heartbeat to keep connection alive
      heartbeatRef++;
      realtimeWs.send(JSON.stringify({
        topic: "phoenix",
        event: "heartbeat",
        payload: {},
        ref: String(heartbeatRef)
      }));
    } else {
      connectRealtime();
    }
  }
});

function connectRealtime() {
  // Don't reconnect if already open or connecting
  if (realtimeWs && (realtimeWs.readyState === WebSocket.OPEN || realtimeWs.readyState === WebSocket.CONNECTING)) {
    return;
  }

  const wsUrl = SUPABASE_URL.replace("https://", "wss://") +
    "/realtime/v1/websocket?apikey=" + SUPABASE_ANON_KEY + "&vsn=1.0.0";

  try {
    realtimeWs = new WebSocket(wsUrl);

    realtimeWs.onopen = () => {
      connected = true;
      updateBadge("connected");
      console.log("Anticipy: Realtime connected");

      // Join the channel for postgres changes on anticipy_intents
      // Subscribes to both INSERT (new intents) and UPDATE (confirmed intents for execution)
      joinRef++;
      const joinMsg = {
        topic: "realtime:public:anticipy_intents",
        event: "phx_join",
        payload: {
          config: {
            broadcast: { self: false },
            postgres_changes: [
              {
                event: "INSERT",
                schema: "public",
                table: "anticipy_intents"
              },
              {
                event: "UPDATE",
                schema: "public",
                table: "anticipy_intents"
              }
            ]
          }
        },
        ref: String(joinRef)
      };
      realtimeWs.send(JSON.stringify(joinMsg));
    };

    realtimeWs.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);

        // Handle join reply
        if (msg.event === "phx_reply" && msg.payload?.status === "ok") {
          console.log("Anticipy: Channel joined successfully");
          return;
        }

        // Handle postgres_changes event (INSERT or UPDATE on anticipy_intents)
        if (msg.event === "postgres_changes") {
          const change = msg.payload;
          if (change && change.data) {
            const eventType = change.data.type; // "INSERT" | "UPDATE" | "DELETE"
            const record = change.data.record;
            if (eventType === "INSERT" && record && record.summary_for_user) {
              handleNewIntent(record);
            } else if (eventType === "UPDATE" && record && record.status === "confirmed") {
              handleConfirmedIntent(record);
            }
          }
          return;
        }

        // Also handle the raw INSERT event format
        if (msg.event === "INSERT") {
          const record = msg.payload?.record || msg.payload;
          if (record && record.summary_for_user) {
            handleNewIntent(record);
          }
          return;
        }

        // Handle system events
        if (msg.event === "system" && msg.payload?.status === "ok") {
          console.log("Anticipy: System ready");
          return;
        }
      } catch (e) {
        // Ignore parse errors (heartbeat responses, etc.)
      }
    };

    realtimeWs.onclose = (event) => {
      connected = false;
      realtimeWs = null;
      updateBadge("disconnected");
      console.log("Anticipy: Realtime disconnected, reconnecting in 5s...");
      setTimeout(connectRealtime, 5000);
    };

    realtimeWs.onerror = (err) => {
      console.error("Anticipy: WebSocket error:", err);
      connected = false;
      updateBadge("disconnected");
      // Don't reconnect here - onclose will fire after onerror
    };
  } catch (e) {
    console.error("Anticipy: Connection setup failed:", e);
    connected = false;
    updateBadge("disconnected");
    setTimeout(connectRealtime, 10000);
  }
}

function handleNewIntent(intent) {
  // Store for popup display
  lastActions.unshift({
    id: intent.id,
    summary: intent.summary_for_user,
    importance: intent.importance,
    action_type: intent.action_type,
    status: intent.status,
    confidence: intent.confidence,
    evidence_quote: intent.evidence_quote,
    timestamp: new Date().toISOString()
  });
  lastActions = lastActions.slice(0, 10); // Keep last 10

  chrome.storage.local.set({ lastActions });

  // Show Chrome notification
  const importanceConfig = {
    critical: { emoji: "🔴", priority: 2, requireInteraction: true },
    important: { emoji: "🟠", priority: 1, requireInteraction: false },
    standard: { emoji: "🟡", priority: 0, requireInteraction: false },
    low: { emoji: "⚪", priority: 0, requireInteraction: false }
  };

  const config = importanceConfig[intent.importance] || importanceConfig.standard;

  chrome.notifications.create(intent.id || `intent-${Date.now()}`, {
    type: "basic",
    iconUrl: "icons/icon128.png",
    title: `${config.emoji} Anticipy`,
    message: intent.summary_for_user || "New action detected",
    priority: config.priority,
    requireInteraction: config.requireInteraction
  });

  // Update badge with action count
  chrome.action.setBadgeText({ text: String(lastActions.length) });
  chrome.action.setBadgeBackgroundColor({ color: "#C8A97E" });
}

// Called when an intent status changes to "confirmed" — the browser agent should execute it
async function handleConfirmedIntent(intent) {
  if (!intent || !intent.id) return;

  // Dedupe: don't execute the same intent twice in the same session
  const dedupKey = `executed_${intent.id}`;
  const stored = await chrome.storage.local.get(dedupKey);
  if (stored[dedupKey]) {
    console.log("Anticipy: already executed intent", intent.id);
    return;
  }
  await chrome.storage.local.set({ [dedupKey]: true });

  // Use the pre-built browser task if stored, otherwise fall back to summary
  const params = intent.parameters || {};
  const task = params.browser_task || intent.summary_for_user || "Complete the requested task.";

  console.log("Anticipy: executing confirmed intent via local engine:", intent.id, task.substring(0, 80));

  try {
    const response = await fetch("http://localhost:8000/execute-intent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        task,
        intent_id: intent.id,
        user_id: intent.user_id || null
      }),
      signal: AbortSignal.timeout(35000)
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      console.error("Anticipy: engine returned error:", response.status, errText);
      return;
    }

    const result = await response.json();
    console.log("Anticipy: engine result for intent", intent.id, "→", result.message || result.working);

    // Show notification with result
    chrome.notifications.create(`exec-${intent.id}`, {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: result.success || result.working ? "✅ Anticipy done" : "⚠️ Anticipy",
      message: result.message || (result.working ? "Working on it…" : "Task finished."),
      priority: 0
    });
  } catch (err) {
    const isOffline = err?.name === "AbortError" || err?.message?.includes("Failed to fetch");
    console.error("Anticipy: could not reach local engine:", err?.message || err);
    // Don't show a notification for connection errors to avoid spamming when engine is off
    if (!isOffline) {
      chrome.notifications.create(`exec-err-${intent.id}`, {
        type: "basic",
        iconUrl: "icons/icon128.png",
        title: "⚠️ Anticipy",
        message: "Browser agent unavailable. Make sure the engine is running on port 8000.",
        priority: 0
      });
    }
    // Remove dedup key so it can be retried
    await chrome.storage.local.remove(dedupKey);
  }
}

function updateBadge(status) {
  if (status === "connected") {
    chrome.action.setBadgeBackgroundColor({ color: "#4CAF50" });
    chrome.action.setBadgeText({ text: "" });
  } else {
    chrome.action.setBadgeBackgroundColor({ color: "#FF5252" });
    chrome.action.setBadgeText({ text: "!" });
  }
  chrome.storage.local.set({ connectionStatus: status });
}

// Handle messages from popup and content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "GET_STATUS") {
    sendResponse({
      connected,
      lastActions,
      wsState: realtimeWs ? realtimeWs.readyState : -1
    });
    return true;
  }

  if (message.type === "RECONNECT") {
    if (realtimeWs) {
      realtimeWs.close();
      realtimeWs = null;
    }
    connectRealtime();
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === "CLEAR_ACTIONS") {
    lastActions = [];
    chrome.storage.local.set({ lastActions: [] });
    chrome.action.setBadgeText({ text: "" });
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === "EXECUTE_DOM_ACTION") {
    // Forward to content script in active tab
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, {
          type: "DOM_ACTION",
          action: message.action
        }, sendResponse);
      } else {
        sendResponse({ success: false, error: "No active tab" });
      }
    });
    return true; // Keep channel open for async response
  }
});

// Handle notification clicks — open the engine page
chrome.notifications.onClicked.addListener((notificationId) => {
  chrome.tabs.create({ url: "https://www.anticipy.ai/engine" });
  chrome.notifications.clear(notificationId);
});

// Connect on install
chrome.runtime.onInstalled.addListener(() => {
  console.log("Anticipy: Extension installed");
  connectRealtime();
});

// Connect on startup
chrome.runtime.onStartup.addListener(() => {
  console.log("Anticipy: Extension started");
  connectRealtime();
});

// Initial connection
connectRealtime();
