// Reads the guest export from the event sign-up page and keeps only what the
// app needs: the email (to match people at the door), first name, how much
// they use Claude, whether they offered to host a table, the kind of work they
// do, and the question they sent in. Every other column is left behind, in the
// browser, and never sent anywhere.

export type Experience = "daily" | "regular" | "occasional" | "new";

export type SignupRow = {
  email: string;
  firstName: string;
  experience: Experience | null;
  willHost: boolean;
  /** A broad kind of work, such as "engineering", not the job title. */
  role: string | null;
  question: string | null;
};

/** Splits comma-separated text into rows of cells, with quoted cells and line breaks inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(cell);
      cell = "";
      if (row.some((x) => x.trim())) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim())) rows.push(row);
  return rows;
}

export function experienceOf(raw: string): Experience | null {
  const s = raw.toLowerCase();
  if (s.includes("daily")) return "daily";
  if (s.includes("regular")) return "regular";
  if (s.includes("occasional")) return "occasional";
  if (s.includes("new")) return "new";
  return null;
}

const ROLE_WORDS: [string, RegExp][] = [
  ["student", /\bstudent|\bintern\b|graduate\b/],
  ["leadership", /\bfounder|\bco-?founder|\bceo\b|\bcto\b|\bcoo\b|\bcio\b|\bcfo\b|\bowner|\bdirector|\bhead of|\bvp\b|\bchief|\bmanaging|\bpartner\b|\bexecutive|\bprincipal\b/],
  ["data", /\bdata\b|\banalyst|\banalytics|\bscientist|machine learning|\bml\b|\bbi\b/],
  ["engineering", /engineer|developer|\bdev\b|software|programmer|architect|\bsre\b|devops|full.?stack|back.?end|front.?end|tech lead|\bqa\b|tester|\bit\b/],
  ["product", /\bproduct|project manager|programme|program manager|scrum|delivery/],
  ["design", /design|\bux\b|\bui\b|creative|\bartist|writer|content/],
  ["education", /teacher|lecturer|research|professor|academic|educat|tutor|trainer/],
  ["business", /marketing|sales|growth|business|consult|account|financ|operations|\bhr\b|recruit|legal|lawyer|attorney|support|manager|admin/],
];

/** A broad kind of work from a free-text job title. "" in, null out. */
export function roleGroup(raw: string): string | null {
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  for (const [group, words] of ROLE_WORDS) if (words.test(s)) return group;
  return "other";
}

const BLANK_QUESTION = /^(n\/?a|none|no|nope|nothing|not sure|unsure|tbd|tbc|idk|\?+|-+|\.+)$/i;

/**
 * The people in a guest export. Only approved guests are kept when the export
 * says who is approved. Returns null if the text has no header row with an
 * email column, so the caller can treat it as a plain list of addresses.
 */
export function readSignups(text: string): { rows: SignupRow[]; notApproved: number } | null {
  const cells = parseCsv(text);
  if (cells.length < 2) return null;
  const header = cells[0].map((h) => h.trim().toLowerCase());
  const find = (...tests: ((h: string) => boolean)[]) => {
    for (const t of tests) {
      const i = header.findIndex(t);
      if (i >= 0) return i;
    }
    return -1;
  };
  const email = find((h) => h === "email", (h) => h === "email address");
  if (email < 0) return null;
  const first = find((h) => h === "first_name" || h === "first name", (h) => h === "name");
  const status = find((h) => h === "approval_status");
  const experience = find((h) => h.includes("experience"));
  const question = find((h) => h.includes("question or topic"), (h) => h.includes("topic"), (h) => h.includes("question"));
  const hosting = find((h) => h.includes("facilitate"), (h) => h.includes("host"));
  const role = find((h) => h.includes("your role"), (h) => h === "role", (h) => h.includes("job title"));
  const at = (r: string[], i: number) => (i >= 0 ? (r[i] ?? "").trim() : "");

  const rows: SignupRow[] = [];
  const seen = new Set<string>();
  let notApproved = 0;
  for (const r of cells.slice(1)) {
    const address = at(r, email).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address) || seen.has(address)) continue;
    if (status >= 0 && at(r, status).toLowerCase() !== "approved") {
      notApproved++;
      continue;
    }
    seen.add(address);
    const q = at(r, question).replace(/\s+/g, " ");
    rows.push({
      email: address,
      firstName: at(r, first).split(/\s+/)[0] ?? "",
      experience: experienceOf(at(r, experience)),
      willHost: /^(yes|y|true)\b/i.test(at(r, hosting)),
      role: roleGroup(at(r, role)),
      question: q && !BLANK_QUESTION.test(q) ? q : null,
    });
  }
  return { rows, notApproved };
}
