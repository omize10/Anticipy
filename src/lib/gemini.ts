const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY ?? "";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GOOGLE_API_KEY}`;

interface GeminiMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export async function callGemini(
  messages: GeminiMessage[],
  options: { temperature?: number; max_tokens?: number } = {}
): Promise<string> {
  const { temperature = 0.0, max_tokens = 8192 } = options;

  const systemMsg = messages.find((m) => m.role === "system")?.content ?? "";
  const userMsgs = messages.filter((m) => m.role !== "system");

  const res = await fetch(GEMINI_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: systemMsg }] },
      contents: userMsgs.map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      })),
      generationConfig: {
        temperature,
        maxOutputTokens: max_tokens,
        responseMimeType: "application/json",
      },
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini error ${res.status}: ${err.substring(0, 200)}`);
  }

  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
}
