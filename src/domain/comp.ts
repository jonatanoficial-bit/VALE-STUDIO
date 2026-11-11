import type { AudioProject, Clip, Take } from './model'

export function clipIsAudible(project: AudioProject, clip: Clip): boolean {
  const enabled = project.tracks.find((track) => track.id === clip.trackId)?.compEnabled
  if (clip.compSegment) return Boolean(enabled)
  if (!clip.takeId) return true
  return !enabled && project.takes.find((take) => take.id === clip.takeId)?.selected !== false
}

export function applyCompRegion(project: AudioProject, take: Take, sourceStart: number, sourceEnd: number, destination: number,
  id: () => string): AudioProject {
  const asset = project.assets.find((item) => item.id === take.assetId)
  const track = project.tracks.find((item) => item.id === take.trackId)
  const duration = sourceEnd - sourceStart
  const end = destination + duration
  if (!asset || !track || ![sourceStart, sourceEnd, destination, end].every(Number.isSafeInteger) ||
    sourceStart < 0 || duration <= 0 || sourceEnd > Math.min(asset.durationFrames, take.durationFrames) || destination < 0) {
    throw new Error('Selecione um trecho válido dentro do take.')
  }
  const existing = project.clips.filter((clip) => clip.trackId === track.id && clip.compSegment)
  const base = existing.length ? existing : project.clips.filter((clip) => clip.trackId === track.id && clip.takeId && clipIsAudible(project, clip))
    .map((clip): Clip => ({ ...clip, id: id(), takeId: undefined, compSegment: true }))
  const fade = Math.max(1, Math.round(project.audioSampleRate * 0.005))
  const retained = base.flatMap((clip) => {
    const from = clip.timelineStartFrame
    const until = from + clip.durationFrames
    if (until <= destination || from >= end) return [clip]
    const result: Clip[] = []
    if (from < destination) {
      const length = destination - from
      result.push({ ...clip, durationFrames: length, fadeInFrames: Math.min(clip.fadeInFrames, Math.floor(length / 2)), fadeOutFrames: Math.min(fade, Math.floor(length / 2)) })
    }
    if (until > end) {
      const length = until - end
      result.push({ ...clip, id: id(), timelineStartFrame: end, sourceOffsetFrame: clip.sourceOffsetFrame + end - from, durationFrames: length,
        fadeInFrames: Math.min(fade, Math.floor(length / 2)), fadeOutFrames: Math.min(clip.fadeOutFrames, Math.floor(length / 2)) })
    }
    return result
  })
  const edge = Math.min(fade, Math.floor(duration / 2))
  retained.push({ id: id(), trackId: track.id, assetId: asset.id, compSegment: true, timelineStartFrame: destination, sourceOffsetFrame: sourceStart,
    durationFrames: duration, gainDb: 0, fadeInFrames: edge, fadeOutFrames: edge })
  const replaced = new Set(existing.map((clip) => clip.id))
  return {
    ...project,
    clips: [...project.clips.filter((clip) => !replaced.has(clip.id)), ...retained],
    tracks: project.tracks.map((item) => item.id === track.id ? {
      ...item, compEnabled: true, clipIds: [...item.clipIds.filter((clipId) => !replaced.has(clipId)), ...retained.map((clip) => clip.id)],
    } : item),
  }
}
