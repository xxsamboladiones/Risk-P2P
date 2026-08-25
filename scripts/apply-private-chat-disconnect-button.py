from pathlib import Path

main = Path("apps/web/src/main.tsx")
source = main.read_text(encoding="utf-8")

submit_anchor = '  async function submitMessage(event: React.FormEvent<HTMLFormElement>) {\n'
if submit_anchor not in source:
    raise SystemExit("submitMessage anchor not found")

disconnect_fn = '''  async function disconnectPrivateChat() {
    if (!privateChannelId) return;
    try {
      await backgroundChats.disconnectPrivate(privateChannelId);
      setChatStatus("disconnected");
      setAttachmentProgress({});
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Falha ao desconectar o chat privado");
    }
  }

'''
source = source.replace(submit_anchor, disconnect_fn + submit_anchor, 1)

old_header = '''          <header className="content-header"><MessageCircle/><strong>{activeFriend.displayName}</strong><span>Mensagem direta P2P</span><input className="message-search" value={messageSearch} onChange={(event) => setMessageSearch(event.target.value)} placeholder="Buscar"/><button className={`chat-connect ${chatStatus}`} disabled={!privateChannelId || chatStatus === "connecting" || chatStatus === "connected" || chatStatus === "ready"} onClick={() => void connectChat()}>{chatStatus === "ready" ? "Chat privado conectado" : chatStatus === "connected" ? "Aguardando amigo…" : chatStatus === "connecting" ? "Conectando…" : chatStatus === "incompatible" ? "Versão incompatível" : "Conectar P2P"}</button></header>'''
new_header = '''          <header className="content-header"><MessageCircle/><strong>{activeFriend.displayName}</strong><span>Mensagem direta P2P</span><input className="message-search" value={messageSearch} onChange={(event) => setMessageSearch(event.target.value)} placeholder="Buscar"/><button className={`chat-connect ${chatStatus}`} disabled={!privateChannelId || chatStatus === "connecting" || chatStatus === "connected" || chatStatus === "ready"} onClick={() => void connectChat()}>{chatStatus === "ready" ? "Chat privado conectado" : chatStatus === "connected" ? "Aguardando amigo…" : chatStatus === "connecting" ? "Conectando…" : chatStatus === "incompatible" ? "Versão incompatível" : "Conectar P2P"}</button>{(chatStatus === "connected" || chatStatus === "ready") && <button className="chat-disconnect" onClick={() => void disconnectPrivateChat()} title="Desconectar somente este chat privado"><PhoneOff size={16}/>Desconectar P2P</button>}</header>'''
if old_header not in source:
    raise SystemExit("private chat header anchor not found")
source = source.replace(old_header, new_header, 1)
main.write_text(source, encoding="utf-8")

styles = Path("apps/web/src/styles.css")
css = styles.read_text(encoding="utf-8")
css_anchor = '.content-header .chat-connect{margin-left:auto;min-width:150px}.content-header .chat-connect.connecting,.content-header .chat-connect.connected{background:#27303c;color:#c8d0db}.content-header .chat-connect.ready{background:#6ee7a0;color:#07120c;box-shadow:0 0 18px #6ee7a044}'
css_replacement = css_anchor + '.content-header .chat-disconnect{margin-left:0;display:flex;align-items:center;gap:7px;white-space:nowrap;background:#e9555520;color:#ff8585;border:1px solid #e9555540}.content-header .chat-disconnect:hover{background:#e95555;color:#fff;transform:none}'
if css_anchor not in css:
    raise SystemExit("chat connect CSS anchor not found")
css = css.replace(css_anchor, css_replacement, 1)
styles.write_text(css, encoding="utf-8")
