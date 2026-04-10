import { supabaseAdmin } from "@/lib/supabase-admin";
import { createCalendarEvent } from "@/lib/google-calendar";

export const dynamic = "force-dynamic";

/**
 * Twilio inbound SMS webhook.
 * Parses YES/NO replies and confirms/rejects the most recent pending intent.
 */
export async function POST(req: Request) {
  const formData = await req.formData();
  const body = formData.get("Body")?.toString()?.trim().toLowerCase() || "";
  const from = formData.get("From")?.toString() || "";

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

  // Check intent is still pending
  const { data: intent } = await supabaseAdmin
    .from("anticipy_intents")
    .select("*")
    .eq("id", intentId)
    .in("status", ["pending"])
    .single();

  if (!intent) {
    return twimlResponse(
      "Anticipy: That action has already been handled."
    );
  }

  const newStatus = isConfirm ? "confirmed" : "rejected";

  await supabaseAdmin
    .from("anticipy_intents")
    .update({ status: newStatus })
    .eq("id", intentId);

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
            message: `Reminder saved as note`,
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

      case "email_draft": {
        await supabaseAdmin.from("anticipy_notes").insert({
          session_id: intent.session_id,
          title: `Email Draft: ${params.subject || "No subject"}`,
          body: `To: ${params.recipient_name || "Unknown"}\nSubject: ${params.subject || ""}\n\n${params.body || ""}`,
        });
        return {
          success: true,
          message: `Email draft saved for ${params.recipient_name}`,
          data: { recipient: params.recipient_name },
        };
      }

      case "message_draft": {
        await supabaseAdmin.from("anticipy_notes").insert({
          session_id: intent.session_id,
          title: `Message to ${params.recipient_name || "Unknown"}`,
          body: (params.body as string) || "",
        });
        return {
          success: true,
          message: `Message draft saved for ${params.recipient_name}`,
          data: { recipient: params.recipient_name },
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
