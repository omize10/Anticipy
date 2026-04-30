import { supabaseAdmin } from "@/lib/supabase-admin";
import { executeAction } from "@/lib/execute-action";
import { escapeHtml } from "@/lib/escape";

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

  // Atomic guard: update only if status is still "pending" and return the updated row.
  // This single round-trip eliminates the SELECT→check→UPDATE TOCTOU race and also
  // avoids stale-read false positives from PgBouncer connection pooling.
  const { data: updated, error } = await supabaseAdmin
    .from("anticipy_intents")
    .update({ status: newStatus })
    .eq("id", intentId)
    .eq("status", "pending")
    .select("id");

  if (error) {
    return new Response(renderPage("Error", escapeHtml(error.message)), {
      headers: { "Content-Type": "text/html" },
      status: 500,
    });
  }

  // Zero rows updated means either the intent doesn't exist or was already handled.
  if (!updated || updated.length === 0) {
    const { data: existingIntent } = await supabaseAdmin
      .from("anticipy_intents")
      .select("id")
      .eq("id", intentId)
      .single();

    if (!existingIntent) {
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
    const { data: intent } = await supabaseAdmin
      .from("anticipy_intents")
      .select("*")
      .eq("id", intentId)
      .single();

    if (intent) {
      const result = await executeAction(intent);

      // Always update intent status and log the action — including browser-routed ones.
      // Browser-routed actions now save a note fallback inside executeAction, so
      // there is always a record even if the extension never picks this up.
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

      // For browser-routed actions, also broadcast to the Chrome extension as an
      // additional best-effort execution path (note fallback already saved above).
      if (result.data?.routing === "browser") {
        const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
        const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
        if (supabaseUrl && serviceKey) {
          fetch(`${supabaseUrl}/realtime/v1/api/broadcast`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              apikey: serviceKey,
              Authorization: `Bearer ${serviceKey}`,
            },
            body: JSON.stringify({
              messages: [{
                topic: "anticipy-intents",
                event: "confirmed_intent",
                payload: {
                  ...intent,
                  status: "confirmed",
                  parameters: {
                    ...(intent.parameters as Record<string, unknown>),
                    browser_task: result.data.task,
                  },
                },
              }],
            }),
          }).catch((e: Error) => console.warn("[broadcast] confirmed_intent failed:", e.message));
        }
      }

      executionMessage = result.message;
    }
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
          ? `<br><br><span style="font-size:13px;color:#C8A97E;">${escapeHtml(executionMessage)}</span>`
          : "")
    ),
    { headers: { "Content-Type": "text/html" } }
  );
}

/**
 * Renders the post-confirm/skip page. `message` may contain a small,
 * caller-controlled HTML snippet (e.g. a styled span around an
 * already-escaped execution message). All user-influenced text MUST be
 * passed through escapeHtml() before being interpolated into `message`.
 */
function renderPage(title: string, message: string): string {
  const emoji =
    title === "Confirmed"
      ? "✅"
      : title === "Skipped"
        ? "⏭️"
        : title === "Already Handled"
          ? "ℹ️"
          : "⚠️";
  const safeTitle = escapeHtml(title);
  return `<!DOCTYPE html>
<html>
<head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Anticipy — ${safeTitle}</title></head>
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
