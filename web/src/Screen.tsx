import { useEffect, useMemo, useState } from "react";
import QRCode from "qrcode";
import { api, eventCode, tableColor, type EventInfo, type RoomTable, type RoundInfo } from "./api";
import { BASE } from "./route";
import { clock, useCountdown, useLive, useRefreshAtZero, useSpin } from "./useLive";
import { Brand } from "./Brand";
import { Wheel } from "./Wheel";

export type VoteTally = { options: { id: string; text: string; votes: number }[]; voted: number; of: number };
type RoomView = {
  event: EventInfo;
  guestCount: number;
  topicCount: number;
  tables: RoomTable[];
  round: RoundInfo;
  vote: VoteTally | null;
};

export function joinUrl(code: string) {
  const def = (import.meta.env.VITE_EVENT_CODE as string) || "demo";
  return location.origin + BASE + (code === def ? "" : `?e=${encodeURIComponent(code)}`);
}

export function Qr({ url, size = 320 }: { url: string; size?: number }) {
  const [src, setSrc] = useState("");
  useEffect(() => {
    QRCode.toDataURL(url, { width: size * 2, margin: 1, errorCorrectionLevel: "M" }).then(setSrc).catch(() => setSrc(""));
  }, [url, size]);
  return src ? <img className="qr" src={src} width={size} height={size} alt={`QR code for ${url}`} /> : null;
}

export function RoomGrid({ tables }: { tables: RoomTable[] }) {
  // On the big screen the whole room has to fit without scrolling: two rows
  // of tables up to 14, three rows beyond that.
  const n = tables.length;
  const cols = n <= 8 ? Math.min(4, Math.max(2, n)) : Math.ceil(n / (n <= 14 ? 2 : 3));
  return (
    <div className={"room" + (cols > 4 ? " dense" : "")} style={{ "--cols": cols } as React.CSSProperties}>
      {tables.map((t) => (
        <section className="table" key={t.number}>
          <header>
            <span className="badge" style={{ background: tableColor(t.number) }}>{t.number}</span>
            <h3>Table {t.number}</h3>
            <span className="count">{t.guests.length}</span>
          </header>
          <div className="chips">
            {t.guests.map((g) => <span className={"chip" + (g.host ? " hosting" : "")} key={g.name}>{g.name}{g.host ? <span className="hosttag"> · host</span> : ""}</span>)}
          </div>
        </section>
      ))}
    </div>
  );
}

/** Live vote counts, most votes first. Only for the big screen and the host. */
export function VoteBars({ vote, top = 3 }: { vote: VoteTally; top?: number }) {
  const sorted = [...vote.options].sort((a, b) => b.votes - a.votes);
  const max = Math.max(1, ...sorted.map((o) => o.votes));
  return (
    <div className="opts">
      {sorted.map((o, i) => (
        <div className={"opt static" + (i < top && o.votes > 0 ? " lead" : "")} key={o.id}>
          <i className="bar" style={{ width: (o.votes * 100) / max + "%" }} />
          <span>{o.text}</span>
          <span className="pct">{o.votes}</span>
        </div>
      ))}
    </div>
  );
}

export function Screen() {
  const code = useMemo(eventCode, []);
  const live = useLive<RoomView>(code, () => api("room", { code }));
  const view = live.data;
  const left = useCountdown(view?.event.endsAt, view?.event.serverNow);
  useRefreshAtZero(left, live.refresh);
  const spin = useSpin(view?.round.spunAt, view?.event.serverNow);
  const url = joinUrl(code);

  if (!view) return <main className="screen"><p className="sub">{live.error ? live.error.message : "Loading..."}</p></main>;
  const { event, round } = view;
  const started = event.phase !== "lobby" && event.phase !== "finished";
  const timed = event.phase === "vote" || event.phase === "table" || event.phase === "room";
  const wheelOn = event.phase === "wheel" || (event.phase === "table" && spin !== "done");
  // The topic stays hidden until the wheel has stopped.
  const topic = spin === "done" ? round.topic : null;
  return (
    <main className={"screen phase-" + event.phase}>
      <header className="row between">
        <div className="stack tight"><Brand /><h1>{event.name}</h1></div>
        <div className="row">
          {started && <span className="label">Round {round.number} of {event.totalRounds} · {round.group}</span>}
          {timed && left != null && <span className={"timer huge" + (left === 0 ? " done" : "")}>{clock(left)}</span>}
        </div>
      </header>

      {event.phase === "lobby" && (
        <div className="lobby">
          <div className="stack center">
            <Qr url={url} />
            <p className="url">{url.replace(/^https?:\/\//, "")}</p>
          </div>
          <div className="stack">
            <h2>Scan to get your table</h2>
            <p className="sub">Sign in with your first name and the email you registered with. Then grab a coffee, find your table and add a topic you'd like to talk about.</p>
            <p className="bigcount">{view.guestCount} <span>checked in · {view.topicCount} topics so far</span></p>
          </div>
        </div>
      )}

      {event.phase === "seating" && (
        <>
          <div className="stack hero">
            <h2>Find your new table</h2>
            <p className="sub">Your table number is on your phone. Table hosts are in coral. Voting on the {round.group.toLowerCase()} topics opens when you're seated.</p>
          </div>
          <RoomGrid tables={view.tables} />
        </>
      )}

      {event.phase === "vote" && view.vote && (
        <div className="votescreen">
          <div className="stack">
            <span className="label">Vote on your phone · pick up to {event.votesEach}</span>
            <h2 className="question">What should we talk about{round.number === 1 ? " first" : " next"}?</h2>
            <p className="sub">{view.vote.voted} of {view.vote.of} have voted. The top three go on the wheel.</p>
          </div>
          <VoteBars vote={view.vote} />
        </div>
      )}

      {wheelOn && (
        <Wheel round={round} spin={spin}>
          <h2>{topic ? "This round's topic" : round.spunAt ? "Spinning..." : round.top.length === 3 ? "The top three" : "The top topics"}</h2>
          {topic && <p className="chosen">{topic}</p>}
        </Wheel>
      )}

      {event.phase === "table" && spin === "done" && (
        <div className="stack hero center">
          <span className="label">At your tables</span>
          <p className="chosen">{round.topic}</p>
          <p className="sub">Table hosts, start with a round of hellos. The room comes back together when the timer ends.</p>
        </div>
      )}

      {event.phase === "room" && (
        <div className="stack hero center">
          <span className="label">Open discussion</span>
          <p className="chosen">{round.topic}</p>
          <p className="sub">Hands up to share what your table said. You can rate the topic on your phone.</p>
        </div>
      )}

      {event.phase === "finished" && (
        <div className="stack center finish">
          <h2>That's a wrap. Thanks for coming.</h2>
          <p className="sub">Your card from today is on your phone. Join us at claudecapetown.com/join</p>
        </div>
      )}

      {started && !wheelOn && (
        <aside className="corner"><Qr url={url} size={96} /><span>Just arrived? Scan to join.</span></aside>
      )}
      {event.practice && <p className="practicetag">Practice event</p>}
      {live.stale && <p className="banner" role="status">Reconnecting...</p>}
    </main>
  );
}
