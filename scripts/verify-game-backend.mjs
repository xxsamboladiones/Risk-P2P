// Teste HTTP isolado do backend. Só envia snapshots vazios ou inválidos:
// nenhuma tecla, movimento ou botão é injetado no sistema operacional.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import assert from "node:assert/strict";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.join(root, ".risk/game-backend-smoke");
mkdirSync(output, { recursive: true });
const token = randomBytes(32).toString("hex");
const executable = path.join(root, "desktop-backend/target/debug", process.platform === "win32" ? "risk-desktop-backend.exe" : "risk-desktop-backend");
const backend = spawn(executable, [], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: {
  ...process.env, RISK_LOCAL_TOKEN: token, RISK_DATA_DIR: path.join(output, `data-${process.pid}`), RISK_BACKEND_BIND: "127.0.0.1:0",
} });
let accessToken;
const timeout = setTimeout(() => backend.kill(), 20000);
const exited = new Promise((resolve) => backend.once("exit", resolve));
try {
  const url = await new Promise((resolve, reject) => {
    let text = "";
    backend.stdout.on("data", (chunk) => {
      text += chunk;
      const match = text.match(/RISK_BACKEND_READY (.+)\r?\n/);
      if (match) resolve(JSON.parse(match[1]).url);
    });
    backend.once("error", reject);
    backend.once("exit", () => reject(new Error("Backend encerrou antes de iniciar")));
  });
  async function request(resource, body, local = true) {
    const response = await fetch(`${url}${resource}`, { method: body === undefined ? "GET" : "POST", headers: {
      "content-type": "application/json", ...(local ? { "x-risk-desktop-token": token } : {}),
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
    }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(3000) });
    return { status: response.status, body: await response.json().catch(() => null) };
  }
  assert.equal((await request("/game/capabilities", undefined, false)).status, 401);
  assert.equal((await request("/game/capabilities")).status, 401);
  const registered = await request("/auth/register", { displayName: "Teste local", email: "game-test@example.test", password: randomBytes(24).toString("hex") });
  assert.equal(registered.status, 200); accessToken = registered.body.accessToken;
  const caps = await request("/game/capabilities"); assert.equal(caps.status, 200);
  if (process.platform !== "win32") throw new Error("Este smoke não cria dispositivos uinput; execute no Windows para verificar snapshots vazios.");
  const sessionId = "smoke-session", grantId = "smoke-grant", peerId = "smoke-peer";
  const command = (op, extra = {}) => request("/game/command", { op, sessionId, ...extra });
  assert.equal((await command("start")).status, 200);
  assert.equal((await command("join", { peerId, grantId, device: "keyboard-mouse" })).status, 200);
  assert.equal((await command("join", { peerId: "second", grantId: "second", device: "keyboard-mouse" })).status, 400);
  const frame = { version: 1, sessionId, grantId, sequence: 0, keys: [], buttons: 0, x: 0, y: 0, wheel: 0 };
  assert.equal((await request("/game/input", { peerId, frame })).status, 200);
  assert.equal((await request("/game/input", { peerId, frame: { ...frame, keys: ["UNSUPPORTED"] } })).status, 400);
  assert.equal((await request("/game/input", { peerId: "stranger", frame })).status, 400);
  assert.equal((await command("revoke", { peerId, grantId })).status, 200);
  assert.equal((await request("/game/input", { peerId, frame })).status, 400);
  assert.equal((await request("/game/emergency-stop", {})).status, 200);
  assert.equal((await command("heartbeat")).status, 400);
  writeFileSync(path.join(output, "report.json"), JSON.stringify({ passed: true, capabilities: caps.body, checks: ["local-token", "user-auth", "single-keyboard-owner", "empty-snapshot", "invalid-input", "unknown-peer", "revocation", "emergency-stop"], injectedInputs: 0 }, null, 2));
  console.log("Backend de jogo: autorização, concessões e encerramento verificados; nenhum input nativo aplicado.");
} catch (error) {
  writeFileSync(path.join(output, "report.json"), JSON.stringify({ passed: false, error: String(error) }, null, 2));
  console.error(String(error)); process.exitCode = 1;
} finally {
  backend.stdin.end(); await exited; clearTimeout(timeout);
}
