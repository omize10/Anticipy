import { supabaseAdmin } from "@/lib/supabase-admin";
import { executeAction } from "@/lib/execute-action";
import {
  verifyTwilioRequest,
  reconstructWebhookUrl,
  formDataToParams,
} from "@/lib/twilio-verify";

export const dynamic = "force-dynamic";

/**
 * Twilio voice callback - handles the user's response to a voice call.
 * Executes or rejects the intent based on speech/DTMF input.
 */
export async function POST(req: Request) {
  const url = new URL(req.url);
  const intentId = url.searchParams.get("intentId");

  if (!intentId) {
    return twimlResponse("Sorry, something went wrong. Goodbye.");
  }

  const formData = await req.formData();
  const params = formDataToParams(formData);
  const signature = req.headers.get("x-twilio-signature");
  if (!verifyTwilioRequest(signature, reconstructWebhookUrl(req), params)) {
    return new Response("Forbidden", { status: 403 });
  }
  const digits = params.Digits;
  const speechResult = params.SpeechResult?.toLowerCase();

  const isConfirm =
    digits === "1" ||
    speechResult?.includes("yes") ||
    speechResult?.includes("confirm") ||
    speechResult?.includes("do it");

  const isReject =
    digits === "2" ||
    speechResult?.includes("no") ||
    speechResult?.includes("skip") ||
    speechResult?.includes("cancel");

  if (!isConfirm && !isReject) {
    return twimlResponse(
      "I didn't understand. I'll skip this one for now. You can still confirm via email or text. Goodbye."
    );
  }

  const newStatus = isConfirm ? "confirmed" : "rejected";

  // Guard: only update intents that are still pending to prevent double-execution
  // (user could confirm via voice AND email link, or voice AND SMS reply).
  const { data: currentIntent } = await supabaseAdmin
    .from("anticipy_intents")
    .select("status")
    .eq("id", intentId)
    .single();

  if (!currentIntent || currentIntent.status !== "pending") {
    return twimlResponse("That action has already been handled. Goodbye.");
  }

  await supabaseAdmin
    .from("anticipy_intents")
    .update({ status: newStatus })
    .eq("id", intentId)
    .eq("status", "pending"); // Double-guard against TOCTOU race

  if (isConfirm) {
    const { data: intent } = await supabaseAdmin
      .from("anticipy_intents")
      .select("*")
      .eq("id", intentId)
      .single();

    if (intent) {
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
          ? `Done. ${result.message}. Goodbye.`
          : `Sorry, that action failed. ${result.message}. Goodbye.`
      );
    }
  }

  return twimlResponse("Got it, skipping. Goodbye.");
}

function twimlResponse(message: string) {
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response><Say voice="Polly.Joanna">${escapeXml(message)}</Say></Response>`;
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
