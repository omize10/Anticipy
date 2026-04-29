import { NextResponse } from "next/server";
import { requireSupabaseUser } from "@/lib/require-auth";

export const dynamic = "force-dynamic";

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
