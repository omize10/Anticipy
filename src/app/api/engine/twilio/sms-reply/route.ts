import { supabaseAdmin } from "@/lib/supabase-admin";
import { executeAction } from "@/lib/execute-action";
import {
  verifyTwilioRequest,
  reconstructWebhookUrl,
  formDataToParams,
} from "@/lib/twilio-verify";

export const dynamic = "force-dynamic";

/**
 * Twilio inbound SMS webhook.
 * Parses YES/NO replies and confirms/rejects the most recent pending intent.
 */
export async function POST(req: Request) {
  const formData = await req.formData();
  const params = formDataToParams(formData);
  const signature = req.headers.get("x-twilio-signature");
  if (!verifyTwilioRequest(signature, reconstructWebhookUrl(req), params)) {
    return new Response("Forbidden", { status: 403 });
  }

  const body = (params.Body || "").trim().toLowerCase();
  const from = params.From || "";

  if (!body || !from) {
    return twimlResponse("Anticipy: Sorry, I didn't understand that.");
  }

  const isConfirm =
    body === "yes" ||
    body === "y" ||
    body === "1" ||
    body === "confirm" ||
    body === "do it";

  const isReject =
    body === "no" ||
    body === "n" ||
    body === "2" ||
    body === "skip" ||
    body === "cancel";

  if (!isConfirm && !isReject) {
    return twimlResponse(
      "Anticipy: Reply YES to confirm or NO to skip the last action."
    );
  }

  // Find the most recent pending intent that was notified to this phone
  const { data: notification } = await supabaseAdmin
    .from("anticipy_notifications")
    .select("intent_id")
    .eq("recipient", from)
    .eq("channel", "sms")
    .order("sent_at", { ascending: false })
    .limit(1)
    .single();

  if (!notification) {
    return twimlResponse("Anticipy: No pending actions found.");
  }

  const intentId = notification.intent_id;

  // Check intent is still pending (prevents double-execution across channels)
  const { data: intent } = await supabaseAdmin
    .from("anticipy_intents")
    .select("*")
    .eq("id", intentId)
    .in("status", ["pending"])
    .single();

  if (!intent) {
    return twimlResponse("Anticipy: That action has already been handled.");
  }

  const newStatus = isConfirm ? "confirmed" : "rejected";

  await supabaseAdmin
    .from("anticipy_intents")
    .update({ status: newStatus })
    .eq("id", intentId)
    .eq("status", "pending"); // Double-guard against TOCTOU race

  // Record the reply
  await supabaseAdmin
    .from("anticipy_notifications")
    .update({
      reply_received_at: new Date().toISOString(),
      reply_text: body,
    })
    .eq("intent_id", intentId)
    .eq("channel", "sms");

  if (isConfirm) {
    const result = await executeAction(intent);

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

    return twimlResponse(
      result.success
        ? `Anticipy: Done! ${result.message}`
        : `Anticipy: Sorry, that failed. ${result.message}`
    );
  }

  return twimlResponse("Anticipy: Skipped. No action taken.");
}

function twimlResponse(message: string) {
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response><Message>${escapeXml(message)}</Message></Response>`;
  return new Response(twiml, {
    headers: { "Content-Type": "text/xml" },
  });
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
