import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const require = createRequire(import.meta.url)

test('o bundle local lamejs produz um fluxo MPEG Layer III com sync header', async () => {
  const source = await readFile(require.resolve('lamejs/lame.min.js'), 'utf8')
  const lamejs = new Function(`${source}\nreturn lamejs;`)()
  const encoder = new lamejs.Mp3Encoder(1, 48000, 192)
  const input = new Int16Array(2304)
  for (let index = 0; index < input.length; index += 1) input[index] = Math.round(Math.sin(index / 12) * 12000)
  const first = encoder.encodeBuffer(input)
  const last = encoder.flush()
  const bytes = new Uint8Array(first.length + last.length)
  bytes.set(first)
  bytes.set(last, first.length)
  assert.ok(bytes.length > 4)
  assert.equal(bytes[0], 0xff)
  assert.equal(bytes[1] & 0xe0, 0xe0)
})
