export type NoteMessage = { type: 'noteon' | 'noteoff'; note: number; velocity: number; channel: number }

export class Sustain {
  private pedals = new Set<number>()
  private held = new Map<number, NoteMessage>()
  private deferred = new Map<number, NoteMessage>()

  constructor(private emit: (message: NoteMessage) => void) {}

  receive(bytes: Uint8Array) {
    if (bytes.length < 3) return
    const status = bytes[0] & 0xf0
    const channel = bytes[0] & 15
    const note = bytes[1]
    const velocity = bytes[2]
    if (note > 127 || velocity > 127) return
    if (status === 0xb0) {
      if (note === 64) {
        if (velocity >= 64) this.pedals.add(channel)
        else {
          this.pedals.delete(channel)
          this.releaseDeferred(channel)
        }
      }
      if (note === 120 || note === 123) this.panic(channel)
      if (note === 121) {
        this.pedals.delete(channel)
        this.releaseDeferred(channel)
      }
      return
    }
    if (status !== 0x90 && status !== 0x80) return
    const key = channel * 128 + note
    const message: NoteMessage = { type: status === 0x90 && velocity > 0 ? 'noteon' : 'noteoff', note, velocity, channel }
    if (message.type === 'noteon') {
      const previous = this.deferred.get(key) ?? this.held.get(key)
      if (previous) this.emit({ ...previous, type: 'noteoff', velocity: 0 })
      this.deferred.delete(key)
      this.held.set(key, message)
      this.emit(message)
    } else {
      if (!this.held.delete(key)) return
      if (this.pedals.has(channel)) this.deferred.set(key, message)
      else this.emit(message)
    }
  }

  private releaseDeferred(channel: number) {
    for (const [key, message] of this.deferred) {
      if (message.channel !== channel) continue
      this.emit(message)
      this.deferred.delete(key)
    }
  }

  panic(channel?: number) {
    for (const [key, message] of this.held) {
      if (channel !== undefined && message.channel !== channel) continue
      this.emit({ ...message, type: 'noteoff', velocity: 0 })
      this.held.delete(key)
    }
    for (const [key, message] of this.deferred) {
      if (channel !== undefined && message.channel !== channel) continue
      this.emit({ ...message, type: 'noteoff', velocity: 0 })
      this.deferred.delete(key)
    }
    if (channel === undefined) this.pedals.clear()
    else this.pedals.delete(channel)
  }
}
