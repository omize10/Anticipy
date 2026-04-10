import { supabaseAdmin } from "@/lib/supabase-admin";
import { createCalendarEvent } from "@/lib/google-calendar";

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

  const { error } = await supabaseAdmin
    .from("anticipy_intents")
    .update({ status: newStatus })
    .eq("id", intentId);

  if (error) {
    return new Response(renderPage("Error", error.message), {
      headers: { "Content-Type": "text/html" },
      status: 500,
    });
  }

  let executionMessage = "";

  // If confirmed, execute the action
  if (newStatus === "confirmed") {
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

      executionMessage = result.message;
    }
  }

  const emoji = newStatus === "confirmed" ? "✅" : "⏭️";
  const mainMessage =
    newStatus === "confirmed"
      ? "Got it — executing now."
      : "Skipped. No action taken.";

  return new Response(
    renderPage(
      newStatus === "confirmed" ? "Confirmed" : "Skipped",
      mainMessage + (executionMessage ? `<br><br><span style="font-size:13px;color:#C8A97E;">${executionMessage}</span>` : "")
    ),
    { headers: { "Content-Type": "text/html" } }
  );
}

interface ActionResult {
  success: boolean;
  message: string;
  data: Record<string, unknown>;
  externalId?: string;
}

async function executeAction(intent: Record<string, unknown>): Promise<ActionResult> {
  const actionType = intent.action_type as string;
  const params = (intent.parameters as Record<string, unknown>) || {};
  const userEmail = process.env.TEST_USER_EMAIL || "omar@anticipy.ai";

  try {
    switch (actionType) {
      case "calendar_add": {
        const event = await createCalendarEvent(userEmail, {
          title: (params.title as string) || "Untitled Event",
          startIso: (params.start_iso as string) || new Date().toISOString(),
          endIso: (params.end_iso as string) || new Date(Date.now() + 3600000).toISOString(),
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
        // Create as a calendar event with a reminder
        try {
          const dueIso = (params.due_iso as string) || new Date(Date.now() + 3600000).toISOString();
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
          // Fallback: store as a note if calendar not connected
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
        const { error: noteErr } = await supabaseAdmin.from("anticipy_notes").insert({
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
        // Store as a note with the draft content (actual Gmail draft creation needs separate OAuth)
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

function renderPage(title: string, message: string): string {
  const emoji = title === "Confirmed" ? "✅" : title === "Skipped" ? "⏭️" : "⚠️";
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
