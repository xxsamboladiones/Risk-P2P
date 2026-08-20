import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Hash,
  Headphones,
  LogOut,
  MessageCircle,
  Mic,
  MicOff,
  MonitorUp,
  PhoneOff,
  Plus,
  Settings2,
  Sparkles,
  UserPlus,
  Users,
  Video,
  VideoOff,
  Volume2,
  VolumeX,
} from "lucide-react";
import { api, type Channel, type ChatMessage, type Community, type CurrentUser, type Friend, type PendingFriend } from "./api";
import { CallController } from "./call";
import {
  ChatController,
  privateConversationId,
  type ChatAttachmentProgress,
  type ChatAttachmentRecord,
  type ChatConnectionStatus,
} from "./chat";
import { CallWorkspace } from "./components/CallWorkspace";
import { ConversationTimeline } from "./components/ConversationTimeline";
import { GroupInvitePanel } from "./components/GroupInvitePanel";
import { MessageComposer } from "./components/MessageComposer";
import { P2PInvitePanel } from "./components/P2PInvitePanel";
import { VoiceVideoSettingsPanel } from "./components/VoiceVideoSettingsPanel";
import {
  addLocalGroupChannel,
  createLocalGroup,
  getOrCreateLocalIdentity,
  loadLocalFriends,
  loadLocalGroups,
  publicIdentity,
  type PublicPeerIdentity,
} from "./services/offline/social-storage";
import { useCallStore, type Participant } from "./store";
import "./styles.css";

const call = new CallController();
const chat = new ChatController();
let sessionRestore: Promise<string | null> | undefined;
let sessionRestoreSuppressed = false;

function restoreSession(): Promise<string | null> {
  if (sessionRestoreSuppressed) return Promise.resolve(null);
  if (!sessionRestore) {
    sessionRestore = api.refresh()
      .then((result) => result.accessToken)
      .catch(() => null)
      .finally(() => { sessionRestore = undefined; });
  }
  return sessionRestore;
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

function VideoTile({ participant }: { participant: Participant }) {
  const streams = Object.values(participant.streams ?? {});
  const screenStream = participant.state.screenStreamId ? participant.streams?.[participant.state.screenStreamId] : undefined;
  const cameraStream = (participant.state.cameraStreamId ? participant.streams?.[participant.state.cameraStreamId] : undefined)
    ?? streams.find((stream) => stream.id !== screenStream?.id);
  const [source, setSource] = useState<"camera" | "screen">("camera");
  const [userVolume, setUserVolume] = useState(100);
  const [screenVolume, setScreenVolume] = useState(100);

  useEffect(() => {
    if (participant.state.screenShare && screenStream) setSource("screen");
    else if (!participant.state.screenShare) setSource("camera");
  }, [participant.state.screenShare, screenStream]);

  const selected = source === "screen" ? screenStream : cameraStream;
  const ref = useRef<HTMLVideoElement>(null);
  const trackKey = selected?.getVideoTracks().map((track) => track.id).join(":") ?? "";
  useEffect(() => {
    if (ref.current) {
      ref.current.srcObject = selected ?? null;
      void ref.current.play().catch(() => undefined);
    }
  }, [selected, trackKey]);

  const hasVideo = Boolean(selected?.getVideoTracks().length);
  const canSwitch = participant.state.camera && Boolean(cameraStream && screenStream);
  const userHasAudio = Boolean(cameraStream?.getAudioTracks().length);
  const screenHasAudio = Boolean(screenStream?.getAudioTracks().length);

  return <article
    className={`tile ${source} ${participant.connection === "connected" ? "online" : ""}`}
    tabIndex={0}
    title="Clique para destacar · duplo clique para tela cheia"
    onDoubleClick={(event) => { void event.currentTarget.requestFullscreen().catch(() => undefined); }}
  >
    <video ref={ref} autoPlay playsInline muted className={hasVideo ? source : "hidden-video"}/>
    {!hasVideo && <div className="video-off"><VideoOff/><span>Vídeo desligado</span></div>}
    {userHasAudio && <RemoteAudio stream={cameraStream!} volume={userVolume}/>} 
    {screenHasAudio && <RemoteAudio stream={screenStream!} volume={screenVolume}/>} 
    {canSwitch && <div className="source-switch">
      <button className={source === "camera" ? "selected" : ""} onClick={() => setSource("camera")}><Video size={14}/> Câmera</button>
      <button className={source === "screen" ? "selected" : ""} onClick={() => setSource("screen")}><MonitorUp size={14}/> Tela</button>
    </div>}
    {(userHasAudio || screenHasAudio) && <div className="volume-panel">
      {userHasAudio && <VolumeControl label="Usuário" value={userVolume} onChange={setUserVolume}/>} 
      {screenHasAudio && <VolumeControl label="Transmissão" value={screenVolume} onChange={setScreenVolume}/>} 
    </div>}
    <div className="tile-label"><span>{participant.displayName}</span>{!participant.state.microphone && <MicOff size={15}/>} {participant.state.screenAudio && <em>ÁUDIO DA TELA</em>}</div>
  </article>;
}

function LocalVideoTile({ stream, label, mirrored, microphone }: { stream: MediaStream; label: string; mirrored: boolean; microphone: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  const source = mirrored ? "camera" : "screen";
  useEffect(() => {
    if (ref.current) {
      ref.current.srcObject = stream;
      void ref.current.play().catch(() => undefined);
    }
  }, [stream]);
  return <article
    className={`tile local online ${source}`}
    tabIndex={0}
    title="Clique para destacar · duplo clique para tela cheia"
    onDoubleClick={(event) => { void event.currentTarget.requestFullscreen().catch(() => undefined); }}
  >
    <video ref={ref} autoPlay playsInline muted className={`${source}${mirrored ? " mirrored" : ""}`}/>
    <div className="tile-label"><span>Você · {label}</span>{!microphone && <MicOff size={15}/>}<em>PRÉVIA</em></div>
  </article>;
}

function Auth() {
  const setSession = useCallStore((state) => state.setSession);
  const [register, setRegister] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    try {
      const result = register
        ? await api.register(String(data.get("name")), String(data.get("email")), String(data.get("password")))
        : await api.login(String(data.get("email")), String(data.get("password")));
      sessionRestoreSuppressed = false;
      setSession(result.accessToken);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Falha na autenticação");
    }
  }

  return <main className="auth"><section className="auth-card">
    <div className="brand"><Sparkles/> Risk</div>
    <h1>{register ? "Crie seu espaço" : "Bom ter você de volta"}</h1>
    <p>Conversas que parecem estar na mesma sala.</p>
    <form onSubmit={submit}>
      {register && <input name="name" placeholder="Como devemos chamar você?" minLength={2} required/>}
      <input name="email" type="email" placeholder="seu@email.com" required/>
      <input name="password" type="password" minLength={8} placeholder="Senha" required/>
      {error && <div className="error">{error}</div>}
      <button>Continuar</button>
    </form>
    <button className="link" onClick={() => { setRegister(!register); setError(""); }}>{register ? "Já tenho uma conta" : "Criar uma conta"}</button>
  </section></main>;
}

function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose(): void }) {
  return <div className="modal-backdrop" onMouseDown={onClose}>
    <section className="modal" onMouseDown={(event) => event.stopPropagation()}>
      <button className="modal-close" onClick={onClose}>×</button><h2>{title}</h2>{children}</section>
  </div>;
}

type SocialModal = "friend" | "group" | "channel" | "member" | "joinGroup" | "settings" | null;

function SocialHome() {
  const token = useCallStore((state) => state.token)!;
  const reset = useCallStore((state) => state.reset);
  const setRoom = useCallStore((state) => state.setRoom);
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null);
  const [communities, setCommunities] = useState<Community[]>([]);
  const [friends, setFriends] = useState<Friend[]>([]);
  const [pending, setPending] = useState<PendingFriend[]>([]);
  const [selectedCommunity, setSelectedCommunity] = useState<Community | null>(null);
  const [activeFriend, setActiveFriend] = useState<Friend | null>(null);
  const [privateChannelId, setPrivateChannelId] = useState<string | null>(null);
  const [groupMembers, setGroupMembers] = useState<PublicPeerIdentity[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [activeChannel, setActiveChannel] = useState<Channel | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [attachments, setAttachments] = useState<ChatAttachmentRecord[]>([]);
  const [attachmentProgress, setAttachmentProgress] = useState<Record<string, ChatAttachmentProgress | undefined>>({});
  const [modal, setModal] = useState<SocialModal>(null);
  const [error, setError] = useState("");
  const [chatStatus, setChatStatus] = useState<ChatConnectionStatus>("disconnected");

  async function loadSocial() {
    const [social, groups, localFriends, localGroups] = await Promise.all([
      api.friends(token).catch(() => ({ friends: [], pending: [] })),
      api.communities(token).catch(() => []),
      loadLocalFriends(),
      loadLocalGroups(),
    ]);
    const mergedFriends = [...social.friends];
    localFriends.forEach((friend) => {
      if (!mergedFriends.some((item) => item.id === friend.peerId)) mergedFriends.push({ id: friend.peerId, displayName: friend.displayName, local: true });
    });
    const mergedGroups = [...groups];
    localGroups.forEach((group) => {
      const existing = mergedGroups.find((item) => item.id === group.groupId);
      if (existing) existing.local = true;
      else mergedGroups.push({ id: group.groupId, name: group.name, local: true });
    });
    setFriends(mergedFriends);
    setPending(social.pending);
    setCommunities(mergedGroups);
    setSelectedCommunity((current) => current ? mergedGroups.find((item) => item.id === current.id) ?? null : current);
    setActiveFriend((current) => current ? mergedFriends.find((item) => item.id === current.id) ?? null : current);
  }

  useEffect(() => {
    void loadSocial().catch((cause) => setError(cause instanceof Error ? cause.message : "Falha ao carregar"));
  }, [token]);

  useEffect(() => {
    const reload = () => { void loadSocial().catch(() => undefined); };
    window.addEventListener("risk:social-updated", reload);
    return () => window.removeEventListener("risk:social-updated", reload);
  }, [token]);

  useEffect(() => {
    void api.me(token).then(setCurrentUser).catch((cause) => setError(cause instanceof Error ? cause.message : "Falha ao carregar perfil"));
  }, [token]);

  useEffect(() => {
    let alive = true;
    if (!activeFriend?.local || !currentUser) {
      setPrivateChannelId(null);
      return () => { alive = false; };
    }
    void Promise.all([getOrCreateLocalIdentity(currentUser.displayName), loadLocalFriends()])
      .then(async ([identity, localFriends]) => {
        const friend = localFriends.find((item) => item.peerId === activeFriend.id);
        if (!friend) throw new Error("Identidade P2P deste amigo não está disponível neste dispositivo.");
        return privateConversationId(identity.peerId, friend.peerId);
      })
      .then((channelId) => { if (alive) setPrivateChannelId(channelId); })
      .catch((cause) => { if (alive) setError(cause instanceof Error ? cause.message : "Falha ao preparar conversa privada"); });
    return () => { alive = false; };
  }, [activeFriend, currentUser]);

  useEffect(() => {
    let alive = true;
    async function loadMembers() {
      if (!selectedCommunity?.local) { if (alive) setGroupMembers([]); return; }
      const group = (await loadLocalGroups()).find((item) => item.groupId === selectedCommunity.id);
      if (alive) setGroupMembers(group?.members ?? []);
    }
    void loadMembers().catch(() => { if (alive) setGroupMembers([]); });
    const reload = () => { void loadMembers().catch(() => undefined); };
    window.addEventListener("risk:social-updated", reload);
    return () => { alive = false; window.removeEventListener("risk:social-updated", reload); };
  }, [selectedCommunity]);

  useEffect(() => {
    if (!selectedCommunity) { setChannels([]); setActiveChannel(null); return; }
    let alive = true;
    const load = selectedCommunity.local
      ? loadLocalGroups().then((groups) => groups.find((group) => group.groupId === selectedCommunity.id)?.channels ?? [])
      : api.channels(token, selectedCommunity.id);
    void load.then((items) => {
      if (!alive) return;
      setChannels(items);
      setActiveChannel(items.find((item) => item.kind === "text") ?? items[0] ?? null);
    }).catch((cause) => {
      if (!alive) return;
      setChannels([]);
      setActiveChannel(null);
      setError(cause instanceof Error ? cause.message : "Falha ao carregar canais");
    });
    return () => { alive = false; };
  }, [selectedCommunity, token]);

  useEffect(() => {
    const conversationId = activeFriend ? privateChannelId : activeChannel?.kind === "text" ? activeChannel.id : null;
    if (!conversationId) { setMessages([]); setAttachments([]); setAttachmentProgress({}); return; }
    let alive = true;
    const offMessage = chat.onMessage((message) => {
      if (!alive) return;
      setMessages((current) => {
        if (current.some((item) => item.id === message.id)) return current;
        return [...current, message].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      });
    });
    const offStatus = chat.onStatus((status) => { if (alive) setChatStatus(status); });
    const offAttachment = chat.onAttachment((record) => {
      if (!alive || record.channelId !== conversationId) return;
      setAttachments((current) => upsertAttachment(current, record));
    });
    const offProgress = chat.onAttachmentProgress((progress) => {
      if (!alive || progress.record.channelId !== conversationId) return;
      setAttachmentProgress((current) => ({ ...current, [progress.record.attachmentId]: progress }));
      setAttachments((current) => upsertAttachment(current, progress.record));
    });
    void Promise.all([chat.history(conversationId), chat.attachmentHistory(conversationId)])
      .then(([chatItems, attachmentItems]) => {
        if (!alive) return;
        setMessages([...chatItems].sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
        setAttachments(dedupeAttachments(attachmentItems));
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : "Falha no histórico local"));
    return () => {
      alive = false;
      offMessage();
      offStatus();
      offAttachment();
      offProgress();
      void chat.disconnect();
      setChatStatus("disconnected");
      setAttachmentProgress({});
    };
  }, [activeChannel, activeFriend, privateChannelId]);

  async function enterVoice(channel: Channel) {
    if (!channel.voiceRoomId) return;
    try {
      const { iceServers } = await api.turnCredentials(token);
      await call.join(token, channel.voiceRoomId, iceServers);
      setRoom(channel.voiceRoomId);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível entrar na voz"); }
  }

  async function connectChat() {
    if (!currentUser) return;
    try {
      const { iceServers } = await api.turnCredentials(token);
      if (activeFriend) {
        if (!activeFriend.local || !privateChannelId) throw new Error("Esta conversa privada P2P ainda não está pronta.");
        const [identity, localFriends] = await Promise.all([
          getOrCreateLocalIdentity(currentUser.displayName),
          loadLocalFriends(),
        ]);
        const friend = localFriends.find((item) => item.peerId === activeFriend.id);
        if (!friend) throw new Error("Este amigo não possui identidade P2P local.");
        await chat.connect(privateChannelId, currentUser.displayName, iceServers, {
          identity,
          trustedPeers: [friend],
          namespace: "friend",
          maxRemotePeers: 1,
        });
        return;
      }
      if (!activeChannel || activeChannel.kind !== "text") return;
      await chat.connect(activeChannel.id, currentUser.displayName, iceServers);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Falha ao conectar o chat"); }
  }

  async function submitMessage(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeFriend && !activeChannel) return;
    const input = event.currentTarget.elements.namedItem("message") as HTMLInputElement;
    const content = input.value.trim();
    if (!content) return;
    try { await chat.send(content); input.value = ""; }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Falha ao enviar mensagem"); }
  }

  async function sendFiles(files: File[]) {
    try {
      for (const file of files) await chat.sendAttachment(file);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Falha ao enviar arquivo"); }
  }

  async function attachmentAction(action: (record: ChatAttachmentRecord) => Promise<void>, record: ChatAttachmentRecord) {
    try { await action(record); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Falha na operação com o arquivo"); }
  }

  async function logout() {
    sessionRestoreSuppressed = true;
    sessionRestore = undefined;
    try { await api.logout(); }
    catch { /* logout local continua mesmo se a API estiver indisponível */ }
    finally { reset(); }
  }

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

  return <>
    <main className="social-shell">
      <aside className="space-rail">
        <button className={!selectedCommunity ? "space active" : "space"} onClick={() => { setSelectedCommunity(null); setActiveFriend(null); }} title="Amigos"><Sparkles/></button>
        <div className="rail-separator"/>
        {communities.map((group) => <button key={group.id} className={selectedCommunity?.id === group.id ? "space active" : "space"} onClick={() => { setActiveFriend(null); setSelectedCommunity(group); }} title={group.name}>{group.name.slice(0, 2).toUpperCase()}</button>)}
        <button className="space add" onClick={() => setModal("group")} title="Criar grupo"><Plus/></button>
      </aside>

      <aside className="navigation">
        <div className="nav-title">{selectedCommunity?.name ?? activeFriend?.displayName ?? "Risk"}</div>
        {selectedCommunity ? <>
          <div className="nav-section"><span>CANAIS DE TEXTO</span><button onClick={() => setModal("channel")}><Plus size={15}/></button></div>
          {channels.filter((item) => item.kind === "text").map((channel) => <button key={channel.id} className={activeChannel?.id === channel.id ? "channel active" : "channel"} onClick={() => setActiveChannel(channel)}><Hash/>{channel.name}</button>)}
          <div className="nav-section"><span>SALAS DE VOZ</span><button onClick={() => setModal("channel")}><Plus size={15}/></button></div>
          {channels.filter((item) => item.kind === "voice").map((channel) => <button key={channel.id} className="channel voice" onClick={() => void enterVoice(channel)}><Headphones/>{channel.name}</button>)}
          <div className="nav-section"><span>MEMBROS</span><button onClick={() => setModal("member")}><UserPlus size={15}/></button></div>
          {groupMembers.slice(0, 8).map((member) => <div className="mini-user" key={member.peerId}><i>{member.displayName[0]?.toUpperCase()}</i><span>{member.displayName}</span></div>)}
        </> : <>
          <button className={!activeFriend ? "channel active" : "channel"} onClick={() => setActiveFriend(null)}><Users/>Amigos</button>
          {activeFriend && <button className="channel active"><MessageCircle/>{activeFriend.displayName}</button>}
          <button className="channel" onClick={() => setModal("friend")}><UserPlus/>Adicionar amigo</button>
        </>}
        <div className="account-bar">
          <div className="avatar">{currentUser?.displayName.slice(0, 2).toUpperCase() ?? "EU"}</div>
          <div><strong>{currentUser?.displayName ?? "Carregando…"}</strong><small>Disponível</small></div>
          <button onClick={() => setModal("settings")} title="Voz e vídeo"><Settings2/></button>
          <button onClick={() => void logout()} title="Sair"><LogOut/></button>
        </div>
      </aside>

      <section className="content-panel">
        {error && <div className="global-error" onClick={() => setError("")}>{error}</div>}
        {activeFriend ? <>
          <header className="content-header"><MessageCircle/><strong>{activeFriend.displayName}</strong><span>Mensagem direta P2P</span><button className={`chat-connect ${chatStatus}`} disabled={!privateChannelId || chatStatus === "connecting" || chatStatus === "connected" || chatStatus === "ready"} onClick={() => void connectChat()}>{chatStatus === "ready" ? "Chat privado conectado" : chatStatus === "connected" ? "Aguardando amigo…" : chatStatus === "connecting" ? "Conectando…" : "Conectar P2P"}</button></header>
          <div className="messages">
            {timeline}
            {!messages.length && !attachments.length && <div className="channel-welcome"><MessageCircle/><h2>Conversa com {activeFriend.displayName}</h2><p>Os dois amigos devem abrir esta conversa e clicar em Conectar P2P. Depois disso mensagens e arquivos seguem diretamente pelo WebRTC.</p></div>}
          </div>
          <MessageComposer placeholder={`Mensagem para ${activeFriend.displayName}`} canAttach={chatStatus === "ready"} onSubmit={submitMessage} onFiles={sendFiles}/>
        </> : !selectedCommunity ? <>
          <header className="content-header"><Users/><strong>Amigos</strong><button onClick={() => setModal("friend")}>Adicionar amigo</button></header>
          <div className="friends-layout"><div>
            <h3>Seus amigos — {friends.length}</h3>
            {pending.map((request) => <div className="friend-row pending" key={request.requestId}><div className="avatar">{request.displayName[0]}</div><div><strong>{request.displayName}</strong><small>Quer adicionar você</small></div><button onClick={() => void api.acceptFriend(token, request.requestId).then(loadSocial).catch((cause) => setError(cause instanceof Error ? cause.message : "Falha ao aceitar"))}>Aceitar</button></div>)}
            {friends.map((friend) => <div className="friend-row" key={friend.id}><div className="avatar">{friend.displayName[0]}</div><div><strong>{friend.displayName}</strong><small>{friend.local ? "Amigo P2P neste dispositivo" : "Amigo no Risk"}</small></div><button disabled={!friend.local} title={friend.local ? "Abrir chat privado P2P" : "Chat P2P requer amizade por identidade local"} onClick={() => { setSelectedCommunity(null); setActiveFriend(friend); }}><MessageCircle size={18}/></button></div>)}
            {!friends.length && !pending.length && <div className="empty-social"><Users/><h2>Seu círculo começa aqui</h2><p>Crie um código temporário ou use o código de outra pessoa.</p><button onClick={() => setModal("friend")}>Adicionar primeiro amigo</button></div>}
          </div><aside><h3>Atividade</h3><p>As salas de voz ativas dos seus grupos aparecerão aqui futuramente.</p></aside></div>
        </> : activeChannel?.kind === "text" ? <>
          <header className="content-header"><Hash/><strong>{activeChannel.name}</strong><span>{selectedCommunity.name}</span><button className={`chat-connect ${chatStatus}`} disabled={chatStatus === "connecting" || chatStatus === "connected" || chatStatus === "ready"} onClick={() => void connectChat()}>{chatStatus === "ready" ? "Chat P2P conectado" : chatStatus === "connected" ? "Aguardando peer…" : chatStatus === "connecting" ? "Conectando…" : "Conectar chat"}</button></header>
          <div className="messages">
            {timeline}
            {!messages.length && !attachments.length && <div className="channel-welcome"><Hash/><h2>Bem-vindo a #{activeChannel.name}</h2><p>Este é o começo deste canal P2P salvo neste dispositivo.</p></div>}
          </div>
          <MessageComposer placeholder={`Conversar em #${activeChannel.name}`} canAttach={chatStatus === "ready"} onSubmit={submitMessage} onFiles={sendFiles}/>
        </> : <div className="empty-social"><Headphones/><h2>Escolha uma sala</h2><p>Entre em um canal de voz pela barra lateral.</p></div>}
      </section>

      {modal === "friend" && <Modal title="Adicionar amigo" onClose={() => setModal(null)}>{currentUser ? <P2PInvitePanel type="friend" token={token} displayName={currentUser.displayName} onComplete={() => void loadSocial()}/> : <p>Carregando sua identidade…</p>}</Modal>}
      {modal === "settings" && <Modal title="Voz e vídeo" onClose={() => setModal(null)}><VoiceVideoSettingsPanel/></Modal>}
      {modal === "group" && <Modal title="Criar um grupo" onClose={() => setModal(null)}><form onSubmit={(event) => {
        event.preventDefault();
        const name = String(new FormData(event.currentTarget).get("name")).trim();
        if (!currentUser) return;
        void getOrCreateLocalIdentity(currentUser.displayName)
          .then((identity) => createLocalGroup(name, publicIdentity(identity)))
          .then((group) => {
            const community: Community = { id: group.groupId, name: group.name, local: true };
            setCommunities((items) => [...items, community]);
            setActiveFriend(null);
            setSelectedCommunity(community);
            setModal(null);
            window.dispatchEvent(new Event("risk:social-updated"));
          })
          .catch((cause) => setError(cause instanceof Error ? cause.message : "Falha ao criar grupo local"));
      }}><input name="name" minLength={2} maxLength={80} placeholder="Nome do grupo" required/><button>Criar grupo neste dispositivo</button></form></Modal>}
      {modal === "channel" && selectedCommunity && <Modal title="Criar canal" onClose={() => setModal(null)}><form onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        const kind = String(data.get("kind")) as "text" | "voice";
        const name = String(data.get("name")).trim();
        const localChannel: Channel = { id: crypto.randomUUID(), name, kind, voiceRoomId: kind === "voice" ? crypto.randomUUID() : null };
        const save = selectedCommunity.local
          ? addLocalGroupChannel(selectedCommunity.id, localChannel).then(() => localChannel)
          : api.createChannel(token, selectedCommunity.id, name, kind);
        void save.then((channel) => {
          setChannels((items) => [...items, channel]);
          setActiveChannel(channel);
          setModal(null);
          window.dispatchEvent(new Event("risk:social-updated"));
        }).catch((cause) => setError(cause instanceof Error ? cause.message : "Falha ao criar canal"));
      }}><input name="name" minLength={2} maxLength={80} placeholder="Nome do canal" required/><select name="kind"><option value="text">Canal de texto</option><option value="voice">Sala de voz</option></select><button>Criar canal</button></form></Modal>}
      {modal === "member" && selectedCommunity && <Modal title="Adicionar membro" onClose={() => setModal(null)}>{currentUser ? <GroupInvitePanel token={token} displayName={currentUser.displayName} preferredGroupId={selectedCommunity.id} preferredGroupName={selectedCommunity.name} preferredGroupChannels={channels} initialMode="create" onComplete={() => void loadSocial()}/> : <p>Carregando sua identidade…</p>}</Modal>}
      {modal === "joinGroup" && <Modal title="Entrar em grupo" onClose={() => setModal(null)}>{currentUser ? <GroupInvitePanel token={token} displayName={currentUser.displayName} initialMode="join" onComplete={() => { void loadSocial(); setModal(null); }}/> : <p>Carregando sua identidade…</p>}</Modal>}
    </main>
    <button className="floating-invite" onClick={() => setModal("joinGroup")}><UserPlus size={18}/> Entrar em grupo</button>
  </>;
}

function upsertAttachment(current: ChatAttachmentRecord[], record: ChatAttachmentRecord): ChatAttachmentRecord[] {
  const index = current.findIndex((item) => item.attachmentId === record.attachmentId);
  if (index < 0) return [...current, record].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const existing = current[index]!;
  const replacement = attachmentStateWeight(record.state) >= attachmentStateWeight(existing.state) ? record : existing;
  const next = [...current];
  next[index] = replacement;
  return next.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

function dedupeAttachments(records: ChatAttachmentRecord[]): ChatAttachmentRecord[] {
  return records.reduce<ChatAttachmentRecord[]>((items, record) => upsertAttachment(items, record), []);
}

function attachmentStateWeight(state: ChatAttachmentRecord["state"]): number {
  return ({ offered: 1, waiting: 2, accepted: 3, queued: 4, transferring: 5, paused: 6, verifying: 7, failed: 8, cancelled: 8, completed: 10 })[state];
}

function CallRoom() {
  return <CallWorkspace call={call} chat={chat}/>;
}

function App() {
  const token = useCallStore((state) => state.token);
  const room = useCallStore((state) => state.roomId);
  const setSession = useCallStore((state) => state.setSession);
  const [checkingSession, setCheckingSession] = useState(!token);

  useEffect(() => {
    if (token) { setCheckingSession(false); return; }
    if (sessionRestoreSuppressed) { setCheckingSession(false); return; }
    setCheckingSession(true);
    void restoreSession().then((restored) => {
      if (restored) setSession(restored);
      setCheckingSession(false);
    });
  }, [token, setSession]);

  if (checkingSession) return <main className="auth"><div className="session-loading"><Sparkles/><span>Restaurando sua sessão…</span></div></main>;
  return !token ? <Auth/> : room ? <CallRoom/> : <SocialHome/>;
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><App/></React.StrictMode>);