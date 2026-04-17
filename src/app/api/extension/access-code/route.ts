import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

/**
 * GET /api/extension/access-code
 *
 * Returns the user's unique access code from engine_users table.
 * Requires a valid engine JWT in the Authorization header.
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
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? ""
  );

  // Try to decode as engine JWT first (has user_id claim)
  try {
    const payload = JSON.parse(atob(token.split(".")[1]));
    if (payload.user_id) {
      const { data: user } = await supabase
        .from("engine_users")
        .select("access_code")
        .eq("id", payload.user_id)
        .single();

      if (user?.access_code) {
        return NextResponse.json({ code: user.access_code }, { headers: corsHeaders });
      }
    }
  } catch {
    // Not an engine JWT, try Supabase auth below
  }

  // Fallback: Supabase auth token → look up by email
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) {
    return NextResponse.json(
      { error: "Invalid or expired session" },
      { status: 401, headers: corsHeaders }
    );
  }

  const { data: engineUser } = await supabase
    .from("engine_users")
    .select("access_code")
    .eq("email", user.email)
    .single();

  if (engineUser?.access_code) {
    return NextResponse.json({ code: engineUser.access_code }, { headers: corsHeaders });
  }

  return NextResponse.json(
    { error: "No access code found — sign up on the engine page first" },
    { status: 404, headers: corsHeaders }
  );
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
