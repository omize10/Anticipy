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

    // Verify session exists and is not already ended — prevents notification spam
    // from arbitrary UUIDs sent by unauthenticated callers.
    const { data: session } = await supabaseAdmin
      .from("anticipy_sessions")
      .select("id, status")
      .eq("id", sessionId)
      .single();

    if (!session) {
      return NextResponse.json(
        { error: "Session not found" },
        { status: 404 }
      );
    }
    if (session.status === "ended") {
      return NextResponse.json(
        { error: "Session already ended" },
        { status: 409 }
      );
    }

    // Resolve local time — guard against invalid timezone strings from client
    let localTime: string;
    try {
      localTime = new Date().toLocaleString("en-US", { timeZone: timezone });
    } catch {
      localTime = new Date().toLocaleString("en-US", {
        timeZone: "America/New_York",
      });
    }

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

    // Build the prompt
    const { system, user } = buildIntentPrompt(
      transcript,
      localTime,
      timezone,
      recentActions
    );

    const llmMessages = [
      { role: "system" as const, content: system },
      { role: "user" as const, content: user },
    ];

    let response: string = "";
    let usedModel = "kimi";

    try {
      response = await callKimi(llmMessages, {
        response_format: { type: "json_object" },
        temperature: 0.1, // Low temperature for reliable structured JSON output
      });
      if (!response || response.trim().length === 0) {
        throw new Error("Kimi returned empty response");
      }
      JSON.parse(response); // Validate JSON; throws → falls through to Groq
    } catch (kimiErr) {
      console.warn("Kimi failed, falling back to Groq:", kimiErr);
      usedModel = "groq";
      try {
        response = await callGroq(llmMessages, {
          temperature: 0.1,
          response_format: { type: "json_object" },
        });
      } catch (groqErr) {
        console.error("Groq fallback also failed:", groqErr);
        // Both models failed — mark session ended and return empty intents
        await supabaseAdmin
          .from("anticipy_sessions")
          .update({ status: "ended" })
          .eq("id", sessionId);
        return NextResponse.json({ intents: [], totalInferred: 0, totalValid: 0 });
      }
    }

    console.log(
      `Intent analysis completed via ${usedModel}, response length: ${response.length}`
    );

    let parsed: { intents: Array<Record<string, unknown>> };
    try {
      parsed = JSON.parse(response);
    } catch {
      console.error(
        "Failed to parse LLM response:",
        response?.substring(0, 200)
      );
      parsed = { intents: [] };
    }

    const intents = parsed.intents ?? [];

    // Filter by confidence threshold
    const validIntents = intents.filter(
      (i) => typeof i.confidence === "number" && i.confidence >= 0.7
    );

    // Store intents in Supabase and dispatch notifications
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

      // Importance-based notification dispatch:
      // critical → voice + SMS + email
      // important/standard → SMS + email
      // low → email only
      const importance = intent.importance as string;
      const notifyEmail =
        process.env.TEST_USER_EMAIL || "omar@anticipy.ai";
      const baseUrl =
        process.env.NEXT_PUBLIC_SITE_URL ||
        (process.env.VERCEL_URL
          ? `https://${process.env.VERCEL_URL}`
          : "http://localhost:3000");

      // Email for ALL importance levels
      const emailResult = await sendIntentEmail(
        notifyEmail,
        {
          intentId: data.id,
          summary: intent.summary_for_user as string,
          evidenceQuote: intent.evidence_quote as string,
          importance,
          actionType: intent.action_type as string,
        },
        baseUrl
      );

      if (emailResult) {
        await supabaseAdmin.from("anticipy_notifications").insert({
          intent_id: data.id,
          channel: "email",
          recipient: notifyEmail,
          status: "sent",
        });
      }

      // SMS + Voice for non-low importance levels
      const notifyPhone = process.env.TEST_USER_PHONE;
      if (notifyPhone && importance !== "low") {
        await sendTwilioNotification(
          notifyPhone,
          intent.summary_for_user as string,
          importance,
          data.id
        );
      }
    }

    // Mark session as ended
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
    return NextResponse.json(
      { error: "Analysis failed. Please try again." },
      { status: 500 }
    );
  }
}
