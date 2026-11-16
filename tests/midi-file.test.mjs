import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'vite'

const result = await build({
  configFile: false,
  publicDir: false,
  logLevel: 'silent',
  build: { write: false, lib: { entry: 'src/midi/midiFile.ts', formats: ['es'] } },
})
const [{ code }] = result[0].output
const { decodeMidiFile, encodeMidiFile } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)

function formatZero(events) {
  const header = [77, 84, 104, 100, 0, 0, 0, 6, 0, 0, 0, 1, 1, 224]
  const littleTrack = [77, 84, 114, 107, 0, 0, 0, events.length, ...events]
  return Uint8Array.from([...header, ...littleTrack]).buffer
}

test('MIDI tipo 0 interpreta running status, note-on de velocidade zero e canais distintos', () => {
  let id = 0
  const file = formatZero([
    0, 0x91, 60, 100,
    0, 64, 96,
    0x81, 0x70, 0x92, 60, 120,
    0x81, 0x70, 0x81, 60, 0,
    0, 64, 0,
    0x83, 0x60, 0x92, 60, 0,
    0, 0xff, 0x2f, 0,
  ])
  const { tracks } = decodeMidiFile(file, () => String(++id))
  assert.equal(tracks.length, 1)
  assert.deepEqual(tracks[0].notes.map(({ note, channel, velocity, startBeat, durationBeats }) => ({ note, channel, velocity, startBeat, durationBeats })), [
    { note: 60, channel: 1, velocity: 100, startBeat: 0, durationBeats: 1 },
    { note: 64, channel: 1, velocity: 96, startBeat: 0, durationBeats: 1 },
    { note: 60, channel: 2, velocity: 120, startBeat: 0.5, durationBeats: 1.5 },
  ])
})

test('MIDI tipo 1 reconstrói tempo, compasso, nome UTF-8 e notas de cada pista', async () => {
  const notes = [{ id: 'a', note: 127, channel: 15, velocity: 90, startBeat: 1.25, durationBeats: 0.5 }]
  const blob = encodeMidiFile([{ name: 'Violão', notes }, { name: 'Baixo', notes: [{ ...notes[0], note: 36, channel: 0 }] }], 120, '6/8')
  const file = decodeMidiFile(await blob.arrayBuffer(), () => 'a')
  assert.equal(file.bpm, 120)
  assert.equal(file.timeSignature, '6/8')
  assert.deepEqual(file.tracks, [{ name: 'Violão', notes }, { name: 'Baixo', notes: [{ ...notes[0], note: 36, channel: 0 }] }])
})

test('MIDI rejeita tamanho truncado e running status depois de meta-evento', () => {
  const file = formatZero([0, 0x90, 60, 100, 0, 0xff, 0x01, 0, 1, 60, 0, 0, 0xff, 0x2f, 0])
  assert.throws(() => decodeMidiFile(file, () => ''), /evento inválido/)
  assert.throws(() => decodeMidiFile(file.slice(0, -1), () => ''), /truncado/)
})
