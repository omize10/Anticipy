import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const intentId = url.searchParams.get("intentId");
  const action = url.searchParams.get("action");

  if (!intentId || !action) {
    return NextResponse.json(
      { error: "Missing intentId or action" },
      { status: 400 }
    );
  }

  const newStatus = action === "yes" ? "confirmed" : "rejected";

  const { error } = await supabaseAdmin
    .from("anticipy_intents")
    .update({ status: newStatus })
    .eq("id", intentId);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // If confirmed, execute the action
  if (newStatus === "confirmed") {
    const { data: intent } = await supabaseAdmin
      .from("anticipy_intents")
      .select("*")
      .eq("id", intentId)
      .single();

    if (intent) {
      // Mark as executed (for now, just mark it — action execution comes in Phase 5)
      await supabaseAdmin
        .from("anticipy_intents")
        .update({ status: "executed" })
        .eq("id", intentId);

      await supabaseAdmin.from("anticipy_actions").insert({
        intent_id: intentId,
        status: "success",
        result: {
          message: `Action "${intent.action_type}" confirmed and queued`,
        },
      });
    }
  }

  // Return a styled confirmation page
  const emoji = newStatus === "confirmed" ? "✅" : "⏭️";
  const message =
    newStatus === "confirmed"
      ? "Got it — executing now."
      : "Skipped. No action taken.";

  return new Response(
    `<!DOCTYPE html>
    <html>
    <head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Anticipy</title></head>
    <body style="background:#0C0C0C;color:#FAFAFA;font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;">
      <div style="text-align:center;max-width:400px;padding:40px;">
        <p style="font-size:48px;margin-bottom:16px;">${emoji}</p>
        <h1 style="font-family:Georgia,serif;font-size:24px;color:#C8A97E;margin-bottom:12px;">Anticipy</h1>
        <p style="font-size:16px;color:#8A8A8A;">${message}</p>
      </div>
    </body>
    </html>`,
    {
      headers: { "Content-Type": "text/html" },
    }
  );
}
