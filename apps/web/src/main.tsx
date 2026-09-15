import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { RiskApplicationProvider } from "./application/ApplicationContext";
import { riskApplication } from "./application/runtime";
import { AppErrorBoundary } from "./components/AppErrorBoundary";
import { DesktopRecoveryNotice } from "./components/DesktopRecoveryNotice";
import "./styles.css";
import "./components/modal-layout.css";
import "./components/theme-overrides.css";
import { initializeTheme } from "./services/theme/settings";
import { installRendererPerformanceProbe } from "./performance/probe";
import { PerformanceRuntimeBridge } from "./performance/PerformanceRuntimeBridge";

initializeTheme();

if (window.desktop?.onPerformanceRendererCaptureStart
  && window.desktop.onPerformanceRendererSnapshotRequest
  && window.desktop.reportPerformanceRendererSnapshot) {
  installRendererPerformanceProbe({
    onStartCapture: window.desktop.onPerformanceRendererCaptureStart,
    onRequestSnapshot: window.desktop.onPerformanceRendererSnapshotRequest,
    reportSnapshot: window.desktop.reportPerformanceRendererSnapshot,
  });
}

createRoot(document.getElementById("root")!).render(<React.StrictMode>
  <RiskApplicationProvider application={riskApplication}>
    <PerformanceRuntimeBridge/>
    <AppErrorBoundary><App/></AppErrorBoundary>
    <DesktopRecoveryNotice/>
  </RiskApplicationProvider>
</React.StrictMode>);
