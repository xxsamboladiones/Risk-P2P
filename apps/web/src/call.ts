// Fachada compatível: consumidores existentes continuam importando `./call`,
// enquanto as responsabilidades vivem em módulos menores dentro de `call/`.
export { CallController } from "./call/CallController";
export type { CallJoinOptions } from "./call/CallSession";
export type { CallDiagnostics } from "./call/CallDiagnostics";
export { callConnectionRecoveryMessage } from "./call/ConnectionRecovery";
export { parseCallProfileMessage, reconcileRemoteMediaState } from "./call/ParticipantManager";
export { sameCallPublicKey } from "./call/auth/AuthenticationManager";
