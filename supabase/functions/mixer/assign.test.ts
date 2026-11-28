import { describe, expect, test } from "bun:test";
import {
  assignRound,
  mulberry32,
  type Person,
  pickHosts,
  type Seated,
  seatArrival,
  seatLate,
  settle,
  stats,
  tablesNeeded,
} from "./assign.ts";

const EXPERIENCE = ["daily", "daily", "daily", "regular", "occasional", "new"];
const ROLES = ["engineering", "engineering", "data", "product", "design", "leadership", "student"];

/** A room like the real sign-ups: mostly daily users, about four in ten offered to host. */
function makePeople(n: number, seed = 7): Person[] {
  const rand = mulberry32(seed);
  return Array.from({ length: n }, (_, i) => ({
    id: "g" + String(i).padStart(3, "0"),
    experience: EXPERIENCE[Math.floor(rand() * EXPERIENCE.length)],
    role: ROLES[Math.floor(rand() * ROLES.length)],
    willHost: rand() < 0.4,
    hosted: 0,
    history: [],
  }));
}
const numbers = (t: number) => Array.from({ length: t }, (_, i) => i + 1);

function arrive(people: Person[], size: number, roomTables: number): Seated[] {
  const seated: Seated[] = [];
  let last: number | null = null;
  for (const p of people) {
    const table = seatArrival(seated, p, { size, tables: numbers(roomTables), lastTable: last });
    seated.push({ ...p, table });
    last = table;
  }
  return seated;
}
function sizes(seated: Seated[]): number[] {
  const m = new Map<number, number>();
  for (const s of seated) m.set(s.table, (m.get(s.table) ?? 0) + 1);
  return [...m.values()];
}

describe("tablesNeeded", () => {
  test("enough tables for the set size, capped by the room", () => {
    expect(tablesNeeded(70, 6, 14)).toBe(12);
    expect(tablesNeeded(45, 6, 14)).toBe(8);
    expect(tablesNeeded(70, 6, 9)).toBe(9);
    expect(tablesNeeded(0, 6, 9)).toBe(1);
  });
});

describe("seatArrival", () => {
  test("fills tables to the set size, with at most two part-filled at any moment", () => {
    const people = makePeople(70);
    const seated: Seated[] = [];
    for (const p of people) {
      seated.push({ ...p, table: seatArrival(seated, p, { size: 6, tables: numbers(14) }) });
      const s = sizes(seated);
      expect(Math.max(...s)).toBeLessThanOrEqual(6);
      expect(s.filter((n) => n < 6).length).toBeLessThanOrEqual(2);
    }
    // 70 people: eleven full tables, and the last four people across two more.
    expect(sizes(seated).length).toBe(13);
  });

  test("nobody is moved by a later arrival", () => {
    const people = makePeople(40);
    const first = arrive(people.slice(0, 25), 6, 10);
    const all = arrive(people, 6, 10);
    for (const s of first) expect(all.find((a) => a.id === s.id)!.table).toBe(s.table);
  });

  test("when the room is full, extra people take a seventh seat at the smallest table", () => {
    const seated = arrive(makePeople(27), 6, 4);
    const s = sizes(seated);
    expect(s.length).toBe(4);
    expect(Math.max(...s) - Math.min(...s)).toBeLessThanOrEqual(1);
  });

  test("people who offered to host are spread across tables", () => {
    const seated = arrive(makePeople(60), 6, 12);
    const without = numbers(10).filter((t) => !seated.some((s) => s.table === t && s.willHost));
    expect(without.length).toBeLessThanOrEqual(1);
  });

  test("a pinned guest gets their table", () => {
    const seated = arrive(makePeople(10), 6, 5);
    expect(seatArrival(seated, { id: "x", pinnedTable: 5 }, { size: 6, tables: numbers(5) })).toBe(5);
  });
});

describe("settle", () => {
  test("folds a last table of three or fewer into the others, and moves nobody else", () => {
    for (const n of [13, 14, 15, 19, 25, 31, 44, 45, 50, 57, 62]) {
      const seated = arrive(makePeople(n, n), 6, 14);
      const moves = settle(seated, 6);
      const after = seated.map((s) => ({ ...s, table: moves[s.id] ?? s.table }));
      const s = sizes(after);
      expect(Math.max(...s)).toBeLessThanOrEqual(7);
      expect(s.filter((x) => x <= 3).length).toBeLessThanOrEqual(1);
      expect(Object.keys(moves).length).toBeLessThanOrEqual(4);
    }
  });

  test("70 people end up at twelve tables, with one person moved", () => {
    const seated = arrive(makePeople(70), 6, 14);
    const moves = settle(seated, 6);
    const after = seated.map((s) => ({ ...s, table: moves[s.id] ?? s.table }));
    expect(sizes(after).sort().join(" ")).toBe("4 6 6 6 6 6 6 6 6 6 6 6");
    expect(Object.keys(moves).length).toBe(1);
  });

  test("leaves full and nearly full tables alone", () => {
    const seated: Seated[] = [6, 6, 5, 4].flatMap((n, t) => Array.from({ length: n }, (_, i) => ({ id: `t${t}p${i}`, table: t + 1 })));
    expect(settle(seated, 6)).toEqual({});
  });

  test("keeps a table of three when folding it would crowd the others", () => {
    const seated: Seated[] = [6, 6, 3].flatMap((n, t) => Array.from({ length: n }, (_, i) => ({ id: `t${t}p${i}`, table: t + 1 })));
    expect(settle(seated, 6)).toEqual({});
  });

  test("a single small table stays put", () => {
    const seated = arrive(makePeople(3), 6, 14).map((s) => ({ ...s, table: 1 }));
    expect(settle(seated, 6)).toEqual({});
  });
});

describe("assignRound", () => {
  function run(n: number, size: number, rounds: number) {
    const people = makePeople(n);
    // Round 1 is the arrival seating.
    const first = arrive(people, size, 30);
    for (const p of people) p.history = [first.find((s) => s.id === p.id)!.table];
    const out = { repeats: 0, revisits: 0, spread: 0, noVolunteer: 0, biggest: 0 };
    for (let r = 2; r <= rounds; r++) {
      const tables = numbers(tablesNeeded(n, size, 30));
      const a = assignRound(people, tables, { seed: r });
      expect(Object.keys(a).length).toBe(n);
      const s = stats(people, a);
      const list = Object.values(s.sizes);
      out.repeats += s.repeatPairs;
      out.revisits += s.revisits;
      out.noVolunteer += s.tablesWithoutVolunteer;
      out.spread = Math.max(out.spread, Math.max(...list) - Math.min(...list));
      out.biggest = Math.max(out.biggest, ...list);
      for (const p of people) p.history!.push(a[p.id]);
    }
    return out;
  }

  test("70 people, tables of 6, three rounds: full tables, new faces, a host everywhere", () => {
    const r = run(70, 6, 3);
    expect(r.spread).toBeLessThanOrEqual(1);
    expect(r.biggest).toBeLessThanOrEqual(6);
    expect(r.repeats).toBe(0);
    expect(r.revisits).toBe(0);
    expect(r.noVolunteer).toBe(0);
  });

  test("45 people use 8 tables and still meet new people", () => {
    const r = run(45, 6, 3);
    expect(r.spread).toBeLessThanOrEqual(1);
    expect(r.biggest).toBeLessThanOrEqual(6);
    expect(r.repeats).toBeLessThanOrEqual(2);
    expect(r.noVolunteer).toBe(0);
  });

  test("a small room still works", () => {
    const r = run(11, 6, 3);
    expect(r.spread).toBeLessThanOrEqual(1);
  });

  test("mixes experience levels: no table is all newcomers", () => {
    const people: Person[] = Array.from({ length: 36 }, (_, i) => ({
      id: "p" + i, experience: i < 6 ? "new" : "daily", willHost: i % 3 === 0, history: [],
    }));
    const a = assignRound(people, numbers(6));
    for (const t of numbers(6)) {
      expect(people.filter((p) => a[p.id] === t && p.experience === "new").length).toBe(1);
    }
  });

  test("keeps a pinned guest at their table", () => {
    const people = makePeople(30);
    people[4].pinnedTable = 2;
    people[4].history = [2];
    expect(assignRound(people, numbers(5))[people[4].id]).toBe(2);
  });

  test("is quick for a full room", () => {
    const people = makePeople(150);
    for (const p of people) p.history = [1 + Math.floor(Math.random() * 25)];
    const t0 = Date.now();
    assignRound(people, numbers(25));
    expect(Date.now() - t0).toBeLessThan(1500);
  });
});

describe("seatLate", () => {
  test("goes to the smallest table in use", () => {
    const seated: Seated[] = [
      { id: "a", table: 1 }, { id: "b", table: 1 }, { id: "c", table: 2 }, { id: "d", table: 3 }, { id: "e", table: 3 },
    ];
    expect(seatLate(seated, { id: "x" }, [1, 2, 3])).toBe(2);
  });
});

describe("pickHosts", () => {
  test("picks someone who offered, and whoever has hosted least", () => {
    const seated: Seated[] = [
      { id: "a", table: 1, willHost: true, hosted: 1 },
      { id: "b", table: 1, willHost: true, hosted: 0 },
      { id: "c", table: 1 },
      { id: "d", table: 2 },
      { id: "e", table: 2 },
    ];
    expect(pickHosts(seated)).toEqual({ 1: "b", 2: null });
  });
});
