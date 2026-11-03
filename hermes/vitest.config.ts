import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Actions on one agent are serialized server-side (409 wallet_busy on
    // concurrent submissions) — never run the e2e files in parallel.
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 300_000,
  },
});
