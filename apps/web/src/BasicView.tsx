import { useState, type FormEvent } from "react";
import { AcceptedResponse, type RequestState } from "@budget-crew/shared";
import type { ViewModel } from "./model.js";
import { advisers, classifyEntry, deriveHistory, endpoints, requestSummary, type RequestKind } from "./basic.js";
import "./basic.css";
import { InferenceLabel, ReplayNote } from "./InferenceLabel.js";

const currency = new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR" });
const dateFormat = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const monthFormat = new Intl.DateTimeFormat("en-GB", { month: "long", timeZone: "UTC" });
const money = (cents: number) => currency.format(cents / 100);
const date = (value: string) => dateFormat.format(new Date(`${value}T00:00:00Z`));
const month = (value: string) => monthFormat.format(new Date(`${value}T00:00:00Z`));
const kinds: RequestKind[] = ["expense", "income", "purchase"];
const labels: Record<RequestKind, string> = { expense: "Expense", income: "Income", purchase: "Purchase check" };

type Props = {
  model: ViewModel;
  selectedId?: string;
  onAccepted(id: string, request: RequestState): void;
  onSelect(id: string): void;
  onPro(id: string): void;
  onReload(): void;
};

function Answer({ id, request, model, onPro }: { id: string; request: RequestState; model: ViewModel; onPro(id: string): void }) {
  const agents = advisers(request);
  const terminal = Boolean(request.error || request.status === "cancelled" || request.judgement);
  const complete = terminal || (request.kind !== "purchase" && Boolean(request.parsed) && agents.every((agent) => request.verdicts[agent as keyof typeof request.verdicts]));
  const active = new Set(Object.values(model.activity).filter((event) => event.data.requestId === id && ["received", "thinking", "tool"].includes(event.data.phase)).map((event) => event.data.agent));
  const activeAdvisers = agents.filter((agent) => active.has(agent));
  const failed = Object.values(request.verdicts).some((slot) => slot && "status" in slot && slot.status === "failed");
  const judgeFailed = request.verdicts.Judge && "status" in request.verdicts.Judge && request.verdicts.Judge.status === "failed";
  const working = !complete && !judgeFailed;
  const headline = request.status === "cancelled" ? "Replay stopped" : request.error || judgeFailed ? "Needs attention" : request.judgement ? request.judgement.decision : working ? "Your crew is on it" : failed ? "Some advice is unavailable" : request.kind === "income" ? "Income added" : "Expense added";
  const summary = requestSummary(request);
  const figures = request.judgement && request.simulation && request.parsed && "price" in request.parsed
    ? [
      { label: "Purchase price", value: money(request.parsed.price) },
      { label: "Left after purchase", value: money(request.simulation.remaining.after) },
      ...(request.simulation.nextAllowance.after === undefined ? [] : [{ label: "Next daily allowance", value: money(request.simulation.nextAllowance.after) }]),
    ]
    : request.judgement?.figures.slice(0, 3) ?? [];
  return <article className={`basic-answer ${working ? "is-working" : ""}`} aria-label="Latest crew answer" aria-live="polite">
    <div className="basic-answer-top"><span className="basic-kicker">Your crew’s answer</span><span className="basic-type">{labels[request.kind]}</span></div>
    <InferenceLabel request={request} />
    <p className="basic-request">“{request.input || "Replay entry"}”</p>
    <h2 className="basic-decision">{headline}</h2>
    {working && <div className="basic-working"><div className="basic-avatars" aria-label="Adviser activity">{agents.map((agent) => <span key={agent} className={`basic-avatar ${active.has(agent) ? "active" : ""}`} title={`${agent}: ${active.has(agent) ? "checking now" : request.verdicts[agent as keyof typeof request.verdicts] ? "answered" : "waiting"}`}><span aria-hidden="true">{agent.split(" ").map((word) => word[0]).join("")}</span><span className="sr-only">{agent}: {active.has(agent) ? "checking now" : "waiting or answered"}</span></span>)}</div><p>{activeAdvisers.length > 1 ? `${activeAdvisers.length} advisers are checking this at once…` : active.has("Judge") ? "Your advisers have weighed in. The Judge is deciding…" : !request.parsed ? "Reading your entry, then bringing the crew together…" : "Your crew is checking the details…"}</p></div>}
    {summary && <p className="basic-why">{summary}</p>}
    {!summary && !working && <p className="basic-why">No answer is available. Open Pro for the request details.</p>}
    {figures.length > 0 && <dl className="basic-figures">{figures.map((figure, index) => <div key={index}><dt>{figure.label}</dt><dd>{figure.value}</dd></div>)}</dl>}
    <button className="basic-link" onClick={() => onPro(id)}>See how the crew decided <span aria-hidden="true">↗</span></button>
  </article>;
}

export function BasicView({ model, selectedId, onAccepted, onSelect, onPro, onReload }: Props) {
  const [text, setText] = useState("");
  const [override, setOverride] = useState<RequestKind>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [replayBusy, setReplayBusy] = useState(false);
  const [replayError, setReplayError] = useState<string>();
  const snapshot = model.snapshot;
  const period = snapshot?.periods.find((entry) => entry.id === snapshot.currentPeriodId && entry.status === "open");
  const today = period?.projection.find((entry) => entry.date === snapshot?.today);
  const days = period?.projection.filter((entry) => entry.date >= snapshot!.today).length ?? 0;
  const requests = Object.entries(snapshot?.requests ?? {}).sort(([aId, a], [bId, b]) => b.createdAt.localeCompare(a.createdAt) || bId.localeCompare(aId));
  const selected = requests.find(([id]) => id === selectedId) ?? requests[0];
  const kind = override ?? classifyEntry(text);
  const history = snapshot ? deriveHistory(snapshot) : [];
  const running = snapshot?.simulation.running ?? false;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!text.trim() || busy) return;
    setBusy(true); setError(undefined);
    const input = text.trim();
    const createdAt = new Date().toISOString();
    try {
      const response = await fetch(endpoints[kind], { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: input }) });
      if (response.status === 409) throw new Error("Add a salary to start a period first.");
      if (response.status !== 202) throw new Error(`Could not send your entry (${response.status}). Please try again.`);
      const accepted = AcceptedResponse.safeParse(await response.json());
      if (!accepted.success) throw new Error("Invalid response. Reload to check whether your entry was accepted.");
      onAccepted(accepted.data.requestId, { kind, input, createdAt, verdicts: {} });
      setText(""); setOverride(undefined);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not connect. Please try again."); }
    finally { setBusy(false); }
  }

  async function replay() {
    if (replayBusy) return;
    setReplayBusy(true); setReplayError(undefined);
    try {
      const response = await fetch("/api/simulation", running ? { method: "DELETE" } : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ speed: 4 }) });
      if (!response.ok) throw new Error(`Could not ${running ? "stop" : "start"} replay (${response.status}).`);
      onReload();
    } catch (cause) { setReplayError(cause instanceof Error ? cause.message : "Could not reach replay."); }
    finally { setReplayBusy(false); }
  }

  return <div className="basic-content">
    <section className="basic-hero" aria-labelledby="basic-heading"><div className="basic-hero-top"><span className="basic-kicker">A little clarity. Every day.</span><span>{snapshot ? date(snapshot.today) : "Connecting…"}</span></div><h1 id="basic-heading">How much can I spend today?</h1><div className="basic-allowance">{today ? money(today.allowance) : "—"}</div><p className="basic-budget-sentence">{today && period ? `${money(today.allowance)} for today · ${money(today.remaining)} left until ${date(period.end)} · ${days} ${days === 1 ? "day" : "days"}` : !snapshot ? "Loading your budget…" : "Start with your salary. We’ll work out your daily allowance."}</p><p className="basic-reassurance">Your essentials are already set aside. This is your everyday spending money.</p></section>
    <section className="basic-composer" aria-labelledby="basic-entry-heading"><div className="basic-section-heading"><h2 id="basic-entry-heading">Ask or tell your crew</h2><span>One entry. A team on your side.</span></div><form onSubmit={(event) => { void submit(event); }}><div className="basic-input-row"><label className="sr-only" htmlFor="basic-entry">Ask or tell your crew</label><input id="basic-entry" value={text} onChange={(event) => { setText(event.target.value); setOverride(undefined); setError(undefined); }} placeholder="Coffee 3.50, salary 2500, or can I buy…?" disabled={busy || !snapshot} aria-describedby="basic-entry-hint" maxLength={2000} required /><button className="basic-send" disabled={busy || !snapshot || !text.trim()}>{busy ? "Sending…" : "Send to crew"}<span aria-hidden="true">↗</span></button></div><div className="basic-input-meta"><button type="button" className="basic-kind-chip" disabled={busy} onClick={() => setOverride(kinds[(kinds.indexOf(kind) + 1) % kinds.length])} aria-label={`Entry type: ${labels[kind]}. Click to change`}>{labels[kind]} <span aria-hidden="true">⇄</span></button><span id="basic-entry-hint">{kind === "purchase" ? "Advice only — this won’t record a purchase." : "We’ll record it and update your daily plan."}</span></div>{error && <p className="inline-error" role="alert">{error}</p>}</form></section>
    {selected ? <Answer id={selected[0]} request={selected[1]} model={model} onPro={onPro} /> : <section className="basic-answer basic-welcome"><span className="basic-kicker">Meet your everyday money team</span><h2>A second opinion before you spend.</h2><p>Ask “can I buy a jacket for €90?” Your advisers check your budget, upcoming bills and the deal together, then give you one clear answer.</p></section>}
    <section className="basic-history" aria-labelledby="basic-history-heading"><div className="basic-section-heading"><div><span className="basic-kicker">The bigger picture</span><h2 id="basic-history-heading">Your money, month by month</h2></div><span>Synthetic demo history</span></div>{!snapshot ? <p>Loading history…</p> : !history.length ? <div className="basic-history-empty">Your story starts here. Completed months will appear here with spending, savings and a few memorable decisions.</div> : <div className="basic-months">{history.map(({ period: past, spent, balance, requests: examples, moment, momentRequest }) => <details className="basic-month" key={past.id}><summary><span className="basic-month-name">{month(past.start)} <small>{past.start.slice(0, 4)}</small></span><span><small>Spent</small><strong>{money(spent)}</strong></span><span><small>{balance >= 0 ? "Saved" : "Overspent"}</small><strong>{money(Math.abs(balance))}</strong></span><p>{moment}<InferenceLabel request={momentRequest} /></p><span className="basic-expand" aria-hidden="true">+</span></summary><div className="basic-month-examples">{examples.length ? examples.map(([id, request]) => <button key={id} onClick={() => { onSelect(id); document.querySelector(".basic-answer")?.scrollIntoView({ behavior: "smooth", block: "center" }); }}><span>{request.input}</span><strong>{request.judgement?.decision ?? (request.status === "cancelled" ? "Stopped" : request.error ? "Needs attention" : requestSummary(request) || "No advice yet")}</strong><InferenceLabel request={request} /></button>) : <p>No example requests saved for this month.</p>}</div></details>)}</div>}{period && <div className="basic-current-month"><strong>{month(period.start)}</strong><span>In progress · {days} {days === 1 ? "day" : "days"} left in this period</span></div>}</section>
    <section className="basic-replay"><div><h2>Watch a month of small decisions add up.</h2><p>{running ? `Replaying ${snapshot?.simulation.day ?? "November"}. Stop at any time.` : "Replay a synthetic November with your crew. This resets the current demo month."}</p><ReplayNote snapshot={snapshot} /></div><button disabled={!snapshot || replayBusy} onClick={() => { void replay(); }}>{replayBusy ? "Updating…" : running ? "Stop replay" : "Replay November"}</button>{replayError && <p className="inline-error" role="alert">{replayError}</p>}</section>
  </div>;
}
