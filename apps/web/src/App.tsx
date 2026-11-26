import { useId, useState, type FormEvent } from "react";
import {
  AcceptedResponse,
  type RequestState,
  type VerdictSlot,
} from "@budget-crew/shared";
import type { ViewModel } from "./model.js";
import { AllowanceChart } from "./AllowanceChart.js";
import { SimulationControls } from "./SimulationControls.js";
import { CrewPanel } from "./CrewPanel.js";
import { BasicView } from "./BasicView.js";
import { initialMode, type Mode } from "./basic.js";
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
  return "status" in verdict ? verdict.status === "cancelled" ? "stop" : "failed" : verdict.level;
}

function VerdictResult({ agent, verdict }: { agent: string; verdict: VerdictSlot | undefined }) {
  if (!verdict) return <div className="verdict-result pending"><span className="verdict-agent">{agent}</span><span className="muted">Awaiting verdict</span></div>;
  if ("status" in verdict && verdict.status === "cancelled") return <div className="verdict-result stop"><span className="verdict-agent">{agent} · cancelled</span><p>Simulation stopped.</p></div>;
  if ("status" in verdict) return <div className="verdict-result failed"><span className="verdict-agent">{agent} · Failed</span><p>{verdict.error}</p></div>;
  return (
    <div className={`verdict-result ${verdict.level}`}>
      <div className="verdict-topline"><span className="verdict-agent">{agent}</span><span className="verdict-level">{verdict.level === "ok" ? "On track" : verdict.level === "warn" ? "Worth a look" : "Caution"}</span></div>
      <h4>{verdict.headline}</h4><p>{verdict.reason}</p>
      {verdict.figures.length > 0 && <dl className="figures">{verdict.figures.map((figure, index) => <div key={`${figure.label}-${index}`}><dt>{figure.label}</dt><dd>{figure.value}</dd></div>)}</dl>}
    </div>
  );
}

function RequestCard({ id, request, newest, onSelect }: { id: string; request: RequestState; newest: boolean; onSelect(): void }) {
  const expected = [...(request.status === "cancelled" && !request.parsed ? ["Parser"] : []), ...expectedAgents(request)];
  const agents = [...new Set([...expected, ...Object.keys(request.verdicts)])].filter((agent) => agent !== "Judge");
  const stopped = request.status === "cancelled";
  const slot = (agent: string): VerdictSlot | undefined => request.verdicts[agent as keyof typeof request.verdicts]
    ?? (stopped ? { status: "cancelled", reason: "simulation_stopped" } : undefined);
  const judge = slot("Judge");
  const parsed = request.parsed;
  const amount = parsed ? ("price" in parsed ? parsed.price : parsed.amount) : undefined;
  const complete = request.kind === "purchase" ? Boolean(request.judgement) : agents.length > 0 && agents.every((agent) => request.verdicts[agent as keyof typeof request.verdicts]);
  const failed = Boolean(request.error) || Object.values(request.verdicts).some((verdict) => verdict && "status" in verdict && verdict.status === "failed");
  return <details className={`request-card ${newest ? "newest" : ""}`} open={newest} aria-label={`${forms[request.kind].label} request ${id}`}>
    <summary className="request-summary" onClick={onSelect}>
      <span className={`request-kind ${request.kind}`}>{forms[request.kind].label}</span>
      <span className="request-input">{request.input || (parsed && "item" in parsed ? parsed.item : stopped ? "Simulation stopped." : "Processing entry…")}</span>
      <strong className="request-amount">{amount === undefined ? "—" : money(amount)}</strong>
      <span className="verdict-dots" aria-label="Crew verdict status">{agents.map((agent) => {
        const verdict = slot(agent);
        const label = verdict && "status" in verdict ? verdict.status : verdictTone(verdict);
        return <span key={agent} className={`verdict-dot ${verdictTone(verdict)}`} title={`${agent}: ${label}`}><span className="sr-only">{agent}: {label}</span></span>;
      })}{request.kind === "purchase" && <span className={`verdict-dot ${request.judgement ? request.judgement.decision === "buy" ? "ok" : "warn" : verdictTone(judge)}`} title={`Judge: ${request.judgement?.decision ?? (judge && "status" in judge ? judge.status : "pending")}`}><span className="sr-only">Judge: {request.judgement?.decision ?? (judge && "status" in judge ? judge.status : "pending")}</span></span>}</span>
      <span className={`request-status ${stopped ? "complete" : failed ? "failed" : complete ? "complete" : "pending"}`}>{stopped ? "Stopped" : request.judgement ? request.judgement.decision.toUpperCase() : failed ? "Needs attention" : complete ? "Reviewed" : "Working"}</span>
      <time dateTime={request.createdAt}>{timeLabel(request.createdAt)}</time>
      <span className="expand-indicator" aria-hidden="true">⌄</span>
    </summary>
    <div className="request-content">
      {request.error && <p className="inline-error" role="alert">{request.error}</p>}
      {request.kind === "purchase" && (request.judgement ? <div className={`judgement ${request.judgement.decision}`}><div><span className="eyebrow">Judge’s decision</span><h3>{request.judgement.decision.toUpperCase()}</h3></div><div><p>{request.judgement.why}</p><dl className="figures">{request.judgement.figures.map((figure, index) => <div key={`${figure.label}-${index}`}><dt>{figure.label}</dt><dd>{figure.value}</dd></div>)}</dl></div></div> : <p className="judge-pending">Judge · {judge && "status" in judge ? judge.status === "cancelled" ? "cancelled" : `Failed: ${judge.error}` : request.error ? "No decision available" : "Waiting for the four advisers"}</p>)}
      {request.kind === "purchase" && parsed && "price" in parsed && <div className="purchase-context"><span className="eyebrow">Budget context · purchase not recorded</span><dl className="figures"><div><dt>Proposed purchase</dt><dd>{money(parsed.price)}</dd></div>{request.simulation && <><div><dt>Current daily allowance</dt><dd>{money(request.simulation.todayAllowance.before)}</dd></div><div><dt>Current remaining</dt><dd>{money(request.simulation.remaining.before)}</dd></div></>}</dl></div>}
      <div className="verdict-grid">{agents.map((agent) => <VerdictResult key={agent} agent={agent} verdict={slot(agent)} />)}</div>
      {!parsed && !request.error && <p className="form-hint">{stopped ? "Simulation stopped." : "Parser is reading your entry…"}</p>}
    </div>
  </details>;
}


export function App({ model, onAccepted, onReload }: AppProps) {
  const [mode, setMode] = useState<Mode>(() => {
    let stored: string | null = null;
    try { stored = localStorage.getItem("budget-crew-mode"); } catch { /* Storage may be disabled. */ }
    return initialMode(location.search, stored);
  });
  const [selectedId, setSelectedId] = useState<string | undefined>(() => new URLSearchParams(location.search).get("request") ?? undefined);
  function selectRequest(id: string) {
    setSelectedId(id);
    const url = new URL(location.href);
    url.searchParams.set("request", id);
    history.replaceState(null, "", url);
  }
  function changeMode(next: Mode) {
    setMode(next);
    try { localStorage.setItem("budget-crew-mode", next); } catch { /* The URL still preserves the choice. */ }
    const url = new URL(location.href);
    url.searchParams.set("mode", next);
    history.replaceState(null, "", url);
  }
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
      selectRequest(result.data.requestId);
      setText(""); setAccepted("Sent to your crew. Follow its progress below.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not reach the server. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`app-shell ${mode === "basic" ? "basic-shell" : ""}`}>
      <header className="app-header"><a className="brand" href="#main"><span className="brand-mark" aria-hidden="true">bc</span><span>budget<span className="brand-light">crew</span></span></a><span className="header-caption">YOUR MONEY. A TEAM EFFORT.</span><div className="header-right"><div className="mode-switch" role="group" aria-label="Display mode">{(["basic", "pro"] as const).map((value) => <button key={value} aria-pressed={mode === value} onClick={() => changeMode(value)}>{value === "basic" ? "Basic" : "Pro"}</button>)}</div><span className="synthetic-label">Synthetic demo · EUR</span><div className="connection" role="status"><span className={`connection-dot ${model.error ? "connection-error" : ""}`} />{model.status}</div><button className="reload-button" onClick={onReload} aria-label="Reload budget and reconnect">↻ Reload</button></div></header>
      {model.error && <div className="connection-error-banner" role="alert">{model.error}</div>}
      <main id="main">
        {mode === "basic" ? <BasicView model={model} selectedId={selectedId} onAccepted={(id, request) => { onAccepted(id, request); selectRequest(id); }} onSelect={selectRequest} onPro={(id) => { selectRequest(id); changeMode("pro"); }} onReload={onReload} /> : <>
        <div className="control-room">
          <aside className="command-column">
            <section className="budget-overview" aria-label="Current budget">
              <div className="section-title"><span className="eyebrow">Your daily runway</span><span className="today-label">{snapshot ? dateLabel(snapshot.today) : "Connecting…"}</span></div>
              <div className="budget-primary"><span className="metric-label">Today’s allowance</span><strong>{today ? money(today.allowance) : "—"}</strong><span>{!snapshot ? "Loading budget…" : !period ? "Add a salary to start a period." : "A plan, not a spending target."}</span></div>
              <div className="budget-metrics"><div><span className="metric-label">Remaining</span><strong>{today ? money(today.remaining) : "—"}</strong></div><div><span className="metric-label">Days left</span><strong>{daysLeft ?? "—"}<small>incl. today</small></strong></div></div>
              <div className="next-allowance"><span>Next allowance</span><strong>{today?.nextAllowance === undefined ? "—" : money(today.nextAllowance)}</strong></div>
            </section>
            <section className="composer" aria-labelledby="entry-heading"><div className="section-title"><h2 id="entry-heading">Give the crew a task</h2><span aria-hidden="true">↗</span></div><div className="entry-tabs" role="group" aria-label="Entry type">{(Object.keys(forms) as RequestKind[]).map((value) => <button key={value} type="button" aria-pressed={kind === value} disabled={busy} onClick={() => { setKind(value); setError(undefined); setAccepted(undefined); }}>{forms[value].label}</button>)}</div><form onSubmit={submit} aria-busy={busy}><label className="sr-only" htmlFor={inputId}>{forms[kind].label} description</label><div className={`entry-field ${error ? "invalid" : ""}`}><textarea id={inputId} value={text} onChange={(event) => { setText(event.target.value); setError(undefined); setAccepted(undefined); }} placeholder={form.placeholder} rows={2} required disabled={busy} aria-invalid={Boolean(error)} aria-describedby={`${hintId}${error ? ` ${errorId}` : ""}`} /></div><p className="form-hint" id={hintId}>{form.hint}</p><button className="submit-button" type="submit" disabled={busy || !text.trim()}>{busy ? "Sending…" : form.action}<span aria-hidden="true">↗</span></button>{error && <p className="inline-error" id={errorId} role="alert">{error}</p>}{accepted && <p className="submission-success" role="status">{accepted}</p>}</form></section>
            <SimulationControls snapshot={snapshot} onReload={onReload} />
          </aside>
          <CrewPanel model={model} requestId={selectedId && snapshot?.requests[selectedId] ? selectedId : requests[0]?.[0]} />
        </div>
        <div className="below-deck">
          <section className="requests-section" aria-labelledby="requests-heading"><div className="section-title requests-heading"><div><span className="eyebrow">The crew’s field notes</span><h2 id="requests-heading">Request feed <span className="count">{requests.length}</span></h2></div><span className="quiet-label">Select any row for detail</span></div>{requests.length ? <div className="request-list">{requests.map(([id, request], index) => <RequestCard key={id} id={id} request={request} newest={selectedId && snapshot?.requests[selectedId] ? id === selectedId : index === 0} onSelect={() => selectRequest(id)} />)}</div> : <div className="empty-state"><span aria-hidden="true">＋</span><div><h3>No requests yet. Your crew is ready.</h3><p>Add an entry or replay November to see the team in action.</p></div></div>}</section>
          <AllowanceChart period={period} today={snapshot?.today} />
        </div>
        </>}
      </main>
      <footer className="app-footer"><span>Independent agents. Deterministic money math.</span><span>Budget Crew / {mode === "basic" ? "Everyday clarity" : "Mission control"}</span></footer>
    </div>
  );
}

export default App;
