import { useState } from 'react'
import type { FormEvent } from 'react'
import { AUTOMATION_MODES, type AutomationLane, type AutomationMode, type TrackAutomation } from '../domain/model'

const LIMITS = {
  gainDb: { min: -60, max: 6, step: 0.5, label: 'Volume (dB)' },
  pan: { min: -1, max: 1, step: 0.05, label: 'Panorama' },
}

type Props = {
  automation?: TrackAutomation
  defaults: { gainDb: number; pan: number }
  playhead: number
  frames: number
  rate: number
  disabled: boolean
  onChange: (automation: TrackAutomation) => void
}

export function AutomationModeSelect({ mode, disabled, label = 'Modo', onChange }: {
  mode?: AutomationMode; disabled: boolean; label?: string; onChange: (mode: AutomationMode) => void
}) {
  return <label>{label} <select aria-label={label} value={mode ?? 'off'} disabled={disabled} onChange={(event) => {
    const value = AUTOMATION_MODES.find((item) => item === event.target.value)
    if (value) onChange(value)
  }}>
    {AUTOMATION_MODES.map((item) => <option value={item} key={item}>{item[0].toUpperCase() + item.slice(1)}</option>)}
  </select></label>
}

export function AutomationEditor({ automation, defaults, playhead, frames, rate, disabled, onChange }: Props) {
  const [lane, setLane] = useState<AutomationLane>('gainDb')
  const [pointFrame, setPointFrame] = useState<number>()
  const points = automation?.[lane] ?? []
  const selected = points.find((point) => point.frame === pointFrame)
  const cursor = selected?.frame ?? playhead
  const limit = LIMITS[lane]

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (disabled) return
    const fields = new FormData(event.currentTarget)
    const frame = Math.round(Number(fields.get('seconds')) * rate)
    const value = Number(fields.get('value'))
    if (!Number.isSafeInteger(frame) || frame < 0 || frame > frames || !Number.isFinite(value) || value < limit.min || value > limit.max) return
    const updated = points.filter((point) => point.frame !== selected?.frame && point.frame !== frame)
    onChange({ mode: 'read', ...automation, [lane]: [...updated, { frame, value }].sort((a, b) => a.frame - b.frame) })
    setPointFrame(frame)
  }

  return <section className="midi-editor automation-editor" aria-label="Editor de automação">
    <h3>Automação</h3>
    <div className="automation-options">
      <AutomationModeSelect mode={automation?.mode} disabled={disabled} onChange={(mode) => onChange({ ...automation, mode })} />
      <label>Parâmetro <select value={lane} onChange={(event) => {
        setLane(event.target.value === 'pan' ? 'pan' : 'gainDb')
        setPointFrame(undefined)
      }}><option value="gainDb">Volume</option><option value="pan">Panorama</option></select></label>
      {selected && <button className="button secondary" type="button" onClick={() => setPointFrame(undefined)}>Novo ponto</button>}
    </div>
    <div className="automation-lane">
      {points.length > 1 && <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        <polyline fill="none" stroke="#53c5ef" vectorEffect="non-scaling-stroke"
          points={points.map((point) => `${point.frame / frames * 100},${90 - (point.value - limit.min) / (limit.max - limit.min) * 80}`).join(' ')} />
      </svg>}
      {points.map((point) => <button className="automation-point" type="button" key={point.frame}
        style={{ left: `${point.frame / frames * 100}%`, top: `${90 - (point.value - limit.min) / (limit.max - limit.min) * 80}%` }}
        aria-label={`Ponto em ${(point.frame / rate).toFixed(3)} s · ${point.value}`} aria-pressed={selected === point}
        onClick={() => setPointFrame(point.frame)} />)}
    </div>
    <form onSubmit={save} key={`${lane}-${cursor}-${selected?.value ?? ''}`}>
      <fieldset disabled={disabled}>
        <label>Posição (s) <input type="number" name="seconds" min={0} max={frames / rate} step="any" defaultValue={Number((cursor / rate).toFixed(6))} required /></label>
        <label>{limit.label} <input type="number" name="value" min={limit.min} max={limit.max} step={limit.step} defaultValue={selected?.value ?? defaults[lane]} required /></label>
        <button className="button primary" type="submit">{selected ? 'Aplicar ao ponto' : 'Adicionar ponto'}</button>
        {selected && <button className="button secondary" type="button" onClick={() => {
          if (!automation) return
          onChange({ ...automation, [lane]: points.filter((point) => point.frame !== selected.frame) })
          setPointFrame(undefined)
        }}>Excluir ponto</button>}
      </fieldset>
    </form>
  </section>
}
