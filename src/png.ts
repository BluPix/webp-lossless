// PNG decoding for converting to WebP: 8 bits per channel, not interlaced, any color type. It runs as
// plain code rather than through a canvas, so the pixels are exactly the file's: no color management, no
// premultiplied alpha, no noise that privacy settings add to canvas reads. Anything else is left alone (null).
// Memory is kept to the pixels: rows are decompressed, unfiltered and converted one at a time, as a 20 megapixel
// photo would otherwise hold another 60–80 MB of decompressed rows.

export interface DecodedPng {
  width: number
  height: number
  argb: Uint32Array<ArrayBuffer> // one 0xAARRGGBB value per pixel, as the WebP encoder takes them
  iccProfile?: Uint8Array<ArrayBuffer> // the embedded color profile, to carry along
}

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10]
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } // gray, RGB, palette, gray + alpha, RGBA
const MAX_DIMENSION = 16384 // what WebP can hold

const inflate = async (data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> =>
  new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer())

// exifRotates tells whether an eXIf chunk turns or mirrors the image (orientation other than 1), which WebP
// would not carry over
const exifRotates = (exif: Uint8Array): boolean => {
  if (exif.length < 8) return false
  const view = new DataView(exif.buffer, exif.byteOffset, exif.byteLength)
  const little = exif[0] === 0x49 // "II"
  const ifd = view.getUint32(4, little)
  if (ifd + 2 > exif.length) return false
  const entries = view.getUint16(ifd, little)
  for (let k = 0, at = ifd + 2; k < entries && at + 12 <= exif.length; k++, at += 12) {
    if (view.getUint16(at, little) === 0x0112) return view.getUint16(at + 8, little) !== 1
  }
  return false
}

const paeth = (a: number, b: number, c: number): number => {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

// unfilterRow undoes a row's filter in place: row[0] is the filter, the samples follow; above holds the row above's
// samples (zeros for the first). false on an unknown filter.
const unfilterRow = (row: Uint8Array, above: Uint8Array, bpp: number): boolean => {
  const filter = row[0]
  for (let x = 0; x < above.length; x++) {
    const a = x >= bpp ? row[x + 1 - bpp] : 0
    const b = above[x]
    switch (filter) {
      case 0: return true
      case 1: row[x + 1] += a; break
      case 2: row[x + 1] += b; break
      case 3: row[x + 1] += (a + b) >> 1; break
      case 4: row[x + 1] += paeth(a, b, x >= bpp ? above[x - bpp] : 0); break
      default: return false
    }
  }
  return true
}

// inflateRows decompresses zlib data, given in pieces, row by row: each row is unfiltered as soon as it is complete
// and handed to onRow (its samples, valid until the next row), holding only two rows at a time. false when the data
// is broken, a filter unknown, or there are more or fewer rows than height.
const inflateRows = async (
  pieces: Uint8Array<ArrayBuffer>[],
  height: number,
  stride: number,
  bpp: number,
  onRow: (samples: Uint8Array, y: number) => boolean,
): Promise<boolean> => {
  const stream = new DecompressionStream('deflate')
  const writer = stream.writable.getWriter()
  const writing = (async () => {
    for (const piece of pieces) await writer.write(piece)
    await writer.close()
  })().catch(() => {})
  const reader = stream.readable.getReader()
  let row = new Uint8Array(stride + 1)
  let above = new Uint8Array(stride + 1) // its samples start at 1; zeros for the first row
  let filled = 0
  let y = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      for (let k = 0; k < value.length; ) {
        if (y === height) {
          await reader.cancel()
          return false
        }
        const take = Math.min(stride + 1 - filled, value.length - k)
        row.set(value.subarray(k, k + take), filled)
        filled += take
        k += take
        if (filled < stride + 1) continue
        if (!unfilterRow(row, above.subarray(1), bpp) || !onRow(row.subarray(1), y)) {
          await reader.cancel()
          return false
        }
        ;[row, above] = [above, row]
        filled = 0
        y++
      }
    }
  } catch {
    return false
  }
  await writing
  return y === height && filled === 0
}

export const decodePng = async (bytes: Uint8Array<ArrayBuffer>): Promise<DecodedPng | null> => {
  if (bytes.length < 8 || SIGNATURE.some((v, i) => bytes[i] !== v)) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let header: Uint8Array | null = null
  let palette: Uint8Array | null = null
  let transparency: Uint8Array | null = null
  let iccProfile: Uint8Array<ArrayBuffer> | undefined
  let srgb = false
  let otherColorSpace = false // gamma, primaries or HDR info without a profile: WebP could not say the same
  const idat: Uint8Array<ArrayBuffer>[] = []
  for (let at = 8; at + 12 <= bytes.length; ) {
    const length = view.getUint32(at)
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8))
    const data = bytes.subarray(at + 8, at + 8 + length)
    if (data.length !== length) return null
    at += 12 + length
    if (type === 'IEND') break
    if (type === 'IHDR') header = data
    else if (type === 'PLTE') palette = data
    else if (type === 'tRNS') transparency = data
    else if (type === 'IDAT') idat.push(data)
    else if (type === 'sRGB') srgb = true
    else if (type === 'gAMA' || type === 'cHRM' || type === 'cICP' || type === 'mDCV' || type === 'cLLI') otherColorSpace = true
    else if (type === 'eXIf' && exifRotates(data)) return null
    else if (type === 'iCCP') {
      const nameEnd = data.indexOf(0)
      if (nameEnd < 1 || data[nameEnd + 1] !== 0) return null
      iccProfile = await inflate(data.subarray(nameEnd + 2))
    }
  }
  if (!header || header.length < 13 || !idat.length) return null
  const h = new DataView(header.buffer, header.byteOffset, header.byteLength)
  const width = h.getUint32(0)
  const height = h.getUint32(4)
  const [depth, colorType, compression, filterMethod, interlace] = header.subarray(8, 13)
  const channels = CHANNELS[colorType]
  if (!width || !height || width > MAX_DIMENSION || height > MAX_DIMENSION) return null
  if (depth !== 8 || !channels || compression || filterMethod || interlace) return null
  if (otherColorSpace && !iccProfile && !srgb) return null
  if (colorType === 3 ? !palette : transparency) return null // a palette is needed; a transparent color key is not supported

  // A palette as ready pixels; indices past its end make the file invalid
  let colors: Uint32Array | null = null
  if (colorType === 3) {
    colors = new Uint32Array(palette!.length / 3)
    for (let k = 0; k < colors.length; k++) {
      const alpha = transparency && k < transparency.length ? transparency[k] : 255
      colors[k] = ((alpha << 24) | (palette![3 * k] << 16) | (palette![3 * k + 1] << 8) | palette![3 * k + 2]) >>> 0
    }
  }
  const argb = new Uint32Array(width * height)
  const toPixels = (samples: Uint8Array, y: number): boolean => {
    for (let x = 0, i = y * width, s = 0; x < width; x++, i++, s += channels) {
      if (colorType === 6) argb[i] = ((samples[s + 3] << 24) | (samples[s] << 16) | (samples[s + 1] << 8) | samples[s + 2]) >>> 0
      else if (colorType === 2) argb[i] = (0xff000000 | (samples[s] << 16) | (samples[s + 1] << 8) | samples[s + 2]) >>> 0
      else if (colorType === 3) {
        if (samples[s] >= colors!.length) return false
        argb[i] = colors![samples[s]]
      } else {
        const v = samples[s]
        argb[i] = (((colorType === 4 ? samples[s + 1] : 255) << 24) | (v << 16) | (v << 8) | v) >>> 0
      }
    }
    return true
  }
  if (!(await inflateRows(idat, height, width * channels, channels, toPixels))) return null
  return { width, height, argb, ...(iccProfile && { iccProfile }) }
}
