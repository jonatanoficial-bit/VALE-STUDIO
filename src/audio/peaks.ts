export function buildPeaks(buffer: AudioBuffer, buckets = 120): number[] {
  const channel = buffer.getChannelData(0)
  const windowSize = Math.max(1, Math.floor(channel.length / buckets))
  const peaks: number[] = []

  for (let start = 0; start < channel.length; start += windowSize) {
    let peak = 0
    const end = Math.min(channel.length, start + windowSize)
    for (let frame = start; frame < end; frame += 1) peak = Math.max(peak, Math.abs(channel[frame]))
    peaks.push(Math.min(1, peak))
  }

  return peaks.length ? peaks : [0]
}
