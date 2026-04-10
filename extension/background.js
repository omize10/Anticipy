// Anticipy Chrome Extension — Service Worker (Manifest V3)
// Connects to Supabase Realtime to receive action commands

const SUPABASE_URL = "https://ogbxpqkmsdrcuilafycn.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9nYnhwcWttc2RyY3VpbGFmeWNuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ4NDI3NDksImV4cCI6MjA5MDQxODc0OX0.PNfKYanSXJTfrYXWGZoUBFaZVE_jnsV4cqBXgxrRJ-0";

let realtimeWs = null;
let connected = false;
let lastActions = [];

// Keep service worker alive with alarm (MV3 kills it after 30s of inactivity)
chrome.alarms.create("keepalive", { periodInMinutes: 0.4 }); // every 24 seconds

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "keepalive") {
    // Ping WebSocket to keep alive
    if (realtimeWs && realtimeWs.readyState === WebSocket.OPEN) {
      realtimeWs.send(JSON.stringify({ topic: "phoenix", event: "heartbeat", payload: {}, ref: Date.now().toString() }));
    } else {
      connectRealtime();
    }
  }
});

function connectRealtime() {
  if (realtimeWs && realtimeWs.readyState === WebSocket.OPEN) return;

  const wsUrl = SUPABASE_URL.replace("https://", "wss://") + "/realtime/v1/websocket?apikey=" + SUPABASE_ANON_KEY + "&vsn=1.0.0";

  try {
    realtimeWs = new WebSocket(wsUrl);

    realtimeWs.onopen = () => {
      connected = true;
      updateBadge("connected");

      // Join the intents channel for real-time updates
      const joinMsg = {
        topic: "realtime:public:anticipy_intents",
        event: "phx_join",
        payload: {
          config: {
            broadcast: { self: false },
            postgres_changes: [
              { event: "INSERT", schema: "public", table: "anticipy_intents" }
            ]
          }
        },
        ref: "1"
      };
      realtimeWs.send(JSON.stringify(joinMsg));
    };

    realtimeWs.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);

        if (msg.event === "postgres_changes" || msg.event === "INSERT") {
          const payload = msg.payload?.record || msg.payload;
          if (payload && payload.summary_for_user) {
            handleNewIntent(payload);
          }
        }
      } catch (e) {
        // Ignore parse errors for heartbeat responses
      }
    };

    realtimeWs.onclose = () => {
      connected = false;
      updateBadge("disconnected");
      // Reconnect after 5 seconds
      setTimeout(connectRealtime, 5000);
    };

    realtimeWs.onerror = () => {
      connected = false;
      updateBadge("disconnected");
    };
  } catch (e) {
    console.error("Anticipy: WebSocket connection failed:", e);
    connected = false;
    updateBadge("disconnected");
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
    timestamp: new Date().toISOString()
  });
  lastActions = lastActions.slice(0, 5); // Keep last 5

  chrome.storage.local.set({ lastActions });

  // Show Chrome notification
  const importanceEmoji = {
    critical: "🔴",
    important: "🟠",
    standard: "🟡",
    low: "⚪"
  };

  chrome.notifications.create(intent.id || `intent-${Date.now()}`, {
    type: "basic",
    iconUrl: "icons/icon128.png",
    title: `${importanceEmoji[intent.importance] || "🟡"} Anticipy`,
    message: intent.summary_for_user,
    priority: intent.importance === "critical" ? 2 : 1,
    requireInteraction: intent.importance === "critical"
  });
}

function updateBadge(status) {
  const color = status === "connected" ? "#4CAF50" : "#FF5252";
  const text = status === "connected" ? "" : "!";
  chrome.action.setBadgeBackgroundColor({ color });
  chrome.action.setBadgeText({ text });
  chrome.storage.local.set({ connectionStatus: status });
}

// Handle messages from content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "GET_STATUS") {
    sendResponse({ connected, lastActions });
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
      }
    });
    return true; // Keep channel open for async response
  }
});

// Handle notification clicks
chrome.notifications.onClicked.addListener((notificationId) => {
  chrome.tabs.create({ url: "https://www.anticipy.ai/engine" });
});

// Connect on install and startup
chrome.runtime.onInstalled.addListener(() => {
  connectRealtime();
});

chrome.runtime.onStartup.addListener(() => {
  connectRealtime();
});

// Initial connection
connectRealtime();
