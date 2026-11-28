// A small in-memory stand-in for the database, for tests only. It copies just
// enough of the Supabase query builder for app.ts to run a whole event without
// touching a real project: filters, ordering, insert, update, upsert, delete,
// column defaults, unique keys and the cascades the schema declares.
// deno-lint-ignore-file no-explicit-any
type Row = Record<string, any>;

type TableSpec = {
  defaults: () => Row;
  /** Primary key first, then any other unique keys. */
  unique: string[][];
};

let clock = 0;
/** Timestamps always move forward, so "order by joined_at" matches insert order. */
const stamp = () => new Date(Date.UTC(2026, 0, 1) + ++clock).toISOString();
const id = () => crypto.randomUUID();

const SPECS: Record<string, TableSpec> = {
  events: {
    defaults: () => ({
      id: id(), phase: "lobby", round: 0, total_rounds: 3, round_minutes: 25, round_ends_at: null, current_poll: null,
      pin_fail_count: 0, pin_locked_until: null, feedback_url: null, created_at: stamp(), table_size: 6, vote_seconds: 120,
      room_minutes: 10, votes_each: 2, group_names: ["Serious", "Practical", "Fun"], card_line: null, practice_of: null,
    }),
    unique: [["id"], ["code"]],
  },
  tables: { defaults: () => ({ id: id(), topic: "", starter: "", open: true }), unique: [["id"], ["event_id", "number"]] },
  guests: {
    defaults: () => ({
      id: id(), token: id(), device_id: null, pinned_table: null, joined_at: stamp(), left_at: null, registered: null,
      email_hash: null, experience: null, will_host: false, role_group: null, interest: null, bot: false,
    }),
    unique: [["id"], ["token"], ["event_id", "email_hash"]],
  },
  seats: { defaults: () => ({ is_host: false, moved: false }), unique: [["event_id", "round", "guest_id"]] },
  registrations: {
    defaults: () => ({ guest_id: null, first_name: null, experience: null, will_host: false, role_group: null, interest: null, question: null }),
    unique: [["event_id", "email_hash"]],
  },
  topics: {
    defaults: () => ({ id: id(), grp: null, status: "approved", source: "host", guest_id: null, position: 0, created_at: stamp() }),
    unique: [["id"]],
  },
  topic_votes: { defaults: () => ({ created_at: stamp() }), unique: [["event_id", "round", "guest_id", "topic_id"]] },
  rounds: {
    defaults: () => ({ top_ids: [], top_votes: [], topic_id: null, topic_text: null, spun_at: null }),
    unique: [["event_id", "round"]],
  },
  ratings: { defaults: () => ({}), unique: [["event_id", "round", "guest_id"]] },
  hosts: { defaults: () => ({ label: "", event_id: null }), unique: [["email_hash"]] },
};

/** child table -> [column, parent table, what happens when the parent row goes] */
const REFS: [string, string, string, "cascade" | "null"][] = [
  ["events", "practice_of", "events", "cascade"],
  ["tables", "event_id", "events", "cascade"],
  ["guests", "event_id", "events", "cascade"],
  ["seats", "event_id", "events", "cascade"],
  ["seats", "guest_id", "guests", "cascade"],
  ["registrations", "event_id", "events", "cascade"],
  ["registrations", "guest_id", "guests", "null"],
  ["topics", "event_id", "events", "cascade"],
  ["topics", "guest_id", "guests", "null"],
  ["topic_votes", "event_id", "events", "cascade"],
  ["topic_votes", "guest_id", "guests", "cascade"],
  ["topic_votes", "topic_id", "topics", "cascade"],
  ["rounds", "event_id", "events", "cascade"],
  ["rounds", "topic_id", "topics", "null"],
  ["ratings", "event_id", "events", "cascade"],
  ["ratings", "guest_id", "guests", "cascade"],
  ["hosts", "event_id", "events", "cascade"],
];

type Result = { data: any; error: { message: string } | null };

export class FakeDb {
  data: Record<string, Row[]> = Object.fromEntries(Object.keys(SPECS).map((t) => [t, []]));

  from(table: string): any {
    if (!SPECS[table]) throw new Error(`fakedb: unknown table ${table}`);
    return new Query(this, table);
  }

  remove(table: string, rows: Row[]) {
    if (!rows.length) return;
    this.data[table] = this.data[table].filter((r) => !rows.includes(r));
    const ids = new Set(rows.map((r) => r.id).filter(Boolean));
    if (!ids.size) return;
    for (const [child, column, parent, rule] of REFS) {
      if (parent !== table) continue;
      const hit = this.data[child].filter((r) => ids.has(r[column]));
      if (rule === "cascade") this.remove(child, hit);
      else for (const r of hit) r[column] = null;
    }
  }
}

class Query {
  private op: "select" | "insert" | "update" | "upsert" | "delete" = "select";
  private filters: ((r: Row) => boolean)[] = [];
  private orders: string[] = [];
  private max = Infinity;
  private payload: Row[] = [];
  private patch: Row = {};
  private conflict: string[] | null = null;
  private ignoreDuplicates = false;
  private one: "maybe" | "single" | null = null;
  private columns: string[] | null = null;

  constructor(private db: FakeDb, private table: string) {}

  select(columns = "*") {
    this.columns = columns.trim() === "*" ? null : columns.split(",").map((c) => c.trim());
    return this;
  }
  insert(rows: Row | Row[]) {
    this.op = "insert";
    this.payload = Array.isArray(rows) ? rows : [rows];
    return this;
  }
  upsert(rows: Row | Row[], opts: { onConflict?: string; ignoreDuplicates?: boolean } = {}) {
    this.op = "upsert";
    this.payload = Array.isArray(rows) ? rows : [rows];
    this.conflict = opts.onConflict ? opts.onConflict.split(",").map((c) => c.trim()) : null;
    this.ignoreDuplicates = !!opts.ignoreDuplicates;
    return this;
  }
  update(patch: Row) {
    this.op = "update";
    this.patch = patch;
    return this;
  }
  delete() {
    this.op = "delete";
    return this;
  }
  eq(c: string, v: unknown) { this.filters.push((r) => r[c] === v); return this; }
  neq(c: string, v: unknown) { this.filters.push((r) => r[c] !== v); return this; }
  gt(c: string, v: any) { this.filters.push((r) => r[c] > v); return this; }
  in(c: string, list: unknown[]) { this.filters.push((r) => list.includes(r[c])); return this; }
  is(c: string, v: null) { this.filters.push((r) => (r[c] ?? null) === v); return this; }
  order(c: string) { this.orders.push(c); return this; }
  limit(n: number) { this.max = n; return this; }
  maybeSingle() { this.one = "maybe"; return this; }
  single() { this.one = "single"; return this; }

  then<T>(resolve: (r: Result) => T, reject?: (e: unknown) => T) {
    try {
      return Promise.resolve(resolve(this.run()));
    } catch (e) {
      return reject ? Promise.resolve(reject(e)) : Promise.reject(e);
    }
  }

  private matching(): Row[] {
    return this.db.data[this.table].filter((r) => this.filters.every((f) => f(r)));
  }

  private clash(row: Row, except?: Row): string[] | null {
    for (const key of SPECS[this.table].unique) {
      if (key.some((c) => row[c] == null)) continue; // nulls never clash, as in Postgres
      if (this.db.data[this.table].some((r) => r !== except && key.every((c) => r[c] === row[c]))) return key;
    }
    return null;
  }

  private run(): Result {
    const spec = SPECS[this.table];
    let rows: Row[];
    if (this.op === "select") {
      rows = this.matching();
      for (const c of [...this.orders].reverse()) rows.sort((a, b) => (a[c] < b[c] ? -1 : a[c] > b[c] ? 1 : 0));
      rows = rows.slice(0, this.max);
    } else if (this.op === "insert") {
      rows = [];
      for (const p of this.payload) {
        const row = { ...spec.defaults(), ...p };
        const key = this.clash(row);
        if (key) return { data: null, error: { message: `duplicate key value violates unique constraint on ${this.table}(${key.join(", ")})` } };
        this.db.data[this.table].push(row);
        rows.push(row);
      }
    } else if (this.op === "upsert") {
      const key = this.conflict ?? spec.unique[0];
      rows = [];
      for (const p of this.payload) {
        const found = this.db.data[this.table].find((r) => key.every((c) => r[c] === p[c]));
        if (found) {
          if (this.ignoreDuplicates) continue;
          Object.assign(found, p);
          rows.push(found);
        } else {
          const row = { ...spec.defaults(), ...p };
          this.db.data[this.table].push(row);
          rows.push(row);
        }
      }
    } else if (this.op === "update") {
      rows = this.matching();
      for (const r of rows) {
        const next = { ...r, ...this.patch };
        const key = this.clash(next, r);
        if (key) return { data: null, error: { message: `duplicate key value violates unique constraint on ${this.table}(${key.join(", ")})` } };
        Object.assign(r, this.patch);
      }
    } else {
      rows = this.matching();
      this.db.remove(this.table, rows);
    }
    const out = rows.map((r) => (this.columns ? Object.fromEntries(this.columns.map((c) => [c, r[c]])) : { ...r }));
    if (this.one === "single") {
      return out.length === 1 ? { data: out[0], error: null } : { data: null, error: { message: "expected exactly one row" } };
    }
    if (this.one === "maybe") {
      return out.length <= 1 ? { data: out[0] ?? null, error: null } : { data: null, error: { message: "expected at most one row" } };
    }
    return { data: out, error: null };
  }
}
