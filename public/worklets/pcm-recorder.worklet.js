class PcmRecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.capturing = true
    this.port.onmessage = ({ data }) => {
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
    if (!this.capturing || !input || !input.length || !input[0].length) return true

    const channels = input.map((channel) => channel.slice().buffer)
    this.port.postMessage({ type: 'pcm', channels }, channels)
    return true
  }
}

registerProcessor('vale-pcm-recorder', PcmRecorderProcessor)
