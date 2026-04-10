import { NextResponse } from "next/server";
import { transcribeAudio } from "@/lib/deepgram";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const contentType = req.headers.get("content-type") || "";

    // JSON path: store pre-transcribed segments from streaming
    if (contentType.includes("application/json")) {
      const { sessionId, segments } = await req.json();
      if (!sessionId || !segments?.length) {
        return NextResponse.json({ ok: true });
      }

      const { error: insertError } = await supabaseAdmin
        .from("anticipy_transcripts")
        .insert(segments.map((s: Record<string, unknown>) => ({
          session_id: sessionId,
          speaker_id: s.speaker_id ?? 0,
          start_time: s.start_time ?? 0,
          end_time: s.end_time ?? 0,
          text: s.text ?? "",
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
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
