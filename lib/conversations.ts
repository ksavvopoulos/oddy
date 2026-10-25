import type { StoredConversation, ConversationSummary } from './conversation-model';
import { conversationIdsToDelete, type HistoryLimits } from './history-policy';
export type {
  StoredConversation,
  StoredTranscriptItem,
  StoredMutationApprovalState,
  StoredListMembershipApprovalState,
  StoredSkillChangeApprovalState,
  ConversationSummary
} from './conversation-model';

const DATABASE_NAME = 'oddy-local-history';
const DATABASE_VERSION = 1;
const STORE_NAME = 'conversations';

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed.'));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error || new Error('IndexedDB transaction failed.'));
    transaction.onabort = () =>
      reject(transaction.error || new Error('IndexedDB transaction was aborted.'));
  });
}

async function openDatabase(): Promise<IDBDatabase> {
  if (!globalThis.indexedDB) throw new Error('Local conversation storage is unavailable.');
  const request = globalThis.indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
  request.onupgradeneeded = () => {
    const database = request.result;
    if (!database.objectStoreNames.contains(STORE_NAME)) {
      const store = database.createObjectStore(STORE_NAME, { keyPath: 'id' });
      store.createIndex('updatedAt', 'updatedAt');
    }
  };
  return requestResult(request);
}

/** All requests share connection cleanup and await transaction commit, not just request success. */
async function withStore<Result>(
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => Result | Promise<Result>
): Promise<Result> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(STORE_NAME, mode);
    const done = transactionDone(transaction);
    try {
      const [result] = await Promise.all([work(transaction.objectStore(STORE_NAME)), done]);
      return result;
    } catch (error) {
      // A failed callback must not leave a partially completed write transaction.
      try {
        transaction.abort();
      } catch {
        /* The transaction may already have settled. */
      }
      await done.catch(() => undefined);
      throw error;
    }
  } finally {
    database.close();
  }
}

async function pruneStore(store: IDBObjectStore, limits: HistoryLimits): Promise<void> {
  const conversations = await requestResult(store.getAll() as IDBRequest<StoredConversation[]>);
  for (const id of conversationIdsToDelete(conversations, limits)) store.delete(id);
}

export async function saveConversation(
  conversation: StoredConversation,
  limits: HistoryLimits
): Promise<void> {
  // Saving and pruning in one transaction avoids deleting a concurrently updated conversation.
  await withStore('readwrite', async (store) => {
    store.put(conversation);
    await pruneStore(store, limits);
  });
}

export async function getConversation(id: string): Promise<StoredConversation | undefined> {
  return withStore('readonly', (store) =>
    requestResult(store.get(id) as IDBRequest<StoredConversation | undefined>)
  );
}

export async function listConversations(): Promise<ConversationSummary[]> {
  const conversations = await withStore('readonly', (store) =>
    requestResult(store.getAll() as IDBRequest<StoredConversation[]>)
  );
  return conversations
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .map((conversation) => ({
      id: conversation.id,
      title: conversation.title,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
      environmentName: conversation.environmentName,
      tableLogicalName: conversation.tableLogicalName,
      messageCount: conversation.transcript.length
    }));
}

export async function deleteConversation(id: string): Promise<void> {
  await withStore('readwrite', (store) => {
    store.delete(id);
  });
}

export async function clearConversations(): Promise<void> {
  await withStore('readwrite', (store) => {
    store.clear();
  });
}

export async function pruneConversations(limits: HistoryLimits): Promise<void> {
  await withStore('readwrite', (store) => pruneStore(store, limits));
}
