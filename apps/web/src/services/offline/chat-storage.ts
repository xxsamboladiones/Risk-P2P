export type LocalChatMessage = {
  id: string;
  channelId: string;
  author: string;
  content: string;
  createdAt: string;
};

import { OFFLINE_STORES, openRiskDatabase } from "./database";
const STORE = OFFLINE_STORES.messages;

export async function loadLocalMessages(channelId: string): Promise<LocalChatMessage[]> {
  const database = await openRiskDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE, "readonly");
    const index = transaction.objectStore(STORE).index("channelId");
    const request = index.getAll(IDBKeyRange.only(channelId));
    request.onsuccess = () => resolve((request.result as LocalChatMessage[]).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(-200));
    request.onerror = () => reject(request.error ?? new Error("Falha ao ler o histórico local."));
    transaction.oncomplete = () => database.close();
  });
}

export async function saveLocalMessage(message: LocalChatMessage): Promise<void> {
  const database = await openRiskDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE, "readwrite");
    transaction.objectStore(STORE).put(message);
    transaction.oncomplete = () => { database.close(); resolve(); };
    transaction.onerror = () => { database.close(); reject(transaction.error ?? new Error("Falha ao salvar a mensagem local.")); };
  });
}
