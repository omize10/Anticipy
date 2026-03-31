import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

function getAdminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );
}

async function verifyAdmin(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) return false;

  const token = authHeader.replace("Bearer ", "");
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );

  const { data } = await supabase.auth.getUser(token);
  if (!data.user) return false;

  const admin = getAdminClient();
  const { data: adminUser } = await admin
    .from("anticipy_admin_users")
    .select("role")
    .eq("id", data.user.id)
    .single();

  return !!adminUser;
}

export async function GET(request: NextRequest) {
  if (!(await verifyAdmin(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = getAdminClient();
  const page = parseInt(request.nextUrl.searchParams.get("page") || "1");
  const search = request.nextUrl.searchParams.get("search") || "";
  const limit = 50;
  const offset = (page - 1) * limit;

  let query = admin
    .from("anticipy_waitlist")
    .select("*", { count: "exact" })
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (search) {
    query = query.ilike("email", `%${search}%`);
  }

  const { data, count, error } = await query;

  if (error) {
    return NextResponse.json({ error: "Failed to fetch" }, { status: 500 });
  }

  return NextResponse.json({ data, total: count, page, limit });
}

export async function DELETE(request: NextRequest) {
  if (!(await verifyAdmin(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await request.json();
  const admin = getAdminClient();

  const { error } = await admin
    .from("anticipy_waitlist")
    .delete()
    .eq("id", id);

  if (error) {
    return NextResponse.json({ error: "Failed to delete" }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
