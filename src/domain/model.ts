export type TimeSignature = '2/4' | '3/4' | '4/4' | '6/8' | '12/8'
export type MonitorMode = 'off' | 'software' | 'direct'
export const DEFAULT_VST_BUFFER_FRAMES = 512

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

/**
 * Persisted VST3 identity. Audio processing stays in the Desktop host; the
 * project must retain this metadata even when a plug-in is not installed.
 */
export type Vst3Insert = {
  id: string
  format: 'vst3'
  bundlePath: string
  classId: string
  name: string
  vendor: string
  version: string
  kind?: 'effect' | 'instrument'
  bypass: boolean
  parameterValues: Record<string, number>
  stateBase64?: string
}

export type MidiNote = {
  id: string
  note: number
  velocity: number
  startBeat: number
  durationBeats: number
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
  sends?: { reverb: number; delay: number }
  mute: boolean
  solo: boolean
  armed: boolean
  monitorMode: MonitorMode
  recordChannels?: 1 | 2
  effects: EffectSettings
  vst3Inserts: Vst3Insert[]
  kind?: 'audio' | 'midi'
  midiNotes?: MidiNote[]
  clipIds: string[]
  takeIds: string[]
}

export type AudioProject = {
  markers?: Array<{ id: string; frame: number; name: string }>
  schemaVersion: 1
  id: string
  name: string
  createdAt: string
  updatedAt: string
  audioSampleRate: number
  bpm: number
  timeSignature: TimeSignature
  metronomeEnabled: boolean
  masterGainDb?: number
  vstBufferFrames?: 256 | 512 | 1024 | 2048 | 4096
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
    vst3Inserts: [],
    kind: 'audio',
    midiNotes: [],
    clipIds: [],
    takeIds: [],
  }
}

export function createMidiTrack(name: string, color = '#a855f7'): Track {
  return { ...createTrack(name, color), kind: 'midi', midiNotes: [] }
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
