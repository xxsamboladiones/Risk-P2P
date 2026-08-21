import { loadLocalGroups, saveLocalGroup, type LocalGroupChannel } from "./social-storage";

function validateChannelName(name: string): string {
  const normalized = name.trim();
  if (normalized.length < 2 || normalized.length > 80) {
    throw new Error("O nome do canal deve ter entre 2 e 80 caracteres.");
  }
  return normalized;
}

export async function renameLocalGroupChannel(
  groupId: string,
  channelId: string,
  name: string,
): Promise<LocalGroupChannel> {
  const group = (await loadLocalGroups()).find((item) => item.groupId === groupId);
  if (!group) throw new Error("Grupo local não encontrado.");

  const index = group.channels.findIndex((channel) => channel.id === channelId);
  if (index < 0) throw new Error("Canal não encontrado.");

  const updated: LocalGroupChannel = {
    ...group.channels[index]!,
    name: validateChannelName(name),
  };
  group.channels[index] = updated;
  await saveLocalGroup(group);
  return updated;
}

export async function deleteLocalGroupChannel(groupId: string, channelId: string): Promise<void> {
  const group = (await loadLocalGroups()).find((item) => item.groupId === groupId);
  if (!group) throw new Error("Grupo local não encontrado.");

  const index = group.channels.findIndex((channel) => channel.id === channelId);
  if (index < 0) throw new Error("Canal não encontrado.");

  group.channels.splice(index, 1);
  await saveLocalGroup(group);
}
