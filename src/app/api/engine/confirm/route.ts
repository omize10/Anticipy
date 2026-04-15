import { supabaseAdmin } from "@/lib/supabase-admin";
import { executeAction } from "@/lib/execute-action";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const intentId = url.searchParams.get("intentId");
  const action = url.searchParams.get("action");

  if (!intentId || !action) {
    return new Response(renderPage("Error", "Missing intentId or action"), {
      headers: { "Content-Type": "text/html" },
      status: 400,
    });
  }

  const newStatus = action === "yes" ? "confirmed" : "rejected";

  // Atomic guard: atomically transition status from "pending" to the new status.
  // If 0 rows are returned, the intent was already handled (or doesn't exist).
  // This prevents double-execution even under concurrent requests (two email link
  // clicks, one email + one SMS reply, etc.) because Postgres UPDATE is atomic.
  const { data: claimedIntent, error: claimError } = await supabaseAdmin
    .from("anticipy_intents")
    .update({ status: newStatus })
    .eq("id", intentId)
    .eq("status", "pending")
    .select("*")
    .single();

  if (claimError || !claimedIntent) {
    // 0 rows updated — check whether the intent exists at all
    const { data: existing } = await supabaseAdmin
      .from("anticipy_intents")
      .select("id")
      .eq("id", intentId)
      .single();

    if (!existing) {
      return new Response(renderPage("Error", "Intent not found."), {
        headers: { "Content-Type": "text/html" },
        status: 404,
      });
    }

    return new Response(
      renderPage(
        "Already Handled",
        "This action has already been confirmed or skipped."
      ),
      { headers: { "Content-Type": "text/html" } }
    );
  }

  let executionMessage = "";

  if (newStatus === "confirmed") {
    const result = await executeAction(claimedIntent);

    await supabaseAdmin
      .from("anticipy_intents")
      .update({ status: result.success ? "executed" : "failed" })
      .eq("id", intentId);

    await supabaseAdmin.from("anticipy_actions").insert({
      intent_id: intentId,
      status: result.success ? "success" : "failed",
      result: result.data,
      external_id: result.externalId,
    });

    executionMessage = result.message;
  }

  const mainMessage =
    newStatus === "confirmed"
      ? "Got it — executing now."
      : "Skipped. No action taken.";

  return new Response(
    renderPage(
      newStatus === "confirmed" ? "Confirmed" : "Skipped",
      mainMessage +
        (executionMessage
          ? `<br><br><span style="font-size:13px;color:#C8A97E;">${executionMessage}</span>`
          : "")
    ),
    { headers: { "Content-Type": "text/html" } }
  );
}

function renderPage(title: string, message: string): string {
  const emoji =
    title === "Confirmed"
      ? "✅"
      : title === "Skipped"
        ? "⏭️"
        : title === "Already Handled"
          ? "ℹ️"
          : "⚠️";
  return `<!DOCTYPE html>
<html>
<head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Anticipy — ${title}</title></head>
<body style="background:#0C0C0C;color:#FAFAFA;font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;">
  <div style="text-align:center;max-width:400px;padding:40px;">
    <p style="font-size:48px;margin-bottom:16px;">${emoji}</p>
    <h1 style="font-family:Georgia,serif;font-size:24px;color:#C8A97E;margin-bottom:12px;">Anticipy</h1>
    <p style="font-size:16px;color:#8A8A8A;">${message}</p>
    <a href="/engine" style="display:inline-block;margin-top:24px;padding:10px 24px;background:rgba(200,169,126,0.1);color:#C8A97E;text-decoration:none;border-radius:100px;font-size:13px;border:1px solid rgba(200,169,126,0.2);">Back to Engine</a>
  </div>
</body>
</html>`;
}
