// Non-health probe of POST /v1/decisions. Prints status, seal header, shape; never the key.
const KEY = process.env.ZG_SK!;
const state = "Daily values: 1, 2, 3, 4, 5, 6, 7.";
const shapes: any[] = [
  [{ id: "trend", type: "choice", question: "Is this series rising?", options: ["yes", "no", "unclear"] }],
  [{ key: "trend", type: "choice", text: "Is this series rising?", choices: ["yes", "no", "unclear"] }],
  { trend: { type: "choice", question: "Is this series rising?", options: ["yes", "no", "unclear"] } },
];
for (const model of ["vela-2.0-9b", "laya"]) for (const questions of shapes) {
  const t = Date.now();
  try {
    const r = await fetch("https://router-api.0g.ai/v1/decisions", { method: "POST",
      headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json", "X-0G-Provider-Trust-Mode": "private" },
      body: JSON.stringify({ model, state, questions }), signal: AbortSignal.timeout(90000) });
    const text = await r.text();
    console.log(model, JSON.stringify({ status: r.status, ms: Date.now() - t, e2ee: r.headers.get("x-0g-e2ee"), body: text.slice(0, 500) }));
    if (r.ok) break;
  } catch (e: any) { console.log(model, "threw", String(e.message).slice(0, 150)); }
}
