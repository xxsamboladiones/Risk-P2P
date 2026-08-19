import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  base: "./",
  envDir: fileURLToPath(new URL("../../", import.meta.url)),
  plugins: [react()],
  server: { port: 5173 },
});
