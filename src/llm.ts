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
export async function generateReply(env: LlmEnv, history: Anthropic.MessageParam[], maxChars: number, profile = ""): Promise<{ text: string; kind: ReplyKind }> {
  if (!env.ANTHROPIC_API_KEY) return { text: env.FALLBACK_TEXT, kind: "fallback" };
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, ...(env.ANTHROPIC_BASE_URL ? { baseURL: env.ANTHROPIC_BASE_URL } : {}) });
  try {
    const response = await client.messages.create({
      model: env.ANTHROPIC_MODEL,
      // Room for adaptive thinking plus the reply. The spoken text is capped separately
      // (MAX_REPLY_CHARS), so this ceiling costs nothing downstream. 300 was enough for
      // Opus 5 but Opus 5.5 thinks longer and got cut off mid-word.
      max_tokens: 1024,
      output_config: { effort: "low" },
      system: profile ? `${SYSTEM_PROMPT}\n\nWhat you already know about him from earlier conversations (use it naturally, do not recite it, and do not ask again about things listed here):\n${profile}` : SYSTEM_PROMPT,
      messages: history,
    });
    if (response.stop_reason === "refusal") return { text: env.REFUSAL_TEXT, kind: "refusal" };
    let text = response.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join(" ").trim();
    text = text.replace(/\s+/g, " ");
    // Hit the token ceiling: the last sentence is unfinished. Speak only the complete
    // ones rather than stopping mid-word.
    if (response.stop_reason === "max_tokens") text = completeSentences(text);
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

// Keep everything up to the last sentence end; empty if there is none.
export function completeSentences(text: string): string {
  const end = Math.max(text.lastIndexOf("."), text.lastIndexOf("!"), text.lastIndexOf("?"));
  return end >= 0 ? text.slice(0, end + 1).trim() : "";
}

// Long-term memory. The recent chat is kept only as a window of turns, so every
// few messages Claude folds what was learned about the friend into a short
// profile that is kept indefinitely and goes into every reply.
const PROFILE_MAX_CHARS = 1500;
export async function updateProfile(env: LlmEnv, profile: string, recent: Anthropic.MessageParam[]): Promise<string | undefined> {
  if (!env.ANTHROPIC_API_KEY) return undefined;
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, ...(env.ANTHROPIC_BASE_URL ? { baseURL: env.ANTHROPIC_BASE_URL } : {}) });
  const transcript = recent.map((m) => `${m.role === "user" ? "HIM" : "YAZHINI"}: ${typeof m.content === "string" ? m.content : "[message]"}`).join("\n");
  try {
    const r = await client.messages.create({
      model: env.ANTHROPIC_MODEL,
      max_tokens: 1024,
      output_config: { effort: "low" },
      system: `You maintain a short memory file about one person, Raagul, from his chats with Yazhini. Merge the existing notes with anything new he revealed about himself in the recent chat: likes and dislikes, food, films, music, family, friends, home town, memories, plans, feelings, things he asked her to remember, running jokes, and topics already asked about. Keep facts he stated; do not invent or guess. Drop nothing still true; replace anything he corrected. Output only the updated notes as short English bullet lines, at most ${PROFILE_MAX_CHARS} characters in total.`,
      messages: [{ role: "user", content: `EXISTING NOTES:\n${profile || "(none yet)"}\n\nRECENT CHAT:\n${transcript}` }],
    });
    const text = r.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("").trim();
    return text ? text.slice(0, PROFILE_MAX_CHARS) : undefined;
  } catch (e) {
    console.warn("profile update failed:", (e as Error).message);
    return undefined;
  }
}
