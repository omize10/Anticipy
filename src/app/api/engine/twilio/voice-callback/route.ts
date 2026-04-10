import { supabaseAdmin } from "@/lib/supabase-admin";
import { createCalendarEvent } from "@/lib/google-calendar";

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
  const digits = formData.get("Digits")?.toString();
  const speechResult = formData.get("SpeechResult")?.toString()?.toLowerCase();

  // Determine if user said yes or no
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

  await supabaseAdmin
    .from("anticipy_intents")
    .update({ status: newStatus })
    .eq("id", intentId);

  if (isConfirm) {
    // Execute the action
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

interface ActionResult {
  success: boolean;
  message: string;
  data: Record<string, unknown>;
  externalId?: string;
}

async function executeAction(
  intent: Record<string, unknown>
): Promise<ActionResult> {
  const actionType = intent.action_type as string;
  const params = (intent.parameters as Record<string, unknown>) || {};
  const userEmail = process.env.TEST_USER_EMAIL || "omar@anticipy.ai";

  try {
    switch (actionType) {
      case "calendar_add": {
        const event = await createCalendarEvent(userEmail, {
          title: (params.title as string) || "Untitled Event",
          startIso:
            (params.start_iso as string) || new Date().toISOString(),
          endIso:
            (params.end_iso as string) ||
            new Date(Date.now() + 3600000).toISOString(),
          description: params.description as string,
          location: params.location as string,
          attendees: params.attendees as string[],
          timezone: "America/Vancouver",
        });
        return {
          success: true,
          message: `Calendar event created: ${params.title}`,
          data: { eventId: event.eventId, htmlLink: event.htmlLink },
          externalId: event.eventId,
        };
      }

      case "reminder_add": {
        try {
          const dueIso =
            (params.due_iso as string) ||
            new Date(Date.now() + 3600000).toISOString();
          const event = await createCalendarEvent(userEmail, {
            title: `Reminder: ${params.text || "Reminder"}`,
            startIso: dueIso,
            endIso: dueIso,
            description: `Reminder set by Anticipy: ${params.text}`,
            timezone: "America/Vancouver",
          });
          return {
            success: true,
            message: `Reminder set: ${params.text}`,
            data: { eventId: event.eventId },
            externalId: event.eventId,
          };
        } catch {
          await supabaseAdmin.from("anticipy_notes").insert({
            session_id: intent.session_id,
            title: `Reminder: ${params.text || "Reminder"}`,
            body: `Due: ${params.due_iso || "Not specified"}\n\n${params.text || ""}`,
          });
          return {
            success: true,
            message: `Reminder saved as note: ${params.text}`,
            data: { fallback: "note" },
          };
        }
      }

      case "note_add": {
        await supabaseAdmin.from("anticipy_notes").insert({
          session_id: intent.session_id,
          title: (params.title as string) || "Untitled Note",
          body: (params.body as string) || "",
        });
        return {
          success: true,
          message: `Note saved: ${params.title}`,
          data: { title: params.title },
        };
      }

      default:
        return {
          success: true,
          message: `Action noted: ${actionType}`,
          data: { actionType },
        };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Execution failed";
    return { success: false, message, data: { error: message } };
  }
}
