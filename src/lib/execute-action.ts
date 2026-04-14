import { supabaseAdmin } from "./supabase-admin";
import { createCalendarEvent } from "./google-calendar";

export interface ActionResult {
  success: boolean;
  message: string;
  data: Record<string, unknown>;
  externalId?: string;
}

/**
 * Canonical executeAction implementation shared across confirm, sms-reply, and voice-callback.
 * All action types and their fallback behaviour are defined here exactly once.
 */
export async function executeAction(
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
          startIso: (params.start_iso as string) || new Date().toISOString(),
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
          message: `Calendar event created: "${params.title}"`,
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
            message: `Reminder set: "${params.text}"`,
            data: { eventId: event.eventId, htmlLink: event.htmlLink },
            externalId: event.eventId,
          };
        } catch {
          // Calendar not connected — save as a note instead
          await supabaseAdmin.from("anticipy_notes").insert({
            session_id: intent.session_id,
            title: `Reminder: ${params.text || "Reminder"}`,
            body: `Due: ${params.due_iso || "Not specified"}\n\n${params.text || ""}`,
          });
          return {
            success: true,
            message: `Reminder saved as note: "${params.text}"`,
            data: { fallback: "note" },
          };
        }
      }

      case "note_add": {
        const { error: noteErr } = await supabaseAdmin
          .from("anticipy_notes")
          .insert({
            session_id: intent.session_id,
            title: (params.title as string) || "Untitled Note",
            body: (params.body as string) || "",
          });
        if (noteErr) throw new Error(noteErr.message);
        return {
          success: true,
          message: `Note saved: "${params.title}"`,
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
          message: `Email draft saved for ${params.recipient_name}: "${params.subject}"`,
          data: { recipient: params.recipient_name, subject: params.subject },
        };
      }

      case "message_draft": {
        await supabaseAdmin.from("anticipy_notes").insert({
          session_id: intent.session_id,
          title: `Message to ${params.recipient_name || "Unknown"} (${params.channel || "sms"})`,
          body: (params.body as string) || "",
        });
        return {
          success: true,
          message: `Message draft saved for ${params.recipient_name}`,
          data: { recipient: params.recipient_name, channel: params.channel },
        };
      }

      case "lookup": {
        await supabaseAdmin.from("anticipy_notes").insert({
          session_id: intent.session_id,
          title: `Lookup: ${params.query || ""}`,
          body: `Query: ${params.query}\nWhy: ${params.why_useful || ""}`,
        });
        return {
          success: true,
          message: `Lookup noted: "${params.query}"`,
          data: { query: params.query },
        };
      }

      default:
        return {
          success: false,
          message: `Unknown action type: ${actionType}`,
          data: { actionType },
        };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Execution failed";
    console.error(`Action execution error (${actionType}):`, message);
    return {
      success: false,
      message: `Failed: ${message}`,
      data: { error: message },
    };
  }
}
