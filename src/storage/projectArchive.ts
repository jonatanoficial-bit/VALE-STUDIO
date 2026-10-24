import type { AudioProject, MediaAsset } from '../domain/model'
import { projectRepository } from './projectRepository'

export const PROJECT_ARCHIVE_MIME = 'application/x-valestudio+json'
export const PROJECT_ARCHIVE_EXTENSION = '.valestudio'

type ArchivedAsset = {
  id: string
  mimeType: string
  base64: string
}

type ProjectArchive = {
  format: 'vale-studio-project'
  version: 1
  exportedAt: string
  project: AudioProject
  assets: ArchivedAsset[]
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function assertArchive(value: unknown): asserts value is ProjectArchive {
  const archive = asRecord(value)
  const project = asRecord(archive?.project)
  if (archive?.format !== 'vale-studio-project' || archive.version !== 1 || !project || typeof project.id !== 'string' || typeof project.name !== 'string' || !Array.isArray(project.tracks) || !Array.isArray(project.clips) || !Array.isArray(project.takes) || !Array.isArray(project.assets) || !Array.isArray(archive.assets)) {
    throw new Error('Este arquivo não é um backup Vale Studio compatível.')
  }
  const identifiers = (items: unknown[], label: string) => {
    const ids = items.map((item) => asRecord(item)?.id).filter((id): id is string => typeof id === 'string')
    if (ids.length !== items.length || new Set(ids).size !== ids.length) throw new Error(`${label} do backup é inválido.`)
    return new Set(ids)
  }
  const projectAssetIds = identifiers(project.assets as unknown[], 'Manifesto de áudios')
  const trackIds = identifiers(project.tracks as unknown[], 'Lista de pistas')
  const clipIds = identifiers(project.clips as unknown[], 'Lista de clipes')
  const takeIds = identifiers(project.takes as unknown[], 'Lista de takes')
  const archiveAssetIds = identifiers(archive.assets as unknown[], 'Conteúdo de áudios')
  const hasInvalidClip = (project.clips as unknown[]).some((clip) => {
    const item = asRecord(clip)
    return !item || typeof item.assetId !== 'string' || typeof item.trackId !== 'string' || !projectAssetIds.has(item.assetId) || !trackIds.has(item.trackId) || (item.takeId !== undefined && (typeof item.takeId !== 'string' || !takeIds.has(item.takeId)))
  })
  const hasInvalidTake = (project.takes as unknown[]).some((take) => {
    const item = asRecord(take)
    return !item || typeof item.assetId !== 'string' || typeof item.trackId !== 'string' || !projectAssetIds.has(item.assetId) || !trackIds.has(item.trackId)
  })
  const hasInvalidTrackLinks = (project.tracks as unknown[]).some((track) => {
    const item = asRecord(track)
    return !item || !Array.isArray(item.clipIds) || !Array.isArray(item.takeIds) || item.clipIds.some((id) => typeof id !== 'string' || !clipIds.has(id)) || item.takeIds.some((id) => typeof id !== 'string' || !takeIds.has(id))
  })
  if (projectAssetIds.size !== archiveAssetIds.size || [...projectAssetIds].some((id) => !archiveAssetIds.has(id)) || archive.assets.some((asset) => !asRecord(asset) || typeof asRecord(asset)?.id !== 'string' || typeof asRecord(asset)?.mimeType !== 'string' || typeof asRecord(asset)?.base64 !== 'string' || !projectAssetIds.has(asRecord(asset)?.id as string)) || hasInvalidClip || hasInvalidTake || hasInvalidTrackLinks) {
    throw new Error('O manifesto de áudios do backup está incompleto ou inválido.')
  }
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  const sliceSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += sliceSize) binary += String.fromCharCode(...bytes.subarray(offset, offset + sliceSize))
  return btoa(binary)
}

function base64ToBlob(base64: string, mimeType: string): Blob {
  let binary: string
  try {
    binary = atob(base64)
  } catch {
    throw new Error('Um áudio do backup está corrompido.')
  }
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return new Blob([bytes], { type: mimeType })
}

function cloneForRestore(project: AudioProject): AudioProject {
  const trackIds = new Map(project.tracks.map((track) => [track.id, crypto.randomUUID()]))
  const assetIds = new Map(project.assets.map((asset) => [asset.id, crypto.randomUUID()]))
  const takeIds = new Map(project.takes.map((take) => [take.id, crypto.randomUUID()]))
  const clipIds = new Map(project.clips.map((clip) => [clip.id, crypto.randomUUID()]))
  const now = new Date().toISOString()

  return {
    ...project,
    id: crypto.randomUUID(),
    name: `${project.name} — restaurado`,
    createdAt: now,
    updatedAt: now,
    tracks: project.tracks.map((track) => ({ ...track, id: trackIds.get(track.id)!, clipIds: track.clipIds.map((id) => clipIds.get(id)!), takeIds: track.takeIds.map((id) => takeIds.get(id)!) })),
    assets: project.assets.map((asset) => ({ ...asset, id: assetIds.get(asset.id)!, createdAt: now })),
    clips: project.clips.map((clip) => ({ ...clip, id: clipIds.get(clip.id)!, assetId: assetIds.get(clip.assetId)!, trackId: trackIds.get(clip.trackId)!, takeId: clip.takeId ? takeIds.get(clip.takeId) : undefined })),
    takes: project.takes.map((take) => ({ ...take, id: takeIds.get(take.id)!, assetId: assetIds.get(take.assetId)!, trackId: trackIds.get(take.trackId)!, createdAt: now })),
  }
}

export async function exportProjectArchive(project: AudioProject): Promise<Blob> {
  const assets: ArchivedAsset[] = []
  for (const asset of project.assets) {
    const blob = await projectRepository.loadAsset(asset.id)
    if (!blob) throw new Error(`O áudio “${asset.name}” não foi encontrado no armazenamento local.`)
    assets.push({ id: asset.id, mimeType: blob.type || asset.mimeType, base64: await blobToBase64(blob) })
  }
  const archive: ProjectArchive = { format: 'vale-studio-project', version: 1, exportedAt: new Date().toISOString(), project, assets }
  return new Blob([JSON.stringify(archive)], { type: PROJECT_ARCHIVE_MIME })
}

export async function restoreProjectArchive(file: File): Promise<{ project: AudioProject; assets: Array<{ asset: MediaAsset; blob: Blob }> }> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await file.text())
  } catch {
    throw new Error('Não foi possível ler este backup .valestudio.')
  }
  assertArchive(parsed)
  const project = cloneForRestore(parsed.project)
  const archivedById = new Map(parsed.assets.map((asset) => [asset.id, asset]))
  const originalAssets = parsed.project.assets as MediaAsset[]
  const assets = project.assets.map((asset, index) => {
    const source = archivedById.get(originalAssets[index].id)
    if (!source) throw new Error('Um áudio esperado não existe no backup.')
    return { asset, blob: base64ToBlob(source.base64, source.mimeType || asset.mimeType) }
  })
  return { project, assets }
}
