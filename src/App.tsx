import { ChangeEvent, useEffect, useMemo, useRef, useState } from 'react'
import { AudioEngine, type AudioCapabilities } from './audio/AudioEngine'
import { buildPeaks } from './audio/peaks'
import { encodeWav } from './audio/wav'
import type { AudioProject, Clip, MediaAsset, MonitorMode, TimeSignature, Track } from './domain/model'
import { createProject, createTrack, gainToDb } from './domain/model'
import { exportProjectArchive, PROJECT_ARCHIVE_EXTENSION, PROJECT_ARCHIVE_MIME, restoreProjectArchive } from './storage/projectArchive'
import { projectRepository, type TakeDraft } from './storage/projectRepository'

type View = 'tracks' | 'mixer' | 'effects' | 'takes' | 'project'
type Toast = { tone: 'info' | 'error' | 'success'; text: string } | undefined

const TRACK_COLORS = ['#1eaeff', '#a855f7', '#ff9e3d', '#f5cd36', '#1ed6b5', '#5d71ff']

function makeId(): string {
  return crypto.randomUUID()
}

function formatDuration(frames: number, rate: number): string {
  const seconds = Math.max(0, frames / rate)
  const minutes = Math.floor(seconds / 60)
  return `${String(minutes).padStart(2, '0')}:${(seconds % 60).toFixed(1).padStart(4, '0')}`
}

function dateLabel(value: string): string {
  return new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short' }).format(new Date(value))
}

function dbLabel(value: number): string {
  return `${value > 0 ? '+' : ''}${value.toFixed(1)} dB`
}

function meterPercent(value?: number): number {
  if (!value || value <= 0) return 2
  return Math.max(2, Math.min(100, (gainToDb(value) + 60) / 60 * 100))
}

function Waveform({ peaks, color }: { peaks: number[]; color: string }) {
  const points = peaks.map((peak, index) => {
    const x = peaks.length === 1 ? 50 : index / (peaks.length - 1) * 100
    const height = Math.max(2, peak * 43)
    return `${x.toFixed(2)},${50 - height} ${x.toFixed(2)},${50 + height}`
  }).join(' ')
  return (
    <svg className="waveform" viewBox="0 0 100 100" preserveAspectRatio="none" aria-label="Forma de onda do áudio real">
      <polyline points={points} stroke={color} strokeWidth="0.85" fill="none" strokeLinecap="round" />
    </svg>
  )
}

function Logo() {
  return <div className="brand" aria-label="Vale Studio"><span className="brand-mark">V</span><span>VALE</span><em>STUDIO</em></div>
}

function Toggle({ pressed, label, onClick, danger = false }: { pressed: boolean; label: string; onClick: () => void; danger?: boolean }) {
  return <button type="button" className={`tiny-toggle ${pressed ? 'active' : ''} ${danger ? 'danger' : ''}`} aria-pressed={pressed} onClick={onClick}>{label}</button>
}

function TrackMeter({ value }: { value?: number }) {
  return <div className="track-meter" aria-label={value === undefined ? 'Medidor inativo' : `Nível ${Math.round(meterPercent(value))}%`}><span style={{ height: `${meterPercent(value)}%` }} /></div>
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
  const activeDraftRef = useRef<{ id: string; projectId: string; trackId: string } | undefined>(undefined)
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
  const [isRecording, setIsRecording] = useState(false)
  const [isMetronome, setIsMetronome] = useState(false)
  const [playhead, setPlayhead] = useState(0)
  const [inputPeak, setInputPeak] = useState<number>()
  const [trackPeaks, setTrackPeaks] = useState<Record<string, number>>({})
  const [toast, setToast] = useState<Toast>()
  const [showNewProject, setShowNewProject] = useState(false)
  const [exporting, setExporting] = useState<'wav' | 'mp3'>()
  const [previewingTakeId, setPreviewingTakeId] = useState<string>()
  const [archiving, setArchiving] = useState<'export' | 'import'>()
  const [takeDrafts, setTakeDrafts] = useState<TakeDraft[]>([])
  const [, setUndoStack] = useState<AudioProject[]>([])
  const [, setRedoStack] = useState<AudioProject[]>([])

  const selectedTrack = project?.tracks.find((track) => track.id === selectedTrackId) ?? project?.tracks[0]
  const selectedClip = project?.clips.find((clip) => clip.id === selectedClipId)
  const activeAssetById = useMemo(() => new Map(project?.assets.map((asset) => [asset.id, asset]) ?? []), [project])
  const activeProjectId = project?.id

  useEffect(() => {
    void projectRepository.listProjects().then(setProjects).catch(() => setToast({ tone: 'error', text: 'Não foi possível abrir os projetos locais.' }))
    void projectRepository.getStorageEstimate().then(setStorage)
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
      setPlayhead(engineRef.current.getCurrentFrame(project.audioSampleRate))
      setInputPeak(engineRef.current.getInputMeter()?.peak)
      const next: Record<string, number> = {}
      project.tracks.forEach((track) => {
        const value = engineRef.current.getTrackMeter(track.id)?.peak
        if (value !== undefined) next[track.id] = value
      })
      setTrackPeaks(next)
    }, 80)
    return () => window.clearInterval(timer)
  }, [project])

  function updateProject(change: (current: AudioProject) => AudioProject, recordHistory = true) {
    setProject((current) => {
      if (!current) return current
      if (recordHistory) {
        setUndoStack((stack) => [...stack.slice(-29), current])
        setRedoStack([])
      }
      const next = { ...change(current), updatedAt: new Date().toISOString() }
      engineRef.current.updateMix(next)
      return next
    })
  }

  function updateTrack(id: string, change: (track: Track) => Track) {
    updateProject((current) => ({ ...current, tracks: current.tracks.map((track) => track.id === id ? change(track) : track) }))
  }

  function undo() {
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

  function openProject(next: AudioProject) {
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
      engineRef.current.stop()
      setIsPlaying(false)
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

  function togglePlayback() {
    if (!project) return
    if (!capabilities) { void activateAudio(); return }
    if (isPlaying) {
      engineRef.current.pause(project.audioSampleRate)
      setIsPlaying(false)
    } else {
      engineRef.current.play(project)
      setIsPlaying(true)
    }
  }

  function toggleMetronome() {
    if (!project || !capabilities) { void activateAudio(); return }
    if (isMetronome) {
      engineRef.current.stopMetronome()
      setIsMetronome(false)
    } else {
      engineRef.current.startMetronome(project.bpm, Number(project.timeSignature.split('/')[0]))
      setIsMetronome(true)
    }
  }

  async function toggleRecording() {
    if (!project || !selectedTrack) return
    if (isRecording) {
      const captured = await engineRef.current.stopRecording()
      setIsRecording(false)
      const activeDraft = activeDraftRef.current
      activeDraftRef.current = undefined
      if (!captured || captured.frames < 128) {
        if (activeDraft) await projectRepository.discardTakeDraft(activeDraft.id).catch(() => undefined)
        setToast({ tone: 'error', text: 'Nenhum frame de áudio foi confirmado. O take não foi salvo.' })
        return
      }
      if (!activeDraft) {
        setToast({ tone: 'error', text: 'A sessão de segurança do take foi perdida. O áudio não foi marcado como salvo.' })
        return
      }
      const assetId = makeId()
      const takeId = makeId()
      const asset: MediaAsset = {
        id: assetId, name: `Take ${project.takes.filter((take) => take.trackId === selectedTrack.id).length + 1}.wav`, mimeType: 'audio/wav',
        sampleRate: captured.sampleRate, channels: captured.channels, frames: captured.frames,
        durationFrames: Math.round(captured.frames / captured.sampleRate * project.audioSampleRate), byteLength: captured.blob.size,
        peaks: captured.peaks, createdAt: new Date().toISOString(),
      }
      const startFrame = Math.max(0, engineRef.current.getRecordingStartFrame() + project.calibrationFrames)
      const clip: Clip = { id: makeId(), assetId, trackId: selectedTrack.id, timelineStartFrame: startFrame, sourceOffsetFrame: 0, durationFrames: asset.durationFrames, gainDb: 0, fadeInFrames: 0, fadeOutFrames: 0, takeId }
      const nextProject: AudioProject = {
        ...project,
        assets: [...project.assets, asset], clips: [...project.clips, clip],
        tracks: project.tracks.map((track) => track.id !== selectedTrack.id ? track : { ...track, clipIds: [...track.clipIds, clip.id], takeIds: [...track.takeIds, takeId] }),
        takes: [...project.takes.map((take) => take.trackId === selectedTrack.id ? { ...take, selected: false } : take), { id: takeId, assetId, trackId: selectedTrack.id, name: asset.name.replace('.wav', ''), startFrame, durationFrames: asset.durationFrames, createdAt: asset.createdAt, calibrationFrames: project.calibrationFrames, selected: true }],
        updatedAt: new Date().toISOString(),
      }
      try {
        await projectRepository.commitTake(nextProject, asset, captured.blob, activeDraft.id)
        engineRef.current.cacheAsset(assetId, captured.buffer)
        setProject(nextProject)
        setSelectedClipId(clip.id)
        setTakeDrafts((drafts) => drafts.filter((draft) => draft.id !== activeDraft.id))
        void projectRepository.listProjects().then(setProjects)
        const durabilityNotice = captured.durability.error ? ' O take foi confirmado no commit final, mas houve falha em um checkpoint intermediário.' : ''
        setToast({ tone: 'success', text: `Take salvo localmente após ${captured.frames.toLocaleString('pt-BR')} frames confirmados.${durabilityNotice}` })
      } catch (error) {
        setToast({ tone: 'error', text: `O commit final falhou; o rascunho persistido continua disponível para recuperação.${error instanceof Error ? ` ${error.message}` : ''}` })
      }
      return
    }
    if (!selectedTrack.armed) { setToast({ tone: 'error', text: 'Arme a pista que receberá a gravação antes de tocar em REC.' }); return }
    const audio = capabilities ?? await activateAudio()
    if (!audio) return
    const draftId = makeId()
    try {
      if (!isPlaying) { engineRef.current.play(project); setIsPlaying(true) }
      await projectRepository.beginTakeDraft({ id: draftId, projectId: project.id, trackId: selectedTrack.id, timelineStartFrame: engineRef.current.getCurrentFrame(project.audioSampleRate), sampleRate: audio.sampleRate, channels: 1 })
      activeDraftRef.current = { id: draftId, projectId: project.id, trackId: selectedTrack.id }
      const recording = await engineRef.current.startRecording(selectedTrack.id, project, selectedTrack.monitorMode, async (chunk) => {
        await projectRepository.appendTakeDraftChunk({ ...chunk, draftId })
      })
      await projectRepository.updateTakeDraftStart(draftId, recording.startFrame)
      setIsRecording(true)
      const agc = recording.inputSettings?.autoGainControl
      setToast({ tone: 'info', text: agc ? 'Capturando: o sistema informou controle automático de ganho.' : 'Capturando PCM seco com checkpoints locais.' })
    } catch (error) {
      if (engineRef.current.isRecording) await engineRef.current.stopRecording().catch(() => undefined)
      activeDraftRef.current = undefined
      await projectRepository.discardTakeDraft(draftId).catch(() => undefined)
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
      if (!recovered || recovered.pcm.length < 128) { setToast({ tone: 'error', text: 'Este rascunho não contém frames suficientes para recuperar um take.' }); return }
      const buffer = engineRef.current.createBufferFromPcm(recovered.pcm, recovered.sampleRate, recovered.channels)
      const assetId = makeId()
      const takeId = makeId()
      const takeBlob = encodeWav(buffer, 32)
      const asset: MediaAsset = {
        id: assetId, name: `Take recuperado ${project.takes.filter((take) => take.trackId === track.id).length + 1}.wav`, mimeType: 'audio/wav', sampleRate: buffer.sampleRate, channels: buffer.numberOfChannels,
        frames: recovered.pcm.length / recovered.channels, durationFrames: Math.round(buffer.duration * project.audioSampleRate), byteLength: takeBlob.size,
        peaks: buildPeaks(buffer), createdAt: new Date().toISOString(),
      }
      const startFrame = Math.max(0, recovered.timelineStartFrame + project.calibrationFrames)
      const clip: Clip = { id: makeId(), assetId, trackId: track.id, timelineStartFrame: startFrame, sourceOffsetFrame: 0, durationFrames: asset.durationFrames, gainDb: 0, fadeInFrames: 0, fadeOutFrames: 0, takeId }
      const nextProject: AudioProject = {
        ...project,
        assets: [...project.assets, asset], clips: [...project.clips, clip],
        tracks: project.tracks.map((item) => item.id === track.id ? { ...item, clipIds: [...item.clipIds, clip.id], takeIds: [...item.takeIds, takeId] } : item),
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
    updateProject((current) => ({ ...current, takes: current.takes.map((item) => item.trackId === take.trackId ? { ...item, selected: item.id === takeId } : item) }))
    setSelectedTrackId(take.trackId)
    setToast({ tone: 'success', text: `${take.name} será usado na prévia e na próxima renderização.` })
  }

  async function previewTake(takeId: string) {
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

  function updateClip(action: 'moveLeft' | 'moveRight' | 'duplicate' | 'split' | 'fadeIn' | 'fadeOut' | 'remove') {
    if (!project || !selectedClip) return
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
      const splitAt = Math.floor(selectedClip.durationFrames / 2)
      if (splitAt < 128) return
      const first: Clip = { ...selectedClip, id: makeId(), durationFrames: splitAt }
      const second: Clip = { ...selectedClip, id: makeId(), sourceOffsetFrame: selectedClip.sourceOffsetFrame + splitAt, timelineStartFrame: selectedClip.timelineStartFrame + splitAt, durationFrames: selectedClip.durationFrames - splitAt }
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
    const onKeyDown = (event: KeyboardEvent) => {
      const element = event.target as HTMLElement
      if (element.tagName === 'INPUT' || element.tagName === 'SELECT' || element.tagName === 'TEXTAREA') return
      if (!project) return
      if (event.code === 'Space') { event.preventDefault(); togglePlayback() }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); undo() }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') { event.preventDefault(); redo() }
      if (event.key.toLowerCase() === 'm' && selectedTrack) updateTrack(selectedTrack.id, (track) => ({ ...track, mute: !track.mute }))
      if (event.key.toLowerCase() === 's' && selectedTrack) updateTrack(selectedTrack.id, (track) => ({ ...track, solo: !track.solo }))
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
    <section className="recent-projects"><div className="section-title"><h2>Projetos recentes</h2><span>{projects.length} local{projects.length === 1 ? '' : 'is'}</span></div>{projects.length === 0 ? <div className="empty-state"><span>◇</span><p>Nenhum projeto salvo ainda.</p><small>Crie um projeto para começar a gravar.</small></div> : projects.map((item) => <button className="project-card" key={item.id} onClick={() => openProject(item)}><span className="project-orb">V</span><span><strong>{item.name}</strong><small>{dateLabel(item.updatedAt)} · {item.tracks.length} pista{item.tracks.length === 1 ? '' : 's'} · {item.assets.length} áudio{item.assets.length === 1 ? '' : 's'}</small></span><i>›</i></button>)}</section>
    <footer className="home-footer"><span className="status-dot" />Dados locais · {storage?.quota ? `${Math.round((storage.usage ?? 0) / 1024 / 1024)} MB usados` : 'armazenamento será verificado no dispositivo'}</footer>
    {showNewProject && <NewProjectDialog onCreate={createNewProject} onCancel={() => setShowNewProject(false)} />}{toast && <div className={`toast ${toast.tone}`}>{toast.text}</div>}
  </main>

  return <main className="app-shell studio-shell">
    <header className="studio-header"><Logo /><div className="project-name"><strong>{project.name}</strong><span className={isRecording ? 'recording' : takeDrafts.length ? 'recovery-status' : ''}>{isRecording ? 'CAPTURANDO' : takeDrafts.length ? 'RECUPERAÇÃO PENDENTE' : 'SALVO LOCAL'}</span></div><div className="header-actions"><button className="action-chip" onClick={() => void activateAudio()}>{capabilities ? `${capabilities.sampleRate / 1000} kHz` : 'Ativar áudio'}</button><button className="icon-button" onClick={() => { setProject(undefined); setView('tracks') }} aria-label="Voltar aos projetos">⌂</button></div></header>
    <section className="transport"><button type="button" className="transport-button" onClick={() => { engineRef.current.stop(); setIsPlaying(false); setPlayhead(0) }} aria-label="Voltar ao início">|◀</button><button type="button" className={`transport-button play ${isPlaying ? 'active' : ''}`} onClick={togglePlayback} aria-label={isPlaying ? 'Pausar' : 'Tocar'}>{isPlaying ? 'Ⅱ' : '▶'}</button><button type="button" className={`record-button ${isRecording ? 'active' : ''}`} onClick={() => void toggleRecording()} aria-label={isRecording ? 'Parar e salvar take' : 'Gravar na pista armada'}><span /></button><div className="clock"><b>{formatDuration(playhead, project.audioSampleRate)}</b><small>{project.bpm} BPM · {project.timeSignature}</small></div><button type="button" className={`metro-button ${isMetronome ? 'active' : ''}`} onClick={toggleMetronome} aria-pressed={isMetronome}>♩<span>METRO</span></button></section>

    <section className="session-meta"><button onClick={() => updateProject((current) => ({ ...current, bpm: Math.max(40, current.bpm - 1) }))}>−</button><strong>{project.bpm} BPM</strong><button onClick={() => updateProject((current) => ({ ...current, bpm: Math.min(240, current.bpm + 1) }))}>＋</button><span className="meta-divider" /><span>{project.timeSignature}</span><span className={`sync-badge ${project.calibrationFrames ? 'calibrated' : ''}`}>{project.calibrationFrames ? `Ajuste ${project.calibrationFrames} fr` : 'Sem calibração'}</span></section>

    {view === 'tracks' && <section className="track-area"><div className="ruler"><span>00:00</span><span>00:15</span><span>00:30</span><span>00:45</span><span>01:00</span></div><div className="playhead" style={{ left: `${Math.min(96, 18 + playhead / Math.max(project.audioSampleRate * 70, 1) * 78)}%` }} />
      {project.tracks.map((track) => <article className={`track-row ${selectedTrack?.id === track.id ? 'selected' : ''}`} key={track.id} onClick={() => setSelectedTrackId(track.id)}><div className="track-head"><span className="track-color" style={{ background: track.color }} /><div><strong>{track.name}</strong><small>{track.armed ? 'ARMADA' : track.monitorMode === 'software' ? 'MONITOR SOFTWARE' : 'Entrada mono'}</small></div><TrackMeter value={track.id === selectedTrack?.id && isRecording ? inputPeak : trackPeaks[track.id]} /><div className="track-toggles"><Toggle pressed={track.armed} label="ARM" danger onClick={() => updateTrack(track.id, (current) => ({ ...current, armed: !current.armed }))} /><Toggle pressed={track.mute} label="M" onClick={() => updateTrack(track.id, (current) => ({ ...current, mute: !current.mute }))} /><Toggle pressed={track.solo} label="S" onClick={() => updateTrack(track.id, (current) => ({ ...current, solo: !current.solo }))} /><button className="tiny-toggle" onClick={() => cycleMonitor(track)}>MON</button></div></div><div className="clip-lane">{project.clips.filter((clip) => clip.trackId === track.id).map((clip) => { const asset = activeAssetById.get(clip.assetId); const left = 3 + clip.timelineStartFrame / project.audioSampleRate / 70 * 94; const width = Math.max(12, clip.durationFrames / project.audioSampleRate / 70 * 94); return <button key={clip.id} className={`audio-clip ${selectedClipId === clip.id ? 'selected' : ''}`} style={{ left: `${Math.min(94, left)}%`, width: `${Math.min(94 - left, width)}%`, '--clip-color': track.color } as React.CSSProperties} onClick={(event) => { event.stopPropagation(); setSelectedTrackId(track.id); setSelectedClipId(clip.id) }} aria-label={`Selecionar clipe ${asset?.name ?? 'gravado'}`}><Waveform peaks={asset?.peaks ?? [0]} color={track.color} /><small>{asset?.name.replace(/\.[^.]+$/, '')}</small></button> })}</div></article>)}
      <div className="track-area-actions"><button className="button secondary" onClick={addTrack}>＋ Pista</button><button className="button secondary" onClick={() => fileInputRef.current?.click()}>↥ Importar</button></div>
      {selectedClip && <div className="edit-sheet"><span>Clipe selecionado</span><button onClick={() => updateClip('split')}>Dividir</button><button onClick={() => updateClip('moveLeft')}>← Mover</button><button onClick={() => updateClip('moveRight')}>Mover →</button><button onClick={() => updateClip('duplicate')}>Duplicar</button><button className={selectedClip.fadeInFrames ? 'active-edit' : ''} onClick={() => updateClip('fadeIn')}>Fade In</button><button className={selectedClip.fadeOutFrames ? 'active-edit' : ''} onClick={() => updateClip('fadeOut')}>Fade Out</button><button className="destructive" onClick={() => updateClip('remove')}>Excluir</button></div>}</section>}

    {view === 'mixer' && <section className="mixer-view"><div className="view-intro"><div><span className="eyebrow">MIXER</span><h2>Controle real por pista.</h2></div><button className="button secondary" onClick={() => void exportMix('wav')} disabled={Boolean(exporting)}>{exporting === 'wav' ? 'Renderizando…' : 'Exportar WAV'}</button></div><div className="mixer-strip-scroll">{project.tracks.map((track) => <article className={`channel-strip ${selectedTrack?.id === track.id ? 'selected' : ''}`} key={track.id} onClick={() => setSelectedTrackId(track.id)}><span className="track-color" style={{ background: track.color }} /><strong>{track.name}</strong><TrackMeter value={trackPeaks[track.id]} /><input aria-label={`Volume de ${track.name}`} className="fader" type="range" min="-60" max="6" step="0.5" value={track.gainDb} onChange={(event) => updateTrack(track.id, (current) => ({ ...current, gainDb: Number(event.target.value) }))} /><output>{dbLabel(track.gainDb)}</output><label>Pan<input type="range" min="-1" max="1" step="0.05" value={track.pan} onChange={(event) => updateTrack(track.id, (current) => ({ ...current, pan: Number(event.target.value) }))} /></label><div><Toggle pressed={track.mute} label="M" onClick={() => updateTrack(track.id, (current) => ({ ...current, mute: !current.mute }))} /><Toggle pressed={track.solo} label="S" onClick={() => updateTrack(track.id, (current) => ({ ...current, solo: !current.solo }))} /></div></article>)}</div></section>}

    {view === 'effects' && selectedTrack && <section className="effects-view"><div className="view-intro"><div><span className="eyebrow">EFEITOS REAIS</span><h2>{selectedTrack.name}</h2><p>Os controles abaixo alteram o grafo de áudio quando a faixa é reproduzida ou exportada.</p></div><select value={selectedTrack.id} onChange={(event) => setSelectedTrackId(event.target.value)}>{project.tracks.map((track) => <option key={track.id} value={track.id}>{track.name}</option>)}</select></div><div className="effects-grid"><EffectCard title="Filtro de graves" active={selectedTrack.effects.highPassEnabled} onToggle={() => updateTrack(selectedTrack.id, (track) => ({ ...track, effects: { ...track.effects, highPassEnabled: !track.effects.highPassEnabled } }))}><RangeControl label="Frequência" value={selectedTrack.effects.highPassHz} min={20} max={500} suffix=" Hz" onChange={(value) => updateTrack(selectedTrack.id, (track) => ({ ...track, effects: { ...track.effects, highPassHz: value } }))} /></EffectCard><EffectCard title="Compressor" active={selectedTrack.effects.compressorEnabled} onToggle={() => updateTrack(selectedTrack.id, (track) => ({ ...track, effects: { ...track.effects, compressorEnabled: !track.effects.compressorEnabled } }))}><RangeControl label="Threshold" value={selectedTrack.effects.threshold} min={-60} max={0} suffix=" dB" onChange={(value) => updateTrack(selectedTrack.id, (track) => ({ ...track, effects: { ...track.effects, threshold: value } }))} /><RangeControl label="Ratio" value={selectedTrack.effects.ratio} min={1} max={12} step={0.5} suffix=":1" onChange={(value) => updateTrack(selectedTrack.id, (track) => ({ ...track, effects: { ...track.effects, ratio: value } }))} /></EffectCard><EffectCard title="Reverb" active={selectedTrack.effects.reverbEnabled} onToggle={() => updateTrack(selectedTrack.id, (track) => ({ ...track, effects: { ...track.effects, reverbEnabled: !track.effects.reverbEnabled } }))}><RangeControl label="Mix" value={selectedTrack.effects.reverbMix * 100} min={0} max={70} suffix=" %" onChange={(value) => updateTrack(selectedTrack.id, (track) => ({ ...track, effects: { ...track.effects, reverbMix: value / 100 } }))} /></EffectCard><EffectCard title="Delay" active={selectedTrack.effects.delayEnabled} onToggle={() => updateTrack(selectedTrack.id, (track) => ({ ...track, effects: { ...track.effects, delayEnabled: !track.effects.delayEnabled } }))}><RangeControl label="Tempo" value={selectedTrack.effects.delayTime * 1000} min={40} max={1200} suffix=" ms" onChange={(value) => updateTrack(selectedTrack.id, (track) => ({ ...track, effects: { ...track.effects, delayTime: value / 1000 } }))} /><RangeControl label="Mix" value={selectedTrack.effects.delayMix * 100} min={0} max={70} suffix=" %" onChange={(value) => updateTrack(selectedTrack.id, (track) => ({ ...track, effects: { ...track.effects, delayMix: value / 100 } }))} /></EffectCard></div></section>}

    {view === 'takes' && <section className="takes-view"><div className="view-intro"><div><span className="eyebrow">GERENCIAMENTO DE TAKES</span><h2>{selectedTrack?.name ?? 'Selecione uma pista'}</h2><p>Somente o take marcado como ativo de cada pista entra na prévia e na renderização. A troca não apaga nenhuma versão.</p></div><select value={selectedTrack?.id ?? ''} onChange={(event) => setSelectedTrackId(event.target.value)}>{project.tracks.map((track) => <option key={track.id} value={track.id}>{track.name}</option>)}</select></div>{selectedTrack && project.takes.filter((take) => take.trackId === selectedTrack.id).length === 0 ? <div className="empty-state"><span>◇</span><p>Nenhum take nesta pista.</p><small>Arme a pista e grave para criar versões recuperáveis.</small></div> : <div className="take-list">{project.takes.filter((take) => take.trackId === selectedTrack?.id).map((take, index) => { const asset = activeAssetById.get(take.assetId); return <article key={take.id} className={`take-card ${take.selected ? 'selected' : ''}`}><div className="take-wave"><Waveform peaks={asset?.peaks ?? [0]} color={selectedTrack?.color ?? '#1eaeff'} /></div><div className="take-copy"><small>TAKE {String(index + 1).padStart(2, '0')} · {take.selected ? 'ATIVO' : 'ALTERNATIVO'}</small><strong>{take.name}</strong><span>{formatDuration(take.durationFrames, project.audioSampleRate)} · início {formatDuration(take.startFrame, project.audioSampleRate)}</span></div><div className="take-actions"><button className="button secondary" onClick={() => void previewTake(take.id)}>{previewingTakeId === take.id ? 'Ouvindo…' : 'Ouvir'}</button><button className={`button ${take.selected ? 'selected-take' : 'primary'}`} onClick={() => selectTake(take.id)}>{take.selected ? 'Em uso' : 'Usar take'}</button></div></article> })}</div>}</section>}

    {view === 'project' && <section className="project-view"><div className="view-intro"><div><span className="eyebrow">PROJETO LOCAL</span><h2>Estado e compatibilidade</h2><p>Esta sessão não envia áudio para servidores. O salvamento é local ao navegador.</p></div></div><div className="diagnostic-grid"><article><small>MOTOR DE ÁUDIO</small><strong>{capabilities ? 'Ativo após gesto' : 'Aguardando ativação'}</strong><p>{capabilities ? `${capabilities.sampleRate.toLocaleString('pt-BR')} Hz efetivos · AudioWorklet ${capabilities.audioWorklet ? 'disponível' : 'indisponível'}` : 'Toque em “Ativar áudio” antes de importar, tocar, gravar ou exportar.'}</p></article><article><small>ARMAZENAMENTO</small><strong>{storage?.persistent ? 'Persistente concedido' : 'Local do navegador'}</strong><p>{storage?.quota ? `${Math.round((storage.usage ?? 0) / 1024 / 1024)} MB usados de aproximadamente ${Math.round(storage.quota / 1024 / 1024)} MB.` : 'A cota será consultada no dispositivo.'}</p><button className="link-button" onClick={() => void projectRepository.requestPersistentStorage().then(() => projectRepository.getStorageEstimate()).then(setStorage)}>Solicitar persistência</button></article><article><small>MONITORAMENTO</small><strong>{selectedTrack?.monitorMode === 'software' ? 'Software ativado' : selectedTrack?.monitorMode === 'direct' ? 'Direto selecionado' : 'Sem retorno'}</strong><p>“Sincronia” ajusta a posição do take. Não elimina a latência física ao ouvir a própria voz.</p></article></div><div className="calibration-panel"><div><span className="eyebrow">ALINHAMENTO</span><h3>Compensação manual de posição</h3><p>Aplica um offset em frames aos próximos takes. Use somente um valor medido; o loopback automático e a validação de drift continuam pendentes.</p></div><RangeControl label="Offset de captura" value={project.calibrationFrames} min={-9600} max={9600} step={1} suffix=" frames" onChange={(value) => updateProject((current) => ({ ...current, calibrationFrames: Math.round(value) }))} /><button className="link-button" onClick={() => updateProject((current) => ({ ...current, calibrationFrames: 0 }))}>Zerar ajuste</button></div>{takeDrafts.length > 0 && <div className="recovery-panel"><div><span className="eyebrow">RECUPERAÇÃO</span><h3>{takeDrafts.length} rascunho{takeDrafts.length === 1 ? '' : 's'} de gravação encontrado{takeDrafts.length === 1 ? '' : 's'}</h3><p>Trechos PCM confirmados durante uma gravação que não chegou ao commit final. Recupere-os como um novo take ou descarte-os explicitamente.</p></div>{takeDrafts.map((draft) => <article key={draft.id}><div><strong>{project.tracks.find((track) => track.id === draft.trackId)?.name ?? 'Pista removida'}</strong><small>{draft.persistedChunks} checkpoints · {formatDuration(draft.persistedFrames, draft.sampleRate)} confirmados</small></div><div><button className="button secondary" onClick={() => void recoverTakeDraft(draft)}>Recuperar</button><button className="link-button destructive-link" onClick={() => void discardTakeDraft(draft)}>Descartar</button></div></article>)}</div>}<div className="export-panel backup-panel"><div><span className="eyebrow">CONTINUIDADE</span><h3>Proteja a sessão inteira.</h3><p>O backup inclui a estrutura do projeto e todos os áudios locais. Ao restaurar, ele sempre cria uma cópia sem substituir a sessão original.</p></div><div><button className="button secondary" onClick={() => archiveInputRef.current?.click()} disabled={Boolean(archiving)}>{archiving === 'import' ? 'Restaurando…' : 'Restaurar .valestudio'}</button><button className="button primary" onClick={() => void exportBackup()} disabled={Boolean(archiving)}>{archiving === 'export' ? 'Criando backup…' : 'Backup .valestudio'}</button></div></div><div className="export-panel"><div><span className="eyebrow">EXPORTAÇÃO</span><h3>Renderize uma mixagem local.</h3><p>WAV é PCM estéreo. MP3 usa encoder MPEG Layer III incluído no bundle.</p></div><div><button className="button secondary" onClick={() => void exportMix('wav')} disabled={Boolean(exporting)}>{exporting === 'wav' ? 'Gerando WAV…' : 'WAV 24-bit'}</button><button className="button primary" onClick={() => void exportMix('mp3')} disabled={Boolean(exporting)}>{exporting === 'mp3' ? 'Codificando MP3…' : 'MP3 192 kbps'}</button></div></div><div className="danger-zone"><button className="button secondary" onClick={() => { if (window.confirm(`Excluir “${project.name}” e seus assets locais? Esta ação não pode ser desfeita.`)) { void projectRepository.removeProject(project).then(() => { setProject(undefined); void projectRepository.listProjects().then(setProjects) }) } }}>Excluir projeto local</button></div></section>}

    <nav className="bottom-nav" aria-label="Navegação do estúdio">{([{ id: 'tracks', label: 'Pistas', icon: '≋' }, { id: 'mixer', label: 'Mixer', icon: '▥' }, { id: 'effects', label: 'Efeitos', icon: '◌' }, { id: 'takes', label: 'Takes', icon: '◫' }, { id: 'project', label: 'Projeto', icon: '◇' }] as const).map((item) => <button key={item.id} className={view === item.id ? 'active' : ''} onClick={() => setView(item.id)}><b>{item.icon}</b><span>{item.label}</span></button>)}</nav>
    <input ref={fileInputRef} className="sr-only" type="file" accept="audio/*,.wav,.mp3,.m4a,.aac,.ogg" onChange={importAudio} />
    <input ref={archiveInputRef} className="sr-only" type="file" accept={`${PROJECT_ARCHIVE_MIME},${PROJECT_ARCHIVE_EXTENSION},application/json`} onChange={importBackup} />
    {toast && <div className={`toast ${toast.tone}`}>{toast.text}<button onClick={() => setToast(undefined)} aria-label="Fechar aviso">×</button></div>}
  </main>
}

function RangeControl({ label, value, min, max, suffix, step = 1, onChange }: { label: string; value: number; min: number; max: number; suffix: string; step?: number; onChange: (value: number) => void }) {
  return <label className="range-control"><span>{label}<b>{Number(value.toFixed(2))}{suffix}</b></span><input type="range" value={value} min={min} max={max} step={step} onChange={(event) => onChange(Number(event.target.value))} /></label>
}

function EffectCard({ title, active, onToggle, children }: { title: string; active: boolean; onToggle: () => void; children: React.ReactNode }) {
  return <article className={`effect-card ${active ? 'active' : ''}`}><div><span className="effect-indicator" /><h3>{title}</h3><button type="button" className="effect-toggle" aria-pressed={active} onClick={onToggle}>{active ? 'Ativo' : 'Bypass'}</button></div>{children}</article>
}
