export type MidiDevice = { id: string; name: string }
export type MidiMessage = NoteMessage

type MidiPort = {
  id: string
  name?: string | null
  type: 'input' | 'output'
  onmidimessage: ((event: { data: Uint8Array }) => void) | null
}

type MidiAccess = {
  inputs: Map<string, MidiPort>
  onstatechange: (() => void) | null
}

type MidiNavigator = Navigator & { requestMIDIAccess?: () => Promise<MidiAccess> }

export class MidiInput {
  private access?: MidiAccess
  private activeInput?: MidiPort
  private sustain?: Sustain

  async connect(inputId: string | undefined, onMessage: (message: MidiMessage) => void, onDevices: (devices: MidiDevice[]) => void): Promise<MidiDevice[]> {
    const request = (navigator as MidiNavigator).requestMIDIAccess
    if (!request) throw new Error('A entrada MIDI não está disponível neste WebView. Atualize o Vale Studio Desktop para usar o dispositivo MIDI.')
    this.access ??= await request.call(navigator)
    const refresh = () => {
      if (this.activeInput && !this.access?.inputs.has(this.activeInput.id)) this.panic()
      onDevices(this.devices())
    }
    this.access.onstatechange = refresh
    const devices = this.devices()
    const input = this.access.inputs.get(inputId ?? devices[0]?.id ?? '')
    if (!input) throw new Error('Nenhum dispositivo MIDI de entrada foi encontrado.')
    if (this.activeInput) this.activeInput.onmidimessage = null
    this.panic()
    this.sustain = new Sustain(onMessage)
    this.activeInput = input
    input.onmidimessage = (event) => {
      this.sustain?.receive(event.data)
    }
    refresh()
    return devices
  }

  devices(): MidiDevice[] {
    return this.access ? [...this.access.inputs.values()].map((input) => ({ id: input.id, name: input.name || 'Entrada MIDI sem nome' })) : []
  }

  panic(): void {
    this.sustain?.panic()
  }

  disconnect(): void {
    this.panic()
    if (this.activeInput) this.activeInput.onmidimessage = null
    if (this.access) this.access.onstatechange = null
    this.activeInput = undefined
  }
}
import { Sustain, type NoteMessage } from './Sustain'
