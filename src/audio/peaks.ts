export function buildPeaks(buffer: AudioBuffer, buckets = 120): number[] {
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, index) => buffer.getChannelData(index))
  const windowSize = Math.max(1, Math.floor(buffer.length / buckets))
  const peaks: number[] = []

  for (let start = 0; start < buffer.length; start += windowSize) {
    let peak = 0
    const end = Math.min(buffer.length, start + windowSize)
    for (const channel of channels) {
      for (let frame = start; frame < end; frame += 1) peak = Math.max(peak, Math.abs(channel[frame]))
    }
    peaks.push(Math.min(1, peak))
  }

  return peaks.length ? peaks : [0]
}
