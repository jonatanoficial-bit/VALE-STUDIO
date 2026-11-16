import { useState } from 'react'
import type { Clip, Track } from './domain/model'

type Props = {
  tracks: Track[]
  clips: Array<{ clip: Clip; name: string; trackName: string }>
  selectedTrack?: Track
  rate: number
  editable: boolean
  onTrack: (track: Track) => void
  onClip: (clip: Clip) => void
  onSettings: (changes: Pick<Partial<Track>, 'name' | 'hiddenInTimeline' | 'timelineHeight'>) => void
}

export function TimelineNavigator({ tracks, clips, selectedTrack, rate, editable, onTrack, onClip, onSettings }: Props) {
  const [search, setSearch] = useState('')
  const [tab, setTab] = useState<'tracks' | 'clips'>('tracks')
  const matches = (name: string) => name.toLocaleLowerCase('pt-BR').includes(search.trim().toLocaleLowerCase('pt-BR'))
  const filteredTracks = tracks.filter((track) => matches(track.name))
  const filteredClips = clips.filter(({ name, trackName }) => matches(`${name} ${trackName}`))
  return <div className="timeline-navigator">
    <nav aria-label="Lista da sessão">
      <button type="button" className="button secondary" aria-pressed={tab === 'tracks'} onClick={() => setTab('tracks')}>Pistas</button>
      <button type="button" className="button secondary" aria-pressed={tab === 'clips'} onClick={() => setTab('clips')}>Clipes</button>
      <input type="search" aria-label="Buscar na sessão" placeholder="Buscar por nome" value={search} onChange={(event) => setSearch(event.target.value)} />
    </nav>
    {tab === 'tracks' && <ul aria-label="Pistas da sessão">
      {filteredTracks.map((track) => <li key={track.id}>
        <button type="button" className="button secondary" onClick={() => onTrack(track)}>
          <span className="navigator-color" style={{ background: track.color }} />
          {track.name}<small>{track.hiddenInTimeline ? 'Oculta na timeline' : track.kind === 'midi' ? 'MIDI' : 'Áudio'}</small>
        </button>
      </li>)}
      {!filteredTracks.length && <li>Nenhuma pista encontrada.</li>}
    </ul>}
    {tab === 'clips' && <ul aria-label="Clipes da sessão">
      {filteredClips.map(({ clip, name, trackName }) => <li key={clip.id}>
        <button type="button" className="button secondary" disabled={!editable} onClick={() => onClip(clip)}>
          {name}<small>{trackName} · {(clip.timelineStartFrame / rate).toFixed(2)} s</small>
        </button>
      </li>)}
      {!filteredClips.length && <li>Nenhum clipe encontrado.</li>}
    </ul>}
    {selectedTrack && tab === 'tracks' && <fieldset disabled={!editable}>
      <legend>{selectedTrack.name}</legend>
      <form key={selectedTrack.id} onSubmit={(event) => {
        event.preventDefault()
        const name = String(new FormData(event.currentTarget).get('trackName') ?? '').trim()
        if (name) onSettings({ name })
      }}>
        <label>Nome <input name="trackName" defaultValue={selectedTrack.name} maxLength={40} required /></label>
        <button type="submit" className="button secondary">Renomear</button>
      </form>
      <label>Altura <select value={selectedTrack.timelineHeight ?? 'normal'} onChange={(event) => {
        const height = event.target.value
        onSettings({ timelineHeight: height === 'compact' || height === 'large' ? height : 'normal' })
      }}>
        <option value="compact">Compacta</option><option value="normal">Normal</option><option value="large">Ampliada</option>
      </select></label>
      <label><input type="checkbox" checked={!selectedTrack.hiddenInTimeline}
        onChange={(event) => onSettings({ hiddenInTimeline: !event.target.checked })} /> Mostrar na timeline</label>
    </fieldset>}
  </div>
}
