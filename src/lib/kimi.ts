const KIMI_API_KEY = process.env.KIMI_API_KEY!;
const KIMI_URL = "https://api.moonshot.ai/v1/chat/completions";

interface KimiMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export async function callKimi(
  messages: KimiMessage[],
  options: {
    model?: string;
    temperature?: number;
    max_tokens?: number;
    response_format?: { type: string };
  } = {}
): Promise<string> {
  const {
    model = "kimi-k2.5",
    temperature = 1,
    max_tokens = 4096,
    response_format,
  } = options;

  const body: Record<string, unknown> = {
    model,
    messages,
    temperature,
    max_tokens,
  };

  if (response_format) {
    body.response_format = response_format;
  }

  // 90-second timeout — Kimi K2.5 is a reasoning model (~70s typical)
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90_000);

  const res = await fetch(KIMI_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${KIMI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: controller.signal,
  });

  clearTimeout(timeout);

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Kimi error ${res.status}: ${err}`);
  }

  const data = await res.json();
  return data.choices[0]?.message?.content ?? "";
}
