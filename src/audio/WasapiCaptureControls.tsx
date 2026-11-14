import { useEffect, useRef, useState } from 'react'
import { listWasapiDevices, playWasapiPcm, stopWasapiOutput, wasapiOutputRunning, type WasapiCaptureSettings, type WasapiCaptureStats, type WasapiDevice } from '../platform/desktop'

function supportedPeriods(device?: WasapiDevice): number[] {
  if (!device?.fundamental) return []
  return [...new Set([128, 256, 512, 1024, device.minimum, device.maximum])]
    .filter((period) => period !== device.standard && period >= device.minimum && period <= device.maximum && period % device.fundamental === 0)
    .sort((a, b) => a - b)
}

const SETTINGS_KEY = 'vale-studio:wasapi-settings'
const INITIAL_SETTINGS = { deviceId: '', outputId: '', frames: 0, outputFrames: 0, input: 0, monitor: false }

function loadSettings(): typeof INITIAL_SETTINGS {
  try {
    const { deviceId, outputId, frames, outputFrames, input, monitor } = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}')
    const natural = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
    return {
      deviceId: typeof deviceId === 'string' ? deviceId : '',
      outputId: typeof outputId === 'string' ? outputId : '',
      frames: natural(frames), outputFrames: natural(outputFrames), input: natural(input),
      monitor: monitor === true,
    }
  } catch {
    return INITIAL_SETTINGS
  }
}

export function WasapiCaptureControls({ armed, blocked, channels, otherTrack, stats, onRecord, prepareMix, setAudioBusy }: {
  armed: boolean
  blocked: boolean
  channels: 1 | 2
  otherTrack?: string
  stats?: WasapiCaptureStats
  onRecord: (settings: WasapiCaptureSettings, twoTracks: boolean, dryReturn: boolean) => Promise<void>
  prepareMix: () => Promise<AudioBuffer>
  setAudioBusy: (busy: boolean) => void
}) {
  const [devices, setDevices] = useState<WasapiDevice[]>([])
  const [settings, setSettings] = useState(loadSettings)
  const [playing, setPlaying] = useState(false)
  const [busy, setBusy] = useState<'devices' | 'record'>()
  const [status, setStatus] = useState('')
  const inputs = devices.filter((item) => item.flow === 'input')
  const outputs = devices.filter((item) => item.flow === 'output')
  const device = settings.deviceId ? inputs.find((item) => item.id === settings.deviceId) : inputs[0]
  const output = outputs.find((item) => item.id === settings.outputId)
  const frames = supportedPeriods(device).includes(settings.frames) ? settings.frames : 0
  const outputFrames = supportedPeriods(output).includes(settings.outputFrames) ? settings.outputFrames : 0
  const input = device && settings.input <= device.channels - channels ? settings.input : 0
  const canMonitor = Boolean(output && device && output.sampleRate === device.sampleRate)
  const run = useRef<AbortController | undefined>(undefined)

  function updateSettings(changes: Partial<typeof INITIAL_SETTINGS>) {
    const next = { ...settings, ...changes }
    setSettings(next)
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(next)) } catch { /* Settings still apply in this session. */ }
  }

  useEffect(() => () => {
    if (!run.current) return
    run.current.abort()
    void stopWasapiOutput().catch(() => undefined).finally(() => setAudioBusy(false))
  }, [setAudioBusy])

  async function refresh() {
    setBusy('devices')
    setStatus('')
    try {
      const found = (await listWasapiDevices()).filter((item) => item.sampleRate > 0 && item.standard > 0)
      const inputs = found.filter((item) => item.flow === 'input')
      setDevices(found)
      if (!inputs.length) setStatus('Nenhuma entrada WASAPI ativa respondeu.')
    } catch (error) {
      setStatus(String(error))
    } finally {
      setBusy(undefined)
    }
  }

  async function playMix(selected: WasapiDevice) {
    const attempt = new AbortController()
    run.current = attempt
    setAudioBusy(true)
    setPlaying(true)
    setStatus('Preparando a mixagem para a saída WASAPI…')
    try {
      let mix = await prepareMix()
      if (attempt.signal.aborted) return
      const length = Math.ceil(mix.duration * selected.sampleRate)
      if (length > 192 * 1024 * 1024 / 8) throw new Error('A mixagem excede a duração disponível para esta reprodução WASAPI.')
      if (mix.sampleRate !== selected.sampleRate) {
        const context = new OfflineAudioContext(2, length, selected.sampleRate)
        const source = context.createBufferSource()
        source.buffer = mix
        source.connect(context.destination)
        source.start()
        mix = await context.startRendering()
      }
      if (attempt.signal.aborted) return
      const pcm = new Float32Array(mix.length * 2)
      const left = mix.getChannelData(0)
      const right = mix.getChannelData(1)
      for (let frame = 0; frame < mix.length; frame += 1) {
        pcm[frame * 2] = left[frame]
        pcm[frame * 2 + 1] = right[frame]
      }
      await playWasapiPcm(selected, outputFrames, pcm.buffer)
      if (attempt.signal.aborted) { await stopWasapiOutput(); return }
      setStatus(`Reproduzindo mixagem em ${selected.name}.`)
      while (!attempt.signal.aborted && await wasapiOutputRunning()) {
        await new Promise<void>((resolve) => window.setTimeout(resolve, 300))
      }
      if (!attempt.signal.aborted) setStatus('Reprodução da mixagem concluída.')
    } catch (error) {
      await stopWasapiOutput().catch(() => undefined)
      if (!attempt.signal.aborted) setStatus(String(error))
    } finally {
      if (run.current === attempt) {
        run.current = undefined
        setPlaying(false)
        setAudioBusy(false)
      }
    }
  }

  async function record(twoTracks: boolean) {
    if (!device || (settings.outputId && !output)) return
    setBusy('record')
    try {
      await onRecord({
        backend: 'wasapi', frames, sampleRate: device.sampleRate,
        input,
        output: 0, inputDeviceId: device.id,
        playback: output ? { device: output, period: outputFrames } : undefined,
      }, twoTracks, canMonitor && settings.monitor)
    } finally {
      setBusy(undefined)
    }
  }

  return <details className="asio-monitor-controls">
    <summary>Áudio nativo · WASAPI Shared</summary>
    <fieldset disabled={blocked || Boolean(busy)}>
      <button type="button" className="button secondary" onClick={() => void refresh()}>{busy === 'devices' ? 'Consultando…' : 'Listar dispositivos WASAPI'}</button>
      {inputs.length > 0 && <label>Dispositivo WASAPI <select value={device?.id ?? ''} onChange={(event) =>
        updateSettings({ deviceId: event.target.value, frames: 0, input: 0, monitor: false })}>
        {!device && <option value="" disabled>Entrada salva indisponível</option>}
        {inputs.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select></label>}
      {device && <>
        <label>Período WASAPI <select value={frames} onChange={(event) =>
          updateSettings({ deviceId: device.id, frames: Number(event.target.value) })}>
          <option value={0}>Automático · {device.standard} frames</option>
          {supportedPeriods(device).map((period) => <option key={period} value={period}>{period} frames</option>)}
        </select></label>
        <label>Canal inicial <select value={input} onChange={(event) =>
          updateSettings({ deviceId: device.id, input: Number(event.target.value) })}>
          {Array.from({ length: Math.max(0, device.channels - channels + 1) }, (_, index) =>
            <option key={index} value={index}>{channels === 2 ? `${index + 1} + ${index + 2}` : index + 1}</option>)}
        </select></label>
        <button type="button" className="button record-action" disabled={!armed || device.channels < channels || Boolean(settings.outputId && !output)}
          onClick={() => void record(false)}>{output ? 'Gravar com a base via WASAPI' : 'Gravar via WASAPI'}</button>
        {otherTrack && <button type="button" className="button secondary" disabled={!armed || input + 2 > device.channels || Boolean(settings.outputId && !output)}
          title={`Canal ${input + 1} na pista selecionada e canal ${input + 2} em ${otherTrack}`}
          onClick={() => void record(true)}>Gravar duas pistas mono</button>}
        <output>{device.sampleRate.toLocaleString('pt-BR')} Hz · {device.channels} canais disponíveis</output>
      </>}
      {(outputs.length > 0 || settings.outputId) && <label>Saída WASAPI <select value={settings.outputId} onChange={(event) =>
        updateSettings({ outputId: event.target.value, outputFrames: 0, monitor: false })}>
        <option value="">Sem saída WASAPI</option>
        {settings.outputId && !output && <option value={settings.outputId} disabled>Saída salva indisponível</option>}
        {outputs.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select></label>}
      {output && <>
        <label>Período de saída <select value={outputFrames} onChange={(event) => updateSettings({ outputFrames: Number(event.target.value) })}>
          <option value={0}>Automático · {output.standard} frames</option>
          {supportedPeriods(output).map((period) => <option key={period} value={period}>{period} frames</option>)}
        </select></label>
        <label><input type="checkbox" checked={canMonitor && settings.monitor} disabled={!canMonitor}
          onChange={(event) => updateSettings({ deviceId: device?.id ?? '', monitor: event.target.checked })} /> Ouvir a entrada durante a gravação</label>
        {device && !canMonitor && <output>O retorno requer entrada e saída na mesma taxa.</output>}
        <button className="button secondary" type="button" onClick={() => void playMix(output)}>Reproduzir mixagem via WASAPI</button>
      </>}
    </fieldset>
    {playing && <button type="button" className="button secondary" onClick={() => {
      run.current?.abort()
      setStatus('Reprodução interrompida.')
      void stopWasapiOutput().catch((error) => setStatus(String(error)))
    }}>Parar mixagem</button>}
    {status && <output aria-live="polite">{status}</output>}
    {busy === 'record' && <output aria-live="polite">Preparando a gravação WASAPI…</output>}
    {stats && <output aria-live="polite">
      Última gravação
      {stats.emptyOutputBuffers !== undefined && ` · Saída vazia ${stats.emptyOutputBuffers}`}
      {stats.monitorPrimingFrames && stats.monitorPrimingFrames > 0
        ? ` · Fila do retorno vazia ${stats.monitorUnderruns} vezes · ${stats.monitorDroppedFrames} frames descartados · Pré-buffer ${stats.monitorPrimingFrames} frames`
        : ''}
      {` · Descontinuidades de entrada ${stats.captureDiscontinuities} · ${stats.captureMissingFrames} frames preenchidos com silêncio`}
    </output>}
  </details>
}
