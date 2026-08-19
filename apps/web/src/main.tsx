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
  Send,
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
import { ChatController, type ChatConnectionStatus } from "./chat";
import { GroupInvitePanel } from "./components/GroupInvitePanel";
import { P2PInvitePanel } from "./components/P2PInvitePanel";
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

  return <article className={`tile ${source} ${participant.connection === "connected" ? "online" : ""}`}>
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
  return <article className={`tile local online ${source}`}>
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
      <button className="modal-close" onClick={onClose}>×</button><h2>{title}</h2>{children}
    </section>
  </div>;
}

type SocialModal = "friend" | "group" | "channel" | "member" | "joinGroup" | null;

function SocialHome() {
  const token = useCallStore((state) => state.token)!;
  const reset = useCallStore((state) => state.reset);
  const setRoom = useCallStore((state) => state.setRoom);
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null);
  const [communities, setCommunities] = useState<Community[]>([]);
  const [friends, setFriends] = useState<Friend[]>([]);
  const [pending, setPending] = useState<PendingFriend[]>([]);
  const [selectedCommunity, setSelectedCommunity] = useState<Community | null>(null);
  const [groupMembers, setGroupMembers] = useState<PublicPeerIdentity[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [activeChannel, setActiveChannel] = useState<Channel | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
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
    if (!activeChannel || activeChannel.kind !== "text") { setMessages([]); return; }
    let alive = true;
    const offMessage = chat.onMessage((message) => {
      if (alive) setMessages((current) => current.some((item) => item.id === message.id) ? current : [...current, message]);
    });
    const offStatus = chat.onStatus((status) => { if (alive) setChatStatus(status); });
    void chat.history(activeChannel.id).then((items) => { if (alive) setMessages(items); }).catch((cause) => setError(cause instanceof Error ? cause.message : "Falha no histórico local"));
    return () => {
      alive = false;
      offMessage();
      offStatus();
      void chat.disconnect();
      setChatStatus("disconnected");
    };
  }, [activeChannel]);

  async function enterVoice(channel: Channel) {
    if (!channel.voiceRoomId) return;
    try {
      const { iceServers } = await api.turnCredentials(token);
      await call.join(token, channel.voiceRoomId, iceServers);
      setRoom(channel.voiceRoomId);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível entrar na voz"); }
  }

  async function connectChat() {
    if (!activeChannel || activeChannel.kind !== "text" || !currentUser) return;
    try {
      const { iceServers } = await api.turnCredentials(token);
      await chat.connect(activeChannel.id, currentUser.displayName, iceServers);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Falha ao conectar o chat"); }
  }

  async function submitMessage(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeChannel) return;
    const input = event.currentTarget.elements.namedItem("message") as HTMLInputElement;
    const content = input.value.trim();
    if (!content) return;
    try { await chat.send(content); input.value = ""; }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Falha ao enviar mensagem"); }
  }

  async function logout() {
    sessionRestoreSuppressed = true;
    sessionRestore = undefined;
    try { await api.logout(); }
    catch { /* logout local continua mesmo se a API estiver indisponível */ }
    finally { reset(); }
  }

  return <>
    <main className="social-shell">
      <aside className="space-rail">
        <button className={!selectedCommunity ? "space active" : "space"} onClick={() => setSelectedCommunity(null)} title="Amigos"><Sparkles/></button>
        <div className="rail-separator"/>
        {communities.map((group) => <button key={group.id} className={selectedCommunity?.id === group.id ? "space active" : "space"} onClick={() => setSelectedCommunity(group)} title={group.name}>{group.name.slice(0, 2).toUpperCase()}</button>)}
        <button className="space add" onClick={() => setModal("group")} title="Criar grupo"><Plus/></button>
      </aside>

      <aside className="navigation">
        <div className="nav-title">{selectedCommunity?.name ?? "Risk"}</div>
        {selectedCommunity ? <>
          <div className="nav-section"><span>CANAIS DE TEXTO</span><button onClick={() => setModal("channel")}><Plus size={15}/></button></div>
          {channels.filter((item) => item.kind === "text").map((channel) => <button key={channel.id} className={activeChannel?.id === channel.id ? "channel active" : "channel"} onClick={() => setActiveChannel(channel)}><Hash/>{channel.name}</button>)}
          <div className="nav-section"><span>SALAS DE VOZ</span><button onClick={() => setModal("channel")}><Plus size={15}/></button></div>
          {channels.filter((item) => item.kind === "voice").map((channel) => <button key={channel.id} className="channel voice" onClick={() => void enterVoice(channel)}><Headphones/>{channel.name}</button>)}
          <div className="nav-section"><span>MEMBROS</span><button onClick={() => setModal("member")}><UserPlus size={15}/></button></div>
          {groupMembers.slice(0, 8).map((member) => <div className="mini-user" key={member.peerId}><i>{member.displayName[0]?.toUpperCase()}</i><span>{member.displayName}</span></div>)}
        </> : <>
          <button className="channel active"><Users/>Amigos</button>
          <button className="channel" onClick={() => setModal("friend")}><UserPlus/>Adicionar amigo</button>
        </>}
        <div className="account-bar">
          <div className="avatar">{currentUser?.displayName.slice(0, 2).toUpperCase() ?? "EU"}</div>
          <div><strong>{currentUser?.displayName ?? "Carregando…"}</strong><small>Disponível</small></div>
          <button onClick={() => void logout()} title="Sair"><LogOut/></button>
        </div>
      </aside>

      <section className="content-panel">
        {error && <div className="global-error" onClick={() => setError("")}>{error}</div>}
        {!selectedCommunity ? <>
          <header className="content-header"><Users/><strong>Amigos</strong><button onClick={() => setModal("friend")}>Adicionar amigo</button></header>
          <div className="friends-layout"><div>
            <h3>Seus amigos — {friends.length}</h3>
            {pending.map((request) => <div className="friend-row pending" key={request.requestId}><div className="avatar">{request.displayName[0]}</div><div><strong>{request.displayName}</strong><small>Quer adicionar você</small></div><button onClick={() => void api.acceptFriend(token, request.requestId).then(loadSocial).catch((cause) => setError(cause instanceof Error ? cause.message : "Falha ao aceitar"))}>Aceitar</button></div>)}
            {friends.map((friend) => <div className="friend-row" key={friend.id}><div className="avatar">{friend.displayName[0]}</div><div><strong>{friend.displayName}</strong><small>{friend.local ? "Amigo P2P neste dispositivo" : "Amigo no Risk"}</small></div><MessageCircle/></div>)}
            {!friends.length && !pending.length && <div className="empty-social"><Users/><h2>Seu círculo começa aqui</h2><p>Crie um código temporário ou use o código de outra pessoa.</p><button onClick={() => setModal("friend")}>Adicionar primeiro amigo</button></div>}
          </div><aside><h3>Atividade</h3><p>As salas de voz ativas dos seus grupos aparecerão aqui futuramente.</p></aside></div>
        </> : activeChannel?.kind === "text" ? <>
          <header className="content-header"><Hash/><strong>{activeChannel.name}</strong><span>{selectedCommunity.name}</span><button className={`chat-connect ${chatStatus}`} disabled={chatStatus === "connecting" || chatStatus === "connected" || chatStatus === "ready"} onClick={() => void connectChat()}>{chatStatus === "ready" ? "Chat P2P conectado" : chatStatus === "connected" ? "Aguardando peer…" : chatStatus === "connecting" ? "Conectando…" : "Conectar chat"}</button></header>
          <div className="messages">
            {messages.map((message) => <article key={message.id}><div className="avatar">{message.author[0]}</div><div><strong>{message.author}</strong><time>{new Date(message.createdAt).toLocaleString()}</time><p>{message.content}</p></div></article>)}
            {!messages.length && <div className="channel-welcome"><Hash/><h2>Bem-vindo a #{activeChannel.name}</h2><p>Este é o começo deste canal P2P salvo neste dispositivo.</p></div>}
          </div>
          <form className="message-box" onSubmit={(event) => void submitMessage(event)}><Plus/><input name="message" maxLength={4000} placeholder={`Conversar em #${activeChannel.name}`} autoComplete="off"/><button><Send/></button></form>
        </> : <div className="empty-social"><Headphones/><h2>Escolha uma sala</h2><p>Entre em um canal de voz pela barra lateral.</p></div>}
      </section>

      {modal === "friend" && <Modal title="Adicionar amigo" onClose={() => setModal(null)}>{currentUser ? <P2PInvitePanel type="friend" token={token} displayName={currentUser.displayName} onComplete={() => void loadSocial()}/> : <p>Carregando sua identidade…</p>}</Modal>}
      {modal === "group" && <Modal title="Criar um grupo" onClose={() => setModal(null)}><form onSubmit={(event) => {
        event.preventDefault();
        const name = String(new FormData(event.currentTarget).get("name")).trim();
        if (!currentUser) return;
        void getOrCreateLocalIdentity(currentUser.displayName)
          .then((identity) => createLocalGroup(name, publicIdentity(identity)))
          .then((group) => {
            const community: Community = { id: group.groupId, name: group.name, local: true };
            setCommunities((items) => [...items, community]);
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
      {modal === "member" && selectedCommunity && <Modal title="Adicionar membro" onClose={() => setModal(null)}>{currentUser ? <GroupInvitePanel token={token} displayName={currentUser.displayName} preferredGroupId={selectedCommunity.id} initialMode="create" onComplete={() => void loadSocial()}/> : <p>Carregando sua identidade…</p>}</Modal>}
      {modal === "joinGroup" && <Modal title="Entrar em grupo" onClose={() => setModal(null)}>{currentUser ? <GroupInvitePanel token={token} displayName={currentUser.displayName} initialMode="join" onComplete={() => { void loadSocial(); setModal(null); }}/> : <p>Carregando sua identidade…</p>}</Modal>}
    </main>
    <button className="floating-invite" onClick={() => setModal("joinGroup")}><UserPlus size={18}/> Entrar em grupo</button>
  </>;
}

function CallRoom() {
  const roomId = useCallStore((state) => state.roomId)!;
  const participants = useCallStore((state) => state.participants);
  const localPreviews = useCallStore((state) => state.localPreviews);
  const localState = useCallStore((state) => state.localState);
  const callError = useCallStore((state) => state.error);
  const setError = useCallStore((state) => state.setError);
  const setRoom = useCallStore((state) => state.setRoom);
  const peers = Object.values(participants);
  const hasVideo = Boolean(localPreviews.camera || localPreviews.screen);

  return <main className="room">
    <header><div className="brand"><Sparkles/> Risk</div><div><strong>Sala ao vivo</strong><span>{roomId}</span></div><div className="status"><i/> Conectado · {peers.length + 1}</div></header>
    {callError && <div className="global-error" onClick={() => setError(null)}>{callError}</div>}
    <section className="stage">
      {localPreviews.camera && <LocalVideoTile stream={localPreviews.camera} label="Câmera" mirrored microphone={localState.microphone}/>} 
      {localPreviews.screen && <LocalVideoTile stream={localPreviews.screen} label={localState.screenAudio ? "Tela · áudio ativo" : "Tela · sem áudio do sistema"} mirrored={false} microphone={localState.microphone}/>} 
      {peers.map((participant) => <VideoTile key={participant.peerId} participant={participant}/>)}
      {!hasVideo && !peers.length && <div className="empty"><div className="pulse"><Sparkles/></div><h2>Você chegou primeiro</h2><p>Compartilhe o código <b>{roomId}</b> para alguém entrar.</p></div>}
    </section>
    <footer>
      <button className={localState.microphone ? "" : "off"} onClick={() => void call.toggleMicrophone(roomId)}>{localState.microphone ? <Mic/> : <MicOff/>}<span>Microfone</span></button>
      <button className={localState.camera ? "active" : ""} onClick={() => void call.toggleCamera(roomId)}>{localState.camera ? <Video/> : <VideoOff/>}<span>Câmera</span></button>
      <button className={localState.screenShare ? "active" : ""} onClick={() => void call.toggleScreen(roomId)}><MonitorUp/><span>Compartilhar</span></button>
      <button className="hangup" onClick={() => { setRoom(null); void call.leave(roomId); }}><PhoneOff/><span>Sair</span></button>
    </footer>
  </main>;
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
