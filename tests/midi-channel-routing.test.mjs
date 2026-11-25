import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'vite'

const result = await build({
  configFile: false, publicDir: false, logLevel: 'silent',
  build: { write: false, lib: { entry: 'src/domain/model.ts', formats: ['es'] } },
})
const [{ code }] = result[0].output
const { acceptsMidiChannel, createMidiTrack } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)

test('pista MIDI aceita todos os canais por padrão e pode fixar um canal', () => {
  const track = createMidiTrack('Instrumento')
  assert.equal(acceptsMidiChannel(track, 0), true)
  assert.equal(acceptsMidiChannel(track, 15), true)
  assert.equal(acceptsMidiChannel({ ...track, midiInputChannel: 3 }, 3), true)
  assert.equal(acceptsMidiChannel({ ...track, midiInputChannel: 3 }, 2), false)
})

test('canal MIDI inválido nunca alcança uma pista', () => {
  const track = createMidiTrack('Instrumento')
  assert.equal(acceptsMidiChannel(track, -1), false)
  assert.equal(acceptsMidiChannel(track, 16), false)
  assert.equal(acceptsMidiChannel(track, 1.5), false)
})
