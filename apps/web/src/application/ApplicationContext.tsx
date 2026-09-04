import { createContext, useContext, type ReactNode } from "react";
import type { RiskApplication } from "./RiskApplication";

const Context = createContext<RiskApplication | null>(null);

export function RiskApplicationProvider({ application, children }: {
  application: RiskApplication;
  children: ReactNode;
}) {
  return <Context.Provider value={application}>{children}</Context.Provider>;
}

export function useRiskApplication(): RiskApplication {
  const application = useContext(Context);
  if (!application) throw new Error("RiskApplicationProvider não foi configurado.");
  return application;
}
