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
    .insert({
      status: "recording",
      user_id: user.id,
      user_email: user.email ?? null,
    })
    .select("id")
    .single();

  if (error || !data) {
    console.error("Session POST error:", error);
    return NextResponse.json(
      { error: "Could not start session." },
      { status: 500 }
    );
  }

  return NextResponse.json({ sessionId: data.id });
}

export async function PATCH(req: Request) {
  const user = await requireSupabaseUser(req);
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const sessionId = typeof body.sessionId === "string" ? body.sessionId : null;
  const status = typeof body.status === "string" ? body.status : null;
  const totalAudioSeconds =
    typeof body.totalAudioSeconds === "number" ? body.totalAudioSeconds : null;

  if (!sessionId) {
    return NextResponse.json({ error: "Missing sessionId" }, { status: 400 });
  }

  const update: Record<string, unknown> = {};
  if (status) update.status = status;
  if (totalAudioSeconds != null) update.total_audio_seconds = totalAudioSeconds;
  if (status === "ended") update.ended_at = new Date().toISOString();

  // Scope the update to rows owned by the caller — without this, any
  // authenticated user could mutate any session by guessing its UUID.
  const { data: updated, error } = await supabaseAdmin
    .from("anticipy_sessions")
    .update(update)
    .eq("id", sessionId)
    .eq("user_id", user.id)
    .select("id");

  if (error) {
    console.error("Session PATCH error:", error);
    return NextResponse.json(
      { error: "Could not update session." },
      { status: 500 }
    );
  }

  if (!updated || updated.length === 0) {
    return NextResponse.json(
      { error: "Session not found or not yours." },
      { status: 404 }
    );
  }

  return NextResponse.json({ ok: true });
}
