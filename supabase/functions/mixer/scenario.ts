// A whole event from doors open to the wipe, driven only through the API.
// The same scenario runs in the tests (against the in-memory stand-in) and in
// scripts/simulate.ts (against a live test event), so the two cannot drift.
// It resets the event it runs on: never point it at an event people are using.
// deno-lint-ignore-file no-explicit-any

export type Call = (action: string, body?: Record<string, unknown>) => Promise<any>;

export type ScenarioOptions = {
  /** Calls the API. Must throw an Error with a `code` when the API answers with an error. */
  call: Call;
  code: string;
  pin: string;
  /** A host email for this event, or "" when the hosts table is empty. */
  email: string;
  guests?: number;
  /** Leaves the running timer with about this many seconds, 0 meaning it has run out. */
  jump: (secondsLeft: number) => Promise<void>;
  log?: (line: string) => void;
};

const EXPERIENCE = ["daily", "daily", "daily", "regular", "regular", "occasional", "new"];
const ROLES = ["engineering", "engineering", "data", "product", "design", "leadership", "student"];
const TOPICS = [
  ["Who answers for it when an AI agent gets it wrong?", "Will AI change what a junior job looks like?", "How far should we trust an answer we can't check?", "What should schools teach now?", "Does Claude make us sharper or lazier?"],
  ["Your best prompt habit", "What do you hand to Claude, and what do you keep?", "Setting up a project so Claude knows your work", "Checking Claude's work without redoing it", "The tool you built in an afternoon"],
  ["The oddest thing you have asked Claude", "Claude as a holiday planner", "If Claude had a favourite Cape Town coffee", "Worst autocorrect of your life", "A film Claude should star in"],
];

async function refused(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (e) {
    return String((e as { code?: string }).code ?? "error");
  }
  return "";
}

/** Runs a few calls at a time, so a live run stays within what the network allows. */
async function inBatches<T, R>(items: T[], size: number, run: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...(await Promise.all(items.slice(i, i + size).map((item, j) => run(item, i + j)))));
  }
  return out;
}

export async function runEvent(o: ScenarioOptions) {
  const N = o.guests ?? 70;
  const SIZE = 6;
  const log = o.log ?? (() => {});
  const check = (cond: unknown, msg: string) => {
    if (!cond) throw new Error("CHECK FAILED: " + msg);
    log("ok  " + msg);
  };
  const host = (action: string, body: Record<string, unknown> = {}) => o.call("host." + action, { code: o.code, pin: o.pin, email: o.email, ...body });
  const sizesOf = (state: any): number[] => state.room.map((t: any) => t.guests.length);

  // ----- set up -----
  await host("reset", { confirm: "RESET" });
  await host("setSignups", { clear: true }).catch(() => {});
  let state = await host("setup", {
    totalRounds: 3, tableSize: SIZE, tableCount: Math.max(4, Math.ceil(N / SIZE) + 2), voteSeconds: 60, roundMinutes: 20, roomMinutes: 10, votesEach: 2,
    groupNames: ["Serious", "Practical", "Fun"],
  });
  state = await host("setTopics", { topics: TOPICS.flatMap((list, g) => list.map((text) => ({ group: g + 1, text }))) });
  check(state.event.phase === "lobby" && state.guests.length === 0, "starts empty with doors open");
  check(state.topics.length === 15 && state.event.groupNames.join() === "Serious,Practical,Fun", "three groups of prepared topics");

  check((await refused(() => o.call("host.state", { code: o.code, pin: "0000000", email: o.email }))) === "bad_login", "a wrong PIN is refused");
  if (o.email) {
    check((await refused(() => o.call("host.state", { code: o.code, pin: o.pin, email: "someone.else@example.com" }))) === "bad_login", "the right PIN with an email that is not a host's is refused");
  }

  // ----- sign-up list -----
  const people = Array.from({ length: N }, (_, i) => ({
    email: `guest${i + 1}@example.com`,
    firstName: `Guest ${i + 1}`,
    experience: EXPERIENCE[i % EXPERIENCE.length],
    willHost: i % 5 < 2,
    role: ROLES[(i * 3) % ROLES.length],
    question: `Question from guest ${i + 1}?`,
  }));
  state = await host("setSignups", { rows: people });
  check(state.signups.total === N && state.signups.offeredToHost === people.filter((p) => p.willHost).length, `${N} sign-ups loaded with their details`);
  check((await o.call("info", { code: o.code })).asksEmail === true, "the sign-in page asks for the registration email");
  check((await refused(() => o.call("join", { code: o.code, name: "Nomail" }))) === "bad_email", "signing in without an email is refused");
  check((await refused(() => o.call("join", { code: o.code, name: "Typo", email: "typo@example.com" }))) === "email_not_found", "an email that is not on the list is questioned");

  // ----- arrivals: a table straight away, and it never changes -----
  const tokens: string[] = [];
  const firstTable = new Map<string, number>();
  await inBatches(people, 1, async (p, i) => {
    const d = await o.call("join", { code: o.code, name: p.firstName, email: p.email.toUpperCase(), deviceId: `sim-${i}` });
    tokens[i] = d.token;
  });
  let views: any[] = await inBatches(tokens, 4, (token) => o.call("view", { token }));
  check(views.every((v) => v.table && v.table.number >= 1), "every guest has a table the moment they sign in");
  views.forEach((v, i) => firstTable.set(tokens[i], v.table.number));
  state = await host("state");
  check(state.guests.length === N && state.signups.arrived === N, `${N} guests checked in and matched to the sign-up list`);
  let sizes = sizesOf(state);
  check(Math.max(...sizes) <= SIZE && sizes.filter((s) => s < SIZE).length <= 2, `tables fill to ${SIZE} with at most two part-filled: ${sizes.join(" ")}`);
  check(state.guests.filter((g: any) => g.willHost).length === people.filter((p) => p.willHost).length, "the offer to host a table came across from the sign-up");

  const again = await o.call("join", { code: o.code, name: " guest 1 ", email: "guest1@example.com", deviceId: "another-phone" });
  check(again.token === tokens[0], "signing in again with the same name and email returns the same guest");
  check((await refused(() => o.call("join", { code: o.code, name: "Someone Else", email: "guest1@example.com" }))) === "name_mismatch", "the same email with a different name is refused");

  const walkIn = await o.call("join", { code: o.code, name: "Walk-in", email: "walkin@example.com", anyway: true, deviceId: "walk-in" });
  tokens.push(walkIn.token);
  state = await host("state");
  check(state.signups.notOnList === 1, "a guest who is not on the list gets in and is flagged to the host");

  // ----- topics from the room -----
  await o.call("suggest", { token: tokens[1], text: "Is writing prompts a real skill?" });
  const v1 = await o.call("view", { token: tokens[1] });
  check(v1.topics.mine.length === 1 && v1.topics.mine[0].status === "pending", "a suggested topic waits for a host");
  state = await host("state");
  const pending = state.topics.find((t: any) => t.status === "pending");
  check(pending && pending.group == null, "the host sees the suggestion with no group yet");
  state = await host("updateTopic", { topicId: pending.id, status: "approved", group: 1 });
  check(state.topics.filter((t: any) => t.group === 1 && t.status === "approved").length === 6, "approving it adds it to the first group");

  // ----- three rounds -----
  const tablesByGuest = new Map<string, number[]>();
  for (let round = 1; round <= 3; round++) {
    if (round === 1) {
      state = await host("advance", { fromPhase: "lobby", fromRound: 0 });
      check(state.event.phase === "vote" && state.event.round === 1, "round 1 voting is open");
      views = await inBatches(tokens, 4, (token) => o.call("view", { token }));
      const moved = views.filter((v, i) => firstTable.has(tokens[i]) && v.table.number !== firstTable.get(tokens[i]));
      check(moved.length <= 4 && moved.every((v) => v.table.moved), `locking in round 1 moved ${moved.length} people, and told them`);
      sizes = sizesOf(state);
      check(Math.max(...sizes) <= SIZE + 1 && sizes.filter((s) => s <= 3).length <= 1, `round 1 tables: ${sizes.join(" ")}`);
    } else {
      check(state.event.phase === "seating" && state.event.round === round, `round ${round} tables are out`);
      sizes = sizesOf(state);
      check(Math.max(...sizes) - Math.min(...sizes) <= 1 && Math.max(...sizes) <= SIZE + 1, `round ${round} tables are even: ${sizes.join(" ")}`);
      views = await inBatches(tokens, 4, (token) => o.call("view", { token }));
      check(views.every((v) => v.table && typeof v.table.newFaces === "number"), `round ${round}: every guest has a new table and a count of new faces`);
      state = await host("advance", { fromPhase: "seating", fromRound: round });
      check(state.event.phase === "vote", `round ${round} voting is open`);
      views = await inBatches(tokens, 4, (token) => o.call("view", { token }));
    }
    check(state.tablesWithoutHost === 0, `round ${round}: every table has a host`);
    for (let i = 0; i < tokens.length; i++) {
      const list = tablesByGuest.get(tokens[i]) ?? [];
      list.push(views[i].table.number);
      tablesByGuest.set(tokens[i], list);
    }

    // voting
    const ballot = views[0].vote;
    check(ballot.options.length === state.topics.filter((t: any) => t.group === round && t.status === "approved").length, `round ${round}: phones list the "${state.round.group}" topics`);
    check(ballot.options.every((opt: any) => !("votes" in opt)) && views[0].round.top.length === 0, "phones show no vote counts");
    check((await refused(() => o.call("vote", { token: tokens[0], topicIds: ballot.options.slice(0, 3).map((x: any) => x.id) }))) === "bad_vote", "more than two votes are refused");
    const voters = tokens.slice(0, Math.floor(tokens.length * 0.8));
    await inBatches(voters, 4, (token, i) => {
      // Skewed on purpose, so there is a clear order.
      const a = ballot.options[i % 3 === 0 ? 0 : i % ballot.options.length].id;
      const b = ballot.options[(i * 7 + 1) % ballot.options.length].id;
      return o.call("vote", { token, topicIds: a === b ? [a] : [a, b] });
    });
    let screen = await o.call("room", { code: o.code });
    check(screen.vote.voted === voters.length && screen.vote.of === tokens.length, `the big screen shows ${voters.length} of ${tokens.length} have voted`);
    check(screen.vote.options.some((x: any) => x.votes > 0), "the big screen shows the counts");
    const lead = [...screen.vote.options].sort((a: any, b: any) => b.votes - a.votes)[0];

    if (round === 2) {
      state = await host("advance", { fromPhase: "vote", fromRound: round });
    } else {
      await o.jump(0);
      screen = await o.call("room", { code: o.code });
      state = await host("state");
    }
    check(state.event.phase === "wheel", round === 2 ? "the host can end voting early" : "voting ends by itself when the time is up");
    check(state.round.top.length === 3 && state.round.top[0].id === lead.id, "the top three go on the wheel, most votes first");
    check((await refused(() => host("advance", { fromPhase: "wheel", fromRound: round }))) === "not_spun", "the round cannot start before the wheel is spun");
    state = await host("spin");
    const chosen = state.round.topic;
    check(chosen && state.round.top.some((t: any) => t.text === chosen), `the wheel picked one of the three: "${chosen}"`);
    state = await host("spin");
    check(state.round.topic === chosen, "a second spin changes nothing");

    // table discussion
    state = await host("advance", { fromPhase: "wheel", fromRound: round });
    check(state.event.phase === "table" && state.event.endsAt, "the table discussion is running on a timer");
    check((await refused(() => host("advance", { fromPhase: "wheel", fromRound: round }))) === "stale", "a repeated press is refused");
    views = await inBatches(tokens, 4, (token) => o.call("view", { token }));
    check(views.every((v) => v.round.topic === chosen), "every phone shows the chosen topic");
    const hosts = views.filter((v) => v.table.iAmHost);
    check(hosts.length === state.room.length && views.every((v) => v.table.host), "each table has one host, and everyone at the table can see who");

    if (round === 2) {
      // someone arrives late, and a table host leaves
      const late = await o.call("join", { code: o.code, name: "Late", email: "late@example.com", anyway: true, deviceId: "late" });
      tokens.push(late.token);
      check((await o.call("view", { token: late.token })).table, "a latecomer gets a table straight away");
      const goneHost = state.guests.find((g: any) => g.isHost);
      state = await host("markLeft", { guestId: goneHost.id });
      const table = state.room.find((t: any) => t.number === goneHost.table) ?? state.room[0];
      check(state.guests.find((g: any) => g.id === goneHost.id).left && !table.guests.some((g: any) => g.name === goneHost.name), "a guest marked as gone leaves their table");
      state = await host("markLeft", { guestId: goneHost.id, left: false });
    }

    // room discussion
    if (round === 1) {
      await o.jump(0);
      await o.call("room", { code: o.code });
      state = await host("state");
      check(state.event.phase === "room", "the room discussion opens by itself when the table time is up");
    } else {
      state = await host("advance", { fromPhase: "table", fromRound: round });
      check(state.event.phase === "room", "the host can open the room discussion early");
    }
    await inBatches(tokens.slice(0, 20), 4, (token, i) => o.call("rate", { token, up: i % 5 !== 0 }));
    state = await host("state");
    const result = state.results.find((r: any) => r.round === round);
    check(result.up === 16 && result.down === 4 && result.topic === chosen, "thumbs up and down are counted for the host");
    check((await o.call("view", { token: tokens[0] })).rating.mine === false, "a guest sees their own rating");

    state = await host("advance", { fromPhase: "room", fromRound: round });
  }
  check(state.event.phase === "finished", "the event finishes after the last room discussion");
  const revisits = [...tablesByGuest.values()].filter((l) => new Set(l).size !== l.length).length;
  // A small room has too few tables for everyone to get a new number every round.
  check(revisits <= (N >= 40 ? 2 : N / 2), `${revisits} guests sat at the same table number twice`);
  check(state.repeatPairs <= (N >= 40 ? Math.ceil(N / 5) : N), `${state.repeatPairs} pairs shared a table more than once`);
  check((await o.call("view", { token: tokens[0] })).event.phase === "finished", "phones show the closing screen");

  // ----- practice event with pretend guests -----
  const practice = await host("practice", { guests: 30 });
  const pcode = practice.practiceCode;
  const phost = (action: string, body: Record<string, unknown> = {}) => o.call("host." + action, { code: pcode, pin: o.pin, email: o.email, ...body });
  let p = await phost("state");
  check(p.event.practice && p.guests.length === 30 && p.guests.every((g: any) => g.bot && g.table), "the practice event has 30 pretend guests, each with a table");
  check(p.topics.filter((t: any) => t.status === "approved").length >= 15, "the practice event has the same topics");
  check((await refused(() => host("addBots", { count: 5 }))) === "not_practice", "pretend guests cannot be added to the real event");
  p = await phost("advance", { fromPhase: "lobby", fromRound: 0 });
  const realState = await host("state");
  check(realState.event.phase === "finished" && realState.guests.every((g: any) => !g.bot), "practising does not touch the real event");
  state = await host("practice", { guests: 0 });
  check(state.practiceCode === pcode, "the practice event can be started afresh");

  // ----- afterwards -----
  state = await host("wipe", { confirm: "DELETE" });
  check(state.guests.length === 0 && state.signups.total === 0 && state.event.phase === "lobby" && state.practiceCode == null, "deleting attendee data removes every guest, the sign-up list and the practice event");
  check(state.topics.length === 15, "the prepared topics are kept");
  return { pcode };
}
