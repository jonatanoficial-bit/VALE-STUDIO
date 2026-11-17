import { useMemo, useState } from 'react'
import { findTransients, regionsAboveSilence, type ClipAnalysis, type ClipRegion } from './clipAnalysis'

type Props = {
  analysis: ClipAnalysis
  clipStart: number
  cursor: number
  editable: boolean
  canStrip: boolean
  onSeek: (frame: number) => void
  onStrip: (regions: ClipRegion[]) => void
  onMark: (frames: number[]) => void
}

export function ClipAnalysisPanel({ analysis, clipStart, cursor, editable, canStrip, onSeek, onStrip, onMark }: Props) {
  const [threshold, setThreshold] = useState(-48)
  const [minimum, setMinimum] = useState(100)
  const [padding, setPadding] = useState(15)
  const transients = useMemo(() => findTransients(analysis, threshold).map((frame) => frame + clipStart), [analysis, threshold, clipStart])
  const currentIndex = transients.findIndex((frame) => frame >= cursor)
  const previous = currentIndex < 0 ? transients.at(-1) : transients[currentIndex - 1]
  const next = transients.find((frame) => frame > cursor)
  const regions = useMemo(() => regionsAboveSilence(analysis, threshold, minimum, padding), [analysis, threshold, minimum, padding])
  const remaining = regions.reduce((total, region) => total + region.end - region.start, 0)
  return <div className="clip-analysis">
    <label>Limiar de sinal <output>{threshold} dBFS</output>
      <input type="range" min={-80} max={-6} value={threshold} onChange={(event) => setThreshold(Number(event.target.value))} />
    </label>
    <section>
      <h3>Transientes</h3>
      <p>{transients.length} ataque(s) detectado(s)</p>
      <div className="clip-analysis-actions">
        <button type="button" className="button secondary" disabled={!editable || previous === undefined} onClick={() => { if (previous !== undefined) onSeek(previous) }}>Anterior</button>
        <button type="button" className="button secondary" disabled={!editable || next === undefined} onClick={() => { if (next !== undefined) onSeek(next) }}>Próximo</button>
        <button type="button" className="button secondary" disabled={!editable || !transients.length} onClick={() => onMark(transients)}>Criar marcadores</button>
      </div>
    </section>
    <section>
      <h3>Separar silêncio</h3>
      <label>Silêncio mínimo <output>{minimum} ms</output>
        <input type="range" min={20} max={1000} step={10} value={minimum} onChange={(event) => setMinimum(Number(event.target.value))} />
      </label>
      <label>Margem nas bordas <output>{padding} ms</output>
        <input type="range" min={0} max={200} step={5} value={padding} onChange={(event) => setPadding(Number(event.target.value))} />
      </label>
      <p>{remaining === 0 ? 'Nenhum trecho acima do limiar.' : `${regions.length} trecho(s) · ${((analysis.length - remaining) / analysis.rate).toFixed(2)} s de silêncio detectado`}</p>
      {!canStrip && <p>Desbloqueie a posição do clipe para separar o silêncio.</p>}
      <button type="button" className="button primary" disabled={!editable || !canStrip || !remaining || remaining >= analysis.length} onClick={() => onStrip(regions)}>Separar silêncio</button>
    </section>
  </div>
}
