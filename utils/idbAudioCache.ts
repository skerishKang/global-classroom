type AudioRecord = {
  id: string;
  audioBase64: string;
  updatedAt: number;
};

const DB_NAME = 'global_classroom_audio_cache';
const STORE_NAME = 'audio';
// DB_VERSION 3: 기존 DB에 updatedAt 인덱스가 없는 경우를 대비해 마이그레이션
const DB_VERSION = 3;

let dbPromise: Promise<IDBDatabase> | null = null;

const openDb = (): Promise<IDBDatabase> => {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('indexedDB를 사용할 수 없습니다.'));
  }

  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = () => {
      const db = req.result;
      let store: IDBObjectStore;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      } else {
        store = req.transaction!.objectStore(STORE_NAME);
      }
      // 인덱스가 누락된 기존 스토어를 대비
      if (!store.indexNames.contains('updatedAt')) {
        store.createIndex('updatedAt', 'updatedAt', { unique: false });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('indexedDB 열기에 실패했습니다.'));
  });

  return dbPromise;
};

const requestToPromise = <T>(req: IDBRequest<T>): Promise<T> => {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('indexedDB 요청에 실패했습니다.'));
  });
};

const txDone = (tx: IDBTransaction): Promise<void> => {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('indexedDB 트랜잭션 오류'));
    tx.onabort = () => reject(tx.error || new Error('indexedDB 트랜잭션 중단'));
  });
};

export const hasCachedAudio = async (id: string): Promise<boolean> => {
  if (!id) return false;

  try {
    const db = await openDb();
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const key = await requestToPromise(store.getKey(id));
    await txDone(tx);
    return typeof key !== 'undefined';
  } catch {
    return false;
  }
};

export const getCachedAudioBase64 = async (id: string): Promise<string | null> => {
  if (!id) return null;

  try {
    const db = await openDb();
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const record = await requestToPromise(store.get(id) as IDBRequest<AudioRecord | undefined>);
    await txDone(tx);
    return record?.audioBase64 || null;
  } catch {
    return null;
  }
};

const cleanupOldRecords = async (limit: number = 100): Promise<void> => {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const index = store.index('updatedAt');

    const count = await requestToPromise(store.count());
    if (count > limit) {
      const deleteCount = count - limit;
      const cursorReq = index.openCursor();
      let itemsDeleted = 0;

      return new Promise((resolve, reject) => {
        cursorReq.onsuccess = (e) => {
          const cursor = (e.target as IDBRequest<IDBCursorWithValue | null>).result;
          if (cursor && itemsDeleted < deleteCount) {
            cursor.delete();
            itemsDeleted++;
            cursor.continue();
          } else {
            resolve();
          }
        };
        cursorReq.onerror = () => reject(cursorReq.error);
      });
    }
  } catch (e) {
    console.warn('Audio cache cleanup failed', e);
  }
};

export const setCachedAudioBase64 = async (id: string, audioBase64: string): Promise<void> => {
  if (!id || !audioBase64) return;

  try {
    const db = await openDb();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const record: AudioRecord = { id, audioBase64, updatedAt: Date.now() };
    await requestToPromise(store.put(record));
    await txDone(tx);
    await cleanupOldRecords(100);
  } catch (e) {
    console.warn('indexedDB 오디오 캐시 저장 실패', e);
  }
};

export const clearCachedAudio = async (): Promise<void> => {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    await requestToPromise(store.clear());
    await txDone(tx);
  } catch (e) {
    console.warn('indexedDB 오디오 캐시 삭제 실패', e);
  }
};
