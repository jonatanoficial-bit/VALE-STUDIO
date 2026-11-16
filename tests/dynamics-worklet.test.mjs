import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import vm from 'node:vm'

const source = await readFile(new URL('../public/worklets/dynamics.worklet.js', import.meta.url), 'utf8')
let Processor
vm.runInNewContext(source, {
  AudioWorkletProcessor: class {},
  registerProcessor: (_, implementation) => { Processor = implementation },
  sampleRate: 48000,
})

function block(processor, left, right, options) {
  const output = [new Float32Array(left.length), new Float32Array(right.length)]
  const params = Object.fromEntries(Object.entries({
    enabled: 1, thresholdDb: -20, depthDb: -60, releaseMs: 20, ...options,
  }).map(([name, value]) => [name, [value]]))
  processor.process([[left, right]], [output], params)
  return output
}

test('gate reduz ruído e usa a mesma envoltória nos dois canais', () => {
  const gate = new Processor({ processorOptions: { mode: 'gate' } })
  const quiet = new Float32Array(480).fill(0.01)
  const [initial] = block(gate, quiet, quiet)
  assert.ok(Math.abs(initial[479]) < 0.000011)
  const [left, right] = block(gate, new Float32Array(960).fill(0.5), new Float32Array(960).fill(0.025))
  assert.ok(left[959] > 0.49)
  assert.ok(Math.abs(right[959] / left[959] - 0.05) < 1e-6)
  const [closed] = block(gate, new Float32Array(9600).fill(0.01), new Float32Array(9600))
  assert.ok(closed[9599] < 0.000012)
})

test('limiter respeita teto por amostra, mantém balanço e recupera o ganho', () => {
  const limiter = new Processor({ processorOptions: { mode: 'limiter' } })
  const data = Float32Array.from([0.02, 2, -4, 0.05])
  const [left, right] = block(limiter, data, data.map((sample) => sample / 2), { thresholdDb: -6 })
  const threshold = 10 ** (-6 / 20)
  assert.ok(left.every((sample) => Math.abs(sample) <= threshold + 1e-7))
  assert.ok(Math.abs(left[1] - threshold) < 1e-7)
  assert.ok(Math.abs(right[2] - left[2] / 2) < 1e-7)
  const weak = new Float32Array(9600).fill(0.01)
  const [released] = block(limiter, weak, weak, { thresholdDb: -6 })
  assert.ok(released[9599] > 0.00999)
  assert.deepEqual(block(limiter, data, data, { enabled: 0 }), [data, data])
})
