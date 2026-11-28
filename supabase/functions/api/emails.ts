// Matching a guest to the event sign-up list without keeping email addresses.
// Only a keyed fingerprint of each address is ever stored.

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const IN_TEXT = /[^\s,;:<>"'()[\]]+@[^\s,;:<>"'()[\]]+\.[^\s,;:<>"'()[\]]+/g;

/** Lower-case and trim, so "  Sam@Example.com " and "sam@example.com" match. Returns "" if it is not an email address. */
export function normaliseEmail(raw: unknown): string {
  const email = String(raw ?? "").trim().toLowerCase();
  return email.length <= 254 && EMAIL.test(email) ? email : "";
}

/** Every email address in a pasted list or a spreadsheet export, each one once. */
export function extractEmails(text: unknown): string[] {
  const found = String(text ?? "").match(IN_TEXT) ?? [];
  const out = new Set<string>();
  for (const f of found) {
    const email = normaliseEmail(f.replace(/[.]+$/, ""));
    if (email) out.add(email);
  }
  return [...out];
}

/**
 * The fingerprint that is stored in place of an address. It is keyed with a
 * secret that lives outside the database, and with the event, so the same
 * address gives a different fingerprint at every event and a copy of the
 * database alone cannot be used to test guesses.
 */
export async function emailFingerprint(secret: string, eventId: string, email: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(`${eventId}:${email}`));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
