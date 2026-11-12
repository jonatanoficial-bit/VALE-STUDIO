import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const asModule = (source) => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`

test('o WAV intercala os canais e preserva o formato e as amostras', async () => {
  const lame = await readFile(require.resolve('lamejs/lame.min.js'), 'utf8')
  const source = (await readFile(new URL('../src/audio/wav.ts', import.meta.url), 'utf8'))
    .replace('lamejs/lame.min.js?raw', asModule(`export default ${JSON.stringify(lame)}`))
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } })
  const { encodeWav } = await import(asModule(outputText))
  const samples = [Float32Array.of(0.25, -1.5), Float32Array.of(-0.5, 1)]
  const buffer = { numberOfChannels: 2, length: 2, sampleRate: 48000, getChannelData: (channel) => samples[channel] }

  for (const [depth, expected] of [
    [16, [8191, -16384, -32768, 32767]],
    [24, [2097152, -4194303, -8388607, 8388607]],
    [32, [0.25, -0.5, -1.5, 1]],
  ]) {
    const bytes = await encodeWav(buffer, depth).arrayBuffer()
    const view = new DataView(bytes)
    const stride = depth / 8
    assert.equal(view.getUint16(20, true), depth === 32 ? 3 : 1)
    assert.equal(view.getUint16(22, true), 2)
    assert.equal(view.getUint32(24, true), 48000)
    assert.equal(view.getUint16(32, true), 2 * stride)
    assert.equal(view.getUint32(40, true), 4 * stride)
    assert.equal(bytes.byteLength, 44 + 4 * stride)
    const actual = expected.map((_, index) => {
      const offset = 44 + index * stride
      if (depth === 16) return view.getInt16(offset, true)
      if (depth === 32) return view.getFloat32(offset, true)
      return view.getUint8(offset) + view.getUint8(offset + 1) * 256 + view.getInt8(offset + 2) * 65536
    })
    assert.deepEqual(actual, expected)
  }
})
