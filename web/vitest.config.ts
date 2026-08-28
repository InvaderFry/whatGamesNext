import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["src/test-setup.ts"],
    /**
     * Vitest defaults to roughly one worker per core, and these tests wait on
     * real elapsed time — the 300ms search debounce, for one. On a many-core
     * machine that many jsdom workers starve each other badly enough that a
     * test doing 80ms of work blows the 5s timeout, so `npm test` fails five
     * random tests that all pass when run alone. Two workers is enough
     * parallelism for eight files and leaves the wait times meaning what they
     * say.
     */
    maxWorkers: 2,
  },
});
