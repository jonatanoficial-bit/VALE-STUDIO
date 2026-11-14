import { useState } from 'react'
import type { FormEvent } from 'react'
import type { MidiNote } from '../domain/model'

const PITCH_NAMES = ['Dó', 'Dó♯', 'Ré', 'Ré♯', 'Mi', 'Fá', 'Fá♯', 'Sol', 'Sol♯', 'Lá', 'Lá♯', 'Si']
const TICKS_PER_BEAT = 960
const QUANTIZE_STEPS = [1, 0.5, 0.25, 0.125] as const

type Props = {
  notes: MidiNote[]
  cursorBeat: number
  disabled: boolean
  onChange: (notes: MidiNote[]) => void
}

function beatLabel(beat: number): number {
  return Number((beat + 1).toFixed(6))
}

function NoteFields({ note }: { note?: MidiNote }) {
  return <>
    <label>Altura MIDI <input name="note" type="number" min={0} max={127} step={1} defaultValue={note?.note ?? 60} required /></label>
    <label>Posição (tempos) <input name="start" type="number" min={1} step="any" defaultValue={beatLabel(note?.startBeat ?? 0)} required /></label>
    <label>Duração (tempos) <input name="duration" type="number" min={0.001} step="any" defaultValue={Number((note?.durationBeats ?? 1).toFixed(6))} required /></label>
    <label>Velocidade <input name="velocity" type="number" min={1} max={127} step={1} defaultValue={note?.velocity ?? 100} required /></label>
  </>
}

export function MidiEditor({ notes, cursorBeat, disabled, onChange }: Props) {
  const [selectedId, setSelectedId] = useState('')
  const [division, setDivision] = useState<number>(0.25)
  const [scope, setScope] = useState<'track' | 'note'>('track')
  const ordered = [...notes].sort((a, b) => a.startBeat - b.startBeat || a.note - b.note)
  const selected = ordered.find((note) => note.id === selectedId)
  const cursorNote = { id: '', note: 60, startBeat: cursorBeat, durationBeats: 1, velocity: 100 }

  function editNotes(transform: (note: MidiNote) => MidiNote) {
    if (disabled) return
    const next = notes.map((note) => scope === 'track' || note.id === selected?.id ? transform(note) : note)
    if (next.some((note, index) => note !== notes[index])) onChange(next)
  }

  function quantize() {
    editNotes((note) => {
      const startBeat = Math.round(note.startBeat / division) * division
      return startBeat === note.startBeat ? note : { ...note, startBeat }
    })
  }

  function transpose(semitones: number) {
    editNotes((note) => {
      const pitch = note.note + semitones
      return { ...note, note: pitch }
    })
  }

  const targets = scope === 'track' ? notes : selected ? [selected] : []

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (disabled) return
    const fields = new FormData(event.currentTarget)
    const note = Number(fields.get('note'))
    const velocity = Number(fields.get('velocity'))
    const start = Number(fields.get('start'))
    const duration = Number(fields.get('duration'))
    if (!Number.isInteger(note) || note < 0 || note > 127 || !Number.isInteger(velocity) || velocity < 1 || velocity > 127 ||
      !Number.isFinite(start) || start < 1 || !Number.isFinite(duration) || duration < 0.001) return
    const next: MidiNote = {
      id: selected?.id ?? crypto.randomUUID(),
      note,
      velocity,
      startBeat: Math.round((start - 1) * TICKS_PER_BEAT) / TICKS_PER_BEAT,
      durationBeats: Math.max(1, Math.round(duration * TICKS_PER_BEAT)) / TICKS_PER_BEAT,
    }
    onChange(selected ? notes.map((item) => item.id === next.id ? next : item) : [...notes, next])
    setSelectedId(next.id)
  }

  return <section className="midi-editor" aria-label="Editor MIDI">
    <h3>Notas MIDI</h3>
    <label>Nota <select value={selected?.id ?? ''} onChange={(event) => setSelectedId(event.target.value)}>
      <option value="">Nova nota no cursor</option>
      {ordered.map((note) => <option key={note.id} value={note.id}>
        {PITCH_NAMES[note.note % 12]}{Math.floor(note.note / 12) - 1} · tempo {beatLabel(note.startBeat)} · velocidade {note.velocity}
      </option>)}
    </select></label>
    <form onSubmit={save} key={selected ? JSON.stringify(selected) : `new-${cursorBeat}`}>
      <fieldset disabled={disabled}>
        <NoteFields note={selected ?? cursorNote} />
        <button className="button primary" type="submit">{selected ? 'Aplicar à nota' : 'Adicionar nota'}</button>
        {selected && <button className="button secondary" type="button" onClick={() => {
          onChange(notes.filter((note) => note.id !== selected.id))
          setSelectedId('')
        }}>Excluir nota</button>}
      </fieldset>
    </form>
    <fieldset disabled={disabled}>
      <legend>Edição de notas</legend>
      <label>Aplicar a <select value={scope} onChange={(event) => setScope(event.target.value === 'note' ? 'note' : 'track')}>
        <option value="track">Pista inteira</option>
        <option value="note">Nota selecionada</option>
      </select></label>
      <label>Grade MIDI <select value={division} onChange={(event) => setDivision(Number(event.target.value))}>
        {QUANTIZE_STEPS.map((step) => <option key={step} value={step}>1/{4 / step}</option>)}
      </select></label>
      <button className="button secondary" type="button" disabled={!targets.length} onClick={quantize}>Quantizar início</button>
      <button className="button secondary" type="button" disabled={!targets.length || targets.some((note) => note.note === 0)}
        onClick={() => transpose(-1)}>−1 semitom</button>
      <button className="button secondary" type="button" disabled={!targets.length || targets.some((note) => note.note === 127)}
        onClick={() => transpose(1)}>+1 semitom</button>
    </fieldset>
  </section>
}
