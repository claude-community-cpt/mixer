// Seating for Table Mixer.
// Pure functions with no imports, so the same file runs in a Supabase Edge
// Function, in the browser and in tests.
//
// What the seating aims for, most important first:
//   1. Tables stay full at the size the host sets, and within one seat of each other.
//   2. People sit with a mostly new group each round.
//   3. Every table has at least one person who offered to host it.
//   4. Each table is a mix: of how much people use Claude, of the work they
//      do and of the topics they asked about.
//   5. Nobody is sent back to a table they have already sat at.

export type Person = {
  id: string;
  /** "daily", "regular", "occasional" or "new". Unknown is fine. */
  experience?: string | null;
  role?: string | null;
  interest?: string | null;
  /** Offered to host a table on the sign-up form. */
  willHost?: boolean;
  /** How many rounds they have hosted a table so far. */
  hosted?: number;
  /** Table number for each past round, oldest first. null = not seated that round. */
  history?: (number | null)[];
  /** A host has fixed this guest to a table (for access reasons, say). */
  pinnedTable?: number | null;
};

export type Seated = Person & { table: number };
export type Assignment = Record<string, number>; // guest id -> table number

const W_MET = 20; // two people who have already shared a table
const W_EXPERIENCE = 2;
const W_ROLE = 1.5;
const W_INTEREST = 1;
const W_TWO_HOSTS = 3; // two volunteers together: better to spread them
const W_NO_HOST = 60; // a table with nobody who offered to host
const W_REVISIT = 8; // back at a table number they have sat at

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pairKey(a: string, b: string) {
  return a < b ? a + "|" + b : b + "|" + a;
}

/** How alike two people are. Lower is a better mix. */
export function alike(a: Person, b: Person): number {
  let c = 0;
  if (a.experience && a.experience === b.experience) c += W_EXPERIENCE;
  if (a.role && a.role === b.role) c += W_ROLE;
  if (a.interest && a.interest === b.interest) c += W_INTEREST;
  if (a.willHost && b.willHost) c += W_TWO_HOSTS;
  return c;
}

/** Every pair of people who have shared a table in a past round. */
export function metPairs(people: Person[]): Set<string> {
  const met = new Set<string>();
  const rounds = Math.max(0, ...people.map((g) => g.history?.length ?? 0));
  for (let r = 0; r < rounds; r++) {
    const byTable = new Map<number, string[]>();
    for (const g of people) {
      const t = g.history?.[r];
      if (t == null) continue;
      if (!byTable.has(t)) byTable.set(t, []);
      byTable.get(t)!.push(g.id);
    }
    for (const ids of byTable.values()) {
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) met.add(pairKey(ids[i], ids[j]));
      }
    }
  }
  return met;
}

/** How many tables to use: enough to seat everyone at the set size, never more than the room has. */
export function tablesNeeded(people: number, size: number, roomTables: number): number {
  return Math.max(1, Math.min(roomTables, Math.ceil(people / Math.max(1, size))));
}

function sizesOf(seated: Seated[]): Map<number, number> {
  const sizes = new Map<number, number>();
  for (const s of seated) sizes.set(s.table, (sizes.get(s.table) ?? 0) + 1);
  return sizes;
}

function mixCost(p: Person, members: Person[], met?: Set<string>): number {
  let c = 0;
  for (const m of members) {
    c += alike(p, m);
    if (met?.has(pairKey(p.id, m.id))) c += W_MET;
  }
  return c;
}

/**
 * A table for someone who has just arrived, before round 1 starts. They keep it.
 *
 * Only a couple of tables fill at a time, so tables are full rather than
 * everyone being spread thin. The newcomer goes to whichever of those tables
 * they add the most variety to, and the next table opens when one fills.
 * `tables` is every table in the room, in the order they should open.
 */
export function seatArrival(
  seated: Seated[],
  newcomer: Person,
  opts: { size: number; tables: number[]; filling?: number; lastTable?: number | null },
): number {
  const { size, tables } = opts;
  const filling = opts.filling ?? 2;
  if (tables.length === 0) throw new Error("No tables");
  if (newcomer.pinnedTable != null && tables.includes(newcomer.pinnedTable)) return newcomer.pinnedTable;

  const sizes = sizesOf(seated);
  const withRoom = tables.filter((t) => (sizes.get(t) ?? 0) > 0 && (sizes.get(t) ?? 0) < size);
  const unused = tables.filter((t) => !sizes.has(t));
  const candidates = [...withRoom];
  if (candidates.length < filling && unused.length) candidates.push(unused[0]);

  if (candidates.length === 0) {
    // Every table is full: add an extra seat at the smallest one.
    let best = tables[0];
    let bestCost = Infinity;
    for (const t of tables) {
      const members = seated.filter((s) => s.table === t);
      const c = members.length * 1000 + mixCost(newcomer, members);
      if (c < bestCost) {
        bestCost = c;
        best = t;
      }
    }
    return best;
  }

  let best = candidates[0];
  let bestCost = Infinity;
  for (const t of candidates) {
    const members = seated.filter((s) => s.table === t);
    let c = mixCost(newcomer, members);
    const volunteers = members.filter((m) => m.willHost).length;
    // Keep the last seat or two for someone who offered to host, if the table has nobody yet.
    if (!newcomer.willHost && volunteers === 0 && members.length >= size - 1) c += 5;
    // People who walk in together have usually met. Send them to different tables.
    if (opts.lastTable === t) c += 1.5;
    // On a tie, finish the fuller table first.
    c -= members.length * 0.01;
    if (c < bestCost) {
      bestCost = c;
      best = t;
    }
  }
  return best;
}

/**
 * A table for someone who arrives, or comes back, once a round is under way:
 * the smallest table in use, and on a tie the one they suit best.
 */
export function seatLate(seated: Seated[], newcomer: Person, tablesInUse: number[]): number {
  if (tablesInUse.length === 0) throw new Error("No tables");
  if (newcomer.pinnedTable != null && tablesInUse.includes(newcomer.pinnedTable)) return newcomer.pinnedTable;
  const met = metPairs([...seated, newcomer]);
  let best = tablesInUse[0];
  let bestCost = Infinity;
  for (const t of tablesInUse) {
    const members = seated.filter((s) => s.table === t);
    let c = members.length * 1000 + mixCost(newcomer, members, met);
    if (newcomer.history?.includes(t)) c += W_REVISIT;
    if (c < bestCost) {
      bestCost = c;
      best = t;
    }
  }
  return best;
}

/**
 * Just before round 1 is locked in: a table left with only a few people (half
 * the table size or fewer) is folded into the others, so nobody sits at a thin
 * table. Everyone else stays exactly where they were told to go. A thin table
 * is left alone if folding it would give any table more than one extra seat.
 * Returns only the people who move.
 */
export function settle(seated: Seated[], size: number): Assignment {
  const moves: Assignment = {};
  const now: Seated[] = seated.map((s) => ({ ...s }));
  const thin = Math.floor(size / 2);
  const kept = new Set<number>(); // thin tables that cannot be folded without crowding the rest
  for (let guard = 0; guard < 30; guard++) {
    const sizes = sizesOf(now);
    if (sizes.size <= 1) break;
    // The thinnest table, if it is thin enough to fold and nobody is pinned to it.
    let fold: number | null = null;
    for (const [t, n] of sizes) {
      if (n > thin || kept.has(t)) continue;
      if (now.some((s) => s.table === t && s.pinnedTable === t)) continue;
      if (fold == null || n < sizes.get(fold)! || (n === sizes.get(fold)! && t > fold)) fold = t;
    }
    if (fold == null) break;
    const others = [...sizes.keys()].filter((t) => t !== fold);
    // Folding must not push any table past one extra seat.
    const trial = others.map((t) => sizes.get(t)!).sort((a, b) => a - b);
    for (let i = 0; i < sizes.get(fold)!; i++) {
      trial[0]++;
      trial.sort((a, b) => a - b);
    }
    if (trial[trial.length - 1] > size + 1) {
      kept.add(fold);
      continue;
    }
    for (const p of now.filter((s) => s.table === fold)) {
      let best = others[0];
      let bestCost = Infinity;
      for (const t of others) {
        const members = now.filter((s) => s.table === t);
        const c = members.length * 1000 + mixCost(p, members);
        if (c < bestCost) {
          bestCost = c;
          best = t;
        }
      }
      p.table = best;
      moves[p.id] = best;
    }
  }
  return moves;
}

function noHostCost(volunteers: number, members: number): number {
  return members > 0 && volunteers === 0 ? W_NO_HOST : 0;
}

function attempt(
  people: Person[],
  tables: number[],
  pair: Float32Array,
  rand: () => number,
): { where: Int32Array; cost: number } {
  const n = people.length;
  const T = tables.length;
  const cap = Math.ceil(n / T);
  const floor = Math.floor(n / T);
  const tableIndex = new Map(tables.map((t, i) => [t, i]));
  const where = new Int32Array(n).fill(-1);
  const members: number[][] = tables.map(() => []);
  const pinned = new Uint8Array(n);
  const revisit = (i: number, ti: number) => (people[i].history?.includes(tables[ti]) ? W_REVISIT : 0);

  // Pinned guests first, then everyone else in random order, each to the
  // table that suits them best among those with room.
  const order: number[] = [];
  for (let i = 0; i < n; i++) {
    const pt = people[i].pinnedTable;
    if (pt != null && tableIndex.has(pt)) {
      pinned[i] = 1;
      where[i] = tableIndex.get(pt)!;
      members[where[i]].push(i);
    } else order.push(i);
  }
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  // Tables that take the bigger size, so sizes end up within one of each other.
  let bigLeft = n - floor * T;
  for (const i of order) {
    let best = -1;
    let bestCost = Infinity;
    for (let ti = 0; ti < T; ti++) {
      const len = members[ti].length;
      if (len >= cap || (len >= floor && bigLeft <= 0 && floor < cap)) continue;
      let c = revisit(i, ti) + len * 0.01;
      for (const m of members[ti]) c += pair[i * n + m];
      if (c < bestCost) {
        bestCost = c;
        best = ti;
      }
    }
    if (best < 0) {
      // Pinned guests have overfilled a table: take the smallest.
      best = 0;
      for (let ti = 1; ti < T; ti++) if (members[ti].length < members[best].length) best = ti;
    }
    if (members[best].length >= floor && floor < cap) bigLeft--;
    where[i] = best;
    members[best].push(i);
  }

  const volunteers = members.map((list) => list.filter((i) => people[i].willHost).length);

  // Swap pairs of guests between tables while that lowers the cost.
  for (let pass = 0; pass < 14; pass++) {
    let changed = false;
    for (let a = 0; a < n; a++) {
      if (pinned[a]) continue;
      for (let b = a + 1; b < n; b++) {
        if (pinned[b]) continue;
        const ta = where[a];
        const tb = where[b];
        if (ta === tb) continue;
        let before = revisit(a, ta) + revisit(b, tb);
        let after = revisit(a, tb) + revisit(b, ta);
        for (const m of members[ta]) {
          if (m === a) continue;
          before += pair[a * n + m];
          after += pair[b * n + m];
        }
        for (const m of members[tb]) {
          if (m === b) continue;
          before += pair[b * n + m];
          after += pair[a * n + m];
        }
        const da = (people[b].willHost ? 1 : 0) - (people[a].willHost ? 1 : 0);
        if (da !== 0) {
          before += noHostCost(volunteers[ta], members[ta].length) + noHostCost(volunteers[tb], members[tb].length);
          after += noHostCost(volunteers[ta] + da, members[ta].length) + noHostCost(volunteers[tb] - da, members[tb].length);
        }
        if (after < before - 1e-9) {
          members[ta][members[ta].indexOf(a)] = b;
          members[tb][members[tb].indexOf(b)] = a;
          where[a] = tb;
          where[b] = ta;
          volunteers[ta] += da;
          volunteers[tb] -= da;
          changed = true;
        }
      }
    }
    if (!changed) break;
  }

  let cost = 0;
  for (let ti = 0; ti < T; ti++) {
    const list = members[ti];
    cost += noHostCost(volunteers[ti], list.length);
    for (let x = 0; x < list.length; x++) {
      cost += revisit(list[x], ti);
      for (let y = x + 1; y < list.length; y++) cost += pair[list[x] * n + list[y]];
    }
  }
  return { where, cost };
}

/**
 * Seat everyone for a round. `tables` is the tables to use this round (see
 * tablesNeeded), so sizes come out at the set table size, within one seat.
 */
export function assignRound(
  people: Person[],
  tables: number[],
  opts: { seed?: number; tries?: number; budgetMs?: number } = {},
): Assignment {
  if (tables.length === 0) throw new Error("No tables");
  const result: Assignment = {};
  const n = people.length;
  if (n === 0) return result;
  const met = metPairs(people);
  const pair = new Float32Array(n * n);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const c = alike(people[i], people[j]) + (met.has(pairKey(people[i].id, people[j].id)) ? W_MET : 0);
      pair[i * n + j] = c;
      pair[j * n + i] = c;
    }
  }
  const seed = opts.seed ?? 1;
  const tries = opts.tries ?? 16;
  const deadline = Date.now() + (opts.budgetMs ?? 600);
  let best: Int32Array | null = null;
  let bestCost = Infinity;
  for (let k = 0; k < tries; k++) {
    const { where, cost } = attempt(people, tables, pair, mulberry32(seed * 1000 + k));
    if (cost < bestCost) {
      bestCost = cost;
      best = where;
    }
    if (bestCost === 0 || Date.now() > deadline) break;
  }
  // Which group sits at which table number does not change who sits together,
  // so hand the numbers out again to send as few people as possible back to a
  // table they have already sat at. A group with a pinned guest keeps its number.
  const T = tables.length;
  const fixed = new Uint8Array(T);
  const back: number[][] = tables.map(() => new Array(T).fill(0)); // back[group][number] = people revisiting
  for (let i = 0; i < n; i++) {
    const g = best![i];
    if (people[i].pinnedTable === tables[g]) fixed[g] = 1;
    for (let t = 0; t < T; t++) if (people[i].history?.includes(tables[t])) back[g][t]++;
  }
  const numberOf = tables.map((_, g) => g);
  for (let pass = 0; pass < 8; pass++) {
    let changed = false;
    for (let a = 0; a < T; a++) {
      for (let b = a + 1; b < T; b++) {
        if (fixed[a] || fixed[b]) continue;
        const now = back[a][numberOf[a]] + back[b][numberOf[b]];
        const swapped = back[a][numberOf[b]] + back[b][numberOf[a]];
        if (swapped < now) {
          [numberOf[a], numberOf[b]] = [numberOf[b], numberOf[a]];
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  for (let i = 0; i < n; i++) result[people[i].id] = tables[numberOf[best![i]]];
  return result;
}

/**
 * One host per table: someone who offered, and of those whoever has hosted
 * least so far. A table where nobody offered gets no named host.
 */
export function pickHosts(seated: Seated[], seed = 1): Record<number, string | null> {
  const rand = mulberry32(seed);
  const out: Record<number, string | null> = {};
  const byTable = new Map<number, Seated[]>();
  for (const s of seated) {
    if (!byTable.has(s.table)) byTable.set(s.table, []);
    byTable.get(s.table)!.push(s);
  }
  for (const [t, list] of byTable) {
    const volunteers = list.filter((p) => p.willHost);
    if (!volunteers.length) {
      out[t] = null;
      continue;
    }
    const least = Math.min(...volunteers.map((p) => p.hosted ?? 0));
    const pool = volunteers.filter((p) => (p.hosted ?? 0) === least);
    out[t] = pool[Math.floor(rand() * pool.length)].id;
  }
  return out;
}

export type SeatingStats = {
  sizes: Record<number, number>;
  repeatPairs: number; // pairs seated together who had already met
  revisits: number; // guests back at a table they have sat at
  tablesWithoutVolunteer: number;
};

export function stats(people: Person[], assignment: Assignment): SeatingStats {
  const met = metPairs(people);
  const byTable = new Map<number, Person[]>();
  for (const g of people) {
    const t = assignment[g.id];
    if (t == null) continue;
    if (!byTable.has(t)) byTable.set(t, []);
    byTable.get(t)!.push(g);
  }
  const out: SeatingStats = { sizes: {}, repeatPairs: 0, revisits: 0, tablesWithoutVolunteer: 0 };
  for (const [t, list] of byTable) {
    out.sizes[t] = list.length;
    if (!list.some((p) => p.willHost)) out.tablesWithoutVolunteer++;
    for (let i = 0; i < list.length; i++) {
      if (list[i].history?.includes(t)) out.revisits++;
      for (let j = i + 1; j < list.length; j++) {
        if (met.has(pairKey(list[i].id, list[j].id))) out.repeatPairs++;
      }
    }
  }
  return out;
}
