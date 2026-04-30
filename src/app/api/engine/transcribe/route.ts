import { NextResponse } from "next/server";
import { transcribeAudio } from "@/lib/deepgram";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { requireSupabaseUser } from "@/lib/require-auth";

export const dynamic = "force-dynamic";

// Cap a single batch upload at ~50 MB. At 16 kHz mono opus that's roughly
// 70 minutes — well past any normal recording. Keeps a malicious or buggy
// client from ballooning the function memory budget.
const MAX_AUDIO_BYTES = 50 * 1024 * 1024;
// Cap the number of segments stored from the JSON path so a misbehaving
// client can't insert millions of rows in a single request.
const MAX_SEGMENTS_PER_REQUEST = 10_000;

async function userOwnsSession(sessionId: string, userId: string): Promise<boolean> {
  const { data } = await supabaseAdmin
    .from("anticipy_sessions")
    .select("id")
    .eq("id", sessionId)
    .eq("user_id", userId)
    .maybeSingle();
  return !!data;
}

export async function POST(req: Request) {
  const user = await requireSupabaseUser(req);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const contentType = req.headers.get("content-type") || "";

    // JSON path: store pre-transcribed segments from streaming
    if (contentType.includes("application/json")) {
      const { sessionId, segments } = await req.json();
      if (!sessionId || typeof sessionId !== "string") {
        return NextResponse.json({ error: "Missing sessionId" }, { status: 400 });
      }
      if (!Array.isArray(segments) || segments.length === 0) {
        return NextResponse.json({ ok: true });
      }
      if (segments.length > MAX_SEGMENTS_PER_REQUEST) {
        return NextResponse.json(
          { error: "Too many segments in a single request." },
          { status: 413 }
        );
      }

      // Without this check any authenticated user could write transcript
      // segments into another user's session by guessing the UUID.
      if (!(await userOwnsSession(sessionId, user.id))) {
        return NextResponse.json({ error: "Session not found." }, { status: 404 });
      }

      const { error: insertError } = await supabaseAdmin
        .from("anticipy_transcripts")
        .insert(segments.map((s: Record<string, unknown>) => ({
          session_id: sessionId,
          speaker_id: s.speaker_id ?? 0,
          start_time: s.start_time ?? 0,
          end_time: s.end_time ?? 0,
          text: typeof s.text === "string" ? s.text.slice(0, 5000) : "",
          is_final: true,
        })));

      if (insertError) {
        console.error("Supabase insert error:", insertError);
      }

      return NextResponse.json({ ok: true, stored: segments.length });
    }

    // FormData path: upload audio for batch transcription
    const formData = await req.formData();
    const audioFile = formData.get("audio") as File | null;
    const sessionId = formData.get("sessionId") as string | null;

    if (!audioFile) {
      return NextResponse.json({ error: "No audio file" }, { status: 400 });
    }
    if (!sessionId) {
      return NextResponse.json({ error: "No sessionId" }, { status: 400 });
    }
    if (!(await userOwnsSession(sessionId, user.id))) {
      return NextResponse.json({ error: "Session not found." }, { status: 404 });
    }
    if (audioFile.size > MAX_AUDIO_BYTES) {
      return NextResponse.json(
        {
          error:
            "Audio too large. Please record a shorter clip — max 50 MB per upload.",
        },
        { status: 413 }
      );
    }

    const buffer = Buffer.from(await audioFile.arrayBuffer());
    const mimetype = audioFile.type || "audio/webm";

    // Transcribe with Deepgram Nova-3 + diarization
    const segments = await transcribeAudio(buffer, mimetype);

    if (segments.length === 0) {
      return NextResponse.json({
        segments: [],
        message: "No speech detected",
      });
    }

    // Store segments in Supabase
    const rows = segments.map((s) => ({
      session_id: sessionId,
      speaker_id: s.speaker_id,
      start_time: s.start_time,
      end_time: s.end_time,
      text: s.text,
      is_final: true,
    }));

    const { error: insertError } = await supabaseAdmin
      .from("anticipy_transcripts")
      .insert(rows);

    if (insertError) {
      console.error("Supabase insert error:", insertError);
    }

    // Update session with audio duration
    const totalSeconds = segments[segments.length - 1].end_time;
    const costCents = totalSeconds * (0.0077 / 60) * 100; // Deepgram cost

    await supabaseAdmin
      .from("anticipy_sessions")
      .update({
        status: "processing",
        total_audio_seconds: totalSeconds,
        total_cost_cents: costCents,
      })
      .eq("id", sessionId);

    // Format transcript for display
    const formattedTranscript = segments
      .map((s) => `[Speaker ${s.speaker_id}]: ${s.text}`)
      .join("\n");

    return NextResponse.json({
      segments,
      transcript: formattedTranscript,
      audioSeconds: totalSeconds,
    });
  } catch (err) {
    console.error("Transcribe error:", err);
    return NextResponse.json(
      { error: "Transcription failed. Please try again." },
      { status: 500 }
    );
  }
}
