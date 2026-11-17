export type ClipAnalysis = {
  length: number
  rate: number
  window: number
  peaks: Float32Array
  peakFrames: Float64Array
}

export type ClipRegion = { start: number; end: number }

export function analyzeClipPcm(buffer: AudioBuffer, rate: number, offset: number, length: number, gainDb: number): ClipAnalysis {
  const window = Math.max(1, Math.round(rate * 0.005))
  const windows = Math.ceil(length / window)
  const peaks = new Float32Array(windows)
  const peakFrames = new Float64Array(windows)
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, channel) => buffer.getChannelData(channel))
  const scale = buffer.sampleRate / rate
  const gain = 10 ** (gainDb / 20)
  for (let index = 0; index < windows; index++) {
    const start = Math.floor((offset + index * window) * scale)
    const end = Math.min(buffer.length, Math.floor((offset + Math.min(length, (index + 1) * window)) * scale))
    let peak = 0
    let frame = start
    for (const samples of channels) {
      for (let sample = start; sample < end; sample++) {
        const level = Math.abs(samples[sample])
        if (level > peak) { peak = level; frame = sample }
      }
    }
    peaks[index] = peak * gain
    peakFrames[index] = Math.max(0, Math.min(length - 1, Math.round(frame / scale - offset)))
  }
  return { length, rate, window, peaks, peakFrames }
}

export function findTransients(analysis: ClipAnalysis, thresholdDb: number): number[] {
  const threshold = 10 ** (thresholdDb / 20)
  const spacing = analysis.rate * 0.04
  const events: number[] = []
  let previous = 0
  for (let index = 0; index < analysis.peaks.length; index++) {
    const value = analysis.peaks[index]
    const frame = analysis.peakFrames[index]
    if (value >= threshold && value >= previous * 2 && frame - (events.at(-1) ?? -Infinity) >= spacing) events.push(frame)
    previous = value
  }
  return events
}

export function regionsAboveSilence(analysis: ClipAnalysis, thresholdDb: number, minimumMs: number, paddingMs: number): ClipRegion[] {
  const threshold = 10 ** (thresholdDb / 20)
  const minimum = Math.round(analysis.rate * minimumMs / 1000)
  const padding = Math.round(analysis.rate * paddingMs / 1000)
  const regions: ClipRegion[] = []
  for (let index = 0; index < analysis.peaks.length; index++) {
    if (analysis.peaks[index] < threshold) continue
    const start = index * analysis.window
    const end = Math.min(analysis.length, start + analysis.window)
    const previous = regions.at(-1)
    if (previous && start - previous.end < minimum + 2 * padding) previous.end = end
    else regions.push({ start, end })
  }
  return regions.map(({ start, end }) => ({
    start: start < minimum + padding ? 0 : start - padding,
    end: analysis.length - end < minimum + padding ? analysis.length : end + padding,
  }))
}
