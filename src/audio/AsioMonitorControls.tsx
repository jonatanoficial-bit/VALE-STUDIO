import { useEffect, useRef, useState } from 'react'
import { asioMonitorAvailable, asioMonitorRunning, startAsioMonitor, stopAsioMonitor, type AsioMonitorInfo, type AsioSettings } from '../platform/desktop'

type Props = {
  armedTrackId?: string
  channels: 1 | 2
  blocked: boolean
  setBusy: (value: boolean) => void
  onRecord: (settings: AsioSettings, dryReturn: boolean) => Promise<void>
}

export function AsioMonitorControls({ armedTrackId, channels, blocked, setBusy, onRecord }: Props) {
  const [available, setAvailable] = useState(false)
  const [pending, setPending] = useState(false)
  const [info, setInfo] = useState<AsioMonitorInfo>()
  const [error, setError] = useState('')
  const [frames, setFrames] = useState(256)
  const [rate, setRate] = useState(48000)
  const [input, setInput] = useState(1)
  const [output, setOutput] = useState(1)
  const [dryReturn, setDryReturn] = useState(false)
  const owner = useRef<string | undefined>(undefined)

  useEffect(() => {
    let valid = true
    void asioMonitorAvailable().then((value) => { if (valid) setAvailable(value === true) }).catch(() => undefined)
    return () => { valid = false }
  }, [])

  useEffect(() => {
    if (!owner.current || (owner.current === armedTrackId && !blocked)) return
    owner.current = undefined
    void stopAsioMonitor().then(() => {
      setInfo(undefined)
      setBusy(false)
    }).catch((reason) => setError(String(reason)))
  }, [armedTrackId, blocked, setBusy])

  useEffect(() => () => {
    if (!owner.current) return
    owner.current = undefined
    void stopAsioMonitor().then(() => setBusy(false)).catch(() => undefined)
  }, [setBusy])

  useEffect(() => {
    if (!info) return
    let valid = true
    const timer = window.setInterval(() => {
      void asioMonitorRunning().then((running) => {
        if (valid && !running) {
          owner.current = undefined
          setInfo(undefined)
          setBusy(false)
        }
      }).catch((reason) => {
        if (!valid) return
        setError(String(reason))
        void stopAsioMonitor().then(() => {
          if (!valid) return
          owner.current = undefined
          setInfo(undefined)
          setBusy(false)
        }).catch((stopError) => { if (valid) setError(String(stopError)) })
      })
    }, 1000)
    return () => { valid = false; window.clearInterval(timer) }
  }, [info, setBusy])

  async function toggle() {
    if (pending || (!info && (blocked || !armedTrackId))) return
    setPending(true)
    setError('')
    try {
      if (info) {
        await stopAsioMonitor()
        owner.current = undefined
        setInfo(undefined)
        setBusy(false)
      } else {
        owner.current = armedTrackId
        setBusy(true)
        const result = await startAsioMonitor({ frames, sampleRate: rate, input: input - 1, output: output - 1, channels })
        if (owner.current === armedTrackId) setInfo(result)
        else await stopAsioMonitor()
      }
    } catch (reason) {
      setError(String(reason))
      if (!info) { owner.current = undefined; setBusy(false) }
    } finally {
      setPending(false)
    }
  }

  if (!available) return null
  return <section className="asio-monitor-controls" aria-label="Retorno ASIO4ALL em desenvolvimento">
    <strong>Retorno seco ASIO4ALL</strong>
    <fieldset disabled={pending || Boolean(info) || blocked}>
      <label>Buffer (frames)<input type="number" min={0} max={32768} value={frames} onChange={(event) => setFrames(Number(event.target.value))} /></label>
      <label>Taxa (Hz)<input type="number" min={8000} max={192000} step={1} value={rate} onChange={(event) => setRate(Number(event.target.value))} /></label>
      <label>{channels === 2 ? 'Primeira entrada do par estéreo' : 'Entrada mono'}<input type="number" min={1} max={257 - channels} value={input} onChange={(event) => setInput(Number(event.target.value))} /></label>
      <label>Saída inicial<input type="number" min={1} max={256} value={output} onChange={(event) => setOutput(Number(event.target.value))} /></label>
      <label><input type="checkbox" checked={dryReturn} onChange={(event) => setDryReturn(event.target.checked)} />Retorno na gravação</label>
    </fieldset>
    <button type="button" className="button secondary" onClick={() => void toggle()} disabled={pending || (!info && (blocked || !armedTrackId))}>
      {pending ? 'Aguardando driver…' : info ? 'Desligar retorno' : 'Ouvir pista armada'}
    </button>
    <button type="button" className="button record-action" disabled={blocked || pending || Boolean(info) || !armedTrackId}
      onClick={() => void onRecord({ frames, sampleRate: rate, input: input - 1, output: output - 1 }, dryReturn)}>Gravar via ASIO</button>
    {info ? <output>{info.frames} frames · {info.sampleRate} Hz · {((info.inputLatency + info.outputLatency) * 1000 / info.sampleRate).toFixed(1)} ms reportados pelo driver</output>
      : <small>Arme uma pista de áudio, pare o transporte e use fones. Buffer 0 usa o valor preferido do driver.</small>}
    {error && <p role="alert">{error}</p>}
  </section>
}
