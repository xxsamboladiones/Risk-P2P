export function findConnectedGamepad(
  pads: readonly (Gamepad | null)[],
  preferredIndex?: number,
): Gamepad | undefined {
  const usable = pads.filter((pad): pad is Gamepad => Boolean(
    pad?.connected && (pad.axes.length > 0 || pad.buttons.length > 0),
  ));
  if (preferredIndex !== undefined) {
    const preferred = usable.find((pad) => pad.index === preferredIndex);
    if (preferred) return preferred;
  }
  return usable.find((pad) => pad.mapping === "standard") ?? usable[0];
}
