import { useId, useState, type FormEvent } from "react";
import type { StateResponse } from "@budget-crew/shared";
import { ReplayNote } from "./InferenceLabel.js";

export function SimulationControls({ snapshot, onReload }: { snapshot: StateResponse | null; onReload(): void }) {
  const speedId = useId();
  const [speed, setSpeed] = useState("4");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const running = snapshot?.simulation.running ?? false;

  async function command(start: boolean) {
    if (busy) return;
    const value = Number(speed);
    if (start && (!Number.isFinite(value) || value <= 0)) {
      setError("Enter a positive simulation speed.");
      return;
    }
    setBusy(true); setError(undefined); setNotice(undefined);
    try {
      const response = await fetch("/api/simulation", start
        ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ speed: value }) }
        : { method: "DELETE" });
      if (response.status === 409) {
        onReload();
        throw new Error("A timelapse is already running. Stop it before starting another.");
      }
      if (start ? response.status !== 202 : !response.ok) {
        const body: unknown = await response.json().catch(() => null);
        const detail = body && typeof body === "object" && "error" in body && typeof body.error === "string" ? `: ${body.error}` : "";
        throw new Error(`Could not ${start ? "start" : "stop"} timelapse (${response.status})${detail}`);
      }
      setNotice(start ? "Timelapse started." : "Timelapse stopped.");
      onReload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not reach the simulation server.");
    } finally {
      setBusy(false);
    }
  }

  function start(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void command(true);
  }

  return <section className="simulation-panel" aria-labelledby="simulation-heading">
    <div className="section-title"><h2 id="simulation-heading">Month timelapse</h2><span className="quiet-label" role="status">{running ? `Running at ${snapshot!.simulation.speed} seconds/day` : "Stopped"}</span></div>
    <p className="simulation-day" role="status">Simulated current day: <strong>{snapshot?.simulation.day ?? snapshot?.today ?? "Loading…"}</strong></p>
    <ReplayNote snapshot={snapshot} />
    <form className="simulation-controls" onSubmit={start} aria-busy={busy}>
      <label htmlFor={speedId}>Speed <span className="quiet-label">(seconds/day)</span></label>
      <input id={speedId} type="number" inputMode="decimal" step="any" min="0" required value={speed} onChange={(event) => setSpeed(event.target.value)} disabled={busy || running} />
      <button className="submit-button" type="submit" disabled={!snapshot || busy || running}>Start timelapse</button>
      <button className="reload-button" type="button" onClick={() => { void command(false); }} disabled={!snapshot || busy || !running}>Stop timelapse</button>
    </form>
    {error && <p className="inline-error" role="alert">{error}</p>}
    {notice && <p className="submission-success" role="status">{notice}</p>}
  </section>;
}
