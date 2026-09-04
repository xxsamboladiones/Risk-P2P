export type CallNetworkInterface = { provider: string };

export function callConnectionRecoveryMessage(
  turnAvailable: boolean,
  networkInterfaces: readonly CallNetworkInterface[],
): string {
  const vpn = networkInterfaces.find((networkInterface) => networkInterface.provider !== "unknown");
  if (vpn) {
    const label = vpn.provider === "zerotier"
      ? "ZeroTier"
      : vpn.provider === "tailscale"
        ? "Tailscale"
        : vpn.provider === "wireguard"
          ? "WireGuard"
          : "VPN";
    return `A conexão WebRTC foi interrompida com ${label} disponível. Tentando restabelecer automaticamente pela rede privada…`;
  }
  if (turnAvailable) {
    return "A conexão WebRTC foi interrompida. Tentando restabelecer automaticamente com ICE/TURN…";
  }
  return "A conexão WebRTC foi interrompida. Tentando restabelecer automaticamente. Se ela não recuperar, configure TURN para redes NAT/CGNAT ou firewalls restritivos.";
}

export class ConnectionRecovery {
  private readonly recoveringPeers = new Set<string>();
  private failureMessage?: string;
  private turnAvailable = false;
  private networkInterfaces: readonly CallNetworkInterface[] = [];

  begin(turnAvailable: boolean, networkInterfaces: readonly CallNetworkInterface[]): void {
    this.reset();
    this.turnAvailable = turnAvailable;
    this.networkInterfaces = networkInterfaces;
  }

  failed(peerId: string): string {
    this.recoveringPeers.add(peerId);
    this.failureMessage = callConnectionRecoveryMessage(this.turnAvailable, this.networkInterfaces);
    return this.failureMessage;
  }

  finish(peerId: string, displayedError: string | null): boolean {
    this.recoveringPeers.delete(peerId);
    if (this.recoveringPeers.size > 0 || displayedError !== this.failureMessage) return false;
    this.failureMessage = undefined;
    return true;
  }

  reset(): void {
    this.recoveringPeers.clear();
    this.failureMessage = undefined;
    this.turnAvailable = false;
    this.networkInterfaces = [];
  }
}
