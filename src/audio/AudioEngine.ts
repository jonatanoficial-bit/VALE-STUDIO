import type { AudioProject, Clip, MonitorMode, Track } from '../domain/model'
import { dbToGain, DEFAULT_VST_BUFFER_FRAMES } from '../domain/model'
import { buildPeaks } from './peaks'
import { encodeMp3, encodeWav } from './wav'
import { finishAsioCapture, isDesktopRuntime, openVstStream, readAsioCapture, startAsioMonitor, type AsioSettings } from '../platform/desktop'

type VstNote = { frame: number; note: number; velocity: number; channel: number }
type NativeInsert = { id: string; node: AudioWorkletNode; close: () => void; showEditor: () => void }

type TrackGraph = {
  highPass: BiquadFilterNode
  compressor: DynamicsCompressorNode
  reverbGain: GainNode
  delayGain: GainNode
  delay: DelayNode
  fader: GainNode
  panner: StereoPannerNode
  analyser: AnalyserNode
  sends: Record<'reverb' | 'delay', GainNode>
  input?: AudioNode
  instrument?: AudioWorkletNode
}

type SendBuses = Record<'reverb' | 'delay', AudioNode>

function sendLevel(value?: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0
}

function masterLevel(project: AudioProject): number {
  const db = project.masterGainDb
  return 0.92 * dbToGain(typeof db === 'number' && Number.isFinite(db) ? Math.max(-60, Math.min(6, db)) : 0)
}

export type AudioCapabilities = {
  sampleRate: number
  audioWorklet: boolean
  outputLatencyMs?: number
  inputSettings?: MediaTrackSettings
}

export type CapturedRecording = {
  blob: Blob
  buffer: AudioBuffer
  peaks: number[]
  frames: number
  channels: number
  sampleRate: number
  inputSettings?: MediaTrackSettings
  durability: {
    persistedChunks: number
    persistedFrames: number
    error?: string
  }
}

export type RecordingPcmChunk = {
  sequence: number
  firstFrame: number
  frameCount: number
  channels: number
  pcm: ArrayBuffer
  writtenAt: string
}

export type RecordingStart = {
  inputSettings?: MediaTrackSettings
  startFrame: number
}

export type StemExport = {
  trackId: string
  trackName: string
  blob: Blob
}

function createImpulse(context: BaseAudioContext, seconds = 1.2): AudioBuffer {
  const length = Math.max(1, Math.floor(context.sampleRate * seconds))
  const impulse = context.createBuffer(2, length, context.sampleRate)
  for (let channel = 0; channel < impulse.numberOfChannels; channel += 1) {
    const data = impulse.getChannelData(channel)
    for (let frame = 0; frame < length; frame += 1) {
      const decay = Math.pow(1 - frame / length, 2.8)
      data[frame] = (Math.random() * 2 - 1) * decay
    }
  }
  return impulse
}

function safeDisconnect(node?: AudioNode): void {
  try {
    node?.disconnect()
  } catch {
    // A node may have been disconnected by a browser interruption.
  }
}

export class AudioEngine {
  private context?: AudioContext
  private workletLoaded = false
  private metronomeTimer?: number
  private metronomeNextBeat = 0
  private metronomeBeat = 0
  private master?: GainNode
  private assetBuffers = new Map<string, AudioBuffer>()
  private liveGraphs = new Map<string, TrackGraph>()
  private liveMixOutput?: GainNode
  private scheduledNotes = new Set<OscillatorNode>()
  private nativeInserts: NativeInsert[] = []
  private playGeneration = 0
  private vstWorklet?: Promise<void>
  private liveVstNotes = new Map<string, Set<number>>()
  private sources = new Set<AudioBufferSourceNode>()
  private previewSource?: AudioBufferSourceNode
  private playheadStartFrame = 0
  private playStartedAt = 0
  private playing = false
  private stream?: MediaStream
  private inputSource?: MediaStreamAudioSourceNode
  private inputMeter?: { peak: number; rms: number }
  private recorder?: AudioWorkletNode
  private monitorGain?: GainNode
  private recordingChunks: Float32Array[] = []
  private recordingChannels: 1 | 2 = 1
  private recordingTrackId?: string
  private recordingStartFrame = 0
  private recordingSettings?: MediaTrackSettings
  private asioCapture?: {
    rate: number; frames: number; timer?: number
    pending?: Promise<void>; error?: string; stopping: boolean
  }
  private resolveFlush?: () => void
  private pendingDurableChunks: Float32Array[] = []
  private pendingDurableFrames = 0
  private persistedChunks = 0
  private persistedFrames = 0
  private durableQueuedFrames = 0
  private durableSequence = 0
  private durableWrite: Promise<void> = Promise.resolve()
  private durableFailure?: string
  private persistRecordingChunk?: (chunk: RecordingPcmChunk) => Promise<void>
  private midiVoices = new Map<number, { oscillator: OscillatorNode; gain: GainNode }>()

  async initFromUserGesture(): Promise<AudioCapabilities> {
    if (!this.context) {
      this.context = new AudioContext({ latencyHint: 'interactive' })
      this.master = this.context.createGain()
      this.master.gain.value = 0.92
      this.master.connect(this.context.destination)
    }
    if (this.context.state !== 'running') await this.context.resume()
    if (this.context.audioWorklet && !this.workletLoaded) {
      await this.context.audioWorklet.addModule(`${import.meta.env.BASE_URL}worklets/pcm-recorder.worklet.js`)
      this.workletLoaded = true
    }
    return {
      sampleRate: this.context.sampleRate,
      audioWorklet: Boolean(this.context.audioWorklet),
      outputLatencyMs: this.context.outputLatency ? Math.round(this.context.outputLatency * 1000) : undefined,
    }
  }

  get sampleRate(): number {
    return this.context?.sampleRate ?? 48000
  }

  get isPlaying(): boolean {
    return this.playing
  }

  get isRecording(): boolean {
    return Boolean(this.recordingTrackId)
  }

  showVstEditor(insertId: string): boolean {
    const insert = this.nativeInserts.find((item) => item.id === insertId)
    insert?.showEditor()
    return Boolean(insert)
  }

  private sendLiveVstNote(trackId: string | undefined, note: number, velocity: number): boolean {
    if (!this.context || !trackId) return false
    const instrument = this.liveGraphs.get(trackId)?.instrument
    if (!instrument) return false
    const frame = Math.ceil(this.context.currentTime * this.context.sampleRate)
    instrument.port.postMessage({ type: 'events', events: [{ frame, note, velocity, channel: 0 }] })
    return true
  }

  playMidiNote(note: number, velocity = 96, trackId?: string): void {
    if (trackId && this.sendLiveVstNote(trackId, note, velocity)) {
      const notes = this.liveVstNotes.get(trackId) ?? new Set<number>()
      notes.add(note)
      this.liveVstNotes.set(trackId, notes)
      return
    }
    if (!this.context || !this.master || this.midiVoices.has(note)) return
    const oscillator = this.context.createOscillator()
    const gain = this.context.createGain()
    oscillator.type = 'sawtooth'
    oscillator.frequency.value = 440 * Math.pow(2, (note - 69) / 12)
    const level = Math.max(0.01, Math.min(1, velocity / 127)) * 0.12
    gain.gain.setValueAtTime(0.0001, this.context.currentTime)
    gain.gain.exponentialRampToValueAtTime(level, this.context.currentTime + 0.012)
    oscillator.connect(gain)
    gain.connect(this.master)
    oscillator.start()
    this.midiVoices.set(note, { oscillator, gain })
  }

  stopMidiNote(note: number, trackId?: string): void {
    for (const [id, notes] of this.liveVstNotes) {
      if ((id === trackId || notes.has(note)) && notes.delete(note)) this.sendLiveVstNote(id, note, 0)
    }
    const voice = this.midiVoices.get(note)
    if (!voice || !this.context) return
    voice.gain.gain.cancelScheduledValues(this.context.currentTime)
    voice.gain.gain.setTargetAtTime(0.0001, this.context.currentTime, 0.025)
    voice.oscillator.stop(this.context.currentTime + 0.12)
    this.midiVoices.delete(note)
  }

  stopMidiNotes(): void {
    for (const [trackId, notes] of this.liveVstNotes) {
      for (const note of notes) this.sendLiveVstNote(trackId, note, 0)
    }
    this.liveVstNotes.clear()
    ;[...this.midiVoices.keys()].forEach((note) => this.stopMidiNote(note))
  }

  async decodeAsset(id: string, blob: Blob): Promise<AudioBuffer> {
    if (!this.context) throw new Error('Ative o áudio antes de importar uma faixa.')
    const buffer = await this.context.decodeAudioData(await blob.arrayBuffer())
    this.assetBuffers.set(id, buffer)
    return buffer
  }

  getCachedAsset(id: string): AudioBuffer | undefined {
    return this.assetBuffers.get(id)
  }

  previewAsset(id: string, onEnded?: () => void): boolean {
    if (!this.context || !this.master) return false
    const buffer = this.assetBuffers.get(id)
    if (!buffer) return false
    this.stopPreview()
    const source = this.context.createBufferSource()
    source.buffer = buffer
    source.connect(this.master)
    source.onended = () => {
      if (this.previewSource === source) this.previewSource = undefined
      onEnded?.()
    }
    this.previewSource = source
    source.start()
    return true
  }

  private stopPreview(): void {
    if (!this.previewSource) return
    try {
      this.previewSource.stop()
    } catch {
      // A one-shot source may already have ended.
    }
    this.previewSource = undefined
  }

  cacheAsset(id: string, buffer: AudioBuffer): void {
    this.assetBuffers.set(id, buffer)
  }

  createBufferFromPcm(pcm: Float32Array, sampleRate: number, channels = 1): AudioBuffer {
    if (!this.context) throw new Error('Ative o áudio antes de recuperar o take.')
    const frames = Math.max(1, Math.floor(pcm.length / channels))
    const buffer = this.context.createBuffer(channels, frames, sampleRate)
    for (let channel = 0; channel < channels; channel += 1) {
      const output = buffer.getChannelData(channel)
      for (let frame = 0; frame < frames; frame += 1) output[frame] = pcm[frame * channels + channel] ?? 0
    }
    return buffer
  }

  getCurrentFrame(projectRate: number): number {
    if (this.asioCapture) {
      return this.recordingStartFrame + Math.round(this.asioCapture.frames * projectRate / this.asioCapture.rate)
    }
    if (!this.playing || !this.context) return this.playheadStartFrame
    return Math.max(this.playheadStartFrame, this.playheadStartFrame + Math.round((this.context.currentTime - this.playStartedAt) * projectRate))
  }

  seek(frame: number): boolean {
    if (this.playing || this.isRecording || !Number.isFinite(frame)) return false
    this.stopPreview()
    this.playheadStartFrame = Math.max(0, Math.round(frame))
    return true
  }

  startMetronome(bpm: number, beatsPerBar: number): void {
    if (!this.context || this.metronomeTimer) return
    this.metronomeNextBeat = this.context.currentTime + 0.04
    this.metronomeBeat = 0
    const schedule = () => {
      const context = this.context
      if (!context) return
      while (this.metronomeNextBeat < context.currentTime + 0.12) {
        const accent = this.metronomeBeat % beatsPerBar === 0
        const oscillator = context.createOscillator()
        const gain = context.createGain()
        oscillator.type = 'sine'
        oscillator.frequency.setValueAtTime(accent ? 1760 : 1080, this.metronomeNextBeat)
        gain.gain.setValueAtTime(0.0001, this.metronomeNextBeat)
        gain.gain.exponentialRampToValueAtTime(accent ? 0.18 : 0.11, this.metronomeNextBeat + 0.003)
        gain.gain.exponentialRampToValueAtTime(0.0001, this.metronomeNextBeat + 0.045)
        oscillator.connect(gain).connect(context.destination)
        oscillator.start(this.metronomeNextBeat)
        oscillator.stop(this.metronomeNextBeat + 0.05)
        this.metronomeNextBeat += 60 / bpm
        this.metronomeBeat += 1
      }
    }
    schedule()
    this.metronomeTimer = window.setInterval(schedule, 25)
  }

  stopMetronome(): void {
    if (this.metronomeTimer) window.clearInterval(this.metronomeTimer)
    this.metronomeTimer = undefined
  }

  private makeSendBuses(context: BaseAudioContext, destination: AudioNode): SendBuses {
    const reverb = context.createConvolver()
    reverb.buffer = createImpulse(context)
    reverb.connect(destination)

    const delay = context.createDelay(1)
    delay.delayTime.value = 0.28
    const feedback = context.createGain()
    feedback.gain.value = 0.24
    delay.connect(feedback).connect(delay)
    delay.connect(destination)
    return { reverb, delay }
  }

  private makeTrackGraph(context: AudioContext | OfflineAudioContext, track: Track, destination: AudioNode, soloActive: boolean, buses: SendBuses): TrackGraph {
    const highPass = context.createBiquadFilter()
    highPass.type = 'highpass'
    highPass.frequency.value = track.effects.highPassEnabled ? track.effects.highPassHz : 10
    highPass.Q.value = 0.7

    const compressor = context.createDynamicsCompressor()
    compressor.threshold.value = track.effects.compressorEnabled ? track.effects.threshold : 0
    compressor.ratio.value = track.effects.compressorEnabled ? track.effects.ratio : 1
    compressor.attack.value = 0.006
    compressor.release.value = 0.16

    const dry = context.createGain()
    const reverb = context.createConvolver()
    reverb.buffer = createImpulse(context)
    const reverbGain = context.createGain()
    reverbGain.gain.value = track.effects.reverbEnabled ? track.effects.reverbMix : 0

    const delay = context.createDelay(2)
    delay.delayTime.value = track.effects.delayTime
    const delayFeedback = context.createGain()
    delayFeedback.gain.value = 0.24
    const delayGain = context.createGain()
    delayGain.gain.value = track.effects.delayEnabled ? track.effects.delayMix : 0

    const panner = context.createStereoPanner()
    panner.pan.value = track.pan
    const fader = context.createGain()
    const shouldMute = track.mute || (soloActive && !track.solo)
    fader.gain.value = shouldMute ? 0 : dbToGain(track.gainDb)

    highPass.connect(compressor)
    compressor.connect(dry).connect(panner)
    compressor.connect(reverb).connect(reverbGain).connect(panner)
    compressor.connect(delay).connect(delayGain).connect(panner)
    delay.connect(delayFeedback).connect(delay)
    const analyser = context.createAnalyser()
    analyser.fftSize = 512
    panner.connect(fader).connect(analyser).connect(destination)
    const sends = { reverb: context.createGain(), delay: context.createGain() }
    for (const bus of ['reverb', 'delay'] as const) {
      sends[bus].gain.value = sendLevel(track.sends?.[bus])
      fader.connect(sends[bus]).connect(buses[bus])
    }

    return { highPass, compressor, reverbGain, delayGain, delay, fader, panner, analyser, sends }
  }

  private scheduleMidi(context: BaseAudioContext, track: Track, input: AudioNode, bpm: number, from: number, at: number): void {
    if (track.kind !== 'midi') return
    const beatSeconds = 60 / bpm
    for (const note of track.midiNotes ?? []) {
      const start = note.startBeat * beatSeconds
      const end = start + note.durationBeats * beatSeconds
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= Math.max(start, from)) continue
      if (!Number.isInteger(note.note) || note.note < 0 || note.note > 127 || !Number.isFinite(note.velocity)) continue
      const on = at + Math.max(0, start - from)
      const off = at + end - from
      const oscillator = context.createOscillator()
      const gain = context.createGain()
      oscillator.type = 'sawtooth'
      oscillator.frequency.value = 440 * 2 ** ((note.note - 69) / 12)
      gain.gain.setValueAtTime(0, on)
      const level = Math.max(0, Math.min(127, note.velocity)) / 127 * 0.12
      gain.gain.linearRampToValueAtTime(level, Math.min(on + 0.012, off))
      gain.gain.setValueAtTime(level, off)
      gain.gain.linearRampToValueAtTime(0, off + 0.06)
      oscillator.connect(gain).connect(input)
      oscillator.start(on)
      oscillator.stop(off + 0.06)
      if (context === this.context) {
        this.scheduledNotes.add(oscillator)
        oscillator.onended = () => {
          oscillator.disconnect()
          gain.disconnect()
          this.scheduledNotes.delete(oscillator)
        }
      }
    }
  }

  private applyClipEnvelope(gain: GainNode, clip: Clip, sourceAt: number, elapsedFrames: number, playableFrames: number, projectRate: number): void {
    const baseLevel = dbToGain(clip.gainDb)
    const endFrame = elapsedFrames + playableFrames
    const fadeIn = Math.max(0, clip.fadeInFrames)
    const fadeOut = Math.max(0, clip.fadeOutFrames)
    const levelAt = (frame: number) => baseLevel * Math.max(0, Math.min(
      1, fadeIn ? frame / fadeIn : 1, fadeOut ? (clip.durationFrames - frame) / fadeOut : 1,
    ))
    gain.gain.setValueAtTime(levelAt(elapsedFrames), sourceAt)
    if (fadeIn || fadeOut) {
      const boundaries = fadeIn + fadeOut > clip.durationFrames
        ? [clip.durationFrames * fadeIn / (fadeIn + fadeOut)]
        : [fadeIn, clip.durationFrames - fadeOut]
      for (const frame of [...new Set([...boundaries, endFrame])]) {
        if (frame > elapsedFrames && frame <= endFrame) {
          gain.gain.linearRampToValueAtTime(levelAt(frame), sourceAt + (frame - elapsedFrames) / projectRate)
        }
      }
    }
  }

  private createSource(buffer: AudioBuffer, graph: TrackGraph, projectRate: number, clip: Clip, startFrame: number, startAt: number): void {
    const clipEnd = clip.timelineStartFrame + clip.durationFrames
    if (clipEnd <= startFrame) return
    const elapsedFrames = Math.max(0, startFrame - clip.timelineStartFrame)
    const offsetSeconds = (clip.sourceOffsetFrame + elapsedFrames) / projectRate
    const playableFrames = Math.min(clip.durationFrames - elapsedFrames, Math.round((buffer.duration - offsetSeconds) * projectRate))
    if (playableFrames <= 0) return

    const source = this.context!.createBufferSource()
    const clipGain = this.context!.createGain()
    source.buffer = buffer
    source.connect(clipGain).connect(graph.input ?? graph.highPass)
    const delay = Math.max(0, clip.timelineStartFrame - startFrame) / projectRate
    const playableSeconds = playableFrames / projectRate
    const sourceAt = startAt + delay
    this.applyClipEnvelope(clipGain, clip, sourceAt, elapsedFrames, playableFrames, projectRate)
    source.start(sourceAt, offsetSeconds, playableSeconds)
    source.onended = () => this.sources.delete(source)
    this.sources.add(source)
  }

  private shouldPlayClip(project: AudioProject, clip: Clip): boolean {
    if (!clip.takeId) return true
    const take = project.takes.find((candidate) => candidate.id === clip.takeId)
    return !take || take.selected
  }

  private async prepareVstRack(context: AudioContext, project: AudioProject, track: Track, graph: TrackGraph, onError: (message: string) => void): Promise<number> {
    const inserts = (track.vst3Inserts ?? []).filter((insert) => !insert.bypass)
    if (!inserts.length || !isDesktopRuntime()) return 0
    const generation = this.playGeneration
    this.vstWorklet ??= context.audioWorklet.addModule(`${import.meta.env.BASE_URL}worklets/vst-stream.worklet.js`).catch((error) => {
      this.vstWorklet = undefined
      throw error
    })
    await this.vstWorklet
    if (generation !== this.playGeneration) throw new Error('Reprodução cancelada.')
    const frames = project.vstBufferFrames ?? DEFAULT_VST_BUFFER_FRAMES
    let tail: AudioNode | undefined
    for (const insert of inserts) {
      const instrument = insert.kind === 'instrument'
      if (instrument && (track.kind !== 'midi' || graph.instrument || tail)) {
        throw new Error(`${insert.name}: coloque um único instrumento no primeiro slot da pista MIDI.`)
      }
      const stream = await openVstStream(insert, frames, context.sampleRate, project.bpm)
      let timer: number | undefined
      try {
        await Promise.race([
          stream.process(new Float32Array(frames * 2), []),
          new Promise<never>((_, reject) => { timer = window.setTimeout(() => reject(new Error('Tempo de inicialização excedido.')), 8000) }),
        ])
        if (generation !== this.playGeneration) throw new Error('Reprodução cancelada.')
      } catch (error) {
        stream.close()
        throw new Error(`${insert.name}: ${error instanceof Error ? error.message : String(error)}`)
      } finally {
        window.clearTimeout(timer)
      }
      const node = new AudioWorkletNode(context, 'vale-vst-stream', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: 2,
        channelCountMode: 'explicit',
        outputChannelCount: [2],
        processorOptions: { frames, instrument },
      })
      let closed = false
      let showEditor = false
      let queue = Promise.resolve()
      const close = () => {
        if (closed) return
        closed = true
        stream.close()
      }
      node.port.onmessage = ({ data }) => {
        if (data.type === 'late' && !closed) {
          onError(`${insert.name}: o processamento está atrasado. Experimente aumentar o buffer VST3.`)
          return
        }
        if (data.type !== 'block' || closed) return
        queue = queue.then(async () => {
          if (closed) return
          let deadline: number | undefined
          const requestedEditor = showEditor
          showEditor = false
          try {
            const pcm = await Promise.race([
              stream.process(data.pcm, data.events, requestedEditor),
              new Promise<never>((_, reject) => { deadline = window.setTimeout(() => reject(new Error('O plug-in deixou de responder.')), 2000) }),
            ])
            if (!closed) node.port.postMessage({ type: 'result', sequence: data.sequence, pcm }, [pcm.buffer])
          } catch (error) {
            if (closed) return
            close()
            node.port.postMessage({ type: 'failed' })
            onError(`${insert.name}: ${error instanceof Error ? error.message : String(error)}`)
          } finally {
            window.clearTimeout(deadline)
          }
        })
      }
      this.nativeInserts.push({ id: insert.id, node, close, showEditor: () => { showEditor = true } })
      if (instrument) graph.instrument = node
      if (tail) tail.connect(node)
      else graph.input = node
      tail = node
    }
    tail?.connect(graph.highPass)
    return inserts.length * 3 * frames / context.sampleRate
  }

  private vstEvents(track: Track, bpm: number, from: number, at: number, sampleRate: number): VstNote[] {
    const events: VstNote[] = []
    const toFrame = (seconds: number) => Math.round((at + seconds - from) * sampleRate)
    for (const note of track.midiNotes ?? []) {
      const start = note.startBeat * 60 / bpm
      const end = (note.startBeat + note.durationBeats) * 60 / bpm
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= Math.max(start, from)) continue
      if (!Number.isInteger(note.note) || note.note < 0 || note.note > 127 || !Number.isFinite(note.velocity)) continue
      const on = toFrame(Math.max(from, start))
      events.push({ frame: on, note: note.note, velocity: Math.max(1, Math.min(127, Math.round(note.velocity))), channel: 0 })
      events.push({ frame: Math.max(on + 1, toFrame(end)), note: note.note, velocity: 0, channel: 0 })
    }
    return events.sort((a, b) => a.frame - b.frame)
  }

  async play(project: AudioProject, onVstError: (message: string) => void): Promise<boolean> {
    if (!this.context || !this.master || this.playing) return false
    const context = this.context
    this.stopPreview()
    this.stopSources()
    const soloActive = project.tracks.some((track) => track.solo)
    const generation = this.playGeneration
    const startFrame = this.playheadStartFrame
    this.liveGraphs.clear()
    const output = this.context.createGain()
    output.connect(this.master)
    this.liveMixOutput = output
    this.master.gain.value = masterLevel(project)
    const buses = this.makeSendBuses(context, output)
    const latencies = new Map<string, number>()
    const pendingOutputs = new Map<string, SendBuses & { main: AudioNode }>()
    for (const track of project.tracks) {
      const trackOutput = context.createGain()
      const trackBuses = { reverb: context.createGain(), delay: context.createGain() }
      const graph = this.makeTrackGraph(context, track, trackOutput, soloActive, trackBuses)
      this.liveGraphs.set(track.id, graph)
      try {
        latencies.set(track.id, await this.prepareVstRack(context, project, track, graph, onVstError))
      } catch (error) {
        if (generation !== this.playGeneration) return false
        this.stopSources()
        throw error
      }
      if (generation !== this.playGeneration) return false
      pendingOutputs.set(track.id, { main: trackOutput, ...trackBuses })
    }
    const maxLatency = Math.max(0, ...latencies.values())
    for (const [id, taps] of pendingOutputs) {
      const compensation = Math.max(0, maxLatency - (latencies.get(id) ?? 0))
      for (const [source, destination] of [[taps.main, output], [taps.reverb, buses.reverb], [taps.delay, buses.delay]]) {
        if (compensation === 0) source.connect(destination)
        else {
          const delay = context.createDelay(Math.max(1, compensation))
          delay.delayTime.value = compensation
          source.connect(delay).connect(destination)
        }
      }
    }
    const startAt = context.currentTime + 0.04
    const from = startFrame / project.audioSampleRate
    for (const track of project.tracks) {
      const graph = this.liveGraphs.get(track.id)!
      if (graph.instrument) graph.instrument.port.postMessage({
        type: 'events',
        events: this.vstEvents(track, project.bpm, from, startAt, context.sampleRate),
      })
      else this.scheduleMidi(context, track, graph.input ?? graph.highPass, project.bpm, from, startAt)
    }

    for (const clip of project.clips) {
      if (!this.shouldPlayClip(project, clip)) continue
      const buffer = this.assetBuffers.get(clip.assetId)
      const graph = this.liveGraphs.get(clip.trackId)
      if (buffer && graph) this.createSource(buffer, graph, project.audioSampleRate, clip, startFrame, startAt)
    }
    this.playStartedAt = startAt
    this.playing = true
    return true
  }

  pause(projectRate: number): void {
    if (!this.playing) return
    this.playheadStartFrame = this.getCurrentFrame(projectRate)
    this.stopSources()
    this.playing = false
  }

  stop(): void {
    this.stopSources()
    this.stopPreview()
    this.playing = false
    this.playheadStartFrame = 0
  }

  private stopSources(): void {
    this.playGeneration += 1
    this.liveVstNotes.clear()
    for (const insert of this.nativeInserts.splice(0)) {
      insert.close()
      insert.node.port.close()
      insert.node.disconnect()
    }
    this.sources.forEach((source) => {
      try {
        source.stop()
      } catch {
        // Sources may have ended between the user action and this command.
      }
    })
    this.sources.clear()
    for (const note of this.scheduledNotes) note.stop()
    this.scheduledNotes.clear()
    safeDisconnect(this.liveMixOutput)
    this.liveMixOutput = undefined
    this.liveGraphs.clear()
  }

  updateMix(project: AudioProject): void {
    const at = this.context?.currentTime ?? 0
    this.master?.gain.setTargetAtTime(masterLevel(project), at, 0.015)
    const soloActive = project.tracks.some((track) => track.solo)
    project.tracks.forEach((track) => {
      const graph = this.liveGraphs.get(track.id)
      if (!graph) return
      for (const bus of ['reverb', 'delay'] as const) {
        graph.sends[bus].gain.setTargetAtTime(sendLevel(track.sends?.[bus]), at, 0.015)
      }
      graph.highPass.frequency.setTargetAtTime(track.effects.highPassEnabled ? track.effects.highPassHz : 10, at, 0.015)
      graph.compressor.threshold.setTargetAtTime(track.effects.compressorEnabled ? track.effects.threshold : 0, at, 0.015)
      graph.compressor.ratio.setTargetAtTime(track.effects.compressorEnabled ? track.effects.ratio : 1, at, 0.015)
      graph.reverbGain.gain.setTargetAtTime(track.effects.reverbEnabled ? track.effects.reverbMix : 0, at, 0.015)
      graph.delayGain.gain.setTargetAtTime(track.effects.delayEnabled ? track.effects.delayMix : 0, at, 0.015)
      graph.delay.delayTime.setTargetAtTime(track.effects.delayTime, at, 0.015)
      graph.panner.pan.setTargetAtTime(track.pan, at, 0.015)
      graph.fader.gain.setTargetAtTime(track.mute || (soloActive && !track.solo) ? 0 : dbToGain(track.gainDb), at, 0.015)
    })
  }

  private async requestInput(channels: 1 | 2): Promise<MediaStream> {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Este navegador não oferece acesso ao microfone.')
    const channelCount = channels === 2 ? { exact: 2 } : 1
    const constraints: MediaTrackConstraints = { channelCount, echoCancellation: false, noiseSuppression: false, autoGainControl: false }
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: constraints })
    } catch (error) {
      if (channels === 2 && error instanceof DOMException && error.name === 'OverconstrainedError') {
        throw new Error('A entrada de áudio selecionada não oferece captura estéreo.')
      }
      throw error
    }
    if (channels === 2 && stream.getAudioTracks()[0]?.getSettings().channelCount !== 2) {
      stream.getTracks().forEach((track) => track.stop())
      throw new Error('O sistema não confirmou dois canais de entrada para a captura estéreo.')
    }
    return stream
  }

  private queueDurableChunk(): void {
    if (!this.persistRecordingChunk || this.pendingDurableFrames === 0) return
    const chunks = this.pendingDurableChunks
    const frames = this.pendingDurableFrames
    this.pendingDurableChunks = []
    this.pendingDurableFrames = 0
    const pcm = new Float32Array(frames * this.recordingChannels)
    let offset = 0
    chunks.forEach((chunk) => { pcm.set(chunk, offset); offset += chunk.length })
    const chunk: RecordingPcmChunk = {
      sequence: this.durableSequence,
      firstFrame: this.durableQueuedFrames,
      frameCount: frames,
      channels: this.recordingChannels,
      pcm: pcm.buffer,
      writtenAt: new Date().toISOString(),
    }
    this.durableSequence += 1
    this.durableQueuedFrames += frames
    this.durableWrite = this.durableWrite.then(async () => {
      try {
        await this.persistRecordingChunk?.(chunk)
        this.persistedChunks += 1
        this.persistedFrames += frames
      } catch (error) {
        this.durableFailure ??= error instanceof Error ? error.message : 'Não foi possível gravar um trecho PCM no armazenamento local.'
      }
    })
  }

  async startRecording(trackId: string, project: AudioProject, mode: MonitorMode, channels: 1 | 2, onPcmChunk?: (chunk: RecordingPcmChunk) => Promise<void>): Promise<RecordingStart> {
    if (!this.context || !this.context.audioWorklet) throw new Error('AudioWorklet não está disponível. A gravação multipista não pode ser iniciada com segurança neste navegador.')
    if (this.recordingTrackId) throw new Error('Já existe uma gravação em andamento.')

    const stream = await this.requestInput(channels)
    const [inputTrack] = stream.getAudioTracks()
    this.recordingSettings = inputTrack?.getSettings()
    this.stream = stream
    this.inputSource = this.context.createMediaStreamSource(stream)
    this.recorder = new AudioWorkletNode(this.context, 'vale-pcm-recorder', {
      numberOfInputs: 1, numberOfOutputs: 1, channelCount: channels,
      channelCountMode: 'explicit', channelInterpretation: channels === 2 ? 'discrete' : 'speakers',
    })
    const silent = this.context.createGain()
    silent.gain.value = 0
    this.inputSource.connect(this.recorder)
    this.recorder.connect(silent).connect(this.context.destination)
    this.monitorGain = this.context.createGain()
    this.monitorGain.gain.value = mode === 'software' ? 0.38 : 0
    const graph = this.liveGraphs.get(trackId)
    this.inputSource.connect(this.monitorGain).connect(graph?.input ?? graph?.highPass ?? this.context.destination)

    this.prepareRecording(trackId, project.audioSampleRate, channels, onPcmChunk)
    this.recorder.port.onmessage = ({ data }: MessageEvent<{ type: string; channels?: ArrayBuffer[] }>) => {
      if (data.type === 'pcm' && data.channels?.length === channels) {
        const left = new Float32Array(data.channels[0])
        if (channels === 1) this.acceptRecordingPcm(left)
        else {
          const right = new Float32Array(data.channels[1])
          const interleaved = new Float32Array(left.length * 2)
          for (let frame = 0; frame < left.length; frame += 1) {
            interleaved[2 * frame] = left[frame]
            interleaved[2 * frame + 1] = right[frame]
          }
          this.acceptRecordingPcm(interleaved)
        }
      }
      if (data.type === 'flushed') this.resolveFlush?.()
    }
    return { inputSettings: this.recordingSettings, startFrame: this.recordingStartFrame }
  }

  private prepareRecording(trackId: string, projectRate: number, channels: 1 | 2, onPcmChunk?: (chunk: RecordingPcmChunk) => Promise<void>): void {
    this.recordingChunks = []
    this.recordingChannels = channels
    this.pendingDurableChunks = []
    this.pendingDurableFrames = 0
    this.persistedChunks = 0
    this.persistedFrames = 0
    this.durableQueuedFrames = 0
    this.durableSequence = 0
    this.durableWrite = Promise.resolve()
    this.durableFailure = undefined
    this.persistRecordingChunk = onPcmChunk
    this.recordingTrackId = trackId
    this.recordingStartFrame = this.getCurrentFrame(projectRate)
  }

  private acceptRecordingPcm(pcm: Float32Array): void {
    if (!pcm.length) return
    const frames = pcm.length / this.recordingChannels
    if (!Number.isInteger(frames)) throw new Error('A captura recebeu um frame PCM incompleto.')
    this.recordingChunks.push(pcm)
    if (this.persistRecordingChunk) {
      this.pendingDurableChunks.push(pcm)
      this.pendingDurableFrames += frames
      if (this.pendingDurableFrames >= 8192) this.queueDurableChunk()
    }
    if (this.asioCapture) this.asioCapture.frames += frames
    let peak = 0
    let energy = 0
    for (const sample of pcm) {
      peak = Math.max(peak, Math.abs(sample))
      energy += sample * sample
    }
    this.inputMeter = { peak, rms: Math.sqrt(energy / pcm.length) }
  }

  async startAsioRecording(trackId: string, projectRate: number, settings: AsioSettings, dryReturn: boolean, channels: 1 | 2,
    onPcmChunk: (chunk: RecordingPcmChunk) => Promise<void>, onFailure: (reason: string) => void): Promise<RecordingStart> {
    if (!this.context || this.playing || this.recordingTrackId) throw new Error('Pare o transporte antes de gravar pelo ASIO.')
    const info = await startAsioMonitor({ ...settings, capture: true, dryReturn, channels })
    if (info.sampleRate !== settings.sampleRate || info.channels !== channels) {
      await finishAsioCapture()
      throw new Error('O driver abriu com uma taxa ou quantidade de canais diferente da solicitada.')
    }
    this.recordingSettings = undefined
    this.prepareRecording(trackId, projectRate, channels, onPcmChunk)
    const capture: NonNullable<AudioEngine['asioCapture']> = { rate: info.sampleRate, frames: 0, stopping: false }
    this.asioCapture = capture
    const poll = () => {
      if (capture.stopping) return
      capture.pending = readAsioCapture().then((packet) => {
        this.acceptRecordingPcm(Float32Array.from(packet.samples))
        if (packet.error || packet.ended) throw new Error(packet.error ?? 'O driver ASIO interrompeu a captura.')
      }).catch((error) => {
        capture.error = String(error)
        if (!capture.stopping) onFailure(capture.error)
      }).finally(() => {
        if (!capture.stopping && !capture.error) capture.timer = window.setTimeout(poll, 80)
      })
    }
    capture.timer = window.setTimeout(poll, 80)
    return { startFrame: this.recordingStartFrame }
  }

  setMonitorMode(mode: MonitorMode): void {
    if (!this.monitorGain || !this.context) return
    this.monitorGain.gain.setTargetAtTime(mode === 'software' ? 0.38 : 0, this.context.currentTime, 0.015)
  }

  getInputMeter(): { peak: number; rms: number } | undefined {
    return this.inputMeter
  }

  getTrackMeter(trackId: string): { peak: number; rms: number } | undefined {
    const analyser = this.liveGraphs.get(trackId)?.analyser
    if (!analyser) return undefined
    const data = new Float32Array(analyser.fftSize)
    analyser.getFloatTimeDomainData(data)
    let peak = 0
    let sum = 0
    data.forEach((sample) => {
      peak = Math.max(peak, Math.abs(sample))
      sum += sample * sample
    })
    return { peak, rms: Math.sqrt(sum / data.length) }
  }

  async stopRecording(): Promise<CapturedRecording | undefined> {
    if (!this.context || !this.recordingTrackId) return undefined
    const capture = this.asioCapture
    if (!capture && !this.recorder) return undefined
    if (capture) {
      capture.stopping = true
      window.clearTimeout(capture.timer)
      await capture.pending
      try {
        const tail = await finishAsioCapture()
        this.acceptRecordingPcm(Float32Array.from(tail.samples))
        capture.error ??= tail.error ?? undefined
      } catch (error) {
        capture.error ??= String(error)
      }
    } else {
      await new Promise<void>((resolve) => {
        this.resolveFlush = resolve
        this.recorder!.port.postMessage({ type: 'stop' })
      })
    }
    this.queueDurableChunk()
    await this.durableWrite
    try {
      if (capture?.error) throw new Error(capture.error)
      const channels = this.recordingChannels
      const frames = this.recordingChunks.reduce((total, chunk) => total + chunk.length / channels, 0)
      const sampleRate = capture?.rate ?? this.context.sampleRate
      const buffer = this.context.createBuffer(channels, Math.max(1, frames), sampleRate)
      for (let channel = 0; channel < channels; channel += 1) {
        const output = buffer.getChannelData(channel)
        let offset = 0
        for (const chunk of this.recordingChunks) {
          for (let sample = channel; sample < chunk.length; sample += channels) {
            output[offset++] = chunk[sample]
          }
        }
      }
      return {
        blob: encodeWav(buffer, 32),
        buffer,
        peaks: buildPeaks(buffer),
        frames,
        channels,
        sampleRate,
        inputSettings: this.recordingSettings,
        durability: { persistedChunks: this.persistedChunks, persistedFrames: this.persistedFrames, error: this.durableFailure },
      }
    } finally {
      this.clearRecording()
    }
  }

  private clearRecording(): void {
    safeDisconnect(this.inputSource)
    safeDisconnect(this.recorder)
    safeDisconnect(this.monitorGain)
    this.stream?.getTracks().forEach((track) => track.stop())
    this.stream = undefined
    this.inputSource = undefined
    this.inputMeter = undefined
    this.recorder = undefined
    this.monitorGain = undefined
    this.recordingTrackId = undefined
    this.asioCapture = undefined
    this.recordingChunks = []
    this.resolveFlush = undefined
    this.pendingDurableChunks = []
    this.pendingDurableFrames = 0
    this.persistRecordingChunk = undefined
  }

  getRecordingStartFrame(): number {
    return this.recordingStartFrame
  }

  private renderLength(project: AudioProject): number {
    const lastFrame = project.clips.reduce((maximum, clip) => Math.max(maximum, clip.timelineStartFrame + clip.durationFrames), 0)
    let lastMidiFrame = 0
    for (const track of project.tracks) {
      if (track.kind !== 'midi') continue
      for (const note of track.midiNotes ?? []) {
        const end = (note.startBeat + note.durationBeats) * 60 / project.bpm * project.audioSampleRate
        if (Number.isFinite(end)) lastMidiFrame = Math.max(lastMidiFrame, Math.ceil(end))
      }
    }
    const tailFrames = Math.round(project.audioSampleRate * 1.5)
    return Math.max(project.audioSampleRate, Math.max(lastFrame, lastMidiFrame) + tailFrames)
  }

  private scheduleRenderClip(offline: OfflineAudioContext, project: AudioProject, clip: Clip, input: AudioNode): void {
    const sourceBuffer = this.assetBuffers.get(clip.assetId)
    if (!sourceBuffer) return
    const source = offline.createBufferSource()
    const clipGain = offline.createGain()
    source.buffer = sourceBuffer
    source.connect(clipGain).connect(input)
    const sourceAt = clip.timelineStartFrame / project.audioSampleRate
    this.applyClipEnvelope(clipGain, clip, sourceAt, 0, clip.durationFrames, project.audioSampleRate)
    source.start(sourceAt, clip.sourceOffsetFrame / project.audioSampleRate, clip.durationFrames / project.audioSampleRate)
  }

  private async scheduleRenderTrack(offline: OfflineAudioContext, project: AudioProject, track: Track, graph: TrackGraph): Promise<void> {
    const clips = project.clips.filter((clip) => clip.trackId === track.id && this.shouldPlayClip(project, clip))
    const inserts = (track.vst3Inserts ?? []).filter((insert) => !insert.bypass)
    if (!inserts.length) {
      for (const clip of clips) this.scheduleRenderClip(offline, project, clip, graph.highPass)
      this.scheduleMidi(offline, track, graph.highPass, project.bpm, 0, 0)
      return
    }
    if (!isDesktopRuntime()) throw new Error('Abra o projeto no Vale Studio Desktop para exportar os inserts VST3 ativos.')
    const instrument = inserts[0].kind === 'instrument'
    if ((instrument && track.kind !== 'midi') || inserts.slice(1).some((insert) => insert.kind === 'instrument')) {
      throw new Error('Coloque um único instrumento no primeiro slot da pista MIDI.')
    }
    const dry = new OfflineAudioContext(2, offline.length, offline.sampleRate)
    for (const clip of clips) this.scheduleRenderClip(dry, project, clip, dry.destination)
    if (!instrument) this.scheduleMidi(dry, track, dry.destination, project.bpm, 0, 0)
    const buffer = await dry.startRendering()
    const left = buffer.getChannelData(0)
    const right = buffer.getChannelData(1)
    const frames = project.vstBufferFrames ?? DEFAULT_VST_BUFFER_FRAMES
    for (const insert of inserts) {
      const notes = insert.kind === 'instrument' ? this.vstEvents(track, project.bpm, 0, 0, offline.sampleRate) : []
      const stream = await openVstStream(insert, frames, offline.sampleRate, project.bpm)
      const pcm = new Float32Array(frames * 2)
      let noteIndex = 0
      try {
        for (let offset = 0; offset < buffer.length; offset += frames) {
          pcm.fill(0)
          const length = Math.min(frames, buffer.length - offset)
          for (let i = 0; i < length; i += 1) {
            pcm[2 * i] = left[offset + i]
            pcm[2 * i + 1] = right[offset + i]
          }
          const events: number[][] = []
          while (noteIndex < notes.length && notes[noteIndex].frame < offset + frames) {
            const note = notes[noteIndex++]
            events.push([note.frame - offset, note.note, note.velocity, note.channel])
          }
          let deadline: number | undefined
          try {
            const rendered = await Promise.race([
              stream.process(pcm, events),
              new Promise<never>((_, reject) => { deadline = window.setTimeout(() => reject(new Error(`${insert.name} excedeu o tempo de processamento.`)), 8000) }),
            ])
            for (let i = 0; i < length; i += 1) {
              left[offset + i] = rendered[2 * i]
              right[offset + i] = rendered[2 * i + 1]
            }
          } finally {
            window.clearTimeout(deadline)
          }
        }
      } finally {
        stream.close()
      }
    }
    const source = offline.createBufferSource()
    source.buffer = buffer
    source.connect(graph.highPass)
    source.start()
  }

  async renderMix(project: AudioProject): Promise<AudioBuffer> {
    if (!this.context) throw new Error('Ative o áudio antes de exportar.')
    const offline = new OfflineAudioContext(2, this.renderLength(project), project.audioSampleRate)
    const master = offline.createGain()
    master.gain.value = masterLevel(project)
    master.connect(offline.destination)
    const soloActive = project.tracks.some((track) => track.solo)
    const buses = this.makeSendBuses(offline, master)
    for (const track of project.tracks) {
      if (track.mute || (soloActive && !track.solo)) continue
      const graph = this.makeTrackGraph(offline, track, master, soloActive, buses)
      await this.scheduleRenderTrack(offline, project, track, graph)
    }
    return offline.startRendering()
  }

  async renderStem(project: AudioProject, trackId: string): Promise<AudioBuffer> {
    if (!this.context) throw new Error('Ative o áudio antes de exportar.')
    const track = project.tracks.find((item) => item.id === trackId)
    if (!track) throw new Error('A pista deste stem não existe mais.')
    const offline = new OfflineAudioContext(2, this.renderLength(project), project.audioSampleRate)
    const master = offline.createGain()
    master.gain.value = 0.92
    master.connect(offline.destination)
    const graph = this.makeTrackGraph(offline, { ...track, mute: false, solo: false }, master, false, this.makeSendBuses(offline, master))
    await this.scheduleRenderTrack(offline, project, track, graph)
    return offline.startRendering()
  }

  async exportMix(project: AudioProject, format: 'wav' | 'mp3'): Promise<Blob> {
    const buffer = await this.renderMix(project)
    return format === 'wav' ? encodeWav(buffer, 24) : encodeMp3(buffer, 192)
  }

  async exportStems(project: AudioProject): Promise<StemExport[]> {
    const tracksWithAudio = project.tracks.filter((track) => project.clips.some((clip) => clip.trackId === track.id && this.shouldPlayClip(project, clip)))
    const stems: StemExport[] = []
    for (const track of tracksWithAudio) {
      const buffer = await this.renderStem(project, track.id)
      stems.push({ trackId: track.id, trackName: track.name, blob: encodeWav(buffer, 24) })
    }
    return stems
  }
}
