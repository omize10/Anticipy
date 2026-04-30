import { NextResponse } from "next/server";
import { callKimi } from "@/lib/kimi";
import { callGroq } from "@/lib/groq";
import { callGemini } from "@/lib/gemini";
import { buildIntentPrompt } from "@/lib/intent-prompt";
import { sendIntentEmail } from "@/lib/resend-notify";
import { sendTwilioNotification } from "@/lib/twilio-notify";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { requireSupabaseUser } from "@/lib/require-auth";

export const dynamic = "force-dynamic";

// Action types that represent conversational back-and-forth, not real future tasks.
// These are dropped before insertion regardless of LLM confidence.
const IGNORED_ACTION_TYPES = new Set([
  "confirm_item_possession",
  "clarify_status",
  "email_subject_instruction",
  "email_instruction",
  "check_email_flagging",
  "send_email_instruction",
  "confirm_status",
  "answer_question",
  "acknowledge",
  "small_talk",
]);

const CONFIDENCE_THRESHOLD = 0.65;
const SUMMARY_OVERLAP_THRESHOLD = 0.8;

function tokenize(text: string): string[] {
  const words = (text || "")
    .toLowerCase()
    .split(/\W+/)
    .filter((w: string) => w.length > 2);
  // Deduplicate without Set iteration
  const seen: Record<string, boolean> = {};
  return words.filter((w: string) => {
    if (seen[w]) return false;
    seen[w] = true;
    return true;
  });
}

function jaccardSimilarity(a: string, b: string): number {
  const wordsA = tokenize(a);
  const wordsB = tokenize(b);
  if (wordsA.length === 0 || wordsB.length === 0) return 0;
  const setB: Record<string, boolean> = {};
  wordsB.forEach((w: string) => { setB[w] = true; });
  let intersection = 0;
  wordsA.forEach((w: string) => { if (setB[w]) intersection += 1; });
  const union = wordsA.length + wordsB.length - intersection;
  return union === 0 ? 0 : intersection / union;
}

interface ExistingIntent {
  action_type: string | null;
  summary_for_user: string | null;
  evidence_quote: string | null;
}

function isDuplicateOfExisting(
  candidate: { action_type: string; summary_for_user: string; evidence_quote: string },
  existing: ExistingIntent[]
): boolean {
  for (const e of existing) {
    const sameType = e.action_type === candidate.action_type;
    const summarySim = jaccardSimilarity(
      candidate.summary_for_user,
      e.summary_for_user || ""
    );
    if (summarySim >= SUMMARY_OVERLAP_THRESHOLD) return true;
    if (sameType) {
      const evidenceSim = jaccardSimilarity(
        candidate.evidence_quote,
        e.evidence_quote || ""
      );
      // Same action_type + similar evidence quote → duplicate
      if (evidenceSim >= 0.6) return true;
      // Same action_type + moderately similar summary → duplicate
      if (summarySim >= 0.5) return true;
    }
  }
  return false;
}

export async function POST(req: Request) {
  const authedUser = await requireSupabaseUser(req);
  if (!authedUser) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const { sessionId, transcript, timezone = "America/Vancouver", isFinal = true } =
      await req.json();
    // Email recipient is the authenticated user — never trust a client-supplied address.
    const user_email = authedUser.email;

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

    // Get recent actions from this session — fetch full set for both LLM context and server-side dedup
    const { data: recentIntents } = await supabaseAdmin
      .from("anticipy_intents")
      .select("action_type, summary_for_user, evidence_quote")
      .eq("session_id", sessionId)
      .order("created_at", { ascending: false })
      .limit(50);

    const sessionExistingIntents: ExistingIntent[] = recentIntents ?? [];
    const recentActions = sessionExistingIntents
      .slice(0, 10)
      .map((i) => i.summary_for_user || "")
      .filter(Boolean);

    // Cross-session memory: fetch intents from user's other sessions in past 24h
    let crossSessionContext: string[] = [];
    try {
      const twentyFourHoursAgo = new Date(
        Date.now() - 24 * 60 * 60 * 1000
      ).toISOString();

      const { data: userSessions } = await supabaseAdmin
        .from("anticipy_sessions")
        .select("id")
        .eq("user_id", authedUser.id)
        .neq("id", sessionId)
        .gte("started_at", twentyFourHoursAgo)
        .order("started_at", { ascending: false })
        .limit(10);

      if (userSessions && userSessions.length > 0) {
        const otherSessionIds = userSessions.map((s) => s.id);
        const { data: crossIntents } = await supabaseAdmin
          .from("anticipy_intents")
          .select("summary_for_user, action_type, created_at")
          .in("session_id", otherSessionIds)
          .order("created_at", { ascending: false })
          .limit(10);

        crossSessionContext = (crossIntents ?? []).map(
          (i) => "[" + i.action_type + "] " + i.summary_for_user
        );
      }
    } catch (err) {
      console.warn("Cross-session memory query failed:", err);
    }

    // Build the prompt
    const { system, user } = buildIntentPrompt(
      transcript,
      localTime,
      timezone,
      recentActions,
      crossSessionContext
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

    // Filter by confidence threshold and drop conversational/non-actionable types
    const validIntents = intents.filter((i) => {
      if (typeof i.confidence !== "number" || i.confidence < CONFIDENCE_THRESHOLD) return false;
      const actionType = String(i.action_type || "").toLowerCase();
      if (IGNORED_ACTION_TYPES.has(actionType)) return false;
      const summary = String(i.summary_for_user || "").trim();
      if (!summary) return false;
      return true;
    });

    // Track intents already stored in this same request so a single batch can't introduce dupes
    const insertedThisCall: ExistingIntent[] = [];

    // Store intents in Supabase and dispatch notifications
    const storedIntents = [];
    let skippedDuplicates = 0;
    for (const intent of validIntents) {
      const candidate = {
        action_type: String(intent.action_type || ""),
        summary_for_user: String(intent.summary_for_user || ""),
        evidence_quote: String(intent.evidence_quote || ""),
      };

      // Server-side fuzzy dedup against intents already in this session (and this batch).
      // Periodic auto-analysis re-processes the growing transcript, so the LLM frequently
      // re-emits the same intent — block it before it ever reaches the DB or notifications.
      const allExisting = [...sessionExistingIntents, ...insertedThisCall];
      if (isDuplicateOfExisting(candidate, allExisting)) {
        skippedDuplicates += 1;
        console.log(
          `[dedup] Skipping duplicate intent: ${candidate.action_type} - ${candidate.summary_for_user.substring(0, 60)}`
        );
        continue;
      }

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
      insertedThisCall.push(candidate);

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
      const adminEmail = "omar@anticipy.ai";
      const baseUrl =
        process.env.NEXT_PUBLIC_SITE_URL ||
        (process.env.VERCEL_URL
          ? `https://${process.env.VERCEL_URL}`
          : "http://localhost:3000");

      const intentPayload = {
        intentId: data.id,
        summary: intent.summary_for_user as string,
        evidenceQuote: intent.evidence_quote as string,
        importance,
        actionType: intent.action_type as string,
      };

      if (user_email) {
        const userEmailResult = await sendIntentEmail(user_email, intentPayload, baseUrl);
        if (userEmailResult) {
          await supabaseAdmin.from("anticipy_notifications").insert({
            intent_id: data.id,
            channel: "email",
            recipient: user_email,
            status: "sent",
          });
        }

        const adminEmailResult = await sendIntentEmail(
          adminEmail,
          intentPayload,
          baseUrl,
          `[Admin] User (${user_email}):`
        );
        if (adminEmailResult) {
          await supabaseAdmin.from("anticipy_notifications").insert({
            intent_id: data.id,
            channel: "email",
            recipient: adminEmail,
            status: "sent",
          });
        }
      } else {
        const emailResult = await sendIntentEmail(
          user_email || adminEmail, intentPayload, baseUrl);
        if (emailResult) {
          await supabaseAdmin.from("anticipy_notifications").insert({
            intent_id: data.id,
            channel: "email",
            recipient: adminEmail,
            status: "sent",
          });
        }
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
      totalSkippedDuplicates: skippedDuplicates,
      _debug: {
        model: usedModel,
        responseLength: response?.length ?? 0,
        reasoning: parsed.reasoning?.substring(0, 200),
        skippedDuplicates,
      },
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
