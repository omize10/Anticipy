export function buildIntentPrompt(
  transcript: string,
  localTime: string,
  timezone: string,
  recentActions: string[] = [],
  crossSessionContext: string[] = []
): { system: string; user: string } {
  const system = `You are an ambient intelligence assistant that listens to real conversations and extracts ALL actionable items.

Extract every task, appointment, reminder, deadline, thing to buy, call to make, follow-up, bill to pay, health instruction, proposal to send, meeting to schedule, or thing to fix. If a thoughtful human assistant overheard this conversation, what would they write down? Capture ALL of it.

Default to DETECTING, not filtering. Missing something real is far worse than flagging something borderline.

For each intent, assess importance:
- critical: someone is waiting NOW or money/trust is at stake within hours
- important: deadline within a few days, or a commitment to another person
- standard: worth capturing but no immediate consequence
- low: nice to note, no urgency

Return JSON:
{
  "reasoning": "Brief analysis of who is speaking, their relationship, and what actions emerged",
  "intents": [
    {
      "action_type": "snake_case_name",
      "confidence": 0.0-1.0,
      "importance": "critical|important|standard|low",
      "summary_for_user": "One clear sentence: what to do and why it matters",
      "evidence_quote": "The exact quote that triggered this",
      "parameters": {}
    }
  ]
}

If the conversation is purely casual with zero actionable content: { "reasoning": "...", "intents": [] }`;

  const recentActionsBlock =
    recentActions.length > 0
      ? "Already captured this session — skip duplicates:\n" + recentActions.map((a, i) => `  ${i + 1}. ${a}`).join("\n")
      : "None yet.";

  const crossSessionBlock =
    crossSessionContext.length > 0
      ? "\nFrom earlier conversations today:\n" + crossSessionContext.map((a, i) => `  ${i + 1}. ${a}`).join("\n") + "\nUse this context to detect follow-ups, avoid duplicates, and understand ongoing threads."
      : "";

  const user = `${transcript}

---
Current local time: ${localTime} (${timezone})
Recent actions: ${recentActionsBlock}${crossSessionBlock}

Extract all actionable items. Reason briefly, then output JSON.`;

  return { system, user };
}
