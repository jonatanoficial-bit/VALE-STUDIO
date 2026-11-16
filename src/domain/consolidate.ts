import { clipIsAudible } from './comp'
import type { AudioProject, Clip } from './model'

export function clipsForConsolidation(project: AudioProject, trackId: string, start: number, end: number): Clip[] {
  if (![start, end].every(Number.isSafeInteger) || start < 0 || end <= start) throw new Error('Marque um intervalo válido.')
  const track = project.tracks.find((item) => item.id === trackId)
  if (!track || track.kind === 'midi' || track.inactive) throw new Error('Selecione uma pista de áudio ativa.')
  const clips = project.clips.filter((clip) => clip.trackId === trackId && clipIsAudible(project, clip) &&
    clip.timelineStartFrame < end && clip.timelineStartFrame + clip.durationFrames > start)
  if (!clips.length) throw new Error('O intervalo não contém clipes audíveis na pista.')
  if (clips.some((clip) => clip.positionLocked)) throw new Error('Desbloqueie os clipes do intervalo antes de consolidar.')
  if (clips.some((clip) => clip.takeId || clip.compSegment)) throw new Error('Use Renderizar pista para converter um take ou comp em áudio editável.')
  if (clips.some((clip) => clip.timelineStartFrame < start || clip.timelineStartFrame + clip.durationFrames > end)) {
    throw new Error('Ajuste o intervalo para conter os clipes inteiros ou divida-os nas bordas.')
  }
  return clips
}
