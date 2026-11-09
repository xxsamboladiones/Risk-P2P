import React from "react";
import { Copy, RefreshCw, Sparkles } from "lucide-react";
import { RISK_APP_VERSION } from "../services/protocol-compatibility";
import { copyText } from "../services/clipboard/copy-text";

type State = { error?: Error; copied: boolean; copyFailed?: boolean };

export class AppErrorBoundary extends React.Component<React.PropsWithChildren, State> {
  override state: State = { copied: false };

  static getDerivedStateFromError(error: Error): State {
    return { error, copied: false, copyFailed: false };
  }

  override componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error("[renderer] falha de interface capturada", {
      name: error.name,
      message: error.message,
      componentStack: import.meta.env.DEV ? info.componentStack : undefined,
    });
  }

  private report(): string {
    return JSON.stringify({
      app: "Risk",
      version: RISK_APP_VERSION,
      platform: navigator.platform,
      error: this.state.error?.name ?? "Error",
      message: this.state.error?.message ?? "Falha desconhecida",
      occurredAt: new Date().toISOString(),
    }, null, 2);
  }

  private async copyReport(): Promise<void> {
    try {
      await copyText(this.report());
      this.setState({ copied: true, copyFailed: false });
    } catch {
      this.setState({ copied: false, copyFailed: true });
    }
  }

  override render(): React.ReactNode {
    if (!this.state.error) return this.props.children;
    return <main className="fatal-recovery" role="alert">
      <div className="fatal-recovery-card">
        <Sparkles/>
        <h1>O Risk encontrou um problema na interface</h1>
        <p>Seus dados locais não foram apagados. Recarregue a janela para tentar recuperar o aplicativo.</p>
        <small>{this.state.error.message || "Falha inesperada do renderer."}</small>
        <div>
          <button onClick={() => window.location.reload()}><RefreshCw/> Recarregar Risk</button>
          <button className="secondary" onClick={() => void this.copyReport()}><Copy/> {this.state.copied ? "Relatório copiado" : this.state.copyFailed ? "Não foi possível copiar" : "Copiar diagnóstico"}</button>
        </div>
      </div>
    </main>;
  }
}
