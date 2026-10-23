import type { AudioProject, MediaAsset } from '../domain/model'

const DATABASE_NAME = 'vale-studio-v1'
const DATABASE_VERSION = 1
const PROJECT_STORE = 'projects'
const ASSET_STORE = 'assets'

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Falha no IndexedDB.'))
  })
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error ?? new Error('Transação cancelada.'))
    transaction.onerror = () => reject(transaction.error ?? new Error('Falha de persistência.'))
  })
}

async function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION)
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(PROJECT_STORE)) database.createObjectStore(PROJECT_STORE, { keyPath: 'id' })
      if (!database.objectStoreNames.contains(ASSET_STORE)) database.createObjectStore(ASSET_STORE, { keyPath: 'id' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Não foi possível abrir o armazenamento local.'))
  })
}

export type StoredAsset = { id: string; blob: Blob }

export const projectRepository = {
  async listProjects(): Promise<AudioProject[]> {
    const database = await openDatabase()
    const transaction = database.transaction(PROJECT_STORE, 'readonly')
    const projects = await requestResult(transaction.objectStore(PROJECT_STORE).getAll()) as AudioProject[]
    database.close()
    return projects.sort((first, second) => second.updatedAt.localeCompare(first.updatedAt))
  },

  async loadProject(id: string): Promise<AudioProject | undefined> {
    const database = await openDatabase()
    const transaction = database.transaction(PROJECT_STORE, 'readonly')
    const project = await requestResult(transaction.objectStore(PROJECT_STORE).get(id)) as AudioProject | undefined
    database.close()
    return project
  },

  async saveProject(project: AudioProject): Promise<void> {
    const database = await openDatabase()
    const transaction = database.transaction(PROJECT_STORE, 'readwrite')
    transaction.objectStore(PROJECT_STORE).put({ ...project, updatedAt: new Date().toISOString() })
    await transactionComplete(transaction)
    database.close()
  },

  async removeProject(project: AudioProject): Promise<void> {
    const database = await openDatabase()
    const transaction = database.transaction([PROJECT_STORE, ASSET_STORE], 'readwrite')
    transaction.objectStore(PROJECT_STORE).delete(project.id)
    project.assets.forEach((asset) => transaction.objectStore(ASSET_STORE).delete(asset.id))
    await transactionComplete(transaction)
    database.close()
  },

  async saveAsset(asset: MediaAsset, blob: Blob): Promise<void> {
    const database = await openDatabase()
    const transaction = database.transaction(ASSET_STORE, 'readwrite')
    transaction.objectStore(ASSET_STORE).put({ id: asset.id, blob } satisfies StoredAsset)
    await transactionComplete(transaction)
    database.close()
  },

  async loadAsset(id: string): Promise<Blob | undefined> {
    const database = await openDatabase()
    const transaction = database.transaction(ASSET_STORE, 'readonly')
    const stored = await requestResult(transaction.objectStore(ASSET_STORE).get(id)) as StoredAsset | undefined
    database.close()
    return stored?.blob
  },

  async getStorageEstimate(): Promise<{ usage?: number; quota?: number; persistent?: boolean }> {
    const estimate = await navigator.storage?.estimate?.()
    const persistent = navigator.storage?.persisted ? await navigator.storage.persisted() : undefined
    return { usage: estimate?.usage, quota: estimate?.quota, persistent }
  },

  async requestPersistentStorage(): Promise<boolean | undefined> {
    return navigator.storage?.persist ? navigator.storage.persist() : undefined
  },
}
