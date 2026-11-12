import { useEffect, useRef, useState } from 'react'
import { listWasapiDevices, playWasapiPcm, stopWasapiOutput, wasapiOutputRunning, type WasapiCaptureSettings, type WasapiCaptureStats, type WasapiDevice } from '../platform/desktop'

function supportedPeriods(device?: WasapiDevice): number[] {
  if (!device?.fundamental) return []
  return [...new Set([128, 256, 512, 1024, device.minimum, device.maximum])]
    .filter((period) => period !== device.standard && period >= device.minimum && period <= device.maximum && period % device.fundamental === 0)
    .sort((a, b) => a - b)
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
  const [deviceId, setDeviceId] = useState('')
  const [frames, setFrames] = useState(0)
  const [input, setInput] = useState(0)
  const [outputId, setOutputId] = useState('')
  const [outputFrames, setOutputFrames] = useState(0)
  const [monitor, setMonitor] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [busy, setBusy] = useState<'devices' | 'record'>()
  const [status, setStatus] = useState('')
  const device = devices.find((item) => item.id === deviceId)
  const output = devices.find((item) => item.id === outputId)
  const canMonitor = Boolean(output && device && output.sampleRate === device.sampleRate)
  const run = useRef<AbortController | undefined>(undefined)

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
      const outputs = found.filter((item) => item.flow === 'output')
      setDevices(found)
      setDeviceId(inputs.find((item) => item.id === deviceId)?.id ?? inputs[0]?.id ?? '')
      setOutputId(outputs.find((item) => item.id === outputId)?.id ?? '')
      setFrames(0)
      setOutputFrames(0)
      setInput(0)
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
    if (!device) return
    setBusy('record')
    try {
      await onRecord({
        backend: 'wasapi', frames, sampleRate: device.sampleRate,
        input: twoTracks || input <= device.channels - channels ? input : 0,
        output: 0, inputDeviceId: device.id,
        playback: output ? { device: output, period: outputFrames } : undefined,
      }, twoTracks, canMonitor && monitor)
    } finally {
      setBusy(undefined)
    }
  }

  return <details className="asio-monitor-controls">
    <summary>Áudio nativo · WASAPI Shared</summary>
    <fieldset disabled={blocked || Boolean(busy)}>
      <button type="button" className="button secondary" onClick={() => void refresh()}>{busy === 'devices' ? 'Consultando…' : 'Listar dispositivos WASAPI'}</button>
      {device && <>
        <label>Dispositivo WASAPI <select value={deviceId} onChange={(event) => {
          setDeviceId(event.target.value)
          setFrames(0)
          setInput(0)
        }}>
          {devices.filter((item) => item.flow === 'input').map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select></label>
        <label>Período WASAPI <select value={frames} onChange={(event) => setFrames(Number(event.target.value))}>
          <option value={0}>Automático · {device.standard} frames</option>
          {supportedPeriods(device).map((period) => <option key={period} value={period}>{period} frames</option>)}
        </select></label>
        <label>Canal inicial <select value={input < device.channels - channels + 1 ? input : 0} onChange={(event) => setInput(Number(event.target.value))}>
          {Array.from({ length: Math.max(0, device.channels - channels + 1) }, (_, index) =>
            <option key={index} value={index}>{channels === 2 ? `${index + 1} + ${index + 2}` : index + 1}</option>)}
        </select></label>
        <button type="button" className="button record-action" disabled={!armed || device.channels < channels}
          onClick={() => void record(false)}>{output ? 'Gravar com a base via WASAPI' : 'Gravar via WASAPI'}</button>
        {otherTrack && <button type="button" className="button secondary" disabled={!armed || input + 2 > device.channels}
          title={`Canal ${input + 1} na pista selecionada e canal ${input + 2} em ${otherTrack}`}
          onClick={() => void record(true)}>Gravar duas pistas mono</button>}
        <output>{device.sampleRate.toLocaleString('pt-BR')} Hz · {device.channels} canais disponíveis</output>
      </>}
      {devices.some((item) => item.flow === 'output') && <label>Saída WASAPI <select value={outputId} onChange={(event) => {
        setOutputId(event.target.value); setOutputFrames(0); setMonitor(false)
      }}>
        <option value="">Escolha a saída</option>
        {devices.filter((item) => item.flow === 'output').map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select></label>}
      {output && <>
        <label>Período de saída <select value={outputFrames} onChange={(event) => setOutputFrames(Number(event.target.value))}>
          <option value={0}>Automático · {output.standard} frames</option>
          {supportedPeriods(output).map((period) => <option key={period} value={period}>{period} frames</option>)}
        </select></label>
        <label><input type="checkbox" checked={canMonitor && monitor} disabled={!canMonitor}
          onChange={(event) => setMonitor(event.target.checked)} /> Ouvir a entrada durante a gravação</label>
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
      Última gravação · Saída vazia {stats.emptyOutputBuffers}
      {stats.monitorPrimingFrames > 0 && ` · Fila do retorno vazia ${stats.monitorUnderruns} vezes · ${stats.monitorDroppedFrames} frames descartados · Pré-buffer ${stats.monitorPrimingFrames} frames`}
    </output>}
  </details>
}
