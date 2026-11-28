import { useEffect, useState } from "react";
import type { RoundInfo } from "./api";
import { SPIN_MS } from "./useLive";

const COLOURS = ["var(--coral)", "var(--t2)", "var(--t4)"];
const TURNS = 5;

function slice(i: number, n: number): string {
  // A wedge of a circle of radius 100, starting at the top and going clockwise.
  const a0 = (i / n) * 2 * Math.PI;
  const a1 = ((i + 1) / n) * 2 * Math.PI;
  const p = (a: number) => `${(100 * Math.sin(a)).toFixed(2)} ${(-100 * Math.cos(a)).toFixed(2)}`;
  return `M0 0 L${p(a0)} A100 100 0 ${n === 1 ? 1 : 0} 1 ${p(a1)} Z`;
}

/**
 * The wheel over the top topics. The server picks the topic. The wheel only
 * turns to show it, landing with the chosen wedge under the pointer.
 */
export function Wheel({ round, spin }: { round: RoundInfo; spin: "waiting" | "spinning" | "done" }) {
  const n = round.top.length;
  const chosen = round.top.findIndex((t) => t.id === round.topicId);
  const rest = chosen < 0 ? 0 : -((chosen + 0.5) * 360) / n;
  const [angle, setAngle] = useState(spin === "done" ? rest : 0);
  useEffect(() => {
    if (spin === "waiting") setAngle(0);
    else if (spin === "done") setAngle((a) => (Math.abs(a) > 360 ? a : rest));
    else {
      // Start from rest on the next frame, so the turn is animated.
      const f = requestAnimationFrame(() => setAngle(TURNS * 360 + rest));
      return () => cancelAnimationFrame(f);
    }
  }, [spin, rest]);

  return (
    <div className="wheelwrap">
      <div className="wheelbox">
        <div className="pointer" aria-hidden="true" />
        <svg className={"wheel" + (spin === "spinning" ? " turning" : "")} viewBox="-104 -104 208 208" style={{ transform: `rotate(${angle}deg)`, transitionDuration: `${SPIN_MS - 400}ms` }} role="img" aria-label="Wheel of the top topics">
          {n === 1 ? <circle r="100" fill={COLOURS[0]} /> : round.top.map((t, i) => <path key={t.id} d={slice(i, n)} fill={COLOURS[i % COLOURS.length]} />)}
          {round.top.map((t, i) => {
            const a = ((i + 0.5) / n) * 2 * Math.PI;
            return <text key={t.id} x={(n === 1 ? 0 : 58 * Math.sin(a)).toFixed(1)} y={(n === 1 ? 0 : -58 * Math.cos(a)).toFixed(1)} textAnchor="middle" dominantBaseline="central">{i + 1}</text>;
          })}
          <circle r="12" className="hub" />
        </svg>
      </div>
      <ol className="legend">
        {round.top.map((t, i) => (
          <li key={t.id} className={spin === "done" && i === chosen ? "won" : spin === "done" ? "lost" : ""}>
            <span className="badge" style={{ background: COLOURS[i % COLOURS.length] }}>{i + 1}</span>
            <span className="legendtext">{t.text}</span>
            {t.votes != null && <span className="count">{t.votes} {t.votes === 1 ? "vote" : "votes"}</span>}
          </li>
        ))}
      </ol>
    </div>
  );
}
