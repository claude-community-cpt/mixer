import { useMemo, useState } from "react";
import { api, ApiError, eventCode, type EventInfo, type RoomTable, type RoundInfo } from "./api";
import { BASE } from "./route";
import { clock, useCountdown, useLive, useRefreshAtZero } from "./useLive";
import { joinUrl, RoomGrid, VoteBars, type VoteTally } from "./Screen";
import { readSignups, type SignupRow } from "./signups";
import { Brand } from "./Brand";

type HostGuest = {
  id: string; name: string; left: boolean; registered: boolean | null; pinnedTable: number | null; table: number | null;
  isHost: boolean; willHost: boolean; experience: string | null; bot: boolean;
};
type HostTopic = { id: string; group: number | null; text: string; status: "approved" | "pending" | "hidden"; source: "signup" | "guest" | "host" };
type HostView = {
  event: EventInfo;
  hostLabel: string;
  tableCount: number;
  tablesInUse: number;
  tablesWithoutHost: number;
  practiceCode: string | null;
  purgeAt: string | null;
  purgedAt: string | null;
  signups: { total: number; arrived: number; notOnList: number; offeredToHost: number; withDetails: number };
  guests: HostGuest[];
  room: RoomTable[];
  round: RoundInfo;
  vote: VoteTally | null;
  topics: HostTopic[];
  results: { round: number; topic: string; up: number; down: number }[];
  repeatPairs: number;
};
type Login = { email: string; pin: string };

// Kept for this browser tab only, and shared by an event and its practice copy.
function loginStore(value?: Login | null): Login | null {
  const key = "tm:host";
  try {
    if (value === undefined) return JSON.parse(sessionStorage.getItem(key) ?? "null");
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, JSON.stringify(value));
  } catch { /* private mode */ }
  return value ?? null;
}

const hostUrl = (code: string) => `${BASE}host${BASE.length > 1 ? "/" : ""}?e=${encodeURIComponent(code)}`;

export function Host() {
  const code = useMemo(eventCode, []);
  const [login, setLogin] = useState<Login | null>(() => loginStore());
  const [email, setEmail] = useState("");
  const [pin, setPin] = useState("");
  const [loginError, setLoginError] = useState("");
  const [busy, setBusy] = useState(false);
  const live = useLive<HostView>(code, login ? () => api("host.state", { code, ...login }) : null, [login]);

  async function signIn(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setLoginError("");
    try {
      const entry = { email: email.trim(), pin: pin.trim() };
      await api("host.state", { code, ...entry });
      loginStore(entry);
      setLogin(entry);
    } catch (err) {
      setLoginError(err instanceof ApiError ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  if (!login || live.error?.code === "bad_login" || live.error?.code === "locked") {
    return (
      <main className="host narrow">
        <form className="stack" onSubmit={signIn}>
          <Brand />
          <h1>Host sign-in</h1>
          <p className="sub">Event: {code}</p>
          <label className="label" htmlFor="email">Your email</label>
          <input id="email" type="email" inputMode="email" autoComplete="email" autoCapitalize="none" spellCheck={false} value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
          <label className="label" htmlFor="pin">Host PIN</label>
          <input id="pin" type="password" inputMode="numeric" autoComplete="off" value={pin} onChange={(e) => setPin(e.target.value)} />
          {(loginError || live.error) && <p className="error" role="alert">{loginError || live.error?.message}</p>}
          <button type="submit" className="primary big" disabled={busy || !pin || !email}>Sign in</button>
          <p className="fine">Only the event's hosts are let in.</p>
        </form>
      </main>
    );
  }
  if (!live.data) return <main className="host"><p className="sub">{live.error?.message ?? "Loading..."}</p></main>;
  return <Dashboard code={code} login={login} view={live.data} setView={live.setData} refresh={live.refresh} stale={live.stale} signOut={() => { loginStore(null); setLogin(null); }} />;
}

type Act = (action: string, body?: Record<string, unknown>) => Promise<boolean>;

function Dashboard({ code, login, view, setView, refresh, stale, signOut }: {
  code: string; login: Login; view: HostView; setView: (v: HostView) => void; refresh: () => void; stale: boolean; signOut: () => void;
}) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const { event, round } = view;
  const left = useCountdown(event.endsAt, event.serverNow);
  useRefreshAtZero(left, refresh);

  async function call<T>(action: string, body: Record<string, unknown> = {}): Promise<T | null> {
    setBusy(true);
    setError("");
    try {
      return await api<T>("host." + action, { code, ...login, ...body });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong.");
      return null;
    } finally {
      setBusy(false);
    }
  }
  const act: Act = async (action, body) => {
    const next = await call<HostView>(action, body);
    if (next?.event) setView(next);
    return !!next;
  };

  const active = view.guests.filter((g) => !g.left);
  const spun = !!round.spunAt;
  const r = round.number;
  const next =
    event.phase === "lobby" ? "Start round 1 voting"
    : event.phase === "seating" ? `Start round ${r} voting`
    : event.phase === "vote" ? "End voting now"
    : event.phase === "wheel" ? (spun ? "Start the table discussion" : "")
    : event.phase === "table" ? "Open the room discussion now"
    : event.phase === "room" ? (r < event.totalRounds ? `Give out round ${r + 1} tables` : "Finish the event")
    : "";
  const phaseLabel =
    event.phase === "lobby" ? "Doors open"
    : event.phase === "seating" ? `Round ${r} · new tables are out`
    : event.phase === "vote" ? `Round ${r} · voting is open`
    : event.phase === "wheel" ? `Round ${r} · ${spun ? "the wheel has chosen" : "voting has closed"}`
    : event.phase === "table" ? `Round ${r} · table discussion`
    : event.phase === "room" ? `Round ${r} · room discussion`
    : "Finished";
  const hint =
    event.phase === "lobby" ? `Everyone keeps the table they have. A last table of ${Math.floor(event.tableSize / 2)} or fewer is folded into the others.`
    : event.phase === "seating" ? `Wait until people are seated. Round ${r} votes on the "${round.group}" topics.`
    : event.phase === "vote" ? "Voting also ends by itself when the time is up, and every phone moves on."
    : event.phase === "wheel" ? (spun ? `The topic is "${round.topic}".` : "The top three are on the big screen. Spin when the room is watching.")
    : event.phase === "table" ? "The room discussion opens by itself when the time is up."
    : event.phase === "room" ? "Lead the open discussion from the front. Move on when you're ready: the timer is only a guide."
    : "";
  const timed = event.phase === "vote" || event.phase === "table" || event.phase === "room";
  const wide = useMemo(() => window.matchMedia("(min-width: 700px)").matches, []);
  const firstGroupEmpty = !view.topics.some((t) => t.status === "approved" && t.group === (event.phase === "lobby" ? 1 : r));
  const seatsShort = active.length > view.tableCount * event.tableSize;
  const showBar = !!next || (event.phase === "wheel" && !spun);

  return (
    <main className={"host" + (showBar ? " hasbar" : "")}>
      <header className="row between">
        <div>
          <Brand />
          <h1>{event.name}</h1>
          <p className="sub">
            Host page{view.hostLabel ? ` · signed in as ${view.hostLabel}` : ""} · guests join at {joinUrl(code).replace(/^https?:\/\//, "")} · <a href={`${BASE}screen${BASE.length > 1 ? "/" : ""}${location.search}`} target="_blank" rel="noreferrer">open the big screen</a>
          </p>
        </div>
        <button type="button" onClick={signOut}>Sign out</button>
      </header>
      {stale && <p className="banner" role="status">Reconnecting...</p>}
      {error && <p className="error" role="alert">{error}</p>}
      {event.practice && <PracticeBar code={code} busy={busy} act={act} />}

      <section className="panel">
        <div className="row between">
          <div>
            <div className="phase">{phaseLabel}{timed && left != null ? ` · ${clock(left)} left` : ""}</div>
            <p className="sub">
              {active.length} here · {view.tablesInUse} of {view.tableCount} tables in use · {event.tableSize} to a table
              {event.phase !== "lobby" ? ` · ${view.repeatPairs} pairs have met twice` : ""}
            </p>
          </div>
          {showBar && (
            <div className="advance">
              {event.phase === "wheel" && !spun ? (
                <button type="button" className="primary big" disabled={busy} onClick={() => act("spin")}>Spin the wheel</button>
              ) : !confirming ? (
                <button type="button" className="primary big" disabled={busy} onClick={() => setConfirming(true)}>{next}</button>
              ) : (
                <>
                  <button type="button" className="primary big" disabled={busy} onClick={async () => { await act("advance", { fromPhase: event.phase, fromRound: event.round }); setConfirming(false); }}>
                    Yes, {next.charAt(0).toLowerCase() + next.slice(1)}
                  </button>
                  <button type="button" className="big" disabled={busy} onClick={() => setConfirming(false)}>Cancel</button>
                </>
              )}
            </div>
          )}
        </div>
        {hint && <p className="sub">{hint}</p>}
        {timed && (
          <div className="row">
            <span className="label">Timer</span>
            <button type="button" disabled={busy} onClick={() => act("addTime", { seconds: 60 })}>Add a minute</button>
            <button type="button" disabled={busy || (left ?? 0) <= 65} onClick={() => act("addTime", { seconds: -60 })}>Take a minute off</button>
          </div>
        )}
        {(event.phase === "lobby" || event.phase === "seating") && firstGroupEmpty && (
          <p className="warn">There are no topics in "{event.phase === "lobby" ? event.groupNames[0] : round.group}" yet. Add at least one under Topics before the vote.</p>
        )}
        {view.tablesWithoutHost > 0 && event.phase !== "finished" && (
          <p className="warn">{view.tablesWithoutHost} {view.tablesWithoutHost === 1 ? "table has" : "tables have"} nobody down to host. Their phones ask "who will kick things off?". To name someone, tap them under Guests.</p>
        )}
        {seatsShort && event.phase !== "finished" && (
          <p className="warn">More people than seats: some tables will go over {event.tableSize}. Add tables in Setup if the room has more.</p>
        )}
      </section>

      {event.phase === "vote" && view.vote && (
        <section className="panel">
          <h2>Votes so far · {view.vote.voted} of {view.vote.of} have voted</h2>
          <VoteBars vote={view.vote} />
          <p className="fine">Guests cannot see these counts on their phones. The big screen shows them.</p>
        </section>
      )}
      {event.phase === "wheel" && (
        <section className="panel">
          <h2>{spun ? "The wheel chose" : "On the wheel"}</h2>
          <ol className="list plainlist">
            {round.top.map((t) => (
              <li key={t.id} className={spun && t.id === round.topicId ? "won" : ""}>
                <span>{t.text}</span> <span className="sub">{t.votes} {t.votes === 1 ? "vote" : "votes"}</span>
              </li>
            ))}
          </ol>
        </section>
      )}
      {view.results.length > 0 && (
        <section className="panel">
          <h2>Topics so far</h2>
          <ul className="list plainlist">
            {view.results.map((x) => (
              <li key={x.round}><span><strong>Round {x.round}:</strong> {x.topic}</span> <span className="sub">👍 {x.up} · 👎 {x.down}</span></li>
            ))}
          </ul>
        </section>
      )}

      <Topics view={view} busy={busy} act={act} />

      {event.phase !== "finished" && view.room.length > 0 && (
        <details className="panel" open={wide && event.phase !== "lobby"}>
          <summary><h2>Tables right now</h2></summary>
          <RoomGrid tables={view.room} />
        </details>
      )}

      <Guests view={view} busy={busy} act={act} />
      {!event.practice && <Signups view={view} busy={busy} act={act} />}
      <Setup key={event.phase + event.round} view={view} busy={busy} act={act} />
      {!event.practice && <Practice view={view} busy={busy} start={(guests) => call<{ practiceCode: string }>("practice", { guests })} />}
      <Danger view={view} busy={busy} act={act} />
    </main>
  );
}

function PracticeBar({ code, busy, act }: { code: string; busy: boolean; act: Act }) {
  const real = code.replace(/-practice$/, "");
  return (
    <section className="panel practice">
      <h2>This is a practice event</h2>
      <p className="sub">
        Nothing here touches the real event. The pretend guests sign in, vote and rate by themselves, and the timers are short so a full run takes a few minutes.
        Join from your own phone too, to see what guests see.
      </p>
      <div className="row">
        <button type="button" disabled={busy} onClick={() => act("addBots", { count: 10 })}>Add 10 pretend guests</button>
        <button type="button" disabled={busy} onClick={() => act("addBots", { count: 30 })}>Add 30</button>
        <a className="button" href={hostUrl(real)}>Back to the real event</a>
      </div>
    </section>
  );
}

function Topics({ view, busy, act }: { view: HostView; busy: boolean; act: Act }) {
  const [text, setText] = useState("");
  const [group, setGroup] = useState(1);
  const names = view.event.groupNames;
  const pending = view.topics.filter((t) => t.status === "pending");
  const hidden = view.topics.filter((t) => t.status === "hidden");
  const count = view.topics.filter((t) => t.status === "approved").length;
  const edit = (t: HostTopic) => {
    const n = window.prompt?.("Wording shown to guests", t.text);
    if (n?.trim() && n !== t.text) act("updateTopic", { topicId: t.id, text: n });
  };
  const picker = (t: HostTopic, label: string) => (
    <select aria-label={`${label}: ${t.text}`} value="" disabled={busy} onChange={(e) => { if (e.target.value) act("updateTopic", { topicId: t.id, group: Number(e.target.value), status: "approved" }); }}>
      <option value="">{label}...</option>
      {names.map((n, i) => <option key={i} value={i + 1}>{n} (round {i + 1})</option>)}
    </select>
  );
  return (
    <details className="panel" open={pending.length > 0 || view.event.phase === "lobby"}>
      <summary><h2>Topics ({count}){pending.length ? ` · ${pending.length} to review` : ""}</h2></summary>
      {pending.length > 0 && (
        <>
          <span className="label">To review. Guests only see a topic once you add it to a group.</span>
          <ul className="list">
            {pending.map((t) => (
              <li key={t.id} className="topicrow">
                <span>{t.text} <span className="fine">{t.source === "signup" ? "from the sign-up form" : "suggested today"}</span></span>
                <span className="row">
                  {picker(t, "Add to")}
                  <button type="button" disabled={busy} onClick={() => edit(t)}>Edit</button>
                  <button type="button" disabled={busy} onClick={() => act("updateTopic", { topicId: t.id, status: "hidden" })}>Hide</button>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      {names.map((name, i) => {
        const list = view.topics.filter((t) => t.status === "approved" && t.group === i + 1);
        return (
          <div key={i} className="stack tight">
            <h3>{name} · round {i + 1} <span className="sub">({list.length})</span></h3>
            <ul className="list">
              {list.map((t) => (
                <li key={t.id} className="topicrow">
                  <span>{t.text}</span>
                  <span className="row">
                    {picker(t, "Move to")}
                    <button type="button" disabled={busy} onClick={() => edit(t)}>Edit</button>
                    <button type="button" disabled={busy} onClick={() => act("updateTopic", { topicId: t.id, status: "hidden" })}>Hide</button>
                  </span>
                </li>
              ))}
              {list.length === 0 && <li className="sub">No topics in this group yet.</li>}
            </ul>
          </div>
        );
      })}
      <form className="row" onSubmit={async (e) => { e.preventDefault(); if (text.trim() && (await act("addTopic", { text, group }))) setText(""); }}>
        <input aria-label="Add a topic" placeholder="Add a topic" value={text} maxLength={120} onChange={(e) => setText(e.target.value)} />
        <select aria-label="Group for the new topic" value={group} onChange={(e) => setGroup(Number(e.target.value))}>
          {names.map((n, i) => <option key={i} value={i + 1}>{n}</option>)}
        </select>
        <button type="submit" disabled={busy || text.trim().length < 3}>Add</button>
      </form>
      {hidden.length > 0 && (
        <details>
          <summary className="sub">Hidden topics ({hidden.length})</summary>
          <ul className="list">
            {hidden.map((t) => (
              <li key={t.id} className="topicrow">
                <span>{t.text}</span>
                <span className="row">
                  {picker(t, "Add to")}
                  <button type="button" disabled={busy} onClick={() => act("removeTopic", { topicId: t.id })}>Delete</button>
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </details>
  );
}

function Guests({ view, busy, act }: { view: HostView; busy: boolean; act: Act }) {
  const [name, setName] = useState("");
  const [find, setFind] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const tables = Array.from({ length: view.tableCount }, (_, i) => i + 1);
  const seated = view.event.phase !== "finished";
  const q = find.trim().toLowerCase();
  const byName = useMemo(() => [...view.guests].sort((a, b) => a.name.localeCompare(b.name)), [view.guests]);
  const shown = q ? byName.filter((g) => g.name.toLowerCase().includes(q)) : byName;
  return (
    <details className="panel" open={view.event.phase === "lobby"}>
      <summary><h2>Guests ({view.guests.filter((g) => !g.left).length})</h2></summary>
      <form className="row" onSubmit={async (e) => { e.preventDefault(); if (name.trim() && (await act("addGuest", { name }))) setName(""); }}>
        <input aria-label="Add a guest by first name" placeholder="Add a guest by first name" value={name} maxLength={20} onChange={(e) => setName(e.target.value)} />
        <button type="submit" disabled={busy || !name.trim()}>Add</button>
      </form>
      {view.guests.length > 8 && (
        <input type="search" aria-label="Find a guest" placeholder="Find a guest" value={find} onChange={(e) => setFind(e.target.value)} />
      )}
      <p className="fine">Tap a name to move, rename, mark as gone or make them a table host.</p>
      <ul className="list guests">
        {shown.map((g) => {
          const isOpen = openId === g.id;
          return (
            <li key={g.id} className={g.left ? "gone" : ""}>
              <button type="button" className="guestrow" aria-expanded={isOpen} onClick={() => setOpenId(isOpen ? null : g.id)}>
                <span>
                  <strong>{g.name}</strong>
                  {g.table != null && !g.left && <span className="sub"> · table {g.table}</span>}
                  {g.isHost && !g.left && <span className="accent"> · hosting</span>}
                  {!g.isHost && g.willHost && <span className="sub"> · offered to host</span>}
                  {g.experience && <span className="sub"> · {g.experience}</span>}
                  {g.pinnedTable != null && <span className="sub"> · kept at table {g.pinnedTable}</span>}
                  {g.registered === false && <span className="warnText"> · not on the sign-up list</span>}
                  {g.bot && <span className="sub"> · pretend</span>}
                  {g.left && <span className="sub"> · gone</span>}
                </span>
                <span className="chev" aria-hidden="true">{isOpen ? "−" : "+"}</span>
              </button>
              {isOpen && (
                <div className="guestactions">
                  {!g.left && seated && (
                    <select
                      aria-label={`Move ${g.name} to a table`}
                      value=""
                      disabled={busy}
                      onChange={(e) => {
                        const v = e.target.value;
                        if (v === "unpin") act("unpinGuest", { guestId: g.id });
                        else if (v.startsWith("keep:")) act("moveGuest", { guestId: g.id, table: Number(v.slice(5)), keep: true });
                        else if (v) act("moveGuest", { guestId: g.id, table: Number(v) });
                      }}
                    >
                      <option value="">Move to a table...</option>
                      {tables.map((t) => <option key={t} value={t}>To table {t} this round</option>)}
                      {tables.map((t) => <option key={"k" + t} value={"keep:" + t}>Keep at table {t} every round</option>)}
                      {g.pinnedTable != null && <option value="unpin">Stop keeping at one table</option>}
                    </select>
                  )}
                  {!g.left && seated && g.table != null && view.event.phase !== "lobby" && (
                    <button type="button" disabled={busy} onClick={() => act("setTableHost", { guestId: g.id, on: !g.isHost })}>{g.isHost ? "Stop hosting" : "Make table host"}</button>
                  )}
                  <button type="button" disabled={busy} onClick={() => act("markLeft", { guestId: g.id, left: !g.left })}>{g.left ? "Bring back" : "Mark as gone"}</button>
                  <button type="button"
                    disabled={busy}
                    onClick={() => {
                      const n = window.prompt?.(`New name for ${g.name}`, g.name);
                      if (n?.trim() && n !== g.name) act("renameGuest", { guestId: g.id, name: n });
                    }}
                  >
                    Rename
                  </button>
                </div>
              )}
            </li>
          );
        })}
        {view.guests.length === 0 && <li className="sub">Nobody has checked in yet.</li>}
        {view.guests.length > 0 && shown.length === 0 && <li className="sub">No guest matches that.</li>}
      </ul>
    </details>
  );
}

function Signups({ view, busy, act }: { view: HostView; busy: boolean; act: Act }) {
  const [text, setText] = useState("");
  const [asTopics, setAsTopics] = useState(false);
  const [msg, setMsg] = useState("");
  const { total, arrived, notOnList, offeredToHost, withDetails } = view.signups;
  // An export is read here, in the browser. Only the columns the app needs are sent on.
  const parsed = useMemo(() => (text.trim() ? readSignups(text) : null), [text]);
  const rows: SignupRow[] | null = parsed?.rows.length ? parsed.rows : null;
  return (
    <details className="panel">
      <summary><h2>Sign-up list{total ? ` (${arrived} of ${total} arrived)` : ""}</h2></summary>
      {total > 0 ? (
        <p className="sub">
          Guests are asked for the email they registered with. {arrived} of {total} sign-ups have arrived
          {notOnList ? `, and ${notOnList} ${notOnList === 1 ? "guest is" : "guests are"} not on the list (marked under Guests)` : ""}.
          {withDetails ? ` ${offeredToHost} offered to host a table.` : " The list has addresses only, so seating cannot mix the room by experience."}
        </p>
      ) : (
        <p className="sub">No list loaded, so guests are only asked for a first name. Load the guest export from the event sign-up page to match people at the door, name table hosts and mix the tables.</p>
      )}
      <label className="field">
        <span className="label">Choose the guest export (.csv)</span>
        <input type="file" accept=".csv,.txt,text/csv,text/plain" onChange={async (e) => { const f = e.target.files?.[0]; if (f) { setText(await f.text()); setMsg(""); } e.target.value = ""; }} />
      </label>
      <label className="field">
        <span className="label">Or paste it, or a list of email addresses</span>
        <textarea rows={3} value={text} placeholder="Paste the export or email addresses" onChange={(e) => { setText(e.target.value); setMsg(""); }} />
      </label>
      {text.trim() && (
        <p className="sub" role="status">
          {rows
            ? `Found ${rows.length} approved ${rows.length === 1 ? "guest" : "guests"}${parsed?.notApproved ? ` (${parsed.notApproved} not yet approved are left out)` : ""}. ${rows.filter((x) => x.willHost).length} offered to host, ${rows.filter((x) => x.question).length} sent a question.`
            : "No export columns found, so this will be read as a plain list of email addresses."}
        </p>
      )}
      {rows && (
        <label className="check"><input type="checkbox" checked={asTopics} onChange={(e) => setAsTopics(e.target.checked)} /> Also add their questions under Topics, to review</label>
      )}
      <div className="row">
        <button type="button" className="primary" disabled={busy || !text.trim()}
          onClick={async () => {
            const ok = await act("setSignups", rows ? { rows, questionsAsTopics: asTopics } : { text });
            if (ok) { setText(""); setMsg("List saved."); }
          }}>
          {total ? "Replace the sign-up list" : "Save sign-up list"}
        </button>
        {total > 0 && (
          <button type="button" disabled={busy} onClick={async () => { if (window.confirm?.("Remove the sign-up list? Guests will no longer be asked for an email.") && (await act("setSignups", { clear: true }))) { setText(""); setMsg("List removed."); } }}>Remove the list</button>
        )}
        {msg && <span className="sub" role="status">{msg}</span>}
      </div>
      <p className="fine">
        From the export we keep the first name, how much the person uses Claude, whether they offered to host, the kind of work they do and their question.
        Email addresses are not kept: each one becomes a one-way fingerprint that can only answer "is this address on the list?". Nothing else in the file leaves this browser.
      </p>
    </details>
  );
}

function Setup({ view, busy, act }: { view: HostView; busy: boolean; act: Act }) {
  const e = view.event;
  const [name, setName] = useState(e.name);
  const [rounds, setRounds] = useState(e.totalRounds);
  const [minutes, setMinutes] = useState(e.roundMinutes);
  const [roomMinutes, setRoomMinutes] = useState(e.roomMinutes);
  const [voteSeconds, setVoteSeconds] = useState(e.voteSeconds);
  const [votesEach, setVotesEach] = useState(e.votesEach);
  const [tableSize, setTableSize] = useState(e.tableSize);
  const [tableCount, setTableCount] = useState(view.tableCount);
  const [groups, setGroups] = useState<string[]>(e.groupNames);
  const [cardLine, setCardLine] = useState(e.cardLine ?? "");
  const [feedback, setFeedback] = useState(e.feedbackUrl ?? "");
  const [saved, setSaved] = useState(false);
  const num = (label: string, value: number, set: (n: number) => void, min: number, max: number) => (
    <label className="field"><span className="label">{label}</span><input type="number" min={min} max={max} value={value} onChange={(ev) => set(Number(ev.target.value))} /></label>
  );
  return (
    <details className="panel">
      <summary><h2>Setup</h2></summary>
      <p className="sub">Changes apply from the next step. {tableCount} tables of {tableSize} seat {tableCount * tableSize} people. Only as many tables as are needed get used, so they stay full.</p>
      <label className="field"><span className="label">Event name</span><input value={name} maxLength={80} onChange={(ev) => setName(ev.target.value)} /></label>
      <div className="grid4">
        {num("Tables in the room", tableCount, setTableCount, 1, 30)}
        {num("People per table", tableSize, setTableSize, 2, 12)}
        {num("Rounds", rounds, setRounds, Math.max(1, e.round), 8)}
        {num("Votes per person", votesEach, setVotesEach, 1, 5)}
        {num("Voting, seconds", voteSeconds, setVoteSeconds, 15, 900)}
        {num("Table discussion, minutes", minutes, setMinutes, 1, 120)}
        {num("Room discussion, minutes", roomMinutes, setRoomMinutes, 1, 60)}
      </div>
      <h3>Topic groups</h3>
      <p className="sub">One group of topics per round.</p>
      <div className="grid4">
        {Array.from({ length: rounds }, (_, i) => (
          <label className="field" key={i}><span className="label">Round {i + 1}</span>
            <input value={groups[i] ?? ""} maxLength={30} placeholder={`Round ${i + 1}`} onChange={(ev) => setGroups(Array.from({ length: rounds }, (_, j) => (j === i ? ev.target.value : groups[j] ?? "")))} />
          </label>
        ))}
      </div>
      <label className="field"><span className="label">Line on the keepsake card, such as the date and city</span><input value={cardLine} maxLength={60} placeholder="Saturday 5 December 2026 · Cape Town" onChange={(ev) => setCardLine(ev.target.value)} /></label>
      <label className="field"><span className="label">Feedback link shown at the end (optional)</span><input value={feedback} placeholder="https://" onChange={(ev) => setFeedback(ev.target.value)} /></label>
      <div className="row">
        <button type="button" className="primary" disabled={busy}
          onClick={async () => {
            setSaved(false);
            setSaved(await act("setup", {
              name, totalRounds: rounds, roundMinutes: minutes, roomMinutes, voteSeconds, votesEach, tableSize, tableCount,
              groupNames: groups.slice(0, rounds), cardLine, feedbackUrl: feedback,
            }));
          }}>
          Save setup
        </button>
        {saved && <span className="sub" role="status">Saved.</span>}
      </div>
    </details>
  );
}

function Practice({ view, busy, start }: { view: HostView; busy: boolean; start: (guests: number) => Promise<{ practiceCode: string } | null> }) {
  const [guests, setGuests] = useState(40);
  const code = view.practiceCode;
  const go = async () => {
    const out = await start(guests);
    if (out) location.href = hostUrl(out.practiceCode);
  };
  return (
    <details className="panel">
      <summary><h2>Practise with pretend guests</h2></summary>
      <p className="sub">
        Makes a practice copy of this event with the same tables and topics, short timers, and pretend guests who get tables, vote and rate by themselves while you press the host buttons.
        Nothing in it touches this event or its sign-up list.
      </p>
      <div className="row">
        <label className="field"><span className="label">Pretend guests</span><input type="number" min={0} max={120} value={guests} onChange={(e) => setGuests(Number(e.target.value))} /></label>
        <button type="button" className="primary" disabled={busy} onClick={go}>{code ? "Start the practice afresh" : "Start a practice event"}</button>
        {code && <a className="button" href={hostUrl(code)}>Open the practice event</a>}
      </div>
    </details>
  );
}

/** A date as the date field wants it, in the host's own time zone. */
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const longDate = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });

function Danger({ view, busy, act }: { view: HostView; busy: boolean; act: Act }) {
  const [word, setWord] = useState("");
  const [newPin, setNewPin] = useState("");
  const [msg, setMsg] = useState("");
  const practice = view.event.practice;
  const [day, setDay] = useState(() => (view.purgeAt ? ymd(new Date(view.purgeAt)) : ""));
  const tomorrow = ymd(new Date(Date.now() + 86400_000));
  return (
    <details className="panel">
      <summary><h2>{practice ? "Start again" : "After the event"}</h2></summary>
      <h3>Back to doors open</h3>
      <p className="sub">Removes every guest with their tables, votes and ratings, and starts again from doors open. {practice ? "Topics are kept." : "The sign-up list and the topics are kept. Use it after a rehearsal."}</p>
      <div className="row">
        <button type="button" disabled={busy} onClick={async () => { if (window.confirm?.("Remove every guest and go back to doors open?") && (await act("reset", { confirm: "RESET" }))) setMsg("Back to doors open."); }}>Reset to doors open</button>
      </div>
      {!practice && (
        <>
          <h3>Delete all attendee data</h3>
          <p className="sub">Deletes every guest, table, vote and rating, the sign-up list, topics guests suggested and the practice event. Prepared topics and settings stay. The ambassador agreement asks for attendee data to be deleted within 30 days of the event.</p>
          <div className="row">
            <input aria-label="Type DELETE to confirm" placeholder="Type DELETE to confirm" value={word} onChange={(e) => setWord(e.target.value)} />
            <button type="button" className="danger" disabled={busy || word !== "DELETE"} onClick={async () => { if (await act("wipe", { confirm: "DELETE" })) { setWord(""); setDay(""); setMsg("All attendee data deleted."); } }}>Delete all attendee data</button>
          </div>
          <h3>Or have it delete itself</h3>
          <p className="sub">Pick a date and the same data is deleted early that morning, with nobody signed in. A date within a few days of the event is the safest: the database goes to sleep after about a week without use, and then the delete waits until it is woken.</p>
          {view.purgeAt && <p className="sub" role="status"><strong>On.</strong> Attendee data deletes itself on {longDate(view.purgeAt)}.</p>}
          {!view.purgeAt && view.purgedAt && <p className="sub" role="status">Attendee data was deleted automatically on {longDate(view.purgedAt)}.</p>}
          <div className="row">
            <input type="date" aria-label="Date for the automatic delete" value={day} min={tomorrow} onChange={(e) => setDay(e.target.value)} />
            <button type="button" disabled={busy || !day || day < tomorrow}
              onClick={async () => { if (await act("setup", { purgeAt: new Date(`${day}T00:00:00`).toISOString() })) setMsg("The automatic delete is set."); }}>
              {view.purgeAt ? "Change the date" : "Set the date"}
            </button>
            {view.purgeAt && <button type="button" disabled={busy} onClick={async () => { if (await act("setup", { purgeAt: null })) { setDay(""); setMsg("The automatic delete is off."); } }}>Turn it off</button>}
          </div>
        </>
      )}
      <h3>Change the host PIN</h3>
      <div className="row">
        <input aria-label="New PIN, 4 to 12 digits" placeholder="New PIN, 4 to 12 digits" inputMode="numeric" value={newPin} onChange={(e) => setNewPin(e.target.value)} />
        <button type="button" disabled={busy || !/^[0-9]{4,12}$/.test(newPin)} onClick={async () => { if (await act("changePin", { newPin })) { setMsg("PIN changed. Sign in again with the new one."); setNewPin(""); } }}>Change PIN</button>
      </div>
      <p className="fine">A longer PIN is harder to guess. Use at least 6 digits once the real sign-up list is loaded.</p>
      {msg && <p className="sub" role="status">{msg}</p>}
    </details>
  );
}
