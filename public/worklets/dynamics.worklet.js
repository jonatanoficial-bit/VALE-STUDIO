/* global AudioWorkletProcessor, registerProcessor, sampleRate */

class ValeDynamics extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'enabled', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'thresholdDb', defaultValue: -48, minValue: -80, maxValue: 0, automationRate: 'k-rate' },
      { name: 'releaseMs', defaultValue: 100, minValue: 10, maxValue: 1000, automationRate: 'k-rate' },
      { name: 'depthDb', defaultValue: -60, minValue: -80, maxValue: 0, automationRate: 'k-rate' },
    ]
  }

  constructor(options) {
    super()
    this.limiter = options.processorOptions?.mode === 'limiter'
    this.gain = 1
    this.open = false
    this.hold = 0
    this.active = false
  }

  process(inputs, outputs, params) {
    const input = inputs[0]
    const output = outputs[0]
    if (!output.length || !input.length) return true
    const enabled = params.enabled[0] >= 0.5
    if (!enabled) {
      for (let channel = 0; channel < output.length; channel++) {
        if (input[channel]) output[channel].set(input[channel])
      }
      this.active = false
      return true
    }
    const threshold = 10 ** (params.thresholdDb[0] / 20)
    const floor = 10 ** (params.depthDb[0] / 20)
    const release = 1 - Math.exp(-1000 / (sampleRate * params.releaseMs[0]))
    const attack = 1 - Math.exp(-1000 / (sampleRate * 2))
    const holdFrames = Math.ceil(sampleRate * 0.015)
    if (!this.active) {
      this.gain = this.limiter ? 1 : floor
      this.open = false
      this.hold = 0
      this.active = true
    }
    for (let frame = 0; frame < output[0].length; frame++) {
      let peak = 0
      for (const channel of input) peak = Math.max(peak, Math.abs(channel[frame]))
      if (this.limiter) {
        const target = peak > threshold ? threshold / peak : 1
        this.gain = Math.min(target, this.gain + release * (1 - this.gain))
      } else {
        if (peak >= threshold) {
          this.open = true
          this.hold = holdFrames
        } else if (this.hold > 0) {
          this.hold -= 1
        } else if (peak < threshold * 0.707) {
          this.open = false
        }
        const target = this.open ? 1 : floor
        this.gain += (target - this.gain) * (this.open ? attack : release)
      }
      for (let channel = 0; channel < output.length; channel++) {
        output[channel][frame] = (input[channel]?.[frame] ?? 0) * this.gain
      }
    }
    return true
  }
}

registerProcessor('vale-dynamics', ValeDynamics)
