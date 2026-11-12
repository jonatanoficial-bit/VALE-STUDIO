import { MAX_AUX_SENDS, type AuxBus, type AuxSend, type Track } from '../domain/model'

type Props = {
  buses: AuxBus[]
  track: Track
  disabled: boolean
  onChange: (routing: Pick<Track, 'outputBusId' | 'auxSends'>) => void
}

export function AuxRouting({ buses, track, disabled, onChange }: Props) {
  const sends = track.auxSends ?? []
  const destinations = buses.filter((bus) => bus.id !== track.outputBusId && !sends.some((send) => send.busId === bus.id))
  const updateSend = (busId: string, change: Partial<Omit<AuxSend, 'busId'>>) => {
    onChange({ outputBusId: track.outputBusId, auxSends: sends.map((send) => send.busId === busId ? { ...send, ...change } : send) })
  }
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
        <input type="range" min={0} max={100} step={1} value={Math.round(send.level * 100)}
          onChange={(event) => updateSend(send.busId, { level: Number(event.target.value) / 100 })} />
      </label>
      <output>{Math.round(send.level * 100)}%</output>
      <label>Ponto do send <select value={send.tap ?? 'post'}
        onChange={(event) => updateSend(send.busId, { tap: event.target.value === 'pre' ? 'pre' : 'post' })}>
        <option value="post">Pós-fader</option>
        <option value="pre">Pré-fader</option>
      </select></label>
      <label>Pan do send <input type="range" min={-100} max={100} step={1} value={Math.round((send.pan ?? 0) * 100)}
        onChange={(event) => updateSend(send.busId, { pan: Number(event.target.value) / 100 })} /></label>
      <button className="button secondary" type="button" aria-pressed={Boolean(send.mute)}
        onClick={() => updateSend(send.busId, { mute: !send.mute })}>Mute do send</button>
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
