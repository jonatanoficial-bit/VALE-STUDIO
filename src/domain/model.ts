export type TimeSignature = '2/4' | '3/4' | '4/4' | '6/8' | '12/8'
export type MonitorMode = 'off' | 'software' | 'direct'

export type EffectSettings = {
  highPassEnabled: boolean
  highPassHz: number
  compressorEnabled: boolean
  threshold: number
  ratio: number
  reverbEnabled: boolean
  reverbMix: number
  delayEnabled: boolean
  delayMix: number
  delayTime: number
}

export type MediaAsset = {
  id: string
  name: string
  mimeType: string
  sampleRate: number
  channels: number
  frames: number
  durationFrames: number
  byteLength: number
  peaks: number[]
  createdAt: string
}

export type Clip = {
  id: string
  assetId: string
  trackId: string
  timelineStartFrame: number
  sourceOffsetFrame: number
  durationFrames: number
  gainDb: number
  fadeInFrames: number
  fadeOutFrames: number
  takeId?: string
}

export type Take = {
  id: string
  assetId: string
  trackId: string
  name: string
  startFrame: number
  durationFrames: number
  createdAt: string
  calibrationFrames: number
  selected: boolean
}

export type Track = {
  id: string
  name: string
  color: string
  gainDb: number
  pan: number
  mute: boolean
  solo: boolean
  armed: boolean
  monitorMode: MonitorMode
  effects: EffectSettings
  clipIds: string[]
  takeIds: string[]
}

export type AudioProject = {
  schemaVersion: 1
  id: string
  name: string
  createdAt: string
  updatedAt: string
  audioSampleRate: number
  bpm: number
  timeSignature: TimeSignature
  metronomeEnabled: boolean
  countInBars: 0 | 1 | 2
  calibrationFrames: number
  calibrationLabel: string
  tracks: Track[]
  clips: Clip[]
  takes: Take[]
  assets: MediaAsset[]
}

export type ProjectSummary = Pick<AudioProject, 'id' | 'name' | 'createdAt' | 'updatedAt' | 'audioSampleRate' | 'bpm' | 'tracks' | 'assets'>

export const DEFAULT_EFFECTS: EffectSettings = {
  highPassEnabled: false,
  highPassHz: 80,
  compressorEnabled: false,
  threshold: -18,
  ratio: 3,
  reverbEnabled: false,
  reverbMix: 0.16,
  delayEnabled: false,
  delayMix: 0.12,
  delayTime: 0.25,
}

export function createTrack(name: string, color = '#20a7ff'): Track {
  return {
    id: crypto.randomUUID(),
    name,
    color,
    gainDb: 0,
    pan: 0,
    mute: false,
    solo: false,
    armed: false,
    monitorMode: 'off',
    effects: { ...DEFAULT_EFFECTS },
    clipIds: [],
    takeIds: [],
  }
}

export function createProject(name: string, sampleRate = 48000): AudioProject {
  const now = new Date().toISOString()
  return {
    schemaVersion: 1,
    id: crypto.randomUUID(),
    name,
    createdAt: now,
    updatedAt: now,
    audioSampleRate: sampleRate,
    bpm: 100,
    timeSignature: '4/4',
    metronomeEnabled: true,
    countInBars: 1,
    calibrationFrames: 0,
    calibrationLabel: 'Sem calibração',
    tracks: [createTrack('Voz principal', '#1aa8ff')],
    clips: [],
    takes: [],
    assets: [],
  }
}

export function dbToGain(value: number): number {
  return Math.pow(10, value / 20)
}

export function gainToDb(value: number): number {
  return value <= 0 ? -96 : 20 * Math.log10(value)
}
