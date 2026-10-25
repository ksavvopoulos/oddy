import type {
  DataverseMutationExecutionResult,
  MarketingListMembershipExecutionResult,
  OddySkillChangeExecutionResult,
  PreparedDataverseMutation,
  PreparedMarketingListMembership,
  PreparedOddySkillChange,
  ToolActivity
} from './types';

const DATABASE_NAME = 'oddy-local-history';
const DATABASE_VERSION = 1;
const STORE_NAME = 'conversations';

export interface StoredTranscriptItem {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  toolsUsed?: ToolActivity[];
  pendingMutations?: PreparedDataverseMutation[];
  pendingListMemberships?: PreparedMarketingListMembership[];
  pendingSkillChanges?: PreparedOddySkillChange[];
  historical?: boolean;
}

export interface StoredMutationApprovalState {
  selectedColumns: string[];
  status: 'pending' | 'approving' | 'approved' | 'rejected' | 'error';
  result?: DataverseMutationExecutionResult;
  error?: string;
}

export interface StoredListMembershipApprovalState {
  selectedMemberIds: string[];
  status: 'pending' | 'approving' | 'approved' | 'rejected' | 'error';
  result?: MarketingListMembershipExecutionResult;
  error?: string;
}

export interface StoredSkillChangeApprovalState {
  status: 'pending' | 'approving' | 'approved' | 'rejected' | 'error';
  result?: OddySkillChangeExecutionResult;
  error?: string;
}

export interface StoredConversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  environmentName?: string;
  environmentOrigin?: string;
  tableLogicalName?: string;
  transcript: StoredTranscriptItem[];
  mutationApprovals: Record<string, StoredMutationApprovalState>;
  listMembershipApprovals: Record<string, StoredListMembershipApprovalState>;
  skillChangeApprovals: Record<string, StoredSkillChangeApprovalState>;
}

export interface ConversationSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  environmentName?: string;
  tableLogicalName?: string;
  messageCount: number;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed.'));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('IndexedDB transaction failed.'));
    transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction was aborted.'));
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

export async function saveConversation(
  conversation: StoredConversation,
  limits: { maxConversations: number; retentionDays: number }
): Promise<void> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    transaction.objectStore(STORE_NAME).put(conversation);
    await transactionDone(transaction);
  } finally {
    database.close();
  }
  await pruneConversations(limits);
}

export async function getConversation(id: string): Promise<StoredConversation | undefined> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(STORE_NAME, 'readonly');
    const done = transactionDone(transaction);
    const result = await requestResult(
      transaction.objectStore(STORE_NAME).get(id) as IDBRequest<StoredConversation | undefined>
    );
    await done;
    return result;
  } finally {
    database.close();
  }
}

export async function listConversations(): Promise<ConversationSummary[]> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(STORE_NAME, 'readonly');
    const done = transactionDone(transaction);
    const conversations = await requestResult(
      transaction.objectStore(STORE_NAME).getAll() as IDBRequest<StoredConversation[]>
    );
    await done;
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
  } finally {
    database.close();
  }
}

export async function deleteConversation(id: string): Promise<void> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    transaction.objectStore(STORE_NAME).delete(id);
    await transactionDone(transaction);
  } finally {
    database.close();
  }
}

export async function clearConversations(): Promise<void> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    transaction.objectStore(STORE_NAME).clear();
    await transactionDone(transaction);
  } finally {
    database.close();
  }
}

export async function pruneConversations(limits: {
  maxConversations: number;
  retentionDays: number;
}): Promise<void> {
  const database = await openDatabase();
  try {
    const readTransaction = database.transaction(STORE_NAME, 'readonly');
    const readDone = transactionDone(readTransaction);
    const conversations = await requestResult(
      readTransaction.objectStore(STORE_NAME).getAll() as IDBRequest<StoredConversation[]>
    );
    await readDone;

    const maximum = Math.min(Math.max(Math.trunc(limits.maxConversations), 1), 500);
    const retentionDays = Math.min(Math.max(Math.trunc(limits.retentionDays), 1), 3650);
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    const sorted = conversations.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    const deleteIds = sorted
      .filter((conversation, index) =>
        index >= maximum || new Date(conversation.updatedAt).getTime() < cutoff
      )
      .map((conversation) => conversation.id);
    if (!deleteIds.length) return;

    const writeTransaction = database.transaction(STORE_NAME, 'readwrite');
    const store = writeTransaction.objectStore(STORE_NAME);
    for (const id of deleteIds) store.delete(id);
    await transactionDone(writeTransaction);
  } finally {
    database.close();
  }
}
