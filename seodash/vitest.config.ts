import { defineConfig } from "vitest/config";

// The marketplace package has its own test run (against the sandbox host).
export default defineConfig({ test: { include: ["test/**/*.test.ts"] } });
