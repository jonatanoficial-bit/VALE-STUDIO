import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

const worklet = await readFile(new URL('../public/worklets/pcm-recorder.worklet.js', import.meta.url), 'utf8')

function setup() {
  const messages = []
  let Processor
  const sandbox = {
    currentFrame: 0,
    AudioWorkletProcessor: class {
      port = { postMessage: (data) => messages.push(data) }
    },
    registerProcessor(_name, processor) { Processor = processor },
  }
  runInNewContext(worklet, sandbox)
  const recorder = new Processor({ processorOptions: { waitForWindow: true } })
  const input = [new Float32Array(128).fill(0.4), new Float32Array(128).fill(-0.2)]
  const output = [[new Float32Array(128).fill(1)]]
  const block = (frame, signal = input) => {
    sandbox.currentFrame = frame
    recorder.process([signal], output)
    assert.ok(output[0][0].every((sample) => sample === 0))
  }
  return { block, recorder, messages }
}

test('punch recorta as bordas dos blocos e entrega os canais completos antes de finalizar', () => {
  const { block, recorder, messages } = setup()
  block(0)
  assert.equal(messages.length, 0)
  recorder.port.onmessage({ data: { type: 'window', start: 153, end: 273 } })
  block(128)
  block(128)
  block(256)
  block(384)
  assert.deepEqual(messages.map((event) => event.type), ['pcm', 'pcm', 'window-ended'])
  assert.equal(messages[2].interrupted, false)
  assert.equal(messages[0].channels[0].byteLength / 4, 103)
  assert.equal(messages[1].channels[0].byteLength / 4, 17)
  assert.equal(new Float32Array(messages[0].channels[1])[0], Math.fround(-0.2))
})

test('punch atrasado ou sem entrada interrompe a captura antes de gravar dados desalinhados', () => {
  for (const reason of ['late', 'missing']) {
    const { block, recorder, messages } = setup()
    recorder.port.onmessage({ data: { type: 'window', start: 10, end: 273 } })
    if (reason === 'late') block(128)
    else block(0, [])
    assert.equal(messages.length, 1)
    assert.equal(messages[0].type, 'window-ended')
    assert.equal(messages[0].interrupted, true)
  }
})
