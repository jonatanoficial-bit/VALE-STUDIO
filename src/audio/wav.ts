import lameSource from 'lamejs/lame.min.js?raw'

type LameEncoder = {
  encodeBuffer(left: Int16Array, right?: Int16Array): Int8Array
  flush(): Int8Array
}

type LameApi = { Mp3Encoder: new (channels: number, sampleRate: number, kbps: number) => LameEncoder }

// lamejs 1.2.1 publishes an incomplete CommonJS entry point. The maintained
// browser bundle is included verbatim in this static app and evaluated locally.
// It is never fetched from a CDN or renamed from another audio container.
const lamejs = new Function(`${lameSource}\nreturn lamejs;`)() as LameApi

function interleave(buffer: AudioBuffer): Float32Array {
  const channels = buffer.numberOfChannels
  const frames = buffer.length
  const output = new Float32Array(frames * channels)

  for (let channel = 0; channel < channels; channel += 1) {
    const data = buffer.getChannelData(channel)
    for (let frame = 0; frame < frames; frame += 1) output[frame * channels + channel] = data[frame]
  }
  return output
}

export function encodeWav(buffer: AudioBuffer, bitDepth: 16 | 24 = 16): Blob {
  const channels = buffer.numberOfChannels
  const bytesPerSample = bitDepth / 8
  const pcm = interleave(buffer)
  const dataLength = pcm.length * bytesPerSample
  const output = new ArrayBuffer(44 + dataLength)
  const view = new DataView(output)
  const writeText = (offset: number, value: string) => [...value].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)))

  writeText(0, 'RIFF')
  view.setUint32(4, 36 + dataLength, true)
  writeText(8, 'WAVE')
  writeText(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, channels, true)
  view.setUint32(24, buffer.sampleRate, true)
  view.setUint32(28, buffer.sampleRate * channels * bytesPerSample, true)
  view.setUint16(32, channels * bytesPerSample, true)
  view.setUint16(34, bitDepth, true)
  writeText(36, 'data')
  view.setUint32(40, dataLength, true)

  let offset = 44
  pcm.forEach((sample) => {
    const clamped = Math.max(-1, Math.min(1, sample))
    if (bitDepth === 16) {
      view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true)
    } else {
      const value = Math.round(clamped * 0x7fffff)
      view.setUint8(offset, value & 0xff)
      view.setUint8(offset + 1, (value >> 8) & 0xff)
      view.setUint8(offset + 2, (value >> 16) & 0xff)
    }
    offset += bytesPerSample
  })

  return new Blob([output], { type: 'audio/wav' })
}

function toInt16(data: Float32Array): Int16Array {
  const output = new Int16Array(data.length)
  for (let index = 0; index < data.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, data[index]))
    output[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff
  }
  return output
}

export function encodeMp3(buffer: AudioBuffer, bitrate = 192): Blob {
  const channels = Math.min(2, buffer.numberOfChannels)
  const encoder = new lamejs.Mp3Encoder(channels, buffer.sampleRate, bitrate)
  const left = toInt16(buffer.getChannelData(0))
  const right = channels === 2 ? toInt16(buffer.getChannelData(1)) : undefined
  const chunks: ArrayBuffer[] = []
  const blockSize = 1152

  for (let offset = 0; offset < left.length; offset += blockSize) {
    const leftChunk = left.subarray(offset, Math.min(offset + blockSize, left.length))
    const rightChunk = right?.subarray(offset, Math.min(offset + blockSize, right.length))
    const encoded = encoder.encodeBuffer(leftChunk, rightChunk)
    if (encoded.length) {
      const copy = new Uint8Array(encoded.length)
      copy.set(encoded)
      chunks.push(copy.buffer)
    }
  }
  const flushed = encoder.flush()
  if (flushed.length) {
    const copy = new Uint8Array(flushed.length)
    copy.set(flushed)
    chunks.push(copy.buffer)
  }
  return new Blob(chunks, { type: 'audio/mpeg' })
}
