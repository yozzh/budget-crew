import { afterEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { StateResponse, type RequestState } from "@budget-crew/shared";
import { App } from "./App.js";
import { BasicView } from "./BasicView.js";
import { ReplayNote } from "./InferenceLabel.js";
import { acceptRequest, initialModel, SnapshotSync, type ViewModel } from "./model.js";

const request: RequestState = { kind: "purchase", input: "Can I buy a jacket?", createdAt: "2026-11-26T12:00:00Z", verdicts: {}, judgement: { decision: "wait", why: "Keep a buffer.", figures: [] } };
const snapshot = StateResponse.parse({
  profile: { name: "Demo", currency: "EUR", payday: 1, recurringArticles: [] },
  today: "2026-11-26", periods: [], simulation: { running: true, speed: 4 },
  requests: {
    live: { ...request, inference: { mode: "live" } },
    limit: { ...request, inference: { mode: "stub", reason: "limit" } },
    replay: { ...request, inference: { mode: "stub", reason: "replay" } },
    legacy: request,
  },
});
const labels = { limit: "Offline answer · live limit reached, try again later", replay: "Replay · offline answers" };
const noop = () => {};
afterEach(() => vi.unstubAllGlobals());

it.each(Object.keys(snapshot.requests))("Basic labels only the selected offline answer: %s", (id) => {
  const html = renderToStaticMarkup(<BasicView model={{ ...initialModel, snapshot }} selectedId={id} onAccepted={noop} onSelect={noop} onPro={noop} onReload={noop} />);
  const answer = html.match(/<article[^>]*aria-label="Latest crew answer"[\s\S]*?<\/article>/)![0];
  expect(answer.includes(labels.limit)).toBe(id === "limit");
  expect(answer.includes(labels.replay)).toBe(id === "replay");
});

it("Pro labels each offline request in both its row and its details, not live or legacy requests", () => {
  vi.stubGlobal("location", new URL("http://localhost/?mode=pro"));
  const html = renderToStaticMarkup(<App model={{ ...initialModel, snapshot }} onAccepted={noop} onReload={noop} />);
  for (const id of Object.keys(snapshot.requests)) {
    const card = html.match(new RegExp(`<details[^>]*aria-label="Can I buy\\? request ${id}"[\\s\\S]*?<\\/details>`))![0];
    for (const [reason, label] of Object.entries(labels)) expect(card.split(label).length - 1).toBe(id === reason ? 2 : 0);
  }
});

it("shows the replay explanation only while an offline replay is running", () => {
  expect(renderToStaticMarkup(<ReplayNote snapshot={snapshot} />)).toContain("Replay uses offline answers; ask your own question for live advisers.");
  expect(renderToStaticMarkup(<ReplayNote snapshot={{ ...snapshot, simulation: { running: false, speed: 4 } }} />)).toBe("");
  expect(renderToStaticMarkup(<ReplayNote snapshot={{ ...snapshot, requests: { live: snapshot.requests.live! } }} />)).toBe("");
  expect(renderToStaticMarkup(<ReplayNote snapshot={null} />)).toBe("");
});

it("preserves inference through HTTP snapshot reload, buffered realtime advice, and optimistic acceptance", async () => {
  let model: ViewModel = { ...initialModel };
  const sync = new SnapshotSync(async () => snapshot, () => model, (next) => { model = next; });
  const loading = sync.reload();
  sync.receive({ v: 1, at: request.createdAt, type: "purchase.judged", data: { requestId: "replay", judgement: { decision: "skip", why: "Protect essentials.", figures: [] } } });
  await loading;
  model = acceptRequest(model, "replay", request);
  expect(model.snapshot!.requests.replay!.inference).toEqual({ mode: "stub", reason: "replay" });
  expect(model.snapshot!.requests.replay!.judgement!.decision).toBe("skip");
  expect(renderToStaticMarkup(<BasicView model={model} selectedId="replay" onAccepted={noop} onSelect={noop} onPro={noop} onReload={noop} />)).toContain(labels.replay);
  sync.dispose();
});
