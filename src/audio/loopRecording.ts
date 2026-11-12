export function loopSlices(first: number, count: number, framesPerPass: number, passes: number) {
  if (![first, count, framesPerPass, passes].every(Number.isSafeInteger) || first < 0 || count < 0 || framesPerPass <= 0 || passes <= 0)
    throw new Error('Intervalo de captura em loop inválido.')
  const slices: Array<{ pass: number; offset: number; firstFrame: number; frameCount: number }> = []
  const end = Math.min(first + count, framesPerPass * passes)
  for (let cursor = first; cursor < end;) {
    const pass = Math.floor(cursor / framesPerPass)
    const firstFrame = cursor - pass * framesPerPass
    const frameCount = Math.min(end - cursor, framesPerPass - firstFrame)
    slices.push({ pass, offset: cursor - first, firstFrame, frameCount })
    cursor += frameCount
  }
  return slices
}
