export type Vst3Plugin = {
  bundlePath: string
  classId: string
  name: string
  vendor: string
  version: string
  kind: 'effect' | 'instrument'
}

export type Vst3ScanResult = {
  plugins: Vst3Plugin[]
  errors: string[]
}

export type Vst3ProbeResult = {
  compatible: boolean
  message: string
}

type TauriCore = {
  invoke<T>(command: string, args?: Record<string, unknown> | Uint8Array, options?: { headers: Record<string, string> }): Promise<T>
}

type TauriWindow = Window & {
  __TAURI__?: { core?: TauriCore }
}

function nativeCore(): TauriCore | undefined {
  return (window as TauriWindow).__TAURI__?.core
}

export function isDesktopRuntime(): boolean {
  return Boolean(nativeCore())
}

export async function chooseVst3Directory(): Promise<string | undefined> {
  const core = nativeCore()
  if (!core) return undefined
  return core.invoke<string | null>('pick_vst3_directory').then((path) => path ?? undefined)
}

export async function scanVst3Directory(directory: string): Promise<Vst3ScanResult> {
  const core = nativeCore()
  if (!core) throw new Error('A busca por VST3 está disponível apenas no Vale Studio Desktop.')
  return core.invoke<Vst3ScanResult>('scan_vst3', { directory })
}

export async function scanDefaultVst3Directories(): Promise<Vst3ScanResult> {
  const core = nativeCore()
  if (!core) throw new Error('A busca por VST3 está disponível apenas no Vale Studio Desktop.')
  return core.invoke<Vst3ScanResult>('scan_default_vst3')
}

export async function probeVst3Plugin(plugin: Pick<Vst3Plugin, 'bundlePath' | 'classId'>): Promise<Vst3ProbeResult> {
  const core = nativeCore()
  if (!core) throw new Error('A qualificação VST3 está disponível apenas no Vale Studio Desktop.')
  return core.invoke<Vst3ProbeResult>('probe_vst3', { bundlePath: plugin.bundlePath, classId: plugin.classId })
}

export type AsioMonitorInfo = {
  frames: number
  bufferFrames?: number
  channels: number
  sampleRate: number
  inputLatency: number
  outputLatency: number
}

export async function asioMonitorAvailable(): Promise<boolean> {
  return await nativeCore()?.invoke<boolean>('asio_monitor_available') ?? false
}

export type AsioSettings = { backend?: 'asio'; frames: number; sampleRate: number; input: number; output: number }
export type WasapiCaptureSettings = {
  backend: 'wasapi'; frames: number; sampleRate: number; input: number; output: 0; inputDeviceId: string
  playback?: { device: WasapiDevice; period: number }
}
export type NativeCaptureSettings = AsioSettings | WasapiCaptureSettings
export type WasapiDevice = {
  id: string; name: string; flow: 'input' | 'output'; sampleRate: number; channels: number
  standard: number; minimum: number; maximum: number; fundamental: number
}

export async function listWasapiDevices(): Promise<WasapiDevice[]> {
  return await nativeCore()?.invoke<WasapiDevice[]>('wasapi_devices') ?? []
}

export async function playWasapiPcm(device: WasapiDevice, frames: number, bytes: ArrayBuffer): Promise<void> {
  const core = nativeCore()
  if (!core) throw new Error('A saída WASAPI exige o Vale Studio Desktop.')
  await core.invoke('play_wasapi_pcm', new Uint8Array(bytes), { headers: {
    'x-device-id': device.id, 'x-period': String(frames), 'x-sample-rate': String(device.sampleRate),
  } })
}

export async function wasapiOutputRunning(): Promise<boolean> {
  return await nativeCore()?.invoke<boolean>('wasapi_output_running') ?? false
}

export async function stopWasapiOutput(): Promise<void> {
  await nativeCore()?.invoke('stop_wasapi_output')
}
export type AsioCapturePacket = { samples: number[]; ended: boolean; error?: string }

export async function startAsioMonitor(settings: NativeCaptureSettings & { capture?: boolean; dryReturn?: boolean; channels?: 1 | 2 }): Promise<AsioMonitorInfo> {
  const core = nativeCore()
  if (!core) throw new Error('O retorno ASIO exige o Vale Studio Desktop.')
  return core.invoke<AsioMonitorInfo>('start_asio_monitor', settings)
}

export async function startWasapiDuplex(settings: WasapiCaptureSettings, dryReturn: boolean, channels: 1 | 2, backing: ArrayBuffer): Promise<AsioMonitorInfo> {
  const core = nativeCore()
  if (!core || !settings.playback) throw new Error('Selecione a saída WASAPI no Vale Studio Desktop.')
  const { device, period } = settings.playback
  return core.invoke('start_wasapi_duplex', new Uint8Array(backing), { headers: {
    'x-input-id': settings.inputDeviceId, 'x-input-period': String(settings.frames),
    'x-input-rate': String(settings.sampleRate), 'x-first-channel': String(settings.input), 'x-channels': String(channels),
    'x-output-id': device.id, 'x-output-period': String(period), 'x-output-rate': String(device.sampleRate),
    'x-dry-return': dryReturn ? '1' : '0',
  } })
}

export async function readAsioCapture(): Promise<AsioCapturePacket> {
  const core = nativeCore()
  if (!core) throw new Error('A captura ASIO exige o Vale Studio Desktop.')
  return core.invoke('read_asio_capture')
}

export async function finishAsioCapture(): Promise<AsioCapturePacket> {
  const core = nativeCore()
  if (!core) throw new Error('A captura ASIO exige o Vale Studio Desktop.')
  return core.invoke('finish_asio_capture')
}

export async function stopAsioMonitor(): Promise<void> {
  await nativeCore()?.invoke('stop_asio_monitor')
}

export async function asioMonitorRunning(): Promise<boolean> {
  return await nativeCore()?.invoke<boolean>('asio_monitor_running') ?? false
}

export async function openVstStream(plugin: Pick<Vst3Plugin, 'bundlePath' | 'classId'> & { id: string }, frames: number, sampleRate: number, bpm: number) {
  const core = nativeCore()
  if (!core) throw new Error('O processamento VST3 exige o Vale Studio Desktop.')
  const streamId = crypto.randomUUID()
  const prefix = new TextEncoder().encode(streamId)
  await core.invoke('open_vst_stream', { streamId, insertId: plugin.id, bundlePath: plugin.bundlePath, classId: plugin.classId, frames, sampleRate, bpm })
  return {
    async process(pcm: Float32Array, events: number[][], showEditor = false): Promise<Float32Array> {
      const count = Math.min(events.length, 1024)
      const bytes = new Uint8Array(prefix.length + pcm.byteLength + 4 + count * 16)
      bytes.set(prefix)
      bytes.set(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength), prefix.length)
      const view = new DataView(bytes.buffer)
      const offset = prefix.length + pcm.byteLength
      view.setUint32(offset, count | (showEditor ? 0x80000000 : 0), true)
      for (let i = 0; i < count; i += 1) {
        for (let field = 0; field < 4; field += 1) {
          view.setUint32(offset + 4 + (i * 4 + field) * 4, events[i][field], true)
        }
      }
      const result = await core.invoke<ArrayBuffer>('process_vst_stream', bytes)
      if (!(result instanceof ArrayBuffer) || result.byteLength !== pcm.byteLength) {
        throw new Error('O host retornou um bloco de áudio inválido.')
      }
      return new Float32Array(result)
    },
    close(): void {
      void core.invoke('close_vst_stream', { streamId }).catch(() => undefined)
    },
  }
}
