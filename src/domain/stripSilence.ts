import type { ClipRegion } from '../audio/clipAnalysis'
import type { Clip } from './model'

export function clipsWithoutSilence(clip: Clip, regions: ClipRegion[], rate: number, makeId: () => string): Clip[] {
  const kept: ClipRegion[] = []
  const fadeOutStart = clip.durationFrames - clip.fadeOutFrames
  for (const region of regions) {
    const keepsFadeIn = region.start < clip.fadeInFrames
    const keepsFadeOut = region.end > fadeOutStart
    const start = keepsFadeIn ? 0 : keepsFadeOut ? Math.min(region.start, fadeOutStart) : region.start
    const end = keepsFadeOut ? clip.durationFrames : keepsFadeIn ? Math.max(region.end, clip.fadeInFrames) : region.end
    const previous = kept.at(-1)
    if (previous && start <= previous.end) previous.end = Math.max(previous.end, end)
    else kept.push({ start, end })
  }
  return kept.map(({ start, end }) => {
    const durationFrames = end - start
    const originalIn = start === 0 ? Math.min(durationFrames, clip.fadeInFrames) : 0
    const originalOut = end === clip.durationFrames ? Math.min(durationFrames - originalIn, clip.fadeOutFrames) : 0
    const edgeFade = Math.round(rate * 0.003)
    const free = durationFrames - originalIn - originalOut
    const fadeInFrames = start === 0 ? originalIn : Math.min(free, edgeFade)
    const fadeOutFrames = end === clip.durationFrames ? originalOut : Math.min(durationFrames - fadeInFrames, edgeFade)
    return {
      ...clip, id: makeId(), durationFrames,
      timelineStartFrame: clip.timelineStartFrame + start,
      sourceOffsetFrame: clip.sourceOffsetFrame + start,
      fadeInFrames, fadeOutFrames,
    }
  })
}
