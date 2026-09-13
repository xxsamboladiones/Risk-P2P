// Execute com Node antes de verify-late-join-screen.cjs; nesse teste, defina
// RISK_VERIFY_SCREEN_UI=1 para verificar os pixels no componente real da chamada.
import { build } from "../apps/web/node_modules/vite/dist/node/index.js";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
await build({
  configFile: false,
  root: path.join(root, "apps/web"),
  logLevel: "error",
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  esbuild: { jsx: "automatic" },
  resolve: { alias: {
    react: path.join(root, "apps/web/node_modules/react"),
    "react-dom": path.join(root, "apps/web/node_modules/react-dom"),
  } },
  plugins: [{
    name: "expose-call-tile-for-verification",
    transform(code, id) {
      if (id.replaceAll("\\", "/").endsWith("/components/CallWorkspace.tsx")) return `${code}\nexport { VideoTile };`;
    },
  }],
  build: {
    outDir: path.join(root, ".risk/late-join-screen"), emptyOutDir: false,
    lib: { entry: path.join(root, "scripts/verify-late-join-screen-ui.tsx"), name: "ScreenUI", formats: ["iife"], fileName: () => "ui.js" },
  },
});
