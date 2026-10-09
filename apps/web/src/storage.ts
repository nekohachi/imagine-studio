// IndexedDB の最小の読み書き(ワーカーの中で使う)。
// フェーズ 1 は作品を丸ごと 1 つのバイト列として保存する。タイル単位の保存と LRU 退避は後で。

const DB = "imagine-studio";
const STORE = "files";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB を開けない"));
  });
}

export async function idbPut(key: string, value: Uint8Array): Promise<void> {
  const db = await open();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      // 自前のバッファをそのまま保存(コピーは IndexedDB 側が持つ)
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("保存に失敗"));
      tx.onabort = () => reject(tx.error ?? new Error("保存が中断"));
    });
  } finally {
    db.close();
  }
}

export async function idbGet(key: string): Promise<Uint8Array | null> {
  const db = await open();
  try {
    return await new Promise<Uint8Array | null>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => {
        const v = req.result as Uint8Array | ArrayBuffer | undefined;
        if (!v) resolve(null);
        else resolve(v instanceof Uint8Array ? v : new Uint8Array(v));
      };
      req.onerror = () => reject(req.error ?? new Error("読み込みに失敗"));
    });
  } finally {
    db.close();
  }
}

export async function idbDelete(key: string): Promise<void> {
  const db = await open();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("削除に失敗"));
    });
  } finally {
    db.close();
  }
}
