import Anthropic from "@anthropic-ai/sdk";
import { SYSTEM_PROMPT } from "./prompt.ts";

export type ReplyKind = "reply" | "refusal" | "fallback";

export interface LlmEnv {
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_BASE_URL?: string; // optional: a gateway in front of the API
  ANTHROPIC_MODEL: string;
  REFUSAL_TEXT: string;
  FALLBACK_TEXT: string;
}

// Generates the next line from the conversation so far. Returns a fixed
// deflection when Claude declines (that is the desired outcome for 18+ content,
// which is why no fallback model is configured here), and a fixed fallback line
// when the API is unavailable, so the friend still hears something.
export async function generateReply(env: LlmEnv, history: Anthropic.MessageParam[], maxChars: number): Promise<{ text: string; kind: ReplyKind }> {
  if (!env.ANTHROPIC_API_KEY) return { text: env.FALLBACK_TEXT, kind: "fallback" };
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, ...(env.ANTHROPIC_BASE_URL ? { baseURL: env.ANTHROPIC_BASE_URL } : {}) });
  try {
    const response = await client.messages.create({
      model: env.ANTHROPIC_MODEL,
      max_tokens: 300, // deliberately short: it is spoken, and it is billed per character downstream
      output_config: { effort: "low" },
      system: SYSTEM_PROMPT,
      messages: history,
    });
    if (response.stop_reason === "refusal") return { text: env.REFUSAL_TEXT, kind: "refusal" };
    let text = response.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join(" ").trim();
    text = text.replace(/\s+/g, " ");
    if (!text) return { text: env.FALLBACK_TEXT, kind: "fallback" };
    if (text.length > maxChars) text = trimToSentence(text, maxChars);
    return { text, kind: "reply" };
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError) console.error("claude: rate limited");
    else if (e instanceof Anthropic.AuthenticationError) console.error("claude: bad API key");
    else if (e instanceof Anthropic.APIError) console.error(`claude: api error ${e.status}: ${e.message}`);
    else console.error("claude: request failed:", (e as Error).message);
    return { text: env.FALLBACK_TEXT, kind: "fallback" };
  }
}

// Cut at the last sentence end before the limit, so a truncated reply still ends
// like speech rather than mid-word.
export function trimToSentence(text: string, max: number): string {
  if (text.length <= max) return text;
  const slice = text.slice(0, max);
  const end = Math.max(slice.lastIndexOf(". "), slice.lastIndexOf("! "), slice.lastIndexOf("? "), slice.lastIndexOf(".") , slice.lastIndexOf("!"), slice.lastIndexOf("?"));
  return (end > max * 0.4 ? slice.slice(0, end + 1) : slice.replace(/\s+\S*$/, "")).trim();
}
