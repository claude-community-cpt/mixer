import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, supabase } from "./api";

// Loads a view from the API and keeps it fresh: on every "changed" ping from
// the event's live channel, on a slow timer as a safety net, and whenever the
// page becomes visible again.
export function useLive<T>(code: string, load: (() => Promise<T>) | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [stale, setStale] = useState(false);
  const loadRef = useRef(load);
  loadRef.current = load;
  const busy = useRef(false);
  const again = useRef(false);

  const refresh = useCallback(async () => {
    if (!loadRef.current) return;
    if (busy.current) {
      again.current = true;
      return;
    }
    busy.current = true;
    try {
      const d = await loadRef.current();
      setData(d);
      setError(null);
      setStale(false);
    } catch (e) {
      const err = e instanceof ApiError ? e : new ApiError("server", "Something went wrong.");
      if (err.code === "offline" || err.code === "server") setStale(true);
      else setError(err);
    } finally {
      busy.current = false;
      if (again.current) {
        again.current = false;
        refresh();
      }
    }
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: load is a new function every render, so the effect keys on whether it exists plus the caller's deps
  useEffect(() => {
    if (!load) {
      setData(null);
      return;
    }
    refresh();
    const channel = supabase.channel(`event:${code}`).on("broadcast", { event: "changed" }, () => refresh()).subscribe();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, 8000);
    const onVisible = () => document.visibilityState === "visible" && refresh();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", refresh);
    return () => {
      supabase.removeChannel(channel);
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", refresh);
    };
  }, [code, !!load, refresh, ...deps]);

  return { data, setData, error, stale, refresh };
}

// Seconds left in the round, corrected for the phone's clock being off.
export function useCountdown(endsAt: string | null | undefined, serverNow: string | undefined) {
  const [left, setLeft] = useState<number | null>(null);
  useEffect(() => {
    if (!endsAt || !serverNow) {
      setLeft(null);
      return;
    }
    const offset = new Date(serverNow).getTime() - Date.now();
    const tick = () => setLeft(Math.max(0, Math.round((new Date(endsAt).getTime() - (Date.now() + offset)) / 1000)));
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [endsAt, serverNow]);
  return left;
}

export function clock(seconds: number | null) {
  if (seconds == null) return "";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** How long the wheel turns for. Phones wait this long before showing the topic. */
export const SPIN_MS = 5200;

// Where the wheel is: not spun, turning, or settled on the topic.
export function useSpin(spunAt: string | null | undefined, serverNow: string | undefined): "waiting" | "spinning" | "done" {
  const [state, setState] = useState<"waiting" | "spinning" | "done">("waiting");
  // How far this device's clock is from the server's. Kept in a ref, because
  // serverNow changes on every refresh and only a new spin should restart the wait.
  const offset = useRef(0);
  if (serverNow) offset.current = new Date(serverNow).getTime() - Date.now();
  const known = !!serverNow;
  useEffect(() => {
    if (!spunAt || !known) {
      setState("waiting");
      return;
    }
    const left = new Date(spunAt).getTime() + SPIN_MS - (Date.now() + offset.current);
    if (left <= 0) {
      setState("done");
      return;
    }
    setState("spinning");
    const t = setTimeout(() => setState("done"), left);
    return () => clearTimeout(t);
  }, [spunAt, known]);
  return state;
}

// When a timer reaches zero the server moves the event on at the next request,
// so ask straight away, and keep asking until the timer is replaced.
export function useRefreshAtZero(left: number | null, refresh: () => void) {
  const zero = left === 0;
  useEffect(() => {
    if (!zero) return;
    refresh();
    const t = setInterval(refresh, 2000);
    return () => clearInterval(t);
  }, [zero, refresh]);
}
