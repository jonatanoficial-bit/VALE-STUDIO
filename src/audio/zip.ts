export type ZipEntry = {
  name: string
  blob: Blob
}

type PreparedEntry = {
  name: Uint8Array
  data: Uint8Array
  crc32: number
  offset: number
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function writeUint16(bytes: Uint8Array, offset: number, value: number): void {
  new DataView(bytes.buffer).setUint16(offset, value, true)
}

function writeUint32(bytes: Uint8Array, offset: number, value: number): void {
  new DataView(bytes.buffer).setUint32(offset, value, true)
}

function toBlobPart(bytes: Uint8Array): ArrayBuffer {
  return new Uint8Array(bytes).buffer
}

function localHeader(entry: PreparedEntry): Uint8Array {
  const header = new Uint8Array(30 + entry.name.length)
  writeUint32(header, 0, 0x04034b50)
  writeUint16(header, 4, 20)
  writeUint16(header, 6, 0x0800)
  writeUint16(header, 8, 0)
  writeUint32(header, 14, entry.crc32)
  writeUint32(header, 18, entry.data.length)
  writeUint32(header, 22, entry.data.length)
  writeUint16(header, 26, entry.name.length)
  entry.name.forEach((value, index) => { header[30 + index] = value })
  return header
}

function centralHeader(entry: PreparedEntry): Uint8Array {
  const header = new Uint8Array(46 + entry.name.length)
  writeUint32(header, 0, 0x02014b50)
  writeUint16(header, 4, 20)
  writeUint16(header, 6, 20)
  writeUint16(header, 8, 0x0800)
  writeUint16(header, 10, 0)
  writeUint32(header, 16, entry.crc32)
  writeUint32(header, 20, entry.data.length)
  writeUint32(header, 24, entry.data.length)
  writeUint16(header, 28, entry.name.length)
  writeUint32(header, 42, entry.offset)
  entry.name.forEach((value, index) => { header[46 + index] = value })
  return header
}

/** Creates a standards-compliant uncompressed ZIP without sending audio to a service. */
export async function createZip(entries: ZipEntry[]): Promise<Blob> {
  if (entries.length === 0) throw new Error('Não há arquivos para incluir no ZIP.')
  if (entries.length > 0xffff) throw new Error('Este ZIP possui arquivos demais.')
  const encoder = new TextEncoder()
  const prepared: PreparedEntry[] = []
  let offset = 0

  for (const entry of entries) {
    const name = encoder.encode(entry.name)
    if (!name.length || name.length > 0xffff) throw new Error('Um nome de stem não pode ser incluído no ZIP.')
    const data = new Uint8Array(await entry.blob.arrayBuffer())
    if (data.length > 0xffffffff) throw new Error('Um stem excede o limite deste exportador ZIP.')
    const preparedEntry = { name, data, crc32: crc32(data), offset }
    prepared.push(preparedEntry)
    offset += localHeader(preparedEntry).length + data.length
  }

  const centralOffset = offset
  const central = prepared.map(centralHeader)
  const centralSize = central.reduce((size, header) => size + header.length, 0)
  if (centralOffset > 0xffffffff || centralSize > 0xffffffff) throw new Error('O conjunto de stems excede o limite deste exportador ZIP.')
  const end = new Uint8Array(22)
  writeUint32(end, 0, 0x06054b50)
  writeUint16(end, 8, prepared.length)
  writeUint16(end, 10, prepared.length)
  writeUint32(end, 12, centralSize)
  writeUint32(end, 16, centralOffset)

  const parts: BlobPart[] = []
  prepared.forEach((entry) => parts.push(toBlobPart(localHeader(entry)), toBlobPart(entry.data)))
  parts.push(...central.map(toBlobPart), toBlobPart(end))
  return new Blob(parts, { type: 'application/zip' })
}
