import { NextResponse } from "next/server";
import { getGoogleAuthUrl } from "@/lib/google-calendar";

export const dynamic = "force-dynamic";

export async function GET() {
  const state = crypto.randomUUID();
  const authUrl = getGoogleAuthUrl(state);
  return NextResponse.redirect(authUrl);
}
