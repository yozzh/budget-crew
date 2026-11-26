import { useId, useState, type FormEvent } from "react";
import {
  AcceptedResponse,
  AgentName,
  type ActivityEnvelope,
  type RequestState,
  type VerdictSlot,
} from "@budget-crew/shared";
import type { ViewModel } from "./model.js";
import "./style.css";

type RequestKind = RequestState["kind"];
type AppProps = {
  model: ViewModel;
  onAccepted(id: string, request: RequestState): void;
  onReload(): void;
};

const forms: Record<RequestKind, { label: string; endpoint: string; placeholder: string; action: string; hint: string }> = {
  expense: {
    label: "Expense", endpoint: "/api/expenses", placeholder: "Coffee and a sandwich for €8.50",
    action: "Add expense", hint: "Tell us what you spent. Your crew will take it from there.",
  },
  income: {
    label: "Income", endpoint: "/api/incomes", placeholder: "My salary of €2,800 arrived today",
    action: "Add income", hint: "Add a salary to start a period, or record a little extra income.",
  },
  purchase: {
    label: "Can I buy?", endpoint: "/api/purchase-checks", placeholder: "Can I buy noise-cancelling headphones for €120?",
    action: "Ask the crew", hint: "Get a second opinion before you spend. This won’t record an expense.",
  },
};
const moneyFormat = new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR" });
const dayFormat = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const clockFormat = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const money = (cents: number) => moneyFormat.format(cents / 100);
const dateLabel = (date: string) => dayFormat.format(new Date(`${date}T00:00:00Z`));
const timeLabel = (date: string) => {
  const value = new Date(date);
  return Number.isNaN(value.getTime()) ? date : clockFormat.format(value);
};

function expectedAgents(request: RequestState): string[] {
  if (request.kind === "expense") return ["Pace", "Anomaly", "Coach"];
  if (request.kind === "purchase") return ["Impact", "Obligations", "Deal Check", "Alternatives"];
  if (!request.parsed || !("kind" in request.parsed)) return [];
  return request.parsed.kind === "salary" ? ["Planner", "Obligations"] : ["Pace", "Coach"];
}

function verdictTone(verdict: VerdictSlot | undefined): string {
  if (!verdict) return "pending";
  return "status" in verdict ? "failed" : verdict.level;
}

function VerdictResult({ agent, verdict }: { agent: string; verdict: VerdictSlot | undefined }) {
  if (!verdict) return <div className="verdict-result pending"><span className="verdict-agent">{agent}</span><span className="muted">Awaiting verdict</span></div>;
  if ("status" in verdict) return <div className="verdict-result failed"><span className="verdict-agent">{agent} · Failed</span><p>{verdict.error}</p></div>;
  return (
    <div className={`verdict-result ${verdict.level}`}>
      <div className="verdict-topline"><span className="verdict-agent">{agent}</span><span className="verdict-level">{verdict.level === "ok" ? "On track" : verdict.level === "warn" ? "Worth a look" : "Caution"}</span></div>
      <h4>{verdict.headline}</h4><p>{verdict.reason}</p>
      {verdict.figures.length > 0 && <dl className="figures">{verdict.figures.map((figure, index) => <div key={`${figure.label}-${index}`}><dt>{figure.label}</dt><dd>{figure.value}</dd></div>)}</dl>}
    </div>
  );
}

function RequestCard({ id, request, newest }: { id: string; request: RequestState; newest: boolean }) {
  const expected = expectedAgents(request);
  const agents = [...new Set([...expected, ...Object.keys(request.verdicts)])];
  const parsed = request.parsed;
  const amount = parsed ? ("price" in parsed ? parsed.price : parsed.amount) : undefined;
  const description = parsed ? ("item" in parsed ? parsed.item : "source" in parsed ? parsed.source : parsed.note || parsed.category) : undefined;
  const complete = request.kind === "purchase" ? Boolean(request.judgement) : agents.length > 0 && agents.every((agent) => request.verdicts[agent as keyof typeof request.verdicts]);
  const failed = Boolean(request.error) || Object.values(request.verdicts).some((verdict) => verdict && "status" in verdict);
  return (
    <article className="request-card" aria-label={`${forms[request.kind].label} request ${id}`}>
      <div className="request-topline"><span className={`request-kind ${request.kind}`}>{forms[request.kind].label}</span><time dateTime={request.createdAt}>{timeLabel(request.createdAt)}</time><span className={`request-status ${failed ? "failed" : complete ? "complete" : "pending"}`}>{failed ? "Needs attention" : complete ? "Reviewed" : "In progress"}</span></div>
      <p className="request-input">{request.input}</p>
      <div className="parsed-line">{parsed ? <><strong>{amount === undefined ? "" : money(amount)}</strong><span>{description}</span><span className="parsed-category">{"kind" in parsed ? parsed.kind === "salary" ? "Salary" : "Extra income" : parsed.category}</span></> : <span className="muted">{request.error ? "Entry could not be processed." : "Parsing your entry…"}</span>}</div>
      {request.error && <p className="inline-error" role="alert">{request.error}</p>}
      <ul className="agent-chips" aria-label="Crew verdict status">
        {agents.map((agent) => <li className={`agent-chip ${verdictTone(request.verdicts[agent as keyof typeof request.verdicts])}`} key={agent}><span className="tiny-dot" />{agent}<span className="sr-only">: {verdictTone(request.verdicts[agent as keyof typeof request.verdicts])}</span></li>)}
        {request.kind === "purchase" && <li className={`agent-chip ${request.judgement ? request.judgement.decision === "buy" ? "ok" : "warn" : "pending"}`}><span className="tiny-dot" />Judge<span className="sr-only">: {request.judgement?.decision ?? "pending"}</span></li>}
      </ul>
      {agents.length > 0 && <details className="verdict-details" open={newest}><summary>Crew assessment <span aria-hidden="true">↗</span></summary><div className="verdict-grid">{agents.map((agent) => <VerdictResult key={agent} agent={agent} verdict={request.verdicts[agent as keyof typeof request.verdicts]} />)}</div></details>}
      {request.kind === "purchase" && (request.judgement ? <div className={`judgement ${request.judgement.decision}`}><div className="eyebrow">Judge’s decision</div><h4>{request.judgement.decision === "buy" ? "Buy" : request.judgement.decision === "wait" ? "Wait" : "Skip"}</h4><p>{request.judgement.why}</p>{request.judgement.figures.length > 0 && <dl className="figures">{request.judgement.figures.map((figure, index) => <div key={`${figure.label}-${index}`}><dt>{figure.label}</dt><dd>{figure.value}</dd></div>)}</dl>}</div> : <p className="judge-pending">Judge · {request.error ? "No decision available" : "Waiting for the crew’s assessment"}</p>)}
    </article>
  );
}

function ActivityPanel({ activity }: { activity: Record<string, ActivityEnvelope> }) {
  const entries = Object.values(activity).sort((a, b) => b.at.localeCompare(a.at));
  const names = [...new Set<string>([...AgentName.options, ...entries.map((entry) => entry.data.agent)])];
  const active = entries.filter((entry) => !["answered", "failed"].includes(entry.data.phase)).length;
  return (
    <aside className="activity-panel" aria-labelledby="activity-heading">
      <div className="panel-heading"><div><span className="eyebrow">Behind the scenes</span><h2 id="activity-heading">Your crew <span className="count">{names.length}</span></h2></div><span className={`live-badge ${active ? "working" : ""}`}><span className="tiny-dot" />{active ? `${active} active` : "Standing by"}</span></div>
      <p className="panel-description">Live agent activity, one loop at a time.</p>
      <div className="activity-list">{names.map((agent, index) => {
        const loops = entries.filter((entry) => entry.data.agent === agent);
        return <section className="agent-row" key={agent} aria-label={`${agent} activity`}><div className={`agent-avatar avatar-${index % 4}`} aria-hidden="true">{agent.split(" ").map((word) => word[0]).join("").slice(0, 2)}</div><div className="agent-body"><div className="agent-heading"><h3>{agent}</h3>{loops.length > 1 && <span className="loop-count">{loops.length} loops</span>}{loops.length === 0 && <span className="idle-label">Idle</span>}</div>{loops.map((entry) => <div className={`activity-loop phase-${entry.data.phase}`} key={entry.data.loopId}><div className="loop-topline"><span className="phase-label"><span className="tiny-dot" />{entry.data.phase}</span><time dateTime={entry.at}>{timeLabel(entry.at)}</time></div>{entry.data.tool && <div className="activity-tool">Tool · {entry.data.tool}</div>}{entry.data.summary && <p>{entry.data.summary}</p>}<div className="loop-reference" title={`Loop ${entry.data.loopId}${entry.data.requestId ? ` · Request ${entry.data.requestId}` : ""}`}>Loop {entry.data.loopId}{entry.data.requestId && <> · Request {entry.data.requestId}</>}</div></div>)}</div></section>;
      })}</div>
      <div className="activity-footer"><span className="tiny-dot" />Independent agents. One shared picture.</div>
    </aside>
  );
}

export function App({ model, onAccepted, onReload }: AppProps) {
  const [kind, setKind] = useState<RequestKind>("expense");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [accepted, setAccepted] = useState<string>();
  const inputId = useId();
  const hintId = useId();
  const errorId = useId();
  const snapshot = model.snapshot;
  const period = snapshot?.periods.find((candidate) => candidate.id === snapshot.currentPeriodId && candidate.status === "open");
  const today = period?.projection.find((day) => day.date === snapshot?.today);
  const daysLeft = period && snapshot ? period.projection.filter((day) => day.date >= snapshot.today).length : undefined;
  const requests = Object.entries(snapshot?.requests ?? {}).sort(([idA, a], [idB, b]) => b.createdAt.localeCompare(a.createdAt) || idB.localeCompare(idA));
  const form = forms[kind];

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const input = text.trim();
    if (!input) { setError("Write a short description first."); return; }
    setBusy(true); setError(undefined); setAccepted(undefined);
    const createdAt = new Date().toISOString();
    try {
      const response = await fetch(form.endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: input }) });
      const body: unknown = await response.json().catch(() => null);
      if (response.status === 409 && body && typeof body === "object" && "error" in body && body.error === "no_open_period") throw new Error("Add a salary to start a period.");
      if (response.status !== 202) {
        const detail = body && typeof body === "object" && "error" in body && typeof body.error === "string" ? body.error : response.statusText;
        throw new Error(`Could not submit ${forms[kind].label.toLowerCase()} (${response.status})${detail ? `: ${detail}` : "."}`);
      }
      const result = AcceptedResponse.safeParse(body);
      if (!result.success) throw new Error("The server accepted the entry but returned an invalid request ID. Reload to check its status.");
      onAccepted(result.data.requestId, { kind, input, verdicts: {}, createdAt });
      setText(""); setAccepted("Sent to your crew. Follow its progress below.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not reach the server. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app-shell">
      <header className="app-header"><a className="brand" href="#main"><span className="brand-mark" aria-hidden="true">b<span>c</span></span><span>budget<span className="brand-light">crew</span><small>A little clarity. Every day.</small></span></a><div className="header-right"><div className="connection" role="status"><span className={`connection-dot ${model.error ? "connection-error" : ""}`} /><span>{model.status}</span>{model.reload && <span className="reload-notice">Update available</span>}</div><button className="reload-button" type="button" onClick={onReload} aria-label="Reload budget and reconnect">↻ <span>Reload</span></button></div></header>
      {model.error && <div className="connection-error-banner" role="alert">{model.error}</div>}
      <main id="main">
        <div className="page-heading"><div><span className="eyebrow">Your everyday money companion</span><h1>A clearer view of today.</h1></div><span className="today-label">{snapshot ? dateLabel(snapshot.today) : "Connecting to your budget…"}</span></div>
        <section className="budget-overview" aria-label="Current budget">
          <div className="budget-primary"><span className="metric-label">Today’s allowance</span><strong>{today ? money(today.allowance) : "—"}</strong><span>{!snapshot ? "Loading your budget…" : !period ? "Add a salary to start a period." : !today ? "No projection available for today" : "A daily plan, not a spending target"}</span></div>
          <div className="budget-metric"><span className="metric-label">Next allowance</span><strong>{today?.nextAllowance === undefined ? "—" : money(today.nextAllowance)}</strong><span>{today && today.nextAllowance === undefined ? "Last day of this period" : "The next day’s plan"}</span></div>
          <div className="budget-metric"><span className="metric-label">Remaining balance</span><strong>{today ? money(today.remaining) : "—"}</strong><span>After today’s recorded spending</span></div>
          <div className="budget-metric period-metric"><span className="metric-label">Days left</span><strong>{daysLeft ?? "—"}<small>{daysLeft === undefined ? "" : " incl. today"}</small></strong><span>{period ? `${dateLabel(period.start)} – ${dateLabel(period.end)}` : "No open period"}</span><span className="carryover">Carryover <b>{period ? money(period.carryover) : "—"}</b></span></div>
        </section>
        <div className="workspace"><div className="main-column">
          <section className="composer" aria-labelledby="entry-heading"><div className="section-title"><h2 id="entry-heading">What’s happening?</h2><span className="quiet-label">Just use your own words</span></div><div className="entry-tabs" role="group" aria-label="Entry type">{(Object.keys(forms) as RequestKind[]).map((value) => <button key={value} type="button" aria-pressed={kind === value} disabled={busy} className={kind === value ? "selected" : ""} onClick={() => { setKind(value); setError(undefined); setAccepted(undefined); }}>{forms[value].label}</button>)}</div><form onSubmit={submit} aria-busy={busy}><label className="sr-only" htmlFor={inputId}>{forms[kind].label} description</label><div className={`entry-field ${error ? "invalid" : ""}`}><textarea id={inputId} value={text} onChange={(event) => { setText(event.target.value); setError(undefined); setAccepted(undefined); }} placeholder={form.placeholder} rows={2} required disabled={busy} aria-invalid={Boolean(error)} aria-describedby={`${hintId}${error ? ` ${errorId}` : ""}`} /><button className="submit-button" type="submit" disabled={busy || !text.trim()}>{busy ? "Sending…" : form.action}<span aria-hidden="true">↗</span></button></div><p className="form-hint" id={hintId}>{form.hint}</p>{error && <p className="inline-error" id={errorId} role="alert">{error}</p>}{accepted && <p className="submission-success" role="status">{accepted}</p>}</form></section>
          <section className="requests-section" aria-labelledby="requests-heading"><div className="section-title requests-heading"><h2 id="requests-heading">Your latest entries <span className="count">{requests.length}</span></h2><span className="quiet-label">Newest first</span></div>{requests.length ? <div className="request-list">{requests.map(([id, request], index) => <RequestCard key={id} id={id} request={request} newest={index === 0} />)}</div> : <div className="empty-state"><span className="empty-mark" aria-hidden="true">＋</span><h3>{snapshot ? "A fresh start for your finances" : "Getting everything ready"}</h3><p>{snapshot ? "Add an expense, record income, or ask about a purchase. Your crew’s insights will appear here." : "Your budget and recent entries will appear once the server connects."}</p></div>}</section>
        </div><ActivityPanel activity={model.activity} /></div>
      </main>
      <footer className="app-footer">Built for thoughtful spending, one day at a time.<span>Budget Crew · EUR</span></footer>
    </div>
  );
}

export default App;
