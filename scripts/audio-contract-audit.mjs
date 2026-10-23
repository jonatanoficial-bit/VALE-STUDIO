import { readFile } from 'node:fs/promises'

const files = ['src/audio/AudioEngine.ts', 'src/audio/wav.ts', 'public/worklets/pcm-recorder.worklet.js', 'src/storage/projectRepository.ts']
const text = await Promise.all(files.map((file) => readFile(file, 'utf8'))).then((parts) => parts.join('\n'))
const required = ['AudioWorkletNode', 'MediaStreamAudioSourceNode', 'OfflineAudioContext', 'Mp3Encoder', "'RIFF'", "'WAVE'", 'takeDrafts', 'commitTake', 'applyClipEnvelope', 'shouldPlayClip']
const missing = required.filter((term) => !text.includes(term))

if (text.includes('ScriptProcessorNode')) throw new Error('Auditoria falhou: ScriptProcessorNode não é permitido como motor de captura.')
if (missing.length) throw new Error(`Auditoria falhou: contratos ausentes: ${missing.join(', ')}`)
console.log('PASS: contratos de captura, journal de take, render e containers de áudio presentes no código.')
