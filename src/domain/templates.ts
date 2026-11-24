import { createMidiTrack, createTrack, type AudioProject } from './model'

export const SESSION_TEMPLATES = {
  blank: 'Voz · uma pista',
  acoustic: 'Voz e violão · três pistas',
  band: 'Banda · oito pistas',
  production: 'Produção MIDI · quatro instrumentos e voz',
  podcast: 'Podcast · duas vozes e trilha',
} as const
export type SessionTemplate = keyof typeof SESSION_TEMPLATES

export function applySessionTemplate(project: AudioProject, template: SessionTemplate): AudioProject {
  const audio = (name: string, color: string, channels: 1 | 2 = 1) => ({ ...createTrack(name, color), recordChannels: channels })
  const tracks = template === 'acoustic' ? [audio('Voz principal', '#20a7ff'), audio('Violão', '#f59e0b', 2), audio('Dobras', '#a855f7')]
    : template === 'band' ? [audio('Voz principal', '#20a7ff'), audio('Dobras', '#a855f7'), audio('Violão', '#f59e0b', 2), audio('Guitarra', '#eab308'), audio('Baixo', '#14b8a6'), audio('Bateria', '#3b82f6', 2), createMidiTrack('Teclado', '#c084fc'), audio('Ambiência', '#94a3b8', 2)]
    : template === 'production' ? [createMidiTrack('Bateria', '#3b82f6'), createMidiTrack('Baixo', '#14b8a6'), createMidiTrack('Teclado', '#a855f7'), createMidiTrack('Synth', '#f59e0b'), audio('Voz principal', '#20a7ff')]
    : template === 'podcast' ? [audio('Voz 1', '#20a7ff'), audio('Voz 2', '#a855f7'), audio('Trilha', '#14b8a6', 2)]
    : [audio('Voz principal', '#20a7ff')]
  return { ...project, tracks, clips: [], takes: [], assets: [], metronomeEnabled: template !== 'podcast', countInBars: template === 'podcast' ? 0 : 1 }
}
