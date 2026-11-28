// Runs a whole event against the live API with fake guests: sign-up list,
// arrivals, topics, three rounds of vote, wheel, table and room discussion,
// a practice event, then deletes everything it made.
//
// It RESETS the event it runs on. Only ever point it at a test event.
//
// Usage:
//   API_URL=https://<project-ref>.supabase.co/functions/v1/mixer \
//     EVENT_CODE=e2e HOST_EMAIL=<a host's email> HOST_PIN=<pin> GUESTS=70 bun scripts/simulate.ts
import { runEvent } from "../supabase/functions/mixer/scenario.ts";

const API = process.env.API_URL!;
const code = process.env.EVENT_CODE ?? "";
const pin = process.env.HOST_PIN!;
const email = process.env.HOST_EMAIL ?? "";
const guests = Number(process.env.GUESTS ?? 70);
if (!API || !code || !pin) throw new Error("Set API_URL, EVENT_CODE, HOST_EMAIL and HOST_PIN");
if (code === "coffee" || code === "demo") throw new Error(`"${code}" is a real event. Use a test event.`);

async function call(action: string, body: Record<string, unknown> = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(API, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, ...body }) });
      const json = await res.json();
      if (json.error) throw Object.assign(new Error(`${action}: ${json.error.code} ${json.error.message}`), { code: json.error.code });
      return json.data;
    } catch (e) {
      // Retry network hiccups, never an answer from the API.
      if ((e as { code?: string }).code || attempt >= 4) throw e;
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
}

// Shortens the running timer through the host page's own "take time off" action.
async function jump(secondsLeft: number) {
  for (const c of [code, `${code}-practice`]) {
    const state = await call("host.state", { code: c, pin, email }).catch(() => null);
    if (!state?.event.endsAt) continue;
    const left = (new Date(state.event.endsAt).getTime() - new Date(state.event.serverNow).getTime()) / 1000;
    await call("host.addTime", { code: c, pin, email, seconds: Math.round(secondsLeft - left) });
  }
  // The server never leaves less than five seconds, so wait those out.
  if (secondsLeft <= 0) await new Promise((r) => setTimeout(r, 6500));
}

const t0 = Date.now();
await runEvent({ call, code, pin, email, guests, jump, log: console.log });
console.log(`ALL GOOD in ${Math.round((Date.now() - t0) / 1000)} s`);
