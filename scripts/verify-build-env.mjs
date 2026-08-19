import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const values = { ...process.env };
try {
  const contents = readFileSync(resolve(process.cwd(), ".env"), "utf8");
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || match[1].startsWith("#")) continue;
    const raw = match[2].trim();
    values[match[1]] ??= raw.replace(/^(['"])(.*)\1$/, "$2");
  }
} catch {
  // Variáveis podem ter sido fornecidas pelo ambiente do CI.
}

const required = ["VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY"];
const missing = required.filter((name) => !values[name]?.trim());
if (missing.length) {
  console.error(`Build interrompido: configure ${missing.join(", ")} no .env ou no ambiente.`);
  process.exit(1);
}

for (const name of ["VITE_API_URL", "VITE_SUPABASE_URL"]) {
  if (!values[name]?.trim()) continue;
  try { new URL(values[name]); }
  catch {
    console.error(`Build interrompido: ${name} precisa ser uma URL válida.`);
    process.exit(1);
  }
}

if (values.VITE_ICE_SERVERS_JSON?.trim()) {
  try {
    const servers = JSON.parse(values.VITE_ICE_SERVERS_JSON);
    if (!Array.isArray(servers) || servers.length === 0) throw new Error("array vazio");
  } catch {
    console.error("Build interrompido: VITE_ICE_SERVERS_JSON precisa conter um array JSON válido de servidores ICE.");
    process.exit(1);
  }
}

console.log(`Variáveis públicas do build validadas. Modo: ${values.VITE_API_URL?.trim() ? "híbrido (API + P2P)" : "P2P local"}.`);
