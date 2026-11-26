import type { RequestState, StateResponse } from "@budget-crew/shared";

/** Missing metadata is seeded live history; never infer mode from answer text. */
export function InferenceLabel({ request }: { request?: RequestState }) {
  if (request?.inference?.mode !== "stub") return null;
  const text = request.inference.reason === "limit"
    ? "Offline answer · live limit reached, try again later"
    : request.inference.reason === "replay" ? "Replay · offline answers" : "Offline answer";
  return <span className="inference-label">{text}</span>;
}

export function ReplayNote({ snapshot }: { snapshot: StateResponse | null }) {
  if (!snapshot?.simulation.running || !Object.values(snapshot.requests).some((request) => request.inference?.mode === "stub" && request.inference.reason === "replay")) return null;
  return <p className="inference-label replay-note">Replay uses offline answers; ask your own question for live advisers.</p>;
}
