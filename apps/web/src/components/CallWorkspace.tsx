import { useEffect, useMemo, useRef, useState, type FormEvent, type RefObject } from "react";
import {
  Hash,
  Maximize2,
  MessageCircle,
  Mic,
  MicOff,
  MonitorUp,
  PhoneOff,
  Settings2,
  Sparkles,
  Video,
  VideoOff,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import type { ChatMessage } from "../api";
import { api } from "../api";
import type { CallController } from "../call";
import type {
  ChatAttachmentProgress,
  ChatAttachmentRecord,
  ChatConnectionStatus,
  ChatController,
} from "../chat";
import { loadLocalGroups } from "../services/offline/social-storage";
import { useCallStore, type CallContext, type Participant } from "../store";
import { ConversationTimeline } from "./ConversationTimeline";
import { InCallAudioSettings } from "./InCallAudioSettings";
import { MessageComposer } from "./MessageComposer";
import "./call-workspace.css";

type ViewMode = "call" | "chat";
type ScreenQuality = "720p30" | "720p60" | "1080p30" | "1080p60";

type QualityProfile = {
  label: string;
  width: number;
  height: number;
  fps: number;
};

const SCREEN_QUALITY_KEY = "risk.screenShareQuality";
const QUALITY_PROFILES: Record<ScreenQuality, QualityProfile> = {
  "720p30": { label: "720p · 30 FPS", width: 1280, height: 720, fps: 30 },
  "720p60": { label: "720p · 60 FPS", width: 1280, height: 720, fps: 60 },
  "1080p30": { label: "1080p · 30 FPS", width: 1920, height: 1080, fps: 30 },
  "1080p60": { label: "1080p · 60 FPS", width: 1920, height: 1080, fps: 60 },
};

function isScreenQuality(value: string | null): value is ScreenQuality {
  return Boolean(value && value in QUALITY_PROFILES);
}

function initialScreenQuality(): ScreenQuality {
  const saved = localStorage.getItem(SCREEN_QUALITY_KEY);
  return isScreenQuality(saved) ? saved : "1080p30";
}

async function applyScreenQuality(stream: MediaStream | null, quality: ScreenQuality): Promise<void> {
  const track = stream?.getVideoTracks()[0];
  if (!track) return;
  const profile = QUALITY_PROFILES[quality];
  try { track.contentHint = "detail"; } catch { /* contentHint é opcional */ }
  try {
    await track.applyConstraints({
      width: { ideal: profile.width, max: profile.width },
      height: { ideal: profile.height, max: profile.height },
      frameRate: { ideal: profile.fps, max: profile.fps },
    });
  } catch {
    // Alguns capturadores não permitem reduzir resolução via constraints, mas
    // normalmente aceitam limitar FPS. Não interrompemos a transmissão por isso.
    await track.applyConstraints({ frameRate: { ideal: profile.fps, max: profile.fps } }).catch(() => undefined);
  }
}

function RemoteAudio({ stream, volume }: { stream: MediaStream; volume: number }) {
  const contextRef = useRef<AudioContext | null>(null);
  const gainRef = useRef<GainNode | null>(null);

  useEffect(() => {
    const context = new AudioContext();
    const source = context.createMediaStreamSource(stream);
    const gain = context.createGain();
    gain.gain.value = volume / 100;
    source.connect(gain).connect(context.destination);
    contextRef.current = context;
    gainRef.current = gain;
    void context.resume().catch(() => undefined);
    return () => {
      source.disconnect();
      gain.disconnect();
      void context.close();
      contextRef.current = null;
      gainRef.current = null;
    };
  }, [stream]);

  useEffect(() => {
    const gain = gainRef.current;
    if (gain) gain.gain.setTargetAtTime(volume / 100, gain.context.currentTime, 0.015);
    if (contextRef.current?.state === "suspended") void contextRef.current.resume().catch(() => undefined);
  }, [volume]);

  return null;
}

function VolumeControl({ label, value, onChange }: { label: string; value: number; onChange(value: number): void }) {
  return <label className="volume-control" title={`${label}: ${value}%`}>
    {value === 0 ? <VolumeX size={15}/> : <Volume2 size={15}/>}<span>{label}</span>
    <input type="range" min="0" max="200" step="5" value={value} onChange={(event) => onChange(Number(event.target.value))} aria-label={`Volume de ${label}`}/>
    <b>{value}%</b>
  </label>;
}

function FullscreenButton({ target }: { target: RefObject<HTMLElement | null> }) {
  return <button
    type="button"
    className="tile-fullscreen"
    title="Tela cheia"
    aria-label="Abrir transmissão em tela cheia"
    onClick={(event) => {
      event.stopPropagation();
      const element = target.current;
      if (element) void element.requestFullscreen().catch(() => undefined);
    }}
  ><Maximize2 size={16}/></button>;
}

function VideoTile({
  participant,
  tileId,
  focused,
  compact,
  onFocus,
}: {
  participant: Participant;
  tileId: string;
  focused: boolean;
  compact: boolean;
  onFocus(tileId: string): void;
}) {
  const streams = Object.values(participant.streams ?? {});
  const screenStream = participant.state.screenStreamId ? participant.streams?.[participant.state.screenStreamId] : undefined;
  const cameraStream = (participant.state.cameraStreamId ? participant.streams?.[participant.state.cameraStreamId] : undefined)
    ?? streams.find((stream) => stream.id !== screenStream?.id && stream.getVideoTracks().length > 0)
    ?? streams.find((stream) => stream.id !== screenStream?.id);
  const microphoneStream = streams.find((stream) =>
    stream.id !== screenStream?.id
    && stream.getAudioTracks().some((track) => track.readyState === "live"),
  ) ?? (cameraStream?.getAudioTracks().length ? cameraStream : undefined);
  const [source, setSource] = useState<"camera" | "screen">("camera");
  const [userVolume, setUserVolume] = useState(100);
  const [screenVolume, setScreenVolume] = useState(100);
  const videoRef = useRef<HTMLVideoElement>(null);
  const articleRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (participant.state.screenShare && screenStream) setSource("screen");
    else if (!participant.state.screenShare) setSource("camera");
  }, [participant.state.screenShare, screenStream]);

  const selected = source === "screen" ? screenStream : cameraStream;
  const trackKey = selected?.getVideoTracks().map((track) => track.id).join(":") ?? "";
  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.srcObject = selected ?? null;
      void videoRef.current.play().catch(() => undefined);
    }
  }, [selected, trackKey]);

  const hasVideo = Boolean(selected?.getVideoTracks().length);
  const canSwitch = participant.state.camera && Boolean(cameraStream && screenStream);
  const userHasAudio = Boolean(microphoneStream?.getAudioTracks().some((track) => track.readyState === "live"));
  const screenHasAudio = Boolean(screenStream?.getAudioTracks().some((track) => track.readyState === "live"));

  return <article
    ref={articleRef}
    className={`tile ${source} ${participant.connection === "connected" ? "online" : ""} ${focused ? "focused" : ""} ${compact ? "thumbnail" : ""}`}
    onClick={(event) => {
      if ((event.target as HTMLElement).closest("button,input")) return;
      onFocus(tileId);
    }}
    onDoubleClick={() => { void articleRef.current?.requestFullscreen().catch(() => undefined); }}
  >
    <video ref={videoRef} autoPlay playsInline muted className={hasVideo ? source : "hidden-video"}/>
    {!hasVideo && <div className="video-off"><VideoOff/><span>Vídeo desligado</span></div>}
    {userHasAudio && <RemoteAudio stream={microphoneStream!} volume={userVolume}/>} 
    {screenHasAudio && <RemoteAudio stream={screenStream!} volume={screenVolume}/>} 
    <FullscreenButton target={articleRef}/>
    {canSwitch && <div className="source-switch">
      <button className={source === "camera" ? "selected" : ""} onClick={(event) => { event.stopPropagation(); setSource("camera"); }}><Video size={14}/> Câmera</button>
      <button className={source === "screen" ? "selected" : ""} onClick={(event) => { event.stopPropagation(); setSource("screen"); }}><MonitorUp size={14}/> Tela</button>
    </div>}
    {(userHasAudio || screenHasAudio) && !compact && <div className="volume-panel">
      {userHasAudio && <VolumeControl label="Usuário" value={userVolume} onChange={setUserVolume}/>} 
      {screenHasAudio && <VolumeControl label="Transmissão" value={screenVolume} onChange={setScreenVolume}/>} 
    </div>}
    <div className="tile-label"><span>{participant.displayName}</span>{!participant.state.microphone && <MicOff size={15}/>} {participant.state.screenAudio && !compact && <em>ÁUDIO DA TELA</em>}</div>
  </article>;
}

function LocalVideoTile({
  stream,
  tileId,
  label,
  mirrored,
  microphone,
  focused,
  compact,
  onFocus,
}: {
  stream: MediaStream;
  tileId: string;
  label: string;
  mirrored: boolean;
  microphone: boolean;
  focused: boolean;
  compact: boolean;
  onFocus(tileId: string): void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const articleRef = useRef<HTMLElement>(null);
  const source = mirrored ? "camera" : "screen";
  useEffect(() => {
    if (videoRef.current) {
      videoRef.current.srcObject = stream;
      void videoRef.current.play().catch(() => undefined);
    }
  }, [stream]);

  return <article
    ref={articleRef}
    className={`tile local online ${source} ${focused ? "focused" : ""} ${compact ? "thumbnail" : ""}`}
    onClick={(event) => {
      if ((event.target as HTMLElement).closest("button")) return;
      onFocus(tileId);
    }}
    onDoubleClick={() => { void articleRef.current?.requestFullscreen().catch(() => undefined); }}
  >
    <video ref={videoRef} autoPlay playsInline muted className={`${source}${mirrored ? " mirrored" : ""}`}/>
    <FullscreenButton target={articleRef}/>
    <div className="tile-label"><span>Você · {label}</span>{!microphone && <MicOff size={15}/>} {!compact && <em>PRÉVIA</em>}</div>
  </article>;
}

function upsertAttachment(current: ChatAttachmentRecord[], record: ChatAttachmentRecord): ChatAttachmentRecord[] {
  const index = current.findIndex((item) => item.attachmentId === record.attachmentId);
  if (index < 0) return [...current, record].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const existing = current[index]!;
  const replacement = record.updatedAt >= existing.updatedAt ? record : existing;
  const next = [...current];
  next[index] = replacement;
  return next.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

function ScreenSourcePicker({
  sources,
  loading,
  onChoose,
  onClose,
}: {
  sources: RiskDesktopSource[];
  loading: boolean;
  onChoose(source: RiskDesktopSource): void;
  onClose(): void;
}) {
  return <div className="screen-picker-backdrop" onMouseDown={onClose}>
    <section className="screen-picker" onMouseDown={(event) => event.stopPropagation()}>
      <header><div><MonitorUp/><span><strong>Compartilhar tela</strong><small>Escolha uma tela ou janela</small></span></div><button onClick={onClose} aria-label="Fechar"><X/></button></header>
      {loading ? <div className="screen-picker-loading"><Sparkles/><span>Buscando telas e janelas…</span></div> :
        <div className="screen-source-grid">
          {sources.map((source) => <button key={source.id} className="screen-source" onClick={() => onChoose(source)}>
            <div className="screen-source-preview">{source.thumbnail ? <img src={source.thumbnail} alt=""/> : <MonitorUp/>}</div>
            <span title={source.name}>{source.name}</span>
          </button>)}
          {!sources.length && <div className="screen-picker-empty">Nenhuma tela ou janela foi encontrada.</div>}
        </div>}
    </section>
  </div>;
}

export function CallWorkspace({ call, chat }: { call: CallController; chat: ChatController }) {
  const token = useCallStore((state) => state.token)!;
  const roomId = useCallStore((state) => state.roomId)!;
  const callContext = useCallStore((state) => state.callContext);
  const setCallContext = useCallStore((state) => state.setCallContext);
  const participants = useCallStore((state) => state.participants);
  const localPreviews = useCallStore((state) => state.localPreviews);
  const localState = useCallStore((state) => state.localState);
  const callError = useCallStore((state) => state.error);
  const setError = useCallStore((state) => state.setError);
  const setRoom = useCallStore((state) => state.setRoom);
  const peers = Object.values(participants);
  const [view, setView] = useState<ViewMode>("call");
  const [focusedTile, setFocusedTile] = useState<string | null>(null);
  const [chatStatus, setChatStatus] = useState<ChatConnectionStatus>("disconnected");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [attachments, setAttachments] = useState<ChatAttachmentRecord[]>([]);
  const [attachmentProgress, setAttachmentProgress] = useState<Record<string, ChatAttachmentProgress | undefined>>({});
  const [quality, setQuality] = useState<ScreenQuality>(initialScreenQuality);
  const [audioSettingsOpen, setAudioSettingsOpen] = useState(false);
  const [sourcePickerOpen, setSourcePickerOpen] = useState(false);
  const [screenSources, setScreenSources] = useState<RiskDesktopSource[]>([]);
  const [screenSourcesLoading, setScreenSourcesLoading] = useState(false);

  const hasVideo = Boolean(localPreviews.camera || localPreviews.screen);
  const context = callContext;

  useEffect(() => {
    if (context) return;
    let alive = true;
    void (async () => {
      try {
        const [localGroups, profile] = await Promise.all([loadLocalGroups(), api.me(token)]);
        if (!alive) return;
        const localGroup = localGroups.find((item) => item.channels.some((channel) => channel.kind === "voice" && channel.voiceRoomId === roomId));
        if (localGroup) {
          const textChannel = localGroup.channels.find((channel) => channel.kind === "text") ?? null;
          setCallContext({
            groupId: localGroup.groupId,
            groupName: localGroup.name,
            textChannelId: textChannel?.id ?? null,
            textChannelName: textChannel?.name ?? null,
            displayName: profile.displayName,
          });
          return;
        }

        const communities = await api.communities(token).catch(() => []);
        for (const community of communities) {
          if (!alive) return;
          const channels = await api.channels(token, community.id).catch(() => []);
          const voiceChannel = channels.find((channel) => channel.kind === "voice" && channel.voiceRoomId === roomId);
          if (!voiceChannel) continue;
          const textChannel = channels.find((channel) => channel.kind === "text") ?? null;
          setCallContext({
            groupId: community.id,
            groupName: community.name,
            textChannelId: textChannel?.id ?? null,
            textChannelName: textChannel?.name ?? null,
            displayName: profile.displayName,
          });
          return;
        }
      } catch {
        // A chamada continua funcionando mesmo se não conseguirmos resolver o chat.
      }
    })();
    return () => { alive = false; };
  }, [context, roomId, setCallContext, token]);

  useEffect(() => {
    const channelId = context?.textChannelId;
    if (!channelId) {
      setChatStatus("disconnected");
      return;
    }
    let alive = true;
    const offMessage = chat.onMessage((message) => {
      if (!alive) return;
      setMessages((current) => current.some((item) => item.id === message.id)
        ? current
        : [...current, message].sort((left, right) => left.createdAt.localeCompare(right.createdAt)));
    });
    const offStatus = chat.onStatus((status) => { if (alive) setChatStatus(status); });
    const offAttachment = chat.onAttachment((record) => {
      if (alive && record.channelId === channelId) setAttachments((current) => upsertAttachment(current, record));
    });
    const offProgress = chat.onAttachmentProgress((progress) => {
      if (!alive || progress.record.channelId !== channelId) return;
      setAttachmentProgress((current) => ({ ...current, [progress.record.attachmentId]: progress }));
      setAttachments((current) => upsertAttachment(current, progress.record));
    });

    void (async () => {
      try {
        await chat.disconnect().catch(() => undefined);
        const [{ iceServers }, history, storedAttachments] = await Promise.all([
          api.turnCredentials(token),
          chat.history(channelId),
          chat.attachmentHistory(channelId),
        ]);
        if (!alive) return;
        setMessages([...history].sort((left, right) => left.createdAt.localeCompare(right.createdAt)));
        setAttachments(storedAttachments.reduce<ChatAttachmentRecord[]>((items, record) => upsertAttachment(items, record), []));
        await chat.connect(channelId, context.displayName, iceServers);
      } catch (cause) {
        if (alive) setError(cause instanceof Error ? cause.message : "Não foi possível conectar o chat do grupo.");
      }
    })();

    return () => {
      alive = false;
      offMessage();
      offStatus();
      offAttachment();
      offProgress();
      void chat.disconnect();
    };
  }, [chat, context?.displayName, context?.textChannelId, setError, token]);

  useEffect(() => {
    localStorage.setItem(SCREEN_QUALITY_KEY, quality);
    void applyScreenQuality(localPreviews.screen, quality);
  }, [localPreviews.screen, quality]);

  const tileIds = useMemo(() => {
    const ids: string[] = [];
    if (localPreviews.camera) ids.push("local-camera");
    if (localPreviews.screen) ids.push("local-screen");
    peers.forEach((peer) => ids.push(`peer-${peer.peerId}`));
    return ids;
  }, [localPreviews.camera, localPreviews.screen, peers]);

  useEffect(() => {
    if (focusedTile && !tileIds.includes(focusedTile)) setFocusedTile(null);
  }, [focusedTile, tileIds]);

  async function showScreenPicker(): Promise<void> {
    if (localState.screenShare) {
      await call.toggleScreen(roomId);
      return;
    }
    if (!window.desktop?.listScreenSources) {
      await call.toggleScreen(roomId);
      return;
    }
    setSourcePickerOpen(true);
    setScreenSourcesLoading(true);
    try {
      setScreenSources(await window.desktop.listScreenSources());
    } catch (cause) {
      setSourcePickerOpen(false);
      setError(cause instanceof Error ? cause.message : "Não foi possível listar as telas disponíveis.");
    } finally {
      setScreenSourcesLoading(false);
    }
  }

  async function chooseScreen(source: RiskDesktopSource): Promise<void> {
    setSourcePickerOpen(false);
    try {
      await call.toggleScreen(roomId, source.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível iniciar o compartilhamento.");
    }
  }

  async function submitMessage(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const input = event.currentTarget.elements.namedItem("message") as HTMLInputElement;
    const content = input.value.trim();
    if (!content) return;
    try {
      await chat.send(content);
      input.value = "";
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Falha ao enviar mensagem.");
    }
  }

  async function sendFiles(files: File[]): Promise<void> {
    try {
      for (const file of files) await chat.sendAttachment(file);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Falha ao enviar arquivo.");
    }
  }

  async function attachmentAction(action: (record: ChatAttachmentRecord) => Promise<void>, record: ChatAttachmentRecord): Promise<void> {
    try { await action(record); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Falha na operação com o arquivo."); }
  }

  const focused = focusedTile && tileIds.includes(focusedTile) ? focusedTile : null;
  const timeline = <ConversationTimeline
    messages={messages}
    attachments={attachments}
    progress={attachmentProgress}
    connected={chatStatus === "ready"}
    loadBlob={(record) => chat.attachmentBlob(record)}
    onDownload={(record) => attachmentAction((item) => chat.downloadAttachment(item), record)}
    onRequest={(record) => attachmentAction((item) => chat.requestAttachment(item), record)}
    onPause={(record) => attachmentAction((item) => chat.pauseAttachment(item), record)}
    onResume={(record) => attachmentAction((item) => chat.resumeAttachment(item), record)}
    onCancel={(record) => attachmentAction((item) => chat.cancelAttachment(item), record)}
  />;

  return <main className="room call-workspace">
    <header>
      <div className="brand"><Sparkles/> Risk</div>
      <div><strong>Sala ao vivo</strong><span>{context?.groupName ? `${context.groupName} · ` : ""}{roomId}</span></div>
      <div className="call-header-actions">
        <div className="call-view-tabs">
          <button className={view === "call" ? "active" : ""} onClick={() => setView("call")}><Video size={16}/> Chamada</button>
          <button className={view === "chat" ? "active" : ""} onClick={() => setView("chat")} disabled={!context?.textChannelId}><MessageCircle size={16}/> Chat</button>
        </div>
        <div className="status"><i/> Conectado · {peers.length + 1}</div>
      </div>
    </header>

    {callError && <div className="global-error" onClick={() => setError(null)}>{callError}</div>}

    <section className={`call-view ${view === "call" ? "" : "is-hidden"}`}>
      <section className={`stage ${focused ? "stage-focused" : ""}`} onMouseDown={(event) => {
        if (event.target === event.currentTarget) setFocusedTile(null);
      }}>
        {localPreviews.camera && <LocalVideoTile
          stream={localPreviews.camera}
          tileId="local-camera"
          label="Câmera"
          mirrored
          microphone={localState.microphone}
          focused={focused === "local-camera"}
          compact={Boolean(focused && focused !== "local-camera")}
          onFocus={(id) => setFocusedTile((current) => current === id ? null : id)}
        />}
        {localPreviews.screen && <LocalVideoTile
          stream={localPreviews.screen}
          tileId="local-screen"
          label={localState.screenAudio ? `Tela · ${QUALITY_PROFILES[quality].label}` : `Tela · sem áudio · ${QUALITY_PROFILES[quality].label}`}
          mirrored={false}
          microphone={localState.microphone}
          focused={focused === "local-screen"}
          compact={Boolean(focused && focused !== "local-screen")}
          onFocus={(id) => setFocusedTile((current) => current === id ? null : id)}
        />}
        {peers.map((participant) => {
          const id = `peer-${participant.peerId}`;
          return <VideoTile
            key={participant.peerId}
            participant={participant}
            tileId={id}
            focused={focused === id}
            compact={Boolean(focused && focused !== id)}
            onFocus={(next) => setFocusedTile((current) => current === next ? null : next)}
          />;
        })}
        {!hasVideo && !peers.length && <div className="empty"><div className="pulse"><Sparkles/></div><h2>Você chegou primeiro</h2><p>Compartilhe o código <b>{roomId}</b> para alguém entrar.</p></div>}
      </section>
    </section>

    <section className={`call-chat-view ${view === "chat" ? "" : "is-hidden"}`}>
      <header className="call-chat-header">
        <div><Hash/><span><strong>#{context?.textChannelName ?? "chat"}</strong><small>{context?.groupName ?? "Grupo atual"}</small></span></div>
        <div className={`call-chat-status ${chatStatus}`}><i/>{chatStatus === "ready" ? "P2P conectado" : chatStatus === "connected" ? "Aguardando peers" : chatStatus === "connecting" ? "Conectando" : "Offline"}</div>
        <button onClick={() => setView("call")}><Video size={16}/> Voltar para chamada</button>
      </header>
      <div className="messages call-chat-messages">
        {timeline}
        {!messages.length && !attachments.length && <div className="channel-welcome"><MessageCircle/><h2>Chat da chamada</h2><p>O chat P2P conecta automaticamente enquanto você permanece na sala de voz.</p></div>}
      </div>
      <MessageComposer
        placeholder={context?.textChannelName ? `Conversar em #${context.textChannelName}` : "Chat indisponível"}
        canAttach={chatStatus === "ready"}
        onSubmit={submitMessage}
        onFiles={sendFiles}
      />
    </section>

    <footer>
      <button className={localState.microphone ? "" : "off"} onClick={() => void call.toggleMicrophone(roomId)}>{localState.microphone ? <Mic/> : <MicOff/>}<span>Microfone</span></button>
      <button className={audioSettingsOpen ? "active" : ""} onClick={() => setAudioSettingsOpen((current) => !current)} title="Configurações de áudio"><Settings2/><span>Áudio</span></button>
      <button className={localState.camera ? "active" : ""} onClick={() => void call.toggleCamera(roomId)}>{localState.camera ? <Video/> : <VideoOff/>}<span>Câmera</span></button>
      <div className="share-control">
        <button className={localState.screenShare ? "active" : ""} onClick={() => void showScreenPicker()}><MonitorUp/><span>{localState.screenShare ? "Parar transmissão" : "Compartilhar"}</span></button>
        <select value={quality} onChange={(event) => setQuality(event.target.value as ScreenQuality)} aria-label="Qualidade da transmissão" title="Qualidade da transmissão">
          {Object.entries(QUALITY_PROFILES).map(([value, profile]) => <option key={value} value={value}>{profile.label}</option>)}
        </select>
      </div>
      {context?.textChannelId && <button className={view === "chat" ? "active" : ""} onClick={() => setView(view === "chat" ? "call" : "chat")}><MessageCircle/><span>{view === "chat" ? "Chamada" : "Chat"}</span></button>}
      <button className="hangup" onClick={() => {
        setAudioSettingsOpen(false);
        setRoom(null);
        setCallContext(null);
        void chat.disconnect();
        void call.leave(roomId);
      }}><PhoneOff/><span>Sair</span></button>
    </footer>

    {audioSettingsOpen && <InCallAudioSettings call={call} onClose={() => setAudioSettingsOpen(false)}/>} 
    {sourcePickerOpen && <ScreenSourcePicker
      sources={screenSources}
      loading={screenSourcesLoading}
      onChoose={(source) => void chooseScreen(source)}
      onClose={() => setSourcePickerOpen(false)}
    />}
  </main>;
}
