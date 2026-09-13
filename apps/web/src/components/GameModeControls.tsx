import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { Gamepad2, X } from "lucide-react";
import { createPortal } from "react-dom";
import type { GameDevice } from "@risk/protocol";
import type { GameModeController } from "../call/game/GameModeController";
import { captureGameInput } from "../call/game/capture";
import "./game-mode.css";

export function GameTileControls({ game, peerId, target, visible }: { game: GameModeController; peerId: string; target: RefObject<HTMLElement | null>; visible: boolean }) {
  const state = useSyncExternalStore(game.subscribe, game.getSnapshot);
  const [device, setDevice] = useState<GameDevice>("keyboard-mouse");
  const [error, setError] = useState<string>();
  const [keyboardPaused, setKeyboardPaused] = useState(false);
  const offer = state.offers[peerId];
  const playing = state.playing?.peerId === peerId ? state.playing : undefined;
  const pending = state.pending === peerId;
  const sessionId = playing?.sessionId, grantId = playing?.grantId, playingDevice = playing?.device;
  const switching = useRef(false);
  const toggleDevice = useCallback(async () => {
    const current = game.getSnapshot();
    const player = current.playing;
    if (!player || player.peerId !== peerId || current.pending || switching.current) return;
    if (!current.offers[peerId]?.gamepad) { setError(current.offers[peerId]?.reason ?? "Controle indisponível neste anfitrião."); return; }
    const next = player.device === "gamepad" ? "keyboard-mouse" : "gamepad";
    if (next === "gamepad" && ![...(navigator.getGamepads?.() ?? [])].some((pad) => pad?.connected && pad.mapping === "standard")) {
      setError("Conecte um controle e pressione um botão antes de alternar."); return;
    }
    switching.current = true; setError(undefined);
    try {
      if (next === "keyboard-mouse") {
        const element = target.current;
        if (!element) return;
        // Request synchronously from the F8/click event, while user activation is valid.
        await element.requestPointerLock();
        if (document.pointerLockElement !== element) throw new Error("Não foi possível capturar o mouse.");
      }
      if (game.getSnapshot().playing?.grantId !== player.grantId) {
        if (next === "keyboard-mouse" && document.pointerLockElement === target.current && game.getSnapshot().playing?.device !== "keyboard-mouse") document.exitPointerLock();
        return;
      }
      game.switchDevice(next);
    } catch (e) { setError(e instanceof Error ? e.message : "Não foi possível trocar o dispositivo."); }
    finally { switching.current = false; }
  }, [game, peerId, target]);
  useEffect(() => {
    setKeyboardPaused(false);
    if (!sessionId || !grantId || !playingDevice || !target.current) return;
    if (!visible) { game.leave(); return; }
    const element = target.current;
    element.dispatchEvent(new Event("risk-show-overlays"));
    return captureGameInput(element, { sessionId, grantId, device: playingDevice }, (frame) => game.sendInput(frame), () => game.leave(), (paused) => {
      setKeyboardPaused(paused);
      element.dispatchEvent(new Event("risk-show-overlays"));
    }, () => void toggleDevice(), () => game.getSnapshot().playing?.device === "keyboard-mouse" && game.getSnapshot().playing?.peerId === peerId && game.getSnapshot().playing?.grantId !== grantId);
  }, [game, sessionId, grantId, playingDevice, target, visible, toggleDevice, peerId]);
  useEffect(() => {
    if (playing?.device === "gamepad" && !pending && document.pointerLockElement === target.current) document.exitPointerLock();
  }, [playing, pending, target]);
  useEffect(() => {
    if (!playing && !pending && document.pointerLockElement === target.current) document.exitPointerLock();
  }, [playing, pending, target]);
  useEffect(() => () => { if (game.getSnapshot().playing?.peerId === peerId || game.getSnapshot().pending === peerId) game.leave(); }, [game, peerId]);
  if (!offer || !visible) return null;
  const resume = async () => {
    setError(undefined);
    try {
      await target.current?.requestPointerLock();
      if (document.pointerLockElement !== target.current) throw new Error("Não foi possível capturar o mouse. Clique em Continuar para tentar novamente.");
    } catch (e) { setError(e instanceof Error ? e.message : "Não foi possível retomar o jogo."); }
  };
  const join = async () => {
    setError(undefined);
    try {
      const selectedDevice = offer.gamepad ? device : "keyboard-mouse";
      if (selectedDevice === "keyboard-mouse") {
        if (!target.current) return;
        await target.current.requestPointerLock();
        if (document.pointerLockElement !== target.current) throw new Error("Não foi possível capturar o mouse.");
      }
      game.join(peerId, selectedDevice);
    } catch (e) { setError(e instanceof Error ? e.message : "Não foi possível entrar no jogo."); }
  };
  return <div className="game-tile-controls" onClick={(e) => e.stopPropagation()}>
    {!playing && !pending && offer.gamepad && <select aria-label="Como jogar" value={device} onChange={(e) => setDevice(e.target.value as GameDevice)}>
      <option value="keyboard-mouse">Teclado e mouse</option><option value="gamepad">Controle</option>
    </select>}
    {playing && keyboardPaused && <button className="playing" onClick={() => void resume()}><Gamepad2 size={18}/>Continuar com teclado e mouse</button>}
    {playing && <button disabled={pending || !offer.gamepad} title={offer.gamepad ? "F8 alterna o dispositivo" : offer.reason ?? "Controle indisponível neste anfitrião"} onClick={() => void toggleDevice()}>{pending ? "Alternando…" : playing.device === "gamepad" ? "Controle → Teclado e mouse (F8)" : "Teclado e mouse → Controle (F8)"}</button>}
    <button className={playing ? "playing" : ""} onClick={() => playing || pending ? game.leave() : void join()}>
      <Gamepad2 size={18}/>{playing ? "Sair do Modo Jogo" : pending ? "Entrando…" : "Jogar Junto"}{playing && <X size={14}/>}
    </button>
    {playing && <small className="game-escape-hint">Ativo: {playing.device === "gamepad" ? "controle" : "teclado e mouse"} · {offer.gamepad ? "F8 alterna · " : `${offer.reason ?? "Controle indisponível neste anfitrião"} · `}Esc mostra controles · Esc duas vezes em 2 s sai do Modo Jogo</small>}
    {(error || state.error) && <small role="status">{error ?? state.error}</small>}
  </div>;
}

export function GameHostControls({ game, sharing, names }: { game: GameModeController; sharing: boolean; names: Record<string, string> }) {
  const state = useSyncExternalStore(game.subscribe, game.getSnapshot);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const toggle = async () => {
    setBusy(true); setError(undefined);
    try { if (state.host) await game.stop(); else await game.start(); }
    catch (e) { setError(e instanceof Error ? e.message : "Não foi possível ativar Modo Jogo."); }
    finally { setBusy(false); }
  };
  return <div className="game-host-control">
    <button disabled={!sharing || busy} className={state.host ? "active" : ""} aria-pressed={Boolean(state.host)}
      title="Permitir que participantes da chamada controlem seu computador enquanto você compartilha a tela" onClick={() => void toggle()}><Gamepad2/><span>Modo Jogo</span></button>
    {(state.host || error || state.error) && createPortal(<div className="game-host-panel">
      {state.host && <><strong>Modo Jogo ativo · {state.quality === "720p60" ? "720p" : "1080p"} / 60 FPS</strong>
        <small>Participantes podem entrar automaticamente. Teclado e mouse controlam o computador em foco.</small>
        <small>Parada rápida: Ctrl + Alt + Shift + F12</small>
        {!state.host.players.length && <span>Aguardando jogadores…</span>}
        {state.host.players.map((player) => <div key={player.grantId}><span>{names[player.peerId] ?? "Participante"} · {player.device === "gamepad" ? `Controle ${player.slot}` : "Teclado e mouse"}</span><button onClick={() => void game.revoke(player.peerId)}>Revogar</button></div>)}</>}
      {(error || state.error) && <small role="alert">{error ?? state.error}</small>}
    </div>, document.body)}
  </div>;
}
