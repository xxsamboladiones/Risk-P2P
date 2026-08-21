/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
  readonly VITE_DEBUG_SIGNALING?: string;
  readonly VITE_ICE_SERVERS_JSON?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

type RiskDesktopSource = {
  id: string;
  name: string;
  displayId: string;
  thumbnail: string;
};

type RiskDesktopBackendConfig = {
  baseUrl: string;
  token: string;
};

interface Window {
  desktop?: {
    listScreenSources(): Promise<RiskDesktopSource[]>;
    chooseScreenSource(): Promise<string | null>;
    selectScreenSource(sourceId: string): Promise<void>;
    setWindowFullscreen(enabled: boolean): Promise<{ fullscreen: boolean }>;
    getBackendConfig(): Promise<RiskDesktopBackendConfig>;
  };
}
