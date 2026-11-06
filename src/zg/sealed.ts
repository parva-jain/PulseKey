import OpenAI from "openai";

export const ZG_BASE_URL = "https://router-api.0g.ai/v1";
export const ZG_MODEL = process.env.ZG_MODEL ?? "0gm-1.0-35b-a3b";

export class NotSealedError extends Error {}

export function createZg(apiKey = process.env.ZG_SK) {
  if (!apiKey) throw new Error("ZG_SK is not set");
  return new OpenAI({
    baseURL: ZG_BASE_URL,
    apiKey,
    timeout: 120_000,
    maxRetries: 0,
    defaultHeaders: {
      "X-0G-Provider-Trust-Mode": "private",
      "X-0G-Encrypted-Transit": "required",
    },
  });
}

export type SealedResult = {
  content: string;
  requestId: string | null;
  provider: string | null;
  sealed: boolean;
  teeVerified: boolean | null;
  costMicroUsd: number | null;
  latencyMs: number;
};

type ChatBody = {
  messages: OpenAI.Chat.ChatCompletionMessageParam[];
  max_tokens: number;
  response_format?: unknown;
  chat_template_kwargs?: unknown;
  verify_tee?: boolean;
};

// Refuses any answer that did not take the sealed path. Never logs messages or content.
// Thinking is off unless the caller turns it on: with it on, short budgets are spent on reasoning and the
// answer comes back empty (seen live on 2026-11-06 at 64 and 200 tokens).
export async function sealedChat(zg: OpenAI, body: ChatBody, model = ZG_MODEL): Promise<SealedResult> {
  const started = Date.now();
  const { data, response } = await zg.chat.completions
    .create({ model, temperature: 0, stream: false, chat_template_kwargs: { enable_thinking: false }, ...body } as any)
    .withResponse();
  const sealed = response.headers.get("x-0g-e2ee") === "sealed";
  if (!sealed) throw new NotSealedError(`x-0g-e2ee=${response.headers.get("x-0g-e2ee")}`);
  const trace = (data as any).x_0g_trace ?? {};
  return {
    content: (data as any).choices?.[0]?.message?.content ?? "",
    requestId: trace.request_id ?? null,
    provider: trace.provider ?? null,
    sealed,
    // The router's trace carries no TEE verdict today (only billing, provider, request_id), so this stays null.
    teeVerified: typeof trace.tee_verified === "boolean" ? trace.tee_verified : null,
    costMicroUsd: trace.billing?.total_cost_usd_micro ?? null,
    latencyMs: Date.now() - started,
  };
}

export const answerSchema = (labels: readonly string[]) => ({
  type: "json_schema",
  json_schema: {
    name: "answer",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["answer"],
      properties: { answer: { type: "string", enum: labels } },
    },
  },
});

// Strict on purpose: anything other than {"answer":"<allowed label>"} is rejected.
export function parseLabel<T extends string>(text: string, labels: readonly T[]): T | null {
  let value: any;
  try {
    value = JSON.parse(text.trim());
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== "answer") return null;
  return labels.includes(value.answer) ? value.answer : null;
}
