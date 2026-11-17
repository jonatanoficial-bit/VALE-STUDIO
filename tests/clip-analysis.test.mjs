import assert from 'node:assert/strict'
import { test } from 'node:test'
import { analyzeClipPcm, findTransients, regionsAboveSilence } from '../src/audio/clipAnalysis.ts'
import { clipsWithoutSilence } from '../src/domain/stripSilence.ts'

test('análise respeita offset, ganho e a taxa real do áudio estéreo', () => {
  const left = new Float32Array(1000)
  const right = new Float32Array(1000)
  left[49] = 1
  right[210] = 0.75
  left[590] = 0.5
  const buffer = { sampleRate: 2000, length: left.length, numberOfChannels: 2, getChannelData: (i) => [left, right][i] }
  const analysis = analyzeClipPcm(buffer, 1000, 50, 350, -6)
  assert.deepEqual(findTransients(analysis, -20), [55, 245])
  assert.deepEqual(regionsAboveSilence(analysis, -20, 30, 10), [{ start: 45, end: 70 }, { start: 235, end: 260 }])
  assert.deepEqual(findTransients(analysis, -6), [])
})

test('separação mantém o alinhamento e preserva fades que cruzam áreas mantidas', () => {
  const clip = { id: 'clip', assetId: 'wav', trackId: 'track', timelineStartFrame: 500, sourceOffsetFrame: 100, durationFrames: 400,
    gainDb: -4, fadeInFrames: 30, fadeOutFrames: 40, takeId: 'take' }
  let id = 0
  const result = clipsWithoutSilence(clip, [{ start: 10, end: 100 }, { start: 300, end: 365 }], 1000, () => String(++id))
  assert.deepEqual(result, [
    { ...clip, id: '1', durationFrames: 100, fadeOutFrames: 3 },
    { ...clip, id: '2', durationFrames: 100, timelineStartFrame: 800, sourceOffsetFrame: 400, fadeInFrames: 3 },
  ])
  const [attack, decay] = clipsWithoutSilence(clip, [{ start: 10, end: 15 }, { start: 380, end: 395 }], 1000, () => 'edge')
  assert.equal(attack.durationFrames, 30)
  assert.equal(attack.fadeInFrames, 30)
  assert.equal(decay.durationFrames, 40)
  assert.equal(decay.timelineStartFrame, 860)
  assert.equal(decay.fadeOutFrames, 40)
})

test('silêncios curtos são mantidos e o áudio inteiramente silencioso não gera clipes', () => {
  const analysis = { length: 100, rate: 1000, window: 5, peaks: new Float32Array(20), peakFrames: new Float64Array(20) }
  assert.deepEqual(regionsAboveSilence(analysis, -48, 20, 0), [])
  analysis.peaks[1] = 0.5
  analysis.peaks[4] = 0.5
  analysis.peaks[18] = 0.5
  assert.deepEqual(regionsAboveSilence(analysis, -48, 20, 0), [{ start: 0, end: 25 }, { start: 90, end: 100 }])
})
