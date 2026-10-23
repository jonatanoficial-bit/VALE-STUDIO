import type { AudioProject, Clip, MonitorMode, Track } from '../domain/model'
import { dbToGain } from '../domain/model'
import { buildPeaks } from './peaks'
import { encodeMp3, encodeWav } from './wav'

type TrackGraph = {
  highPass: BiquadFilterNode
  compressor: DynamicsCompressorNode
  reverbGain: GainNode
  delayGain: GainNode
  delay: DelayNode
  fader: GainNode
  panner: StereoPannerNode
  analyser: AnalyserNode
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
  private sources = new Set<AudioBufferSourceNode>()
  private playheadStartFrame = 0
  private playStartedAt = 0
  private playing = false
  private stream?: MediaStream
  private inputSource?: MediaStreamAudioSourceNode
  private inputAnalyser?: AnalyserNode
  private recorder?: AudioWorkletNode
  private monitorGain?: GainNode
  private recordingChunks: Float32Array[] = []
  private recordingTrackId?: string
  private recordingStartFrame = 0
  private recordingSettings?: MediaTrackSettings
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

  async decodeAsset(id: string, blob: Blob): Promise<AudioBuffer> {
    if (!this.context) throw new Error('Ative o áudio antes de importar uma faixa.')
    const buffer = await this.context.decodeAudioData(await blob.arrayBuffer())
    this.assetBuffers.set(id, buffer)
    return buffer
  }

  getCachedAsset(id: string): AudioBuffer | undefined {
    return this.assetBuffers.get(id)
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
    if (!this.playing || !this.context) return this.playheadStartFrame
    return Math.max(this.playheadStartFrame, this.playheadStartFrame + Math.round((this.context.currentTime - this.playStartedAt) * projectRate))
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

  private makeTrackGraph(context: AudioContext | OfflineAudioContext, track: Track, destination: AudioNode, soloActive: boolean): TrackGraph {
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

    return { highPass, compressor, reverbGain, delayGain, delay, fader, panner, analyser }
  }

  private applyClipEnvelope(gain: GainNode, clip: Clip, sourceAt: number, elapsedFrames: number, playableFrames: number, projectRate: number): void {
    const baseLevel = dbToGain(clip.gainDb)
    const sourceEnd = sourceAt + playableFrames / projectRate
    gain.gain.setValueAtTime(baseLevel, sourceAt)

    if (clip.fadeInFrames > 0 && elapsedFrames < clip.fadeInFrames) {
      const initialLevel = Math.max(0, Math.min(1, elapsedFrames / clip.fadeInFrames)) * baseLevel
      const fadeInEnd = sourceAt + Math.min(playableFrames, clip.fadeInFrames - elapsedFrames) / projectRate
      gain.gain.setValueAtTime(initialLevel, sourceAt)
      gain.gain.linearRampToValueAtTime(baseLevel, fadeInEnd)
    }

    const fadeOutStartFrame = Math.max(0, clip.durationFrames - clip.fadeOutFrames)
    const endFrame = elapsedFrames + playableFrames
    if (clip.fadeOutFrames > 0 && endFrame > fadeOutStartFrame) {
      const fadeOutAt = sourceAt + Math.max(0, fadeOutStartFrame - elapsedFrames) / projectRate
      const endingLevel = Math.max(0, Math.min(1, (clip.durationFrames - endFrame) / clip.fadeOutFrames)) * baseLevel
      gain.gain.setValueAtTime(baseLevel, fadeOutAt)
      gain.gain.linearRampToValueAtTime(endingLevel, sourceEnd)
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
    source.connect(clipGain).connect(graph.highPass)
    const delay = Math.max(0, clip.timelineStartFrame - startFrame) / projectRate
    const playableSeconds = playableFrames / projectRate
    const sourceAt = startAt + delay
    this.applyClipEnvelope(clipGain, clip, sourceAt, elapsedFrames, playableFrames, projectRate)
    source.start(sourceAt, offsetSeconds, playableSeconds)
    source.onended = () => this.sources.delete(source)
    this.sources.add(source)
  }

  play(project: AudioProject): void {
    if (!this.context || !this.master || this.playing) return
    this.stopSources()
    const soloActive = project.tracks.some((track) => track.solo)
    const startAt = this.context.currentTime + 0.03
    const startFrame = this.playheadStartFrame
    this.liveGraphs.clear()
    project.tracks.forEach((track) => this.liveGraphs.set(track.id, this.makeTrackGraph(this.context!, track, this.master!, soloActive)))

    for (const clip of project.clips) {
      const buffer = this.assetBuffers.get(clip.assetId)
      const graph = this.liveGraphs.get(clip.trackId)
      if (buffer && graph) this.createSource(buffer, graph, project.audioSampleRate, clip, startFrame, startAt)
    }
    this.playStartedAt = startAt
    this.playing = true
  }

  pause(projectRate: number): void {
    if (!this.playing) return
    this.playheadStartFrame = this.getCurrentFrame(projectRate)
    this.stopSources()
    this.playing = false
  }

  stop(): void {
    this.stopSources()
    this.playing = false
    this.playheadStartFrame = 0
  }

  private stopSources(): void {
    this.sources.forEach((source) => {
      try {
        source.stop()
      } catch {
        // Sources may have ended between the user action and this command.
      }
    })
    this.sources.clear()
    this.liveGraphs.clear()
  }

  updateMix(project: AudioProject): void {
    const soloActive = project.tracks.some((track) => track.solo)
    project.tracks.forEach((track) => {
      const graph = this.liveGraphs.get(track.id)
      if (!graph) return
      const at = this.context?.currentTime ?? 0
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

  private async requestInput(): Promise<MediaStream> {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Este navegador não oferece acesso ao microfone.')
    const constraints: MediaTrackConstraints = { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false }
    return navigator.mediaDevices.getUserMedia({ audio: constraints })
  }

  private queueDurableChunk(): void {
    if (!this.persistRecordingChunk || this.pendingDurableFrames === 0) return
    const chunks = this.pendingDurableChunks
    const frames = this.pendingDurableFrames
    this.pendingDurableChunks = []
    this.pendingDurableFrames = 0
    const pcm = new Float32Array(frames)
    let offset = 0
    chunks.forEach((chunk) => { pcm.set(chunk, offset); offset += chunk.length })
    const chunk: RecordingPcmChunk = {
      sequence: this.durableSequence,
      firstFrame: this.durableQueuedFrames,
      frameCount: frames,
      channels: 1,
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

  async startRecording(trackId: string, project: AudioProject, mode: MonitorMode, onPcmChunk?: (chunk: RecordingPcmChunk) => Promise<void>): Promise<RecordingStart> {
    if (!this.context || !this.context.audioWorklet) throw new Error('AudioWorklet não está disponível. A gravação multipista não pode ser iniciada com segurança neste navegador.')
    if (this.recordingTrackId) throw new Error('Já existe uma gravação em andamento.')

    const stream = await this.requestInput()
    const [inputTrack] = stream.getAudioTracks()
    this.recordingSettings = inputTrack?.getSettings()
    this.stream = stream
    this.inputSource = this.context.createMediaStreamSource(stream)
    this.inputAnalyser = this.context.createAnalyser()
    this.inputAnalyser.fftSize = 1024
    this.recorder = new AudioWorkletNode(this.context, 'vale-pcm-recorder', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 })
    const silent = this.context.createGain()
    silent.gain.value = 0
    this.inputSource.connect(this.inputAnalyser)
    this.inputSource.connect(this.recorder)
    this.recorder.connect(silent).connect(this.context.destination)
    this.monitorGain = this.context.createGain()
    this.monitorGain.gain.value = mode === 'software' ? 0.38 : 0
    this.inputSource.connect(this.monitorGain).connect(this.context.destination)

    this.recordingChunks = []
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
    this.recordingStartFrame = this.getCurrentFrame(project.audioSampleRate)
    this.recorder.port.onmessage = ({ data }: MessageEvent<{ type: string; channels?: ArrayBuffer[] }>) => {
      if (data.type === 'pcm' && data.channels?.[0]) {
        const pcm = new Float32Array(data.channels[0])
        this.recordingChunks.push(pcm)
        if (this.persistRecordingChunk) {
          this.pendingDurableChunks.push(pcm)
          this.pendingDurableFrames += pcm.length
          if (this.pendingDurableFrames >= 8192) this.queueDurableChunk()
        }
      }
      if (data.type === 'flushed') this.resolveFlush?.()
    }
    return { inputSettings: this.recordingSettings, startFrame: this.recordingStartFrame }
  }

  setMonitorMode(mode: MonitorMode): void {
    if (!this.monitorGain || !this.context) return
    this.monitorGain.gain.setTargetAtTime(mode === 'software' ? 0.38 : 0, this.context.currentTime, 0.015)
  }

  getInputMeter(): { peak: number; rms: number } | undefined {
    if (!this.inputAnalyser) return undefined
    const data = new Float32Array(this.inputAnalyser.fftSize)
    this.inputAnalyser.getFloatTimeDomainData(data)
    let peak = 0
    let sum = 0
    data.forEach((sample) => {
      peak = Math.max(peak, Math.abs(sample))
      sum += sample * sample
    })
    return { peak, rms: Math.sqrt(sum / data.length) }
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
    if (!this.context || !this.recordingTrackId || !this.recorder) return undefined
    await new Promise<void>((resolve) => {
      this.resolveFlush = resolve
      this.recorder!.port.postMessage({ type: 'stop' })
    })
    this.queueDurableChunk()
    await this.durableWrite
    const frames = this.recordingChunks.reduce((total, chunk) => total + chunk.length, 0)
    const buffer = this.context.createBuffer(1, Math.max(1, frames), this.context.sampleRate)
    const output = buffer.getChannelData(0)
    let offset = 0
    this.recordingChunks.forEach((chunk) => {
      output.set(chunk, offset)
      offset += chunk.length
    })
    const recording: CapturedRecording = {
      blob: encodeWav(buffer, 32),
      buffer,
      peaks: buildPeaks(buffer),
      frames,
      channels: 1,
      sampleRate: this.context.sampleRate,
      inputSettings: this.recordingSettings,
      durability: { persistedChunks: this.persistedChunks, persistedFrames: this.persistedFrames, error: this.durableFailure },
    }
    safeDisconnect(this.inputSource)
    safeDisconnect(this.inputAnalyser)
    safeDisconnect(this.recorder)
    safeDisconnect(this.monitorGain)
    this.stream?.getTracks().forEach((track) => track.stop())
    this.stream = undefined
    this.inputSource = undefined
    this.inputAnalyser = undefined
    this.recorder = undefined
    this.monitorGain = undefined
    this.recordingTrackId = undefined
    this.recordingChunks = []
    this.resolveFlush = undefined
    this.pendingDurableChunks = []
    this.pendingDurableFrames = 0
    this.persistRecordingChunk = undefined
    return recording
  }

  getRecordingStartFrame(): number {
    return this.recordingStartFrame
  }

  async renderMix(project: AudioProject): Promise<AudioBuffer> {
    if (!this.context) throw new Error('Ative o áudio antes de exportar.')
    const lastFrame = project.clips.reduce((maximum, clip) => Math.max(maximum, clip.timelineStartFrame + clip.durationFrames), 0)
    const tailFrames = Math.round(project.audioSampleRate * 1.5)
    const offline = new OfflineAudioContext(2, Math.max(project.audioSampleRate, lastFrame + tailFrames), project.audioSampleRate)
    const master = offline.createGain()
    master.gain.value = 0.92
    master.connect(offline.destination)
    const soloActive = project.tracks.some((track) => track.solo)
    const graphs = new Map(project.tracks.map((track) => [track.id, this.makeTrackGraph(offline, track, master, soloActive)]))

    for (const clip of project.clips) {
      const sourceBuffer = this.assetBuffers.get(clip.assetId)
      const graph = graphs.get(clip.trackId)
      if (!sourceBuffer || !graph) continue
      const source = offline.createBufferSource()
      const clipGain = offline.createGain()
      source.buffer = sourceBuffer
      source.connect(clipGain).connect(graph.highPass)
      const sourceAt = clip.timelineStartFrame / project.audioSampleRate
      this.applyClipEnvelope(clipGain, clip, sourceAt, 0, clip.durationFrames, project.audioSampleRate)
      source.start(sourceAt, clip.sourceOffsetFrame / project.audioSampleRate, clip.durationFrames / project.audioSampleRate)
    }
    return offline.startRendering()
  }

  async exportMix(project: AudioProject, format: 'wav' | 'mp3'): Promise<Blob> {
    const buffer = await this.renderMix(project)
    return format === 'wav' ? encodeWav(buffer, 24) : encodeMp3(buffer, 192)
  }
}
