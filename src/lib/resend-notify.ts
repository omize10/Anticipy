import { Resend } from "resend";
import { escapeHtml, sanitizeHeader } from "./escape";

const resend = new Resend(process.env.RESEND_API_KEY ?? "re_placeholder");
const FROM_EMAIL = "Anticipy <notifications@aevoy.com>";

interface IntentNotification {
  intentId: string;
  summary: string;
  evidenceQuote: string;
  importance: string;
  actionType: string;
}

export async function sendIntentEmail(
  toEmail: string,
  intent: IntentNotification,
  baseUrl: string,
  subjectPrefix?: string
): Promise<{ id: string } | null> {
  const safeIntentId = encodeURIComponent(intent.intentId);
  const confirmUrl = `${baseUrl}/api/engine/confirm?intentId=${safeIntentId}&action=yes`;
  const rejectUrl = `${baseUrl}/api/engine/confirm?intentId=${safeIntentId}&action=no`;

  const importanceBadge =
    intent.importance === "critical"
      ? "🔴 CRITICAL"
      : intent.importance === "important"
        ? "🟠 Important"
        : intent.importance === "standard"
          ? "🟡 Standard"
          : "⚪ Low";

  const rawSubject = subjectPrefix
    ? `${subjectPrefix} Anticipy: ${intent.summary}`
    : `Anticipy: ${intent.summary}`;
  const subject = sanitizeHeader(rawSubject, 180);

  const safeSummary = escapeHtml(intent.summary);
  const safeQuote = escapeHtml(intent.evidenceQuote);

  const { data, error } = await resend.emails.send({
    from: FROM_EMAIL,
    to: toEmail,
    subject,
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 500px; margin: 0 auto; background: #0C0C0C; color: #FAFAFA; padding: 32px; border-radius: 16px;">
        <div style="margin-bottom: 24px;">
          <span style="font-family: Georgia, serif; font-size: 20px; color: #C8A97E;">Anticipy</span>
          <span style="float: right; font-size: 12px; padding: 4px 10px; border-radius: 20px; background: rgba(200,169,126,0.15); color: #C8A97E;">${importanceBadge}</span>
        </div>

        <p style="font-size: 14px; color: #8A8A8A; margin-bottom: 8px;">I heard you mention:</p>
        <blockquote style="border-left: 3px solid #C8A97E; padding-left: 16px; margin: 0 0 24px 0; font-style: italic; color: #FAFAFA;">
          "${safeQuote}"
        </blockquote>

        <p style="font-size: 16px; margin-bottom: 24px; color: #FAFAFA;">
          <strong>${safeSummary}</strong>
        </p>

        <div style="display: flex; gap: 12px; margin-bottom: 24px;">
          <a href="${confirmUrl}" style="display: inline-block; padding: 12px 32px; background: #C8A97E; color: #0C0C0C; text-decoration: none; border-radius: 100px; font-weight: 600; font-size: 15px;">Yes, do it</a>
          <a href="${rejectUrl}" style="display: inline-block; padding: 12px 32px; background: #252525; color: #8A8A8A; text-decoration: none; border-radius: 100px; font-weight: 500; font-size: 15px;">Skip</a>
        </div>

        <p style="font-size: 12px; color: #5A5A5A;">
          Tap a button above to confirm or skip — Anticipy will handle the rest.
        </p>
      </div>
    `,
  });

  if (error) {
    console.error("Resend error:", error);
    return null;
  }

  return data;
}
