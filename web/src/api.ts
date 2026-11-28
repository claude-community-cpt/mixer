import { createClient } from "@supabase/supabase-js";

const URL_BASE = import.meta.env.VITE_SUPABASE_URL as string;
const KEY = import.meta.env.VITE_SUPABASE_KEY as string;

export const supabase = createClient(URL_BASE, KEY, { auth: { persistSession: false } });

export class ApiError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

export async function api<T = unknown>(action: string, body: Record<string, unknown> = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${URL_BASE}/functions/v1/mixer`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: KEY },
      body: JSON.stringify({ action, ...body }),
    });
  } catch {
    throw new ApiError("offline", "Can't reach the server. Check your connection.");
  }
  const json = await res.json().catch(() => null);
  if (!json || json.error) {
    throw new ApiError(json?.error?.code ?? "server", json?.error?.message ?? "Something went wrong. Please try again.");
  }
  return json.data as T;
}

export function eventCode(): string {
  const fromUrl = new URLSearchParams(location.search).get("e");
  return (fromUrl || (import.meta.env.VITE_EVENT_CODE as string) || "demo").toLowerCase();
}

export function store(key: string, value?: string | null): string | null {
  try {
    if (value === undefined) return localStorage.getItem(key);
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
    return value;
  } catch {
    return null;
  }
}

export type Phase = "lobby" | "seating" | "vote" | "wheel" | "table" | "room" | "finished";

export type EventInfo = {
  code: string;
  name: string;
  phase: Phase;
  round: number;
  totalRounds: number;
  /** Minutes of table discussion each round. */
  roundMinutes: number;
  roomMinutes: number;
  voteSeconds: number;
  votesEach: number;
  tableSize: number;
  /** One name per round for its group of topics. */
  groupNames: string[];
  /** When the running timer ends (voting, table or room discussion). */
  endsAt: string | null;
  feedbackUrl: string | null;
  cardLine: string | null;
  practice: boolean;
  serverNow: string;
};

export type RoundInfo = {
  number: number;
  group: string;
  /** The top topics once voting has closed. Vote counts are only sent to the big screen and the host. */
  top: { id: string; text: string; votes?: number }[];
  topicId: string | null;
  topic: string | null;
  spunAt: string | null;
};

export type Seat = { name: string; host: boolean };
export type RoomTable = { number: number; guests: Seat[] };

export const tableColor = (n: number) => `var(--t${((n - 1) % 8) + 1})`;
