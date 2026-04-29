import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { requireSupabaseUser } from "@/lib/require-auth";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const user = await requireSupabaseUser(req);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await supabaseAdmin
    .from("anticipy_sessions")
    .insert({ status: "recording" })
    .select("id")
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ sessionId: data.id });
}

export async function PATCH(req: Request) {
  const user = await requireSupabaseUser(req);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { sessionId, status, totalAudioSeconds } = await req.json();

  const update: Record<string, unknown> = {};
  if (status) update.status = status;
  if (totalAudioSeconds != null) update.total_audio_seconds = totalAudioSeconds;
  if (status === "ended") update.ended_at = new Date().toISOString();

  const { error } = await supabaseAdmin
    .from("anticipy_sessions")
    .update(update)
    .eq("id", sessionId);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
