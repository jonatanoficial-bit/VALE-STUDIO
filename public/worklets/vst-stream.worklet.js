class ValeVstStream extends AudioWorkletProcessor {
  constructor(options) {
    super()
    this.frames = options.processorOptions.frames
    this.instrument = options.processorOptions.instrument
    this.pcm = new Float32Array(this.frames * 2)
    this.results = new Map()
    this.dry = new Map()
    this.events = []
    this.position = 0
    this.sequence = 0
    this.inFlight = 0
    this.failed = false
    this.misses = 0
    this.port.onmessage = ({ data }) => {
      if (data.type === 'events') {
        this.events.push(...data.events)
        this.events.sort((a, b) => a.frame - b.frame)
      }
      if (data.type === 'result') {
        this.inFlight -= 1
        const next = this.sequence - 3 + (this.position > 0 ? 1 : 0)
        if (data.sequence >= next) this.results.set(data.sequence, data.pcm)
      }
      if (data.type === 'failed') this.failed = true
    }
  }

  process(inputs, outputs) {
    const [left, right = left] = inputs[0] ?? []
    const [outLeft, outRight] = outputs[0]
    for (let i = 0; i < outLeft.length; i += 1) {
      if (this.position === 0) {
        const sequence = this.sequence - 3
        const rendered = this.results.get(sequence)
        this.output = rendered ?? (!this.instrument ? this.dry.get(sequence) : undefined)
        if (sequence >= 0 && !this.failed) {
          this.misses = rendered ? 0 : this.misses + 1
          if (this.misses === 6) this.port.postMessage({ type: 'late' })
        }
        this.results.delete(sequence)
        this.dry.delete(sequence)
      }
      const sample = this.position * 2
      this.pcm[sample] = left?.[i] ?? 0
      this.pcm[sample + 1] = right?.[i] ?? 0
      outLeft[i] = this.output?.[sample] ?? 0
      outRight[i] = this.output?.[sample + 1] ?? 0
      this.position += 1
      if (this.position !== this.frames) continue

      const sequence = this.sequence++
      const end = currentFrame + i + 1
      const start = end - this.frames
      const firstFuture = this.events.findIndex((event) => event.frame >= end)
      const events = this.events.splice(0, firstFuture < 0 ? this.events.length : firstFuture)
      if (!this.instrument) this.dry.set(sequence, this.pcm)
      if (!this.failed && this.inFlight < 3) {
        this.inFlight += 1
        this.port.postMessage({
          type: 'block',
          sequence,
          pcm: this.pcm,
          events: events.map((event) => [Math.max(0, event.frame - start), event.note, event.velocity, event.channel]),
        })
      } else if (events.length && !this.failed) {
        // Retain note-off messages if the host is temporarily behind.
        this.events.unshift(...events)
      }
      this.pcm = new Float32Array(this.frames * 2)
      this.position = 0
    }
    return true
  }
}

registerProcessor('vale-vst-stream', ValeVstStream)
