import { dbToGain, gainToDb } from '../domain/model'
import type { AutomationLane, AutomationMode, AutomationPoint, Track, TrackAutomation } from '../domain/model'

const LANES = ['gainDb', 'pan'] as const
const identity = (value: number) => value

export function isAutomationWriter(mode?: AutomationMode): mode is 'write' | 'touch' | 'latch' {
  return mode === 'write' || mode === 'touch' || mode === 'latch'
}

function firstAfter(points: AutomationPoint[], frame: number): number {
  let low = 0
  let high = points.length
  while (low < high) {
    const middle = Math.floor((low + high) / 2)
    if (points[middle].frame <= frame) low = middle + 1
    else high = middle
  }
  return low
}

function interpolate(points: AutomationPoint[], frame: number, index: number, convert: (value: number) => number): number {
  const previous = points[Math.max(0, index - 1)]
  const initial = convert(previous.value)
  const next = points[index]
  if (!next || frame <= previous.frame) return initial
  const fraction = (frame - previous.frame) / (next.frame - previous.frame)
  return initial + (convert(next.value) - initial) * fraction
}

export function automationValueAt(track: Track, lane: AutomationLane, frame: number): number {
  const points = track.automation?.[lane]
  if (track.automation?.mode === 'off' || !points?.length) return track[lane]
  const value = interpolate(points, frame, firstAfter(points, frame), lane === 'gainDb' ? dbToGain : identity)
  return lane === 'gainDb' ? Math.max(-60, Math.min(6, gainToDb(value))) : value
}

export function scheduleAutomation(param: AudioParam, points: AutomationPoint[], frame: number, rate: number,
  at: number, convert: (value: number) => number): void {
  param.cancelScheduledValues(at)
  let index = firstAfter(points, frame)
  param.setValueAtTime(interpolate(points, frame, index, convert), at)
  for (; index < points.length; index += 1) {
    const point = points[index]
    param.linearRampToValueAtTime(convert(point.value), at + (point.frame - frame) / rate)
  }
}

type LanePass = { active?: AutomationPoint[]; completed: AutomationPoint[][] }

export class AutomationPass {
  private tracks = new Map<string, { track: Track; lanes: Record<AutomationLane, LanePass> }>()

  constructor(tracks: Track[], startFrame: number, private rate: number) {
    for (const track of tracks) {
      const mode = track.automation?.mode
      if (!isAutomationWriter(mode)) continue
      const lanePass = (lane: AutomationLane): LanePass => ({
        active: mode === 'write' ? [{ frame: startFrame, value: automationValueAt(track, lane, startFrame) }] : undefined,
        completed: [],
      })
      this.tracks.set(track.id, { track, lanes: { gainDb: lanePass('gainDb'), pan: lanePass('pan') } })
    }
  }

  value(trackId: string, lane: AutomationLane): number | undefined {
    return this.tracks.get(trackId)?.lanes[lane].active?.at(-1)?.value
  }

  write(trackId: string, lane: AutomationLane, frame: number, value: number): boolean {
    const pass = this.tracks.get(trackId)?.lanes[lane]
    if (!pass || !Number.isFinite(value)) return false
    const [min, max] = lane === 'gainDb' ? [-60, 6] : [-1, 1]
    value = Math.max(min, Math.min(max, value))
    const last = pass.active?.at(-1)
    if (!pass.active || !last) {
      pass.active = [{ frame, value }]
    } else if (last.value !== value) {
      if (frame === last.frame) last.value = value
      else {
        if (frame - last.frame > this.rate / 10) pass.active.push({ frame: frame - Math.round(this.rate / 100), value: last.value })
        pass.active.push({ frame, value })
      }
    }
    return true
  }

  release(trackId: string, lane: AutomationLane, frame: number): boolean {
    const entry = this.tracks.get(trackId)
    if (entry?.track.automation?.mode !== 'touch') return false
    return this.closeSpan(entry.lanes[lane], frame)
  }

  private closeSpan(pass: LanePass, frame: number): boolean {
    const points = pass.active
    const last = points?.at(-1)
    if (!points || !last) return false
    if (frame > last.frame) points.push({ frame, value: last.value })
    pass.completed.push(points)
    pass.active = undefined
    return true
  }

  finish(frame: number): Map<string, TrackAutomation> {
    const result = new Map<string, TrackAutomation>()
    for (const [id, { track, lanes }] of this.tracks) {
      const automation = { ...track.automation! }
      let written = false
      for (const lane of LANES) {
        const pass = lanes[lane]
        if (automation.mode === 'write' && pass.active?.length === 1 && pass.active[0].frame === frame) continue
        this.closeSpan(pass, frame)
        if (pass.completed.length === 0) continue
        let points = automation[lane] ?? []
        for (const span of pass.completed) {
          const start = span[0].frame
          const end = span.at(-1)!.frame
          const previous = { ...track, automation: { ...automation, [lane]: points } }
          const before = points.filter((point) => point.frame < start)
          const after = points.filter((point) => point.frame > end)
          if (start > 0 && before.at(-1)?.frame !== start - 1) {
            before.push({ frame: start - 1, value: automationValueAt(previous, lane, start - 1) })
          }
          if (after[0]?.frame !== end + 1) {
            after.unshift({ frame: end + 1, value: automationValueAt(previous, lane, end + 1) })
          }
          points = [...before, ...span, ...after]
        }
        automation[lane] = points
        written = true
      }
      if (written) result.set(id, automation)
    }
    return result
  }
}
