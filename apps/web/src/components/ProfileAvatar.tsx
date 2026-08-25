import { validAvatarDataUrl } from "../services/offline/profile";

export function ProfileAvatar({ displayName, avatar, className = "" }: { displayName: string; avatar?: string; className?: string }) {
  const initials = displayName.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "EU";
  return <span className={`profile-avatar ${className}`.trim()} aria-label={`Foto de ${displayName}`}>
    {validAvatarDataUrl(avatar) ? <img src={avatar} alt=""/> : <span>{initials}</span>}
  </span>;
}
