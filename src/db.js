import localforage from 'localforage';

export const db = localforage.createInstance({
  name: 'pdfReader',
  storeName: 'documents',
  description: 'Stores PDF documents locally for offline viewing'
});

export const metaDb = localforage.createInstance({
  name: 'pdfMetaData',
  storeName: 'metadata',
  description: 'Stores last read page, scroll position, and annotations'
});

export async function saveDocument(id, file, name) {
  await db.setItem(id, file);
  await metaDb.setItem(id, {
    name,
    addedAt: Date.now(),
    lastRead: Date.now(),
    lastPage: 1,
    paths: [],
  });
}

export async function getDocumentsList() {
  const keys = await metaDb.keys();
  const list = [];
  for (const key of keys) {
    const meta = await metaDb.getItem(key);
    if (meta) {
      list.push({ id: key, ...meta });
    }
  }
  return list.sort((a, b) => b.lastRead - a.lastRead);
}

export async function getDocument(id) {
  return await db.getItem(id);
}

export async function updateMetadata(id, updates) {
  const meta = await metaDb.getItem(id);
  const baseMeta = meta ?? {
    name: 'Untitled',
    addedAt: Date.now(),
    lastPage: 1,
    paths: [],
  };
  await metaDb.setItem(id, { ...baseMeta, ...updates, lastRead: Date.now() });
}

export async function deleteDocument(id) {
  await Promise.all([db.removeItem(id), metaDb.removeItem(id)]);
}
