import { defineConfig, mergeConfig } from "vitest/config";
import base from "../vitest.config.js";

// Live model evaluation only; `pnpm test` keeps its default *.test.ts include and never reaches here.
export default mergeConfig(base, defineConfig({ test: { include: ["src/eval/**/*.eval.ts"], reporters: ["default"] } }));
