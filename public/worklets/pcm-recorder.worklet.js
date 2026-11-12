class PcmRecorderProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super()
    this.capturing = true
    this.waiting = options?.processorOptions?.waitForWindow === true
    this.window = undefined
    this.port.onmessage = ({ data }) => {
      if (data.type === 'window' && this.waiting) {
        this.window = { start: data.start, end: data.end, next: data.start }
        this.waiting = false
      }
      if (data.type === 'stop') {
        this.capturing = false
        this.port.postMessage({ type: 'flushed' })
      }
    }
  }

  process(inputs, outputs) {
    const input = inputs[0]
    const output = outputs[0]

    if (output) output.forEach((channel) => channel.fill(0))
    if (!this.capturing || this.waiting) return true

    const frames = output?.[0]?.length ?? input?.[0]?.length ?? 128
    const start = this.window ? Math.max(0, this.window.start - currentFrame) : 0
    const end = this.window ? Math.min(frames, this.window.end - currentFrame) : frames
    if (this.window && end > start && (currentFrame + start !== this.window.next || !input?.length || input.some((channel) => channel.length < end))) {
      this.capturing = false
      this.port.postMessage({ type: 'window-ended', interrupted: true,
        reason: currentFrame + start !== this.window.next ? `A captura perdeu sincronismo no frame ${this.window.next} (recebido ${currentFrame + start}).` : 'A entrada deixou de entregar blocos completos.' })
      return true
    }
    if (input?.length && end > start) {
      const channels = input.map((channel) => channel.slice(start, end).buffer)
      this.port.postMessage({ type: 'pcm', channels }, channels)
      if (this.window) this.window.next += end - start
    }
    if (this.window && currentFrame + frames >= this.window.end) {
      this.capturing = false
      this.port.postMessage({ type: 'window-ended', interrupted: this.window.next !== this.window.end,
        reason: this.window.next !== this.window.end ? 'A captura terminou antes de receber todo o intervalo.' : undefined })
    }
    return true
  }
}

registerProcessor('vale-pcm-recorder', PcmRecorderProcessor)
