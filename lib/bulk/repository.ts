import type { BulkDataset, BulkDatasetSummary, BulkJob, BulkRow } from './contracts';

const databaseName = 'oddy-bulk-workspace';
const stores = ['jobs', 'rows', 'datasets'];
const request = <T>(value: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    value.onsuccess = () => resolve(value.result);
    value.onerror = () => reject(value.error || new Error('Bulk workspace request failed.'));
  });
async function transaction<T>(
  mode: IDBTransactionMode,
  work: (tx: IDBTransaction) => Promise<T> | T
): Promise<T> {
  if (!globalThis.indexedDB) throw new Error('IndexedDB is required for durable bulk jobs.');
  const opening = indexedDB.open(databaseName, 1);
  opening.onupgradeneeded = () => {
    const db = opening.result;
    db.createObjectStore('jobs', { keyPath: 'summary.id' });
    db.createObjectStore('rows', { keyPath: ['jobId', 'index'] });
    db.createObjectStore('datasets', { keyPath: 'summary.id' });
  };
  const db = await request(opening);
  try {
    const tx = db.transaction(stores, mode);
    const done = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () =>
        reject(tx.error || new Error('Bulk workspace transaction aborted.'));
    });
    try {
      const [result] = await Promise.all([work(tx), done]);
      return result;
    } catch (error) {
      try {
        tx.abort();
      } catch {
        /* already settled */
      }
      await done.catch(() => undefined);
      throw error;
    }
  } finally {
    db.close();
  }
}
function datasetSummaries(tx: IDBTransaction): Promise<BulkDatasetSummary[]> {
  return new Promise((resolve, reject) => {
    const summaries: BulkDatasetSummary[] = [];
    const cursor = tx.objectStore('datasets').openCursor();
    cursor.onerror = () => reject(cursor.error || new Error('Could not read dataset handles.'));
    cursor.onsuccess = () => {
      if (!cursor.result) {
        resolve(summaries);
        return;
      }
      summaries.push((cursor.result.value as BulkDataset).summary);
      cursor.result.continue();
    };
  });
}
export const bulkRepository = {
  jobs: (): Promise<BulkJob[]> =>
    transaction('readonly', (tx) => request(tx.objectStore('jobs').getAll())),
  getJob: (id: string): Promise<BulkJob | undefined> =>
    transaction('readonly', (tx) => request(tx.objectStore('jobs').get(id))),
  save: (job: BulkJob, rows: BulkRow[] = []): Promise<void> =>
    transaction('readwrite', (tx) => {
      tx.objectStore('jobs').put(job);
      for (const row of rows)
        tx.objectStore('rows').put({ jobId: job.summary.id, index: row.index, row });
    }),
  rows: (id: string, offset: number, limit: number): Promise<BulkRow[]> =>
    transaction('readonly', async (tx) => {
      if (
        !Number.isInteger(offset) ||
        offset < 0 ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 1000
      )
        throw new Error('Invalid bulk workspace page.');
      const values = (await request(
        tx.objectStore('rows').getAll(IDBKeyRange.bound([id, offset], [id, offset + limit - 1]))
      )) as Array<{ row: BulkRow }>;
      return values.map((value) => value.row);
    }),
  saveDataset: (dataset: BulkDataset): Promise<void> =>
    transaction('readwrite', (tx) => {
      tx.objectStore('datasets').put(dataset);
    }),
  getDataset: (id: string): Promise<BulkDataset | undefined> =>
    transaction('readonly', (tx) => request(tx.objectStore('datasets').get(id))),
  datasets: (): Promise<BulkDatasetSummary[]> => transaction('readonly', datasetSummaries),
  deleteDataset: (id: string): Promise<void> =>
    transaction('readwrite', (tx) => {
      tx.objectStore('datasets').delete(id);
    }),
  deleteJob: (id: string): Promise<void> =>
    transaction('readwrite', (tx) => {
      tx.objectStore('jobs').delete(id);
      tx.objectStore('rows').delete(IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]));
    }),
  clear: (): Promise<void> =>
    transaction('readwrite', (tx) => {
      for (const name of stores) tx.objectStore(name).clear();
    }),
  prune: (now = Date.now()): Promise<void> =>
    transaction('readwrite', async (tx) => {
      const [jobs, datasets] = await Promise.all([
        request(tx.objectStore('jobs').getAll()) as Promise<BulkJob[]>,
        datasetSummaries(tx)
      ]);
      for (const job of jobs)
        if (Date.parse(job.summary.createdAt) + 24 * 60 * 60 * 1000 <= now) {
          tx.objectStore('jobs').delete(job.summary.id);
          tx.objectStore('rows').delete(
            IDBKeyRange.bound([job.summary.id, 0], [job.summary.id, Number.MAX_SAFE_INTEGER])
          );
        }
      for (const dataset of datasets)
        if (Date.parse(dataset.expiresAt) <= now) tx.objectStore('datasets').delete(dataset.id);
    })
};
export type BulkRepository = typeof bulkRepository;
