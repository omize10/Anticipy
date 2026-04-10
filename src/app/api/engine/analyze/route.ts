import { NextResponse } from "next/server";
import { callKimi } from "@/lib/kimi";
import { callGroq } from "@/lib/groq";
import { buildIntentPrompt } from "@/lib/intent-prompt";
import { sendIntentEmail } from "@/lib/resend-notify";
import { sendTwilioNotification } from "@/lib/twilio-notify";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const { sessionId, transcript, timezone = "America/Vancouver" } =
      await req.json();

    if (!transcript || !sessionId) {
      return NextResponse.json(
        { error: "Missing transcript or sessionId" },
        { status: 400 }
      );
    }

    const localTime = new Date().toLocaleString("en-US", {
      timeZone: timezone,
    });

    // Get recent actions from this session
    const { data: recentIntents } = await supabaseAdmin
      .from("anticipy_intents")
      .select("summary_for_user")
      .eq("session_id", sessionId)
      .order("created_at", { ascending: false })
      .limit(5);

    const recentActions = (recentIntents ?? []).map(
      (i) => i.summary_for_user
    );

    // Build the prompt and call Groq
    const { system, user } = buildIntentPrompt(
      transcript,
      localTime,
      timezone,
      recentActions
    );

    // Kimi K2.5 primary, Groq fallback
    let response: string;
    try {
      response = await callKimi(
        [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        {
          // Kimi K2.5 only accepts temperature=1
          response_format: { type: "json_object" },
        }
      );
    } catch (kimiErr) {
      console.warn("Kimi failed, falling back to Groq:", kimiErr);
      response = await callGroq(
        [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        {
          temperature: 0.1,
          response_format: { type: "json_object" },
        }
      );
    }

    let parsed: { intents: Array<Record<string, unknown>> };
    try {
      parsed = JSON.parse(response);
    } catch {
      console.error("Failed to parse Groq response:", response);
      parsed = { intents: [] };
    }

    const intents = parsed.intents ?? [];

    // Filter by confidence threshold
    const validIntents = intents.filter(
      (i) => typeof i.confidence === "number" && i.confidence >= 0.7
    );

    // Store intents in Supabase
    const storedIntents = [];
    for (const intent of validIntents) {
      const { data, error } = await supabaseAdmin
        .from("anticipy_intents")
        .insert({
          session_id: sessionId,
          action_type: intent.action_type as string,
          parameters: intent.parameters ?? {},
          confidence: intent.confidence as number,
          importance: intent.importance as string,
          summary_for_user: intent.summary_for_user as string,
          evidence_quote: intent.evidence_quote as string,
          status: "pending",
        })
        .select("id")
        .single();

      if (error) {
        console.error("Insert intent error:", error);
        continue;
      }

      const intentWithId = { ...intent, id: data.id };
      storedIntents.push(intentWithId);

      // Send email notification
      const notifyEmail =
        process.env.TEST_USER_EMAIL || "omar@anticipy.ai";
      const baseUrl =
        process.env.NEXT_PUBLIC_SITE_URL ||
        (process.env.VERCEL_URL
          ? `https://${process.env.VERCEL_URL}`
          : "http://localhost:3000");

      const emailResult = await sendIntentEmail(notifyEmail, {
        intentId: data.id,
        summary: intent.summary_for_user as string,
        evidenceQuote: intent.evidence_quote as string,
        importance: intent.importance as string,
        actionType: intent.action_type as string,
      }, baseUrl);

      if (emailResult) {
        await supabaseAdmin.from("anticipy_notifications").insert({
          intent_id: data.id,
          channel: "email",
          recipient: notifyEmail,
          status: "sent",
        });
      }

      // Send SMS/Voice notification via Twilio (mock mode if no credentials)
      const notifyPhone = process.env.TEST_USER_PHONE;
      if (notifyPhone) {
        await sendTwilioNotification(
          notifyPhone,
          intent.summary_for_user as string,
          intent.importance as string,
          data.id
        );
      }
    }

    // Update session status
    await supabaseAdmin
      .from("anticipy_sessions")
      .update({ status: "ended" })
      .eq("id", sessionId);

    return NextResponse.json({
      intents: storedIntents,
      totalInferred: intents.length,
      totalValid: validIntents.length,
    });
  } catch (err) {
    console.error("Analyze error:", err);
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
