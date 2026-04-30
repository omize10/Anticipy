import { supabaseAdmin } from "@/lib/supabase-admin";
import { executeAction } from "@/lib/execute-action";
import { readVerifiedTwilioBody } from "@/lib/twilio-verify";

export const dynamic = "force-dynamic";

/**
 * Twilio voice callback - handles the user's response to a voice call.
 * Executes or rejects the intent based on speech/DTMF input.
 *
 * The X-Twilio-Signature header is validated before any state changes —
 * without it anyone who guesses the intentId could forge a "1" digit and
 * trigger another user's pending action.
 */
export async function POST(req: Request) {
  const url = new URL(req.url);
  const intentId = url.searchParams.get("intentId");

  if (!intentId) {
    return twimlResponse("Sorry, something went wrong. Goodbye.");
  }

  const verified = await readVerifiedTwilioBody(req);
  if (!verified) {
    return new Response("Forbidden", { status: 403 });
  }

  const digits = verified.params.Digits;
  const speechResult = verified.params.SpeechResult?.toLowerCase();

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

  // Atomic guard: a single conditional UPDATE eliminates the SELECT→UPDATE
  // race that lets a duplicate webhook (voice + email + SMS hitting at once)
  // execute the action twice. We rely on the returned row count, not on a
  // prior SELECT, because PgBouncer can serve stale reads.
  const { data: flipped } = await supabaseAdmin
    .from("anticipy_intents")
    .update({ status: newStatus })
    .eq("id", intentId)
    .eq("status", "pending")
    .select("id");

  if (!flipped || flipped.length === 0) {
    return twimlResponse("That action has already been handled. Goodbye.");
  }

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
