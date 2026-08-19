const DATABASE = "risk-offline";
const VERSION = 2;

export const OFFLINE_STORES = {
  messages: "chat-messages",
  identity: "identity",
  friends: "friends",
  groups: "groups",
} as const;

export function openRiskDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      const messages = database.objectStoreNames.contains(OFFLINE_STORES.messages)
        ? request.transaction!.objectStore(OFFLINE_STORES.messages)
        : database.createObjectStore(OFFLINE_STORES.messages, { keyPath: "id" });
      if (!messages.indexNames.contains("channelId")) messages.createIndex("channelId", "channelId", { unique: false });
      if (!database.objectStoreNames.contains(OFFLINE_STORES.identity)) database.createObjectStore(OFFLINE_STORES.identity, { keyPath: "id" });
      if (!database.objectStoreNames.contains(OFFLINE_STORES.friends)) database.createObjectStore(OFFLINE_STORES.friends, { keyPath: "peerId" });
      if (!database.objectStoreNames.contains(OFFLINE_STORES.groups)) database.createObjectStore(OFFLINE_STORES.groups, { keyPath: "groupId" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB indisponível."));
  });
}

export function getAllFromStore<T>(storeName: string): Promise<T[]> {
  return withStore<T[]>(storeName, "readonly", (store) => store.getAll());
}

export function putInStore<T>(storeName: string, value: T): Promise<void> {
  return withStore<void>(storeName, "readwrite", (store) => store.put(value));
}

function asyncRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Falha no armazenamento local."));
  });
}

async function withStore<T>(storeName: string, mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest): Promise<T> {
  const database = await openRiskDatabase();
  try { return await asyncRequest(operation(database.transaction(storeName, mode).objectStore(storeName))) as T; }
  finally { database.close(); }
}
