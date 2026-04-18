import { NextResponse } from "next/server";
import { callKimi } from "@/lib/kimi";
import { callGroq } from "@/lib/groq";
import { callGemini } from "@/lib/gemini";
import { buildIntentPrompt } from "@/lib/intent-prompt";
import { sendIntentEmail } from "@/lib/resend-notify";
import { sendTwilioNotification } from "@/lib/twilio-notify";
import { supabaseAdmin } from "@/lib/supabase-admin";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const { sessionId, transcript, timezone = "America/Vancouver", isFinal = true } =
      await req.json();

    if (!transcript || !sessionId) {
      return NextResponse.json(
        { error: "Missing transcript or sessionId" },
        { status: 400 }
      );
    }

    // Verify session exists — prevents notification spam from arbitrary UUIDs.
    // Only block if already ended AND this is the final call (periodic mid-recording
    // calls are allowed to run multiple times on the same session).
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
    if (isFinal && session.status === "ended") {
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

    // Gemini Flash first (GOOGLE_API_KEY confirmed on Vercel), Groq second, Kimi third
    const models = [
      { name: "gemini", fn: () => callGemini(llmMessages, { temperature: 0.0, max_tokens: 8192 }) },
      { name: "groq", fn: () => callGroq(llmMessages, { temperature: 0.0, response_format: { type: "json_object" }, max_tokens: 8192 }) },
      { name: "kimi", fn: () => callKimi(llmMessages, { response_format: { type: "json_object" }, temperature: 0.0, max_tokens: 8192 }) },
    ];

    for (const model of models) {
      try {
        response = await model.fn();
        if (!response || response.trim().length === 0) throw new Error(`${model.name} empty`);
        JSON.parse(response);
        usedModel = model.name;
        break;
      } catch (err) {
        console.warn(`${model.name} failed:`, err instanceof Error ? err.message : err);
        if (model.name === models[models.length - 1].name) {
          console.error("All models failed");
          if (isFinal) {
            await supabaseAdmin.from("anticipy_sessions").update({ status: "ended" }).eq("id", sessionId);
          }
          return NextResponse.json({ intents: [], totalInferred: 0, totalValid: 0 });
        }
      }
    }

    console.log(
      `Intent analysis completed via ${usedModel}, response length: ${response.length}`
    );

    let parsed: { reasoning?: string; intents: Array<Record<string, unknown>> };
    try {
      parsed = JSON.parse(response);
    } catch {
      console.error(
        "Failed to parse LLM response:",
        response?.substring(0, 200)
      );
      parsed = { intents: [] };
    }

    // Log the model's reasoning for debugging and quality monitoring
    if (parsed.reasoning) {
      console.log(`[${usedModel}] Intent reasoning:\n${parsed.reasoning}`);
    }

    const intents = parsed.intents ?? [];

    // Filter by confidence threshold
    const validIntents = intents.filter(
      (i) => typeof i.confidence === "number" && i.confidence >= 0.5
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

      // Broadcast to extension via Supabase Realtime (bypasses RLS — works with anon key)
      const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
      const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (supabaseUrl && serviceKey) {
        fetch(`${supabaseUrl}/realtime/v1/api/broadcast`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            apikey: serviceKey,
            Authorization: `Bearer ${serviceKey}`,
          },
          body: JSON.stringify({
            messages: [{
              topic: "anticipy-intents",
              event: "new_intent",
              payload: {
                id: data.id,
                action_type: intent.action_type,
                importance: intent.importance,
                confidence: intent.confidence,
                summary_for_user: intent.summary_for_user,
                evidence_quote: intent.evidence_quote,
                status: "pending",
              },
            }],
          }),
        }).catch((e) => console.warn("[broadcast] failed:", e.message));
      }

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

    // Mark session as ended only on final analysis (not on periodic mid-recording calls)
    if (isFinal) {
      await supabaseAdmin
        .from("anticipy_sessions")
        .update({ status: "ended" })
        .eq("id", sessionId);
    }

    return NextResponse.json({
      intents: storedIntents,
      totalInferred: intents.length,
      totalValid: validIntents.length,
      _debug: { model: usedModel, responseLength: response?.length ?? 0, reasoning: parsed.reasoning?.substring(0, 200) },
    });
  } catch (err) {
    console.error("Analyze error:", err);
    return NextResponse.json(
      { error: "Analysis failed. Please try again." },
      { status: 500 }
    );
  }
}
// cache bust 1776487693
