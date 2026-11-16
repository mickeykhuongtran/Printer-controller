"use client";
import type { LabelDoc } from "./types";

// Large templates/data feeds live in IndexedDB, not synchronous localStorage.
export async function fleetDraft(id: string, value?: LabelDoc): Promise<LabelDoc | undefined> {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("zbre-fleet-drafts", 1);
        request.onupgradeneeded = () => request.result.createObjectStore("drafts");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
    try {
        return await new Promise((resolve, reject) => {
            const transaction = db.transaction("drafts", value ? "readwrite" : "readonly");
            const request = value ? transaction.objectStore("drafts").put(value, id) : transaction.objectStore("drafts").get(id);
            transaction.oncomplete = () => resolve(value || request.result as LabelDoc | undefined);
            transaction.onerror = () => reject(transaction.error);
            transaction.onabort = () => reject(transaction.error || new Error("Không lưu được template máy in."));
        });
    } finally { db.close(); }
}
