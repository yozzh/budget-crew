import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const apiPort = process.env.PORT ?? "3000";
const centrifugoPort = process.env.CENTRIFUGO_PORT ?? "8000";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": `http://127.0.0.1:${apiPort}`,
      "/connection": { target: `http://127.0.0.1:${centrifugoPort}`, ws: true },
    },
  },
});
