import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Tests run before build in CI; resolve workspace packages from source, as the API tests do.
export default defineConfig({
  resolve: { alias: {
    "@budget-crew/budget": fileURLToPath(new URL("../../packages/budget/src/index.ts", import.meta.url)),
    "@budget-crew/shared": fileURLToPath(new URL("../../packages/shared/src/index.ts", import.meta.url)),
  } },
});
