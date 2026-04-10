import { NextRequest, NextResponse } from "next/server";
import { exchangeCodeForTokens, storeTokens } from "@/lib/google-calendar";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const error = request.nextUrl.searchParams.get("error");

  if (error) {
    return new Response(renderPage("Access Denied", "Google Calendar access was denied."), {
      headers: { "Content-Type": "text/html" },
    });
  }

  if (!code) {
    return new Response(renderPage("Error", "No authorization code received."), {
      headers: { "Content-Type": "text/html" },
      status: 400,
    });
  }

  try {
    const tokens = await exchangeCodeForTokens(code);

    // Get user email from the access token
    const userInfoRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    const userInfo = await userInfoRes.json();
    const email = userInfo.email || process.env.TEST_USER_EMAIL || "omar@anticipy.ai";

    await storeTokens(email, {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expiry_date: Date.now() + (tokens.expires_in ?? 3600) * 1000,
    });

    return new Response(
      renderPage("Connected", `Google Calendar connected for ${email}. You can close this tab.`),
      { headers: { "Content-Type": "text/html" } }
    );
  } catch (err) {
    console.error("Google OAuth callback error:", err);
    const message = err instanceof Error ? err.message : "Unknown error";
    return new Response(renderPage("Error", message), {
      headers: { "Content-Type": "text/html" },
      status: 500,
    });
  }
}

function renderPage(title: string, message: string): string {
  return `<!DOCTYPE html>
<html>
<head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Anticipy — ${title}</title></head>
<body style="background:#0C0C0C;color:#FAFAFA;font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;">
  <div style="text-align:center;max-width:400px;padding:40px;">
    <h1 style="font-family:Georgia,serif;font-size:24px;color:#C8A97E;margin-bottom:12px;">Anticipy</h1>
    <p style="font-size:18px;margin-bottom:8px;">${title}</p>
    <p style="font-size:14px;color:#8A8A8A;">${message}</p>
    <a href="/engine" style="display:inline-block;margin-top:24px;padding:10px 24px;background:#C8A97E;color:#0C0C0C;text-decoration:none;border-radius:100px;font-size:14px;font-weight:600;">Back to Engine</a>
  </div>
</body>
</html>`;
}
