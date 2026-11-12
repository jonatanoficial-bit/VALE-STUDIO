import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'vite'

const result = await build({
  configFile: false,
  publicDir: false,
  logLevel: 'silent',
  build: { write: false, lib: { entry: 'src/audio/loopRecording.ts', formats: ['es'] } },
})
const [{ code }] = result[0].output
const { loopSlices } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)

test('os checkpoints em loop preservam os frames que atravessam várias passagens', () => {
  assert.deepEqual(loopSlices(95, 118, 100, 3), [
    { pass: 0, offset: 0, firstFrame: 95, frameCount: 5 },
    { pass: 1, offset: 5, firstFrame: 0, frameCount: 100 },
    { pass: 2, offset: 105, firstFrame: 0, frameCount: 13 },
  ])
  assert.deepEqual(loopSlices(290, 20, 100, 3), [{ pass: 2, offset: 0, firstFrame: 90, frameCount: 10 }])
})
