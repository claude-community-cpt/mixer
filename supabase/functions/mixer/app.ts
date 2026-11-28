// Table Mixer API: every action the pages can ask for. index.ts wraps this in
// the Edge Function's one POST endpoint.
// Guests are identified by a random token, hosts by their email and the event
// PIN. Browsers never read or write the database directly.
//
// An event moves through these phases. Rounds 2 and later start at "seating".
//   lobby    doors open: guests sign in, get their round 1 table, suggest topics
//   seating  new tables are out for this round
//   vote     the room votes on this round's group of topics (timed)
//   wheel    voting is closed, the top three are on the wheel
//   table    table discussion on the chosen topic (timed)
//   room     open discussion with the whole room, optional thumbs up or down
//   finished
// "vote" and "table" end by themselves when their time is up: the first
// request after the deadline moves the event on (see tick), so every phone
// follows whether or not its owner did anything.
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.45.4";
import {
  assignRound,
  metPairs,
  type Person,
  pickHosts,
  type Seated,
  seatArrival,
  seatLate,
  settle,
  tablesNeeded,
} from "./assign.ts";
import { emailFingerprint, extractEmails, normaliseEmail } from "./emails.ts";

// Read through globalThis so the tests, which run outside Deno, can load this file.
const env = (name: string): string => (globalThis as { Deno?: { env: { get(n: string): string | undefined } } }).Deno?.env.get(name) ?? "";
const SUPABASE_URL = env("SUPABASE_URL");
// Also keys the email fingerprints. The tests have no key and use a fixed one.
const SERVICE_KEY = env("SUPABASE_SERVICE_ROLE_KEY") || "test-key";

export class ApiError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message);
  }
}

const MAX_NAME = 20;
const MAX_TOPIC = 120;
const MAX_GUESTS = 200;
const MAX_PER_DEVICE = 3;
const MAX_SIGNUPS = 2000;
const MAX_SIGNUP_TEXT = 400_000;
const MAX_TOPICS = 200;
const MAX_SUGGESTIONS = 3;
const MAX_BOTS = 120;
const TOP_N = 3;
const PIN_TRIES = 5;
const PIN_LOCK_MINUTES = 5;
const EXPERIENCE = ["daily", "regular", "occasional", "new"];
// Small on purpose: the host can rename or remove anyone from the host page.
const BLOCKED = ["fuck", "shit", "cunt", "bitch", "nigg", "fag", "poes", "naai", "kak"];

// Only the query builder is used, so tests can pass a stand-in (see fakedb.ts).
export type Db = Pick<SupabaseClient, "from">;
// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

function clean(s: unknown, max: number): string {
  return String(s ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function pinHash(code: string, pin: string): Promise<string> {
  return sha256(`${code}:${pin}`);
}

/** The hash kept in the hosts table in place of a host's email. */
export function hostEmailHash(email: string): Promise<string> {
  return sha256(`host:${email}`);
}

/** A stable number between 0 and 1 for a string. Used where "random" must come out the same on every request. */
function fraction(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  return (h >>> 0) / 4294967296;
}

async function must<T>(p: PromiseLike<{ data: T | null; error: { message: string } | null }>): Promise<T> {
  const { data, error } = await p;
  if (error) throw new ApiError("db", error.message, 500);
  return data as T;
}

async function getEvent(db: Db, code: unknown): Promise<Row> {
  const c = clean(code, 40).toLowerCase();
  if (!c) throw new ApiError("no_event", "Missing event code");
  const ev = await must(db.from("events").select("*").eq("code", c).maybeSingle());
  if (!ev) throw new ApiError("no_event", "We couldn't find that event", 404);
  return ev as Row;
}

async function notify(code: string) {
  if (!SUPABASE_URL) return; // tests
  try {
    await fetch(`${SUPABASE_URL}/realtime/v1/api/broadcast`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
      body: JSON.stringify({ messages: [{ topic: `event:${code}`, event: "changed", payload: { at: Date.now() } }] }),
    });
  } catch (_) {
    // Pages also poll, so a missed ping only delays an update.
  }
}

// ---------- loading ----------

const loadTables = async (db: Db, eventId: string) =>
  (await must(db.from("tables").select("*").eq("event_id", eventId).order("number"))) as Row[];
const loadGuests = async (db: Db, eventId: string) =>
  (await must(db.from("guests").select("*").eq("event_id", eventId).order("joined_at").order("id"))) as Row[];
const loadSeats = async (db: Db, eventId: string) => (await must(db.from("seats").select("*").eq("event_id", eventId))) as Row[];
const loadTopics = async (db: Db, eventId: string) =>
  (await must(db.from("topics").select("*").eq("event_id", eventId).order("position").order("created_at").order("id"))) as Row[];
const loadRounds = async (db: Db, eventId: string) => (await must(db.from("rounds").select("*").eq("event_id", eventId))) as Row[];
const loadVotes = async (db: Db, eventId: string, round: number) =>
  (await must(db.from("topic_votes").select("guest_id, topic_id").eq("event_id", eventId).eq("round", round))) as Row[];

/** The round whose tables people are sitting at. In the lobby that is already round 1. */
function seatingRound(ev: Row): number {
  return Math.max(1, ev.round);
}

function groupName(ev: Row, round: number): string {
  const names = Array.isArray(ev.group_names) ? ev.group_names : [];
  return clean(names[round - 1], 30) || `Round ${round}`;
}

function eventPublic(ev: Row) {
  return {
    code: ev.code,
    name: ev.name,
    phase: ev.phase,
    round: ev.round,
    totalRounds: ev.total_rounds,
    roundMinutes: ev.round_minutes,
    roomMinutes: ev.room_minutes,
    voteSeconds: ev.vote_seconds,
    votesEach: ev.votes_each,
    tableSize: ev.table_size,
    groupNames: Array.from({ length: ev.total_rounds }, (_, i) => groupName(ev, i + 1)),
    endsAt: ev.round_ends_at,
    feedbackUrl: ev.feedback_url,
    cardLine: ev.card_line ?? null,
    practice: !!ev.practice_of,
    serverNow: new Date().toISOString(),
  };
}

/** What everyone may know about the current round: its group, the top three once voting closes, the topic once the wheel has spun. */
function roundPublic(ev: Row, rounds: Row[], topics: Row[], withVotes: boolean) {
  const number = seatingRound(ev);
  const row = rounds.find((r) => r.round === ev.round);
  const text = new Map(topics.map((t) => [t.id, t.text as string]));
  return {
    number,
    group: groupName(ev, number),
    top: ((row?.top_ids as string[]) ?? []).map((id, i) => ({
      id,
      text: text.get(id) ?? "",
      ...(withVotes ? { votes: (row!.top_votes as number[])[i] ?? 0 } : {}),
    })),
    topicId: row?.topic_id ?? null,
    topic: row?.topic_text ?? null,
    spunAt: row?.spun_at ?? null,
  };
}

// ---------- seating ----------

function toPeople(guests: Row[], seats: Row[], beforeRound: number): Map<string, Person> {
  const byGuest = new Map<string, Row[]>();
  for (const s of seats) {
    if (!byGuest.has(s.guest_id)) byGuest.set(s.guest_id, []);
    byGuest.get(s.guest_id)!.push(s);
  }
  const out = new Map<string, Person>();
  for (const g of guests) {
    const mine = byGuest.get(g.id) ?? [];
    out.set(g.id, {
      id: g.id,
      experience: g.experience,
      role: g.role_group,
      interest: g.interest,
      willHost: !!g.will_host,
      hosted: mine.filter((s) => s.is_host && s.round < beforeRound).length,
      history: Array.from({ length: Math.max(0, beforeRound - 1) }, (_, i) => mine.find((s) => s.round === i + 1)?.table_number ?? null),
      pinnedTable: g.pinned_table,
    });
  }
  return out;
}

/** Everyone active and seated in a round, as the seating functions want them. */
function seatedIn(round: number, active: Row[], seats: Row[]): Seated[] {
  const people = toPeople(active, seats, round);
  const out: Seated[] = [];
  for (const s of seats) {
    if (s.round !== round) continue;
    const p = people.get(s.guest_id);
    if (p) out.push({ ...p, table: s.table_number });
  }
  return out;
}

/**
 * Gives tables to guests who have none for the current round: on arrival, on
 * being added by a host, or on coming back after being marked as gone.
 */
async function seatGuests(db: Db, ev: Row, newcomers: Row[]) {
  if (ev.phase === "finished" || !newcomers.length) return;
  const round = seatingRound(ev);
  const [tables, guests, seats] = await Promise.all([loadTables(db, ev.id), loadGuests(db, ev.id), loadSeats(db, ev.id)]);
  const numbers = tables.filter((t) => t.open).map((t) => t.number as number);
  if (!numbers.length) return;
  const ids = new Set(newcomers.map((g) => g.id));
  const active = guests.filter((g) => !g.left_at && !ids.has(g.id));
  const seated = seatedIn(round, active, seats);
  const hostAt = new Set(seats.filter((s) => s.round === round && s.is_host && active.some((g) => g.id === s.guest_id)).map((s) => s.table_number));
  const people = toPeople(newcomers, seats, round);
  // The table the latest arrival went to, so people who walk in together are split up.
  let last: number | null = null;
  for (let i = active.length - 1; i >= 0 && last == null; i--) last = seated.find((s) => s.id === active[i].id)?.table ?? null;
  const rows: Row[] = [];
  for (const g of newcomers) {
    const p = people.get(g.id)!;
    let table: number;
    let isHost = false;
    if (ev.phase === "lobby") {
      table = seatArrival(seated, p, { size: ev.table_size, tables: numbers, lastTable: last });
    } else {
      const inUse = [...new Set(seated.map((s) => s.table))].sort((a, b) => a - b);
      table = seatLate(seated, p, inUse.length ? inUse : numbers.slice(0, 1));
      // A table with no host yet gains one if the newcomer offered.
      if (p.willHost && !hostAt.has(table)) {
        isHost = true;
        hostAt.add(table);
      }
    }
    seated.push({ ...p, table });
    last = table;
    rows.push({ event_id: ev.id, round, guest_id: g.id, table_number: table, is_host: isHost, moved: false });
  }
  await must(db.from("seats").upsert(rows, { onConflict: "event_id,round,guest_id" }).select("guest_id"));
}

/**
 * Locks round 1 in: folds a thin last table into the others, seats anyone
 * without a table and names a host for each table. Nobody else moves.
 */
async function lockRoundOne(db: Db, ev: Row) {
  const guests = (await loadGuests(db, ev.id)).filter((g) => !g.left_at);
  let seats = await loadSeats(db, ev.id);
  const unseated = guests.filter((g) => !seats.some((s) => s.round === 1 && s.guest_id === g.id));
  if (unseated.length) {
    await seatGuests(db, ev, unseated);
    seats = await loadSeats(db, ev.id);
  }
  const seated = seatedIn(1, guests, seats);
  const moves = settle(seated, ev.table_size);
  const after = seated.map((s) => ({ ...s, table: moves[s.id] ?? s.table }));
  const hosts = new Set(Object.values(pickHosts(after, Math.floor(fraction(ev.id) * 1e6))));
  const wasMoved = new Set(seats.filter((s) => s.round === 1 && s.moved).map((s) => s.guest_id));
  const rows = after.map((s) => ({
    event_id: ev.id,
    round: 1,
    guest_id: s.id,
    table_number: s.table,
    is_host: hosts.has(s.id),
    moved: s.id in moves || wasMoved.has(s.id),
  }));
  if (rows.length) await must(db.from("seats").upsert(rows, { onConflict: "event_id,round,guest_id" }).select("guest_id"));
}

/** New tables for round 2 and later, worked out from who is still in the room. */
async function assignNextRound(db: Db, ev: Row, round: number) {
  const [tables, allGuests, seats] = await Promise.all([loadTables(db, ev.id), loadGuests(db, ev.id), loadSeats(db, ev.id)]);
  const numbers = tables.filter((t) => t.open).map((t) => t.number as number);
  if (!numbers.length) throw new ApiError("no_tables", "Set the number of tables in Setup first");
  const guests = allGuests.filter((g) => !g.left_at);
  const people = [...toPeople(guests, seats.filter((s) => s.round < round), round).values()];
  const use = numbers.slice(0, tablesNeeded(people.length, ev.table_size, numbers.length));
  const assignment = assignRound(people, use, { seed: round + Math.floor(fraction(ev.id) * 1000) });
  const seated: Seated[] = people.map((p) => ({ ...p, table: assignment[p.id] }));
  const hosts = new Set(Object.values(pickHosts(seated, round + Math.floor(fraction(ev.id) * 1e6))));
  await must(db.from("seats").delete().eq("event_id", ev.id).eq("round", round).select("guest_id"));
  const rows = seated.map((s) => ({ event_id: ev.id, round, guest_id: s.id, table_number: s.table, is_host: hosts.has(s.id), moved: false }));
  if (rows.length) await must(db.from("seats").insert(rows).select("guest_id"));
}

/** If a table's host has gone, hands the job to someone else at the table who offered. */
async function replaceHost(db: Db, ev: Row, goneId: string) {
  const round = seatingRound(ev);
  const seats = await loadSeats(db, ev.id);
  const seat = seats.find((s) => s.round === round && s.guest_id === goneId);
  if (!seat?.is_host) return;
  await must(db.from("seats").update({ is_host: false }).eq("event_id", ev.id).eq("round", round).eq("guest_id", goneId).select("guest_id"));
  if (ev.phase === "lobby") return; // hosts are named when round 1 is locked in
  const guests = (await loadGuests(db, ev.id)).filter((g) => !g.left_at && g.id !== goneId);
  const here = seatedIn(round, guests, seats).filter((s) => s.table === seat.table_number);
  const next = pickHosts(here, round)[seat.table_number];
  if (next) await must(db.from("seats").update({ is_host: true }).eq("event_id", ev.id).eq("round", round).eq("guest_id", next).select("guest_id"));
}

// ---------- phases ----------

/** Moves an event from one phase to the next only if nobody else already has. */
async function step(db: Db, ev: Row, patch: Row): Promise<boolean> {
  const rows = (await must(
    db.from("events").update(patch).eq("id", ev.id).eq("phase", ev.phase).eq("round", ev.round).select("id"),
  )) as Row[];
  return rows.length > 0;
}

const inSeconds = (from: number, seconds: number) => new Date(from + seconds * 1000).toISOString();

async function startVote(db: Db, ev: Row, round: number) {
  const topics = (await loadTopics(db, ev.id)).filter((t) => t.status === "approved" && t.grp === round);
  if (!topics.length) throw new ApiError("no_topics", `Add at least one topic to "${groupName(ev, round)}" first`);
  if (round === 1) await lockRoundOne(db, ev);
  await step(db, ev, { phase: "vote", round, round_ends_at: inSeconds(Date.now(), ev.vote_seconds) });
}

/** Counts the votes and puts the top three on the wheel. Safe to call from several requests at once. */
async function closeVote(db: Db, ev: Row) {
  const [topics, votes] = await Promise.all([loadTopics(db, ev.id), loadVotes(db, ev.id, ev.round)]);
  const counts = new Map<string, number>();
  for (const v of votes) counts.set(v.topic_id, (counts.get(v.topic_id) ?? 0) + 1);
  // Ties are broken the same way on every request, but not by list order.
  const tie = (id: string) => fraction(`${id}:${ev.round}`);
  const top = topics
    .filter((t) => t.status === "approved" && t.grp === ev.round)
    .sort((a, b) => (counts.get(b.id) ?? 0) - (counts.get(a.id) ?? 0) || tie(a.id) - tie(b.id))
    .slice(0, TOP_N);
  await must(
    db.from("rounds").upsert(
      { event_id: ev.id, round: ev.round, top_ids: top.map((t) => t.id), top_votes: top.map((t) => counts.get(t.id) ?? 0) },
      // The first request to close the vote sets the result. Later ones must not undo a spin.
      { onConflict: "event_id,round", ignoreDuplicates: true },
    ).select("round"),
  );
  await step(db, ev, { phase: "wheel", round_ends_at: null });
}

async function spin(db: Db, ev: Row) {
  if (ev.phase !== "wheel") throw new ApiError("stale", "The wheel isn't up right now", 409);
  const row = (await must(db.from("rounds").select("*").eq("event_id", ev.id).eq("round", ev.round).maybeSingle())) as Row | null;
  const ids = (row?.top_ids as string[]) ?? [];
  if (!ids.length) throw new ApiError("no_topics", "There are no topics on the wheel");
  if (row!.spun_at) return;
  const pick = ids[crypto.getRandomValues(new Uint32Array(1))[0] % ids.length];
  const topic = (await must(db.from("topics").select("text").eq("id", pick).maybeSingle())) as Row | null;
  await must(
    db.from("rounds").update({ topic_id: pick, topic_text: topic?.text ?? "", spun_at: new Date().toISOString() })
      .eq("event_id", ev.id).eq("round", ev.round).is("spun_at", null).select("round"),
  );
}

async function openRoom(db: Db, ev: Row, from: number) {
  await step(db, ev, { phase: "room", round_ends_at: inSeconds(from, ev.room_minutes * 60) });
}

/**
 * Moves the event on when a timer has run out, and lets the pretend guests of
 * a practice event act. Called on every read, so it is cheap when there is
 * nothing to do. Returns the event as it now stands.
 */
async function tick(db: Db, ev: Row): Promise<Row> {
  const due = ev.round_ends_at && new Date(ev.round_ends_at).getTime() <= Date.now();
  let changed = false;
  if (ev.phase === "vote" && due) {
    await closeVote(db, ev);
    changed = true;
  } else if (ev.phase === "table" && due) {
    await openRoom(db, ev, new Date(ev.round_ends_at).getTime());
    changed = true;
  } else if (ev.practice_of && (ev.phase === "vote" || ev.phase === "room")) {
    changed = await botsAct(db, ev);
  }
  if (!changed) return ev;
  await notify(ev.code);
  return (await must(db.from("events").select("*").eq("id", ev.id).single())) as Row;
}

async function advance(db: Db, ev: Row, body: Row) {
  // The page sends the phase and round it was looking at, so a double tap or
  // two hosts pressing at once can't skip a step.
  if (body.fromPhase !== ev.phase || Number(body.fromRound) !== ev.round) {
    throw new ApiError("stale", "The event has already moved on. Check the screen and try again.", 409);
  }
  switch (ev.phase) {
    case "lobby":
      return startVote(db, ev, 1);
    case "seating":
      return startVote(db, ev, ev.round);
    case "vote":
      return closeVote(db, ev);
    case "wheel": {
      const row = (await must(db.from("rounds").select("spun_at").eq("event_id", ev.id).eq("round", ev.round).maybeSingle())) as Row | null;
      if (!row?.spun_at) throw new ApiError("not_spun", "Spin the wheel first");
      await step(db, ev, { phase: "table", round_ends_at: inSeconds(Date.now(), ev.round_minutes * 60) });
      return;
    }
    case "table":
      return openRoom(db, ev, Date.now());
    case "room":
      if (ev.round >= ev.total_rounds) {
        await step(db, ev, { phase: "finished", round_ends_at: null });
        return;
      }
      await assignNextRound(db, ev, ev.round + 1);
      await step(db, ev, { phase: "seating", round: ev.round + 1, round_ends_at: null });
      return;
    default:
      throw new ApiError("finished", "This event has finished");
  }
}

// ---------- pretend guests (practice events only) ----------

const BOT_NAMES = [
  "Aisha", "Ben", "Chen", "Dudu", "Emma", "Farid", "Gugu", "Hana", "Imran", "Jo", "Kabelo", "Lin", "Mpho", "Nadia", "Omar",
  "Priya", "Quinn", "Rudi", "Sipho", "Thandi", "Uma", "Vusi", "Wendy", "Xola", "Yusuf", "Zinhle", "Anel", "Bongi", "Cara",
  "Dev", "Elna", "Femi", "Gert", "Hlengi", "Ivan", "Jabu", "Kim", "Lerato", "Mia", "Neo", "Olwethu", "Pieter", "Rania",
  "Sam", "Tumi", "Unathi", "Vera", "Willem", "Yara", "Zak",
];
const BOT_ROLES = ["engineering", "engineering", "engineering", "data", "product", "design", "leadership", "business", "student"];
const BOT_TOPICS = [
  "Is writing prompts a real skill?",
  "What did Claude get badly wrong for you?",
  "The best thing you automated this month",
  "Should AI write our emails for us?",
];

async function addBots(db: Db, ev: Row, wanted: unknown) {
  if (!ev.practice_of) throw new ApiError("not_practice", "Pretend guests can only join a practice event");
  const count = Math.floor(Number(wanted));
  if (!Number.isInteger(count) || count < 1 || count > MAX_BOTS) throw new ApiError("bad_count", `Add between 1 and ${MAX_BOTS} pretend guests`);
  const guests = await loadGuests(db, ev.id);
  if (guests.length + count > MAX_GUESTS) throw new ApiError("full", "This event is full");
  const taken = new Set(guests.map((g) => String(g.name).toLowerCase()));
  const rand = () => crypto.getRandomValues(new Uint32Array(1))[0] / 4294967296;
  const rows: Row[] = [];
  for (let i = 0; i < count; i++) {
    const base = BOT_NAMES[Math.floor(rand() * BOT_NAMES.length)];
    let name = base;
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base} ${n}`;
    taken.add(name.toLowerCase());
    const x = rand();
    rows.push({
      event_id: ev.id,
      name,
      bot: true,
      experience: x < 0.6 ? "daily" : x < 0.8 ? "regular" : x < 0.9 ? "occasional" : "new",
      will_host: rand() < 0.4,
      role_group: BOT_ROLES[Math.floor(rand() * BOT_ROLES.length)],
    });
  }
  const added = (await must(db.from("guests").insert(rows).select("*"))) as Row[];
  await seatGuests(db, ev, added);
  // A couple of them suggest a topic, so there is something to approve.
  if (ev.phase === "lobby") {
    const topics = await loadTopics(db, ev.id);
    const fresh = BOT_TOPICS.filter((t) => !topics.some((x) => x.text === t)).slice(0, Math.min(2, Math.ceil(count / 10)));
    if (fresh.length) {
      await must(
        db.from("topics").insert(fresh.map((text, i) => ({ event_id: ev.id, text, status: "pending", source: "guest", guest_id: added[i % added.length].id }))).select("id"),
      );
    }
  }
}

/** Pretend guests vote and rate a few at a time, so the big screen fills up the way it would on the day. */
async function botsAct(db: Db, ev: Row): Promise<boolean> {
  if (!ev.round_ends_at) return false;
  const span = (ev.phase === "vote" ? ev.vote_seconds : ev.room_minutes * 60) * 1000;
  const elapsed = Math.min(1, Math.max(0, 1 - (new Date(ev.round_ends_at).getTime() - Date.now()) / span));
  const bots = (await must(db.from("guests").select("id").eq("event_id", ev.id).eq("bot", true).is("left_at", null))) as Row[];
  const ready = bots.filter((b) => {
    const f = fraction(`${b.id}:${ev.phase}:${ev.round}`);
    return f < 0.9 && elapsed >= f * 0.7; // one in ten never gets round to it
  });
  if (!ready.length) return false;
  if (ev.phase === "vote") {
    const [topics, votes] = await Promise.all([loadTopics(db, ev.id), loadVotes(db, ev.id, ev.round)]);
    const options = topics.filter((t) => t.status === "approved" && t.grp === ev.round);
    const voted = new Set(votes.map((v) => v.guest_id));
    const rows: Row[] = [];
    for (const b of ready) {
      if (voted.has(b.id) || !options.length) continue;
      // Earlier topics are a little more popular, so there is a clear top three.
      const picks = new Set<string>();
      const wanted = Math.min(options.length, ev.votes_each, fraction(`${b.id}:n:${ev.round}`) < 0.7 ? 2 : 1);
      for (let k = 0; picks.size < wanted && k < 12; k++) {
        const f = fraction(`${b.id}:pick${k}:${ev.round}`);
        picks.add(options[Math.floor(f * f * options.length)].id);
      }
      for (const topic_id of picks) rows.push({ event_id: ev.id, round: ev.round, guest_id: b.id, topic_id });
    }
    if (!rows.length) return false;
    await must(db.from("topic_votes").upsert(rows, { onConflict: "event_id,round,guest_id,topic_id" }).select("guest_id"));
    return true;
  }
  const rated = new Set(((await must(db.from("ratings").select("guest_id").eq("event_id", ev.id).eq("round", ev.round))) as Row[]).map((r) => r.guest_id));
  const rows = ready.filter((b) => !rated.has(b.id)).map((b) => ({
    event_id: ev.id, round: ev.round, guest_id: b.id, up: fraction(`${b.id}:up:${ev.round}`) < 0.85,
  }));
  if (!rows.length) return false;
  await must(db.from("ratings").upsert(rows, { onConflict: "event_id,round,guest_id" }).select("guest_id"));
  return true;
}

// ---------- guests: names and sign-in ----------

function sameName(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, "");
  // "Sam 2" is what a second Sam is called, so "Sam" matches it too.
  return norm(a) === norm(b) || norm(a.replace(/ \d+$/, "")) === norm(b);
}

async function uniqueName(db: Db, eventId: string, wanted: string, exceptId?: string): Promise<string> {
  const guests = await loadGuests(db, eventId);
  const taken = new Set(guests.filter((g) => g.id !== exceptId).map((g) => String(g.name).toLowerCase()));
  if (!taken.has(wanted.toLowerCase())) return wanted;
  for (let n = 2; n < 100; n++) {
    const candidate = `${wanted.slice(0, MAX_NAME - 3)} ${n}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return wanted;
}

function checkName(raw: unknown): string {
  const name = clean(raw, MAX_NAME);
  if (!name) throw new ApiError("bad_name", "Type a first name to join");
  const lower = name.toLowerCase();
  if (BLOCKED.some((w) => lower.includes(w))) throw new ApiError("bad_name", "Please pick a different name");
  return name;
}

async function addGuestRow(db: Db, ev: Row, rawName: unknown, deviceId: string | null, extra: Row = {}): Promise<Row> {
  const guests = await loadGuests(db, ev.id);
  if (guests.length >= MAX_GUESTS) throw new ApiError("full", "This event is full");
  if (deviceId && guests.filter((g) => g.device_id === deviceId).length >= MAX_PER_DEVICE) {
    throw new ApiError("device_limit", "This phone has already joined a few times. Ask the host to add you.");
  }
  const name = await uniqueName(db, ev.id, checkName(rawName));
  const guest = (await must(db.from("guests").insert({ event_id: ev.id, name, device_id: deviceId, ...extra }).select("*").single())) as Row;
  await seatGuests(db, ev, [guest]);
  return guest;
}

// What the sign-in page needs before anyone has joined.
async function info(db: Db, body: Row) {
  const ev = await getEvent(db, body.code);
  return { name: ev.name, phase: ev.phase, practice: !!ev.practice_of, asksEmail: await hasSignups(db, ev.id) };
}

async function join(db: Db, body: Row) {
  const ev = await getEvent(db, body.code);
  if (ev.phase === "finished") throw new ApiError("closed", "This event has finished");
  const deviceId = clean(body.deviceId, 64) || null;
  // With a sign-up list loaded, guests give the address they registered with.
  // It is fingerprinted, compared and thrown away: the address itself is never
  // stored or logged. The fingerprint is what lets the same person sign back in.
  if (!(await hasSignups(db, ev.id))) {
    const guest = await addGuestRow(db, ev, body.name, deviceId);
    await notify(ev.code);
    return { token: guest.token, name: guest.name };
  }
  const email = normaliseEmail(body.email);
  if (!email) throw new ApiError("bad_email", "Type the email address you registered with");
  const name = checkName(body.name);
  const fingerprint = await emailFingerprint(SERVICE_KEY, ev.id, email);

  const findExisting = async () =>
    (await must(db.from("guests").select("*").eq("event_id", ev.id).eq("email_hash", fingerprint).maybeSingle())) as Row | null;
  const comeBack = async (guest: Row) => {
    if (!sameName(guest.name, name)) {
      throw new ApiError("name_mismatch", "That email has already signed in with a different first name. Use the same name as before, or ask a host.");
    }
    if (guest.left_at) {
      await must(db.from("guests").update({ left_at: null }).eq("id", guest.id).select("id"));
      await seatGuests(db, ev, [guest]);
      await notify(ev.code);
    }
    return { token: guest.token, name: guest.name, back: true };
  };
  const existing = await findExisting();
  if (existing) return comeBack(existing);

  const reg = (await must(
    db.from("registrations").select("*").eq("event_id", ev.id).eq("email_hash", fingerprint).maybeSingle(),
  )) as Row | null;
  // A typo should not turn anyone away at the door: the page offers "join
  // anyway", and the host sees who is not on the list.
  if (!reg && body.anyway !== true) {
    throw new ApiError("email_not_found", "We couldn't find that email on the sign-up list. Check it's the one you registered with.");
  }
  let guest: Row;
  try {
    guest = await addGuestRow(db, ev, name, deviceId, {
      registered: !!reg,
      email_hash: fingerprint,
      experience: reg?.experience ?? null,
      will_host: !!reg?.will_host,
      role_group: reg?.role_group ?? null,
      interest: reg?.interest ?? null,
    });
  } catch (e) {
    // Two taps at once: the first one made the guest, so hand that one back.
    const again = await findExisting();
    if (again) return comeBack(again);
    throw e;
  }
  if (reg) {
    await must(db.from("registrations").update({ guest_id: guest.id }).eq("event_id", ev.id).eq("email_hash", fingerprint).select("email_hash"));
  }
  await notify(ev.code);
  return { token: guest.token, name: guest.name };
}

async function guestByToken(db: Db, token: unknown): Promise<{ guest: Row; ev: Row }> {
  const t = clean(token, 64);
  if (!/^[0-9a-f-]{36}$/i.test(t)) throw new ApiError("no_guest", "Please join again", 404);
  const guest = (await must(db.from("guests").select("*").eq("token", t).maybeSingle())) as Row | null;
  if (!guest) throw new ApiError("no_guest", "Please join again", 404);
  const ev = (await must(db.from("events").select("*").eq("id", guest.event_id).single())) as Row;
  return { guest, ev };
}

/** Whether a topic suggested now could still be voted on. */
function suggestionsOpen(ev: Row): boolean {
  if (ev.phase === "finished") return false;
  return ev.phase === "lobby" || ev.phase === "seating" || ev.round < ev.total_rounds;
}

async function view(db: Db, body: Row) {
  const found = await guestByToken(db, body.token);
  const guest = found.guest;
  const ev = await tick(db, found.ev);
  const out: Row = {
    event: eventPublic(ev),
    me: { name: guest.name, left: !!guest.left_at },
    round: null,
    table: null,
    topics: null,
    vote: null,
    rating: null,
  };
  if (ev.phase === "finished" || guest.left_at) return out;
  const round = seatingRound(ev);
  const [guests, seats, topics, rounds] = await Promise.all([loadGuests(db, ev.id), loadSeats(db, ev.id), loadTopics(db, ev.id), loadRounds(db, ev.id)]);
  out.round = roundPublic(ev, rounds, topics, false);

  const mine = seats.find((s) => s.round === round && s.guest_id === guest.id);
  if (mine) {
    const active = new Map(guests.filter((g) => !g.left_at).map((g) => [g.id, g]));
    const here = seats.filter((s) => s.round === round && s.table_number === mine.table_number && s.guest_id !== guest.id && active.has(s.guest_id));
    const metBefore = new Set<string>();
    for (const s of seats) {
      if (s.round >= round || s.guest_id === guest.id) continue;
      const me = seats.find((x) => x.round === s.round && x.guest_id === guest.id);
      if (me && me.table_number === s.table_number) metBefore.add(s.guest_id);
    }
    const host = mine.is_host ? guest : active.get(here.find((s) => s.is_host)?.guest_id);
    out.table = {
      number: mine.table_number,
      moved: !!mine.moved,
      iAmHost: !!mine.is_host,
      host: host?.name ?? null,
      mates: here.map((s) => ({ name: active.get(s.guest_id)!.name, host: !!s.is_host })),
      newFaces: round > 1 ? here.filter((s) => !metBefore.has(s.guest_id)).length : null,
    };
  }

  const approved = topics.filter((t) => t.status === "approved" && t.grp);
  const own = topics.filter((t) => t.guest_id === guest.id);
  out.topics = {
    groups: Array.from({ length: ev.total_rounds }, (_, i) => ({
      round: i + 1,
      name: groupName(ev, i + 1),
      count: approved.filter((t) => t.grp === i + 1).length,
    })),
    mine: own.map((t) => ({ text: t.text, status: t.status })),
    canSuggest: suggestionsOpen(ev) && own.length < MAX_SUGGESTIONS,
  };

  if (ev.phase === "vote") {
    const votes = (await must(
      db.from("topic_votes").select("topic_id").eq("event_id", ev.id).eq("round", ev.round).eq("guest_id", guest.id),
    )) as Row[];
    out.vote = {
      options: approved.filter((t) => t.grp === ev.round).map((t) => ({ id: t.id, text: t.text })),
      mine: votes.map((v) => v.topic_id),
      max: ev.votes_each,
    };
  }
  if (ev.phase === "room") {
    const r = (await must(
      db.from("ratings").select("up").eq("event_id", ev.id).eq("round", ev.round).eq("guest_id", guest.id).maybeSingle(),
    )) as Row | null;
    out.rating = { mine: r ? r.up : null };
  }
  return out;
}

async function suggest(db: Db, body: Row) {
  const { guest, ev } = await guestByToken(db, body.token);
  if (guest.left_at) throw new ApiError("left", "You've been marked as gone. Ask a host to bring you back.");
  if (!suggestionsOpen(ev)) throw new ApiError("closed", "Topics are closed for today");
  const text = clean(body.text, MAX_TOPIC);
  if (text.length < 5) throw new ApiError("bad_topic", "Type a topic or a question");
  const lower = text.toLowerCase();
  if (BLOCKED.some((w) => lower.includes(w))) throw new ApiError("bad_topic", "Please word that differently");
  const topics = await loadTopics(db, ev.id);
  if (topics.length >= MAX_TOPICS) throw new ApiError("full", "There are plenty of topics already");
  if (topics.filter((t) => t.guest_id === guest.id).length >= MAX_SUGGESTIONS) {
    throw new ApiError("limit", `You can suggest up to ${MAX_SUGGESTIONS} topics`);
  }
  // A host reads every suggestion before the room sees it.
  await must(db.from("topics").insert({ event_id: ev.id, text, status: "pending", source: "guest", guest_id: guest.id }).select("id"));
  await notify(ev.code);
  return { ok: true };
}

async function vote(db: Db, body: Row) {
  const found = await guestByToken(db, body.token);
  const guest = found.guest;
  const ev = await tick(db, found.ev);
  if (ev.phase !== "vote") throw new ApiError("no_vote", "Voting has closed");
  if (guest.left_at) throw new ApiError("left", "You've been marked as gone. Ask a host to bring you back.");
  const wanted = [...new Set((Array.isArray(body.topicIds) ? body.topicIds : []).map((x: unknown) => clean(x, 64)))] as string[];
  if (wanted.length > ev.votes_each) throw new ApiError("bad_vote", `Pick up to ${ev.votes_each}`);
  const options = new Set((await loadTopics(db, ev.id)).filter((t) => t.status === "approved" && t.grp === ev.round).map((t) => t.id as string));
  if (wanted.some((id) => !options.has(id))) throw new ApiError("bad_vote", "Pick from the list");
  // Replace this guest's picks for the round.
  await must(db.from("topic_votes").delete().eq("event_id", ev.id).eq("round", ev.round).eq("guest_id", guest.id).select("topic_id"));
  if (wanted.length) {
    await must(db.from("topic_votes").insert(wanted.map((topic_id) => ({ event_id: ev.id, round: ev.round, guest_id: guest.id, topic_id }))).select("topic_id"));
  }
  await notify(ev.code);
  return { ok: true, mine: wanted };
}

async function rate(db: Db, body: Row) {
  const { guest, ev } = await guestByToken(db, body.token);
  if (ev.phase !== "room") throw new ApiError("no_rating", "Rating is open during the room discussion");
  if (body.up === true || body.up === false) {
    await must(
      db.from("ratings").upsert({ event_id: ev.id, round: ev.round, guest_id: guest.id, up: body.up }, { onConflict: "event_id,round,guest_id" }).select("round"),
    );
  } else {
    await must(db.from("ratings").delete().eq("event_id", ev.id).eq("round", ev.round).eq("guest_id", guest.id).select("round"));
  }
  await notify(ev.code);
  return { ok: true };
}

// ---------- big screen ----------

async function roomData(db: Db, ev: Row) {
  const [tables, guests, allSeats, topics, rounds] = await Promise.all([
    loadTables(db, ev.id), loadGuests(db, ev.id), loadSeats(db, ev.id), loadTopics(db, ev.id), loadRounds(db, ev.id),
  ]);
  const active = guests.filter((g) => !g.left_at);
  const byId = new Map(active.map((g) => [g.id, g]));
  const round = seatingRound(ev);
  const seats = allSeats.filter((s) => s.round === round && byId.has(s.guest_id));
  const numbers = [...new Set(seats.map((s) => s.table_number as number))].sort((a, b) => a - b);
  const outTables = ev.phase === "finished" ? [] : numbers.map((n) => ({
    number: n,
    guests: seats.filter((s) => s.table_number === n).map((s) => ({ name: byId.get(s.guest_id)!.name as string, host: !!s.is_host })),
  }));
  return { tables, guests, active, allSeats, seats, topics, rounds, outTables };
}

async function voteTally(db: Db, ev: Row, topics: Row[], active: Row[]) {
  const votes = await loadVotes(db, ev.id, ev.round);
  const here = new Set(active.map((g) => g.id));
  const counts = new Map<string, number>();
  const voters = new Set<string>();
  for (const v of votes) {
    counts.set(v.topic_id, (counts.get(v.topic_id) ?? 0) + 1);
    if (here.has(v.guest_id)) voters.add(v.guest_id);
  }
  return {
    options: topics.filter((t) => t.status === "approved" && t.grp === ev.round).map((t) => ({ id: t.id, text: t.text, votes: counts.get(t.id) ?? 0 })),
    voted: voters.size,
    of: active.length,
  };
}

async function room(db: Db, body: Row) {
  const ev = await tick(db, await getEvent(db, body.code));
  const d = await roomData(db, ev);
  return {
    event: eventPublic(ev),
    guestCount: d.active.length,
    topicCount: d.topics.filter((t) => t.status === "approved" && t.grp).length,
    // Seating is only shown once round 1 is locked in: before that, each phone has its own table.
    tables: ev.phase === "lobby" ? [] : d.outTables,
    round: roundPublic(ev, d.rounds, d.topics, true),
    vote: ev.phase === "vote" ? await voteTally(db, ev, d.topics, d.active) : null,
  };
}

// ---------- host ----------

async function requireHost(db: Db, body: Row): Promise<{ ev: Row; label: string }> {
  const ev = await getEvent(db, body.code);
  if (ev.pin_locked_until && new Date(ev.pin_locked_until) > new Date()) {
    throw new ApiError("locked", "Too many wrong tries. Try again in a few minutes.", 429);
  }
  // Hosts of every event, plus any listed for this one (a practice event shares its event's hosts).
  const hosts = ((await must(db.from("hosts").select("email_hash, label, event_id"))) as Row[])
    .filter((h) => h.event_id == null || h.event_id === ev.id || h.event_id === ev.practice_of);
  let ok = (await pinHash(ev.code, clean(body.pin, 20))) === ev.host_pin_hash;
  let label = "";
  // With hosts listed, the email must be one of theirs as well as the PIN being right.
  if (hosts.length) {
    const email = normaliseEmail(body.email);
    const hash = email ? await hostEmailHash(email) : "";
    const match = hosts.find((h) => h.email_hash === hash);
    if (!match) ok = false;
    else label = match.label ?? "";
  }
  if (!ok) {
    const fails = ev.pin_fail_count + 1;
    const lock = fails >= PIN_TRIES;
    await must(
      db.from("events").update({
        pin_fail_count: lock ? 0 : fails,
        pin_locked_until: lock ? new Date(Date.now() + PIN_LOCK_MINUTES * 60000).toISOString() : null,
      }).eq("id", ev.id).select("id"),
    );
    throw new ApiError("bad_login", hosts.length ? "That email and PIN don't match a host of this event" : "That PIN isn't right", 401);
  }
  if (ev.pin_fail_count) await must(db.from("events").update({ pin_fail_count: 0 }).eq("id", ev.id).select("id"));
  return { ev, label };
}

async function loadSignups(db: Db, eventId: string): Promise<Row[]> {
  return (await must(db.from("registrations").select("email_hash, guest_id, will_host, experience").eq("event_id", eventId).limit(MAX_SIGNUPS))) as Row[];
}

async function hasSignups(db: Db, eventId: string): Promise<boolean> {
  const rows = (await must(db.from("registrations").select("email_hash").eq("event_id", eventId).limit(1))) as Row[];
  return rows.length > 0;
}

/**
 * Loads the sign-up list. Either `rows` (one per person, with what the form
 * told us about them) or `text` (anything with email addresses in it). The
 * addresses are turned into fingerprints here and never stored.
 */
async function setSignups(db: Db, ev: Row, body: Row) {
  if (body.clear === true) {
    await must(db.from("registrations").delete().eq("event_id", ev.id).select("email_hash"));
    return;
  }
  let people: Row[];
  if (Array.isArray(body.rows)) {
    if (body.rows.length > MAX_SIGNUPS) throw new ApiError("bad_signups", `Up to ${MAX_SIGNUPS} sign-ups`);
    people = (body.rows as Row[]).map((r) => ({
      email: normaliseEmail(r.email),
      first_name: clean(r.firstName, 40) || null,
      experience: EXPERIENCE.includes(r.experience) ? r.experience : null,
      will_host: r.willHost === true,
      role_group: clean(r.role, 40).toLowerCase() || null,
      interest: clean(r.interest, 40).toLowerCase() || null,
      question: clean(r.question, 300) || null,
    })).filter((r) => r.email);
  } else {
    const text = String(body.text ?? "");
    if (text.length > MAX_SIGNUP_TEXT) throw new ApiError("bad_signups", "That list is too long. Paste only the email column.");
    people = extractEmails(text).map((email) => ({ email }));
  }
  if (!people.length) throw new ApiError("bad_signups", "We couldn't find any email addresses in that");
  if (people.length > MAX_SIGNUPS) throw new ApiError("bad_signups", `Up to ${MAX_SIGNUPS} sign-ups`);
  const byHash = new Map<string, Row>();
  for (const p of people) {
    const { email, ...details } = p;
    byHash.set(await emailFingerprint(SERVICE_KEY, ev.id, email), details);
  }
  // Replace the list, but keep who has arrived for rows that are still on it.
  const existing = new Set((await loadSignups(db, ev.id)).map((r) => r.email_hash as string));
  const gone = [...existing].filter((h) => !byHash.has(h));
  for (let i = 0; i < gone.length; i += 200) {
    await must(db.from("registrations").delete().eq("event_id", ev.id).in("email_hash", gone.slice(i, i + 200)).select("email_hash"));
  }
  const rows = [...byHash].map(([email_hash, details]) => ({ event_id: ev.id, email_hash, ...details }));
  const detailed = Array.isArray(body.rows);
  for (let i = 0; i < rows.length; i += 500) {
    const part = rows.slice(i, i + 500);
    // A plain list of addresses must not blank out details loaded earlier.
    await must(db.from("registrations").upsert(part, { onConflict: "event_id,email_hash", ignoreDuplicates: !detailed }).select("email_hash"));
  }
  // Sign-up questions can be queued as topics for a host to tidy and approve.
  if (detailed && body.questionsAsTopics === true) {
    const have = new Set((await loadTopics(db, ev.id)).map((t) => String(t.text).toLowerCase()));
    const fresh = [...new Set(rows.map((r) => clean((r as Row).question, MAX_TOPIC)).filter((q) => q.length >= 8 && !have.has(q.toLowerCase())))];
    if (fresh.length) {
      await must(db.from("topics").insert(fresh.slice(0, MAX_TOPICS).map((text) => ({ event_id: ev.id, text, status: "pending", source: "signup" }))).select("id"));
    }
  }
}

function repeatCount(guests: Row[], seats: Row[]): number {
  // Pairs who have shared a table more than once so far.
  const seen = new Map<string, number>();
  const rounds = Math.max(0, ...seats.map((s) => s.round as number));
  for (let r = 1; r <= rounds; r++) {
    const one: Person[] = guests.map((g) => ({ id: g.id, history: [seats.find((s) => s.round === r && s.guest_id === g.id)?.table_number ?? null] }));
    for (const k of metPairs(one)) seen.set(k, (seen.get(k) ?? 0) + 1);
  }
  let n = 0;
  for (const v of seen.values()) if (v > 1) n += v - 1;
  return n;
}

async function hostState(db: Db, evIn: Row, label: string) {
  const ev = await tick(db, evIn);
  const d = await roomData(db, ev);
  const [signups, ratings, practice] = await Promise.all([
    loadSignups(db, ev.id),
    must(db.from("ratings").select("round, up").eq("event_id", ev.id)) as Promise<Row[]>,
    must(db.from("events").select("code").eq("practice_of", ev.id).maybeSingle()) as Promise<Row | null>,
  ]);
  const seatNow = new Map(d.seats.map((s) => [s.guest_id, s]));
  const tally = ev.phase === "vote" ? await voteTally(db, ev, d.topics, d.active) : null;
  const round = roundPublic(ev, d.rounds, d.topics, true);
  const numbers = d.tables.filter((t) => t.open).map((t) => t.number as number);
  return {
    event: eventPublic(ev),
    hostLabel: label,
    tableCount: numbers.length,
    tablesInUse: d.outTables.length,
    tablesWithoutHost: ev.phase === "lobby" ? 0 : d.outTables.filter((t) => !t.guests.some((g) => g.host)).length,
    practiceCode: practice?.code ?? null,
    signups: {
      total: signups.length,
      arrived: signups.filter((r) => r.guest_id).length,
      notOnList: d.guests.filter((g) => g.registered === false).length,
      offeredToHost: signups.filter((r) => r.will_host).length,
      withDetails: signups.filter((r) => r.experience).length,
    },
    guests: d.guests.map((g) => ({
      id: g.id,
      name: g.name,
      left: !!g.left_at,
      registered: g.registered ?? null,
      pinnedTable: g.pinned_table,
      table: g.left_at || ev.phase === "finished" ? null : seatNow.get(g.id)?.table_number ?? null,
      isHost: !!seatNow.get(g.id)?.is_host,
      willHost: !!g.will_host,
      experience: g.experience ?? null,
      bot: !!g.bot,
    })),
    room: d.outTables,
    round,
    vote: tally,
    topics: d.topics.map((t) => ({ id: t.id, group: t.grp, text: t.text, status: t.status, source: t.source })),
    results: d.rounds.filter((r) => r.topic_text).sort((a, b) => a.round - b.round).map((r) => ({
      round: r.round,
      topic: r.topic_text,
      up: ratings.filter((x) => x.round === r.round && x.up).length,
      down: ratings.filter((x) => x.round === r.round && !x.up).length,
    })),
    repeatPairs: repeatCount(d.active, d.allSeats),
  };
}

function intIn(value: unknown, min: number, max: number, message: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new ApiError("bad_setup", message);
  return n;
}

async function setup(db: Db, ev: Row, body: Row) {
  const patch: Row = {};
  if (body.name != null) patch.name = clean(body.name, 80) || ev.name;
  if (body.totalRounds != null) {
    const n = intIn(body.totalRounds, 1, 8, "Rounds must be between 1 and 8");
    if (n < ev.round) throw new ApiError("bad_setup", `Round ${ev.round} has already started`);
    patch.total_rounds = n;
  }
  if (body.roundMinutes != null) patch.round_minutes = intIn(body.roundMinutes, 1, 120, "Table discussion must be 1 to 120 minutes");
  if (body.roomMinutes != null) patch.room_minutes = intIn(body.roomMinutes, 1, 60, "Room discussion must be 1 to 60 minutes");
  if (body.voteSeconds != null) patch.vote_seconds = intIn(body.voteSeconds, 15, 900, "Voting must be 15 seconds to 15 minutes");
  if (body.votesEach != null) patch.votes_each = intIn(body.votesEach, 1, 5, "Votes per person must be 1 to 5");
  if (body.tableSize != null) patch.table_size = intIn(body.tableSize, 2, 12, "People per table must be 2 to 12");
  if (Array.isArray(body.groupNames)) patch.group_names = (body.groupNames as unknown[]).slice(0, 8).map((g) => clean(g, 30));
  if (body.feedbackUrl != null) {
    const u = clean(body.feedbackUrl, 300);
    if (u && !/^https:\/\//i.test(u)) throw new ApiError("bad_setup", "The feedback link must start with https://");
    patch.feedback_url = u || null;
  }
  if (body.cardLine != null) patch.card_line = clean(body.cardLine, 60) || null;
  if (Object.keys(patch).length) await must(db.from("events").update(patch).eq("id", ev.id).select("id"));

  if (body.tableCount != null) {
    const n = intIn(body.tableCount, 1, 30, "Set between 1 and 30 tables");
    const rows = Array.from({ length: n }, (_, i) => ({ event_id: ev.id, number: i + 1, open: true }));
    await must(db.from("tables").upsert(rows, { onConflict: "event_id,number" }).select("id"));
    await must(db.from("tables").delete().eq("event_id", ev.id).gt("number", n).select("id"));
  }
}

async function topicInEvent(db: Db, ev: Row, id: unknown): Promise<Row> {
  const t = (await must(db.from("topics").select("*").eq("id", clean(id, 64)).eq("event_id", ev.id).maybeSingle())) as Row | null;
  if (!t) throw new ApiError("no_topic", "That topic isn't in this event", 404);
  return t;
}

function checkGroup(ev: Row, value: unknown): number {
  const g = Number(value);
  if (!Number.isInteger(g) || g < 1 || g > ev.total_rounds) throw new ApiError("bad_topic", "Pick a group for the topic");
  return g;
}

async function guestInEvent(db: Db, ev: Row, guestId: unknown): Promise<Row> {
  const id = clean(guestId, 64);
  const g = (await must(db.from("guests").select("*").eq("id", id).eq("event_id", ev.id).maybeSingle())) as Row | null;
  if (!g) throw new ApiError("no_guest", "That guest isn't in this event", 404);
  return g;
}

/** Removes every guest with their seats, votes and ratings, and returns the event to doors open. */
async function resetEvent(db: Db, ev: Row) {
  await must(db.from("guests").delete().eq("event_id", ev.id).select("id"));
  await must(db.from("rounds").delete().eq("event_id", ev.id).select("round"));
  await must(db.from("topics").delete().eq("event_id", ev.id).eq("source", "guest").select("id"));
  await must(db.from("events").update({ phase: "lobby", round: 0, round_ends_at: null, current_poll: null }).eq("id", ev.id).select("id"));
}

/** Makes (or remakes) the practice copy of an event: same settings and topics, short timers, pretend guests. */
async function startPractice(db: Db, ev: Row, body: Row) {
  if (ev.practice_of) throw new ApiError("is_practice", "This is already a practice event");
  const code = `${ev.code}-practice`.slice(0, 40);
  await must(db.from("events").delete().eq("code", code).eq("practice_of", ev.id).select("id"));
  const clash = (await must(db.from("events").select("id").eq("code", code).maybeSingle())) as Row | null;
  if (clash) throw new ApiError("clash", "Another event already uses the practice code");
  const practice = (await must(
    db.from("events").insert({
      code,
      name: `${ev.name} (practice)`,
      total_rounds: ev.total_rounds,
      // Short timers, so a whole run-through takes a few minutes. Change them in Setup.
      round_minutes: 1,
      room_minutes: 1,
      vote_seconds: 45,
      votes_each: ev.votes_each,
      table_size: ev.table_size,
      group_names: ev.group_names,
      feedback_url: ev.feedback_url,
      card_line: ev.card_line,
      host_pin_hash: await pinHash(code, clean(body.pin, 20)),
      practice_of: ev.id,
    }).select("*").single(),
  )) as Row;
  const [tables, topics] = await Promise.all([loadTables(db, ev.id), loadTopics(db, ev.id)]);
  if (tables.length) {
    await must(db.from("tables").insert(tables.map((t) => ({ event_id: practice.id, number: t.number, open: t.open }))).select("id"));
  }
  const copy = topics.filter((t) => t.status === "approved" && t.grp).map((t) => ({
    event_id: practice.id, grp: t.grp, text: t.text, status: "approved", source: t.source === "guest" ? "host" : t.source, position: t.position,
  }));
  if (copy.length) await must(db.from("topics").insert(copy).select("id"));
  const count = body.guests == null ? 0 : Math.floor(Number(body.guests));
  if (count > 0) await addBots(db, practice, count);
  return { practiceCode: code };
}

async function host(db: Db, action: string, body: Row) {
  const { ev, label } = await requireHost(db, body);
  const round = seatingRound(ev);
  switch (action) {
    case "host.state":
      return hostState(db, ev, label);
    case "host.setup":
      await setup(db, ev, body);
      break;
    case "host.advance":
      await advance(db, ev, body);
      break;
    case "host.spin":
      await spin(db, ev);
      break;
    case "host.addTime": {
      // Adds or takes off time in the timed phases.
      if (!ev.round_ends_at || !["vote", "table", "room"].includes(ev.phase)) throw new ApiError("no_timer", "There's no timer running");
      const seconds = intIn(body.seconds, -3600, 3600, "Pick a number of seconds");
      const ends = Math.max(Date.now() + 5000, new Date(ev.round_ends_at).getTime() + seconds * 1000);
      await step(db, ev, { round_ends_at: new Date(ends).toISOString() });
      break;
    }
    case "host.setSignups":
      await setSignups(db, ev, body);
      break;
    case "host.addTopic": {
      const text = clean(body.text, MAX_TOPIC);
      if (text.length < 3) throw new ApiError("bad_topic", "Type a topic");
      if ((await loadTopics(db, ev.id)).length >= MAX_TOPICS) throw new ApiError("full", `Up to ${MAX_TOPICS} topics`);
      await must(db.from("topics").insert({ event_id: ev.id, grp: checkGroup(ev, body.group), text, status: "approved", source: "host" }).select("id"));
      break;
    }
    case "host.setTopics": {
      // Replaces the prepared topics in one go: [{ group, text }]. Guests' own suggestions are left alone.
      if (ev.phase !== "lobby") throw new ApiError("bad_topic", "Topics can only be replaced before round 1 starts");
      const list = Array.isArray(body.topics) ? (body.topics as Row[]) : [];
      if (!list.length || list.length > MAX_TOPICS) throw new ApiError("bad_topic", `Send between 1 and ${MAX_TOPICS} topics`);
      const rows = list.map((t, i) => ({
        event_id: ev.id, grp: checkGroup(ev, t.group), text: clean(t.text, MAX_TOPIC), status: "approved", source: "signup", position: i,
      })).filter((t) => t.text.length >= 3);
      await must(db.from("topics").delete().eq("event_id", ev.id).neq("source", "guest").select("id"));
      await must(db.from("topics").insert(rows).select("id"));
      break;
    }
    case "host.updateTopic": {
      const t = await topicInEvent(db, ev, body.topicId);
      const patch: Row = {};
      if (body.text != null) {
        const text = clean(body.text, MAX_TOPIC);
        if (text.length < 3) throw new ApiError("bad_topic", "Type a topic");
        patch.text = text;
      }
      if (body.group != null) patch.grp = checkGroup(ev, body.group);
      if (body.status != null) {
        if (!["approved", "hidden", "pending"].includes(body.status)) throw new ApiError("bad_topic", "Unknown status");
        patch.status = body.status;
      }
      if ((patch.status ?? t.status) === "approved" && (patch.grp ?? t.grp) == null) throw new ApiError("bad_topic", "Pick a group for the topic");
      if (Object.keys(patch).length) await must(db.from("topics").update(patch).eq("id", t.id).select("id"));
      break;
    }
    case "host.removeTopic": {
      const t = await topicInEvent(db, ev, body.topicId);
      await must(db.from("topics").delete().eq("id", t.id).select("id"));
      break;
    }
    case "host.addGuest":
      await addGuestRow(db, ev, body.name, null, { will_host: body.willHost === true });
      break;
    case "host.addBots":
      await addBots(db, ev, body.count);
      break;
    case "host.markLeft": {
      const g = await guestInEvent(db, ev, body.guestId);
      const left = body.left !== false;
      await must(db.from("guests").update({ left_at: left ? new Date().toISOString() : null }).eq("id", g.id).select("id"));
      if (left) await replaceHost(db, ev, g.id);
      else await seatGuests(db, ev, [g]);
      break;
    }
    case "host.renameGuest": {
      const g = await guestInEvent(db, ev, body.guestId);
      const name = await uniqueName(db, ev.id, checkName(body.name), g.id);
      await must(db.from("guests").update({ name }).eq("id", g.id).select("id"));
      break;
    }
    case "host.removeGuest": {
      const g = await guestInEvent(db, ev, body.guestId);
      await replaceHost(db, ev, g.id);
      await must(db.from("guests").delete().eq("id", g.id).select("id"));
      break;
    }
    case "host.moveGuest": {
      const g = await guestInEvent(db, ev, body.guestId);
      const table = Number(body.table);
      const tables = await loadTables(db, ev.id);
      if (!tables.some((t) => t.number === table && t.open)) throw new ApiError("bad_table", "That table isn't in the room");
      await must(db.from("guests").update({ pinned_table: body.keep ? table : null }).eq("id", g.id).select("id"));
      if (ev.phase !== "finished" && !g.left_at) {
        await replaceHost(db, ev, g.id);
        await must(
          db.from("seats").upsert(
            { event_id: ev.id, round, guest_id: g.id, table_number: table, is_host: false, moved: false },
            { onConflict: "event_id,round,guest_id" },
          ).select("guest_id"),
        );
      }
      break;
    }
    case "host.unpinGuest": {
      const g = await guestInEvent(db, ev, body.guestId);
      await must(db.from("guests").update({ pinned_table: null }).eq("id", g.id).select("id"));
      break;
    }
    case "host.setTableHost": {
      // Hands a table to this guest for the current round.
      const g = await guestInEvent(db, ev, body.guestId);
      const seats = (await loadSeats(db, ev.id)).filter((s) => s.round === round);
      const seat = seats.find((s) => s.guest_id === g.id);
      if (!seat) throw new ApiError("no_seat", "That guest has no table this round");
      const others = seats.filter((s) => s.table_number === seat.table_number && s.is_host).map((s) => s.guest_id);
      if (others.length) await must(db.from("seats").update({ is_host: false }).eq("event_id", ev.id).eq("round", round).in("guest_id", others).select("guest_id"));
      if (body.on !== false) await must(db.from("seats").update({ is_host: true }).eq("event_id", ev.id).eq("round", round).eq("guest_id", g.id).select("guest_id"));
      break;
    }
    case "host.changePin": {
      const pin = clean(body.newPin, 20);
      if (!/^[0-9]{4,12}$/.test(pin)) throw new ApiError("bad_pin", "The PIN must be 4 to 12 digits");
      await must(db.from("events").update({ host_pin_hash: await pinHash(ev.code, pin) }).eq("id", ev.id).select("id"));
      return { ok: true };
    }
    case "host.reset":
      // Back to doors open, for a rehearsal. The sign-up list and the prepared topics are kept.
      if (body.confirm !== "RESET") throw new ApiError("confirm", "Type RESET to confirm");
      await resetEvent(db, ev);
      break;
    case "host.wipe": {
      // Deletes everything that came from attendees: guests with their seats,
      // votes and ratings, the sign-up list, and topics guests suggested.
      if (body.confirm !== "DELETE") throw new ApiError("confirm", "Type DELETE to confirm");
      await resetEvent(db, ev);
      await must(db.from("registrations").delete().eq("event_id", ev.id).select("email_hash"));
      await must(db.from("events").delete().eq("practice_of", ev.id).select("id"));
      break;
    }
    case "host.practice": {
      const out = await startPractice(db, ev, body);
      await notify(out.practiceCode);
      return out;
    }
    default:
      throw new ApiError("unknown", "Unknown action", 404);
  }
  await notify(ev.code);
  const fresh = await getEvent(db, ev.code);
  return hostState(db, fresh, label);
}

/** Runs one action. Throws ApiError for anything the caller got wrong. */
export function dispatch(db: Db, body: Row): Promise<unknown> {
  const action = String(body.action ?? "");
  if (action === "join") return join(db, body);
  if (action === "info") return info(db, body);
  if (action === "view") return view(db, body);
  if (action === "suggest") return suggest(db, body);
  if (action === "vote") return vote(db, body);
  if (action === "rate") return rate(db, body);
  if (action === "room") return room(db, body);
  if (action.startsWith("host.")) return host(db, action, body);
  return Promise.reject(new ApiError("unknown", "Unknown action", 404));
}
