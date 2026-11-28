import { expect, test } from "bun:test";
import { emailFingerprint, extractEmails, normaliseEmail } from "./emails.ts";

test("normaliseEmail trims and lower-cases, and rejects things that are not addresses", () => {
  expect(normaliseEmail("  Sam@Example.COM ")).toBe("sam@example.com");
  expect(normaliseEmail("sam")).toBe("");
  expect(normaliseEmail("sam@example")).toBe("");
  expect(normaliseEmail("sam @example.com")).toBe("");
  expect(normaliseEmail(null)).toBe("");
});

test("extractEmails finds each address once in a pasted list or a spreadsheet export", () => {
  const csv = [
    "name,email,approval_status",
    '"Sam Jones",Sam@Example.com,approved',
    "Thandi <thandi@example.co.za>; sam@example.com",
    "no address on this line",
    "Ends a sentence with lee@example.org.",
  ].join("\n");
  expect(extractEmails(csv)).toEqual(["sam@example.com", "thandi@example.co.za", "lee@example.org"]);
  expect(extractEmails("")).toEqual([]);
});

test("the fingerprint is stable, differs by event and by secret, and does not contain the address", async () => {
  const a = await emailFingerprint("secret", "event-1", "sam@example.com");
  expect(a).toMatch(/^[0-9a-f]{64}$/);
  expect(a).toBe(await emailFingerprint("secret", "event-1", "sam@example.com"));
  expect(a).not.toBe(await emailFingerprint("secret", "event-2", "sam@example.com"));
  expect(a).not.toBe(await emailFingerprint("other", "event-1", "sam@example.com"));
  expect(a).not.toContain("sam");
});
