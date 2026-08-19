import React, { useEffect, useState } from "react";
import {
  loadLocalGroups,
  type LocalGroup,
  type PublicGroupMetadata,
} from "../services/offline/social-storage";
import { P2PInvitePanel } from "./P2PInvitePanel";

export function GroupInvitePanel({
  token,
  displayName,
  initialMode = "join",
  preferredGroupId,
  onComplete,
}: {
  token: string;
  displayName: string;
  initialMode?: "create" | "join";
  preferredGroupId?: string;
  onComplete?(): void;
}) {
  const [groups, setGroups] = useState<LocalGroup[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [loading, setLoading] = useState(initialMode === "create");
  const [error, setError] = useState("");

  useEffect(() => {
    if (initialMode !== "create") return;
    let alive = true;
    void loadLocalGroups()
      .then((localGroups) => {
        if (!alive) return;
        const available = preferredGroupId
          ? localGroups.filter((group) => group.groupId === preferredGroupId)
          : localGroups;
        setGroups(available);
        setSelectedId((current) => {
          if (current && available.some((group) => group.groupId === current)) return current;
          return available[0]?.groupId ?? "";
        });
      })
      .catch((cause) => {
        if (alive) setError(cause instanceof Error ? cause.message : "Falha ao carregar grupos locais");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [initialMode, preferredGroupId]);

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
    <label>Grupo local que receberá o membro</label>
    <select
      value={selectedId}
      onChange={(event) => setSelectedId(event.target.value)}
      disabled={loading || groups.length === 0 || Boolean(preferredGroupId)}
    >
      <option value="">{loading ? "Carregando grupo…" : "Selecione um grupo local"}</option>
      {groups.map((group) => <option key={group.groupId} value={group.groupId}>{group.name}</option>)}
    </select>
    {!loading && groups.length === 0 && <p className="invite-notice">
      {preferredGroupId
        ? "Este grupo não é local. Convites P2P não podem misturar memberships locais com grupos mantidos pelo backend."
        : "Crie um grupo local antes de gerar um convite P2P."}
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
