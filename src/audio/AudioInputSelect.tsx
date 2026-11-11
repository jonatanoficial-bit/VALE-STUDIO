import { useEffect, useState } from 'react'

type Props = {
  value?: string
  disabled: boolean
  onChange: (id?: string) => void
}

export function AudioInputSelect({ value, disabled, onChange }: Props) {
  const [inputs, setInputs] = useState<MediaDeviceInfo[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const devices = navigator.mediaDevices
    if (!devices?.enumerateDevices) return
    let active = true
    const refresh = () => void devices.enumerateDevices().then((list) => {
      if (active) setInputs(list.filter((device) => device.kind === 'audioinput' && device.deviceId && device.deviceId !== 'default'))
    }).catch(() => undefined)
    refresh()
    devices.addEventListener('devicechange', refresh)
    return () => { active = false; devices.removeEventListener('devicechange', refresh) }
  }, [])

  async function enableInputs() {
    setBusy(true)
    setError('')
    let stream: MediaStream | undefined
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const list = await navigator.mediaDevices.enumerateDevices()
      setInputs(list.filter((device) => device.kind === 'audioinput' && device.deviceId && device.deviceId !== 'default'))
    } catch {
      setError('O sistema não liberou o acesso às entradas de áudio.')
    } finally {
      stream?.getTracks().forEach((track) => track.stop())
      setBusy(false)
    }
  }

  if (!navigator.mediaDevices?.getUserMedia) return null
  return <div className="audio-input-select">
    <label>Dispositivo de entrada <select value={value ?? ''} disabled={disabled || busy} onChange={(event) => onChange(event.target.value || undefined)}>
      <option value="">Padrão do sistema</option>
      {value && !inputs.some((input) => input.deviceId === value) && <option value={value}>Entrada salva · indisponível</option>}
      {inputs.map((input, index) => <option key={input.deviceId} value={input.deviceId}>{input.label || `Entrada ${index + 1}`}</option>)}
    </select></label>
    <button type="button" className="button secondary" disabled={disabled || busy} onClick={() => void enableInputs()}>{busy ? 'Aguardando…' : 'Listar entradas'}</button>
    {error && <small role="alert">{error}</small>}
  </div>
}
