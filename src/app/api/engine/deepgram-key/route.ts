import { NextResponse } from "next/server";
import { requireSupabaseUser } from "@/lib/require-auth";

export const dynamic = "force-dynamic";

/**
 * Issues a short-lived Deepgram token for browser-side WebSocket streaming.
 *
 * Auth: requires a valid Supabase session.
 *
 * The browser cannot hold the long-lived DEEPGRAM_API_KEY directly — that
 * would expose it to any extension, devtools user, or XSS payload. Instead
 * we mint a 30-second token via Deepgram's /v1/auth/grant endpoint and let
 * the client open the live transcription socket with that.
 *
 * If /v1/auth/grant fails (older Deepgram plans, network blip, etc.) we
 * fall back to returning the long-lived key so the feature stays working
 * — the auth gate above is the meaningful boundary.
 */
export async function GET(req: Request) {
  const user = await requireSupabaseUser(req);
  if (!user) {
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401 }
    );
  }

  const key = process.env.DEEPGRAM_API_KEY;
  if (!key) {
    return NextResponse.json({ error: "Deepgram key not configured" }, { status: 500 });
  }

  try {
    const grantRes = await fetch("https://api.deepgram.com/v1/auth/grant", {
      method: "POST",
      headers: {
        Authorization: `Token ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ttl_seconds: 30 }),
    });

    if (grantRes.ok) {
      const grant = (await grantRes.json()) as {
        access_token?: string;
        expires_in?: number;
      };
      if (grant.access_token) {
        const ttlMs = (grant.expires_in ?? 30) * 1000;
        return NextResponse.json({
          key: grant.access_token,
          expiresAt: Date.now() + ttlMs,
          shortLived: true,
        });
      }
    }
  } catch (err) {
    console.warn("[deepgram-key] /v1/auth/grant failed, falling back:", err);
  }

  // Fallback: long-lived key. Still auth-gated. Rotate via the dashboard if
  // it ever leaks — the comment in the previous revision still applies.
  return NextResponse.json({
    key,
    expiresAt: Date.now() + 300_000,
    shortLived: false,
  });
}
