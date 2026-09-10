import { useState } from "react";
import { LocalStoragePanel } from "../components/LocalStoragePanel";
import { NetworkSettingsPanel } from "../components/NetworkSettingsPanel";
import { VoiceVideoSettingsPanel } from "../components/VoiceVideoSettingsPanel";
import { AppearanceSettingsPanel } from "../components/AppearanceSettingsPanel";

export function SettingsView() {
  const [tab, setTab] = useState<"voice" | "appearance" | "network" | "storage">("voice");
  return <>
    <nav className="settings-tabs" aria-label="Seções das configurações">
      <button className={tab === "voice" ? "active" : ""} onClick={() => setTab("voice")}>Voz e vídeo</button>
      <button className={tab === "appearance" ? "active" : ""} onClick={() => setTab("appearance")}>Aparência</button>
      <button className={tab === "network" ? "active" : ""} onClick={() => setTab("network")}>Rede</button>
      <button className={tab === "storage" ? "active" : ""} onClick={() => setTab("storage")}>Armazenamento</button>
    </nav>
    {tab === "voice" && <VoiceVideoSettingsPanel/>}
    {tab === "appearance" && <AppearanceSettingsPanel/>}
    {tab === "network" && <NetworkSettingsPanel/>}
    {tab === "storage" && <LocalStoragePanel/>}
  </>;
}
