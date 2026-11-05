// Non-health diagnostic. Prints status, routing headers and trace only, never the key.
const KEY = process.env.ZG_SK!;
async function call(label: string, model: string, headers: Record<string,string>, path = "/chat/completions", body?: object) {
  const t = Date.now();
  try {
    const r = await fetch(`https://router-api.0g.ai/v1${path}`, { method: "POST",
      headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json", ...headers },
      body: JSON.stringify(body ?? { model, messages: [{ role: "user", content: "Say the word ready." }], max_tokens: 200, temperature: 0 }),
      signal: AbortSignal.timeout(120000) });
    const text = await r.text(); let j: any = {}; try { j = JSON.parse(text); } catch {}
    console.log(label, JSON.stringify({ status: r.status, ms: Date.now() - t, e2ee: r.headers.get("x-0g-e2ee"), provider: r.headers.get("x-provider"),
      err: j.error ? (j.error.code ?? j.error.message ?? j.error) : undefined, msg: r.ok ? undefined : text.slice(0, 200),
      content: j.choices?.[0]?.message?.content?.slice(0, 60), trace: j.x_0g_trace ? { request_id: j.x_0g_trace.request_id, provider: j.x_0g_trace.provider, tee_verified: j.x_0g_trace.tee_verified } : undefined }));
  } catch (e: any) { console.log(label, "threw", String(e.message).slice(0, 200)); }
}
const P = { "X-0G-Provider-Trust-Mode": "private" };
await call("a private+required 0gm", "0gm-1.0-35b-a3b", { ...P, "X-0G-Encrypted-Transit": "required" });
await call("b private default 0gm", "0gm-1.0-35b-a3b", P);
await call("c private transit off 0gm", "0gm-1.0-35b-a3b", { ...P, "X-0G-Encrypted-Transit": "off" });
await call("d private+required sia", "0gm-1.0-35b-a3b-sia", { ...P, "X-0G-Encrypted-Transit": "required" });
await call("e private default sia", "0gm-1.0-35b-a3b-sia", P);
