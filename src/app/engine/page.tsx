"use client";

import { useState, useRef, useCallback, useEffect, type FormEvent } from "react";
import { supabase } from "@/lib/supabase";
import type { Session } from "@supabase/supabase-js";

// ─── Types ────────────────────────────────────────────────────────────────────

interface TranscriptSegment {
  speaker_id: number;
  start_time: number;
  end_time: number;
  text: string;
}

interface Intent {
  id: string;
  action_type: string;
  confidence: number;
  importance: string;
  summary_for_user: string;
  evidence_quote: string;
  parameters: Record<string, unknown>;
}

type EngineState =
  | "idle"
  | "recording"
  | "processing"
  | "transcribing"
  | "analyzing"
  | "done"
  | "error";

type AuthMode = "signin" | "signup";

// ─── Constants ────────────────────────────────────────────────────────────────

const SPEAKER_COLORS = [
  "#C8A97E",
  "#7C9CBF",
  "#9B8EC4",
  "#7EBF8A",
  "#BF7E7E",
];

const IMPORTANCE_STYLES: Record<
  string,
  { bg: string; border: string; label: string }
> = {
  critical: {
    bg: "rgba(239,68,68,0.1)",
    border: "rgba(239,68,68,0.3)",
    label: "CRITICAL",
  },
  important: {
    bg: "rgba(251,146,60,0.1)",
    border: "rgba(251,146,60,0.3)",
    label: "Important",
  },
  standard: {
    bg: "rgba(200,169,126,0.1)",
    border: "rgba(200,169,126,0.3)",
    label: "Standard",
  },
  low: {
    bg: "rgba(138,138,138,0.08)",
    border: "rgba(138,138,138,0.2)",
    label: "Low",
  },
};

// ─── Component ────────────────────────────────────────────────────────────────

export default function EnginePage() {
  // ── Auth state ──────────────────────────────────────────────────────────────
  const [session, setSession] = useState<Session | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authMode, setAuthMode] = useState<AuthMode>("signin");
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authError, setAuthError] = useState("");
  const [authSubmitting, setAuthSubmitting] = useState(false);
  const [authSuccess, setAuthSuccess] = useState(false);

  // ── Setup state ─────────────────────────────────────────────────────────────
  const [accessCode, setAccessCode] = useState("");
  const [codeCopied, setCodeCopied] = useState(false);
  const [setupDismissed, setSetupDismissed] = useState(false);

  // ── Engine state ────────────────────────────────────────────────────────────
  const [state, setState] = useState<EngineState>("idle");
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);
  const [intents, setIntents] = useState<Intent[]>([]);
  const [error, setError] = useState("");
  const [duration, setDuration] = useState(0);
  const [audioLevel, setAudioLevel] = useState(0);
  const [manualTranscript, setManualTranscript] = useState("");
  const [liveText, setLiveText] = useState("");
  const [calendarConnected, setCalendarConnected] = useState(false);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const sessionIdRef = useRef<string>("");
  const timerRef = useRef<ReturnType<typeof setInterval>>();
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animFrameRef = useRef<number>(0);
  const streamRef = useRef<MediaStream | null>(null);
  const dgSocketRef = useRef<WebSocket | null>(null);
  const liveSegmentsRef = useRef<TranscriptSegment[]>([]);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);

  // ── Auth effects ────────────────────────────────────────────────────────────

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setAuthLoading(false);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_, session) => {
      setSession(session);
      if (session) setAuthLoading(false);
    });
    return () => subscription.unsubscribe();
  }, []);

  // Fetch access code once authenticated
  useEffect(() => {
    if (!session) return;
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      if (!session) return;
      try {
        const res = await fetch("/api/extension/access-code", {
          headers: { Authorization: `Bearer ${session.access_token}` },
        });
        if (res.ok) {
          const data = await res.json();
          setAccessCode(data.code || "");
        }
      } catch {
        // Non-critical
      }
    });
  }, [session]);

  // Check calendar status
  useEffect(() => {
    if (!session) return;
    fetch("/api/auth/google/status")
      .then((r) => r.json())
      .then((d) => setCalendarConnected(d.connected))
      .catch(() => {});
  }, [session]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
      }
      if (dgSocketRef.current) dgSocketRef.current.close();
      if (audioCtxRef.current) audioCtxRef.current.close();
    };
  }, []);

  // ── Auth handlers ───────────────────────────────────────────────────────────

  const handleAuth = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      setAuthError("");
      setAuthSubmitting(true);

      try {
        if (authMode === "signup") {
          const { error, data } = await supabase.auth.signUp({
            email: authEmail,
            password: authPassword,
          });
          if (error) {
            setAuthError(error.message);
          } else if (!data.session) {
            setAuthSuccess(true);
          }
        } else {
          const { error } = await supabase.auth.signInWithPassword({
            email: authEmail,
            password: authPassword,
          });
          if (error) {
            setAuthError(
              error.message.toLowerCase().includes("invalid")
                ? "Incorrect email or password."
                : error.message
            );
          }
        }
      } finally {
        setAuthSubmitting(false);
      }
    },
    [authMode, authEmail, authPassword]
  );

  const handleSignOut = useCallback(async () => {
    await supabase.auth.signOut();
    reset();
    setAccessCode("");
    setSetupDismissed(false);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const copyCode = useCallback(() => {
    if (!accessCode) return;
    navigator.clipboard.writeText(accessCode).catch(() => {});
    setCodeCopied(true);
    setTimeout(() => setCodeCopied(false), 2000);
  }, [accessCode]);

  // ── Engine handlers ─────────────────────────────────────────────────────────

  const startRecording = useCallback(async () => {
    try {
      setError("");
      setSegments([]);
      setIntents([]);
      setDuration(0);
      setLiveText("");
      liveSegmentsRef.current = [];

      const sessionRes = await fetch("/api/engine/session", { method: "POST" });
      const sessionData = await sessionRes.json();
      if (!sessionRes.ok) throw new Error(sessionData.error);
      sessionIdRef.current = sessionData.sessionId;

      const keyRes = await fetch("/api/engine/deepgram-key");
      const keyData = await keyRes.json();
      if (!keyRes.ok) throw new Error(keyData.error || "Failed to get Deepgram key");

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 16000 },
      });
      streamRef.current = stream;

      const audioCtx = new AudioContext({ sampleRate: 16000 });
      audioCtxRef.current = audioCtx;
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      analyserRef.current = analyser;

      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      const updateLevel = () => {
        analyser.getByteFrequencyData(dataArray);
        const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
        setAudioLevel(avg / 128);
        animFrameRef.current = requestAnimationFrame(updateLevel);
      };
      updateLevel();

      const dgParams = new URLSearchParams({
        model: "nova-3",
        diarize: "true",
        punctuate: "true",
        language: "en",
        smart_format: "true",
        interim_results: "true",
        endpointing: "300",
        encoding: "linear16",
        sample_rate: "16000",
        channels: "1",
      });

      const dgWs = new WebSocket(
        `wss://api.deepgram.com/v1/listen?${dgParams}`,
        ["token", keyData.key]
      );
      dgSocketRef.current = dgWs;

      dgWs.onopen = () => {
        const processor = audioCtx.createScriptProcessor(4096, 1, 1);
        processorRef.current = processor;
        source.connect(processor);
        processor.connect(audioCtx.destination);

        processor.onaudioprocess = (e) => {
          if (dgWs.readyState !== WebSocket.OPEN) return;
          const inputData = e.inputBuffer.getChannelData(0);
          const int16 = new Int16Array(inputData.length);
          for (let i = 0; i < inputData.length; i++) {
            const s = Math.max(-1, Math.min(1, inputData[i]));
            int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
          }
          dgWs.send(int16.buffer);
        };
      };

      dgWs.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === "Results" && msg.channel) {
            const alt = msg.channel.alternatives?.[0];
            if (!alt) return;

            const isFinal = msg.is_final;
            const transcript = alt.transcript;

            if (isFinal && transcript) {
              const words = alt.words || [];
              if (words.length > 0) {
                let current: TranscriptSegment | null = null;
                const newSegments: TranscriptSegment[] = [];

                for (const w of words) {
                  if (!current || current.speaker_id !== (w.speaker ?? 0)) {
                    if (current) newSegments.push(current);
                    current = {
                      speaker_id: w.speaker ?? 0,
                      start_time: w.start,
                      end_time: w.end,
                      text: w.punctuated_word || w.word,
                    };
                  } else {
                    current.end_time = w.end;
                    current.text += " " + (w.punctuated_word || w.word);
                  }
                }
                if (current) newSegments.push(current);

                liveSegmentsRef.current = [...liveSegmentsRef.current, ...newSegments];
                setSegments([...liveSegmentsRef.current]);
              }
              setLiveText("");
            } else if (transcript) {
              setLiveText(transcript);
            }
          }
        } catch {
          // Ignore parse errors
        }
      };

      dgWs.onerror = (e) => console.error("Deepgram WebSocket error:", e);

      const recorder = new MediaRecorder(stream, {
        mimeType: MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
          ? "audio/webm;codecs=opus"
          : "audio/webm",
      });
      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.start(1000);
      mediaRecorderRef.current = recorder;
      setState("recording");

      const startTime = Date.now();
      timerRef.current = setInterval(() => {
        setDuration(Math.floor((Date.now() - startTime) / 1000));
      }, 1000);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to start recording";
      setError(message);
      setState("error");
    }
  }, []);

  const stopRecording = useCallback(async () => {
    if (!mediaRecorderRef.current) return;

    setState("processing");
    if (timerRef.current) clearInterval(timerRef.current);
    if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    setAudioLevel(0);
    setLiveText("");

    if (dgSocketRef.current && dgSocketRef.current.readyState === WebSocket.OPEN) {
      dgSocketRef.current.send(JSON.stringify({ type: "CloseStream" }));
      await new Promise((r) => setTimeout(r, 1000));
      dgSocketRef.current.close();
    }

    if (processorRef.current) processorRef.current.disconnect();

    const recorder = mediaRecorderRef.current;
    await new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
      recorder.stop();
    });

    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
    }
    if (audioCtxRef.current) audioCtxRef.current.close();

    const finalSegments = liveSegmentsRef.current;

    if (finalSegments.length === 0) {
      setState("transcribing");
      try {
        const audioBlob = new Blob(chunksRef.current, { type: "audio/webm" });
        const formData = new FormData();
        formData.append("audio", audioBlob, "recording.webm");
        formData.append("sessionId", sessionIdRef.current);

        const transcribeRes = await fetch("/api/engine/transcribe", {
          method: "POST",
          body: formData,
        });
        const transcribeData = await transcribeRes.json();
        if (!transcribeRes.ok) throw new Error(transcribeData.error);

        if (!transcribeData.segments?.length) {
          setState("done");
          setError("No speech detected. Try speaking louder or closer to the mic.");
          return;
        }

        setSegments(transcribeData.segments);
        await analyzeTranscript(transcribeData.transcript);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Processing failed";
        setError(message);
        setState("error");
      }
      return;
    }

    const rows = finalSegments.map((s) => ({
      session_id: sessionIdRef.current,
      speaker_id: s.speaker_id,
      start_time: s.start_time,
      end_time: s.end_time,
      text: s.text,
      is_final: true,
    }));

    fetch("/api/engine/transcribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: sessionIdRef.current, segments: rows }),
    }).catch(() => {});

    const transcriptStr = finalSegments
      .map((s) => `[Speaker ${s.speaker_id}]: ${s.text}`)
      .join("\n");

    await analyzeTranscript(transcriptStr);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const analyzeTranscript = useCallback(async (transcript: string) => {
    setState("analyzing");
    try {
      const analyzeRes = await fetch("/api/engine/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: sessionIdRef.current,
          transcript,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }),
      });
      const analyzeData = await analyzeRes.json();
      if (!analyzeRes.ok) throw new Error(analyzeData.error || "Analysis failed");

      setIntents(analyzeData.intents ?? []);
      setState("done");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Analysis failed";
      setError(message);
      setState("error");
    }
  }, []);

  const analyzeManualTranscript = useCallback(async () => {
    if (!manualTranscript.trim()) return;

    setError("");
    setSegments([]);
    setIntents([]);
    setState("processing");

    try {
      const sessionRes = await fetch("/api/engine/session", { method: "POST" });
      const sessionData = await sessionRes.json();
      if (!sessionRes.ok) throw new Error(sessionData.error);
      sessionIdRef.current = sessionData.sessionId;

      const lines = manualTranscript.trim().split("\n");
      const parsedSegments: TranscriptSegment[] = [];
      let time = 0;
      for (const line of lines) {
        const match = line.match(/^\[?(?:Speaker\s*)?(\d+)\]?:\s*(.+)/i);
        if (match) {
          parsedSegments.push({
            speaker_id: parseInt(match[1]),
            start_time: time,
            end_time: time + 2,
            text: match[2].trim(),
          });
          time += 2;
        } else if (line.trim()) {
          parsedSegments.push({
            speaker_id: 0,
            start_time: time,
            end_time: time + 2,
            text: line.trim(),
          });
          time += 2;
        }
      }
      setSegments(parsedSegments);

      await analyzeTranscript(manualTranscript);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Analysis failed";
      setError(message);
      setState("error");
    }
  }, [manualTranscript, analyzeTranscript]);

  const reset = useCallback(() => {
    setState("idle");
    setSegments([]);
    setIntents([]);
    setError("");
    setDuration(0);
    setLiveText("");
    setManualTranscript("");
    liveSegmentsRef.current = [];
  }, []);

  const formatDuration = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  // ── Loading ─────────────────────────────────────────────────────────────────

  if (authLoading) {
    return (
      <div
        style={{
          background: "var(--dark)",
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <div
          className="animate-spin"
          style={{
            width: 32,
            height: 32,
            borderRadius: "50%",
            border: "2px solid var(--dark-border)",
            borderTopColor: "var(--gold)",
          }}
        />
      </div>
    );
  }

  // ── Auth screen ─────────────────────────────────────────────────────────────

  if (!session) {
    return (
      <div
        style={{
          background: "var(--dark)",
          minHeight: "100vh",
          color: "var(--text-on-dark)",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          padding: "24px",
        }}
      >
        {/* Logo */}
        <a
          href="/"
          className="font-serif"
          style={{
            fontSize: 26,
            color: "var(--text-on-dark)",
            textDecoration: "none",
            marginBottom: 48,
          }}
        >
          Anticipy
        </a>

        <div style={{ maxWidth: 420, width: "100%" }}>
          {/* Tagline */}
          <div style={{ textAlign: "center", marginBottom: 36 }}>
            <h1
              className="font-serif"
              style={{
                fontSize: "clamp(22px, 4vw, 28px)",
                fontWeight: 400,
                marginBottom: 12,
                lineHeight: 1.3,
              }}
            >
              Your AI that acts, not just answers.
            </h1>
            <p
              style={{
                fontSize: 15,
                color: "var(--text-on-dark-muted)",
                fontWeight: 300,
                lineHeight: 1.7,
              }}
            >
              Anticipy listens to your conversations and handles the follow-ups
              — bookings, emails, reminders — without you lifting a finger.
            </p>
          </div>

          {/* Auth card */}
          <div
            style={{
              background: "var(--dark-elevated)",
              border: "1px solid var(--dark-border)",
              borderRadius: 16,
              padding: 28,
            }}
          >
            {authSuccess ? (
              /* Email confirmation sent */
              <div style={{ textAlign: "center", padding: "8px 0" }}>
                <div
                  style={{
                    width: 48,
                    height: 48,
                    borderRadius: "50%",
                    background: "rgba(200,169,126,0.12)",
                    border: "1px solid rgba(200,169,126,0.25)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    margin: "0 auto 16px",
                    fontSize: 20,
                    color: "var(--gold)",
                  }}
                >
                  ✓
                </div>
                <h2
                  style={{
                    fontSize: 17,
                    fontWeight: 600,
                    marginBottom: 8,
                  }}
                >
                  Check your email
                </h2>
                <p
                  style={{
                    fontSize: 14,
                    color: "var(--text-on-dark-muted)",
                    fontWeight: 300,
                    lineHeight: 1.6,
                    marginBottom: 20,
                  }}
                >
                  We sent a confirmation link to{" "}
                  <strong style={{ color: "var(--text-on-dark)" }}>
                    {authEmail}
                  </strong>
                  . Click it to activate your account, then come back here.
                </p>
                <button
                  onClick={() => {
                    setAuthSuccess(false);
                    setAuthMode("signin");
                  }}
                  style={{
                    background: "none",
                    border: "none",
                    color: "var(--gold)",
                    fontSize: 13,
                    cursor: "pointer",
                    textDecoration: "underline",
                  }}
                >
                  Back to sign in
                </button>
              </div>
            ) : (
              <>
                {/* Tab toggle */}
                <div
                  style={{
                    display: "flex",
                    gap: 4,
                    marginBottom: 24,
                    background: "rgba(255,255,255,0.04)",
                    padding: 4,
                    borderRadius: 10,
                  }}
                >
                  {(["signin", "signup"] as const).map((mode) => (
                    <button
                      key={mode}
                      onClick={() => {
                        setAuthMode(mode);
                        setAuthError("");
                      }}
                      style={{
                        flex: 1,
                        padding: "8px",
                        borderRadius: 7,
                        border: "none",
                        cursor: "pointer",
                        fontSize: 13,
                        fontWeight: 500,
                        transition: "all 0.15s",
                        background:
                          authMode === mode ? "var(--dark)" : "transparent",
                        color:
                          authMode === mode
                            ? "var(--text-on-dark)"
                            : "var(--text-on-dark-muted)",
                        boxShadow:
                          authMode === mode
                            ? "0 1px 4px rgba(0,0,0,0.4)"
                            : "none",
                      }}
                    >
                      {mode === "signin" ? "Sign in" : "Create account"}
                    </button>
                  ))}
                </div>

                {/* Form */}
                <form onSubmit={handleAuth}>
                  <div style={{ marginBottom: 10 }}>
                    <input
                      type="email"
                      value={authEmail}
                      onChange={(e) => setAuthEmail(e.target.value)}
                      placeholder="Email"
                      required
                      autoComplete="email"
                      style={{
                        width: "100%",
                        padding: "10px 12px",
                        background: "rgba(255,255,255,0.05)",
                        border: "1px solid rgba(255,255,255,0.1)",
                        borderRadius: 8,
                        color: "var(--text-on-dark)",
                        fontSize: 14,
                        outline: "none",
                        boxSizing: "border-box",
                      }}
                    />
                  </div>
                  <div style={{ marginBottom: authError ? 10 : 16 }}>
                    <input
                      type="password"
                      value={authPassword}
                      onChange={(e) => setAuthPassword(e.target.value)}
                      placeholder="Password"
                      required
                      minLength={8}
                      autoComplete={
                        authMode === "signup"
                          ? "new-password"
                          : "current-password"
                      }
                      style={{
                        width: "100%",
                        padding: "10px 12px",
                        background: "rgba(255,255,255,0.05)",
                        border: "1px solid rgba(255,255,255,0.1)",
                        borderRadius: 8,
                        color: "var(--text-on-dark)",
                        fontSize: 14,
                        outline: "none",
                        boxSizing: "border-box",
                      }}
                    />
                  </div>
                  {authError && (
                    <p
                      style={{
                        fontSize: 13,
                        color: "#ef4444",
                        marginBottom: 12,
                      }}
                    >
                      {authError}
                    </p>
                  )}
                  <button
                    type="submit"
                    disabled={authSubmitting}
                    style={{
                      width: "100%",
                      padding: "11px",
                      background: "var(--gold)",
                      color: "var(--dark)",
                      border: "none",
                      borderRadius: 100,
                      fontSize: 14,
                      fontWeight: 600,
                      cursor: authSubmitting ? "not-allowed" : "pointer",
                      opacity: authSubmitting ? 0.7 : 1,
                      transition: "opacity 0.2s",
                    }}
                  >
                    {authSubmitting
                      ? "…"
                      : authMode === "signin"
                        ? "Sign in"
                        : "Create account"}
                  </button>
                </form>
              </>
            )}
          </div>

          {/* Hint */}
          {!authSuccess && (
            <p
              style={{
                textAlign: "center",
                marginTop: 20,
                fontSize: 13,
                color: "var(--text-on-dark-muted)",
                fontWeight: 300,
                lineHeight: 1.6,
              }}
            >
              After signing in, you&apos;ll receive your extension access code
              and a download link to get started.
            </p>
          )}
        </div>

        {/* Footer */}
        <p
          style={{
            position: "absolute",
            bottom: 24,
            fontSize: 12,
            color: "rgba(255,255,255,0.2)",
          }}
        >
          &copy; 2026 Anticipation Labs
        </p>
      </div>
    );
  }

  // ── Engine UI (authenticated) ───────────────────────────────────────────────

  return (
    <div
      className="min-h-screen"
      style={{ background: "var(--dark)", color: "var(--text-on-dark)" }}
    >
      {/* Header */}
      <header
        className="sticky top-0 z-50 px-6 py-4"
        style={{
          background: "rgba(12,12,12,0.85)",
          backdropFilter: "blur(20px)",
          borderBottom: "1px solid rgba(255,255,255,0.06)",
        }}
      >
        <div className="max-w-container mx-auto flex items-center justify-between">
          <a href="/" className="font-serif text-[22px]">
            Anticipy
          </a>
          <div className="flex items-center gap-4">
            {!calendarConnected && (
              <a
                href="/api/auth/google"
                className="text-[12px] px-3 py-1.5 rounded-pill transition-all"
                style={{
                  background: "rgba(200,169,126,0.1)",
                  color: "var(--gold)",
                  border: "1px solid rgba(200,169,126,0.2)",
                }}
              >
                Connect Calendar
              </a>
            )}
            {calendarConnected && (
              <span
                className="text-[12px] flex items-center gap-1.5"
                style={{ color: "#4CAF50" }}
              >
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: "50%",
                    background: "#4CAF50",
                    display: "inline-block",
                  }}
                />
                Calendar linked
              </span>
            )}
            <span
              className="text-[12px]"
              style={{ color: "var(--text-on-dark-muted)" }}
            >
              {session.user.email}
            </span>
            <button
              onClick={handleSignOut}
              style={{
                background: "none",
                border: "none",
                color: "var(--text-on-dark-muted)",
                fontSize: 12,
                cursor: "pointer",
                padding: 0,
              }}
            >
              Sign out
            </button>
            <span
              className="text-[13px] font-light tracking-wide-label uppercase"
              style={{ color: "var(--gold)" }}
            >
              Engine
            </span>
          </div>
        </div>
      </header>

      {/* Setup card */}
      {!setupDismissed && (
        <div
          className="px-6 py-4"
          style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}
        >
          <div className="max-w-container mx-auto">
            <div
              className="rounded-card p-5"
              style={{
                background: "var(--dark-elevated)",
                border: "1px solid rgba(200,169,126,0.15)",
              }}
            >
              {/* Card header */}
              <div
                className="flex items-center justify-between"
                style={{ marginBottom: 20 }}
              >
                <div className="flex items-center gap-3">
                  <span
                    className="text-[11px] uppercase tracking-wide-label"
                    style={{ color: "var(--gold)" }}
                  >
                    Extension Setup
                  </span>
                  <span
                    className="text-[11px]"
                    style={{ color: "var(--text-on-dark-muted)" }}
                  >
                    · 3 steps · ~2 minutes
                  </span>
                </div>
                <button
                  onClick={() => setSetupDismissed(true)}
                  style={{
                    background: "none",
                    border: "none",
                    color: "var(--text-on-dark-muted)",
                    fontSize: 12,
                    cursor: "pointer",
                    padding: "2px 6px",
                  }}
                >
                  Dismiss
                </button>
              </div>

              {/* Steps */}
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
                  gap: 16,
                }}
              >
                {/* Step 1 */}
                <div
                  style={{
                    padding: "14px 16px",
                    borderRadius: 10,
                    background: "rgba(76,175,80,0.06)",
                    border: "1px solid rgba(76,175,80,0.15)",
                  }}
                >
                  <div
                    className="flex items-center gap-2"
                    style={{ marginBottom: 8 }}
                  >
                    <span
                      style={{
                        width: 20,
                        height: 20,
                        borderRadius: "50%",
                        background: "rgba(76,175,80,0.2)",
                        border: "1px solid rgba(76,175,80,0.4)",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontSize: 11,
                        color: "#4CAF50",
                        flexShrink: 0,
                      }}
                    >
                      ✓
                    </span>
                    <span
                      style={{
                        fontSize: 11,
                        color: "#4CAF50",
                        textTransform: "uppercase",
                        letterSpacing: "0.05em",
                      }}
                    >
                      Done
                    </span>
                  </div>
                  <p
                    style={{
                      fontSize: 13,
                      fontWeight: 500,
                      marginBottom: 3,
                    }}
                  >
                    Account created
                  </p>
                  <p
                    style={{
                      fontSize: 12,
                      color: "var(--text-on-dark-muted)",
                      fontWeight: 300,
                    }}
                  >
                    {session.user.email}
                  </p>
                </div>

                {/* Step 2 */}
                <div
                  style={{
                    padding: "14px 16px",
                    borderRadius: 10,
                    background: "rgba(200,169,126,0.05)",
                    border: "1px solid rgba(200,169,126,0.15)",
                  }}
                >
                  <div
                    className="flex items-center gap-2"
                    style={{ marginBottom: 8 }}
                  >
                    <span
                      style={{
                        width: 20,
                        height: 20,
                        borderRadius: "50%",
                        background: "rgba(200,169,126,0.15)",
                        border: "1px solid rgba(200,169,126,0.3)",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontSize: 11,
                        color: "var(--gold)",
                        flexShrink: 0,
                        fontWeight: 600,
                      }}
                    >
                      2
                    </span>
                    <span
                      style={{
                        fontSize: 11,
                        color: "var(--gold)",
                        textTransform: "uppercase",
                        letterSpacing: "0.05em",
                      }}
                    >
                      Download
                    </span>
                  </div>
                  <p
                    style={{
                      fontSize: 13,
                      fontWeight: 500,
                      marginBottom: 10,
                    }}
                  >
                    Get the Chrome extension
                  </p>
                  <div className="flex items-center gap-2">
                    <a
                      href="/anticipy-extension.zip"
                      download="anticipy-extension.zip"
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 6,
                        padding: "6px 12px",
                        background: "var(--gold)",
                        color: "var(--dark)",
                        borderRadius: 100,
                        fontSize: 12,
                        fontWeight: 600,
                        textDecoration: "none",
                      }}
                    >
                      <svg
                        width="11"
                        height="11"
                        viewBox="0 0 11 11"
                        fill="none"
                      >
                        <path
                          d="M5.5 1v6M2.5 5l3 3 3-3M1 10h9"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                      Download .zip
                    </a>
                    <a
                      href="/engine/extension"
                      style={{
                        fontSize: 12,
                        color: "var(--text-on-dark-muted)",
                        textDecoration: "none",
                      }}
                    >
                      Install guide →
                    </a>
                  </div>
                </div>

                {/* Step 3 */}
                <div
                  style={{
                    padding: "14px 16px",
                    borderRadius: 10,
                    background: "rgba(200,169,126,0.05)",
                    border: "1px solid rgba(200,169,126,0.15)",
                  }}
                >
                  <div
                    className="flex items-center gap-2"
                    style={{ marginBottom: 8 }}
                  >
                    <span
                      style={{
                        width: 20,
                        height: 20,
                        borderRadius: "50%",
                        background: "rgba(200,169,126,0.15)",
                        border: "1px solid rgba(200,169,126,0.3)",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontSize: 11,
                        color: "var(--gold)",
                        flexShrink: 0,
                        fontWeight: 600,
                      }}
                    >
                      3
                    </span>
                    <span
                      style={{
                        fontSize: 11,
                        color: "var(--gold)",
                        textTransform: "uppercase",
                        letterSpacing: "0.05em",
                      }}
                    >
                      Connect
                    </span>
                  </div>
                  <p
                    style={{
                      fontSize: 13,
                      fontWeight: 500,
                      marginBottom: 8,
                    }}
                  >
                    Your access code
                  </p>
                  {accessCode ? (
                    <div className="flex items-center gap-2">
                      <code
                        style={{
                          padding: "5px 10px",
                          background: "rgba(0,0,0,0.3)",
                          border: "1px solid rgba(255,255,255,0.1)",
                          borderRadius: 6,
                          fontSize: 13,
                          fontFamily: "monospace",
                          letterSpacing: "0.08em",
                          color: "var(--text-on-dark)",
                        }}
                      >
                        {accessCode}
                      </code>
                      <button
                        onClick={copyCode}
                        style={{
                          padding: "5px 10px",
                          background: codeCopied
                            ? "rgba(76,175,80,0.15)"
                            : "rgba(255,255,255,0.07)",
                          border: codeCopied
                            ? "1px solid rgba(76,175,80,0.3)"
                            : "1px solid rgba(255,255,255,0.1)",
                          borderRadius: 6,
                          fontSize: 12,
                          color: codeCopied ? "#4CAF50" : "var(--text-on-dark-muted)",
                          cursor: "pointer",
                          transition: "all 0.2s",
                          flexShrink: 0,
                        }}
                      >
                        {codeCopied ? "Copied!" : "Copy"}
                      </button>
                    </div>
                  ) : (
                    <p
                      style={{
                        fontSize: 12,
                        color: "var(--text-on-dark-muted)",
                      }}
                    >
                      Enter this code in the extension popup after installing.
                    </p>
                  )}
                  <p
                    style={{
                      fontSize: 11,
                      color: "var(--text-on-dark-muted)",
                      marginTop: 8,
                      fontWeight: 300,
                    }}
                  >
                    Enter in the extension popup to activate the agent.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      <main className="max-w-container mx-auto px-6 py-12">
        {/* Record section */}
        <div className="text-center mb-16">
          <h1
            className="font-serif text-section tracking-tight-section mb-4"
            style={{ color: "var(--text-on-dark)" }}
          >
            {state === "idle" && "Start a conversation."}
            {state === "recording" && "Listening..."}
            {(state === "processing" || state === "transcribing") &&
              "Transcribing..."}
            {state === "analyzing" && "Finding actions..."}
            {state === "done" && "Done."}
            {state === "error" && "Something went wrong."}
          </h1>
          <p
            className="text-[15px] font-light max-w-md mx-auto mb-10"
            style={{ color: "var(--text-on-dark-muted)" }}
          >
            {state === "idle" &&
              "Press record and have a real conversation. Anticipy listens and figures out what to do."}
            {state === "recording" && `Recording — ${formatDuration(duration)}`}
            {state === "transcribing" &&
              "Processing your audio with speaker diarization..."}
            {state === "analyzing" &&
              "Analyzing your conversation for actionable moments..."}
            {state === "done" &&
              `${intents.length} action${intents.length !== 1 ? "s" : ""} found. Notifications sent.`}
          </p>

          {/* Record button */}
          {(state === "idle" || state === "recording") && (
            <button
              onClick={state === "idle" ? startRecording : stopRecording}
              className="relative mx-auto block transition-all duration-300"
              style={{
                width: 120,
                height: 120,
                borderRadius: "50%",
                background:
                  state === "recording"
                    ? "rgba(239,68,68,0.15)"
                    : "rgba(200,169,126,0.1)",
                border: `2px solid ${state === "recording" ? "rgba(239,68,68,0.4)" : "var(--gold)"}`,
                cursor: "pointer",
              }}
            >
              <div
                className="absolute inset-0 rounded-full transition-all duration-300"
                style={{
                  background:
                    state === "recording"
                      ? `rgba(239,68,68,${0.05 + audioLevel * 0.2})`
                      : "transparent",
                  transform: `scale(${1 + audioLevel * 0.15})`,
                }}
              />
              <div className="absolute inset-0 flex items-center justify-center">
                {state === "recording" ? (
                  <div
                    style={{
                      width: 32,
                      height: 32,
                      borderRadius: 6,
                      background: "#ef4444",
                    }}
                  />
                ) : (
                  <div
                    style={{
                      width: 40,
                      height: 40,
                      borderRadius: "50%",
                      background: "var(--gold)",
                    }}
                  />
                )}
              </div>
            </button>
          )}

          {/* Processing spinner */}
          {(state === "processing" ||
            state === "transcribing" ||
            state === "analyzing") && (
            <div className="flex justify-center">
              <div
                className="animate-spin"
                style={{
                  width: 48,
                  height: 48,
                  borderRadius: "50%",
                  border: "3px solid var(--dark-border)",
                  borderTopColor: "var(--gold)",
                }}
              />
            </div>
          )}

          {/* Done / Error */}
          {(state === "done" || state === "error") && (
            <button
              onClick={reset}
              className="px-8 py-3 rounded-pill text-[15px] font-medium transition-all"
              style={{ background: "var(--gold)", color: "var(--dark)" }}
            >
              New Recording
            </button>
          )}

          {error && (
            <p className="mt-4 text-[14px]" style={{ color: "#f87171" }}>
              {error}
            </p>
          )}
        </div>

        {/* Live transcript during recording */}
        {state === "recording" && (segments.length > 0 || liveText) && (
          <div className="max-w-2xl mx-auto mb-8">
            <h2
              className="text-[13px] font-light tracking-wide-label uppercase mb-4"
              style={{ color: "var(--text-on-dark-muted)" }}
            >
              Live Transcript
            </h2>
            <div
              className="rounded-card p-6 space-y-3 max-h-[300px] overflow-y-auto"
              style={{
                background: "var(--dark-elevated)",
                border: "1px solid var(--dark-border)",
              }}
            >
              {segments.map((seg, i) => (
                <div key={i}>
                  <span
                    className="text-[12px] font-medium mr-2"
                    style={{
                      color: SPEAKER_COLORS[seg.speaker_id % SPEAKER_COLORS.length],
                    }}
                  >
                    Speaker {seg.speaker_id}
                  </span>
                  <span className="text-[15px] font-light">{seg.text}</span>
                </div>
              ))}
              {liveText && (
                <div style={{ opacity: 0.5 }}>
                  <span className="text-[15px] font-light italic">{liveText}</span>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Manual transcript */}
        {state === "idle" && (
          <div className="max-w-2xl mx-auto mb-16">
            <div
              className="rounded-card p-6"
              style={{
                background: "var(--dark-elevated)",
                border: "1px solid var(--dark-border)",
              }}
            >
              <p
                className="text-[13px] font-light mb-3 tracking-wide-label uppercase"
                style={{ color: "var(--text-on-dark-muted)" }}
              >
                Or paste a transcript
              </p>
              <textarea
                value={manualTranscript}
                onChange={(e) => setManualTranscript(e.target.value)}
                placeholder={`[Speaker 0]: Hey, want to grab lunch Tuesday?\n[Speaker 1]: Yeah noon works. Sushi place sound good?\n[Speaker 0]: Perfect, let's do it.`}
                rows={6}
                className="w-full bg-transparent text-[15px] font-light resize-none outline-none"
                style={{ color: "var(--text-on-dark)", border: "none" }}
              />
              {manualTranscript.trim() && (
                <button
                  onClick={analyzeManualTranscript}
                  className="mt-4 px-6 py-2.5 rounded-pill text-[14px] font-medium"
                  style={{ background: "var(--gold)", color: "var(--dark)" }}
                >
                  Analyze Conversation
                </button>
              )}
            </div>
          </div>
        )}

        {/* Results */}
        {state !== "recording" &&
          (segments.length > 0 || intents.length > 0) && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 max-w-5xl mx-auto">
              {segments.length > 0 && (
                <div>
                  <h2
                    className="text-[13px] font-light tracking-wide-label uppercase mb-4"
                    style={{ color: "var(--text-on-dark-muted)" }}
                  >
                    Transcript
                  </h2>
                  <div
                    className="rounded-card p-6 space-y-3 max-h-[500px] overflow-y-auto"
                    style={{
                      background: "var(--dark-elevated)",
                      border: "1px solid var(--dark-border)",
                    }}
                  >
                    {segments.map((seg, i) => (
                      <div key={i}>
                        <span
                          className="text-[12px] font-medium mr-2"
                          style={{
                            color:
                              SPEAKER_COLORS[
                                seg.speaker_id % SPEAKER_COLORS.length
                              ],
                          }}
                        >
                          Speaker {seg.speaker_id}
                        </span>
                        <span className="text-[15px] font-light">
                          {seg.text}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {intents.length > 0 && (
                <div>
                  <h2
                    className="text-[13px] font-light tracking-wide-label uppercase mb-4"
                    style={{ color: "var(--text-on-dark-muted)" }}
                  >
                    Actions
                  </h2>
                  <div className="space-y-4">
                    {intents.map((intent) => {
                      const style =
                        IMPORTANCE_STYLES[intent.importance] ??
                        IMPORTANCE_STYLES.low;
                      return (
                        <div
                          key={intent.id}
                          className="rounded-card p-5"
                          style={{
                            background: style.bg,
                            border: `1px solid ${style.border}`,
                          }}
                        >
                          <div className="flex items-start justify-between mb-2">
                            <span
                              className="text-[11px] uppercase tracking-wide-label px-2 py-0.5 rounded-pill"
                              style={{
                                background: style.border,
                                color: "var(--text-on-dark)",
                              }}
                            >
                              {style.label}
                            </span>
                            <span
                              className="text-[12px]"
                              style={{ color: "var(--text-on-dark-muted)" }}
                            >
                              {Math.round(intent.confidence * 100)}%
                            </span>
                          </div>
                          <p className="text-[15px] font-medium mb-2">
                            {intent.summary_for_user}
                          </p>
                          <p
                            className="text-[13px] font-light italic"
                            style={{ color: "var(--text-on-dark-muted)" }}
                          >
                            &ldquo;{intent.evidence_quote}&rdquo;
                          </p>
                          <div className="mt-3 flex items-center gap-2">
                            <span
                              className="text-[12px] px-3 py-1 rounded-pill"
                              style={{
                                background: "rgba(200,169,126,0.1)",
                                color: "var(--gold)",
                                border: "1px solid rgba(200,169,126,0.2)",
                              }}
                            >
                              {intent.action_type.replace("_", " ")}
                            </span>
                            <span
                              className="text-[12px]"
                              style={{ color: "var(--text-on-dark-muted)" }}
                            >
                              Notification sent
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}

        {state === "done" && intents.length === 0 && segments.length > 0 && (
          <div className="text-center max-w-md mx-auto">
            <p
              className="text-[15px] font-light"
              style={{ color: "var(--text-on-dark-muted)" }}
            >
              No actionable moments found in this conversation. Try discussing
              plans, scheduling, or tasks.
            </p>
          </div>
        )}
      </main>

      {/* Footer */}
      <footer
        className="px-6 py-8 mt-20"
        style={{ borderTop: "1px solid var(--dark-border)" }}
      >
        <div className="max-w-container mx-auto flex items-center justify-between">
          <p className="text-[13px]" style={{ color: "var(--text-on-dark-muted)" }}>
            &copy; 2026 Anticipation Labs.
          </p>
          <div className="flex items-center gap-4">
            <a
              href="/engine/extension"
              className="text-[13px]"
              style={{ color: "var(--text-on-dark-muted)", textDecoration: "none" }}
            >
              Extension guide
            </a>
            <a
              href="/anticipy-extension.zip"
              download
              className="text-[13px]"
              style={{ color: "var(--gold)", textDecoration: "none" }}
            >
              Download extension
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
