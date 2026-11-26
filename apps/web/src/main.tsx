import { StrictMode, useEffect, useRef, useState, type MouseEvent } from "react";
import { createRoot } from "react-dom/client";
import type { RequestState } from "@budget-crew/shared";
import { App } from "./App.js";
import { LandingPage } from "./LandingPage.js";
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

function Router() {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const onPopState = () => setPath(location.pathname);
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);
  useEffect(() => {
    document.title = path === "/app" ? "Budget Crew · Live demo" : "Budget Crew · Your daily budget, a team effort";
  }, [path]);
  function navigate(event: MouseEvent<HTMLDivElement>) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = event.target instanceof Element ? event.target.closest("a") : null;
    if (!link || link.target || link.hasAttribute("download")) return;
    const url = new URL(link.href);
    if (url.origin !== location.origin || url.hash || !["/", "/app"].includes(url.pathname)) return;
    event.preventDefault();
    history.pushState(null, "", url);
    setPath(url.pathname);
    window.scrollTo(0, 0);
  }
  return <div onClick={navigate}>{path === "/app" ? <ConnectedApp /> : <LandingPage />}</div>;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Router />
  </StrictMode>,
);
