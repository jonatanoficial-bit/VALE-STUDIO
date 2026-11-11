import type { AutomationPoint } from '../domain/model'

export function scheduleAutomation(param: AudioParam, points: AutomationPoint[], frame: number, rate: number,
  at: number, convert: (value: number) => number): void {
  param.cancelScheduledValues(at)
  let previous = points[0]
  let index = 0
  while (index < points.length && points[index].frame <= frame) previous = points[index++]
  const next = points[index]
  const fraction = next && frame > previous.frame ? (frame - previous.frame) / (next.frame - previous.frame) : 0
  const initial = convert(previous.value)
  param.setValueAtTime(next ? initial + (convert(next.value) - initial) * fraction : initial, at)
  for (; index < points.length; index += 1) {
    const point = points[index]
    param.linearRampToValueAtTime(convert(point.value), at + (point.frame - frame) / rate)
  }
}
