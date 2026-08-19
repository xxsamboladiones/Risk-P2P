import React, { useEffect, useState } from "react";
import { api, type Channel, type Community } from "../api";
import { loadLocalGroups, type PublicGroupMetadata } from "../services/offline/social-storage";
import { P2PInvitePanel } from "./P2PInvitePanel";

export function GroupInvitePanel({ token, displayName, initialMode = "join", preferredGroupId, onComplete }: {
  token: string;
  displayName: string;
  initialMode?: "create" | "join";
  preferredGroupId?: string;
  onComplete?(): void;
}) {
  const [groups, setGroups] = useState<Community[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [metadata, setMetadata] = useState<PublicGroupMetadata>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    void Promise.all([api.communities(token).catch(() => []), loadLocalGroups()])
      .then(([remote, local]) => {
        if (!alive) return;
        const merged = [...remote];
        local.forEach((group) => {
          const existing = merged.find((item) => item.id === group.groupId);
          if (existing) existing.local = true;
          else merged.push({ id: group.groupId, name: group.name, local: true });
        });
        setGroups(merged);
        setSelectedId((current) => {
          if (current && merged.some((item) => item.id === current)) return current;
          if (preferredGroupId && merged.some((item) => item.id === preferredGroupId)) return preferredGroupId;
          return merged[0]?.id ?? "";
        });
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : "Falha ao carregar grupos locais"))
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [token, preferredGroupId]);

  useEffect(() => {
    if (!selectedId) { setMetadata(undefined); return; }
    let alive = true;
    const selected = groups.find((group) => group.id === selectedId);
    if (!selected) return;
    const channels: Promise<Channel[]> = selected.local
      ? loadLocalGroups().then((items) => items.find((group) => group.groupId === selected.id)?.channels ?? [])
      : api.channels(token, selected.id);
    void channels
      .then((items) => { if (alive) { setError(""); setMetadata({ groupId: selected.id, name: selected.name, channels: items }); } })
      .catch((cause) => { if (alive) { setMetadata(undefined); setError(cause instanceof Error ? cause.message : "Falha ao carregar o grupo"); } });
    return () => { alive = false; };
  }, [groups, selectedId, token]);

  return <div className="group-invite-panel">
    <label>Grupo que receberá o membro</label>
    <select value={selectedId} onChange={(event) => setSelectedId(event.target.value)} disabled={loading || groups.length === 0}>
      <option value="">{loading ? "Carregando grupos…" : "Selecione um grupo"}</option>
      {groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
    </select>
    {!loading && groups.length === 0 && <p className="invite-notice">Crie um grupo antes de gerar um convite. Ainda é possível usar um código recebido.</p>}
    {error && <div className="invite-notice error">{error}</div>}
    <P2PInvitePanel key={selectedId || "join-only"} type="group" token={token} displayName={displayName} group={metadata} initialMode={initialMode} onComplete={onComplete}/>
  </div>;
}
