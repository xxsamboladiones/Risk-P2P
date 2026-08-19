import React, { useEffect, useMemo, useState } from "react";
import { api } from "../api";
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
  const preferredMetadata = useMemo<PublicGroupMetadata | undefined>(() => {
    if (!preferredGroupId || !preferredGroupName) return undefined;
    return {
      groupId: preferredGroupId,
      name: preferredGroupName,
      channels: preferredGroupChannels ?? [],
    };
  }, [preferredGroupChannels, preferredGroupId, preferredGroupName]);

  const [groups, setGroups] = useState<LocalGroup[]>([]);
  const [selectedId, setSelectedId] = useState(preferredGroupId ?? "");
  const [loading, setLoading] = useState(initialMode === "create" && !preferredMetadata);
  const [error, setError] = useState("");

  useEffect(() => {
    if (initialMode !== "create") return;
    let alive = true;

    void (async () => {
      setError("");
      let localGroups = await loadLocalGroups();

      if (preferredGroupId) {
        const existing = localGroups.find((group) => group.groupId === preferredGroupId);
        if (!existing) {
          let metadata = preferredMetadata;
          if (!metadata) {
            const communities = await api.communities(token);
            const community = communities.find((group) => group.id === preferredGroupId);
            if (!community) throw new Error("Grupo selecionado não foi encontrado.");
            metadata = {
              groupId: preferredGroupId,
              name: community.name,
              channels: await api.channels(token, preferredGroupId).catch(() => []),
            };
          }

          // Persistência é desejável para o histórico local, mas não deve bloquear a
          // criação do código. O convite usa os metadados recebidos diretamente do
          // grupo selecionado e o grupo será salvo novamente quando o handshake for
          // aceito/concluído.
          try {
            const identity = await getOrCreateLocalIdentity(displayName);
            await ensureLocalGroup(
              metadata.groupId,
              metadata.name,
              publicIdentity(identity),
              metadata.channels,
            );
            localGroups = await loadLocalGroups();
            window.dispatchEvent(new Event("risk:social-updated"));
          } catch (cause) {
            console.warn("Não foi possível preparar o grupo no armazenamento P2P antes do convite", cause);
          }
        }
      }

      if (!alive) return;
      const available = preferredGroupId
        ? localGroups.filter((group) => group.groupId === preferredGroupId)
        : localGroups;
      setGroups(available);
      setSelectedId((current) => {
        if (preferredGroupId) return preferredGroupId;
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
  }, [displayName, initialMode, preferredGroupId, preferredMetadata, token]);

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
    : preferredMetadata && selectedId === preferredMetadata.groupId
      ? preferredMetadata
      : undefined;

  return <div className="group-invite-panel">
    <label>Grupo que receberá o membro</label>
    <select
      value={selectedId}
      onChange={(event) => setSelectedId(event.target.value)}
      disabled={loading || Boolean(preferredGroupId) || (!preferredMetadata && groups.length === 0)}
    >
      <option value="">{loading ? "Preparando grupo…" : "Selecione um grupo"}</option>
      {preferredMetadata && !groups.some((group) => group.groupId === preferredMetadata.groupId) && (
        <option value={preferredMetadata.groupId}>{preferredMetadata.name}</option>
      )}
      {groups.map((group) => <option key={group.groupId} value={group.groupId}>{group.name}</option>)}
    </select>
    {!loading && !metadata && <p className="invite-notice">
      {error
        ? "Não foi possível preparar este grupo para convites P2P."
        : "Crie um grupo antes de gerar um convite P2P."}
    </p>}
    {error && metadata && <div className="invite-notice">O armazenamento local será sincronizado quando o convite for concluído.</div>}
    {error && !metadata && <div className="invite-notice error">{error}</div>}
    <P2PInvitePanel
      key={metadata?.groupId ?? selectedId || "create-unavailable"}
      type="group"
      token={token}
      displayName={displayName}
      group={metadata}
      initialMode="create"
      onComplete={onComplete}
    />
  </div>;
}
