import React, { useEffect, useRef, useState } from "react";
import { Check, Clipboard, Link2, X } from "lucide-react";
import { api } from "../api";
import { normalizeRiskInviteCode, type InviteType } from "../services/invites/code";
import { FriendInviteService, GroupInviteService, type IncomingInviteRequest, type InviteSnapshot, type InviteService } from "../services/invites/service";
import { getOrCreateLocalIdentity, type PublicGroupMetadata } from "../services/offline/social-storage";

export function P2PInvitePanel({ type, token, displayName, group, initialMode = "create", onComplete }: {
  type: InviteType; token: string; displayName: string; group?: PublicGroupMetadata; initialMode?: "create" | "join"; onComplete?(): void;
}) {
  const [mode, setMode] = useState<"create" | "join">(initialMode);
  const [code, setCode] = useState(""); const [state, setState] = useState<InviteSnapshot>();
  const [request, setRequest] = useState<IncomingInviteRequest>(); const [error, setError] = useState("");
  const [copied, setCopied] = useState(false); const [now, setNow] = useState(Date.now());
  const service = useRef<InviteService | undefined>(undefined);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1_000); return () => { window.clearInterval(timer); void service.current?.cancel(false); }; }, []);
  useEffect(() => { if (state?.status === "accepted") onComplete?.(); }, [state?.status, onComplete]);

  async function getService(): Promise<InviteService> {
    await service.current?.cancel(false);
    const [identity, turn] = await Promise.all([getOrCreateLocalIdentity(displayName), api.turnCredentials(token)]);
    const next = type === "friend" ? new FriendInviteService(identity, turn.iceServers) : new GroupInviteService(identity, turn.iceServers);
    next.onState(setState); next.onRequest(setRequest); service.current = next; return next;
  }
  async function create() { setError(""); setRequest(undefined); try { const next = await getService(); if (type === "friend") await next.createInvite("friend"); else await next.createInvite("group", group); } catch (cause) { setError(friendly(cause)); } }
  async function join(event: React.FormEvent) { event.preventDefault(); setError(""); setRequest(undefined); try { const next = await getService(); await next.joinInvite(type, code); } catch (cause) { setError(friendly(cause)); } }
  async function decide(accept: boolean) { setError(""); try { if (accept) await service.current?.accept(); else await service.current?.reject(); } catch (cause) { setError(friendly(cause)); } }
  async function cancel() { await service.current?.cancel(); setRequest(undefined); }
  async function copy() {
    if (!state) return;
    setError("");
    try {
      await copyText(state.code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      setError("Não foi possível copiar o código automaticamente. Selecione o código acima e use Ctrl+C.");
    }
  }
  const remaining = Math.max(0, Math.ceil(((state?.expiresAt ?? now) - now) / 1000));

  const canCreate = type === "friend" || Boolean(group);
  const terminal = state && ["accepted", "rejected", "expired", "cancelled", "error"].includes(state.status);
  return <div className="p2p-invite">
    <div className="invite-tabs"><button disabled={!canCreate} className={mode === "create" ? "active" : ""} onClick={() => setMode("create")}>Criar convite</button><button className={mode === "join" ? "active" : ""} onClick={() => setMode("join")}>Usar código</button></div>
    {!state && mode === "create" && <div className="invite-start"><Link2/><p>{type === "friend" ? "Crie um código temporário para outra pessoa adicionar você." : group ? `Crie um código temporário para entrar em ${group.name}.` : "Selecione primeiro o grupo que receberá o novo membro."}</p><button disabled={!canCreate} onClick={() => void create()}>Criar convite P2P</button></div>}
    {!state && mode === "join" && <form className="invite-code-form" onSubmit={(event) => void join(event)}><label>Código de convite</label><input value={code} onChange={(event) => setCode(event.target.value)} onBlur={() => setCode((current) => normalizeRiskInviteCode(current))} placeholder="risk-____-____-____-____" autoComplete="off" maxLength={256}/><button>Conectar por WebRTC</button></form>}
    {state && <div className={`invite-progress ${state.status}`}>
      {state.role === "creator" && <><small>Compartilhe somente este código</small><strong className="invite-code">{state.code}</strong><button className="copy-code" onClick={() => void copy()}>{copied ? <Check/> : <Clipboard/>}{copied ? "Código copiado!" : "Copiar código"}</button><span>Expira em {Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, "0")}</span></>}
      <p>{state.message}</p>
      {request && state.status === "approval" && <div className="incoming-request"><div className="avatar">{request.identity.displayName[0]?.toUpperCase()}</div><div><strong>{request.identity.displayName}</strong><small>{type === "friend" ? "quer adicionar você" : `quer entrar em ${group?.name ?? "seu grupo"}`}</small></div><button className="reject" onClick={() => void decide(false)}><X/>Recusar</button><button onClick={() => void decide(true)}><Check/>Aceitar</button></div>}
      {!terminal && <button className="cancel-invite" onClick={() => void cancel()}>Cancelar convite</button>}
      {terminal && <button onClick={() => { setState(undefined); setRequest(undefined); setError(""); }}>Novo convite</button>}
    </div>}
    {error && <div className="invite-notice error">{error}</div>}
    <small className="privacy-note">O Supabase só ajuda os peers a se encontrarem. A solicitação e os dados sociais passam pelo WebRTC e ficam neste dispositivo.</small>
  </div>;
}

async function copyText(value: string): Promise<void> {
  // `navigator.clipboard` pode ser negado no Electron sandboxado e em alguns
  // navegadores mesmo durante um clique. O caminho legado é síncrono e preserva
  // a ativação do usuário, então tentamos primeiro e removemos o elemento logo após.
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  textarea.setSelectionRange(0, value.length);
  let copiedWithDom = false;
  try {
    copiedWithDom = document.execCommand("copy");
  } catch {
    copiedWithDom = false;
  } finally {
    textarea.remove();
  }
  if (copiedWithDom) return;

  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  throw new Error("Clipboard indisponível.");
}

function friendly(cause: unknown): string { return cause instanceof Error ? cause.message : "Não foi possível concluir o convite."; }
