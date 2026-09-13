import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { loadLocalFriends, loadLocalGroups, loadLocalIdentity } from "../services/offline/social-storage";
import { resolveMessageAuthor, type ChatAuthorProfile } from "../services/chat/message-author";
import type { ChatMessage } from "../application/contracts";

const ChatProfilesContext = createContext<ChatAuthorProfile[]>([]);

export function ChatProfiles({ children }: { children: ReactNode }) {
  const [profiles, setProfiles] = useState<ChatAuthorProfile[]>([]);
  useEffect(() => {
    let generation = 0;
    const refresh = () => {
      const current = ++generation;
      void Promise.all([loadLocalGroups(), loadLocalFriends(), loadLocalIdentity()]).then(([groups, friends, identity]) => {
        if (generation !== current) return;
        const entries = [...groups.flatMap((group) => [...(group.members ?? []), ...(group.removedMembers ?? [])]), ...friends, ...(identity ? [identity] : [])];
        setProfiles([...new Map(entries.map((profile) => [profile.peerId, profile])).values()]);
      }).catch((error) => console.warn("Não foi possível carregar fotos do chat.", error));
    };
    refresh();
    window.addEventListener("risk:social-updated", refresh);
    return () => { generation++; window.removeEventListener("risk:social-updated", refresh); };
  }, []);
  return <ChatProfilesContext.Provider value={profiles}>{children}</ChatProfilesContext.Provider>;
}

export function useMessageAuthor(): (message: Pick<ChatMessage, "author" | "authorPeerId">) => ChatAuthorProfile {
  const profiles = useContext(ChatProfilesContext);
  return (message) => resolveMessageAuthor(message, profiles);
}
