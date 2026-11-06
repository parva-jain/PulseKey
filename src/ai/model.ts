// model: one swap point for "a model that reads a person's data inside a sealed enclave". 0G Private Computer
// in production; "off" when 0G is unavailable, which makes every AI feature report itself unavailable. There is
// deliberately no fallback to an ordinary model: health data only ever goes to the sealed path.
import type OpenAI from "openai";
import { createZg, sealedChat, ZG_MODEL } from "../zg/sealed.js";

export type SealedReply = { content: string; requestId: string | null; provider: string | null; model: string; costMicroUsd: number | null };

export type ChatRequest = {
  messages: OpenAI.Chat.ChatCompletionMessageParam[];
  max_tokens: number;
  response_format?: unknown;
  /** Lets the model reason before answering. Needs a far larger max_tokens, or the reply comes back empty. */
  thinking?: boolean;
};

export interface SealedModel {
  name: "0g" | "off" | "scripted";
  /** Resolves only for a sealed reply. Anything else throws, and callers treat that as unavailable. */
  chat(req: ChatRequest): Promise<SealedReply>;
}

export class SealedUnavailable extends Error {}

export function zgModel(): SealedModel {
  const zg = createZg();
  return {
    name: "0g",
    async chat(req) {
      const { thinking, ...body } = req;
      const r = await sealedChat(zg, { ...body, chat_template_kwargs: { enable_thinking: !!thinking } });
      return { content: r.content, requestId: r.requestId, provider: r.provider, model: ZG_MODEL, costMicroUsd: r.costMicroUsd === null ? null : Number(r.costMicroUsd) };
    },
  };
}

export const offModel: SealedModel = {
  name: "off",
  chat: async () => { throw new SealedUnavailable("sealed AI is off"); },
};

/** For tests: answers come from a function, nothing leaves the process. */
export function scriptedModel(reply: (req: ChatRequest, n: number) => string): SealedModel & { calls: ChatRequest[] } {
  const calls: ChatRequest[] = [];
  return {
    name: "scripted",
    calls,
    async chat(req) {
      calls.push(req);
      return { content: reply(req, calls.length), requestId: `req-${calls.length}`, provider: "0xscripted", model: "scripted", costMicroUsd: 1 };
    },
  };
}

export function modelFromEnv(): SealedModel {
  const which = process.env.SEALED ?? "0g";
  if (which === "off") return offModel;
  if (which === "0g") return zgModel();
  throw new Error(`SEALED must be 0g or off, got ${which}`);
}
