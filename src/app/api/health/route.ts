import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const version =
    process.env.VERCEL_GIT_COMMIT_SHA ||
    process.env.GIT_COMMIT_SHA ||
    "unknown";

  return NextResponse.json({
    status: "ok",
    version,
  });
}
