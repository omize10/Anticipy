"use client";

import { useState, useRef, useCallback, useEffect } from "react";

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

const SPEAKER_COLORS = [
  "#C8A97E", // gold - Speaker 0 (user)
  "#7C9CBF", // blue
  "#9B8EC4", // purple
  "#7EBF8A", // green
  "#BF7E7E", // red
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

export default function EnginePage() {
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

  // Check if Google Calendar is connected
  useEffect(() => {
    fetch("/api/auth/google/status")
      .then((r) => r.json())
      .then((d) => setCalendarConnected(d.connected))
      .catch(() => {});
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
      }
      if (dgSocketRef.current) {
        dgSocketRef.current.close();
      }
      if (audioCtxRef.current) {
        audioCtxRef.current.close();
      }
    };
  }, []);

  const startRecording = useCallback(async () => {
    try {
      setError("");
      setSegments([]);
      setIntents([]);
      setDuration(0);
      setLiveText("");
      liveSegmentsRef.current = [];

      // Create session
      const sessionRes = await fetch("/api/engine/session", {
        method: "POST",
      });
      const sessionData = await sessionRes.json();
      if (!sessionRes.ok) throw new Error(sessionData.error);
      sessionIdRef.current = sessionData.sessionId;

      // Get temporary Deepgram key for browser-side streaming
      const keyRes = await fetch("/api/engine/deepgram-key");
      const keyData = await keyRes.json();

      if (!keyRes.ok) {
        throw new Error(keyData.error || "Failed to get Deepgram key");
      }

      // Get microphone
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          sampleRate: 16000,
        },
      });
      streamRef.current = stream;

      // Audio level visualization
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
        const avg =
          dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
        setAudioLevel(avg / 128);
        animFrameRef.current = requestAnimationFrame(updateLevel);
      };
      updateLevel();

      // Connect to Deepgram WebSocket for real-time streaming
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
        // Stream audio via ScriptProcessorNode (converts to linear16)
        const processor = audioCtx.createScriptProcessor(4096, 1, 1);
        processorRef.current = processor;
        source.connect(processor);
        processor.connect(audioCtx.destination);

        processor.onaudioprocess = (e) => {
          if (dgWs.readyState !== WebSocket.OPEN) return;
          const inputData = e.inputBuffer.getChannelData(0);
          // Convert float32 to int16
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
              // Process final words with speaker info
              const words = alt.words || [];
              if (words.length > 0) {
                // Group consecutive words by speaker
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
              // Interim result — show as live preview
              setLiveText(transcript);
            }
          }
        } catch {
          // Ignore parse errors
        }
      };

      dgWs.onerror = (e) => {
        console.error("Deepgram WebSocket error:", e);
      };

      // Also keep MediaRecorder for fallback/backup audio
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

      // Duration timer
      const startTime = Date.now();
      timerRef.current = setInterval(() => {
        setDuration(Math.floor((Date.now() - startTime) / 1000));
      }, 1000);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to start recording";
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

    // Close Deepgram WebSocket
    if (dgSocketRef.current && dgSocketRef.current.readyState === WebSocket.OPEN) {
      // Send close frame to get final results
      dgSocketRef.current.send(JSON.stringify({ type: "CloseStream" }));
      // Wait a moment for final results
      await new Promise((r) => setTimeout(r, 1000));
      dgSocketRef.current.close();
    }

    // Stop ScriptProcessor
    if (processorRef.current) {
      processorRef.current.disconnect();
    }

    // Stop recorder
    const recorder = mediaRecorderRef.current;
    await new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
      recorder.stop();
    });

    // Stop mic
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
    }

    // Close AudioContext
    if (audioCtxRef.current) {
      audioCtxRef.current.close();
    }

    const finalSegments = liveSegmentsRef.current;

    if (finalSegments.length === 0) {
      // Fall back to batch transcription if streaming produced nothing
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

    // Store streaming segments to Supabase
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
      body: JSON.stringify({
        sessionId: sessionIdRef.current,
        segments: rows,
      }),
    }).catch(() => {}); // Non-critical storage

    // Build transcript string and analyze
    const transcriptStr = finalSegments
      .map((s) => `[Speaker ${s.speaker_id}]: ${s.text}`)
      .join("\n");

    await analyzeTranscript(transcriptStr);
  }, []);

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

      if (!analyzeRes.ok)
        throw new Error(analyzeData.error || "Analysis failed");

      setIntents(analyzeData.intents ?? []);
      setState("done");
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Analysis failed";
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
      // Create session
      const sessionRes = await fetch("/api/engine/session", {
        method: "POST",
      });
      const sessionData = await sessionRes.json();
      if (!sessionRes.ok) throw new Error(sessionData.error);
      sessionIdRef.current = sessionData.sessionId;

      // Parse the manual transcript into segments for display
      const lines = manualTranscript.trim().split("\n");
      const parsedSegments: TranscriptSegment[] = [];
      let time = 0;
      for (const line of lines) {
        const match = line.match(
          /^\[?(?:Speaker\s*)?(\d+)\]?:\s*(.+)/i
        );
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
      const message =
        err instanceof Error ? err.message : "Analysis failed";
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
              className="text-[13px] font-light tracking-wide-label uppercase"
              style={{ color: "var(--gold)" }}
            >
              Engine
            </span>
          </div>
        </div>
      </header>

      <main className="max-w-container mx-auto px-6 py-12">
        {/* Record Section */}
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
            {state === "recording" &&
              `Recording — ${formatDuration(duration)}`}
            {state === "transcribing" &&
              "Processing your audio with speaker diarization..."}
            {state === "analyzing" &&
              "Analyzing your conversation for actionable moments..."}
            {state === "done" &&
              `${intents.length} action${intents.length !== 1 ? "s" : ""} found. Notifications sent.`}
          </p>

          {/* Record Button */}
          {(state === "idle" || state === "recording") && (
            <button
              onClick={
                state === "idle" ? startRecording : stopRecording
              }
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
              <div
                className="absolute inset-0 flex items-center justify-center"
              >
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

          {/* Done / Error actions */}
          {(state === "done" || state === "error") && (
            <button
              onClick={reset}
              className="px-8 py-3 rounded-pill text-[15px] font-medium transition-all"
              style={{
                background: "var(--gold)",
                color: "var(--dark)",
              }}
            >
              New Recording
            </button>
          )}

          {error && (
            <p
              className="mt-4 text-[14px]"
              style={{ color: "#f87171" }}
            >
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
                      color:
                        SPEAKER_COLORS[seg.speaker_id % SPEAKER_COLORS.length],
                    }}
                  >
                    Speaker {seg.speaker_id}
                  </span>
                  <span className="text-[15px] font-light">{seg.text}</span>
                </div>
              ))}
              {liveText && (
                <div style={{ opacity: 0.5 }}>
                  <span className="text-[15px] font-light italic">
                    {liveText}
                  </span>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Manual transcript input (fallback) */}
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
                style={{
                  color: "var(--text-on-dark)",
                  border: "none",
                }}
              />
              {manualTranscript.trim() && (
                <button
                  onClick={analyzeManualTranscript}
                  className="mt-4 px-6 py-2.5 rounded-pill text-[14px] font-medium"
                  style={{
                    background: "var(--gold)",
                    color: "var(--dark)",
                  }}
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
              {/* Transcript */}
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

              {/* Actions */}
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
                              style={{
                                color: "var(--text-on-dark-muted)",
                              }}
                            >
                              {Math.round(intent.confidence * 100)}%
                            </span>
                          </div>
                          <p className="text-[15px] font-medium mb-2">
                            {intent.summary_for_user}
                          </p>
                          <p
                            className="text-[13px] font-light italic"
                            style={{
                              color: "var(--text-on-dark-muted)",
                            }}
                          >
                            &ldquo;{intent.evidence_quote}&rdquo;
                          </p>
                          <div className="mt-3 flex items-center gap-2">
                            <span
                              className="text-[12px] px-3 py-1 rounded-pill"
                              style={{
                                background: "rgba(200,169,126,0.1)",
                                color: "var(--gold)",
                                border:
                                  "1px solid rgba(200,169,126,0.2)",
                              }}
                            >
                              {intent.action_type.replace("_", " ")}
                            </span>
                            <span
                              className="text-[12px]"
                              style={{
                                color: "var(--text-on-dark-muted)",
                              }}
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

        {/* Empty state for done with no intents */}
        {state === "done" && intents.length === 0 && segments.length > 0 && (
          <div className="text-center max-w-md mx-auto">
            <p
              className="text-[15px] font-light"
              style={{ color: "var(--text-on-dark-muted)" }}
            >
              No actionable moments found in this conversation. Try
              discussing plans, scheduling, or tasks.
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
          <p
            className="text-[13px]"
            style={{ color: "var(--text-on-dark-muted)" }}
          >
            &copy; 2026 Anticipation Labs.
          </p>
          <p
            className="text-[13px]"
            style={{ color: "var(--text-on-dark-muted)" }}
          >
            omar@anticipy.ai
          </p>
        </div>
      </footer>
    </div>
  );
}
