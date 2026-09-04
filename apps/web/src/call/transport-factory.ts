import {
  CallTransportRegistry,
  MeshTransport,
  selectCallTransport,
  type CallNetworkHealth,
  type CallTransport,
  type CallTransportCreationContext,
  type CallTransportDecision,
  type CallTransportPreference,
} from "@risk/rtc";

/** Registro padrão; provedores SFU podem compor um registro alternativo. */
export const defaultCallTransportRegistry = new CallTransportRegistry({
  mesh: ({ localPeerId, iceServers, events, networkInterfaces, networkPreference }) => (
    new MeshTransport(localPeerId, iceServers, events, { networkInterfaces, networkPreference })
  ),
});

export type CreateCallTransportOptions = CallTransportCreationContext & {
  participantCount: number;
  preference?: CallTransportPreference;
  network?: CallNetworkHealth;
  registry?: CallTransportRegistry;
};

export type CreatedCallTransport = {
  transport: CallTransport;
  decision: CallTransportDecision;
};

export function createCallTransport(options: CreateCallTransportOptions): CreatedCallTransport {
  const registry = options.registry ?? defaultCallTransportRegistry;
  const decision = selectCallTransport({
    participantCount: options.participantCount,
    preference: options.preference,
    sfuAvailable: registry.has("sfu"),
    network: options.network,
  });
  return {
    transport: registry.create(decision.selected, options),
    decision,
  };
}
