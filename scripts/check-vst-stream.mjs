import { spawn, execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'

const [bundle, expectedKind] = process.argv.slice(2)
assert.ok(bundle && ['effect', 'instrument'].includes(expectedKind),
  'Uso: node scripts/check-vst-stream.mjs <módulo.vst3> <effect|instrument>')
const executable = resolve('native/vst3-host/dist/vst3-host.exe')
const catalog = JSON.parse(execFileSync(executable, ['--scan', bundle], { timeout: 15_000, encoding: 'utf8' }))
const plugin = catalog.plugins.find((item) => item.kind === expectedKind)
assert.ok(plugin, 'A classe de teste não foi encontrada.')
const frames = 1024
const rate = 48000
const child = spawn(executable, ['--stream', plugin.bundlePath, plugin.classId, frames, rate, 120].map(String), {
  windowsHide: true, stdio: ['pipe', 'pipe', 'inherit'],
})
child.stdin.on('error', () => child.kill())
const deadline = setTimeout(() => child.kill(), 25_000)
const chunks = child.stdout[Symbol.asyncIterator]()
let pending = Buffer.alloc(0)
async function read(size) {
  while (pending.length < size) {
    const next = await chunks.next()
    assert.equal(next.done, false, 'O host fechou o fluxo antes de retornar o bloco.')
    pending = Buffer.concat([pending, next.value])
  }
  const result = pending.subarray(0, size)
  pending = pending.subarray(size)
  return result
}

try {
  assert.deepEqual(await read(1), Buffer.from([1]))
  let peak = 0
  let delta = 0
  for (let block = 0; block < 72; block += 1) {
    const event = expectedKind === 'instrument' && (block === 0 || block === 48)
    const request = Buffer.alloc(frames * 8 + 4 + (event ? 16 : 0))
    if (expectedKind === 'effect') {
      for (let i = 0; i < frames * 2; i += 1) {
        request.writeFloatLE(0.2 * Math.sin((block * frames + Math.floor(i / 2)) * 0.031), i * 4)
      }
    }
    request.writeUInt32LE(event ? 1 : 0, frames * 8)
    if (event) {
      request.writeUInt32LE(60, frames * 8 + 8)
      request.writeUInt32LE(block === 0 ? 112 : 0, frames * 8 + 12)
    }
    child.stdin.write(request)
    const reply = await read(frames * 8)
    for (let i = 0; i < frames * 2; i += 1) {
      const value = reply.readFloatLE(i * 4)
      assert.ok(Number.isFinite(value))
      peak = Math.max(peak, Math.abs(value))
      delta = Math.max(delta, Math.abs(value - request.readFloatLE(i * 4)))
    }
  }
  assert.ok(peak > 0.0001, 'A saída permaneceu silenciosa.')
  console.log(JSON.stringify({ plugin: plugin.name, peak, delta, blocks: 72 }))
} finally {
  clearTimeout(deadline)
  child.stdin.end()
  if (child.exitCode === null) child.kill()
}
