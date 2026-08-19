import React, { useEffect, useState } from "react";
import {
  ensureLocalGroup,
  getOrCreateLocalIdentity,
  loadLocalGroups,
  publicIdentity,
  type LocalGroup,
  type LocalGroupChannel,
  type PublicGroupMetadata,
} from "../services/offline/social-storage";
import { P2PInvitePanel } from "./P2PInvitePanel";

export function GroupInvitePanel({
  token,
  displayName,
  initialMode = "join",
  preferredGroupId,
  preferredGroupName,
  preferredGroupChannels,
  onComplete,
}: {
  token: string;
  displayName: string;
  initialMode?: "create" | "join";
  preferredGroupId?: string;
  preferredGroupName?: string;
  preferredGroupChannels?: LocalGroupChannel[];
  onComplete?(): void;
}) {
  const [groups, setGroups] = useState<LocalGroup[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [loading, setLoading] = useState(initialMode === "create");
  const [error, setError] = useState("");

  useEffect(() => {
    if (initialMode !== "create") return;
    let alive = true;

    void (async () => {
      let localGroups = await loadLocalGroups();

      // Grupos criados antes da migração para o armazenamento P2P/SQLite podem
      // existir apenas na tabela `communities`. Ao abrir o fluxo de convite,
      // promovemos o grupo selecionado para uma representação P2P local com o
      // mesmo id/nome/canais. Isso evita bloquear convites de grupos legados e
      // mantém os metadados usados pelo DataChannel no mesmo SQLite do desktop.
      if (
        preferredGroupId
        && preferredGroupName
        && !localGroups.some((group) => group.groupId === preferredGroupId)
      ) {
        const identity = await getOrCreateLocalIdentity(displayName);
        await ensureLocalGroup(
          preferredGroupId,
          preferredGroupName,
          publicIdentity(identity),
          preferredGroupChannels ?? [],
        );
        localGroups = await loadLocalGroups();
        window.dispatchEvent(new Event("risk:social-updated"));
      }

      if (!alive) return;
      const available = preferredGroupId
        ? localGroups.filter((group) => group.groupId === preferredGroupId)
        : localGroups;
      setGroups(available);
      setSelectedId((current) => {
        if (current && available.some((group) => group.groupId === current)) return current;
        return available[0]?.groupId ?? "";
      });
    })()
      .catch((cause) => {
        if (alive) setError(cause instanceof Error ? cause.message : "Falha ao carregar grupo para o convite");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });

    return () => {
      alive = false;
    };
  }, [displayName, initialMode, preferredGroupChannels, preferredGroupId, preferredGroupName]);

  if (initialMode === "join") {
    return <div className="group-invite-panel">
      <P2PInvitePanel
        type="group"
        token={token}
        displayName={displayName}
        initialMode="join"
        onComplete={onComplete}
      />
    </div>;
  }

  const selected = groups.find((group) => group.groupId === selectedId);
  const metadata: PublicGroupMetadata | undefined = selected
    ? {
        groupId: selected.groupId,
        name: selected.name,
        avatar: selected.avatar,
        channels: selected.channels,
      }
    : undefined;

  return <div className="group-invite-panel">
    <label>Grupo que receberá o membro</label>
    <select
      value={selectedId}
      onChange={(event) => setSelectedId(event.target.value)}
      disabled={loading || groups.length === 0 || Boolean(preferredGroupId)}
    >
      <option value="">{loading ? "Preparando grupo…" : "Selecione um grupo"}</option>
      {groups.map((group) => <option key={group.groupId} value={group.groupId}>{group.name}</option>)}
    </select>
    {!loading && groups.length === 0 && <p className="invite-notice">
      {error
        ? "Não foi possível preparar este grupo para convites P2P."
        : "Crie um grupo antes de gerar um convite P2P."}
    </p>}
    {error && <div className="invite-notice error">{error}</div>}
    <P2PInvitePanel
      key={selectedId || "create-unavailable"}
      type="group"
      token={token}
      displayName={displayName}
      group={metadata}
      initialMode="create"
      onComplete={onComplete}
    />
  </div>;
}
