import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { HealthResponse } from "@budget-crew/shared";

function App() {
  const [health, setHealth] = useState<HealthResponse | "down" | null>(null);

  useEffect(() => {
    fetch("/api/health")
      .then((r): Promise<HealthResponse | "down"> => (r.ok ? r.json() : Promise.resolve("down")))
      .then(setHealth, () => setHealth("down"));
  }, []);

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: 24 }}>
      <h1>Daily Budget Crew</h1>
      <p>
        API:{" "}
        {health === null ? "checking…" : health === "down" ? "unavailable" : `${health.status}, version ${health.version}, inference ${health.inference}`}
      </p>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
