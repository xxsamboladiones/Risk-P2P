import { readFile } from "node:fs/promises";

const tag = (process.env.GITHUB_REF_NAME ?? process.argv[2] ?? "").replace(/^v/, "");
const desktop = JSON.parse(await readFile(new URL("../apps/desktop/package.json", import.meta.url), "utf8"));
if (!tag || tag !== desktop.version) {
  console.error(`A tag (${tag || "ausente"}) precisa corresponder à versão desktop (${desktop.version}).`);
  process.exit(1);
}
console.log(`Versão de release validada: ${desktop.version}`);
