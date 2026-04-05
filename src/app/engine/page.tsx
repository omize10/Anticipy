"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "motion/react";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ENGINE_URL =
  process.env.NEXT_PUBLIC_ENGINE_URL || "http://localhost:8000";

// SHA-256 of "123"
const ACCESS_HASH =
  "a665a45920422f9d417e4867efdc4fb8a04a1f3fff1fa07e998e86f7f7a27ae3";

const GREETING =
  "Hey! I can help you get things done on the web \u2014 booking restaurants, managing subscriptions, filling out forms, you name it. Just tell me what you need.";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type AppPhase = "gate" | "auth" | "chat";
type AuthMode = "login" | "signup";

interface Message {
  id: string;
  role: "user" | "agent" | "status" | "confirm" | "login_needed";
  text: string;
  action?: string; // for confirm messages
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function hashCode(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ---------------------------------------------------------------------------
// Component: AccessGate
// ---------------------------------------------------------------------------

function AccessGate({ onPass }: { onPass: () => void }) {
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setChecking(true);
    const hashed = await hashCode(code.trim());
    if (hashed === ACCESS_HASH) {
      onPass();
    } else {
      setError("That code didn\u2019t work. Try again.");
    }
    setChecking(false);
  }

  return (
    <div className="min-h-screen bg-dark flex items-center justify-center px-6">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
        className="w-full max-w-sm"
      >
        <h1 className="font-serif text-[28px] text-center mb-2 text-[var(--text-on-dark)]">
          Anticipy Engine
        </h1>
        <p className="text-[var(--text-on-dark-muted)] text-[15px] text-center mb-8">
          Enter your access code to continue.
        </p>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <input
            type="password"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="Access code"
            autoFocus
            className="w-full bg-dark-elevated border border-dark-border rounded-pill px-5 py-3 text-[15px] text-[var(--text-on-dark)] placeholder:text-[var(--text-on-dark-muted)] outline-none focus:border-gold transition-colors"
          />
          {error && (
            <p className="text-[13px] text-red-400 text-center">{error}</p>
          )}
          <button
            type="submit"
            disabled={checking || !code.trim()}
            className="w-full bg-gold text-dark font-medium text-[15px] rounded-pill py-3 hover:opacity-90 transition-opacity disabled:opacity-40"
          >
            {checking ? "Checking\u2026" : "Continue"}
          </button>
        </form>
      </motion.div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component: AuthForm
// ---------------------------------------------------------------------------

function AuthForm({ onAuth }: { onAuth: (token: string) => void }) {
  const [mode, setMode] = useState<AuthMode>("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setLoading(true);

    const endpoint =
      mode === "signup" ? "/auth/signup" : "/auth/login";

    try {
      const res = await fetch(`${ENGINE_URL}${endpoint}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: username.trim(), password }),
      });

      const data = await res.json();

      if (!data.success) {
        setError(data.message || "Something went wrong. Please try again.");
        setLoading(false);
        return;
      }

      const jwt = data.token;
      if (jwt) {
        localStorage.setItem("engine_token", jwt);
        onAuth(jwt);
      } else {
        setError("Something went wrong. Please try again.");
      }
    } catch {
      setError("Could not reach the server. Please try again later.");
    }

    setLoading(false);
  }

  return (
    <div className="min-h-screen bg-dark flex items-center justify-center px-6">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
        className="w-full max-w-sm"
      >
        <h1 className="font-serif text-[28px] text-center mb-2 text-[var(--text-on-dark)]">
          {mode === "login" ? "Welcome back" : "Create your account"}
        </h1>
        <p className="text-[var(--text-on-dark-muted)] text-[15px] text-center mb-8">
          {mode === "login"
            ? "Sign in to start using the engine."
            : "Pick a username and password to get started."}
        </p>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <input
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="Username"
            autoFocus
            autoComplete="username"
            className="w-full bg-dark-elevated border border-dark-border rounded-pill px-5 py-3 text-[15px] text-[var(--text-on-dark)] placeholder:text-[var(--text-on-dark-muted)] outline-none focus:border-gold transition-colors"
          />
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            autoComplete={mode === "signup" ? "new-password" : "current-password"}
            className="w-full bg-dark-elevated border border-dark-border rounded-pill px-5 py-3 text-[15px] text-[var(--text-on-dark)] placeholder:text-[var(--text-on-dark-muted)] outline-none focus:border-gold transition-colors"
          />
          {error && (
            <p className="text-[13px] text-red-400 text-center">{error}</p>
          )}
          <button
            type="submit"
            disabled={loading || !username.trim() || !password}
            className="w-full bg-gold text-dark font-medium text-[15px] rounded-pill py-3 hover:opacity-90 transition-opacity disabled:opacity-40"
          >
            {loading
              ? "Please wait\u2026"
              : mode === "login"
              ? "Sign in"
              : "Create account"}
          </button>
        </form>

        <p className="text-center text-[var(--text-on-dark-muted)] text-[13px] mt-6">
          {mode === "login" ? (
            <>
              Don&apos;t have an account?{" "}
              <button
                type="button"
                onClick={() => {
                  setMode("signup");
                  setError("");
                }}
                className="text-gold hover:underline"
              >
                Sign up
              </button>
            </>
          ) : (
            <>
              Already have an account?{" "}
              <button
                type="button"
                onClick={() => {
                  setMode("login");
                  setError("");
                }}
                className="text-gold hover:underline"
              >
                Sign in
              </button>
            </>
          )}
        </p>
      </motion.div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component: ChatInterface
// ---------------------------------------------------------------------------

function ChatInterface({ token }: { token: string }) {
  const [messages, setMessages] = useState<Message[]>([
    { id: uid(), role: "agent", text: GREETING },
  ]);
  const [input, setInput] = useState("");
  const [connected, setConnected] = useState(false);
  const [awaitingConfirm, setAwaitingConfirm] = useState(false);
  const [awaitingLogin, setAwaitingLogin] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // WebSocket connection
  const connectWs = useCallback(() => {
    const wsUrl = ENGINE_URL.replace(/^http/, "ws");
    const ws = new WebSocket(`${wsUrl}/ws/task?token=${token}`);

    ws.onopen = () => {
      setConnected(true);
    };

    ws.onclose = () => {
      setConnected(false);
    };

    ws.onerror = () => {
      setConnected(false);
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        switch (data.type) {
          case "status":
            // Replace the previous status message if any, or add new one
            setMessages((prev) => {
              const withoutOldStatus = prev.filter((m) => m.role !== "status");
              return [
                ...withoutOldStatus,
                { id: uid(), role: "status", text: data.message },
              ];
            });
            break;

          case "confirm":
            setAwaitingConfirm(true);
            // Clear status messages and add the confirmation
            setMessages((prev) => {
              const withoutStatus = prev.filter((m) => m.role !== "status");
              return [
                ...withoutStatus,
                {
                  id: uid(),
                  role: "confirm",
                  text: data.message,
                  action: data.action,
                },
              ];
            });
            break;

          case "login_needed":
            setAwaitingLogin(true);
            setMessages((prev) => {
              const withoutStatus = prev.filter((m) => m.role !== "status");
              return [
                ...withoutStatus,
                { id: uid(), role: "login_needed", text: data.message },
              ];
            });
            break;

          case "complete":
            // Clear status messages and add the final message
            setMessages((prev) => {
              const withoutStatus = prev.filter((m) => m.role !== "status");
              return [
                ...withoutStatus,
                { id: uid(), role: "agent", text: data.message },
              ];
            });
            break;

          case "error":
            setMessages((prev) => {
              const withoutStatus = prev.filter((m) => m.role !== "status");
              return [
                ...withoutStatus,
                { id: uid(), role: "agent", text: data.message },
              ];
            });
            break;

          case "chat":
            setMessages((prev) => {
              const withoutStatus = prev.filter((m) => m.role !== "status");
              return [
                ...withoutStatus,
                { id: uid(), role: "agent", text: data.message },
              ];
            });
            break;
        }
      } catch {
        // Ignore malformed messages
      }
    };

    wsRef.current = ws;
  }, [token]);

  useEffect(() => {
    connectWs();
    return () => {
      wsRef.current?.close();
    };
  }, [connectWs]);

  // Send a user message
  function sendMessage() {
    const text = input.trim();
    if (!text || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN)
      return;

    setMessages((prev) => [...prev, { id: uid(), role: "user", text }]);
    wsRef.current.send(JSON.stringify({ type: "start", text }));
    setInput("");
    inputRef.current?.focus();
  }

  // Handle confirm response
  function handleConfirm(value: "yes" | "no") {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;

    setAwaitingConfirm(false);
    setMessages((prev) => [
      ...prev,
      {
        id: uid(),
        role: "user",
        text: value === "yes" ? "Yes, go ahead" : "No, cancel",
      },
    ]);
    wsRef.current.send(JSON.stringify({ type: "confirm", value }));
  }

  // Handle continue after login
  function handleContinue() {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;

    setAwaitingLogin(false);
    setMessages((prev) => [
      ...prev,
      { id: uid(), role: "user", text: "Done, continue" },
    ]);
    wsRef.current.send(JSON.stringify({ type: "continue" }));
  }

  // Handle Enter key in input
  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }

  return (
    <div className="min-h-screen bg-dark flex flex-col">
      {/* Header */}
      <header className="shrink-0 border-b border-dark-border px-6 py-4 flex items-center justify-between">
        <h1 className="font-serif text-[20px] text-[var(--text-on-dark)]">
          Anticipy Engine
        </h1>
        <div className="flex items-center gap-2">
          <span
            className={`inline-block w-2 h-2 rounded-full ${
              connected ? "bg-emerald-400" : "bg-[var(--text-on-dark-muted)]"
            }`}
          />
          <span className="text-[12px] text-[var(--text-on-dark-muted)]">
            {connected ? "Connected" : "Disconnected"}
          </span>
        </div>
      </header>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-6">
        <div className="max-w-2xl mx-auto flex flex-col gap-4">
          <AnimatePresence initial={false}>
            {messages.map((msg) => (
              <MessageBubble key={msg.id} message={msg} />
            ))}
          </AnimatePresence>

          {/* Confirm buttons */}
          {awaitingConfirm && (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              className="flex gap-3 ml-0"
            >
              <button
                onClick={() => handleConfirm("yes")}
                className="bg-gold text-dark font-medium text-[14px] rounded-pill px-6 py-2.5 hover:opacity-90 transition-opacity"
              >
                Yes, go ahead
              </button>
              <button
                onClick={() => handleConfirm("no")}
                className="bg-dark-elevated border border-dark-border text-[var(--text-on-dark)] font-medium text-[14px] rounded-pill px-6 py-2.5 hover:border-[var(--text-on-dark-muted)] transition-colors"
              >
                No, cancel
              </button>
            </motion.div>
          )}

          {/* Login continue button */}
          {awaitingLogin && (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              className="flex flex-col gap-3 ml-0"
            >
              <div className="w-full h-[300px] bg-dark-elevated border border-dark-border rounded-card flex items-center justify-center">
                <p className="text-[var(--text-on-dark-muted)] text-[14px]">
                  Browser view will appear here
                </p>
              </div>
              <button
                onClick={handleContinue}
                className="bg-gold text-dark font-medium text-[14px] rounded-pill px-6 py-2.5 hover:opacity-90 transition-opacity self-start"
              >
                Done, continue
              </button>
            </motion.div>
          )}

          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Input */}
      <div className="shrink-0 border-t border-dark-border px-4 py-4">
        <div className="max-w-2xl mx-auto flex gap-3">
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Tell me what you need\u2026"
            disabled={awaitingConfirm || awaitingLogin}
            className="flex-1 bg-dark-elevated border border-dark-border rounded-pill px-5 py-3 text-[15px] text-[var(--text-on-dark)] placeholder:text-[var(--text-on-dark-muted)] outline-none focus:border-gold transition-colors disabled:opacity-40"
          />
          <button
            onClick={sendMessage}
            disabled={
              !input.trim() ||
              !connected ||
              awaitingConfirm ||
              awaitingLogin
            }
            className="bg-gold text-dark rounded-full w-12 h-12 flex items-center justify-center hover:opacity-90 transition-opacity disabled:opacity-40 shrink-0"
            aria-label="Send message"
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 20 20"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
            >
              <path
                d="M3.5 10H16.5M16.5 10L10.5 4M16.5 10L10.5 16"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component: MessageBubble
// ---------------------------------------------------------------------------

function MessageBubble({ message }: { message: Message }) {
  if (message.role === "status") {
    return (
      <motion.div
        layout
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.2 }}
        className="flex items-center gap-2"
      >
        <span className="inline-block w-1.5 h-1.5 rounded-full bg-gold animate-pulse" />
        <span className="text-[13px] text-[var(--text-on-dark-muted)]">
          {message.text}
        </span>
      </motion.div>
    );
  }

  if (message.role === "user") {
    return (
      <motion.div
        layout
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.25 }}
        className="flex justify-end"
      >
        <div className="bg-gold text-dark rounded-[20px] rounded-br-[4px] px-5 py-3 max-w-[80%] text-[15px]">
          {message.text}
        </div>
      </motion.div>
    );
  }

  if (message.role === "confirm" || message.role === "login_needed") {
    return (
      <motion.div
        layout
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
        className="flex justify-start"
      >
        <div className="bg-dark-elevated border border-dark-border rounded-[20px] rounded-bl-[4px] px-5 py-3 max-w-[80%] text-[15px] text-[var(--text-on-dark)]">
          {message.text}
        </div>
      </motion.div>
    );
  }

  // agent
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="flex justify-start"
    >
      <div className="bg-dark-elevated border border-dark-border rounded-[20px] rounded-bl-[4px] px-5 py-3 max-w-[80%] text-[15px] text-[var(--text-on-dark)]">
        {message.text}
      </div>
    </motion.div>
  );
}

// ---------------------------------------------------------------------------
// Page Component
// ---------------------------------------------------------------------------

export default function EnginePage() {
  const [phase, setPhase] = useState<AppPhase>("gate");
  const [token, setToken] = useState<string | null>(null);

  // On mount, check for existing token
  useEffect(() => {
    const stored = localStorage.getItem("engine_token");
    const gateCleared = sessionStorage.getItem("engine_gate");
    if (stored && gateCleared) {
      setToken(stored);
      setPhase("chat");
    } else if (gateCleared) {
      setPhase("auth");
    }
  }, []);

  function handleGatePass() {
    sessionStorage.setItem("engine_gate", "1");
    setPhase("auth");
  }

  function handleAuth(jwt: string) {
    setToken(jwt);
    setPhase("chat");
  }

  return (
    <>
      {phase === "gate" && <AccessGate onPass={handleGatePass} />}
      {phase === "auth" && <AuthForm onAuth={handleAuth} />}
      {phase === "chat" && token && <ChatInterface token={token} />}
    </>
  );
}
