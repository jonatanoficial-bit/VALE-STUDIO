import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'vite'

const result = await build({
  configFile: false,
  publicDir: false,
  logLevel: 'silent',
  build: { write: false, lib: { entry: 'src/audio/automation.ts', formats: ['es'] } },
})
const [{ code }] = result[0].output
const { AutomationPass, automationValueAt } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)

function track(mode) {
  return {
    id: 'voz', gainDb: 0, pan: 0,
    automation: { mode, pan: [{ frame: 0, value: -1 }, { frame: 50, value: 0 }, { frame: 100, value: 1 }] },
  }
}

test('Write substitui o intervalo percorrido e conserva a curva fora dele', () => {
  const original = track('write')
  const pass = new AutomationPass([original], 20, 1000)
  assert.equal(pass.value('voz', 'pan'), -0.6)
  assert.equal(pass.write('voz', 'pan', 35, 0.5), true)
  const written = { ...original, automation: pass.finish(65).get('voz') }
  assert.equal(automationValueAt(written, 'pan', 20), -0.6)
  assert.equal(automationValueAt(written, 'pan', 35), 0.5)
  assert.equal(automationValueAt(written, 'pan', 65), 0.5)
  for (const frame of [0, 10, 19, 66, 80, 100]) {
    assert.ok(Math.abs(automationValueAt(written, 'pan', frame) - automationValueAt(original, 'pan', frame)) < 1e-9)
  }
  assert.ok(!written.automation.pan.some((point) => point.frame === 50))
  assert.deepEqual(written.automation.gainDb.map((point) => point.value), [0, 0, 0, 0])
})

test('Touch volta à automação anterior entre dois gestos', () => {
  const original = track('touch')
  const pass = new AutomationPass([original], 0, 1000)
  assert.equal(pass.value('voz', 'pan'), undefined)
  pass.write('voz', 'pan', 15, 0.4)
  assert.equal(pass.release('voz', 'pan', 25), true)
  assert.equal(pass.value('voz', 'pan'), undefined)
  pass.write('voz', 'pan', 60, -0.2)
  pass.release('voz', 'pan', 70)
  const written = { ...original, automation: pass.finish(100).get('voz') }
  assert.equal(automationValueAt(written, 'pan', 24), 0.4)
  assert.equal(automationValueAt(written, 'pan', 50), 0)
  assert.equal(automationValueAt(written, 'pan', 69), -0.2)
  assert.ok(!written.automation.gainDb)
})

test('Latch mantém o último movimento até parar e não grava uma pista intocada', () => {
  const original = track('latch')
  const pass = new AutomationPass([original, { ...original, id: 'outra' }, { ...track('read'), id: 'leitura' }], 0, 1000)
  assert.equal(pass.write('leitura', 'pan', 20, 1), false)
  pass.write('voz', 'pan', 20, 0.75)
  assert.equal(pass.release('voz', 'pan', 30), false)
  assert.equal(pass.value('voz', 'pan'), 0.75)
  const automation = pass.finish(70)
  assert.equal(automation.size, 1)
  const written = { ...original, automation: automation.get('voz') }
  assert.equal(automationValueAt(written, 'pan', 50), 0.75)
  assert.equal(automationValueAt(written, 'pan', 70), 0.75)
  assert.equal(automationValueAt(written, 'pan', 71), automationValueAt(original, 'pan', 71))
})
