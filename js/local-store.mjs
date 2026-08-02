const DB_NAME = 'acionar-local-cache';
const STORE_NAME = 'records';
const DB_VERSION = 1;
const DEFAULT_TTL_MS = 5 * 60 * 1000;

function canUseIndexedDb() {
    return typeof indexedDB !== 'undefined';
}

function openDatabase() {
    if (!canUseIndexedDb()) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
            if (!request.result.objectStoreNames.contains(STORE_NAME)) {
                request.result.createObjectStore(STORE_NAME, { keyPath: 'key' });
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('IndexedDB indisponível'));
    });
}

export async function readLocalCache(key, { allowStale = false, maxAgeMs = DEFAULT_TTL_MS } = {}) {
    if (!key) return null;
    try {
        const db = await openDatabase();
        if (!db) return null;
        const record = await new Promise((resolve, reject) => {
            const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(key);
            request.onsuccess = () => resolve(request.result || null);
            request.onerror = () => reject(request.error);
        });
        db.close();
        if (!record) return null;
        const isFresh = Date.now() - record.updatedAt <= maxAgeMs;
        return isFresh || allowStale ? record.value : null;
    } catch (error) {
        return null;
    }
}

export async function writeLocalCache(key, value, { ttlMs = DEFAULT_TTL_MS } = {}) {
    if (!key) return false;
    try {
        const db = await openDatabase();
        if (!db) return false;
        await new Promise((resolve, reject) => {
            const transaction = db.transaction(STORE_NAME, 'readwrite');
            transaction.objectStore(STORE_NAME).put({ key, value, updatedAt: Date.now(), ttlMs });
            transaction.oncomplete = resolve;
            transaction.onerror = () => reject(transaction.error);
        });
        db.close();
        return true;
    } catch (error) {
        return false;
    }
}

export async function removeLocalCache(key) {
    if (!key) return false;
    try {
        const db = await openDatabase();
        if (!db) return false;
        await new Promise((resolve, reject) => {
            const transaction = db.transaction(STORE_NAME, 'readwrite');
            transaction.objectStore(STORE_NAME).delete(key);
            transaction.oncomplete = resolve;
            transaction.onerror = () => reject(transaction.error);
        });
        db.close();
        return true;
    } catch (error) {
        return false;
    }
}
