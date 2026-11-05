export type MidiDevice = { id: string; name: string }
export type MidiMessage = { type: 'noteon' | 'noteoff'; note: number; velocity: number }

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

  async connect(inputId: string | undefined, onMessage: (message: MidiMessage) => void, onDevices: (devices: MidiDevice[]) => void): Promise<MidiDevice[]> {
    const request = (navigator as MidiNavigator).requestMIDIAccess
    if (!request) throw new Error('A entrada MIDI não está disponível neste WebView. Atualize o Vale Studio Desktop para usar o dispositivo MIDI.')
    this.access ??= await request.call(navigator)
    const refresh = () => onDevices(this.devices())
    this.access.onstatechange = refresh
    const devices = this.devices()
    const input = this.access.inputs.get(inputId ?? devices[0]?.id ?? '')
    if (!input) throw new Error('Nenhum dispositivo MIDI de entrada foi encontrado.')
    if (this.activeInput) this.activeInput.onmidimessage = null
    this.activeInput = input
    input.onmidimessage = (event) => {
      const status = event.data[0] & 0xf0
      const note = event.data[1]
      const velocity = event.data[2] ?? 0
      if (note === undefined || (status !== 0x90 && status !== 0x80)) return
      onMessage({ type: status === 0x80 || velocity === 0 ? 'noteoff' : 'noteon', note, velocity })
    }
    refresh()
    return devices
  }

  devices(): MidiDevice[] {
    return this.access ? [...this.access.inputs.values()].map((input) => ({ id: input.id, name: input.name || 'Entrada MIDI sem nome' })) : []
  }

  disconnect(): void {
    if (this.activeInput) this.activeInput.onmidimessage = null
    if (this.access) this.access.onstatechange = null
    this.activeInput = undefined
  }
}
