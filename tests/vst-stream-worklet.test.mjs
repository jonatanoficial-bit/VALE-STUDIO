import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

const source = await readFile(new URL('../public/worklets/vst-stream.worklet.js', import.meta.url), 'utf8')

function worklet(instrument) {
  const blocks = []
  let Processor
  const scope = {
    currentFrame: 0,
    AudioWorkletProcessor: class {
      port = { postMessage: (message) => blocks.push(message) }
    },
    registerProcessor: (_, processor) => { Processor = processor },
  }
  runInNewContext(source, scope)
  const node = new Processor({ processorOptions: { frames: 256, instrument } })
  return {
    blocks,
    deliver: (data) => node.port.onmessage({ data }),
    render(value = 0) {
      const input = new Float32Array(128).fill(value)
      const output = [new Float32Array(128), new Float32Array(128)]
      node.process([[input, input]], [output])
      scope.currentFrame += 128
      return output[0][0]
    },
  }
}

test('o insert devolve áudio processado no bloco correto e usa dry no atraso', () => {
  const node = worklet(false)
  assert.equal(node.render(0.25), 0)
  node.render(0.25)
  assert.equal(node.blocks[0].pcm[0], 0.25)
  node.deliver({ type: 'result', sequence: 0, pcm: new Float32Array(512).fill(0.75) })
  for (let i = 0; i < 4; i += 1) assert.equal(node.render(0.25), 0)
  assert.equal(node.render(0.25), 0.75)
  assert.equal(node.render(0.25), 0.75)
  assert.equal(node.render(0.25), 0.25)
})

test('o instrumento encaminha note-on e note-off com posição dentro do bloco', () => {
  const node = worklet(true)
  node.deliver({ type: 'events', events: [
    { frame: 144, note: 60, velocity: 100, channel: 0 },
    { frame: 300, note: 60, velocity: 0, channel: 0 },
  ] })
  for (let i = 0; i < 4; i += 1) node.render()
  assert.equal(JSON.stringify(node.blocks[0].events), '[[144,60,100,0]]')
  assert.equal(JSON.stringify(node.blocks[1].events), '[[44,60,0,0]]')
})
