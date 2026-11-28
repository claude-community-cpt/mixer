import { expect, test } from "bun:test";
import { ApiError, dispatch, hostEmailHash, pinHash } from "./app.ts";
import { FakeDb } from "./fakedb.ts";
import { type Call, runEvent } from "./scenario.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

async function setUp(code: string, pin: string, email: string) {
  const db = new FakeDb();
  await db.from("events").insert({ code, name: "Test event", host_pin_hash: await pinHash(code, pin) });
  await db.from("hosts").insert({ email_hash: await hostEmailHash(email), label: "Test host" });
  const call: Call = async (action, body = {}) => {
    try {
      // Through JSON, as over the network.
      return JSON.parse(JSON.stringify(await dispatch(db as Any, JSON.parse(JSON.stringify({ action, ...body })))));
    } catch (e) {
      if (e instanceof ApiError) throw Object.assign(new Error(`${action}: ${e.code} ${e.message}`), { code: e.code });
      throw e;
    }
  };
  // Moves the running timer, the way waiting would.
  const jump = (secondsLeft: number) => {
    for (const ev of db.data.events) {
      if (ev.round_ends_at) ev.round_ends_at = new Date(Date.now() + (secondsLeft > 0 ? secondsLeft * 1000 : -1000)).toISOString();
    }
    return Promise.resolve();
  };
  return { db, call, jump };
}

test("a whole event for 70 guests, from doors open to the wipe", async () => {
  const { db, call, jump } = await setUp("test", "1234", "host@example.com");
  const lines: string[] = [];
  await runEvent({ call, code: "test", pin: "1234", email: "host@example.com", guests: 70, jump, log: (l) => lines.push(l) });
  expect(lines.length).toBeGreaterThan(60);
  // Nothing readable is kept: no address anywhere in what was stored.
  expect(JSON.stringify(db.data)).not.toContain("@example.com");
}, 60_000);

test("a smaller room works too", async () => {
  const { call, jump } = await setUp("small", "1234", "host@example.com");
  await runEvent({ call, code: "small", pin: "1234", email: "host@example.com", guests: 23, jump });
}, 60_000);

test("pretend guests vote and rate by themselves in a practice event", async () => {
  const { call, jump } = await setUp("real", "1234", "host@example.com");
  const auth = { pin: "1234", email: "host@example.com" };
  await call("host.setup", { code: "real", ...auth, tableCount: 8 });
  for (const group of [1, 2, 3]) {
    for (const n of [1, 2, 3, 4]) await call("host.addTopic", { code: "real", ...auth, group, text: `Topic ${group}.${n}` });
  }
  const { practiceCode } = await call("host.practice", { code: "real", ...auth, guests: 24 });
  const host = (action: string, body = {}) => call("host." + action, { code: practiceCode, ...auth, ...body });
  let state = await host("state");
  expect(state.topics.filter((t: Any) => t.status === "pending").length).toBeGreaterThan(0);
  state = await host("advance", { fromPhase: "lobby", fromRound: 0 });
  expect(state.vote.voted).toBe(0);
  await jump(2); // nearly out of time, so most have voted by now
  state = await host("state");
  expect(state.vote.voted).toBeGreaterThan(15);
  await jump(0);
  state = await host("state");
  expect(state.event.phase).toBe("wheel");
  expect(state.round.top.length).toBe(3);
  state = await host("spin");
  state = await host("advance", { fromPhase: "wheel", fromRound: 1 });
  state = await host("advance", { fromPhase: "table", fromRound: 1 });
  await jump(2);
  state = await host("state");
  expect(state.results[0].up + state.results[0].down).toBeGreaterThan(15);
  // a real person can join the practice event next to the pretend ones
  const me = await call("join", { code: practiceCode, name: "Dan" });
  expect((await call("view", { token: me.token })).table.number).toBeGreaterThan(0);
});
