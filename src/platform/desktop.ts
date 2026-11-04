export type Vst3Plugin = {
  bundlePath: string
  classId: string
  name: string
  vendor: string
  version: string
}

export type Vst3ScanResult = {
  plugins: Vst3Plugin[]
  errors: string[]
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
