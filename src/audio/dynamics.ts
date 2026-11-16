import type { GateSettings, LimiterSettings } from '../domain/model'

export const DEFAULT_GATE: GateSettings = { enabled: false, thresholdDb: -48, depthDb: -60, releaseMs: 100 }
export const DEFAULT_LIMITER: LimiterSettings = { enabled: false, ceilingDb: -1, releaseMs: 100 }

const worklets = new WeakMap<BaseAudioContext, Promise<void>>()

export function loadDynamics(context: BaseAudioContext): Promise<void> {
  if (!context.audioWorklet) throw new Error('Gate e limiter requerem suporte a AudioWorklet.')
  const pending = worklets.get(context)
  if (pending) return pending
  const result = context.audioWorklet.addModule(`${import.meta.env.BASE_URL}worklets/dynamics.worklet.js`).catch((error) => {
    worklets.delete(context)
    throw error
  })
  worklets.set(context, result)
  return result
}

type DynamicsMode = { mode: 'gate'; settings: GateSettings } | { mode: 'limiter'; settings: LimiterSettings }

export function setDynamics(node: AudioWorkletNode, config: DynamicsMode, time?: number) {
  const { mode, settings } = config
  const values = { enabled: Number(settings.enabled), releaseMs: settings.releaseMs,
    thresholdDb: mode === 'gate' ? config.settings.thresholdDb : config.settings.ceilingDb,
    depthDb: mode === 'gate' ? config.settings.depthDb : 0 }
  for (const [name, value] of Object.entries(values)) {
    const parameter = node.parameters.get(name)!
    if (time === undefined) parameter.value = value
    else if (name === 'enabled') parameter.setValueAtTime(value, time)
    else parameter.setTargetAtTime(value, time, 0.012)
  }
}

export function createDynamics(context: BaseAudioContext, config: DynamicsMode) {
  // Stereo speaker upmix preserves the mono level in the existing track graph.
  const node = new AudioWorkletNode(context, 'vale-dynamics', {
    numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
    channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers',
    processorOptions: { mode: config.mode },
  })
  setDynamics(node, config)
  return node
}
