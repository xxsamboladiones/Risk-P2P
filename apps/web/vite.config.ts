import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const envDir = fileURLToPath(new URL("../../", import.meta.url));
const devBackendBridgeFile = fileURLToPath(new URL("../../.risk/dev-backend.json", import.meta.url));
const DEV_API_PREFIX = "/__risk-api";

type DevBackendBridge = {
  baseUrl: string;
  token: string;
};

function isLoopback(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

async function readDevBackendBridge(): Promise<DevBackendBridge> {
  const value = JSON.parse(await readFile(devBackendBridgeFile, "utf8")) as Partial<DevBackendBridge>;
  if (typeof value.baseUrl !== "string" || typeof value.token !== "string" || value.token.length < 32) {
    throw new Error("Configuração temporária do backend desktop inválida.");
  }
  const url = new URL(value.baseUrl);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") {
    throw new Error("O backend de desenvolvimento precisa estar no loopback.");
  }
  return { baseUrl: value.baseUrl.replace(/\/$/, ""), token: value.token };
}

function sendJson(response: import("node:http").ServerResponse, status: number, body: object): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  response.end(payload);
}

function devBackendProxy(): Plugin {
  return {
    name: "risk-dev-backend-proxy",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const requestUrl = request.url ?? "";
        if (!(requestUrl === DEV_API_PREFIX || requestUrl.startsWith(`${DEV_API_PREFIX}/`) || requestUrl.startsWith(`${DEV_API_PREFIX}?`))) {
          next();
          return;
        }

        // O Vite fica exposto em 0.0.0.0 para testes de UI, mas o proxy autenticado
        // nunca deve transformar a máquina do desenvolvedor em uma ponte de LAN para o sidecar.
        if (!isLoopback(request.socket.remoteAddress)) {
          sendJson(response, 403, { message: "O proxy do backend desktop só está disponível no localhost." });
          return;
        }

        void (async () => {
          let bridge: DevBackendBridge;
          try {
            bridge = await readDevBackendBridge();
          } catch {
            sendJson(response, 503, {
              message: "Backend desktop ainda não está disponível. Inicie com `pnpm dev:desktop` e aguarde o readiness.",
            });
            return;
          }

          const suffix = requestUrl.slice(DEV_API_PREFIX.length) || "/";
          const target = new URL(suffix.startsWith("/") ? suffix : `/${suffix}`, `${bridge.baseUrl}/`);
          const headers = { ...request.headers };
          delete headers.host;
          delete headers.origin;
          delete headers.referer;
          delete headers.cookie;
          delete headers["x-risk-desktop-token"];
          headers.host = target.host;
          headers["x-risk-desktop-token"] = bridge.token;

          const upstream = http.request(target, {
            method: request.method,
            headers,
          }, (upstreamResponse) => {
            response.statusCode = upstreamResponse.statusCode ?? 502;
            for (const [name, value] of Object.entries(upstreamResponse.headers)) {
              if (value !== undefined) response.setHeader(name, value);
            }
            upstreamResponse.pipe(response);
          });

          upstream.on("error", () => {
            if (!response.headersSent) {
              sendJson(response, 502, { message: "Não foi possível alcançar o backend desktop local." });
            } else {
              response.destroy();
            }
          });
          request.on("aborted", () => upstream.destroy());
          request.pipe(upstream);
        })().catch(() => {
          if (!response.headersSent) sendJson(response, 500, { message: "Falha no proxy local de desenvolvimento." });
          else response.destroy();
        });
      });
    },
  };
}

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, envDir, "");
  if (command === "serve" && !env.VITE_API_URL?.trim() && !process.env.VITE_API_URL?.trim()) {
    // No navegador de desenvolvimento, a API é acessada pelo próprio Vite. O proxy
    // injeta o token efêmero sem expô-lo ao JavaScript da página.
    process.env.VITE_API_URL = DEV_API_PREFIX;
  }

  return {
    base: "./",
    envDir,
    plugins: [react(), devBackendProxy()],
    server: { port: 5173 },
  };
});
