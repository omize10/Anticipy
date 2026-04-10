import { supabaseAdmin } from "./supabase-admin";

const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_PHONE = process.env.TWILIO_PHONE_NUMBER;

// Mock mode: active when credentials are missing or explicitly set
const MOCK_MODE = !TWILIO_SID || !TWILIO_TOKEN || !TWILIO_PHONE || process.env.TWILIO_MOCK === "true";

interface TwilioResult {
  success: boolean;
  sid?: string;
  mock?: boolean;
  error?: string;
}

/**
 * Send SMS notification. Falls back to mock/log mode when Twilio credentials are unavailable.
 */
export async function sendSMS(
  to: string,
  body: string,
  intentId?: string
): Promise<TwilioResult> {
  if (MOCK_MODE) {
    console.log(`[TWILIO MOCK] SMS to ${to}: ${body}`);

    // Record the mock notification in Supabase
    if (intentId) {
      try {
        await supabaseAdmin.from("anticipy_notifications").insert({
          intent_id: intentId,
          channel: "sms",
          recipient: to,
          status: "mock_sent",
        });
      } catch { /* non-critical */ }
    }

    return { success: true, sid: `MOCK_SM_${Date.now()}`, mock: true };
  }

  try {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`;
    const auth = Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString("base64");

    const params = new URLSearchParams({
      To: to,
      From: TWILIO_PHONE!,
      Body: body,
    });

    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Twilio SMS error ${res.status}: ${err}`);
    }

    const data = await res.json();

    // Record the notification
    if (intentId) {
      await supabaseAdmin.from("anticipy_notifications").insert({
        intent_id: intentId,
        channel: "sms",
        recipient: to,
        status: "sent",
      });
    }

    return { success: true, sid: data.sid };
  } catch (err) {
    const message = err instanceof Error ? err.message : "SMS send failed";
    console.error("Twilio SMS error:", message);
    return { success: false, error: message };
  }
}

/**
 * Initiate a voice call with a TwiML message. Falls back to mock mode when credentials are unavailable.
 */
export async function sendVoiceCall(
  to: string,
  message: string,
  intentId?: string
): Promise<TwilioResult> {
  if (MOCK_MODE) {
    console.log(`[TWILIO MOCK] Voice call to ${to}: ${message}`);

    if (intentId) {
      await supabaseAdmin.from("anticipy_notifications").insert({
        intent_id: intentId,
        channel: "voice",
        recipient: to,
        status: "mock_sent",
      });
    }

    return { success: true, sid: `MOCK_CA_${Date.now()}`, mock: true };
  }

  try {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Calls.json`;
    const auth = Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString("base64");

    // Use TwiML to speak the message
    const twiml = `<Response><Say voice="alice">${escapeXml(message)}</Say><Pause length="1"/><Say voice="alice">Reply yes to confirm or no to skip.</Say></Response>`;

    const params = new URLSearchParams({
      To: to,
      From: TWILIO_PHONE!,
      Twiml: twiml,
    });

    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Twilio Voice error ${res.status}: ${err}`);
    }

    const data = await res.json();

    if (intentId) {
      await supabaseAdmin.from("anticipy_notifications").insert({
        intent_id: intentId,
        channel: "voice",
        recipient: to,
        status: "sent",
      });
    }

    return { success: true, sid: data.sid };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Voice call failed";
    console.error("Twilio Voice error:", message);
    return { success: false, error: message };
  }
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Send notification via the user's preferred channel.
 * Tries SMS first, then voice for critical importance.
 */
export async function sendTwilioNotification(
  to: string,
  summary: string,
  importance: string,
  intentId?: string
): Promise<TwilioResult> {
  // Always send SMS
  const smsBody = `Anticipy: ${summary}\n\nReply YES to confirm or NO to skip.`;
  const smsResult = await sendSMS(to, smsBody, intentId);

  // For critical items, also call
  if (importance === "critical") {
    await sendVoiceCall(to, summary, intentId);
  }

  return smsResult;
}
