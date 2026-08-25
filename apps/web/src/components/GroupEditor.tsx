import { useState, type FormEvent } from "react";
import { Camera, Trash2 } from "lucide-react";
import { avatarFromFile } from "../services/offline/profile";
import { updateLocalGroupProfile, type LocalGroup } from "../services/offline/social-storage";
import { ProfileAvatar } from "./ProfileAvatar";

export function GroupEditor({ group, onSaved }: { group: LocalGroup; onSaved(group: LocalGroup): void }) {
  const [name, setName] = useState(group.name);
  const [avatar, setAvatar] = useState(group.avatar);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function chooseAvatar(file?: File): Promise<void> {
    if (!file) return;
    setBusy(true);
    setError("");
    try { setAvatar(await avatarFromFile(file)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível usar essa imagem."); }
    finally { setBusy(false); }
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError("");
    try { onSaved(await updateLocalGroupProfile(group.groupId, name, avatar)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível salvar o grupo."); }
    finally { setBusy(false); }
  }

  return <form className="profile-editor group-editor" onSubmit={(event) => void submit(event)}>
    <div className="profile-photo-editor">
      <ProfileAvatar displayName={name || group.name} avatar={avatar} className="profile-avatar-preview group-avatar-preview"/>
      <div>
        <label className="profile-file-button"><Camera size={17}/> Escolher imagem<input type="file" accept="image/png,image/jpeg,image/webp" disabled={busy} onChange={(event) => void chooseAvatar(event.target.files?.[0])}/></label>
        {avatar && <button type="button" className="profile-remove-photo" disabled={busy} onClick={() => setAvatar(undefined)}><Trash2 size={15}/> Remover</button>}
      </div>
    </div>
    <label className="profile-name-field">Nome do grupo<input value={name} minLength={2} maxLength={80} onChange={(event) => setName(event.target.value)} required/></label>
    <small>A personalização fica no seu dispositivo e é sincronizada diretamente aos membros pelo WebRTC.</small>
    {error && <div className="invite-notice error">{error}</div>}
    <button disabled={busy}>{busy ? "Salvando…" : "Salvar grupo"}</button>
  </form>;
}
