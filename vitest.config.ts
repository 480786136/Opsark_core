import { defineConfig } from "vitest/config";
import vue from "@vitejs/plugin-vue";
import { fileURLToPath, URL } from "node:url";
import { probeSourcePlugin } from "./build/probeSourcePlugin";

export default defineConfig({
  plugins: [probeSourcePlugin(), vue()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "happy-dom",
    clearMocks: true,
  },
});
