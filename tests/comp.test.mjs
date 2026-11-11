import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'vite'

const result = await build({
  configFile: false,
  publicDir: false,
  logLevel: 'silent',
  build: { write: false, lib: { entry: 'src/domain/comp.ts', formats: ['es'] } },
})
const [{ code }] = result[0].output
const { applyCompRegion, clipIsAudible } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)

test('comp substitui apenas o intervalo escolhido e preserva os takes e clipes importados', () => {
  const original = { id: 'original', assetId: 'a', trackId: 'track', timelineStartFrame: 0, sourceOffsetFrame: 12, durationFrames: 100,
    gainDb: -3, fadeInFrames: 0, fadeOutFrames: 0, takeId: 'primeiro' }
  const alternative = { id: 'alternativo', assetId: 'b', trackId: 'track', timelineStartFrame: 0, sourceOffsetFrame: 0, durationFrames: 100,
    gainDb: 0, fadeInFrames: 0, fadeOutFrames: 0, takeId: 'segundo' }
  const imported = { ...original, id: 'importado', takeId: undefined }
  const take = { id: 'segundo', assetId: 'b', trackId: 'track', durationFrames: 100, selected: false }
  const project = {
    audioSampleRate: 48000, tracks: [{ id: 'track', clipIds: [original.id, alternative.id, imported.id] }],
    clips: [original, alternative, imported], assets: [{ id: 'a', durationFrames: 120 }, { id: 'b', durationFrames: 100 }],
    takes: [{ id: 'primeiro', trackId: 'track', selected: true }, take],
  }
  let index = 0
  const id = () => `comp-${++index}`
  const comp = applyCompRegion(project, take, 11, 41, 20, id)
  assert.deepEqual(comp.clips.slice(0, 3), project.clips)
  assert.equal(comp.takes, project.takes)
  assert.equal(clipIsAudible(comp, imported), true)
  assert.equal(clipIsAudible(comp, original), false)
  const segments = comp.clips.filter((clip) => clip.compSegment).sort((a, b) => a.timelineStartFrame - b.timelineStartFrame)
  assert.deepEqual(segments.map(({ timelineStartFrame, sourceOffsetFrame, durationFrames }) =>
    [timelineStartFrame, sourceOffsetFrame, durationFrames]), [[0, 12, 20], [20, 11, 30], [50, 62, 50]])
  assert.ok(segments.every((clip) => clipIsAudible(comp, clip)))
  const edited = applyCompRegion(comp, take, 40, 50, 54, id)
  assert.equal(edited.clips.filter((clip) => clip.compSegment).length, 5)
  assert.equal(edited.tracks[0].clipIds.length, edited.clips.length)
  assert.throws(() => applyCompRegion(comp, take, 40, 150, 54, id), /trecho válido/)
})
