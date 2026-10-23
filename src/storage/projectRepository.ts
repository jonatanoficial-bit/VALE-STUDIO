import type { AudioProject, MediaAsset } from '../domain/model'

const DATABASE_NAME = 'vale-studio-v1'
const DATABASE_VERSION = 2
const PROJECT_STORE = 'projects'
const ASSET_STORE = 'assets'
const TAKE_DRAFT_STORE = 'takeDrafts'
const TAKE_CHUNK_STORE = 'takeDraftChunks'

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
      if (!database.objectStoreNames.contains(TAKE_DRAFT_STORE)) database.createObjectStore(TAKE_DRAFT_STORE, { keyPath: 'id' })
      if (!database.objectStoreNames.contains(TAKE_CHUNK_STORE)) {
        const chunks = database.createObjectStore(TAKE_CHUNK_STORE, { keyPath: ['draftId', 'sequence'] })
        chunks.createIndex('byDraftId', 'draftId', { unique: false })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Não foi possível abrir o armazenamento local.'))
  })
}

export type StoredAsset = { id: string; blob: Blob }

export type TakeDraft = {
  id: string
  projectId: string
  trackId: string
  timelineStartFrame: number
  sampleRate: number
  channels: number
  createdAt: string
  updatedAt: string
  persistedFrames: number
  persistedChunks: number
}

export type TakeDraftChunk = {
  draftId: string
  sequence: number
  firstFrame: number
  frameCount: number
  channels: number
  pcm: ArrayBuffer
  writtenAt: string
}

export type RecoveredTakeDraft = TakeDraft & { pcm: Float32Array }

async function deleteDraftChunks(transaction: IDBTransaction, draftId: string): Promise<void> {
  const store = transaction.objectStore(TAKE_CHUNK_STORE)
  const chunks = await requestResult(store.index('byDraftId').getAll(IDBKeyRange.only(draftId))) as TakeDraftChunk[]
  chunks.forEach((chunk) => store.delete([chunk.draftId, chunk.sequence]))
}

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
    const transaction = database.transaction([PROJECT_STORE, ASSET_STORE, TAKE_DRAFT_STORE, TAKE_CHUNK_STORE], 'readwrite')
    transaction.objectStore(PROJECT_STORE).delete(project.id)
    project.assets.forEach((asset) => transaction.objectStore(ASSET_STORE).delete(asset.id))
    const drafts = await requestResult(transaction.objectStore(TAKE_DRAFT_STORE).getAll()) as TakeDraft[]
    await Promise.all(drafts.filter((draft) => draft.projectId === project.id).map(async (draft) => {
      transaction.objectStore(TAKE_DRAFT_STORE).delete(draft.id)
      await deleteDraftChunks(transaction, draft.id)
    }))
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

  async beginTakeDraft(draft: Omit<TakeDraft, 'createdAt' | 'updatedAt' | 'persistedFrames' | 'persistedChunks'>): Promise<TakeDraft> {
    const database = await openDatabase()
    const now = new Date().toISOString()
    const stored: TakeDraft = { ...draft, createdAt: now, updatedAt: now, persistedFrames: 0, persistedChunks: 0 }
    const transaction = database.transaction(TAKE_DRAFT_STORE, 'readwrite')
    transaction.objectStore(TAKE_DRAFT_STORE).put(stored)
    await transactionComplete(transaction)
    database.close()
    return stored
  },

  async updateTakeDraftStart(id: string, timelineStartFrame: number): Promise<void> {
    const database = await openDatabase()
    const transaction = database.transaction(TAKE_DRAFT_STORE, 'readwrite')
    const store = transaction.objectStore(TAKE_DRAFT_STORE)
    const draft = await requestResult(store.get(id)) as TakeDraft | undefined
    if (draft) store.put({ ...draft, timelineStartFrame, updatedAt: new Date().toISOString() })
    await transactionComplete(transaction)
    database.close()
  },

  async appendTakeDraftChunk(chunk: TakeDraftChunk): Promise<void> {
    const database = await openDatabase()
    const transaction = database.transaction([TAKE_DRAFT_STORE, TAKE_CHUNK_STORE], 'readwrite')
    const drafts = transaction.objectStore(TAKE_DRAFT_STORE)
    const draft = await requestResult(drafts.get(chunk.draftId)) as TakeDraft | undefined
    if (!draft) {
      transaction.abort()
      database.close()
      throw new Error('O rascunho da gravação não está mais disponível.')
    }
    transaction.objectStore(TAKE_CHUNK_STORE).put(chunk)
    drafts.put({
      ...draft,
      persistedFrames: draft.persistedFrames + chunk.frameCount,
      persistedChunks: draft.persistedChunks + 1,
      updatedAt: new Date().toISOString(),
    })
    await transactionComplete(transaction)
    database.close()
  },

  async listTakeDrafts(projectId: string): Promise<TakeDraft[]> {
    const database = await openDatabase()
    const transaction = database.transaction(TAKE_DRAFT_STORE, 'readonly')
    const drafts = await requestResult(transaction.objectStore(TAKE_DRAFT_STORE).getAll()) as TakeDraft[]
    database.close()
    return drafts.filter((draft) => draft.projectId === projectId).sort((first, second) => second.updatedAt.localeCompare(first.updatedAt))
  },

  async recoverTakeDraft(id: string): Promise<RecoveredTakeDraft | undefined> {
    const database = await openDatabase()
    const transaction = database.transaction([TAKE_DRAFT_STORE, TAKE_CHUNK_STORE], 'readonly')
    const draft = await requestResult(transaction.objectStore(TAKE_DRAFT_STORE).get(id)) as TakeDraft | undefined
    if (!draft) { database.close(); return undefined }
    const chunks = await requestResult(transaction.objectStore(TAKE_CHUNK_STORE).index('byDraftId').getAll(IDBKeyRange.only(id))) as TakeDraftChunk[]
    const ordered = chunks.sort((first, second) => first.sequence - second.sequence)
    const frames = ordered.reduce((total, chunk) => total + chunk.frameCount, 0)
    const pcm = new Float32Array(Math.max(0, frames * draft.channels))
    let offset = 0
    ordered.forEach((chunk) => {
      const samples = new Float32Array(chunk.pcm)
      pcm.set(samples, offset)
      offset += samples.length
    })
    database.close()
    return { ...draft, pcm }
  },

  async discardTakeDraft(id: string): Promise<void> {
    const database = await openDatabase()
    const transaction = database.transaction([TAKE_DRAFT_STORE, TAKE_CHUNK_STORE], 'readwrite')
    transaction.objectStore(TAKE_DRAFT_STORE).delete(id)
    await deleteDraftChunks(transaction, id)
    await transactionComplete(transaction)
    database.close()
  },

  async commitTake(project: AudioProject, asset: MediaAsset, blob: Blob, draftId: string): Promise<void> {
    const database = await openDatabase()
    const transaction = database.transaction([PROJECT_STORE, ASSET_STORE, TAKE_DRAFT_STORE, TAKE_CHUNK_STORE], 'readwrite')
    transaction.objectStore(ASSET_STORE).put({ id: asset.id, blob } satisfies StoredAsset)
    transaction.objectStore(PROJECT_STORE).put({ ...project, updatedAt: new Date().toISOString() })
    transaction.objectStore(TAKE_DRAFT_STORE).delete(draftId)
    await deleteDraftChunks(transaction, draftId)
    await transactionComplete(transaction)
    database.close()
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
