import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * POST /api/extension/auth
 *
 * Authenticates the Chrome extension with a shared access code and returns
 * the LLM API keys the extension needs to run the browser agent.
 *
 * Body: { code: string }
 * Returns: { groqApiKey: string, geminiApiKey: string }
 *
 * The access code is stored in the EXTENSION_ACCESS_CODE env var.
 * The API keys are returned from GROQ_API_KEY / GOOGLE_API_KEY env vars —
 * they are never hardcoded in the extension source.
 */
export async function POST(req: Request) {
  // CORS headers — Chrome extensions use their extension ID as origin,
  // which is allowed by the browser for host_permissions matches.
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  let body: { code?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400, headers: corsHeaders });
  }

  const { code } = body;
  if (!code || typeof code !== "string") {
    return NextResponse.json({ error: "Missing access code" }, { status: 400, headers: corsHeaders });
  }

  const validCode = process.env.EXTENSION_ACCESS_CODE;
  if (!validCode) {
    console.error("[extension/auth] EXTENSION_ACCESS_CODE env var is not set");
    return NextResponse.json({ error: "Server misconfigured" }, { status: 500, headers: corsHeaders });
  }

  // Constant-time comparison to prevent timing attacks
  if (!timingSafeEqual(code.trim(), validCode.trim())) {
    return NextResponse.json({ error: "Invalid access code" }, { status: 401, headers: corsHeaders });
  }

  const groqApiKey = process.env.GROQ_API_KEY || null;
  const geminiApiKey = process.env.GOOGLE_API_KEY || null;

  if (!groqApiKey && !geminiApiKey) {
    console.error("[extension/auth] Neither GROQ_API_KEY nor GOOGLE_API_KEY is set");
    return NextResponse.json({ error: "No LLM API keys configured on server" }, { status: 500, headers: corsHeaders });
  }

  return NextResponse.json({ groqApiKey, geminiApiKey }, { headers: corsHeaders });
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}

/**
 * XOR-based constant-time string comparison so timing attacks can't
 * determine how many characters matched.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    // Still iterate to prevent length leakage
    let diff = 0;
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
    }
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
