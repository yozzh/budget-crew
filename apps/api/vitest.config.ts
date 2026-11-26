import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: {
    "@budget-crew/budget": fileURLToPath(new URL("../../packages/budget/src/index.ts", import.meta.url)),
    "@budget-crew/shared": fileURLToPath(new URL("../../packages/shared/src/index.ts", import.meta.url)),
  } },
});
