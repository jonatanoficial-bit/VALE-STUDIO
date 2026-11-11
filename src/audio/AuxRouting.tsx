import { MAX_AUX_SENDS, type AuxBus, type Track } from '../domain/model'

type Props = {
  buses: AuxBus[]
  track: Track
  disabled: boolean
  onChange: (routing: Pick<Track, 'outputBusId' | 'auxSends'>) => void
}

export function AuxRouting({ buses, track, disabled, onChange }: Props) {
  const sends = track.auxSends ?? []
  const destinations = buses.filter((bus) => bus.id !== track.outputBusId && !sends.some((send) => send.busId === bus.id))
  return <fieldset className="aux-routing" disabled={disabled}>
    <legend>Roteamento interno</legend>
    <label>Saída da pista <select value={track.outputBusId ?? ''} onChange={(event) => {
      const outputBusId = event.target.value || undefined
      onChange({ outputBusId, auxSends: sends.filter((send) => send.busId !== outputBusId) })
    }}>
      <option value="">Master</option>
      {buses.map((bus) => <option key={bus.id} value={bus.id}>{bus.name}</option>)}
    </select></label>
    {sends.map((send, index) => <div className="aux-send" key={send.busId}>
      <label>{String.fromCharCode(65 + index)} · {buses.find((bus) => bus.id === send.busId)?.name ?? 'Auxiliar'}
        <input type="range" min={0} max={100} step={1} value={Math.round(send.level * 100)} onChange={(event) => {
          const level = Number(event.target.value) / 100
          onChange({ outputBusId: track.outputBusId, auxSends: sends.map((item) => item.busId === send.busId ? { ...item, level } : item) })
        }} />
      </label>
      <output>{Math.round(send.level * 100)}%</output>
      <button className="button secondary" type="button" onClick={() => {
        onChange({ outputBusId: track.outputBusId, auxSends: sends.filter((item) => item.busId !== send.busId) })
      }}>Remover send {String.fromCharCode(65 + index)}</button>
    </div>)}
    {sends.length < MAX_AUX_SENDS && destinations.length > 0 && <label>Adicionar send <select value="" onChange={(event) => {
      if (!event.target.value) return
      onChange({ outputBusId: track.outputBusId, auxSends: [...sends, { busId: event.target.value, level: 0.25 }] })
    }}>
      <option value="">Escolha um auxiliar</option>
      {destinations.map((bus) => <option key={bus.id} value={bus.id}>{bus.name}</option>)}
    </select></label>}
  </fieldset>
}
