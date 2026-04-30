import { NextResponse } from "next/server";
import { requireSupabaseUser } from "@/lib/require-auth";

export const dynamic = "force-dynamic";

// SECURITY: this endpoint is now auth-gated, but the previous DEEPGRAM_API_KEY
// was reachable without auth before lockdown — rotate it manually in the
// Deepgram dashboard (https://console.deepgram.com/) and update the value in
// Vercel env vars. Rotation must happen before this commit goes live.
// For production we should also move to short-lived tokens via /v1/auth/grant.
export async function GET(req: Request) {
  const user = await requireSupabaseUser(req);
  if (!user) {
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401 }
    );
  }

  // For prototype: return the API key directly for browser-side WebSocket streaming.
  // In production, use Deepgram's /v1/auth/grant to create short-lived tokens.
  const key = process.env.DEEPGRAM_API_KEY;

  if (!key) {
    return NextResponse.json({ error: "Deepgram key not configured" }, { status: 500 });
  }

  return NextResponse.json({
    key,
    expiresAt: Date.now() + 300_000,
  });
}
