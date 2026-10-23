import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')

test('o núcleo declara captura por AudioWorklet e não usa ScriptProcessor', async () => {
  const engine = await read('src/audio/AudioEngine.ts')
  assert.match(engine, /AudioWorkletNode/)
  assert.match(engine, /addModule/)
  assert.doesNotMatch(engine, /ScriptProcessorNode/)
})

test('o worklet captura PCM e não roteia a captura para a saída', async () => {
  const worklet = await read('public/worklets/pcm-recorder.worklet.js')
  assert.match(worklet, /channel\.slice\(\)\.buffer/)
  assert.match(worklet, /channel\.fill\(0\)/)
})

test('o contrato de export declara RIFF/WAVE e encoder MPEG Layer III local', async () => {
  const wav = await read('src/audio/wav.ts')
  assert.match(wav, /writeText\(0, 'RIFF'\)/)
  assert.match(wav, /writeText\(8, 'WAVE'\)/)
  assert.match(wav, /new lamejs\.Mp3Encoder/)
  assert.match(wav, /bitDepth === 32 \? 3 : 1/)
})

test('a captura mantém checkpoints PCM e só confirma o take em transação local', async () => {
  const engine = await read('src/audio/AudioEngine.ts')
  const repository = await read('src/storage/projectRepository.ts')
  assert.match(engine, /pendingDurableFrames >= 8192/)
  assert.match(engine, /await this\.durableWrite/)
  assert.match(repository, /const TAKE_DRAFT_STORE = 'takeDrafts'/)
  assert.match(repository, /async commitTake/)
  assert.match(repository, /database\.transaction\(\[PROJECT_STORE, ASSET_STORE, TAKE_DRAFT_STORE, TAKE_CHUNK_STORE\], 'readwrite'\)/)
})

test('assets e worklet são resolvidos contra BASE_URL para GitHub Pages', async () => {
  const engine = await read('src/audio/AudioEngine.ts')
  const main = await read('src/main.tsx')
  assert.match(engine, /import\.meta\.env\.BASE_URL/)
  assert.match(main, /import\.meta\.env\.BASE_URL/)
})
