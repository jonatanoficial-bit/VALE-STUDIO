import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

async function loadZipModule() {
  const source = await readFile(new URL('../src/audio/zip.ts', import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)
}

test('o ZIP de stems contém cabeçalhos locais, diretório central e nomes UTF-8', async () => {
  const { createZip } = await loadZipModule()
  const blob = await createZip([
    { name: 'vale--01-voz.wav', blob: new Blob(['audio-1']) },
    { name: 'vale--02-violão.wav', blob: new Blob(['audio-2']) },
  ])
  const bytes = new Uint8Array(await blob.arrayBuffer())
  const view = new DataView(bytes.buffer)
  const firstNameLength = view.getUint16(26, true)
  const firstDataLength = view.getUint32(18, true)
  const centralOffset = 30 + firstNameLength + firstDataLength + 30 + view.getUint16(30 + firstNameLength + firstDataLength + 26, true) + view.getUint32(30 + firstNameLength + firstDataLength + 18, true)

  assert.equal(blob.type, 'application/zip')
  assert.equal(view.getUint32(0, true), 0x04034b50)
  assert.equal(new TextDecoder().decode(bytes.slice(30, 30 + firstNameLength)), 'vale--01-voz.wav')
  assert.equal(view.getUint32(centralOffset, true), 0x02014b50)
  assert.equal(view.getUint32(bytes.length - 22, true), 0x06054b50)
  assert.equal(view.getUint16(bytes.length - 14, true), 2)
})
