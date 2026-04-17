import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

/**
 * POST /api/extension/auth
 *
 * Authenticates the Chrome extension with a per-user access code
 * and returns the LLM API keys the extension needs.
 *
 * Body: { code: string }
 * Returns: { groqApiKey: string, geminiApiKey: string }
 *
 * Validates the code against engine_users.access_code in Supabase.
 * Each user has a unique code generated at signup.
 */
export async function POST(req: Request) {
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

  const trimmedCode = code.trim();

  // Look up the code in engine_users table
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? ""
  );

  const { data: user, error } = await supabase
    .from("engine_users")
    .select("id, username")
    .eq("access_code", trimmedCode)
    .single();

  if (error || !user) {
    return NextResponse.json({ error: "Invalid access code" }, { status: 401, headers: corsHeaders });
  }

  const groqApiKey = process.env.GROQ_API_KEY || null;
  const geminiApiKey = process.env.GOOGLE_API_KEY || null;

  if (!groqApiKey && !geminiApiKey) {
    console.error("[extension/auth] Neither GROQ_API_KEY nor GOOGLE_API_KEY is set");
    return NextResponse.json({ error: "No LLM API keys configured on server" }, { status: 500, headers: corsHeaders });
  }

  return NextResponse.json(
    { groqApiKey, geminiApiKey, userId: user.id, username: user.username },
    { headers: corsHeaders }
  );
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
