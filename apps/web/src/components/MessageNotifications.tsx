import { useEffect, useRef, useState } from "react";
import { MessageCircle, X } from "lucide-react";
import { onIncomingMessage } from "../services/chat/incoming-messages";
import { playMessageSound, prepareMessageSound } from "../services/audio/message-sound";
import type { LocalChatMessage } from "../services/offline/chat-storage";
import { ProfileAvatar } from "./ProfileAvatar";
import { useMessageAuthor } from "./ChatProfiles";
import "./message-notifications.css";

export function MessageNotifications() {
  const [messages, setMessages] = useState<LocalChatMessage[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const authorFor = useMessageAuthor();
  const latestAuthorFor = useRef(authorFor);
  latestAuthorFor.current = authorFor;
  const keyFor = (message: LocalChatMessage) => `${message.channelId}:${message.id}`;
  const dismiss = (key: string) => {
    clearTimeout(timers.current.get(key));
    timers.current.delete(key);
    setMessages((current) => current.filter((message) => keyFor(message) !== key));
  };

  useEffect(() => {
    const stopSound = prepareMessageSound();
    const off = onIncomingMessage((message) => {
      playMessageSound();
      if (document.visibilityState !== "visible" && "Notification" in window && Notification.permission === "granted") {
        const author = latestAuthorFor.current(message);
        try {
          new Notification(`Nova mensagem de ${author.displayName}`, {
            body: message.editedContent ?? message.content, icon: author.avatar, silent: true,
          });
        } catch { /* O aviso dentro do aplicativo continua disponível. */ }
      }
      setMessages((current) => [...current, message].slice(-3));
      const key = keyFor(message);
      timers.current.set(key, setTimeout(() => dismiss(key), 10_000));
    });
    return () => {
      off(); stopSound();
      timers.current.forEach(clearTimeout); timers.current.clear();
    };
  }, []);

  return <aside className="message-notifications" aria-label="Novas mensagens" aria-live="polite" aria-relevant="additions">
    {messages.map((message) => {
      const author = authorFor(message);
      return <article className="message-notification" key={keyFor(message)}>
        <ProfileAvatar displayName={author.displayName} avatar={author.avatar}/>
        <div className="message-notification-content">
          <small><MessageCircle size={12}/> Nova mensagem</small>
          <strong>{author.displayName}</strong>
          <p>{message.editedContent ?? message.content}</p>
        </div>
        <button type="button" onClick={() => dismiss(keyFor(message))} aria-label="Fechar aviso"><X size={16}/></button>
      </article>;
    })}
  </aside>;
}
