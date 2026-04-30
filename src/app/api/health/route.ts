import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/health
 *
 * Lightweight liveness probe. Returns the configured-or-not state of the
 * environment variables this app depends on so that an uptime monitor (or
 * a deploy smoke-test) can quickly distinguish "container is up" from
 * "container is up but mis-configured."
 *
 * Never returns secret values — only booleans for whether each var is set.
 */
export async function GET() {
  const env = {
    supabase: Boolean(
      process.env.NEXT_PUBLIC_SUPABASE_URL &&
        process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    ),
    supabaseAdmin: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
    deepgram: Boolean(process.env.DEEPGRAM_API_KEY),
    gemini: Boolean(process.env.GOOGLE_API_KEY),
    groq: Boolean(process.env.GROQ_API_KEY),
    resend: Boolean(process.env.RESEND_API_KEY),
  };

  const ok = env.supabase && env.supabaseAdmin && env.deepgram && (env.gemini || env.groq);

  return NextResponse.json(
    {
      ok,
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      env,
    },
    { status: ok ? 200 : 503 }
  );
}
