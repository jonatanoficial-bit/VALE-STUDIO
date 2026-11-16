import type { MidiNote, TimeSignature } from '../domain/model'

type MidiTrack = { name: string; notes: MidiNote[] }
type MidiFile = { tracks: MidiTrack[]; bpm?: number; timeSignature?: TimeSignature }
const TICKS_PER_BEAT = 960
const MAX_DELTA = 0x0fffffff

class Reader {
  private offset = 0
  constructor(private bytes: Uint8Array) {}
  get done() { return this.offset >= this.bytes.length }
  read(length: number): Uint8Array {
    if (length > this.bytes.length - this.offset) throw new Error('O arquivo MIDI está truncado.')
    const data = this.bytes.subarray(this.offset, this.offset + length)
    this.offset += length
    return data
  }
  byte() { return this.read(1)[0] }
  integer(length: number) { return this.read(length).reduce((value, byte) => value * 256 + byte, 0) }
  tag() { return String.fromCharCode(...this.read(4)) }
  delta() {
    let value = 0
    for (let index = 0; index < 4; index++) {
      const byte = this.byte()
      value = value * 128 + (byte & 127)
      if (byte < 128) return value
    }
    throw new Error('O arquivo MIDI contém um tempo de evento inválido.')
  }
}

export function decodeMidiFile(buffer: ArrayBuffer, makeId: () => string): MidiFile {
  const file = new Reader(new Uint8Array(buffer))
  if (file.tag() !== 'MThd') throw new Error('Selecione um arquivo MIDI padrão (.mid ou .midi).')
  const header = new Reader(file.read(file.integer(4)))
  const format = header.integer(2)
  const trackCount = header.integer(2)
  const division = header.integer(2)
  if (format > 1 || !trackCount || (format === 0 && trackCount !== 1) || !division || division >= 0x8000) {
    throw new Error('Use MIDI tipo 0 ou 1 com divisão musical PPQN.')
  }
  const result: MidiFile = { tracks: [] }
  for (let index = 0; index < trackCount; index++) {
    if (file.tag() !== 'MTrk') throw new Error('O arquivo MIDI contém uma pista inválida.')
    const reader = new Reader(file.read(file.integer(4)))
    const track: MidiTrack = { name: '', notes: [] }
    const active = new Map<number, Array<{ tick: number; velocity: number }>>()
    let tick = 0
    let runningStatus = 0
    while (!reader.done) {
      tick += reader.delta()
      const first = reader.byte()
      if (first === 0xff) {
        runningStatus = 0
        const type = reader.byte()
        const data = reader.read(reader.delta())
        if (type === 0x2f) break
        if (type === 0x03 && !track.name) {
          track.name = new TextDecoder().decode(data).replace(/[\u0000-\u001f]/g, '').trim().slice(0, 40)
        }
        if (type === 0x51 && tick === 0 && data.length === 3 && result.bpm === undefined) {
          const micros = data[0] * 65536 + data[1] * 256 + data[2]
          if (micros > 0) result.bpm = 60_000_000 / micros
        }
        if (type === 0x58 && tick === 0 && data.length >= 2 && result.timeSignature === undefined) {
          const signature = `${data[0]}/${2 ** data[1]}`
          if (signature === '2/4' || signature === '3/4' || signature === '4/4' || signature === '6/8' || signature === '12/8') result.timeSignature = signature
        }
        continue
      }
      if (first === 0xf0 || first === 0xf7) {
        runningStatus = 0
        reader.read(reader.delta())
        continue
      }
      const status = first >= 128 ? first : runningStatus
      if (status < 0x80 || status >= 0xf0) throw new Error('O arquivo MIDI contém um evento inválido.')
      runningStatus = status
      const message = status & 0xf0
      const channel = status & 15
      const note = first >= 128 ? reader.byte() : first
      const velocity = message === 0xc0 || message === 0xd0 ? 0 : reader.byte()
      if (note > 127 || velocity > 127) throw new Error('O arquivo MIDI contém dados de nota inválidos.')
      if (message !== 0x80 && message !== 0x90) continue
      const key = channel * 128 + note
      if (message === 0x90 && velocity > 0) {
        const pending = active.get(key) ?? []
        pending.push({ tick, velocity })
        active.set(key, pending)
        continue
      }
      const pending = active.get(key)
      const start = pending?.shift()
      if (!pending?.length) active.delete(key)
      if (start && tick > start.tick) track.notes.push({
        id: makeId(), note, channel, velocity: start.velocity, startBeat: start.tick / division, durationBeats: (tick - start.tick) / division,
      })
    }
    if (track.notes.length) {
      track.name ||= `MIDI ${index + 1}`
      track.notes.sort((a, b) => a.startBeat - b.startBeat || a.note - b.note)
      result.tracks.push(track)
    }
  }
  return result
}

function integer(value: number, bytes: number) {
  return Array.from({ length: bytes }, (_, index) => (value >>> ((bytes - 1 - index) * 8)) & 255)
}

function variable(value: number): number[] {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_DELTA) throw new Error('O intervalo entre eventos ultrapassa o limite do arquivo MIDI.')
  const bytes = [value & 127]
  while (value >= 128) {
    value >>>= 7
    bytes.unshift((value & 127) | 128)
  }
  return bytes
}

function chunk(tag: string, bytes: number[]): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(bytes.length + 8)
  result.set([...new TextEncoder().encode(tag), ...integer(bytes.length, 4)])
  result.set(bytes, 8)
  return result
}

export function encodeMidiFile(tracks: MidiTrack[], bpm: number, signature: TimeSignature): Blob {
  const [beats, beatUnit] = signature.split('/').map(Number)
  const tempo = Math.round(60_000_000 / bpm)
  const conductor = [0, 255, 81, 3, ...integer(tempo, 3), 0, 255, 88, 4, beats, Math.log2(beatUnit), 24, 8, 0, 255, 47, 0]
  const parts = [chunk('MThd', [0, 1, ...integer(tracks.length + 1, 2), ...integer(TICKS_PER_BEAT, 2)]), chunk('MTrk', conductor)]
  for (const track of tracks) {
    const name = new TextEncoder().encode(track.name)
    const bytes = [0, 255, 3, ...variable(name.length), ...name]
    const events = track.notes.flatMap((note) => {
      const first = Math.round(note.startBeat * TICKS_PER_BEAT)
      const end = Math.max(first + 1, Math.round((note.startBeat + note.durationBeats) * TICKS_PER_BEAT))
      const channel = note.channel ?? 0
      return [{ tick: first, status: 0x90 | channel, note: note.note, velocity: Math.max(1, note.velocity) },
        { tick: end, status: 0x80 | channel, note: note.note, velocity: 0 }]
    }).sort((a, b) => a.tick - b.tick || a.velocity - b.velocity)
    let position = 0
    for (const event of events) {
      bytes.push(...variable(event.tick - position), event.status, event.note, event.velocity)
      position = event.tick
    }
    bytes.push(0, 255, 47, 0)
    parts.push(chunk('MTrk', bytes))
  }
  return new Blob(parts, { type: 'audio/midi' })
}
