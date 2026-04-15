import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

/**
 * GET /api/extension/access-code
 *
 * Returns the extension access code to authenticated users.
 * Requires a valid Supabase JWT in the Authorization header.
 *
 * Headers: { Authorization: "Bearer <supabase_access_token>" }
 * Returns: { code: string }
 */
export async function GET(req: Request) {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };

  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return NextResponse.json(
      { error: "Missing or invalid Authorization header" },
      { status: 401, headers: corsHeaders }
    );
  }

  const token = authHeader.slice(7);

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const {
    data: { user },
    error,
  } = await supabase.auth.getUser(token);

  if (error || !user) {
    return NextResponse.json(
      { error: "Invalid or expired session" },
      { status: 401, headers: corsHeaders }
    );
  }

  const code = process.env.EXTENSION_ACCESS_CODE;
  if (!code) {
    console.error("[extension/access-code] EXTENSION_ACCESS_CODE is not set");
    return NextResponse.json(
      { error: "Access code not configured" },
      { status: 500, headers: corsHeaders }
    );
  }

  return NextResponse.json({ code }, { headers: corsHeaders });
}

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });
}
