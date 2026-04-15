/**
 * Canonical executeAction implementation shared across confirm, sms-reply, and voice-callback.
 *
 * Routing tiers:
 *   Tier 1  — Direct API calls  (calendar, notes, email via Resend, SMS via Twilio)
 *   Tier 2  — Browser agent     (everything else, plus fallback for Tier-1 failures)
 *
 * The browser agent runs in the Python FastAPI engine (/execute-intent endpoint).
 * If the engine is unreachable, Tier-2 actions fall back to saving a note in Supabase
 * so no action is silently lost.
 */

import { supabaseAdmin } from "./supabase-admin";
import { createCalendarEvent } from "./google-calendar";
import { Resend } from "resend";
import { sendSMS } from "./twilio-notify";

const resend = new Resend(process.env.RESEND_API_KEY!);

// Engine URL for server-side calls (not exposed to browser)
// Use ENGINE_INTERNAL_URL for private VPC routing, fall back to public URL
const ENGINE_URL =
  process.env.ENGINE_INTERNAL_URL ||
  process.env.NEXT_PUBLIC_ENGINE_URL ||
  "http://localhost:8000";

export interface ActionResult {
  success: boolean;
  message: string;
  data: Record<string, unknown>;
  externalId?: string;
}

// ---------------------------------------------------------------------------
// Browser task builder
// Translates a structured intent into a plain-English task the browser agent
// can execute without any per-site hardcoding.
// ---------------------------------------------------------------------------

export function buildBrowserTask(
  actionType: string,
  params: Record<string, unknown>
): string {
  const p = params;

  switch (actionType) {
    case "email_draft": {
      const toLine = (p.recipient_email as string)?.includes("@")
        ? `${p.recipient_name} <${p.recipient_email}>`
        : String(p.recipient_name || "the recipient");
      return [
        "Open Gmail (mail.google.com) and compose a new email.",
        `To: ${toLine}`,
        `Subject: ${p.subject || "No subject"}`,
        `Message body:\n${p.body || ""}`,
        "Click Send to deliver the email.",
      ].join("\n");
    }

    case "message_draft": {
      const channel = String(p.channel || "message").toLowerCase();
      const recipient = String(p.recipient_name || "the recipient");
      const body = String(p.body || "");

      if (channel === "whatsapp") {
        return `Open WhatsApp Web (web.whatsapp.com), find the conversation with ${recipient}, type this message: "${body}", and send it.`;
      }
      if (channel === "slack") {
        return `Open Slack (app.slack.com), find ${recipient}, type this message: "${body}", and send it.`;
      }
      // Default for unknown channel: open Gmail as a fallback
      return [
        "Open Gmail (mail.google.com) and compose a new email.",
        `To: ${recipient}`,
        `Message: ${body}`,
        "Click Send.",
      ].join("\n");
    }

    case "lookup": {
      return [
        `Search Google for: "${p.query}"`,
        p.why_useful ? `Context: ${p.why_useful}` : "",
        "Read the top 3–5 results and return a concise, accurate summary of the key findings.",
      ]
        .filter(Boolean)
        .join("\n");
    }

    case "book_flight": {
      return [
        "Search for flights on Google Flights (flights.google.com).",
        p.from ? `Departing from: ${p.from}` : "",
        p.to ? `Destination: ${p.to}` : "",
        p.date ? `Date: ${p.date}` : "",
        p.return_date ? `Return date: ${p.return_date}` : "",
        p.passengers ? `Passengers: ${p.passengers}` : "",
        p.cabin_class ? `Class: ${p.cabin_class}` : "",
        "Find the best available options and report the top 3 results with price, airline, and departure time.",
      ]
        .filter(Boolean)
        .join("\n");
    }

    case "make_reservation":
    case "book_restaurant":
    case "restaurant_reservation": {
      const venue = String(p.venue || p.restaurant || p.place || "the restaurant");
      return [
        `Make a restaurant reservation at ${venue} using OpenTable (opentable.com).`,
        p.date ? `Date: ${p.date}` : "",
        p.time ? `Time: ${p.time}` : "",
        p.party_size ? `Party size: ${p.party_size} people` : "",
        p.notes ? `Special requests: ${p.notes}` : "",
        "Complete the booking and confirm all reservation details.",
      ]
        .filter(Boolean)
        .join("\n");
    }

    case "order_gift":
    case "send_gift":
    case "send_flowers": {
      const recipient = String(p.recipient_name || "the recipient");
      const item = String(p.item || p.gift_type || "flowers");
      return [
        `Order ${item} for ${recipient}.`,
        p.occasion ? `Occasion: ${p.occasion}` : "",
        p.budget ? `Budget: ${p.budget}` : "",
        p.delivery_address ? `Deliver to: ${p.delivery_address}` : "",
        p.message ? `Gift message: ${p.message}` : "",
        "Find a reputable seller, choose a suitable option, and complete the order.",
      ]
        .filter(Boolean)
        .join("\n");
    }

    case "pay_invoice":
    case "send_payment": {
      return [
        `Make a payment.`,
        p.amount ? `Amount: ${p.amount}` : "",
        p.recipient_name ? `To: ${p.recipient_name}` : "",
        p.method ? `Via: ${p.method}` : "",
        p.reference ? `Reference: ${p.reference}` : "",
        "Complete the payment and confirm the transaction.",
      ]
        .filter(Boolean)
        .join("\n");
    }

    case "schedule_call":
    case "book_meeting": {
      const with_ = String(p.with || p.recipient_name || p.attendee || "");
      return [
        `Schedule a call${with_ ? ` with ${with_}` : ""}.`,
        p.date ? `Date: ${p.date}` : "",
        p.time ? `Time: ${p.time}` : "",
        p.duration ? `Duration: ${p.duration}` : "",
        p.platform ? `Platform: ${p.platform}` : "",
        "Use Calendly or Google Meet to book the meeting and send an invite.",
      ]
        .filter(Boolean)
        .join("\n");
    }

    case "follow_up_with":
    case "check_in_on":
    case "return_call": {
      const person = String(p.recipient_name || p.person || "them");
      const context = String(p.context || p.subject || p.body || "");
      return [
        `Send a follow-up message to ${person}.`,
        context ? `Context: ${context}` : "",
        "Open Gmail and compose a brief, friendly follow-up email. Send it.",
      ]
        .filter(Boolean)
        .join("\n");
    }

    case "send_congratulations":
    case "send_condolences":
    case "send_apology": {
      const person = String(p.recipient_name || "them");
      const humanType = actionType.replace("send_", "").replace("_", " ");
      return [
        `Send ${humanType} to ${person}.`,
        p.context ? `Context: ${p.context}` : "",
        p.body ? `Message: ${p.body}` : "",
        "Open Gmail and compose a heartfelt message. Send it.",
      ]
        .filter(Boolean)
        .join("\n");
    }

    case "share_document": {
      return [
        `Share a document with ${p.recipient_name || "the recipient"}.`,
        p.document ? `Document: ${p.document}` : "",
        p.permissions ? `Permissions: ${p.permissions}` : "",
        "Find the document in Google Drive and share it with the appropriate permissions.",
      ]
        .filter(Boolean)
        .join("\n");
    }

    default: {
      // Generic: convert snake_case action type to natural language
      const humanAction = actionType.replace(/_/g, " ");
      const paramLines = Object.entries(p)
        .filter(([, v]) => v !== null && v !== undefined && v !== "")
        .map(([k, v]) => `${k.replace(/_/g, " ")}: ${v}`)
        .join("\n");
      return paramLines
        ? `${humanAction}.\n\nDetails:\n${paramLines}`
        : humanAction;
    }
  }
}

// ---------------------------------------------------------------------------
// Browser agent router
// Calls the Python engine's /execute-intent endpoint.
// Falls back to saving a Supabase note if the engine is unreachable.
// ---------------------------------------------------------------------------

async function routeToBrowserAgent(
  intent: Record<string, unknown>,
  taskDescription: string
): Promise<ActionResult> {
  try {
    const response = await fetch(`${ENGINE_URL}/execute-intent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        task: taskDescription,
        intent_id: intent.id,
        user_id: intent.user_id,
      }),
      // Allow up to 35 s — the engine times out at 25 s and returns "working"
      signal: AbortSignal.timeout(35_000),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw new Error(`Engine returned ${response.status}: ${errText}`);
    }

    const result = await response.json();

    // "working" = engine started the task but it's still running in background
    if (result.working) {
      return {
        success: true,
        message:
          result.plan
            ? `Working on it — ${result.plan}`
            : "Working on it — this may take a minute.",
        data: {
          working: true,
          task_id: result.data?.task_id,
          plan: result.plan,
          executedVia: "browser_agent",
        },
      };
    }

    return {
      success: result.success ?? false,
      message: result.message || "Task completed.",
      data: {
        ...(result.data || {}),
        plan: result.plan,
        executedVia: "browser_agent",
      },
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.warn(`[executeAction] Browser agent unreachable: ${errMsg}`);

    // Fallback: persist as a queued note so nothing is silently lost
    try {
      const label = String(intent.action_type || "action").replace(/_/g, " ");
      await supabaseAdmin.from("anticipy_notes").insert({
        session_id: intent.session_id,
        title: `Queued: ${label}`,
        body: taskDescription,
      });
      return {
        success: true,
        message: `Saved for later — the browser agent is currently unavailable. "${taskDescription.split("\n")[0]}"`,
        data: { queued: true, engineError: errMsg },
      };
    } catch {
      return {
        success: false,
        message:
          "The action could not be completed. The browser agent is unavailable and the note could not be saved.",
        data: { engineError: errMsg },
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function executeAction(
  intent: Record<string, unknown>
): Promise<ActionResult> {
  const actionType = intent.action_type as string;
  const params = (intent.parameters as Record<string, unknown>) || {};
  const userEmail = process.env.TEST_USER_EMAIL || "omar@anticipy.ai";

  try {
    switch (actionType) {
      // -----------------------------------------------------------------------
      // TIER 1 — Direct API calls (fast, no browser needed)
      // -----------------------------------------------------------------------

      case "calendar_add": {
        const event = await createCalendarEvent(userEmail, {
          title: (params.title as string) || "Untitled Event",
          startIso:
            (params.start_iso as string) || new Date().toISOString(),
          endIso:
            (params.end_iso as string) ||
            new Date(Date.now() + 3_600_000).toISOString(),
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
            new Date(Date.now() + 3_600_000).toISOString();
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
          // Calendar not connected — save as note
          await supabaseAdmin.from("anticipy_notes").insert({
            session_id: intent.session_id,
            title: `Reminder: ${params.text || "Reminder"}`,
            body: `Due: ${params.due_iso || "Not specified"}\n\n${params.text || ""}`,
          });
          return {
            success: true,
            message: `Reminder saved: "${params.text}"`,
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
        // If we have a direct email address, send via Resend immediately
        const recipientEmail = params.recipient_email as string | undefined;
        if (recipientEmail?.includes("@")) {
          try {
            const senderHandle = userEmail.split("@")[0];
            const { data: sent, error: sendErr } = await resend.emails.send({
              from: `${senderHandle} via Anticipy <notifications@aevoy.com>`,
              to: recipientEmail,
              subject:
                (params.subject as string) || "Message via Anticipy",
              text: (params.body as string) || "",
              html: `<p>${((params.body as string) || "").replace(/\n/g, "<br>")}</p>
                     <hr style="border:none;border-top:1px solid #eee;margin:16px 0">
                     <p style="font-size:12px;color:#888">Sent via Anticipy on behalf of ${senderHandle}</p>`,
            });

            if (!sendErr) {
              return {
                success: true,
                message: `Email sent to ${params.recipient_name || recipientEmail}: "${params.subject}"`,
                data: { emailId: sent?.id, recipient: recipientEmail },
                externalId: sent?.id,
              };
            }
            console.warn("[executeAction] Resend failed, routing to browser agent:", sendErr);
          } catch (emailErr) {
            console.warn("[executeAction] Resend threw, routing to browser agent:", emailErr);
          }
        }

        // No email address or Resend failed → browser agent opens Gmail
        return routeToBrowserAgent(intent, buildBrowserTask("email_draft", params));
      }

      case "message_draft": {
        const channel = (params.channel as string | undefined) || "";
        const phone = params.recipient_phone as string | undefined;

        // SMS with a known phone number → Twilio direct send
        if (channel.toLowerCase() === "sms" && phone) {
          const body = (params.body as string) || "";
          const smsResult = await sendSMS(phone, body, intent.id as string);
          return {
            success: smsResult.success,
            message: smsResult.success
              ? `SMS sent to ${params.recipient_name || phone}`
              : `Failed to send SMS: ${smsResult.error}`,
            data: { sid: smsResult.sid, mock: smsResult.mock },
          };
        }

        // Everything else → browser agent
        return routeToBrowserAgent(
          intent,
          buildBrowserTask("message_draft", params)
        );
      }

      // -----------------------------------------------------------------------
      // TIER 2 — Browser agent for all remaining action types
      // The agent autonomously figures out HOW to execute the task.
      // -----------------------------------------------------------------------

      case "lookup":
      default: {
        return routeToBrowserAgent(
          intent,
          buildBrowserTask(actionType, params)
        );
      }
    }
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Execution failed";
    console.error(`[executeAction] Error (${actionType}):`, message);
    return {
      success: false,
      message: `Failed: ${message}`,
      data: { error: message },
    };
  }
}
