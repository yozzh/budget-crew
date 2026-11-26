import { useEffect, useState, type CSSProperties } from "react";
import { AgentName } from "@budget-crew/shared";
import type { ViewModel } from "./model.js";
import { deriveTimeline } from "./timeline.js";

const members: Record<string, { role: string; tier: string; mark: string; color: string }> = {
  Parser: { role: "Makes sense of words", tier: "luna", mark: "[ ]", color: "#9bcbff" },
  Planner: { role: "Sets the monthly plan", tier: "terra", mark: "▦", color: "#b8a5ff" },
  Pace: { role: "Tracks your daily pace", tier: "terra", mark: "↗", color: "#6de6cf" },
  Anomaly: { role: "Spots unusual spending", tier: "terra", mark: "◇", color: "#ffd08b" },
  Coach: { role: "Turns numbers into advice", tier: "sol", mark: "✦", color: "#f4a8dd" },
  Impact: { role: "Tests before you spend", tier: "terra", mark: "±", color: "#8acbff" },
  Obligations: { role: "Protects the essentials", tier: "terra", mark: "⊞", color: "#c1d98b" },
  "Deal Check": { role: "Checks the real discount", tier: "terra", mark: "%", color: "#ffb4a0" },
  Alternatives: { role: "Finds another way", tier: "terra", mark: "⇄", color: "#a6bbff" },
  Judge: { role: "Makes the final call", tier: "sol", mark: "⊥", color: "#f4d87a" },
};
const activePhases = ["received", "thinking", "tool"];

export function CrewPanel({ model, requestId }: { model: ViewModel; requestId?: string }) {
  const [room, setRoom] = useState(false);
  const [now, setNow] = useState(Date.now);
  const entries = Object.values(model.activity).sort((a, b) => b.at.localeCompare(a.at));
  const working = new Set(entries.filter((entry) => activePhases.includes(entry.data.phase) && model.snapshot?.requests[entry.data.requestId ?? ""]?.status !== "cancelled").map((entry) => entry.data.agent));
  const rolling = model.snapshot?.simulation.running ?? false;
  useEffect(() => {
    if (!working.size && !rolling) return;
    const timer = setInterval(() => setNow(Date.now()), 80);
    return () => clearInterval(timer);
  }, [working.size, rolling]);
  const timeline = deriveTimeline(model, requestId, Math.max(now, Date.now()), rolling);
  const duration = Math.max(1, timeline.end - timeline.start);
  const hasBars = timeline.lanes.some((lane) => lane.bars.length);
  return <section className="crew-panel" aria-labelledby="crew-heading">
    <div className="crew-heading"><div><span className="eyebrow">Ten minds. One shared budget.</span><h1 id="crew-heading">Your money crew<span className="crew-count">10</span></h1></div><span className={`live-badge ${working.size ? "working" : ""}`}><span className="tiny-dot" />{working.size ? `${working.size} working together` : "Crew standing by"}</span></div>
    <div className="crew-view-switch" role="group" aria-label="Crew view"><button aria-pressed={!room} onClick={() => setRoom(false)}>Mission control</button><button aria-pressed={room} onClick={() => setRoom(true)}>Room <span>next</span></button><p>Independent loops · live activity</p></div>
    {room ? <div className="room-slot"><span className="room-wire" aria-hidden="true">◇</span><h2>A room for the crew</h2><p>The future 3D room will live here, using the same live activity stream.</p><button onClick={() => setRoom(false)}>Back to mission control</button></div> : <div className="crew-grid">{AgentName.options.map((agent) => {
      const member = members[agent]!;
      const loops = entries.filter((entry) => entry.data.agent === agent);
      const active = loops.filter((entry) => activePhases.includes(entry.data.phase) && model.snapshot?.requests[entry.data.requestId ?? ""]?.status !== "cancelled");
      const entry = active[0] ?? loops[0];
      const request = entry?.data.requestId ? model.snapshot?.requests[entry.data.requestId] : undefined;
      const phase = request?.status === "cancelled" && entry && activePhases.includes(entry.data.phase) ? "cancelled" : entry?.data.phase ?? "idle";
      const verdict = request?.verdicts[agent];
      const judgement = agent === "Judge" ? request?.judgement : undefined;
      const tone = phase === "failed" ? "failed" : phase === "cancelled" ? "warn" : phase === "answered" ? verdict && !("status" in verdict) ? verdict.level : judgement ? judgement.decision === "buy" ? "ok" : judgement.decision === "skip" ? "stop" : "warn" : "ok" : "";
      const headline = verdict && !("status" in verdict) ? verdict.headline : judgement ? judgement.decision.toUpperCase() : entry?.data.summary;
      return <article key={agent} className={`crew-member phase-${phase} tone-${tone}`} style={{ "--agent": member.color } as CSSProperties} aria-label={`${agent} activity`}>
        <div className="member-top"><span className="member-glyph" aria-hidden="true">{member.mark}</span><span className="model-tier">{member.tier}</span></div>
        <h2>{agent}</h2><p className="member-role">{member.role}</p>
        <div className="phase-label"><span className="tiny-dot" />{phase === "cancelled" ? "Cancelled" : phase === "tool" ? "Using a tool" : phase === "answered" ? "Answered" : phase === "received" ? "Received" : phase === "thinking" ? "Thinking" : phase === "failed" ? "Failed" : "Idle / ready"}{active.length > 1 && ` · ${active.length} loops`}</div>
        <p className="member-detail" title={phase === "tool" ? entry?.data.tool : headline}>{phase === "cancelled" ? "Simulation stopped." : phase === "tool" ? entry?.data.tool ?? "Running tool" : phase === "answered" ? headline ?? "Response delivered" : phase === "failed" ? entry?.data.summary ?? "Could not complete this loop" : phase === "thinking" ? "Working on this request…" : phase === "received" ? "A new request just arrived" : "Waiting for your next move"}</p>
      </article>;
    })}</div>}
    <section className="timeline-panel" aria-label="Agent concurrency timeline">
      <div className="section-title"><h2>Parallel, not sequential</h2><span className="overlap-count" role="status">{timeline.running} loops running now</span></div>
      <div className="timeline-axis"><span>Agent</span><span>{rolling ? "−20 s" : "0 ms"}</span><span>{rolling ? "Now" : `${Math.round(duration)} ms`}</span></div>
      <div className="timeline-lanes">{timeline.lanes.map((lane) => <div className="timeline-lane" key={lane.agent} data-agent={lane.agent}>
        <span>{lane.agent}</span>
        <div className="timeline-track">{lane.bars.map((bar) => <div
          key={`${bar.requestId ?? ""}:${bar.loopId}`}
          className={`timeline-bar phase-${bar.phase}${bar.latest ? " latest" : ""}`}
          style={{ left: `${(bar.start - timeline.start) / duration * 100}%`, width: `${(bar.end - bar.start) / duration * 100}%`, top: `${bar.row * 8 / lane.rows + 1}px`, height: `${Math.min(4, 8 / lane.rows * .8)}px`, backgroundColor: members[lane.agent]?.color }}
          title={`${lane.agent} · ${bar.requestId ?? "unlinked request"} · ${bar.loopId} · ${Math.round(bar.end - bar.start)} ms visible · ${bar.phase}${bar.incomplete ? " · received event unavailable" : ""}`}
        />)}</div>
      </div>)}</div>
      <p className="timeline-caption">{hasBars ? `${rolling ? "Last 20 s · all requests" : "Latest request"} · ${timeline.peak} peak overlapping · bright outline = latest request · observed timestamps` : "Send an entry or start the timelapse to see independent loops."}</p>
    </section>
  </section>;
}
