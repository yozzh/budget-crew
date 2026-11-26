import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { RequestState } from "@budget-crew/shared";
import { App } from "./App.js";
import { acceptRequest, initialModel } from "./model.js";
import { connectRealtime, type RealtimeConnection } from "./realtime.js";
import "./style.css";

function ConnectedApp() {
  const [model, setModel] = useState(initialModel);
  const current = useRef(model);
  const connection = useRef<RealtimeConnection | null>(null);
  useEffect(() => {
    connection.current = connectRealtime(() => current.current, (next) => {
      current.current = next;
      setModel(next);
    });
    return () => { connection.current?.dispose(); connection.current = null; };
  }, []);
  function onAccepted(id: string, request: RequestState) {
    const next = acceptRequest(current.current, id, request);
    current.current = next;
    setModel(next);
  }
  return <App model={model} onAccepted={onAccepted} onReload={() => connection.current?.reload()} />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ConnectedApp />
  </StrictMode>,
);
