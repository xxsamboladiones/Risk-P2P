import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { RiskApplicationProvider } from "./application/ApplicationContext";
import { riskApplication } from "./application/runtime";
import { AppErrorBoundary } from "./components/AppErrorBoundary";
import { DesktopRecoveryNotice } from "./components/DesktopRecoveryNotice";
import "./styles.css";
import "./components/modal-layout.css";

createRoot(document.getElementById("root")!).render(<React.StrictMode>
  <RiskApplicationProvider application={riskApplication}>
    <AppErrorBoundary><App/></AppErrorBoundary>
    <DesktopRecoveryNotice/>
  </RiskApplicationProvider>
</React.StrictMode>);
