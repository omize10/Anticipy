import { NextResponse } from "next/server";
import { getStoredTokens } from "@/lib/google-calendar";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const email = process.env.TEST_USER_EMAIL || "omar@anticipy.ai";
    const tokens = await getStoredTokens(email);
    return NextResponse.json({ connected: !!tokens });
  } catch {
    return NextResponse.json({ connected: false });
  }
}
