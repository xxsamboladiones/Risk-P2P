import { useState } from "react";
import { LocalStoragePanel } from "../components/LocalStoragePanel";
import { NetworkSettingsPanel } from "../components/NetworkSettingsPanel";
import { VoiceVideoSettingsPanel } from "../components/VoiceVideoSettingsPanel";

export function SettingsView() {
  const [tab, setTab] = useState<"voice" | "network" | "storage">("voice");
  return <>
    <nav className="settings-tabs" aria-label="Seções das configurações">
      <button className={tab === "voice" ? "active" : ""} onClick={() => setTab("voice")}>Voz e vídeo</button>
      <button className={tab === "network" ? "active" : ""} onClick={() => setTab("network")}>Rede</button>
      <button className={tab === "storage" ? "active" : ""} onClick={() => setTab("storage")}>Armazenamento</button>
    </nav>
    {tab === "voice" && <VoiceVideoSettingsPanel/>}
    {tab === "network" && <NetworkSettingsPanel/>}
    {tab === "storage" && <LocalStoragePanel/>}
  </>;
}
