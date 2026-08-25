import { useState, type FormEvent } from "react";
import { Camera, Trash2 } from "lucide-react";
import { avatarFromFile, saveLocalProfile, type LocalProfile } from "../services/offline/profile";
import { ProfileAvatar } from "./ProfileAvatar";

export function ProfileEditor({ profile, onSaved }: { profile: LocalProfile; onSaved(profile: LocalProfile): void }) {
  const [displayName, setDisplayName] = useState(profile.displayName);
  const [avatar, setAvatar] = useState(profile.avatar);
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
    try { onSaved(await saveLocalProfile(displayName, avatar)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível salvar o perfil."); }
    finally { setBusy(false); }
  }

  return <form className="profile-editor" onSubmit={(event) => void submit(event)}>
    <div className="profile-photo-editor">
      <ProfileAvatar displayName={displayName || profile.displayName} avatar={avatar} className="profile-avatar-preview"/>
      <div>
        <label className="profile-file-button"><Camera size={17}/> Escolher imagem<input type="file" accept="image/png,image/jpeg,image/webp" disabled={busy} onChange={(event) => void chooseAvatar(event.target.files?.[0])}/></label>
        {avatar && <button type="button" className="profile-remove-photo" disabled={busy} onClick={() => setAvatar(undefined)}><Trash2 size={15}/> Remover</button>}
      </div>
    </div>
    <label className="profile-name-field">Nome exibido<input value={displayName} minLength={2} maxLength={80} onChange={(event) => setDisplayName(event.target.value)} required/></label>
    <small>A foto é reduzida no seu dispositivo e enviada aos participantes diretamente pelo WebRTC.</small>
    {error && <div className="invite-notice error">{error}</div>}
    <button disabled={busy}>{busy ? "Salvando…" : "Salvar perfil"}</button>
  </form>;
}
