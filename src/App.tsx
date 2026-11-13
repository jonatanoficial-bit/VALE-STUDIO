import { ChangeEvent, memo, useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'
import { AudioEngine, type AudioCapabilities, type RecordingPcmChunk } from './audio/AudioEngine'
import type { NativeCaptureSettings, WasapiCaptureStats } from './platform/desktop'
import { AsioMonitorControls } from './audio/AsioMonitorControls'
import { WasapiCaptureControls } from './audio/WasapiCaptureControls'
import { AudioInputSelect } from './audio/AudioInputSelect'
import { AutomationEditor, AutomationModeSelect } from './audio/AutomationEditor'
import { isAutomationWriter } from './audio/automation'
import { AuxRouting } from './audio/AuxRouting'
import { buildPeaks } from './audio/peaks'
import { encodeWav } from './audio/wav'
import { createZip } from './audio/zip'
import type { AudioProject, AutomationLane, AuxBus, Clip, EffectSettings, MediaAsset, MidiNote, MonitorMode, TimeSignature, Track, TrackAutomation, Vst3Insert } from './domain/model'
import { applyCompRegion, clipIsAudible } from './domain/comp'
import { loopSlices } from './audio/loopRecording'
import { createMidiTrack, createProject, createTrack, DEFAULT_VST_BUFFER_FRAMES, gainToDb } from './domain/model'
import { exportProjectArchive, PROJECT_ARCHIVE_EXTENSION, PROJECT_ARCHIVE_MIME, restoreProjectArchive } from './storage/projectArchive'
import { projectRepository, type TakeDraft } from './storage/projectRepository'
import { chooseVst3Directory, isDesktopRuntime, probeVst3Plugin, scanDefaultVst3Directories, scanVst3Directory, type Vst3Plugin } from './platform/desktop'
import { MidiInput, type MidiDevice, type MidiMessage } from './midi/MidiInput'
import { MidiEditor } from './midi/MidiEditor'
import { PWA_SERVICE_WORKER_AVAILABLE, SERVICE_WORKER_RELOAD_KEY, SERVICE_WORKER_UPDATE_EVENT } from './platform/serviceWorker'

type View = 'tracks' | 'mixer' | 'effects' | 'takes' | 'project'
type Toast = { tone: 'info' | 'error' | 'success'; text: string } | undefined
type Vst3ProbeState = { status: 'checking' | 'compatible' | 'incompatible'; message: string }
type PunchRange = { start: number; end: number; preRoll: number; passes?: number }

const TRACK_COLORS = ['#1eaeff', '#a855f7', '#ff9e3d', '#f5cd36', '#1ed6b5', '#5d71ff']

function makeId(): string {
  return crypto.randomUUID()
}

function pairedMonoTrack(project: AudioProject, selected?: Track): Track | undefined {
  if (!selected?.armed || selected.kind === 'midi' || selected.recordChannels === 2) return undefined
  const armed = project.tracks.filter((track) => track.armed && track.kind !== 'midi')
  return armed.length === 2 ? armed.find((track) => track.id !== selected.id && track.recordChannels !== 2) : undefined
}

function formatDuration(frames: number, rate: number): string {
  const seconds = Math.max(0, frames / rate)
  const minutes = Math.floor(seconds / 60)
  return `${String(minutes).padStart(2, '0')}:${(seconds % 60).toFixed(1).padStart(4, '0')}`
}

function formatTransportTime(frames: number, rate: number): string {
  const millis = Math.max(0, Math.floor(frames * 1000 / rate))
  const hours = Math.floor(millis / 3_600_000)
  const minutes = Math.floor(millis / 60_000) % 60
  const seconds = Math.floor(millis / 1000) % 60
  return [hours, minutes, seconds].map((part) => String(part).padStart(2, '0')).join(':')
    + '.' + String(millis % 1000).padStart(3, '0')
}

function dateLabel(value: string): string {
  return new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short' }).format(new Date(value))
}

function dbLabel(value: number): string {
  return `${value > 0 ? '+' : ''}${value.toFixed(1)} dB`
}

function meterPercent(value?: number): number {
  if (!value || value <= 0) return 0
  return Math.max(0, Math.min(100, (gainToDb(value) + 60) / 60 * 100))
}

function safeFilePart(value: string, fallback: string): string {
  const safe = value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase()
  return safe || fallback
}

function readStoredVst3Directory(): string | undefined {
  try {
    return window.localStorage.getItem('vale-studio:vst3-directory') ?? undefined
  } catch {
    return undefined
  }
}

function storeVst3Directory(directory: string): void {
  try {
    window.localStorage.setItem('vale-studio:vst3-directory', directory)
  } catch {
    // The desktop app remains usable when the embedded WebView blocks storage.
  }
}

function mergeVst3Plugins(current: Vst3Plugin[], incoming: Vst3Plugin[]): Vst3Plugin[] {
  const byId = new Map(current.map((plugin) => [`${plugin.bundlePath}:${plugin.classId}`, plugin]))
  incoming.forEach((plugin) => byId.set(`${plugin.bundlePath}:${plugin.classId}`, plugin))
  return [...byId.values()].sort((left, right) => left.name.localeCompare(right.name, 'pt-BR'))
}

const Waveform = memo(function Waveform({ peaks, color }: { peaks: number[]; color: string }) {
  const samples = peaks.length < 2 ? [peaks[0] ?? 0, peaks[0] ?? 0] : peaks
  const edge = (direction: number) => samples.map((peak, index) => {
    const x = index / (samples.length - 1) * 100
    return `${x.toFixed(2)},${50 + direction * Math.max(0.4, peak * 46)}`
  })
  return (
    <svg className="waveform" viewBox="0 0 100 100" preserveAspectRatio="none" aria-label="Forma de onda do áudio real">
      <polygon points={[...edge(-1), ...edge(1).reverse()].join(' ')} fill={color} />
    </svg>
  )
})

function MidiRoll({ notes, color, framesPerBeat, timelineFrames, pencil, onDraw }: {
  notes: MidiNote[]; color: string; framesPerBeat: number; timelineFrames: number; pencil: boolean;
  onDraw: (x: number, pitch: number) => void
}) {
  return <div className="midi-roll" aria-label={`${notes.length} nota${notes.length === 1 ? '' : 's'} MIDI gravada${notes.length === 1 ? '' : 's'}`}>
    {notes.map((note) => <span key={note.id} style={{ left: `${note.startBeat * framesPerBeat / timelineFrames * 100}%`, width: `${note.durationBeats * framesPerBeat / timelineFrames * 100}%`, top: `${Math.max(0, Math.min(87, (84 - note.note) / 48 * 87))}%`, background: color }} title={`MIDI ${note.note} · velocidade ${note.velocity}`} />)}
    {notes.length === 0 && <small>Grave ou adicione notas no editor MIDI</small>}
    {pencil && <button type="button" className="midi-pencil" aria-label="Desenhar nota MIDI" onClick={(event) => {
      const bounds = event.currentTarget.getBoundingClientRect()
      const x = event.detail ? Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)) : 0
      const y = event.detail ? Math.max(0, Math.min(0.87, (event.clientY - bounds.top) / bounds.height)) : 0.435
      onDraw(x, Math.round(84 - y / 0.87 * 48))
    }} />}
  </div>
}

const TimelineClip = memo(function TimelineClip({ clip, asset, color, timelineFrames, snapFrames, tool, selected, editable, onSelect, onEdit }: {
  clip: Clip; asset?: MediaAsset; color: string; timelineFrames: number; snapFrames?: number; tool: 'move' | 'trim'; selected: boolean; editable: boolean
  onSelect: (clip: Clip) => void; onEdit: (clip: Clip) => void
}) {
  const gesture = useRef<{ id: number; x: number; width: number; moved: boolean; mode: 'move' | 'start' | 'end' } | null>(null)
  const [draft, setDraft] = useState<Clip>()
  const visible = draft ?? clip
  const peaks = useMemo(() => {
    if (!asset?.durationFrames) return [0]
    const scale = asset.peaks.length / asset.durationFrames
    return asset.peaks.slice(Math.floor(visible.sourceOffsetFrame * scale), Math.ceil((visible.sourceOffsetFrame + visible.durationFrames) * scale))
  }, [asset, visible.sourceOffsetFrame, visible.durationFrames])

  function targetClip(clientX: number, start: NonNullable<typeof gesture.current>): Clip {
    const delta = (clientX - start.x) / start.width * timelineFrames
    const edge = clip.timelineStartFrame + (start.mode === 'end' ? clip.durationFrames : 0)
    const raw = edge + delta
    const target = Math.round(snapFrames ? Math.round(raw / snapFrames) * snapFrames : raw)
    if (start.mode === 'move') {
      return { ...clip, timelineStartFrame: Math.max(0, Math.min(timelineFrames - clip.durationFrames, target)) }
    }
    const minLength = Math.min(128, clip.durationFrames)
    const moveStart = start.mode === 'start'
    const shift = moveStart
      ? Math.max(-Math.min(clip.sourceOffsetFrame, clip.timelineStartFrame), Math.min(clip.durationFrames - minLength, target - edge))
      : 0
    const duration = moveStart ? clip.durationFrames - shift : Math.max(minLength, Math.min(
      (asset?.durationFrames ?? clip.sourceOffsetFrame + clip.durationFrames) - clip.sourceOffsetFrame,
      timelineFrames - clip.timelineStartFrame,
      target - clip.timelineStartFrame,
    ))
    return { ...clip, timelineStartFrame: clip.timelineStartFrame + shift, sourceOffsetFrame: clip.sourceOffsetFrame + shift,
      durationFrames: duration, fadeInFrames: Math.min(clip.fadeInFrames, Math.floor(duration / 2)),
      fadeOutFrames: Math.min(clip.fadeOutFrames, Math.floor(duration / 2)) }
  }

  return <button type="button" className={`audio-clip ${selected ? 'selected' : ''} ${draft ? 'clip-moving' : ''} ${tool === 'trim' ? 'clip-trim' : ''}`}
    style={{ left: `${visible.timelineStartFrame / timelineFrames * 100}%`, width: `${visible.durationFrames / timelineFrames * 100}%`, '--clip-color': color } as React.CSSProperties}
    aria-label={`Selecionar clipe ${asset?.name ?? 'gravado'}`}
    onClick={(event) => { event.stopPropagation(); onSelect(clip) }}
    onPointerDown={(event) => {
      if (!editable || !event.isPrimary || event.button !== 0) return
      const width = event.currentTarget.parentElement?.getBoundingClientRect().width ?? 0
      if (width <= 0) return
      const bounds = event.currentTarget.getBoundingClientRect()
      const mode = tool === 'move' ? 'move' : event.clientX < bounds.left + bounds.width / 2 ? 'start' : 'end'
      gesture.current = { id: event.pointerId, x: event.clientX, width, moved: false, mode }
      event.currentTarget.setPointerCapture(event.pointerId)
    }}
    onPointerMove={(event) => {
      const start = gesture.current
      if (!start || start.id !== event.pointerId || (!start.moved && Math.abs(event.clientX - start.x) < 4)) return
      start.moved = true
      setDraft(targetClip(event.clientX, start))
    }}
    onPointerUp={(event) => {
      const start = gesture.current
      if (!start || start.id !== event.pointerId) return
      gesture.current = null
      setDraft(undefined)
      if (editable && start.moved) { onSelect(clip); onEdit(targetClip(event.clientX, start)) }
    }}
    onLostPointerCapture={() => { gesture.current = null; setDraft(undefined) }}>
    <Waveform peaks={peaks} color={color} />
    <small>{asset?.name.replace(/\.[^.]+$/, '')}</small>
  </button>
})

function TrackSends({ track, onChange }: { track: Track; onChange: (bus: 'reverb' | 'delay', level: number) => void }) {
  return <div className="channel-sends" aria-label={`Sends de ${track.name}`}>
    {(['reverb', 'delay'] as const).map((bus) => <RangeControl key={bus} label={bus === 'reverb' ? 'Reverb' : 'Delay'}
      value={Math.round((track.sends?.[bus] ?? 0) * 100)} min={0} max={100} suffix="%" onChange={(value) => onChange(bus, value / 100)} />)}
  </div>
}

function Logo() {
  return <div className="brand" aria-label="Vale Studio"><span className="brand-mark">V</span><span>VALE</span><em>STUDIO</em></div>
}

function Toggle({ pressed, label, onClick, danger = false, disabled = false, title }: { pressed: boolean; label: string; onClick: () => void; danger?: boolean; disabled?: boolean; title?: string }) {
  return <button type="button" className={`tiny-toggle ${pressed ? 'active' : ''} ${danger ? 'danger' : ''}`} aria-pressed={pressed} title={title} disabled={disabled} onClick={onClick}>{label}</button>
}

function TrackMeter({ value }: { value?: number }) {
  return <div className="track-meter" aria-label={value === undefined ? 'Medidor inativo' : `Nível ${Math.round(meterPercent(value))}%`}><span style={{ height: `${meterPercent(value)}%` }} /></div>
}

function PeakHold({ value, onReset }: { value?: number; onReset: () => void }) {
  const decibels = value && value > 0 ? 20 * Math.log10(value) : -Infinity
  return <button type="button" className={`peak-hold${decibels >= 0 ? ' clipping' : ''}`}
    title="Zerar o pico deste canal" aria-label="Zerar pico" onClick={(event) => { event.stopPropagation(); onReset() }}>
    <span>Pico</span> {Number.isFinite(decibels) ? `${decibels.toFixed(1)} dBFS` : '—'}
  </button>
}

function FaderScale() {
  return <span className="fader-scale" aria-hidden="true">{[6, 0, -12, -24, -36, -48, -60].map((db) =>
    <span key={db} style={{ top: `${(6 - db) / 66 * 100}%` }}>{db > 0 ? '+' : ''}{db}</span>)}</span>
}

function MixAutomationControl({ track, lane, playing, value, onValue, onRelease }: {
  track: Track; lane: AutomationLane; playing: boolean; value: number;
  onValue: (value: number) => void; onRelease: () => void
}) {
  const fader = lane === 'gainDb'
  return <input type="range" className={fader ? 'fader' : undefined}
    aria-label={`${fader ? 'Volume' : 'Panorama'} de ${track.name}`}
    min={fader ? -60 : -1} max={fader ? 6 : 1} step={fader ? 0.5 : 0.05} value={value}
    disabled={playing && track.automation?.mode === 'read' && Boolean(track.automation[lane]?.length)}
    onChange={(event) => onValue(Number(event.target.value))}
    onPointerDown={(event) => {
      if (playing && track.automation?.mode === 'touch') event.currentTarget.setPointerCapture(event.pointerId)
    }}
    onPointerUp={onRelease} onPointerCancel={onRelease} onLostPointerCapture={onRelease} onKeyUp={onRelease} onBlur={onRelease} />
}

function NewProjectDialog({ onCreate, onCancel }: { onCreate: (name: string, bpm: number, signature: TimeSignature) => void; onCancel: () => void }) {
  const [name, setName] = useState('Minha nova música')
  const [bpm, setBpm] = useState(100)
  const [signature, setSignature] = useState<TimeSignature>('4/4')
  return <div className="dialog-backdrop" role="presentation"><form className="dialog" onSubmit={(event) => { event.preventDefault(); onCreate(name.trim() || 'Minha nova música', bpm, signature) }}>
    <div className="dialog-kicker">NOVO PROJETO</div><h2>Comece do seu jeito.</h2><p>Configurações simples agora. Você pode ajustar o tempo depois.</p>
    <label>Nome<input autoFocus value={name} onChange={(event) => setName(event.target.value)} maxLength={60} /></label>
    <div className="form-row"><label>BPM<input type="number" min="40" max="240" value={bpm} onChange={(event) => setBpm(Math.max(40, Math.min(240, Number(event.target.value) || 100)))} /></label><label>Compasso<select value={signature} onChange={(event) => setSignature(event.target.value as TimeSignature)}>{(['2/4', '3/4', '4/4', '6/8', '12/8'] as TimeSignature[]).map((value) => <option key={value}>{value}</option>)}</select></label></div>
    <div className="dialog-actions"><button className="button secondary" type="button" onClick={onCancel}>Cancelar</button><button className="button primary" type="submit">Criar projeto</button></div>
  </form></div>
}

export default function App() {
  const engineRef = useRef(new AudioEngine())
  const midiRef = useRef(new MidiInput())
  const projectRef = useRef<AudioProject | undefined>(undefined)
  const selectedTrackIdRef = useRef<string | undefined>(undefined)
  const recordingRef = useRef(false)
  const startingPlaybackRef = useRef(false)
  const activeMidiNotesRef = useRef(new Map<number, Omit<MidiNote, 'durationBeats'>>())
  const activeDraftRef = useRef<{ id: string; projectId: string; trackId: string; secondary?: { id: string; trackId: string };
    punch?: PunchRange; loop?: { framesPerPass: number; ids: string[] } } | undefined>(undefined)
  const punchInterrupted = useRef<string | undefined>(undefined)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const archiveInputRef = useRef<HTMLInputElement>(null)
  const [projects, setProjects] = useState<AudioProject[]>([])
  const [project, setProject] = useState<AudioProject>()
  const [view, setView] = useState<View>('tracks')
  const [selectedTrackId, setSelectedTrackId] = useState<string>()
  const [selectedClipId, setSelectedClipId] = useState<string>()
  const [capabilities, setCapabilities] = useState<AudioCapabilities>()
  const [storage, setStorage] = useState<{ usage?: number; quota?: number; persistent?: boolean }>()
  const [isPlaying, setIsPlaying] = useState(false)
  const [asioBusy, setAsioBusy] = useState(false)
  const recordTransition = useRef(false)
  const [asioRecording, setAsioRecording] = useState(false)
  const [wasapiStats, setWasapiStats] = useState<WasapiCaptureStats>()
  const [isStarting, setIsStarting] = useState(false)
  const [isRecording, setIsRecording] = useState(false)
  const [punchEnded, setPunchEnded] = useState(false)
  const [isMetronome, setIsMetronome] = useState(false)
  const [playhead, setPlayhead] = useState(0)
  const [inputPeak, setInputPeak] = useState<number>()
  const [recordingPeaks, setRecordingPeaks] = useState<Record<string, number[]>>({})
  const [recordFrom, setRecordFrom] = useState(0)
  const [trackPeaks, setTrackPeaks] = useState<Record<string, number>>({})
  const [heldPeaks, setHeldPeaks] = useState<{ projectId: string; levels: Record<string, number> }>()
  const [toast, setToast] = useState<Toast>()
  const [showNewProject, setShowNewProject] = useState(false)
  const [exporting, setExporting] = useState<'wav' | 'mp3' | 'stems'>()
  const [previewingTakeId, setPreviewingTakeId] = useState<string>()
  const [archiving, setArchiving] = useState<'export' | 'import'>()
  const [takeDrafts, setTakeDrafts] = useState<TakeDraft[]>([])
  const [updateReady, setUpdateReady] = useState(false)
  const [vst3Directory, setVst3Directory] = useState<string | undefined>(() => {
    if (!isDesktopRuntime()) return undefined
    return readStoredVst3Directory()
  })
  const [vst3Plugins, setVst3Plugins] = useState<Vst3Plugin[]>([])
  const [vst3ScanErrors, setVst3ScanErrors] = useState<string[]>([])
  const [isScanningVst3, setIsScanningVst3] = useState(false)
  const [vst3ProbeStates, setVst3ProbeStates] = useState<Record<string, Vst3ProbeState>>({})
  const [midiDevices, setMidiDevices] = useState<MidiDevice[]>([])
  const [midiInputId, setMidiInputId] = useState<string>()
  const [midiReady, setMidiReady] = useState(false)
  const [draggedTrackId, setDraggedTrackId] = useState<string>()
  const [dropTrackId, setDropTrackId] = useState<string>()
  const [timelineZoom, setTimelineZoom] = useState(1)
  const [snapToBeat, setSnapToBeat] = useState(false)
  const [gridDivision, setGridDivision] = useState('beat')
  const [clipTool, setClipTool] = useState<'move' | 'trim' | 'pencil'>('move')
  const [rulerMode, setRulerMode] = useState<'time' | 'bars'>('time')
  const [trackPanel, setTrackPanel] = useState<'inserts' | 'sends'>()
  const [mixAutomationValues, setMixAutomationValues] = useState<Record<string, Partial<Record<AutomationLane, number>>>>({})
  const trackDialog = useRef<HTMLDialogElement>(null)
  const newTrackDialog = useRef<HTMLDialogElement>(null)
  const firstFadeInput = useRef<HTMLInputElement>(null)
  const [fadeFocusRequest, setFadeFocusRequest] = useState(0)
  const [, setUndoStack] = useState<AudioProject[]>([])
  const [, setRedoStack] = useState<AudioProject[]>([])

  const selectedTrack = project?.tracks.find((track) => track.id === selectedTrackId) ?? project?.tracks[0]
  const contentEnd = useMemo(() => {
    if (!project) return 0
    const framesPerBeat = project.audioSampleRate * 60 / project.bpm
    let end = 0
    for (const clip of project.clips) end = Math.max(end, clip.timelineStartFrame + clip.durationFrames)
    for (const marker of project.markers ?? []) end = Math.max(end, marker.frame)
    for (const track of project.tracks) {
      for (const note of track.midiNotes ?? []) end = Math.max(end, (note.startBeat + note.durationBeats) * framesPerBeat)
      for (const lane of ['gainDb', 'pan'] as const) end = Math.max(end, track.automation?.[lane]?.at(-1)?.frame ?? 0)
    }
    return end
  }, [project])
  const selectedClip = project?.clips.find((clip) => clip.id === selectedClipId)
  const activeAssetById = useMemo(() => new Map(project?.assets.map((asset) => [asset.id, asset]) ?? []), [project])
  const visibleClipsByTrack = useMemo(() => {
    const groups = new Map<string, Clip[]>()
    if (!project) return groups
    const tracks = new Map(project.tracks.map((track) => [track.id, track]))
    for (const clip of project.clips) {
      const track = tracks.get(clip.trackId)
      if (!track || (track.compEnabled ? !clipIsAudible(project, clip) : clip.compSegment)) continue
      const clips = groups.get(track.id)
      if (clips) clips.push(clip)
      else groups.set(track.id, [clip])
    }
    return groups
  }, [project])
  const activeProjectId = project?.id
  const desktopRuntime = isDesktopRuntime()
  const finishPunch = useEffectEvent(() => { void toggleRecording() })

  useEffect(() => {
    if (isRecording) document.querySelector<HTMLElement>('#studio-recording:popover-open')?.hidePopover()
  }, [isRecording])

  useEffect(() => {
    if (isRecording && punchEnded) finishPunch()
  }, [isRecording, punchEnded])

  useEffect(() => {
    const dialog = trackDialog.current
    if (trackPanel && dialog && !dialog.open) dialog.showModal()
  }, [trackPanel])

  useEffect(() => {
    projectRef.current = project
    if (project) engineRef.current.updateMix(project)
  }, [project])
  useEffect(() => { selectedTrackIdRef.current = selectedTrackId }, [selectedTrackId])
  useEffect(() => { recordingRef.current = isRecording }, [isRecording])
  useEffect(() => () => { midiRef.current.disconnect(); engineRef.current.stopMidiNotes() }, [])

  useEffect(() => {
    void projectRepository.listProjects().then(setProjects).catch(() => setToast({ tone: 'error', text: 'Não foi possível abrir os projetos locais.' }))
    void projectRepository.getStorageEstimate().then(setStorage)
  }, [])

  useEffect(() => {
    if (!desktopRuntime) return
    void Promise.all([scanDefaultVst3Directories(), ...(vst3Directory ? [scanVst3Directory(vst3Directory)] : [])]).then((results) => {
      const plugins = results.flatMap((result) => result.plugins)
      const errors = results.flatMap((result) => result.errors)
      setVst3Plugins((current) => mergeVst3Plugins(current, plugins))
      setVst3ScanErrors(errors)
    }).catch(() => undefined)
  }, [desktopRuntime, vst3Directory])

  useEffect(() => {
    const markUpdateReady = () => setUpdateReady(true)
    window.addEventListener(SERVICE_WORKER_UPDATE_EVENT, markUpdateReady)
    if (PWA_SERVICE_WORKER_AVAILABLE) {
      void navigator.serviceWorker.getRegistration().then((registration) => {
        if (registration?.waiting) markUpdateReady()
      })
    }
    return () => window.removeEventListener(SERVICE_WORKER_UPDATE_EVENT, markUpdateReady)
  }, [])

  useEffect(() => {
    if (!project) return
    const save = window.setTimeout(() => {
      void projectRepository.saveProject(project).then(() => projectRepository.listProjects().then(setProjects)).catch(() => setToast({ tone: 'error', text: 'O projeto ficou em memória: não foi possível confirmar o salvamento local.' }))
    }, 350)
    return () => window.clearTimeout(save)
  }, [project])

  useEffect(() => {
    if (!activeProjectId) return
    void projectRepository.listTakeDrafts(activeProjectId).then(setTakeDrafts).catch(() => setToast({ tone: 'error', text: 'Não foi possível verificar os rascunhos de gravação.' }))
  }, [activeProjectId])

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!project) return
      const frame = engineRef.current.getCurrentFrame(project.audioSampleRate)
      setPlayhead(frame)
      if (isPlaying && view === 'mixer') {
        setMixAutomationValues(Object.fromEntries(project.tracks.map((track) => [track.id, engineRef.current.automationControls(track, frame)])))
      }
      const input = engineRef.current.getInputMeter()
      setInputPeak(input?.peak)
      const draft = activeDraftRef.current
      if (isRecording && draft) {
        const primary = draft.secondary ? input?.channelPeaks[0] : input?.peak
        const secondary = draft.secondary?.trackId
        setRecordingPeaks((peaks) => ({
          [draft.trackId]: [...(peaks[draft.trackId] ?? []).slice(-119), primary ?? 0],
          ...(secondary ? { [secondary]: [...(peaks[secondary] ?? []).slice(-119), input?.channelPeaks[1] ?? 0] } : {}),
        }))
      }
      const next: Record<string, number> = {}
      const masterPeak = engineRef.current.getMasterMeter()?.peak
      if (masterPeak !== undefined) next.master = masterPeak
      for (const bus of project.auxBuses ?? []) {
        const peak = engineRef.current.getAuxMeter(bus.id)?.peak
        if (peak !== undefined) next[bus.id] = peak
      }
      project.tracks.forEach((track) => {
        const value = engineRef.current.getTrackMeter(track.id)?.peak
        if (value !== undefined) next[track.id] = value
      })
      if (isRecording && draft && input) {
        next[draft.trackId] = draft.secondary ? input.channelPeaks[0] : input.peak
        if (draft.secondary) next[draft.secondary.trackId] = input.channelPeaks[1]
      }
      setTrackPeaks(next)
      if (isPlaying || isRecording) {
        setHeldPeaks((previous) => {
          const sameProject = previous?.projectId === project.id
          const levels = sameProject ? previous.levels : {}
          const increases = Object.entries(next).filter(([channel, peak]) => peak > (levels[channel] ?? 0))
          if (sameProject && increases.length === 0) return previous
          return { projectId: project.id, levels: { ...levels, ...Object.fromEntries(increases) } }
        })
      }
    }, 80)
    return () => window.clearInterval(timer)
  }, [project, isRecording, isPlaying, view])

  function resetPeak(channel: string) {
    setHeldPeaks((previous) => {
      if (!previous || previous.projectId !== project?.id) return previous
      const levels = { ...previous.levels }
      delete levels[channel]
      return { projectId: previous.projectId, levels }
    })
  }

  function heldPeak(channel: string) {
    return heldPeaks?.projectId === project?.id ? heldPeaks?.levels[channel] : undefined
  }

  const updateProject = useCallback((change: (current: AudioProject) => AudioProject, recordHistory = true) => {
    setProject((current) => {
      if (!current) return current
      if (recordHistory) {
        setUndoStack((stack) => [...stack.slice(-29), current])
        setRedoStack([])
      }
      const next = { ...change(current), updatedAt: new Date().toISOString() }
      return next
    })
  }, [])

  const selectTimelineClip = useCallback((clip: Clip) => {
    if (isRecording) return
    setSelectedTrackId(clip.trackId)
    setSelectedClipId(clip.id)
  }, [isRecording])

  const editTimelineClip = useCallback((updated: Clip) => {
    updateProject((current) => ({ ...current, clips: current.clips.map((clip) => clip.id === updated.id ? updated : clip) }))
  }, [updateProject])

  function updateTrack(id: string, change: (track: Track) => Track) {
    updateProject((current) => ({ ...current, tracks: current.tracks.map((track) => track.id === id ? change(track) : track) }))
  }

  function mixAutomationValue(track: Track, lane: AutomationLane) {
    return isPlaying ? mixAutomationValues[track.id]?.[lane] ?? track[lane] : track[lane]
  }

  function moveMixControl(track: Track, lane: AutomationLane, value: number) {
    if (project && engineRef.current.moveAutomationControl(project, track.id, lane, value)) {
      setMixAutomationValues((values) => ({ ...values, [track.id]: { ...values[track.id], [lane]: value } }))
    } else updateTrack(track.id, (current) => ({ ...current, [lane]: value }))
  }

  function releaseMixControl(track: Track, lane: AutomationLane) {
    if (project) engineRef.current.releaseAutomationControl(project, track.id, lane)
  }

  function saveAutomationPass(automation: Map<string, TrackAutomation>, current: AudioProject): AudioProject {
    if (!automation.size) return current
    const apply = (active: AudioProject): AudioProject => active.id !== current.id ? active : ({
      ...active,
      updatedAt: new Date().toISOString(),
      tracks: active.tracks.map((track) => {
        const recorded = automation.get(track.id)
        return recorded ? { ...track, automation: recorded } : track
      }),
    })
    updateProject(apply)
    return apply(current)
  }

  async function leavePlayback(current: AudioProject) {
    const automation = engineRef.current.stop()
    setIsPlaying(false)
    const next = saveAutomationPass(automation, current)
    await projectRepository.saveProject(next)
    setProjects((items) => [next, ...items.filter((item) => item.id !== next.id)])
  }

  async function closeProject(current: AudioProject) {
    if (recordTransition.current) return
    recordTransition.current = true
    try {
      await leavePlayback(current)
      setProject(undefined)
      setView('tracks')
    } catch {
      setToast({ tone: 'error', text: 'Não foi possível salvar. A sessão continua aberta.' })
    } finally {
      recordTransition.current = false
    }
  }

  function updateSend(trackId: string, bus: 'reverb' | 'delay', level: number) {
    updateTrack(trackId, (track) => ({ ...track, sends: { reverb: 0, delay: 0, ...track.sends, [bus]: level } }))
  }

  function updateAux(id: string, change: (bus: AuxBus) => AuxBus) {
    updateProject((current) => ({ ...current, auxBuses: current.auxBuses?.map((bus) => bus.id === id ? change(bus) : bus) }))
  }

  function removeAux(id: string) {
    updateProject((current) => ({
      ...current,
      auxBuses: current.auxBuses?.filter((bus) => bus.id !== id),
      tracks: current.tracks.map((track) => ({
        ...track, outputBusId: track.outputBusId === id ? undefined : track.outputBusId,
        auxSends: track.auxSends?.filter((send) => send.busId !== id),
      })),
    }))
  }

  function openTrackPanel(trackId: string, panel: 'inserts' | 'sends') {
    setSelectedTrackId(trackId)
    setTrackPanel(panel)
  }

  async function scanVst3Plugins(directory: string) {
    setIsScanningVst3(true)
    try {
      const result = await scanVst3Directory(directory)
      setVst3Directory(directory)
      storeVst3Directory(directory)
      setVst3Plugins((current) => mergeVst3Plugins(current, result.plugins))
      setVst3ScanErrors(result.errors)
      setToast({ tone: result.errors.length ? 'info' : 'success', text: `${result.plugins.length} plug-in${result.plugins.length === 1 ? '' : 's'} VST3 encontrado${result.plugins.length === 1 ? '' : 's'} em scanner isolado.` })
    } catch (error) {
      setToast({ tone: 'error', text: error instanceof Error ? error.message : 'Não foi possível verificar os plug-ins VST3.' })
    } finally {
      setIsScanningVst3(false)
    }
  }

  async function chooseAndScanVst3Directory() {
    if (!desktopRuntime) {
      setToast({ tone: 'info', text: 'VST3 requer o Vale Studio Desktop para Windows; a versão web continua usando efeitos nativos.' })
      return
    }
    const directory = await chooseVst3Directory()
    if (directory) await scanVst3Plugins(directory)
  }

  function addVst3Insert(plugin: Vst3Plugin) {
    if (!desktopRuntime || !selectedTrack) {
      setToast({ tone: 'info', text: 'Selecione uma pista no Vale Studio Desktop para preparar um insert VST3.' })
      return
    }
    if (plugin.kind === 'instrument' && (selectedTrack.kind !== 'midi' || selectedTrack.vst3Inserts.some((insert) => insert.kind === 'instrument'))) {
      setToast({ tone: 'info', text: 'Escolha uma pista MIDI sem outro instrumento.' })
      return
    }
    if (selectedTrack.vst3Inserts.some((insert) => insert.bundlePath === plugin.bundlePath && insert.classId === plugin.classId)) {
      setToast({ tone: 'info', text: `${plugin.name} já está na cadeia de ${selectedTrack.name}.` })
      return
    }
    const insert: Vst3Insert = {
      id: makeId(),
      format: 'vst3',
      bundlePath: plugin.bundlePath,
      classId: plugin.classId,
      name: plugin.name,
      vendor: plugin.vendor,
      version: plugin.version,
      kind: plugin.kind,
      bypass: false,
      parameterValues: {},
    }
    updateTrack(selectedTrack.id, (track) => ({
      ...track,
      vst3Inserts: plugin.kind === 'instrument' ? [insert, ...track.vst3Inserts] : [...track.vst3Inserts, insert],
    }))
    setToast({ tone: 'success', text: `${plugin.name} inserido em ${selectedTrack.name}. Inicie a reprodução para carregar o plug-in.` })
  }

  async function probeVst3Insert(insert: Vst3Insert) {
    if (!desktopRuntime) return
    setVst3ProbeStates((states) => ({ ...states, [insert.id]: { status: 'checking', message: 'Abrindo componente em processo isolado…' } }))
    try {
      const result = await probeVst3Plugin(insert)
      const state: Vst3ProbeState = { status: result.compatible ? 'compatible' : 'incompatible', message: result.message }
      setVst3ProbeStates((states) => ({ ...states, [insert.id]: state }))
      setToast({ tone: result.compatible ? 'success' : 'error', text: `${insert.name}: ${result.message}` })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Não foi possível qualificar este plug-in VST3.'
      setVst3ProbeStates((states) => ({ ...states, [insert.id]: { status: 'incompatible', message } }))
      setToast({ tone: 'error', text: message })
    }
  }

  function toggleVst3Insert(trackId: string, insertId: string) {
    updateTrack(trackId, (track) => ({ ...track, vst3Inserts: track.vst3Inserts.map((insert) => insert.id === insertId ? { ...insert, bypass: !insert.bypass } : insert) }))
  }

  function removeVst3Insert(trackId: string, insertId: string) {
    updateTrack(trackId, (track) => ({ ...track, vst3Inserts: track.vst3Inserts.filter((insert) => insert.id !== insertId) }))
  }

  async function applyPendingUpdate() {
    if (isRecording) {
      setToast({ tone: 'info', text: 'Finalize a gravação antes de atualizar. O Vale Studio não troca a versão durante um take.' })
      return
    }
    try {
      if (project) {
        const automation = engineRef.current.stop()
        setIsPlaying(false)
        await projectRepository.saveProject(saveAutomationPass(automation, project))
      }
      const registration = await navigator.serviceWorker?.getRegistration()
      if (!registration?.waiting) {
        setUpdateReady(false)
        setToast({ tone: 'info', text: 'A nova versão já foi aplicada ou não está mais disponível.' })
        return
      }
      window.sessionStorage.setItem(SERVICE_WORKER_RELOAD_KEY, '1')
      registration.waiting.postMessage({ type: 'VALE_STUDIO_SKIP_WAITING' })
    } catch {
      setToast({ tone: 'error', text: 'Não foi possível confirmar o salvamento antes da atualização. Tente novamente.' })
    }
  }

  function undo() {
    if (isPlaying && project?.tracks.some((track) => isAutomationWriter(track.automation?.mode))) return
    setUndoStack((stack) => {
      const previous = stack.at(-1)
      if (!previous || !project) return stack
      setRedoStack((redo) => [...redo, project])
      setProject(previous)
      engineRef.current.updateMix(previous)
      return stack.slice(0, -1)
    })
  }

  function redo() {
    if (isPlaying && project?.tracks.some((track) => isAutomationWriter(track.automation?.mode))) return
    setRedoStack((stack) => {
      const next = stack.at(-1)
      if (!next || !project) return stack
      setUndoStack((undoItems) => [...undoItems, project])
      setProject(next)
      engineRef.current.updateMix(next)
      return stack.slice(0, -1)
    })
  }

  async function activateAudio(): Promise<AudioCapabilities | undefined> {
    try {
      const nextCapabilities = await engineRef.current.initFromUserGesture()
      setCapabilities(nextCapabilities)
      if (project) {
        for (const asset of project.assets) {
          if (engineRef.current.getCachedAsset(asset.id)) continue
          const blob = await projectRepository.loadAsset(asset.id)
          if (blob) await engineRef.current.decodeAsset(asset.id, blob)
        }
      }
      setToast({ tone: 'success', text: `Áudio ativo em ${nextCapabilities.sampleRate.toLocaleString('pt-BR')} Hz.` })
      return nextCapabilities
    } catch (error) {
      setToast({ tone: 'error', text: error instanceof Error ? error.message : 'Não foi possível ativar o motor de áudio.' })
      return undefined
    }
  }

  async function createNewProject(name: string, bpm: number, signature: TimeSignature) {
    const audio = await activateAudio()
    const next = createProject(name, audio?.sampleRate ?? 48000)
    next.bpm = bpm
    next.timeSignature = signature
    setProject(next)
    setSelectedTrackId(next.tracks[0].id)
    setSelectedClipId(undefined)
    setUndoStack([])
    setRedoStack([])
    setShowNewProject(false)
    setView('tracks')
  }

  async function openProject(id: string) {
    if (recordTransition.current) return
    recordTransition.current = true
    try {
      const next = await projectRepository.loadProject(id)
      if (!next) throw new Error('A sessão já não está no armazenamento local.')
      engineRef.current.stop()
      setIsPlaying(false)
      setIsRecording(false)
      setProject(next)
      setSelectedTrackId(next.tracks[0]?.id)
      setSelectedClipId(next.clips[0]?.id)
      setPlayhead(0)
      setUndoStack([])
      setRedoStack([])
      setView('tracks')
    } catch (error) {
      setToast({ tone: 'error', text: error instanceof Error ? error.message : 'Não foi possível abrir a sessão.' })
    } finally {
      recordTransition.current = false
    }
  }

  async function importAudio(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    if (!/^audio\/(wav|mpeg|mp3|x-wav|ogg|aac|mp4)/.test(file.type) && !/\.(wav|mp3|m4a|aac|ogg)$/i.test(file.name)) {
      setToast({ tone: 'error', text: 'Importe WAV, MP3 ou um formato que o navegador consiga decodificar.' })
      return
    }
    const audio = capabilities ?? await activateAudio()
    if (!audio) return
    try {
      const targetProject = project ?? createProject(file.name.replace(/\.[^.]+$/, '') || 'Projeto importado', audio.sampleRate)
      const assetId = makeId()
      const decoded = await engineRef.current.decodeAsset(assetId, file)
      const asset: MediaAsset = {
        id: assetId, name: file.name, mimeType: file.type || 'audio/unknown', sampleRate: decoded.sampleRate, channels: decoded.numberOfChannels,
        frames: decoded.length, durationFrames: Math.round(decoded.duration * targetProject.audioSampleRate), byteLength: file.size,
        peaks: buildPeaks(decoded), createdAt: new Date().toISOString(),
      }
      const color = TRACK_COLORS[targetProject.tracks.length % TRACK_COLORS.length]
      const track = createTrack(file.name.replace(/\.[^.]+$/, ''), color)
      const clip: Clip = { id: makeId(), assetId, trackId: track.id, timelineStartFrame: 0, sourceOffsetFrame: 0, durationFrames: asset.durationFrames, gainDb: 0, fadeInFrames: 0, fadeOutFrames: 0 }
      track.clipIds = [clip.id]
      await projectRepository.saveAsset(asset, file)
      const nextProject = { ...targetProject, tracks: [...targetProject.tracks, track], clips: [...targetProject.clips, clip], assets: [...targetProject.assets, asset] }
      if (project) updateProject(() => nextProject)
      else { setProject(nextProject); setView('tracks') }
      setSelectedTrackId(track.id)
      setSelectedClipId(clip.id)
      setToast({ tone: 'success', text: `${file.name} foi decodificado localmente e inserido como faixa.` })
    } catch {
      setToast({ tone: 'error', text: 'O navegador não conseguiu decodificar este áudio. O projeto não foi alterado.' })
    }
  }

  async function exportBackup() {
    if (!project) return
    try {
      setArchiving('export')
      const blob = await exportProjectArchive(project)
      const href = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = href
      anchor.download = `${project.name.replace(/[^a-z0-9_-]+/gi, '-').toLowerCase() || 'vale-studio'}${PROJECT_ARCHIVE_EXTENSION}`
      anchor.click()
      window.setTimeout(() => URL.revokeObjectURL(href), 5000)
      setToast({ tone: 'success', text: 'Backup .valestudio criado com o projeto e seus áudios locais.' })
    } catch (error) {
      setToast({ tone: 'error', text: error instanceof Error ? error.message : 'Não foi possível criar o backup local.' })
    } finally { setArchiving(undefined) }
  }

  async function importBackup(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    try {
      setArchiving('import')
      const restored = await restoreProjectArchive(file)
      await projectRepository.restoreProject(restored.project, restored.assets)
      if (project) await leavePlayback(project)
      setIsRecording(false)
      setProject(restored.project)
      setSelectedTrackId(restored.project.tracks[0]?.id)
      setSelectedClipId(restored.project.clips[0]?.id)
      setView('tracks')
      void projectRepository.listProjects().then(setProjects)
      setToast({ tone: 'success', text: `Backup restaurado como “${restored.project.name}”. A sessão original não foi alterada.` })
    } catch (error) {
      setToast({ tone: 'error', text: error instanceof Error ? error.message : 'Não foi possível restaurar este backup.' })
    } finally { setArchiving(undefined) }
  }

  function addTrack() {
    if (!project) return
    const track = createTrack(`Nova pista ${project.tracks.length + 1}`, TRACK_COLORS[project.tracks.length % TRACK_COLORS.length])
    updateProject((current) => ({ ...current, tracks: [...current.tracks, track] }))
    setSelectedTrackId(track.id)
  }

  function addMidiTrack() {
    if (!project) return
    const track = createMidiTrack(`Instrumento MIDI ${project.tracks.filter((item) => item.kind === 'midi').length + 1}`, TRACK_COLORS[project.tracks.length % TRACK_COLORS.length])
    updateProject((current) => ({ ...current, tracks: [...current.tracks, track] }))
    setSelectedTrackId(track.id)
    setToast({ tone: 'info', text: 'Pista MIDI criada. Conecte uma entrada MIDI e arme a pista para gravar notas.' })
  }

  function reorderTracks(sourceId: string, targetId: string) {
    if (sourceId === targetId) return
    updateProject((current) => {
      const sourceIndex = current.tracks.findIndex((track) => track.id === sourceId)
      const targetIndex = current.tracks.findIndex((track) => track.id === targetId)
      if (sourceIndex < 0 || targetIndex < 0) return current
      const tracks = [...current.tracks]
      const [source] = tracks.splice(sourceIndex, 1)
      tracks.splice(targetIndex, 0, source)
      return { ...current, tracks }
    })
  }

  function currentBeat(current: AudioProject): number {
    return engineRef.current.getCurrentFrame(current.audioSampleRate) / current.audioSampleRate * current.bpm / 60
  }

  function onMidiMessage(message: MidiMessage) {
    const current = projectRef.current
    const trackId = selectedTrackIdRef.current
    const track = current?.tracks.find((item) => item.id === trackId)
    if (!current || !track || track.kind !== 'midi') return
    if (message.type === 'noteon') {
      engineRef.current.playMidiNote(message.note, message.velocity, track.id)
      if (recordingRef.current && track.armed) {
        activeMidiNotesRef.current.set(message.note, { id: makeId(), note: message.note, velocity: message.velocity, startBeat: currentBeat(current) })
      }
      return
    }
    engineRef.current.stopMidiNote(message.note, track.id)
    const started = activeMidiNotesRef.current.get(message.note)
    if (!started) return
    activeMidiNotesRef.current.delete(message.note)
    const note: MidiNote = { ...started, durationBeats: Math.max(0.0625, currentBeat(current) - started.startBeat) }
    setProject((active) => !active ? active : { ...active, updatedAt: new Date().toISOString(), tracks: active.tracks.map((item) => item.id === track.id ? { ...item, midiNotes: [...(item.midiNotes ?? []), note] } : item) })
  }

  async function enableMidiInput() {
    const audio = capabilities ?? await activateAudio()
    if (!audio) return
    try {
      const devices = await midiRef.current.connect(midiInputId, onMidiMessage, setMidiDevices)
      const selected = devices.find((item) => item.id === midiInputId) ?? devices[0]
      setMidiInputId(selected?.id)
      setMidiReady(true)
      setToast({ tone: 'success', text: `${selected?.name ?? 'Entrada MIDI'} pronta. Toque uma nota para pré-ouvir ou grave na pista MIDI armada.` })
    } catch (error) {
      setMidiReady(false)
      setToast({ tone: 'error', text: error instanceof Error ? error.message : 'Não foi possível abrir a entrada MIDI.' })
    }
  }

  function finishMidiNotes() {
    const current = projectRef.current
    const trackId = selectedTrackIdRef.current
    if (!current || !trackId) return
    const unfinished = [...activeMidiNotesRef.current.values()]
    activeMidiNotesRef.current.clear()
    engineRef.current.stopMidiNotes()
    if (!unfinished.length) return
    const endBeat = currentBeat(current)
    setProject((active) => !active ? active : { ...active, updatedAt: new Date().toISOString(), tracks: active.tracks.map((track) => track.id === trackId ? { ...track, midiNotes: [...(track.midiNotes ?? []), ...unfinished.map((note) => ({ ...note, durationBeats: Math.max(0.0625, endBeat - note.startBeat) }))] } : track) })
  }

  async function startPlayback(current: AudioProject): Promise<boolean> {
    if (startingPlaybackRef.current) return false
    startingPlaybackRef.current = true
    setIsStarting(true)
    try {
      const started = await engineRef.current.play(current, (message) => setToast({ tone: 'error', text: message }))
      if (started) {
        const frame = engineRef.current.getCurrentFrame(current.audioSampleRate)
        setMixAutomationValues(Object.fromEntries(current.tracks.map((track) => [track.id, engineRef.current.automationControls(track, frame)])))
        setIsPlaying(true)
      }
      return started
    } catch (error) {
      setToast({ tone: 'error', text: error instanceof Error ? error.message : 'Falha ao iniciar a reprodução.' })
      return false
    } finally {
      startingPlaybackRef.current = false
      setIsStarting(false)
    }
  }

  async function togglePlayback() {
    if (asioBusy || asioRecording || recordTransition.current) { setToast({ tone: 'info', text: 'Encerre a captura ou o retorno antes de usar o transporte.' }); return }
    if (!project) return
    if (!capabilities && !await activateAudio()) return
    if (isPlaying) {
      if (activeDraftRef.current?.punch) {
        const loop = activeDraftRef.current.loop
        await toggleRecording()
        if (loop) return
      }
      saveAutomationPass(engineRef.current.pause(project.audioSampleRate), project)
      setIsPlaying(false)
    } else {
      await startPlayback(project)
    }
  }

  function toggleMetronome() {
    if (asioBusy || asioRecording || recordTransition.current) return
    if (!project || !capabilities) { void activateAudio(); return }
    if (isMetronome) {
      engineRef.current.stopMetronome()
      setIsMetronome(false)
    } else {
      engineRef.current.startMetronome(project.bpm, Number(project.timeSignature.split('/')[0]))
      setIsMetronome(true)
    }
  }

  async function toggleRecording(asio?: NativeCaptureSettings, dryReturn = false, twoTracks = false, punch?: PunchRange) {
    if (recordTransition.current) return
    recordTransition.current = true
    try {
      await changeRecording(asio, dryReturn, twoTracks, punch)
    } finally {
      recordTransition.current = false
    }
  }

  async function changeRecording(asio?: NativeCaptureSettings, dryReturn = false, twoTracks = false, punch?: PunchRange) {
    if (asioBusy) { setToast({ tone: 'info', text: 'Desligue o retorno ASIO antes de gravar pelo motor atual.' }); return }
    if (!project) return
    const recordingTrackId = isRecording ? activeDraftRef.current?.trackId : undefined
    const recordTrack = recordingTrackId ? project.tracks.find((track) => track.id === recordingTrackId) : selectedTrack
    if (!recordTrack) return
    if (recordTrack.kind === 'midi') {
      if (isRecording) {
        finishMidiNotes()
        setIsRecording(false)
        setToast({ tone: 'success', text: 'Gravação MIDI concluída. As notas ficaram salvas nesta pista.' })
        return
      }
      if (!recordTrack.armed) { setToast({ tone: 'error', text: 'Arme a pista MIDI antes de tocar em REC.' }); return }
      if (!midiReady) { await enableMidiInput(); return }
      if (!isPlaying && !await startPlayback(project)) return
      setIsRecording(true)
      setToast({ tone: 'info', text: 'Gravando MIDI. Toque no controlador; as notas aparecem na pista.' })
      return
    }
    if (isRecording) {
      const activeDraft = activeDraftRef.current
      let captured
      try {
        captured = await engineRef.current.stopRecording(Boolean(activeDraft?.secondary))
      } catch (error) {
        setToast({ tone: 'error', text: `${String(error)} Os checkpoints confirmados continuam em Projeto → Recuperação.` })
        void projectRepository.listTakeDrafts(project.id).then(setTakeDrafts)
        return
      } finally {
        if (activeDraft?.loop) {
          engineRef.current.pause(project.audioSampleRate)
          engineRef.current.updateMix(project)
          setIsPlaying(false)
        }
        setIsRecording(false)
        setAsioRecording(false)
        setPunchEnded(false)
        activeDraftRef.current = undefined
      }
      if (!captured || captured.frames < 128) {
        if (activeDraft) await projectRepository.discardTakeDraft(activeDraft.id).catch(() => undefined)
        if (activeDraft?.secondary) await projectRepository.discardTakeDraft(activeDraft.secondary.id).catch(() => undefined)
        for (const id of activeDraft?.loop?.ids.slice(1) ?? []) await projectRepository.discardTakeDraft(id).catch(() => undefined)
        const detail = activeDraft?.punch && punchInterrupted.current
        setToast({ tone: 'error', text: detail ? `${detail} Nenhum take foi confirmado.` : 'Nenhum frame de áudio foi confirmado. O take não foi salvo.' })
        return
      }
      if (!activeDraft) {
        setToast({ tone: 'error', text: 'A sessão de segurança do take foi perdida. O áudio não foi marcado como salvo.' })
        return
      }
      const range = activeDraft.punch
      const loop = activeDraft.loop
      const compPunch = Boolean(range && !loop)
      const interrupted = range && punchInterrupted.current
      const startFrame = range?.start ?? Math.max(0, engineRef.current.getRecordingStartFrame() + project.calibrationFrames)
      const recording = captured
      if (recording.wasapi) setWasapiStats(recording.wasapi)
      const targets = loop
        ? loopSlices(0, recording.frames, loop.framesPerPass, loop.ids.length).filter((slice) => slice.frameCount >= 128)
          .map((slice) => ({ id: loop.ids[slice.pass], trackId: activeDraft.trackId, slice }))
        : (activeDraft.secondary ? [activeDraft, activeDraft.secondary] : [activeDraft]).map((target) => ({ ...target, slice: undefined }))
      const lastFullPass = loop ? targets.reduce((last, target, index) => target.slice?.frameCount === loop.framesPerPass ? index : last, -1) : -1
      const selectedPass = lastFullPass >= 0 ? lastFullPass : targets.length - 1
      const entries = targets.map((target, index) => {
        let buffer = recording.buffers[activeDraft.secondary ? index : 0]
        if (target.slice) {
          const { offset, frameCount } = target.slice
          buffer = new AudioBuffer({ length: frameCount, numberOfChannels: recording.channels, sampleRate: recording.sampleRate })
          for (let channel = 0; channel < recording.channels; channel += 1) {
            buffer.getChannelData(channel).set(recording.buffers[0].getChannelData(channel).subarray(offset, offset + frameCount))
          }
        }
        const blob = encodeWav(buffer, 32)
        const assetId = makeId()
        const takeId = makeId()
        const asset: MediaAsset = {
          id: assetId, name: `Take ${project.takes.filter((take) => take.trackId === target.trackId).length + (loop ? index : 0) + 1}.wav`, mimeType: 'audio/wav',
          sampleRate: buffer.sampleRate, channels: buffer.numberOfChannels, frames: buffer.length,
          durationFrames: Math.round(buffer.length / buffer.sampleRate * project.audioSampleRate), byteLength: blob.size,
          peaks: buildPeaks(buffer), createdAt: new Date().toISOString(),
        }
        const clip: Clip = { id: makeId(), assetId, trackId: target.trackId, timelineStartFrame: startFrame, sourceOffsetFrame: 0, durationFrames: asset.durationFrames, gainDb: 0, fadeInFrames: 0, fadeOutFrames: 0, takeId }
        const take = { id: takeId, assetId, trackId: target.trackId, name: asset.name.replace('.wav', ''), startFrame, durationFrames: asset.durationFrames,
          createdAt: asset.createdAt, calibrationFrames: range ? 0 : project.calibrationFrames,
          selected: !compPunch && !interrupted && (!loop || index === selectedPass) }
        return { draftId: target.id, asset, blob, buffer, clip, take }
      })
      const byTrack = new Map<string, typeof entries>()
      for (const entry of entries) {
        const group = byTrack.get(entry.clip.trackId) ?? []
        group.push(entry)
        byTrack.set(entry.clip.trackId, group)
      }
      const replaceSelection = !compPunch && !interrupted
      let nextProject: AudioProject = {
        ...project,
        assets: [...project.assets, ...entries.map((entry) => entry.asset)],
        clips: [...project.clips, ...entries.map((entry) => entry.clip)],
        tracks: project.tracks.map((track) => {
          const group = byTrack.get(track.id)
          return group ? { ...track, compEnabled: replaceSelection ? false : track.compEnabled,
            clipIds: [...track.clipIds, ...group.map((entry) => entry.clip.id)], takeIds: [...track.takeIds, ...group.map((entry) => entry.take.id)] } : track
        }),
        takes: [...project.takes.map((take) => replaceSelection && byTrack.has(take.trackId) ? { ...take, selected: false } : take), ...entries.map((entry) => entry.take)],
        updatedAt: new Date().toISOString(),
      }
      try {
        if (range && compPunch && !interrupted) {
          const take = entries[0].take
          nextProject = applyCompRegion(nextProject, take, 0, Math.min(take.durationFrames, range.end - range.start), range.start, makeId)
        }
        await projectRepository.commitTakes(nextProject, entries)
        if (loop) {
          const saved = new Set(entries.map((entry) => entry.draftId))
          await Promise.all(loop.ids.filter((id) => !saved.has(id)).map((id) => projectRepository.discardTakeDraft(id).catch(() => undefined)))
        }
        entries.forEach((entry) => engineRef.current.cacheAsset(entry.asset.id, entry.buffer))
        setProject(nextProject)
        setSelectedClipId(compPunch && !interrupted ? nextProject.clips.at(-1)?.id : entries.at(-1)?.clip.id)
        setTakeDrafts((drafts) => drafts.filter((draft) => !entries.some((entry) => entry.draftId === draft.id)))
        void projectRepository.listProjects().then(setProjects)
        const durabilityNotice = captured.durability.error ? ' O take foi confirmado no commit final, mas houve falha em um checkpoint intermediário.' : ''
        const gapNotice = captured.wasapi?.captureMissingFrames
          ? ` O WASAPI preencheu ${captured.wasapi.captureMissingFrames.toLocaleString('pt-BR')} frames ausentes com silêncio.`
          : ''
        setToast(interrupted ? { tone: 'error', text: `${interrupted} O áudio disponível foi salvo em takes alternativos.` } :
          { tone: 'success', text: `${loop ? `${entries.length} takes do loop salvos` : compPunch ? 'Punch salvo no comp' : entries.length === 1 ? 'Take salvo' : 'Dois takes sincronizados salvos'} após ${captured.frames.toLocaleString('pt-BR')} frames confirmados.${durabilityNotice}${gapNotice}` })
      } catch (error) {
        setToast({ tone: 'error', text: `O commit final falhou; o rascunho persistido continua disponível para recuperação.${error instanceof Error ? ` ${error.message}` : ''}` })
      }
      return
    }
    if (!recordTrack.armed) { setToast({ tone: 'error', text: 'Arme a pista que receberá a gravação antes de tocar em REC.' }); return }
    const audio = capabilities ?? await activateAudio()
    if (!audio) return
    const draftId = makeId()
    const loopIds = punch?.passes ? [draftId, ...Array.from({ length: punch.passes - 1 }, makeId)] : undefined
    const paired = twoTracks && asio?.backend === 'wasapi' ? pairedMonoTrack(project, recordTrack) : undefined
    const secondary = paired ? { id: makeId(), trackId: paired.id } : undefined
    try {
      if (twoTracks && !secondary) throw new Error('Arme exatamente duas pistas de áudio mono para gravar os dois canais.')
      if (asio && (isPlaying || isStarting || isMetronome || previewingTakeId)) throw new Error('Pare a reprodução antes de iniciar a captura nativa.')
      if (asio && (!Number.isInteger(asio.sampleRate) || asio.sampleRate < 8000 || asio.sampleRate > 192000)) {
        throw new Error('A captura nativa exige uma taxa entre 8.000 e 192.000 Hz.')
      }
      const loopAudio = punch?.passes ? await engineRef.current.renderTakeLoop(project, punch.start, punch.end) : undefined
      const loop = loopAudio && loopIds ? { framesPerPass: loopAudio.length, ids: loopIds } : undefined
      if (punch) {
        const overlap = project.clips.some((clip) => clip.trackId === recordTrack.id && !clip.takeId && !clip.compSegment &&
          clip.timelineStartFrame < punch.end && clip.timelineStartFrame + clip.durationFrames > punch.start)
        if (overlap && !loop) throw new Error('O punch substitui trechos de takes. A região selecionada contém um clipe importado.')
        if (!engineRef.current.seek(loop ? punch.start : Math.max(0, punch.start - punch.preRoll))) throw new Error('Pare o transporte antes de iniciar a gravação por intervalo.')
        punchInterrupted.current = undefined
        setPunchEnded(false)
      } else if (!asio && !isPlaying && !await startPlayback(project)) return
      const channels = secondary ? 2 : recordTrack.recordChannels ?? 1
      const start = punch?.start ?? engineRef.current.getCurrentFrame(project.audioSampleRate)
      const output = asio?.backend === 'wasapi' ? asio.playback?.device : undefined
      if (asio?.backend === 'wasapi') setWasapiStats(undefined)
      if (output && dryReturn && output.sampleRate !== asio?.sampleRate) throw new Error('Para ouvir a entrada, use a mesma taxa de amostragem nos dois dispositivos WASAPI.')
      if (output) setToast({ tone: 'info', text: 'Preparando a base para a gravação WASAPI…' })
      const backing = output ? await engineRef.current.renderWasapiBacking(project, start, output.sampleRate) : undefined
      const sampleRate = asio?.sampleRate ?? audio.sampleRate
      await projectRepository.beginTakeDraft({ id: draftId, projectId: project.id, trackId: recordTrack.id, timelineStartFrame: start, positionIsFinal: punch ? true : undefined, sampleRate, channels: secondary ? 1 : channels })
      if (secondary) await projectRepository.beginTakeDraft({ ...secondary, projectId: project.id, timelineStartFrame: start, sampleRate, channels: 1 })
      for (const id of loop?.ids.slice(1) ?? []) await projectRepository.beginTakeDraft({
        id, projectId: project.id, trackId: recordTrack.id, timelineStartFrame: start, positionIsFinal: true, sampleRate, channels,
      })
      activeDraftRef.current = { id: draftId, projectId: project.id, trackId: recordTrack.id, secondary, punch, loop }
      const loopSequences = loop?.ids.map(() => 0)
      const persistChunk = async (chunk: RecordingPcmChunk) => {
        if (loop && loopSequences) {
          const pcm = new Float32Array(chunk.pcm)
          const slices = loopSlices(chunk.firstFrame, chunk.frameCount, loop.framesPerPass, loop.ids.length)
          await projectRepository.appendTakeDraftChunks(slices.map(({ pass, offset, firstFrame, frameCount }) => ({
            ...chunk, draftId: loop.ids[pass], sequence: loopSequences[pass], firstFrame, frameCount,
            pcm: pcm.slice(offset * channels, (offset + frameCount) * channels).buffer,
          })))
          for (const slice of slices) loopSequences[slice.pass] += 1
          return
        }
        if (secondary) {
          const pcm = new Float32Array(chunk.pcm)
          await projectRepository.appendTakeDraftChunks([draftId, secondary.id].map((id, channel) => {
            const mono = new Float32Array(chunk.frameCount)
            for (let frame = 0; frame < mono.length; frame += 1) mono[frame] = pcm[frame * 2 + channel]
            return { ...chunk, draftId: id, channels: 1, pcm: mono.buffer }
          }))
          return
        }
        await projectRepository.appendTakeDraftChunk({ ...chunk, draftId })
      }
      const recording = asio
        ? await engineRef.current.startAsioRecording(recordTrack.id, project.audioSampleRate, asio, dryReturn, channels, persistChunk,
          (reason) => setToast({ tone: 'error', text: `${reason} Encerre a gravação para recuperar os trechos confirmados.` }), backing)
        : await engineRef.current.startRecording(recordTrack.id, project, recordTrack.monitorMode, channels, persistChunk, punch && {
          ...punch, onEnd: (failed, reason) => {
            punchInterrupted.current = failed ? reason ?? 'A gravação foi interrompida.' : undefined
            setPunchEnded(true)
          },
          loop: loopAudio && punch.passes ? { audio: loopAudio, passes: punch.passes } : undefined,
        })
      if (punch && !await startPlayback(project)) throw new Error('Não foi possível iniciar a reprodução para o punch.')
      if (!asio && !punch) await projectRepository.updateTakeDraftStart(draftId, recording.startFrame)
      setRecordFrom(recording.startFrame)
      setRecordingPeaks({ [recordTrack.id]: [0], ...(secondary ? { [secondary.trackId]: [0] } : {}) })
      setIsRecording(true)
      setAsioRecording(Boolean(asio))
      const agc = recording.inputSettings?.autoGainControl
      const bufferInfo = recording.bufferFrames ? ` · buffer de ${recording.bufferFrames} frames` : ''
      setToast({ tone: 'info', text: loop ? 'Gravando em loop sobre a mixagem preparada.' : punch ? 'Punch programado. A reprodução começou no pré-roll.' : asio ? `Capturando pelo ${asio.backend === 'wasapi' ? 'WASAPI Shared' : 'ASIO4ALL'}${output ? ' com a base' : ''} · período de ${recording.periodFrames} frames${bufferInfo}.` : agc ? 'Capturando: o sistema informou controle automático de ganho.' : 'Capturando PCM seco com checkpoints locais.' })
    } catch (error) {
      if (engineRef.current.isRecording) await engineRef.current.stopRecording().catch(() => undefined)
      activeDraftRef.current = undefined
      await projectRepository.discardTakeDraft(draftId).catch(() => undefined)
      if (secondary) await projectRepository.discardTakeDraft(secondary.id).catch(() => undefined)
      for (const id of loopIds?.slice(1) ?? []) await projectRepository.discardTakeDraft(id).catch(() => undefined)
      setToast({ tone: 'error', text: error instanceof Error ? error.message : 'Não foi possível iniciar a gravação.' })
    }
  }

  async function recoverTakeDraft(draft: TakeDraft) {
    if (!project) return
    const track = project.tracks.find((item) => item.id === draft.trackId)
    if (!track) { setToast({ tone: 'error', text: 'A pista original deste rascunho não existe mais. Crie ou restaure a pista antes de recuperar o take.' }); return }
    const audio = capabilities ?? await activateAudio()
    if (!audio) return
    try {
      const recovered = await projectRepository.recoverTakeDraft(draft.id)
      if (!recovered || recovered.pcm.length / recovered.channels < 128) { setToast({ tone: 'error', text: 'Este rascunho não contém frames suficientes para recuperar um take.' }); return }
      const buffer = engineRef.current.createBufferFromPcm(recovered.pcm, recovered.sampleRate, recovered.channels)
      const assetId = makeId()
      const takeId = makeId()
      const takeBlob = encodeWav(buffer, 32)
      const asset: MediaAsset = {
        id: assetId, name: `Take recuperado ${project.takes.filter((take) => take.trackId === track.id).length + 1}.wav`, mimeType: 'audio/wav', sampleRate: buffer.sampleRate, channels: buffer.numberOfChannels,
        frames: recovered.pcm.length / recovered.channels, durationFrames: Math.round(buffer.duration * project.audioSampleRate), byteLength: takeBlob.size,
        peaks: buildPeaks(buffer), createdAt: new Date().toISOString(),
      }
      const startFrame = Math.max(0, recovered.timelineStartFrame + (draft.positionIsFinal ? 0 : project.calibrationFrames))
      const clip: Clip = { id: makeId(), assetId, trackId: track.id, timelineStartFrame: startFrame, sourceOffsetFrame: 0, durationFrames: asset.durationFrames, gainDb: 0, fadeInFrames: 0, fadeOutFrames: 0, takeId }
      const nextProject: AudioProject = {
        ...project,
        assets: [...project.assets, asset], clips: [...project.clips, clip],
        tracks: project.tracks.map((item) => item.id === track.id ? { ...item, compEnabled: false, clipIds: [...item.clipIds, clip.id], takeIds: [...item.takeIds, takeId] } : item),
        takes: [...project.takes.map((take) => take.trackId === track.id ? { ...take, selected: false } : take), { id: takeId, assetId, trackId: track.id, name: asset.name.replace('.wav', ''), startFrame, durationFrames: asset.durationFrames, createdAt: asset.createdAt, calibrationFrames: project.calibrationFrames, selected: true }],
        updatedAt: new Date().toISOString(),
      }
      await projectRepository.commitTake(nextProject, asset, takeBlob, draft.id)
      engineRef.current.cacheAsset(assetId, buffer)
      setProject(nextProject)
      setSelectedTrackId(track.id)
      setSelectedClipId(clip.id)
      setTakeDrafts((drafts) => drafts.filter((item) => item.id !== draft.id))
      void projectRepository.listProjects().then(setProjects)
      setToast({ tone: 'success', text: `Take recuperado com ${recovered.persistedChunks} checkpoints locais confirmados.` })
    } catch (error) {
      setToast({ tone: 'error', text: error instanceof Error ? error.message : 'Não foi possível recuperar este take.' })
    }
  }

  async function discardTakeDraft(draft: TakeDraft) {
    if (!window.confirm('Descartar este rascunho de gravação? Os trechos PCM locais serão removidos.')) return
    try {
      await projectRepository.discardTakeDraft(draft.id)
      setTakeDrafts((drafts) => drafts.filter((item) => item.id !== draft.id))
      setToast({ tone: 'info', text: 'Rascunho de gravação descartado localmente.' })
    } catch {
      setToast({ tone: 'error', text: 'Não foi possível descartar este rascunho.' })
    }
  }

  function selectTake(takeId: string) {
    if (!project) return
    const take = project.takes.find((item) => item.id === takeId)
    if (!take) return
    updateProject((current) => ({
      ...current,
      tracks: current.tracks.map((track) => track.id === take.trackId ? { ...track, compEnabled: false } : track),
      takes: current.takes.map((item) => item.trackId === take.trackId ? { ...item, selected: item.id === takeId } : item),
    }))
    setSelectedTrackId(take.trackId)
    setSelectedClipId(undefined)
    setToast({ tone: 'success', text: `${take.name} será usado na prévia e na próxima renderização.` })
  }

  async function previewTake(takeId: string) {
    if (asioBusy || asioRecording || recordTransition.current) return
    if (!project) return
    const take = project.takes.find((item) => item.id === takeId)
    if (!take) return
    const audio = capabilities ?? await activateAudio()
    if (!audio) return
    const started = engineRef.current.previewAsset(take.assetId, () => setPreviewingTakeId(undefined))
    if (!started) { setToast({ tone: 'error', text: 'Este take ainda não está disponível no motor de áudio.' }); return }
    setPreviewingTakeId(take.id)
  }

  function cycleMonitor(track: Track) {
    const order: MonitorMode[] = ['off', 'software', 'direct']
    const next = order[(order.indexOf(track.monitorMode) + 1) % order.length]
    updateTrack(track.id, (current) => ({ ...current, monitorMode: next }))
    if (track.id === selectedTrack?.id) engineRef.current.setMonitorMode(next)
  }

  async function exportMix(format: 'wav' | 'mp3') {
    if (!project) return
    const audio = capabilities ?? await activateAudio()
    if (!audio) return
    try {
      setExporting(format)
      const blob = await engineRef.current.exportMix(project, format)
      const href = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = href
      anchor.download = `${project.name.replace(/[^a-z0-9_-]+/gi, '-').toLowerCase() || 'vale-studio-mix'}.${format}`
      anchor.click()
      window.setTimeout(() => URL.revokeObjectURL(href), 5000)
      setToast({ tone: 'success', text: `${format.toUpperCase()} criado a partir da renderização local do projeto.` })
    } catch (error) {
      setToast({ tone: 'error', text: error instanceof Error ? error.message : `Não foi possível gerar ${format.toUpperCase()}.` })
    } finally { setExporting(undefined) }
  }

  async function exportStems() {
    if (!project) return
    const audio = capabilities ?? await activateAudio()
    if (!audio) return
    try {
      setExporting('stems')
      const stems = await engineRef.current.exportStems(project)
      if (stems.length === 0) throw new Error('Não há pistas com áudio para exportar em stems.')
      const projectFileName = safeFilePart(project.name, 'vale-studio')
      const archive = await createZip(stems.map((stem, index) => ({
        name: `${projectFileName}--${String(index + 1).padStart(2, '0')}-${safeFilePart(stem.trackName, 'pista')}.wav`,
        blob: stem.blob,
      })))
      const href = URL.createObjectURL(archive)
      const anchor = document.createElement('a')
      anchor.href = href
      anchor.download = `${projectFileName}-stems.zip`
      anchor.click()
      window.setTimeout(() => URL.revokeObjectURL(href), 5000)
      setToast({ tone: 'success', text: `${stems.length} stem${stems.length === 1 ? '' : 's'} WAV consolidado${stems.length === 1 ? '' : 's'} desde 00:00 foram incluídos no ZIP.` })
    } catch (error) {
      setToast({ tone: 'error', text: error instanceof Error ? error.message : 'Não foi possível gerar os stems.' })
    } finally { setExporting(undefined) }
  }

  function updateClip(action: 'moveLeft' | 'moveRight' | 'duplicate' | 'split' | 'fadeIn' | 'fadeOut' | 'crossfade' | 'remove') {
    if (!project || !selectedClip || isPlaying || isRecording) return
    if (action === 'crossfade') {
      const current = project.clips.filter((clip) => clip.trackId === selectedClip.trackId
        && clipIsAudible(project, clip))
        .sort((left, right) => left.timelineStartFrame - right.timelineStartFrame)
      const index = current.findIndex((clip) => clip.id === selectedClip.id)
      const pair = [[current[index], current[index + 1]], [current[index - 1], current[index]]].find(([left, right]) => {
        if (!left || !right) return false
        const overlap = left.timelineStartFrame + left.durationFrames - right.timelineStartFrame
        return overlap > 0 && overlap <= Math.min(left.durationFrames - left.fadeInFrames, right.durationFrames - right.fadeOutFrames)
      })
      if (!pair) {
        setToast({ tone: 'info', text: 'Sobreponha dois clipes consecutivos na mesma pista para criar o crossfade.' })
        return
      }
      const [left, right] = pair
      const overlap = left.timelineStartFrame + left.durationFrames - right.timelineStartFrame
      updateProject((project) => ({ ...project, clips: project.clips.map((clip) => {
        if (clip.id === left.id) return { ...clip, fadeOutFrames: overlap }
        if (clip.id === right.id) return { ...clip, fadeInFrames: overlap }
        return clip
      }) }))
      return
    }
    const beat = Math.round(project.audioSampleRate * 60 / project.bpm)
    if (action === 'remove') {
      updateProject((current) => ({ ...current, clips: current.clips.filter((clip) => clip.id !== selectedClip.id), tracks: current.tracks.map((track) => ({ ...track, clipIds: track.clipIds.filter((id) => id !== selectedClip.id) })) }))
      setSelectedClipId(undefined)
      return
    }
    if (action === 'duplicate') {
      const copy: Clip = { ...selectedClip, id: makeId(), timelineStartFrame: selectedClip.timelineStartFrame + beat }
      updateProject((current) => ({ ...current, clips: [...current.clips, copy], tracks: current.tracks.map((track) => track.id === copy.trackId ? { ...track, clipIds: [...track.clipIds, copy.id] } : track) }))
      setSelectedClipId(copy.id)
      return
    }
    if (action === 'split') {
      const splitAt = playhead - selectedClip.timelineStartFrame
      if (splitAt < 128 || selectedClip.durationFrames - splitAt < 128) {
        setToast({ tone: 'info', text: 'Posicione o cursor dentro do clipe pela régua para dividir.' })
        return
      }
      const first: Clip = { ...selectedClip, id: makeId(), durationFrames: splitAt, fadeInFrames: Math.min(selectedClip.fadeInFrames, splitAt), fadeOutFrames: 0 }
      const secondLength = selectedClip.durationFrames - splitAt
      const second: Clip = {
        ...selectedClip, id: makeId(), sourceOffsetFrame: selectedClip.sourceOffsetFrame + splitAt,
        timelineStartFrame: playhead, durationFrames: secondLength, fadeInFrames: 0,
        fadeOutFrames: Math.min(selectedClip.fadeOutFrames, secondLength),
      }
      updateProject((current) => ({ ...current, clips: [...current.clips.filter((clip) => clip.id !== selectedClip.id), first, second], tracks: current.tracks.map((track) => track.id === selectedClip.trackId ? { ...track, clipIds: [...track.clipIds.filter((id) => id !== selectedClip.id), first.id, second.id] } : track) }))
      setSelectedClipId(first.id)
      return
    }
    if (action === 'fadeIn' || action === 'fadeOut') {
      const fadeFrames = Math.min(Math.floor(selectedClip.durationFrames / 2), Math.round(project.audioSampleRate * 0.25))
      const field = action === 'fadeIn' ? 'fadeInFrames' : 'fadeOutFrames'
      updateProject((current) => ({ ...current, clips: current.clips.map((clip) => clip.id !== selectedClip.id ? clip : { ...clip, [field]: clip[field] > 0 ? 0 : fadeFrames }) }))
      return
    }
    const delta = action === 'moveLeft' ? -beat : beat
    updateProject((current) => ({ ...current, clips: current.clips.map((clip) => clip.id === selectedClip.id ? { ...clip, timelineStartFrame: Math.max(0, clip.timelineStartFrame + delta) } : clip) }))
  }

  useEffect(() => {
    if (fadeFocusRequest) firstFadeInput.current?.focus()
  }, [fadeFocusRequest])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const element = event.target as HTMLElement
      if (element.closest('input, select, textarea, [contenteditable="true"], dialog') || !project || event.repeat) return
      const key = event.key.toLowerCase()
      if (event.ctrlKey || event.metaKey) {
        const canEdit = !isPlaying && !isRecording && !isStarting && !recordTransition.current
        if (key === 'n' && event.shiftKey && canEdit) {
          event.preventDefault()
          newTrackDialog.current?.showModal()
          return
        }
        if (key === 'f' && selectedClip && canEdit) {
          event.preventDefault()
          setView('tracks')
          setFadeFocusRequest((request) => request + 1)
          return
        }
        if (!['z', 'y', 's', 'e', '=', ' '].includes(key)) return
        event.preventDefault()
        if (key === 'z') undo()
        if (key === 'y') redo()
        if (key === '=') setView((current) => current === 'mixer' ? 'tracks' : 'mixer')
        if (key === 'e' && !isPlaying && !isRecording) updateClip('split')
        if (key === ' ') void toggleRecording()
        if (key === 's') void projectRepository.saveProject(project).then(
          () => setToast({ tone: 'success', text: 'Sessão salva.' }),
          () => setToast({ tone: 'error', text: 'Não foi possível salvar a sessão.' }),
        )
        return
      }
      if (key === 'f12') { event.preventDefault(); void toggleRecording(); return }
      if (event.code === 'Space' && !element.closest('button')) { event.preventDefault(); void togglePlayback() }
      if (key === 'm' && selectedTrack) updateTrack(selectedTrack.id, (track) => ({ ...track, mute: !track.mute }))
      if (key === 's' && selectedTrack) updateTrack(selectedTrack.id, (track) => ({ ...track, solo: !track.solo }))
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  })

  if (!project) return <main className="app-shell home-shell">
    <header className="home-header"><Logo /><button className="icon-button" type="button" aria-label="Ajuda">?</button></header>
    <section className="hero"><div className="eyebrow">ESTÚDIO MULTIPISTA LOCAL</div><h1>Grave. Crie.<br /><span>Misture.</span></h1><p>Seu estúdio multipista em qualquer lugar, sem conta e sem enviar seu áudio para a nuvem.</p><div className="hero-line" /></section>
    <section className="home-actions"><button className="button primary large" onClick={() => setShowNewProject(true)}><b>＋</b><span>Novo projeto<small>Comece uma nova ideia</small></span></button><button className="button secondary large" onClick={() => fileInputRef.current?.click()}><b>↥</b><span>Importar áudio<small>WAV, MP3 ou formato compatível</small></span></button><button className="button secondary large archive-action" onClick={() => archiveInputRef.current?.click()} disabled={archiving === 'import'}><b>⇩</b><span>{archiving === 'import' ? 'Restaurando backup…' : 'Restaurar backup'}<small>Abra uma cópia independente em .valestudio</small></span></button></section>
    <input ref={fileInputRef} className="sr-only" type="file" accept="audio/*,.wav,.mp3,.m4a,.aac,.ogg" onChange={importAudio} />
    <input ref={archiveInputRef} className="sr-only" type="file" accept={`${PROJECT_ARCHIVE_MIME},${PROJECT_ARCHIVE_EXTENSION},application/json`} onChange={importBackup} />
    <section className="recent-projects"><div className="section-title"><h2>Projetos recentes</h2><span>{projects.length} local{projects.length === 1 ? '' : 'is'}</span></div>{projects.length === 0 ? <div className="empty-state"><span>◇</span><p>Nenhum projeto salvo ainda.</p><small>Crie um projeto para começar a gravar.</small></div> : projects.map((item) => <button className="project-card" key={item.id} onClick={() => void openProject(item.id)}><span className="project-orb">V</span><span><strong>{item.name}</strong><small>{dateLabel(item.updatedAt)} · {item.tracks.length} pista{item.tracks.length === 1 ? '' : 's'} · {item.assets.length} áudio{item.assets.length === 1 ? '' : 's'}</small></span><i>›</i></button>)}</section>
    <footer className="home-footer"><span className="status-dot" />Dados locais · {storage?.quota ? `${Math.round((storage.usage ?? 0) / 1024 / 1024)} MB usados` : 'armazenamento será verificado no dispositivo'}</footer>
    {showNewProject && <NewProjectDialog onCreate={createNewProject} onCancel={() => setShowNewProject(false)} />}{toast && <div className={`toast ${toast.tone}`}>{toast.text}</div>}
  </main>

  const visibleEnd = isRecording ? Math.max(contentEnd, playhead) : contentEnd
  const pageFrames = project.audioSampleRate * 16
  const timelineFrames = Math.max(pageFrames, Math.ceil((visibleEnd + project.audioSampleRate) / pageFrames) * pageFrames)
  const playheadPosition = `${Math.min(100, playhead / timelineFrames * 100)}%`
  const bufferFrames = project.vstBufferFrames ?? DEFAULT_VST_BUFFER_FRAMES
  const canEditTimeline = !isRecording && !isPlaying && !isStarting
  const beatFrames = project.audioSampleRate * 60 / project.bpm
  const [meterBeats, meterUnit] = project.timeSignature.split('/').map(Number)
  const measuredBarFrames = beatFrames * meterBeats * 4 / meterUnit
  const barFrames = Number.isFinite(measuredBarFrames) && measuredBarFrames > 0 ? measuredBarFrames : project.audioSampleRate * 2
  const barStep = Math.max(1, Math.ceil(timelineFrames / barFrames / (timelineZoom * 12)))
  const gridFrames = gridDivision === 'bar' ? barFrames : beatFrames / (gridDivision === 'half' ? 2 : gridDivision === 'quarter' ? 4 : 1)
  const visibleGridFrames = gridFrames * Math.max(1, Math.ceil(timelineFrames / gridFrames / (timelineZoom * 96)))

  function seekTimeline(frame: number) {
    if (!canEditTimeline) return
    const target = Math.max(0, Math.min(timelineFrames, Math.round(frame)))
    if (engineRef.current.seek(target)) setPlayhead(target)
  }

  return <main className="app-shell studio-shell">
    <header className="studio-header">
      <div className="studio-transport-row">
        <div className="studio-project">
          <button type="button" className="transport-button project-home" aria-label="Voltar aos projetos" title="Voltar aos projetos"
            disabled={isRecording || asioBusy} onClick={() => void closeProject(project)}>V</button>
          <div className="project-name">
            <strong title={project.name}>{project.name}</strong>
            <span className={isRecording ? 'recording' : takeDrafts.length ? 'recovery-status' : undefined}>
              {isRecording ? 'CAPTURANDO' : takeDrafts.length ? 'RECUPERAÇÃO PENDENTE' : 'SALVO LOCAL'}
            </span>
          </div>
        </div>
        <section className="transport" aria-label="Transporte">
          <div className="transport-buttons">
            <button type="button" className="transport-button" disabled={isRecording || asioBusy} title="Voltar ao início" aria-label="Voltar ao início"
              onClick={() => { if (recordTransition.current) return; saveAutomationPass(engineRef.current.stop(), project); setIsPlaying(false); setPlayhead(0) }}>⏮</button>
            <button type="button" className="transport-button" disabled={!canEditTimeline || asioBusy} title="Retroceder 5 segundos" aria-label="Retroceder 5 segundos"
              onClick={() => seekTimeline(playhead - project.audioSampleRate * 5)}>⏪</button>
            <button type="button" className={`transport-button play ${isPlaying ? 'active' : ''}`} onClick={togglePlayback}
              disabled={asioBusy || (isRecording && asioRecording)} title={isPlaying ? 'Pausar' : 'Tocar'} aria-label={isPlaying ? 'Pausar' : 'Tocar'}>{isPlaying ? 'Ⅱ' : '▶'}</button>
            <button type="button" className="transport-button" disabled={!canEditTimeline || asioBusy} title="Avançar 5 segundos" aria-label="Avançar 5 segundos"
              onClick={() => seekTimeline(playhead + project.audioSampleRate * 5)}>⏩</button>
            <button type="button" className={`record-button ${isRecording ? 'active' : ''}`} onClick={() => void toggleRecording()}
              disabled={asioBusy || !selectedTrack} title={isRecording ? 'Salvar take' : 'Gravar na pista armada'}
              aria-label={isRecording ? 'Parar e salvar take' : 'Gravar na pista armada'}><span /></button>
          </div>
          <div className="clock" aria-label="Posição do transporte"><b>{formatTransportTime(playhead, project.audioSampleRate)}</b></div>
        </section>
      </div>
      <div className="studio-nav-row">
        <nav className="studio-tabs" aria-label="Navegação do estúdio">
          {([{ id: 'tracks', label: 'Pistas' }, { id: 'mixer', label: 'Mixer' }, { id: 'effects', label: 'Efeitos' }, { id: 'takes', label: 'Takes' }, { id: 'project', label: 'Projeto' }] as const).map((item) =>
            <button key={item.id} type="button" aria-current={view === item.id ? 'page' : undefined} onClick={() => setView(item.id)}>{item.label}</button>)}
        </nav>
        <div className="studio-menu-buttons">
          <button type="button" popoverTarget="studio-recording">Gravação <span aria-hidden="true">▾</span></button>
          <button type="button" popoverTarget="studio-settings">Configurações <span aria-hidden="true">▾</span></button>
        </div>
      </div>
    </header>
    <section className="studio-popover" id="studio-recording" popover="auto" aria-label="Gravação">
      <header className="studio-popover-header">
        <h2>Gravação</h2>
        <button type="button" className="icon-button" popoverTarget="studio-recording" popoverTargetAction="hide" aria-label="Fechar gravação">×</button>
      </header>
      <details className="punch-controls" open>
        <summary>Entrada da pista</summary>
        <div className="recording-desk">
          <div className="recording-desk-title">
            <h3>{selectedTrack?.name ?? 'Selecione uma pista'}</h3>
            <span>{selectedTrack?.armed ? 'Pista armada' : 'Pista desarmada'}</span>
          </div>
          {selectedTrack?.kind !== 'midi' && <div className="recording-input"><span>Nível de entrada</span><meter min={0} max={1} value={Math.min(1, inputPeak ?? 0)} aria-label="Nível de entrada" /></div>}
          <div className="recording-controls">
            {selectedTrack && selectedTrack.kind !== 'midi' && <AudioInputSelect value={selectedTrack.inputDeviceId} disabled={isRecording || asioBusy}
              onChange={(inputDeviceId) => updateTrack(selectedTrack.id, (track) => ({ ...track, inputDeviceId }))} />}
            {selectedTrack && selectedTrack.kind !== 'midi' && <label>Formato de entrada <select value={selectedTrack.recordChannels ?? 1} disabled={isRecording || asioBusy} onChange={(event) => {
              const recordChannels = event.target.value === '2' ? 2 : 1
              updateTrack(selectedTrack.id, (current) => ({ ...current, recordChannels }))
            }}>
              <option value={1}>Mono</option><option value={2}>Estéreo</option>
            </select></label>}
            {selectedTrack?.kind === 'midi' && <button className="button secondary" onClick={() => void enableMidiInput()}>{midiReady ? 'MIDI conectado' : 'Conectar MIDI'}</button>}
            {selectedTrack && <button className="button secondary" disabled={isRecording} aria-pressed={selectedTrack.armed} onClick={() => updateTrack(selectedTrack.id, (current) => ({ ...current, armed: !current.armed }))}>{selectedTrack.armed ? 'Desarmar' : 'Armar pista'}</button>}
          </div>
        </div>
      </details>
      {selectedTrack && selectedTrack.kind !== 'midi' && <details className="punch-controls">
        <summary>Punch e gravação em loop</summary>
        <form onSubmit={(event) => {
          event.preventDefault()
          if (!canEditTimeline || asioBusy || isMetronome || !selectedTrack.armed) return
          const fields = new FormData(event.currentTarget)
          const frame = (name: string) => Math.round(Number(fields.get(name)) * project.audioSampleRate)
          const start = frame('start')
          const end = frame('end')
          const preRoll = frame('preRoll')
          const looping = (event.nativeEvent as SubmitEvent).submitter?.getAttribute('value') === 'loop'
          const passes = looping ? Number(fields.get('passes')) : undefined
          if (![start, end, preRoll].every(Number.isSafeInteger) || start < 0 || end - start < project.audioSampleRate / 50 ||
              end > timelineFrames || preRoll < 0 || preRoll > project.audioSampleRate * 30) {
            setToast({ tone: 'error', text: 'Selecione um intervalo de pelo menos 20 ms dentro da linha do tempo.' })
            return
          }
          if (passes !== undefined && (!Number.isInteger(passes) || passes < 2 || passes > 8 || (end - start) * passes > project.audioSampleRate * 300)) {
            setToast({ tone: 'error', text: 'Escolha de 2 a 8 passagens com até 5 minutos de gravação no total.' })
            return
          }
          void toggleRecording(undefined, false, false, { start, end, preRoll, passes })
        }}>
          <fieldset disabled={!canEditTimeline || asioBusy || isMetronome}>
            <label>Início (s) <input name="start" type="number" min={0} max={timelineFrames / project.audioSampleRate} step="any" defaultValue={0} required /></label>
            <label>Fim (s) <input name="end" type="number" min={0} max={timelineFrames / project.audioSampleRate} step="any" defaultValue={2} required /></label>
            <label>Pré-roll do punch (s) <input name="preRoll" type="number" min={0} max={30} step="any" defaultValue={1} required /></label>
            <label>Passagens no loop <input name="passes" type="number" min={2} max={8} step={1} defaultValue={3} required /></label>
            <button type="submit" className="button record-action" disabled={!selectedTrack.armed}>Gravar punch</button>
            <button type="submit" value="loop" className="button secondary" title="Repete a mixagem do intervalo e salva um take por passagem" disabled={!selectedTrack.armed}>Gravar loop</button>
          </fieldset>
        </form>
      </details>}
      {desktopRuntime && <AsioMonitorControls
        key={project.id}
        armedTrackId={selectedTrack?.armed && selectedTrack.kind !== 'midi' ? selectedTrack.id : undefined}
        channels={selectedTrack?.recordChannels ?? 1}
        blocked={isPlaying || isStarting || isRecording || isMetronome || Boolean(previewingTakeId)}
        setBusy={setAsioBusy}
        onRecord={toggleRecording}
      />}
      {desktopRuntime && <WasapiCaptureControls
        armed={Boolean(selectedTrack?.armed && selectedTrack.kind !== 'midi')}
        blocked={isPlaying || isStarting || isRecording || isMetronome || asioBusy || Boolean(previewingTakeId)}
        channels={selectedTrack?.recordChannels ?? 1}
        otherTrack={pairedMonoTrack(project, selectedTrack)?.name}
        stats={wasapiStats}
        onRecord={(settings, twoTracks, dryReturn) => toggleRecording(settings, dryReturn, twoTracks)}
        prepareMix={async () => {
          if (!capabilities && !await activateAudio()) throw new Error('Ative o áudio antes de preparar a mixagem.')
          return engineRef.current.renderMix(project)
        }}
        setAudioBusy={setAsioBusy}
      />}
    </section>
    <section className="studio-popover" id="studio-settings" popover="auto" aria-label="Configurações">
      <header className="studio-popover-header">
        <h2>Configurações</h2>
        <button type="button" className="icon-button" popoverTarget="studio-settings" popoverTargetAction="hide" aria-label="Fechar configurações">×</button>
      </header>
      <div className="studio-settings-grid">
        <button className="button secondary" onClick={() => void activateAudio()}>{capabilities ? `${capabilities.sampleRate / 1000} kHz` : 'Ativar áudio'}</button>
        <button type="button" className="button secondary" onClick={toggleMetronome} aria-pressed={isMetronome}>Metrônomo</button>
        <label>Tempo (BPM)
          <input type="number" min={40} max={240} value={project.bpm} disabled={!canEditTimeline} onChange={(event) => {
            const bpm = event.target.valueAsNumber
            if (Number.isFinite(bpm)) updateProject((current) => ({ ...current, bpm: Math.max(40, Math.min(240, bpm)) }))
          }} />
        </label>
{desktopRuntime && <label className="transport-buffer">Buffer VST3
      <select aria-label="Buffer VST3 em frames" value={bufferFrames} disabled={isPlaying || isRecording || isStarting} onChange={(event) => {
        const value = Number(event.target.value) as NonNullable<AudioProject['vstBufferFrames']>
        updateProject((current) => ({ ...current, vstBufferFrames: value }))
      }}>
        {([256, 512, 1024, 2048, 4096] as const).map((frames) => <option key={frames} value={frames}>{frames} frames</option>)}
      </select>
      <small title="Atraso estimado de um insert, sem contar o dispositivo">~{Math.round(bufferFrames * 3000 / (capabilities?.sampleRate ?? project.audioSampleRate))} ms por insert</small>
    </label>}
        {updateReady && <button className="button secondary" onClick={() => void applyPendingUpdate()} disabled={isRecording}>Salvar e atualizar</button>}
      </div>
    </section>

    {view === 'tracks' && <section className="track-area">
      <div className="timeline-tools">
        <div className="track-area-actions"><button className="button secondary" onClick={addTrack}>＋ Áudio</button><button className="button secondary" onClick={addMidiTrack}>＋ MIDI</button><button className="button secondary" onClick={() => fileInputRef.current?.click()}>↥ Importar</button></div>
        <div className="timeline-zoom">
          <label>Régua <select aria-label="Unidade da régua" value={rulerMode} onChange={(event) => setRulerMode(event.target.value === 'bars' ? 'bars' : 'time')}>
            <option value="time">Minutos e segundos</option><option value="bars">Compassos</option>
          </select></label>
          <label>Compasso <select aria-label="Fórmula de compasso" value={project.timeSignature} disabled={!canEditTimeline} onChange={(event) => {
            const value = event.target.value as TimeSignature
            updateProject((current) => ({ ...current, timeSignature: value }))
          }}>
            {(['2/4', '3/4', '4/4', '6/8', '12/8'] as const).map((signature) => <option key={signature}>{signature}</option>)}
          </select></label>
          <Toggle pressed={snapToBeat} label="Grade" onClick={() => setSnapToBeat(!snapToBeat)} />
          {snapToBeat && <select aria-label="Divisão da grade" value={gridDivision} onChange={(event) => setGridDivision(event.target.value)}>
            <option value="bar">Compasso</option><option value="beat">Semínima</option><option value="half">Colcheia</option><option value="quarter">Semicolcheia</option>
          </select>}
          <label>Ferramenta <select aria-label="Ferramenta de clipe" value={clipTool} onChange={(event) => {
            const tool = event.target.value
            setClipTool(tool === 'trim' || tool === 'pencil' ? tool : 'move')
          }}>
            <option value="move">Mover</option><option value="trim">Trim</option><option value="pencil">Lápis MIDI</option>
          </select></label>
          <label>Zoom <select aria-label="Zoom horizontal da timeline" value={timelineZoom} onChange={(event) => setTimelineZoom(Number(event.target.value))}>
            <option value={1}>1×</option><option value={2}>2×</option><option value={4}>4×</option><option value={8}>8×</option>
          </select></label>
        </div>
      </div>
      <div className="timeline-viewport">
      <div className="timeline-grid" style={{
        '--timeline-zoom': timelineZoom,
        '--major-grid': `${rulerMode === 'bars' || snapToBeat ? barFrames * barStep / timelineFrames * 100 : 25 / timelineZoom}%`,
        '--minor-grid': `${rulerMode === 'bars' || snapToBeat ? visibleGridFrames / timelineFrames * 100 : 6.25 / timelineZoom}%`,
      } as React.CSSProperties}>
      <div className="ruler">
        <button type="button" className="ruler-seek" aria-label="Posicionar cursor na régua de tempo" disabled={!canEditTimeline}
          onClick={(event) => {
            if (event.detail === 0) { seekTimeline(0); return }
            const bounds = event.currentTarget.getBoundingClientRect()
            seekTimeline((event.clientX - bounds.left) / bounds.width * timelineFrames)
          }}
          onKeyDown={(event) => {
            if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
            event.preventDefault()
            seekTimeline(playhead + (event.key === 'ArrowRight' ? beatFrames : -beatFrames))
          }} />
        {rulerMode === 'bars' ? Array.from({ length: Math.floor(timelineFrames / (barFrames * barStep)) + 1 }, (_, index) => {
          const bar = index * barStep
          return <span key={bar} style={{ left: `${bar * barFrames / timelineFrames * 100}%` }}>{bar + 1}</span>
        }) : Array.from({ length: timelineZoom * 4 + 1 }, (_, division) => {
          const fraction = division / (timelineZoom * 4)
          const label = formatDuration(timelineFrames * fraction, project.audioSampleRate)
          return <span key={division} style={{ left: `${fraction * 100}%` }}>{label.replace(/\.0$/, '')}</span>
        })}
      </div>
      <div className="marker-lane">
        {(project.markers ?? []).map((marker) => <button type="button" key={marker.id} disabled={!canEditTimeline}
          title={marker.name} style={{ left: `${marker.frame / timelineFrames * 100}%` }} onClick={() => seekTimeline(marker.frame)}>{marker.name}</button>)}
      </div>
      {project.tracks.map((track, index) => <article key={track.id} data-track-id={track.id}
        className={`track-row ${selectedTrack?.id === track.id ? 'selected' : ''} ${draggedTrackId === track.id ? 'dragging' : ''} ${dropTrackId === track.id && draggedTrackId !== track.id ? 'track-drop-target' : ''}`}
        style={{ '--track-color': track.color } as React.CSSProperties}
        onClick={() => { if (!isRecording) setSelectedTrackId(track.id) }}>
        <div className="track-head">
          <button type="button" className="track-handle" style={{ color: track.color }} disabled={!canEditTimeline}
            aria-label={`Reordenar ${track.name}`} title="Arraste para reordenar ou use as setas ↑ ↓"
            onPointerDown={(event) => {
              if (!event.isPrimary || event.button !== 0) return
              event.currentTarget.setPointerCapture(event.pointerId)
              setDraggedTrackId(track.id)
            }}
            onPointerMove={(event) => {
              if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
              setDropTrackId(document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-track-id]')?.dataset.trackId)
            }}
            onPointerUp={(event) => {
              if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
              const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-track-id]')?.dataset.trackId
              if (target && canEditTimeline) reorderTracks(track.id, target)
              setDraggedTrackId(undefined)
              setDropTrackId(undefined)
            }}
            onLostPointerCapture={() => { setDraggedTrackId(undefined); setDropTrackId(undefined) }}
            onKeyDown={(event) => {
              if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
              event.preventDefault()
              const target = project.tracks[index + (event.key === 'ArrowUp' ? -1 : 1)]
              if (target) reorderTracks(track.id, target.id)
            }}>⠿</button>
          <div><strong>{track.name}</strong><small>{track.kind === 'midi' ? 'Instrumento MIDI' : track.recordChannels === 2 ? 'Entrada estéreo' : 'Entrada mono'}</small></div>
          <TrackMeter value={isRecording ? recordingPeaks[track.id]?.at(-1) ?? trackPeaks[track.id] : trackPeaks[track.id]} />
          <div className="track-toggles">
            <Toggle pressed={track.armed} label="R" title="Armar pista" danger disabled={isRecording} onClick={() => updateTrack(track.id, (current) => ({ ...current, armed: !current.armed }))} />
            <Toggle pressed={track.mute} label="M" onClick={() => updateTrack(track.id, (current) => ({ ...current, mute: !current.mute }))} />
            <Toggle pressed={track.solo} label="S" onClick={() => updateTrack(track.id, (current) => ({ ...current, solo: !current.solo }))} />
            {track.kind !== 'midi' && <Toggle pressed={track.monitorMode !== 'off'} label="I" title={`Monitoramento · ${track.monitorMode === 'software' ? 'Software' : track.monitorMode === 'direct' ? 'Direto' : 'Desligado'}`} onClick={() => cycleMonitor(track)} />}
          </div>
          <div className="track-routing">
            <button className="tiny-toggle" aria-label="Inserts" title={track.vst3Inserts[0]?.name ?? 'Inserts da pista'} disabled={isRecording} onClick={() => openTrackPanel(track.id, 'inserts')}>{track.vst3Inserts[0]?.name ?? 'Inserts'}</button>
            <button className="tiny-toggle" disabled={isRecording} onClick={() => openTrackPanel(track.id, 'sends')}>Sends</button>
          </div>
        </div>
        <div className="clip-lane">
          {track.kind === 'midi' && <MidiRoll notes={track.midiNotes ?? []} color={track.color} framesPerBeat={project.audioSampleRate * 60 / project.bpm} timelineFrames={timelineFrames}
            pencil={clipTool === 'pencil' && canEditTimeline} onDraw={(position, note) => {
              const step = snapToBeat ? gridFrames / beatFrames : 1 / 960
              const startBeat = Math.round(position * timelineFrames / beatFrames / step) * step
              const drawn = { id: makeId(), note, startBeat, durationBeats: 0.25, velocity: 100 }
              setSelectedTrackId(track.id)
              updateTrack(track.id, (current) => ({ ...current, midiNotes: [...(current.midiNotes ?? []), drawn] }))
            }} />}
          {isRecording && playhead >= recordFrom && recordingPeaks[track.id] && <div className="audio-clip live-wave" style={{ left: `${recordFrom / timelineFrames * 100}%`, width: `${Math.max(0, playhead - recordFrom) / timelineFrames * 100}%`, '--clip-color': track.color } as React.CSSProperties}>
            <Waveform peaks={recordingPeaks[track.id]} color={track.color} /><small>Capturando ao vivo</small>
          </div>}
          {visibleClipsByTrack.get(track.id)?.map((clip) => <TimelineClip key={clip.id} clip={clip} asset={activeAssetById.get(clip.assetId)}
            color={track.color} timelineFrames={timelineFrames} snapFrames={snapToBeat ? gridFrames : undefined} tool={clipTool === 'trim' ? 'trim' : 'move'} selected={selectedClipId === clip.id} editable={canEditTimeline && clipTool !== 'pencil'}
            onSelect={selectTimelineClip} onEdit={editTimelineClip} />)}
        </div>
      </article>)}
      <div className="playhead-overlay" aria-hidden="true"><i className="lane-playhead" style={{ left: playheadPosition }} /></div>
      </div></div>
      <form className="marker-form" onSubmit={(event) => {
        event.preventDefault()
        if (!canEditTimeline) return
        const form = event.currentTarget
        const name = String(new FormData(form).get('name') ?? '').trim()
        if (!name) return
        updateProject((current) => ({ ...current, markers: [...(current.markers ?? []), { id: makeId(), frame: playhead, name }] }))
        form.reset()
      }}>
        <input name="name" maxLength={40} required aria-label="Nome do marcador" placeholder="Nome do marcador" />
        <button className="button secondary" disabled={!canEditTimeline}>＋ Marcador no cursor</button>
        {project.markers?.some((marker) => marker.frame === playhead) && <button type="button" className="button secondary" disabled={!canEditTimeline}
          onClick={() => updateProject((current) => ({ ...current, markers: current.markers?.filter((marker) => marker.frame !== playhead) }))}>Remover marcadores no cursor</button>}
      </form>
      {selectedTrack?.kind === 'midi' && <MidiEditor key={selectedTrack.id} notes={selectedTrack.midiNotes ?? []}
        cursorBeat={playhead * project.bpm / (60 * project.audioSampleRate)} disabled={!canEditTimeline}
        onChange={(midiNotes) => updateTrack(selectedTrack.id, (track) => ({ ...track, midiNotes }))} />}
      {selectedTrack && <details className="track-automation">
        <summary>Automação da pista</summary>
        <AutomationEditor key={selectedTrack.id} automation={selectedTrack.automation} defaults={selectedTrack}
          playhead={playhead} frames={timelineFrames} rate={project.audioSampleRate} disabled={!canEditTimeline}
          onChange={(automation) => updateTrack(selectedTrack.id, (track) => ({ ...track, automation }))} />
      </details>}
      {selectedClip && <div className="edit-sheet"><span>Clipe selecionado</span><button onClick={() => updateClip('split')}>Dividir</button><button onClick={() => updateClip('moveLeft')}>← Mover</button><button onClick={() => updateClip('moveRight')}>Mover →</button><button onClick={() => updateClip('duplicate')}>Duplicar</button><button disabled={!canEditTimeline} onClick={() => updateClip('crossfade')}>Crossfade</button>
        <label className="fade-control">Ganho do clipe (dB)
          <input type="number" min={-60} max={12} step={0.5} value={selectedClip.gainDb} disabled={!canEditTimeline} onChange={(event) => {
            const gain = Math.max(-60, Math.min(12, Number(event.target.value)))
            updateProject((current) => ({ ...current, clips: current.clips.map((clip) => clip.id === selectedClip.id ? { ...clip, gainDb: gain } : clip) }))
          }} />
        </label>{(['fadeInFrames', 'fadeOutFrames'] as const).map((field) => {
          const other = field === 'fadeInFrames' ? selectedClip.fadeOutFrames : selectedClip.fadeInFrames
          const maxFrames = Math.max(0, selectedClip.durationFrames - other)
          return <label className="fade-control" key={field}>
          {field === 'fadeInFrames' ? 'Entrada (ms)' : 'Saída (ms)'}
          <input ref={field === 'fadeInFrames' ? firstFadeInput : undefined} type="number" min={0} max={Math.round(maxFrames / project.audioSampleRate * 1000)} disabled={!canEditTimeline} value={Math.round(selectedClip[field] / project.audioSampleRate * 1000)} onChange={(event) => {
            const frames = Math.round(Number(event.target.value) * project.audioSampleRate / 1000)
            const value = Math.max(0, Math.min(maxFrames, frames))
            updateProject((current) => ({ ...current, clips: current.clips.map((clip) => clip.id === selectedClip.id ? { ...clip, [field]: value } : clip) }))
          }} />
        </label>})}<button className={selectedClip.fadeInFrames ? 'active-edit' : ''} onClick={() => updateClip('fadeIn')}>Fade In</button><button className={selectedClip.fadeOutFrames ? 'active-edit' : ''} onClick={() => updateClip('fadeOut')}>Fade Out</button><button className="destructive" onClick={() => updateClip('remove')}>Excluir</button></div>}</section>}

    {view === 'mixer' && <section className="mixer-view"><div className="view-intro"><div><h2>Mixer</h2></div><button className="button secondary" onClick={() => void exportMix('wav')} disabled={Boolean(exporting)}>{exporting === 'wav' ? 'Renderizando…' : 'Exportar WAV'}</button></div><div className="mixer-strip-scroll">{project.tracks.map((track) => <article className={`channel-strip ${selectedTrack?.id === track.id ? 'selected' : ''}`} key={track.id} onClick={() => setSelectedTrackId(track.id)}><span className="track-color" style={{ background: track.color }} /><strong>{track.name}</strong><div className="mixer-routing">
      <button className="button secondary" disabled={isRecording} onClick={() => openTrackPanel(track.id, 'inserts')}>{track.vst3Inserts[0]?.name ?? '＋ Insert VST3'}</button>
      <button className="button secondary" disabled={isRecording} onClick={() => openTrackPanel(track.id, 'sends')}>Sends</button>
    </div><div className="strip-settings"><AutomationModeSelect mode={track.automation?.mode} disabled={!canEditTimeline} label="Automação" onChange={(mode) => updateTrack(track.id, (item) => ({ ...item, automation: { ...item.automation, mode } }))} /><label>Cor da pista<input className="track-color-input" type="color" value={track.color} onChange={(event) => updateTrack(track.id, (current) => ({ ...current, color: event.target.value }))} /></label></div><div className="fader-bank"><FaderScale /><MixAutomationControl track={track} lane="gainDb" playing={isPlaying} value={mixAutomationValue(track, 'gainDb')} onValue={(value) => moveMixControl(track, 'gainDb', value)} onRelease={() => releaseMixControl(track, 'gainDb')} /><TrackMeter value={trackPeaks[track.id]} /></div><output>{dbLabel(mixAutomationValue(track, 'gainDb'))}</output><label>Pan<MixAutomationControl track={track} lane="pan" playing={isPlaying} value={mixAutomationValue(track, 'pan')} onValue={(value) => moveMixControl(track, 'pan', value)} onRelease={() => releaseMixControl(track, 'pan')} /></label>
        <PeakHold value={heldPeak(track.id)} onReset={() => resetPeak(track.id)} />
        <div className="channel-sends" aria-label={`Sends de ${track.name}`}>
          <small>SENDS</small>
          {(['reverb', 'delay'] as const).map((bus) => <RangeControl key={bus} label={bus === 'reverb' ? 'Reverb' : 'Delay'} value={Math.round((track.sends?.[bus] ?? 0) * 100)} min={0} max={100} suffix="%" onChange={(value) => updateTrack(track.id, (current) => ({ ...current, sends: { reverb: 0, delay: 0, ...current.sends, [bus]: value / 100 } }))} />)}
        </div><div className="strip-toggles">
          <Toggle pressed={track.armed} label="R" title="Armar pista" danger disabled={isRecording} onClick={() => updateTrack(track.id, (item) => ({ ...item, armed: !item.armed }))} />
          {track.kind !== 'midi' && <Toggle pressed={track.monitorMode !== 'off'} label="I" title="Monitoramento de entrada" onClick={() => cycleMonitor(track)} />}
          <Toggle pressed={track.mute} label="M" onClick={() => updateTrack(track.id, (item) => ({ ...item, mute: !item.mute }))} />
          <Toggle pressed={track.solo} label="S" onClick={() => updateTrack(track.id, (item) => ({ ...item, solo: !item.solo }))} />
        </div></article>)}
        {(project.auxBuses ?? []).map((bus) => <article className="channel-strip aux-strip" key={bus.id}>
          <strong>Auxiliar</strong>
          <label>Nome <input aria-label={`Nome de ${bus.name}`} maxLength={40} value={bus.name} onChange={(event) => {
            const name = event.target.value
            updateAux(bus.id, (item) => ({ ...item, name }))
          }} /></label>
          <div className="fader-bank"><FaderScale />
            <input aria-label={`Volume de ${bus.name}`} className="fader" type="range" min="-60" max="6" step="0.5" value={bus.gainDb}
              onChange={(event) => { const gainDb = Number(event.target.value); updateAux(bus.id, (item) => ({ ...item, gainDb })) }} />
            <TrackMeter value={trackPeaks[bus.id]} />
          </div>
          <output>{dbLabel(bus.gainDb)}</output>
          <PeakHold value={heldPeak(bus.id)} onReset={() => resetPeak(bus.id)} />
          <Toggle pressed={bus.mute} label="M" onClick={() => updateAux(bus.id, (item) => ({ ...item, mute: !item.mute }))} />
          <button className="button secondary" type="button" disabled={!canEditTimeline} onClick={() => removeAux(bus.id)}>Remover auxiliar</button>
        </article>)}
        <article className="channel-strip master-strip">
          <strong>Master</strong>
          <div className="fader-bank"><FaderScale />
          <input aria-label="Volume master" className="fader" type="range" min="-60" max="6" step="0.5" value={project.masterGainDb ?? 0} onChange={(event) => {
            const value = Number(event.target.value)
            updateProject((current) => ({ ...current, masterGainDb: value }), false)
          }} /><TrackMeter value={trackPeaks.master} /></div>
          <output>{dbLabel(project.masterGainDb ?? 0)}</output>
          <PeakHold value={heldPeak('master')} onReset={() => resetPeak('master')} />
          <button className="button secondary" type="button" disabled={!canEditTimeline || (project.auxBuses?.length ?? 0) >= 32} onClick={() => {
            const id = makeId()
            updateProject((current) => ({ ...current, auxBuses: [...(current.auxBuses ?? []), { id, name: `Auxiliar ${(current.auxBuses?.length ?? 0) + 1}`, gainDb: 0, mute: false }] }))
          }}>＋ Auxiliar</button>
        </article>
      </div></section>}

    {view === 'effects' && selectedTrack && <section className="effects-view"><div className="view-intro"><div><span className="eyebrow">EFEITOS REAIS</span><h2>{selectedTrack.name}</h2><p>Os controles abaixo alteram o grafo de áudio quando a faixa é reproduzida ou exportada.</p></div><select value={selectedTrack.id} onChange={(event) => setSelectedTrackId(event.target.value)}>{project.tracks.map((track) => <option key={track.id} value={track.id}>{track.name}</option>)}</select></div><div className="effects-grid"><TrackEqualizer effects={selectedTrack.effects} onChange={(eq) => updateTrack(selectedTrack.id, (track) => ({ ...track, effects: { ...track.effects, eq } }))} /><EffectCard title="Filtro de graves" active={selectedTrack.effects.highPassEnabled} onToggle={() => updateTrack(selectedTrack.id, (track) => ({ ...track, effects: { ...track.effects, highPassEnabled: !track.effects.highPassEnabled } }))}><RangeControl label="Frequência" value={selectedTrack.effects.highPassHz} min={20} max={500} suffix=" Hz" onChange={(value) => updateTrack(selectedTrack.id, (track) => ({ ...track, effects: { ...track.effects, highPassHz: value } }))} /></EffectCard><EffectCard title="Compressor" active={selectedTrack.effects.compressorEnabled} onToggle={() => updateTrack(selectedTrack.id, (track) => ({ ...track, effects: { ...track.effects, compressorEnabled: !track.effects.compressorEnabled } }))}><RangeControl label="Threshold" value={selectedTrack.effects.threshold} min={-60} max={0} suffix=" dB" onChange={(value) => updateTrack(selectedTrack.id, (track) => ({ ...track, effects: { ...track.effects, threshold: value } }))} /><RangeControl label="Ratio" value={selectedTrack.effects.ratio} min={1} max={12} step={0.5} suffix=":1" onChange={(value) => updateTrack(selectedTrack.id, (track) => ({ ...track, effects: { ...track.effects, ratio: value } }))} /></EffectCard><EffectCard title="Reverb" active={selectedTrack.effects.reverbEnabled} onToggle={() => updateTrack(selectedTrack.id, (track) => ({ ...track, effects: { ...track.effects, reverbEnabled: !track.effects.reverbEnabled } }))}><RangeControl label="Mix" value={selectedTrack.effects.reverbMix * 100} min={0} max={70} suffix=" %" onChange={(value) => updateTrack(selectedTrack.id, (track) => ({ ...track, effects: { ...track.effects, reverbMix: value / 100 } }))} /></EffectCard><EffectCard title="Delay" active={selectedTrack.effects.delayEnabled} onToggle={() => updateTrack(selectedTrack.id, (track) => ({ ...track, effects: { ...track.effects, delayEnabled: !track.effects.delayEnabled } }))}><RangeControl label="Tempo" value={selectedTrack.effects.delayTime * 1000} min={40} max={1200} suffix=" ms" onChange={(value) => updateTrack(selectedTrack.id, (track) => ({ ...track, effects: { ...track.effects, delayTime: value / 1000 } }))} /><RangeControl label="Mix" value={selectedTrack.effects.delayMix * 100} min={0} max={70} suffix=" %" onChange={(value) => updateTrack(selectedTrack.id, (track) => ({ ...track, effects: { ...track.effects, delayMix: value / 100 } }))} /></EffectCard></div></section>}

    {view === 'takes' && <section className="takes-view"><div className="view-intro"><div><span className="eyebrow">GERENCIAMENTO DE TAKES</span><h2>{selectedTrack?.name ?? 'Selecione uma pista'}</h2><p>Escolha um take inteiro ou monte um comp com trechos de diferentes gravações.</p></div><select value={selectedTrack?.id ?? ''} onChange={(event) => setSelectedTrackId(event.target.value)}>{project.tracks.map((track) => <option key={track.id} value={track.id}>{track.name}</option>)}</select></div>{selectedTrack && project.clips.some((clip) => clip.trackId === selectedTrack.id && clip.compSegment) && <button type="button" className="button secondary" disabled={!canEditTimeline} aria-pressed={Boolean(selectedTrack.compEnabled)} onClick={() => { setSelectedClipId(undefined); updateTrack(selectedTrack.id, (track) => ({ ...track, compEnabled: !track.compEnabled })) }}>{selectedTrack.compEnabled ? 'Ouvir take inteiro' : 'Ativar comp'}</button>}{selectedTrack && project.takes.filter((take) => take.trackId === selectedTrack.id).length === 0 ? <div className="empty-state"><span>◇</span><p>Nenhum take nesta pista.</p><small>Arme a pista e grave para criar versões recuperáveis.</small></div> : <div className="take-list">{project.takes.filter((take) => take.trackId === selectedTrack?.id).map((take, index) => { const asset = activeAssetById.get(take.assetId); return <article key={take.id} className={`take-card ${take.selected ? 'selected' : ''}`}><div className="take-wave"><Waveform peaks={asset?.peaks ?? [0]} color={selectedTrack?.color ?? '#1eaeff'} /></div><div className="take-copy"><small>TAKE {String(index + 1).padStart(2, '0')} · {take.selected ? 'ATIVO' : 'ALTERNATIVO'}</small><strong>{take.name}</strong><span>{formatDuration(take.durationFrames, project.audioSampleRate)} · início {formatDuration(take.startFrame, project.audioSampleRate)}</span></div><div className="take-actions"><button className="button secondary" onClick={() => void previewTake(take.id)}>{previewingTakeId === take.id ? 'Ouvindo…' : 'Ouvir'}</button><button className={`button ${take.selected ? 'selected-take' : 'primary'}`} disabled={!canEditTimeline} onClick={() => selectTake(take.id)}>{take.selected && !selectedTrack?.compEnabled ? 'Em uso' : 'Usar take'}</button><details className="comp-region"><summary>Usar trecho no comp</summary><form onSubmit={(event) => {
      event.preventDefault()
      if (!canEditTimeline) return
      const fields = new FormData(event.currentTarget)
      const frame = (name: string) => Math.round(Number(fields.get(name)) * project.audioSampleRate)
      try {
        const comp = applyCompRegion(project, take, frame('from'), frame('until'), frame('destination'), makeId)
        updateProject(() => comp)
        setSelectedClipId(comp.clips.at(-1)?.id)
        setView('tracks')
      } catch (error) {
        setToast({ tone: 'error', text: error instanceof Error ? error.message : 'Não foi possível montar o comp.' })
      }
    }}><fieldset disabled={!canEditTimeline}>
      <label>Início no take (s) <input type="number" name="from" min={0} step="any" defaultValue={0} required /></label>
      <label>Fim no take (s) <input type="number" name="until" min={0} step="any" defaultValue={take.durationFrames / project.audioSampleRate} required /></label>
      <label>Posição na sessão (s) <input type="number" name="destination" min={0} step="any" defaultValue={take.startFrame / project.audioSampleRate} required /></label>
      <button className="button secondary" type="submit">Inserir no comp</button>
    </fieldset></form></details></div></article> })}</div>}</section>}

    {view === 'project' && <section className="project-view"><div className="view-intro"><div><span className="eyebrow">PROJETO LOCAL</span><h2>Estado e compatibilidade</h2><p>Esta sessão não envia áudio para servidores. O salvamento é local ao navegador.</p></div></div><div className="diagnostic-grid"><article><small>MOTOR DE ÁUDIO</small><strong>{capabilities ? 'Ativo após gesto' : 'Aguardando ativação'}</strong><p>{capabilities ? `${capabilities.sampleRate.toLocaleString('pt-BR')} Hz efetivos · AudioWorklet ${capabilities.audioWorklet ? 'disponível' : 'indisponível'}` : 'Toque em “Ativar áudio” antes de importar, tocar, gravar ou exportar.'}</p></article><article><small>ARMAZENAMENTO</small><strong>{storage?.persistent ? 'Persistente concedido' : 'Local do navegador'}</strong><p>{storage?.quota ? `${Math.round((storage.usage ?? 0) / 1024 / 1024)} MB usados de aproximadamente ${Math.round(storage.quota / 1024 / 1024)} MB.` : 'A cota será consultada no dispositivo.'}</p><button className="link-button" onClick={() => void projectRepository.requestPersistentStorage().then(() => projectRepository.getStorageEstimate()).then(setStorage)}>Solicitar persistência</button></article><article><small>MONITORAMENTO</small><strong>{selectedTrack?.monitorMode === 'software' ? 'Software ativado' : selectedTrack?.monitorMode === 'direct' ? 'Direto selecionado' : 'Sem retorno'}</strong><p>“Sincronia” ajusta a posição do take. Não elimina a latência física ao ouvir a própria voz.</p></article><article><small>ATUALIZAÇÃO</small><strong>{updateReady ? isRecording ? 'Pronta após o take' : 'Nova versão pronta' : 'Sem atualização pendente'}</strong><p>{updateReady ? 'O projeto é salvo e a nova versão só assume quando você confirmar.' : 'Nenhuma sessão em andamento é substituída automaticamente.'}</p>{updateReady && <button className="link-button" onClick={() => void applyPendingUpdate()} disabled={isRecording}>{isRecording ? 'Finalize o take' : 'Salvar e atualizar'}</button>}</article></div><div className="calibration-panel"><div><span className="eyebrow">ALINHAMENTO</span><h3>Compensação manual de posição</h3><p>Aplica um offset em frames aos próximos takes. Use somente um valor medido; o loopback automático e a validação de drift continuam pendentes.</p></div><RangeControl label="Offset de captura" value={project.calibrationFrames} min={-9600} max={9600} step={1} suffix=" frames" onChange={(value) => updateProject((current) => ({ ...current, calibrationFrames: Math.round(value) }))} /><button className="link-button" onClick={() => updateProject((current) => ({ ...current, calibrationFrames: 0 }))}>Zerar ajuste</button></div>{takeDrafts.length > 0 && <div className="recovery-panel"><div><span className="eyebrow">RECUPERAÇÃO</span><h3>{takeDrafts.length} rascunho{takeDrafts.length === 1 ? '' : 's'} de gravação encontrado{takeDrafts.length === 1 ? '' : 's'}</h3><p>Trechos PCM confirmados durante uma gravação que não chegou ao commit final. Recupere-os como um novo take ou descarte-os explicitamente.</p></div>{takeDrafts.map((draft) => <article key={draft.id}><div><strong>{project.tracks.find((track) => track.id === draft.trackId)?.name ?? 'Pista removida'}</strong><small>{draft.persistedChunks} checkpoints · {formatDuration(draft.persistedFrames, draft.sampleRate)} confirmados</small></div><div><button className="button secondary" onClick={() => void recoverTakeDraft(draft)}>Recuperar</button><button className="link-button destructive-link" onClick={() => void discardTakeDraft(draft)}>Descartar</button></div></article>)}</div>}<div className="export-panel backup-panel"><div><span className="eyebrow">CONTINUIDADE</span><h3>Proteja a sessão inteira.</h3><p>O backup inclui a estrutura do projeto e todos os áudios locais. Ao restaurar, ele sempre cria uma cópia sem substituir a sessão original.</p></div><div><button className="button secondary" onClick={() => archiveInputRef.current?.click()} disabled={Boolean(archiving)}>{archiving === 'import' ? 'Restaurando…' : 'Restaurar .valestudio'}</button><button className="button primary" onClick={() => void exportBackup()} disabled={Boolean(archiving)}>{archiving === 'export' ? 'Criando backup…' : 'Backup .valestudio'}</button></div></div><div className="export-panel"><div><span className="eyebrow">EXPORTAÇÃO</span><h3>Renderize a mixagem ou stems locais.</h3><p>WAV é PCM estéreo; MP3 usa encoder MPEG Layer III. Stems entram em um ZIP, todos alinhados desde 00:00 e com a mesma duração.</p></div><div><button className="button secondary" onClick={() => void exportMix('wav')} disabled={Boolean(exporting)}>{exporting === 'wav' ? 'Gerando WAV…' : 'WAV 24-bit'}</button><button className="button secondary" onClick={() => void exportStems()} disabled={Boolean(exporting)}>{exporting === 'stems' ? 'Renderizando stems…' : 'Stems WAV (.zip)'}</button><button className="button primary" onClick={() => void exportMix('mp3')} disabled={Boolean(exporting)}>{exporting === 'mp3' ? 'Codificando MP3…' : 'MP3 192 kbps'}</button></div></div><div className="danger-zone"><button className="button secondary" onClick={() => { if (window.confirm(`Excluir “${project.name}” e seus assets locais? Esta ação não pode ser desfeita.`)) { void projectRepository.removeProject(project).then(() => { setProject(undefined); void projectRepository.listProjects().then(setProjects) }) } }}>Excluir projeto local</button></div></section>}

    <dialog ref={newTrackDialog} className="routing-dialog" aria-labelledby="new-track-title">
      <header><h2 id="new-track-title">Nova pista</h2><form method="dialog"><button className="icon-button" aria-label="Fechar">×</button></form></header>
      <button className="button secondary" type="button" onClick={() => { addTrack(); setView('tracks'); newTrackDialog.current?.close() }}>Pista de áudio</button>
      <button className="button secondary" type="button" onClick={() => { addMidiTrack(); setView('tracks'); newTrackDialog.current?.close() }}>Pista de instrumento MIDI</button>
    </dialog>
    <dialog ref={trackDialog} className="routing-dialog" aria-labelledby="routing-title" onClose={() => setTrackPanel(undefined)}>
      {trackPanel && selectedTrack && <>
        <header><div><small>{selectedTrack.name}</small><h2 id="routing-title">{trackPanel === 'inserts' ? 'Inserts VST3' : 'Sends'}</h2></div>
          <form method="dialog"><button className="icon-button" aria-label="Fechar painel">×</button></form>
        </header>
        {trackPanel === 'sends' ? <>
          <TrackSends track={selectedTrack} onChange={(bus, level) => updateSend(selectedTrack.id, bus, level)} />
          <AuxRouting buses={project.auxBuses ?? []} track={selectedTrack} disabled={!canEditTimeline}
            onChange={(routing) => updateTrack(selectedTrack.id, (track) => ({ ...track, ...routing }))} />
        </> : <>
          {desktopRuntime ? vst3Plugins.length > 0 ?
            <Vst3CatalogInsert key={selectedTrack.id} plugins={vst3Plugins} track={selectedTrack} onInsert={addVst3Insert} />
            : <button className="button secondary" disabled={isScanningVst3} onClick={() => void chooseAndScanVst3Directory()}>{isScanningVst3 ? 'Buscando VST3…' : 'Buscar pasta de plugins VST3'}</button>
            : <p>Os inserts VST3 estão disponíveis no Vale Studio Desktop.</p>}
          <Vst3InsertRack track={selectedTrack} desktopRuntime={desktopRuntime} probeStates={vst3ProbeStates}
            onEdit={(id) => { if (!engineRef.current.showVstEditor(id)) setToast({ tone: 'info', text: 'Ative o insert e inicie a reprodução para abrir o editor.' }) }}
            onProbe={probeVst3Insert} onToggle={toggleVst3Insert} onRemove={removeVst3Insert} />
          {toast && <p role="status" className={`routing-status ${toast.tone}`}>{toast.text}</p>}
        </>}
      </>}
    </dialog>

    {view === 'project' && <section className="midi-panel"><div><span className="eyebrow">MIDI EXTERNO</span><h3>{selectedTrack?.kind === 'midi' ? `Entrada para ${selectedTrack.name}` : 'Selecione uma pista MIDI'}</h3><p>Conecte um teclado/controlador. As notas podem ser pré-ouvidas pelo sintetizador local e gravadas na pista MIDI armada. No Desktop, coloque um instrumento VST3 no primeiro insert da pista MIDI e inicie a reprodução.</p></div><div className="midi-controls"><select aria-label="Entrada MIDI" value={midiInputId ?? ''} onChange={(event) => setMidiInputId(event.target.value || undefined)}><option value="">{midiDevices.length ? 'Escolha a entrada MIDI' : 'Nenhuma entrada detectada ainda'}</option>{midiDevices.map((device) => <option key={device.id} value={device.id}>{device.name}</option>)}</select><button className="button secondary" onClick={() => void enableMidiInput()}>{midiReady ? 'Atualizar MIDI' : 'Conectar MIDI'}</button><small>{midiReady ? 'Entrada pronta. Para gravar, selecione e arme uma pista MIDI, depois use REC.' : 'O dispositivo só é acessado depois do seu toque em Conectar MIDI.'}</small></div></section>}

    {view === 'project' && <section className={`desktop-vst3-panel ${desktopRuntime ? 'desktop-ready' : ''}`}><div><span className="eyebrow">VST3 DESKTOP</span><h3>{desktopRuntime ? 'Catálogo de plug-ins VST3' : 'Plug-ins VST3 exigem o app Desktop'}</h3><p>{desktopRuntime ? 'Ao abrir, o app procura VST3 nas pastas padrão do Windows. Escolha uma pasta sua para acrescentar outros plug-ins; a inspeção acontece em processo nativo separado, com prazo de segurança.' : 'No navegador, continue usando os efeitos nativos. O suporte VST3 aparece apenas no instalador Vale Studio para Windows.'}</p></div><div className="vst3-actions"><button className="button secondary" onClick={() => void chooseAndScanVst3Directory()} disabled={isScanningVst3}>{isScanningVst3 ? 'Verificando…' : desktopRuntime ? 'Escolher pasta VST3' : 'Como usar no Desktop'}</button>{desktopRuntime && vst3Directory && <button className="link-button" onClick={() => void scanVst3Plugins(vst3Directory)} disabled={isScanningVst3}>Verificar novamente</button>}</div>{vst3Directory && <small className="vst3-directory">Pasta escolhida: {vst3Directory}</small>}{vst3Plugins.length > 0 && <div className="vst3-plugin-list">{vst3Plugins.map((plugin) => <article key={`${plugin.bundlePath}:${plugin.classId}`}><span>{plugin.kind === 'instrument' ? 'VST3 MIDI' : 'VST3 FX'}</span><div><strong>{plugin.name}</strong><small>{plugin.vendor || 'Fabricante não informado'} · {plugin.version || 'versão não informada'}</small></div><code>{plugin.classId}</code></article>)}</div>}{vst3ScanErrors.length > 0 && <details className="vst3-errors"><summary>{vst3ScanErrors.length} item{vst3ScanErrors.length === 1 ? '' : 's'} não pôde{vst3ScanErrors.length === 1 ? '' : 'ram'} ser inspecionado{vst3ScanErrors.length === 1 ? '' : 's'}</summary><ul>{vst3ScanErrors.slice(0, 8).map((error) => <li key={error}>{error}</li>)}</ul></details>}</section>}

    <input ref={fileInputRef} className="sr-only" type="file" accept="audio/*,.wav,.mp3,.m4a,.aac,.ogg" onChange={importAudio} />
    <input ref={archiveInputRef} className="sr-only" type="file" accept={`${PROJECT_ARCHIVE_MIME},${PROJECT_ARCHIVE_EXTENSION},application/json`} onChange={importBackup} />
    {toast && <div className={`toast ${toast.tone}`}>{toast.text}<button onClick={() => setToast(undefined)} aria-label="Fechar aviso">×</button></div>}
  </main>
}

function TrackEqualizer({ effects, onChange }: { effects: EffectSettings; onChange: (eq: NonNullable<EffectSettings['eq']>) => void }) {
  const eq = effects.eq ?? { enabled: false, low: 0, mid: 0, high: 0 }
  const bands = { low: 'Graves · 120 Hz', mid: 'Médios · 1 kHz', high: 'Agudos · 6 kHz' }
  return <EffectCard title="Equalizador" active={eq.enabled} onToggle={() => onChange({ ...eq, enabled: !eq.enabled })}>
    {(['low', 'mid', 'high'] as const).map((band) => <RangeControl key={band} label={bands[band]} value={eq[band]}
      min={-18} max={18} step={0.5} suffix=" dB" onChange={(value) => onChange({ ...eq, [band]: value })} />)}
  </EffectCard>
}

function RangeControl({ label, value, min, max, suffix, step = 1, onChange }: { label: string; value: number; min: number; max: number; suffix: string; step?: number; onChange: (value: number) => void }) {
  return <label className="range-control"><span>{label}<b>{Number(value.toFixed(2))}{suffix}</b></span><input type="range" value={value} min={min} max={max} step={step} onChange={(event) => onChange(Number(event.target.value))} /></label>
}

function EffectCard({ title, active, onToggle, children }: { title: string; active: boolean; onToggle: () => void; children: React.ReactNode }) {
  return <article className={`effect-card ${active ? 'active' : ''}`}><div><span className="effect-indicator" /><h3>{title}</h3><button type="button" className="effect-toggle" aria-pressed={active} onClick={onToggle}>{active ? 'Ativo' : 'Bypass'}</button></div>{children}</article>
}

function Vst3CatalogInsert({ plugins, track, onInsert }: { plugins: Vst3Plugin[]; track?: Track; onInsert: (plugin: Vst3Plugin) => void }) {
  const [query, setQuery] = useState('')
  const [selectedKey, setSelectedKey] = useState('')
  const matches = plugins.filter((plugin) => (track?.kind === 'midi' || plugin.kind !== 'instrument')
    && `${plugin.name} ${plugin.vendor}`.toLowerCase().includes(query.trim().toLowerCase()))
  const keyOf = (plugin: Vst3Plugin) => `${plugin.bundlePath}:${plugin.classId}`
  const selectedPlugin = matches.find((plugin) => keyOf(plugin) === selectedKey) ?? matches[0]
  return <div className="plugin-picker">
    <input type="search" aria-label="Filtrar plugins VST3" placeholder="Buscar por nome ou fabricante" value={query} onChange={(event) => setQuery(event.target.value)} />
    <div className="vst3-picker-actions">
      <select aria-label="Plug-in VST3 para inserir" value={selectedPlugin ? keyOf(selectedPlugin) : ''} disabled={!selectedPlugin} onChange={(event) => setSelectedKey(event.target.value)}>
        {!selectedPlugin && <option value="">Nenhum plugin encontrado</option>}
        {matches.map((plugin) => <option key={keyOf(plugin)} value={keyOf(plugin)}>{plugin.name} · {plugin.vendor || 'VST3'}</option>)}
      </select>
      <button className="button primary" disabled={!selectedPlugin} onClick={() => { if (selectedPlugin) onInsert(selectedPlugin) }}>Inserir no projeto</button>
    </div>
    <p>Os inserts ativos processam o áudio no Desktop. Reinicie a reprodução após mudar a cadeia.</p>
  </div>
}

function Vst3InsertRack({ track, desktopRuntime, probeStates, onEdit, onProbe, onToggle, onRemove }: { track: Track; desktopRuntime: boolean; probeStates: Record<string, Vst3ProbeState>; onEdit: (id: string) => void; onProbe: (insert: Vst3Insert) => void; onToggle: (trackId: string, insertId: string) => void; onRemove: (trackId: string, insertId: string) => void }) {
  if (track.vst3Inserts.length === 0) return null
  return <section className="vst3-insert-rack"><div className="vst3-rack-heading"><div><span className="eyebrow">INSERÇÕES VST3</span><h3>Cadeia de {track.name}</h3><p>{desktopRuntime ? 'Identidade, ordem e bypass ficam salvos localmente. Ative o insert e inicie a reprodução para usar o plug-in e abrir seu editor.' : 'Este projeto preserva os inserts, mas a versão web usa apenas os efeitos nativos.'}</p></div><span>{track.vst3Inserts.length} insert{track.vst3Inserts.length === 1 ? '' : 's'}</span></div><div className="vst3-insert-list">{track.vst3Inserts.map((insert, index) => { const probe = probeStates[insert.id]; return <article key={insert.id}><span className="vst3-order">{String(index + 1).padStart(2, '0')}</span><div><strong>{insert.name}</strong><small>{probe?.message ?? `${insert.vendor || 'Fabricante não informado'} · ${insert.version || 'versão não informada'}`}</small></div><span className={`vst3-state ${probe?.status === 'compatible' ? 'compatible' : probe?.status === 'incompatible' ? 'incompatible' : insert.bypass ? 'bypassed' : 'armed'}`}>{probe?.status === 'checking' ? 'TESTANDO' : probe?.status === 'compatible' ? 'BLOCO OK' : probe?.status === 'incompatible' ? 'FALHOU' : insert.bypass ? 'BYPASS' : 'PREPARADO'}</span><div className="vst3-insert-actions"><button className="button secondary" disabled={!desktopRuntime || probe?.status === 'checking'} onClick={() => onProbe(insert)}>{probe?.status === 'checking' ? 'Testando…' : 'Verificar'}</button><button className="button secondary" disabled={!desktopRuntime} onClick={() => onToggle(track.id, insert.id)}>{insert.bypass ? 'Ativar' : 'Bypass'}</button><button className="button secondary" disabled={!desktopRuntime || insert.bypass} onClick={() => onEdit(insert.id)}>Editor</button><button className="link-button destructive-link" onClick={() => onRemove(track.id, insert.id)}>Remover</button></div></article> })}</div></section>
}
