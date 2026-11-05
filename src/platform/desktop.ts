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
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>
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
