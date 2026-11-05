// Live 0G test using non-health prompts only. Saves results without keys or content beyond the short answers.
import { writeFileSync } from "node:fs";
import { answerSchema, createZg, parseLabel, sealedChat } from "../src/zg/sealed.js";

const zg = createZg();
const LABELS = ["yes", "no", "unclear"] as const;
const results: Record<string, unknown> = {};
const prompt = [
  { role: "system" as const, content: 'Reply with JSON only: {"answer":"yes"|"no"|"unclear"}.' },
  { role: "user" as const, content: "Series: 1, 2, 3, 4, 5. Is this series rising?" },
];

async function run(name: string, fn: () => Promise<unknown>) {
  try {
    results[name] = { ok: true, ...(await fn() as object) };
  } catch (e: any) {
    results[name] = { ok: false, status: e.status, code: e.code ?? e.error?.code, message: String(e.message).slice(0, 300) };
  }
  console.log(name, JSON.stringify(results[name]));
}

await run("1_sealed_basic", () => sealedChat(zg, { messages: [{ role: "user", content: "Say the word ready." }], max_tokens: 200 }));
await run("2_sealed_verify_tee", () => sealedChat(zg, { messages: [{ role: "user", content: "Say the word ready." }], max_tokens: 200, verify_tee: true }));
await run("3_schema_64_tokens", async () => {
  const r = await sealedChat(zg, { messages: prompt, max_tokens: 64, response_format: answerSchema(LABELS) });
  return { ...r, parsed: parseLabel(r.content, LABELS) };
});
await run("4_schema_thinking_off", async () => {
  const r = await sealedChat(zg, { messages: prompt, max_tokens: 64, response_format: answerSchema(LABELS), chat_template_kwargs: { enable_thinking: false } });
  return { ...r, parsed: parseLabel(r.content, LABELS) };
});
await run("5_four_concurrent", async () => {
  const started = Date.now();
  const all = await Promise.all([1, 2, 3, 4].map(() => sealedChat(zg, { messages: prompt, max_tokens: 64, response_format: answerSchema(LABELS), chat_template_kwargs: { enable_thinking: false } })));
  return { wallMs: Date.now() - started, latencies: all.map((r) => r.latencyMs), parsed: all.map((r) => parseLabel(r.content, LABELS)), requestIds: all.map((r) => r.requestId) };
});

writeFileSync("test-results/0g.json", JSON.stringify(results, null, 2));
