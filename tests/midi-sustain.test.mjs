import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Sustain } from '../src/midi/Sustain.ts'

test('sustain adia note-off somente no canal do pedal e libera ao soltar', () => {
  const events = []
  const input = new Sustain(event => events.push(event))
  const send = (...data) => input.receive(Uint8Array.from(data))
  send(0x90, 60, 100)
  send(0x91, 60, 90)
  send(0xb0, 64, 127)
  send(0x80, 60, 0)
  send(0x81, 60, 0)
  assert.deepEqual(events.map(event=>[event.type,event.channel]), [['noteon',0],['noteon',1],['noteoff',1]])
  send(0xb0, 64, 0)
  assert.equal(events.at(-1).type,'noteoff')
  assert.equal(events.at(-1).channel,0)
  assert.equal(events.length,4)
})

test('repetir nota sustentada encerra a voz anterior e panic limpa todas as notas', () => {
  const events = []
  const input = new Sustain(event=>events.push(event))
  const send = (...data) => input.receive(Uint8Array.from(data))
  send(0xb0,64,127)
  send(0x90,60,100)
  send(0x90,60,0)
  send(0x90,60,90)
  assert.deepEqual(events.map(event=>event.type),['noteon','noteoff','noteon'])
  input.panic()
  input.panic()
  send(0xb0,64,0)
  assert.equal(events.length,4)
  assert.equal(events.at(-1).type,'noteoff')
})

test('CC 123 encerra notas do próprio canal e mensagens incompletas são ignoradas', () => {
  const events=[]
  const input=new Sustain(event=>events.push(event))
  input.receive(Uint8Array.from([0x90,60]))
  input.receive(Uint8Array.from([0x90,60,100]))
  input.receive(Uint8Array.from([0x91,65,100]))
  input.receive(Uint8Array.from([0xb0,123,0]))
  assert.deepEqual(events.at(-1),{type:'noteoff',note:60,velocity:0,channel:0})
  input.panic()
  assert.equal(events.length,4)
  assert.equal(events.at(-1).channel,1)
})
