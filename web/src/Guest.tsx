import { useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, eventCode, store, tableColor, type EventInfo, type RoundInfo, type Seat } from "./api";
import { clock, useCountdown, useLive, useRefreshAtZero, useSpin } from "./useLive";
import { Brand } from "./Brand";
import { drawCard, stickerFor } from "./card";

type GuestView = {
  event: EventInfo;
  me: { name: string; left: boolean };
  round: RoundInfo | null;
  table: null | { number: number; moved: boolean; iAmHost: boolean; host: string | null; mates: Seat[]; newFaces: number | null };
  topics: null | {
    groups: { round: number; name: string; count: number }[];
    mine: { text: string; status: "approved" | "pending" | "hidden" }[];
    canSuggest: boolean;
  };
  vote: null | { options: { id: string; text: string }[]; mine: string[]; max: number };
  rating: null | { mine: boolean | null };
};

function deviceId() {
  let id = store("tm:device");
  if (!id) {
    id = crypto.randomUUID?.() ?? String(Math.random()).slice(2) + Date.now();
    store("tm:device", id);
  }
  return id;
}

export function Guest() {
  const code = useMemo(eventCode, []);
  const tokenKey = `tm:${code}:token`;
  const [token, setToken] = useState<string | null>(() => store(tokenKey));
  const live = useLive<GuestView>(code, token ? () => api("view", { token }) : null, [token]);

  // The server no longer knows this phone (data wiped, or removed by the host).
  const forgotten = live.error?.code === "no_guest";
  useEffect(() => {
    if (token && forgotten) {
      store(tokenKey, null);
      setToken(null);
    }
  }, [token, forgotten, tokenKey]);

  return (
    <main className="guest">
      <Brand />
      {!token ? (
        <Join code={code} onJoined={(t) => { store(tokenKey, t); setToken(t); }} />
      ) : !live.data ? (
        <p className="sub">{live.stale ? "Trying to connect..." : "Loading..."}</p>
      ) : (
        <Joined view={live.data} token={token} refresh={live.refresh} />
      )}
      {live.stale && live.data && (
        <p className="banner" role="status">
          Reconnecting. {live.data.table ? `Your table is still ${live.data.table.number}.` : "Hang tight."}
        </p>
      )}
      <footer>A volunteer-run community tool. Not an Anthropic product.</footer>
    </main>
  );
}

function Join({ code, onJoined }: { code: string; onJoined: (token: string) => void }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  // What the event is called, and whether it has a sign-up list to match against.
  // Until we know, the email box stays hidden.
  const [info, setInfo] = useState<{ name: string; asksEmail: boolean; practice: boolean } | null>(null);
  const [asksEmail, setAsksEmail] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let on = true;
    api<{ name: string; asksEmail: boolean; practice: boolean }>("info", { code })
      .then((d) => { if (on) { setInfo(d); setAsksEmail(!!d.asksEmail); } })
      .catch(() => {});
    return () => { on = false; };
  }, [code]);

  async function join(anyway: boolean) {
    if (!name.trim()) return setError("Type a first name to join.");
    if (asksEmail && !email.trim()) return setError("Type the email address you registered with.");
    setBusy(true);
    setError("");
    try {
      const d = await api<{ token: string }>("join", { code, name, deviceId: deviceId(), ...(asksEmail ? { email, anyway } : {}) });
      onJoined(d.token);
    } catch (err) {
      const e = err instanceof ApiError ? err : null;
      // The server asks for an email if a sign-up list was loaded after this page opened.
      if (e?.code === "bad_email") setAsksEmail(true);
      setNotFound(e?.code === "email_not_found");
      setError(e ? e.message : "Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={(e) => { e.preventDefault(); join(false); }} className="stack">
      <h1 className="welcome"><small>Welcome to</small> {info?.name ?? " "}</h1>
      {info?.practice && <p className="warn">This is a practice event. Nothing here is real.</p>}
      <p className="sub">Pop in your first name and we'll give you a table.</p>
      <label className="label" htmlFor="name">First name</label>
      <input id="name" value={name} onChange={(e) => setName(e.target.value)} maxLength={20} autoComplete="given-name" autoFocus />
      {asksEmail && (
        <>
          <label className="label" htmlFor="email">Email you registered with</label>
          <input id="email" type="email" inputMode="email" autoComplete="email" autoCapitalize="none" spellCheck={false} maxLength={254}
            value={email} onChange={(e) => { setEmail(e.target.value); setNotFound(false); }} aria-describedby="email-note" />
          <p className="fine" id="email-note">Only used to match you to your event sign-up. We don't store it and we won't email you.</p>
        </>
      )}
      {error && <p className="error" role="alert">{error}</p>}
      <button type="submit" className="primary big" disabled={busy}>{busy ? "Joining..." : "Get my table"}</button>
      {notFound && (
        <button type="button" className="big" disabled={busy} onClick={() => join(true)}>Join anyway and tell a host</button>
      )}
      <p className="fine">
        Your first name is shown to other guests and on the big screen, and deleted after the event.
        {asksEmail && " Been here already today? Use the same name and email to pick up where you were."}
      </p>
    </form>
  );
}

function Joined({ view, token, refresh }: { view: GuestView; token: string; refresh: () => void }) {
  const { event, me, table, round } = view;
  const left = useCountdown(event.endsAt, event.serverNow);
  useRefreshAtZero(left, refresh);
  const spin = useSpin(round?.spunAt, event.serverNow);
  const steps = (
    <div className="steps" role="img" aria-label={`Round ${round?.number ?? 1} of ${event.totalRounds}`}>
      {Array.from({ length: event.totalRounds }, (_, i) => <i key={i} className={(round?.number ?? 0) > i ? "on" : ""} />)}
    </div>
  );

  if (me.left) {
    return <div className="stack"><h1>Thanks for coming, {me.name}</h1><p className="sub">You've been marked as gone. If that's a mistake, tell a host and they'll bring you back.</p></div>;
  }
  if (event.phase === "finished") return <Finished event={event} name={me.name} token={token} />;
  if (!round) return <p className="sub">Loading...</p>;
  if (!table) {
    return <div className="stack">{steps}<h1>Nearly there, {me.name}</h1><p className="sub">Your table will show up here in a moment. If it doesn't, tell a host.</p></div>;
  }

  const timer = left != null && <span className={"timer" + (left === 0 ? " done" : "")}>{clock(left)}</span>;
  const head = (label: string) => (
    <div className="row between">
      <span className="label">{label}</span>
      {timer}
    </div>
  );
  const number = <div className="bignum" style={{ color: tableColor(table.number) }}>{table.number}</div>;
  const small = <p className="tableline">Your table: <strong style={{ color: tableColor(table.number) }}>{table.number}</strong></p>;
  const nextGroup = event.groupNames[round.number] ?? "";
  const topicCard = round.topic && (
    <div className="card topic">
      <span className="label">This round's topic</span>
      <h2>{round.topic}</h2>
    </div>
  );

  if (event.phase === "lobby") {
    return (
      <div className="stack">
        {steps}
        <h1>You're in, {me.name}</h1>
        {head("Round 1 · your table")}
        {number}
        <p className="sub">Grab a coffee and find your table. We start after the welcome, and your table changes each round.</p>
        <Mates table={table} />
        <Topics view={view} token={token} refresh={refresh} />
      </div>
    );
  }
  if (event.phase === "seating") {
    return (
      <div className="stack">
        {steps}
        {head(`Round ${round.number} of ${event.totalRounds} · your new table`)}
        {number}
        {table.newFaces != null && table.mates.length > 0 && (
          <p className="sub">{table.newFaces === table.mates.length ? "Everyone at this table is new to you." : `${table.newFaces} new ${table.newFaces === 1 ? "face" : "faces"} at this table.`}</p>
        )}
        <Mates table={table} />
        <p className="sub">Coming up: a vote on the {round.group.toLowerCase()} topics.</p>
        <Topics view={view} token={token} refresh={refresh} />
      </div>
    );
  }
  if (event.phase === "vote" && view.vote) {
    return (
      <div className="stack">
        {steps}
        {head(`Round ${round.number} · the ${round.group.toLowerCase()} one`)}
        {table.moved && <p className="warn">Your table is now {table.number}. We moved a few people so every table is full.</p>}
        <Ballot key={round.number} vote={view.vote} token={token} />
        {small}
      </div>
    );
  }
  if (event.phase === "wheel" || (event.phase === "table" && spin === "spinning")) {
    return (
      <div className="stack">
        {steps}
        {head(`Round ${round.number} of ${event.totalRounds}`)}
        {spin === "done" && round.topic ? topicCard : (
          <div className="card topic">
            <span className="label">{round.spunAt ? "The wheel is turning" : "Voting has closed"}</span>
            <h2>Eyes on the big screen</h2>
            <p className="sub">The wheel picks one of the room's top {round.top.length === 3 ? "three" : "topics"}.</p>
          </div>
        )}
        {small}
        <Mates table={table} />
      </div>
    );
  }
  if (event.phase === "table") {
    return (
      <div className="stack">
        {steps}
        {head(`Round ${round.number} of ${event.totalRounds} · at your table`)}
        {number}
        {topicCard}
        {table.iAmHost ? (
          <div className="card hostcard">
            <h3>{me.name}, you're hosting this table</h3>
            <ol>
              <li>Say hello and introduce yourself. Then go round the table: name, and how each person uses Claude.</li>
              <li>Read the topic out and ask who wants to start.</li>
              <li>Keep it moving so everyone gets a turn.</li>
              <li>Near the end, agree one thought to share with the room.</li>
            </ol>
          </div>
        ) : !table.host ? (
          <div className="card hostcard">
            <h3>Who will kick things off?</h3>
            <p className="sub">Nobody at this table is down to host. Start with names and how you each use Claude, then take the topic from there.</p>
          </div>
        ) : null}
        <Mates table={table} />
      </div>
    );
  }
  // room discussion
  return (
    <div className="stack">
      {steps}
      {head("Open discussion with the room")}
      {topicCard}
      {view.rating && <Rating key={round.number} mine={view.rating.mine} token={token} />}
      <p className="sub">
        {round.number < event.totalRounds
          ? `Next up is round ${round.number + 1}${nextGroup ? `, the ${nextGroup.toLowerCase()} one` : ""}, at a new table.`
          : "That was the last round. Stay where you are for the wrap-up."}
      </p>
      {round.number < event.totalRounds && <Topics view={view} token={token} refresh={refresh} />}
    </div>
  );
}

function Mates({ table }: { table: NonNullable<GuestView["table"]> }) {
  return (
    <div>
      <span className="label">With you at table {table.number}</span>
      <div className="chips">
        {table.mates.length
          ? table.mates.map((m) => <span className={"chip" + (m.host ? " hosting" : "")} key={m.name}>{m.name}{m.host ? " · hosting" : ""}</span>)
          : <span className="sub">You're first at the table.</span>}
      </div>
    </div>
  );
}

function Topics({ view, token, refresh }: { view: GuestView; token: string; refresh: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const topics = view.topics;
  if (!topics) return null;
  const status = { pending: "waiting for a host to read it", approved: "added to the list", hidden: "not added this time" };
  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    setBusy(true);
    setError("");
    try {
      await api("suggest", { token, text });
      setText("");
      refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="card">
      <span className="label">Topics to vote on</span>
      <div className="chips">
        {topics.groups.map((g) => <span className="chip plain" key={g.round}>{g.name} · {g.count}</span>)}
      </div>
      {topics.mine.length > 0 && (
        <ul className="mine">
          {topics.mine.map((t, i) => <li key={i}>"{t.text}" <span className="fine">{status[t.status]}</span></li>)}
        </ul>
      )}
      {topics.canSuggest && (
        <form className="stack tight" onSubmit={send}>
          <label className="label" htmlFor="topic">Suggest a topic</label>
          <div className="row">
            <input id="topic" value={text} maxLength={120} placeholder="Your question" onChange={(e) => setText(e.target.value)} />
            <button type="submit" disabled={busy || text.trim().length < 5}>Send</button>
          </div>
          {error && <p className="error" role="alert">{error}</p>}
        </form>
      )}
    </div>
  );
}

function Ballot({ vote, token }: { vote: NonNullable<GuestView["vote"]>; token: string }) {
  // The picks are kept here so a tap shows at once, and saved in the background.
  const [mine, setMine] = useState<string[]>(vote.mine);
  const [error, setError] = useState("");
  const full = mine.length >= vote.max;
  // One save runs at a time and always sends the latest picks, so quick taps
  // cannot overtake each other on the way to the server.
  const want = useRef(vote.mine);
  const saved = useRef(vote.mine);
  const saving = useRef(false);
  async function save() {
    if (saving.current) return;
    saving.current = true;
    try {
      while (want.current !== saved.current) {
        const sending = want.current;
        await api("vote", { token, topicIds: sending });
        saved.current = sending;
      }
    } catch (err) {
      want.current = saved.current;
      setMine(saved.current);
      setError(err instanceof ApiError ? err.message : "That didn't save. Try again.");
    } finally {
      saving.current = false;
    }
  }
  function toggle(id: string) {
    const now = want.current;
    const next = now.includes(id) ? now.filter((x) => x !== id) : [...now, id];
    if (next.length > vote.max) return;
    want.current = next;
    setMine(next);
    setError("");
    save();
  }
  return (
    <>
      <h1 className="question">What should we talk about?</h1>
      <p className="sub">Pick up to {vote.max}. {mine.length ? `You've picked ${mine.length}.` : ""}</p>
      <div className="opts">
        {vote.options.map((o) => {
          const on = mine.includes(o.id);
          return (
            <button type="button" key={o.id} className={"opt pick" + (on ? " mine" : "")} aria-pressed={on} disabled={!on && full} onClick={() => toggle(o.id)}>
              <span>{o.text}</span>
              <span className="tick" aria-hidden="true">{on ? "✓" : ""}</span>
            </button>
          );
        })}
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      <p className="fine">The results are on the big screen, not here. You can change your picks until the time is up.</p>
    </>
  );
}

function Rating({ mine, token }: { mine: boolean | null; token: string }) {
  const [value, setValue] = useState<boolean | null>(mine);
  async function set(up: boolean) {
    const next = value === up ? null : up;
    setValue(next);
    try {
      await api("rate", { token, up: next });
    } catch {
      setValue(value);
    }
  }
  return (
    <div className="card">
      <span className="label">How was that topic? Optional</span>
      <div className="row thumbs">
        <button type="button" className={value === true ? "primary" : ""} aria-pressed={value === true} onClick={() => set(true)}>👍 Good one</button>
        <button type="button" className={value === false ? "primary" : ""} aria-pressed={value === false} onClick={() => set(false)}>👎 Not for me</button>
      </div>
      <p className="fine">Only the hosts see the totals.</p>
    </div>
  );
}

function Finished({ event, name, token }: { event: EventInfo; name: string; token: string }) {
  return (
    <div className="stack">
      <h1>That's a wrap</h1>
      <p className="sub">Thanks for coming, {name}. Stick around for coffee.</p>
      <Keepsake event={event} name={name} seed={token} />
      <a className="button big" href="https://claudecapetown.com/join/" target="_blank" rel="noreferrer">Join the community</a>
      {event.feedbackUrl && <a className="button big" href={event.feedbackUrl} target="_blank" rel="noreferrer">Tell us how it went</a>}
      <p className="fine">Your details from today are deleted after the event. The card is made on your phone and is yours to keep.</p>
    </div>
  );
}

function Keepsake({ event, name, seed }: { event: EventInfo; name: string; seed: string }) {
  const [url, setUrl] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [failed, setFailed] = useState(false);
  const eventName = event.name.replace(/ \(practice\)$/, "");
  const line = event.cardLine ?? new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  useEffect(() => {
    let on = true;
    let made = "";
    drawCard({ name, eventName, line, sticker: stickerFor(seed) })
      .then((blob) => {
        if (!on) return;
        made = URL.createObjectURL(blob);
        setUrl(made);
        setFile(new File([blob], "claude-and-coffee.png", { type: "image/png" }));
      })
      .catch(() => on && setFailed(true));
    return () => {
      on = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [name, eventName, line, seed]);

  if (failed) return null;
  const canShare = !!file && !!navigator.canShare?.({ files: [file] });
  return (
    <div className="keepsake">
      <span className="label">Your card from today</span>
      {url ? <img src={url} width={1080} height={1350} alt={`A card that says ${name} was at ${eventName}`} /> : <div className="cardwait">Drawing your card...</div>}
      {url && (
        <div className="row">
          {canShare && (
            <button type="button" className="primary big" onClick={() => navigator.share({ files: [file!], title: eventName }).catch(() => {})}>Share</button>
          )}
          <a className={"button big" + (canShare ? "" : " primary")} href={url} download="claude-and-coffee.png">Save the picture</a>
        </div>
      )}
    </div>
  );
}
