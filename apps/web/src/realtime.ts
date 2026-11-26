import { Centrifuge } from "centrifuge";
import { ActivityEnvelope, StateEnvelope, StateResponse } from "@budget-crew/shared";
import { SnapshotSync, type ViewModel } from "./model.js";

export interface RealtimeConnection {
  reload(): void;
  dispose(): void;
}

export function connectRealtime(get: () => ViewModel, set: (model: ViewModel) => void) {
  const sync = new SnapshotSync(async () => {
    const response = await fetch("/api/state", { cache: "no-store" });
    if (!response.ok) throw new Error(`Snapshot unavailable (${response.status})`);
    return StateResponse.parse(await response.json());
  }, get, set);
  const url = new URL("/connection/websocket", location.href);
  url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const client = new Centrifuge(url.href);
  const subscribed = new Set<string>();
  for (const channel of ["crew:state", "crew:activity"]) {
    const subscription = client.newSubscription(channel, { positioned: true, recoverable: true });
    subscription.on("publication", ({ data }) => {
      const result = (channel === "crew:state" ? StateEnvelope : ActivityEnvelope).safeParse(data);
      if (result.success) sync.receive(result.data);
      else set({ ...get(), error: "Unrecognized realtime event. Reload to synchronize." });
    });
    subscription.on("subscribing", () => {
      subscribed.delete(channel);
      set({ ...get(), status: "Reconnecting" });
    });
    subscription.on("subscribed", (context) => {
      subscribed.add(channel);
      if (subscribed.size === 2) {
        set({ ...get(), status: "Live" });
        // The API has no stream cursor. Subscribe first, then fetch and buffer
        // publications to close the initial snapshot / subscription gap.
        void sync.reload();
      } else if (context.wasRecovering && !context.recovered) void sync.reload();
    });
    subscription.on("error", () => set({ ...get(), error: "Realtime subscription unavailable" }));
    subscription.subscribe();
  }
  client.on("disconnected", () => set({ ...get(), status: "Disconnected" }));
  client.on("connecting", () => set({ ...get(), status: "Connecting" }));
  client.connect();
  void sync.reload();
  return {
    reload: () => { void sync.reload(); },
    dispose: () => { sync.dispose(); client.disconnect(); client.removeAllListeners(); },
  };
}
