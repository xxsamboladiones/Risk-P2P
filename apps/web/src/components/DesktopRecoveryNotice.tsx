import { useEffect, useState } from "react";
import { useRiskApplication } from "../application/ApplicationContext";

export function DesktopRecoveryNotice() {
  const application = useRiskApplication();
  const [status, setStatus] = useState<RiskDesktopBackendStatus>();

  useEffect(() => window.desktop?.onBackendStatus?.((next) => {
    application.backendChanged();
    setStatus(next);
  }), [application]);

  if (!status) return null;
  return <button
    className={`desktop-recovery-notice ${status.state}`}
    onClick={() => setStatus(undefined)}
    title="Clique para fechar"
  >{status.message}</button>;
}
