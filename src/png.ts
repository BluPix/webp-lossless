// PNG decoding for converting to WebP: every bit depth and color type, interlaced or not. It runs as plain code
// rather than through a canvas, so the pixels are exactly the file's: no color management, no premultiplied alpha,
// no noise that privacy settings add to canvas reads. 16-bit samples are taken when they are 8-bit ones widened
// (both bytes the same), as WebP holds 8 bits, and a transparent color key becomes alpha. What WebP would not show
// the same is left alone (null): 16-bit detail, an animation, a color space other than sRGB without a profile, an
// Exif orientation that turns the image. So is anything broken.
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
// The bit depths the specification allows for each color type
const DEPTHS: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] }
const MAX_DIMENSION = 16384 // what WebP can hold
// Adam7 interlacing: the first column and row of each of the seven passes and the steps between its pixels
const ADAM7 = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
]
// sRGB as gAMA and cHRM state it (×100 000; white, red, green, blue as x, y), the values the specification asks for
// next to an sRGB chunk. Tools such as ImageMagick write them without one.
const SRGB_GAMMA = 45455
const SRGB_CHROMATICITIES = [31270, 32900, 64000, 33000, 30000, 60000, 15000, 6000]

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

// srgbLike tells whether gAMA and cHRM, those that are there, say sRGB: gamma within 2 % (older tools write 0.45
// for 1/2.2), chromaticities within rounding. Any other color space WebP could only carry as a profile.
const srgbLike = (gamma: Uint8Array | null, chromaticities: Uint8Array | null): boolean => {
  const values = (data: Uint8Array) => Array.from({ length: data.length >> 2 }, (_, k) => new DataView(data.buffer, data.byteOffset).getUint32(4 * k))
  if (gamma && (gamma.length !== 4 || Math.abs(values(gamma)[0] - SRGB_GAMMA) > SRGB_GAMMA / 50)) return false
  if (chromaticities && (chromaticities.length !== 32 || values(chromaticities).some((v, k) => Math.abs(v - SRGB_CHROMATICITIES[k]) > 100))) return false
  return true
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

// Rows is how the decompressed data divides into rows: one sub-image, or Adam7's seven passes over an interlaced
// image, each its own run of rows filtered from zero above
interface Pass {
  x0: number
  y0: number
  dx: number
  dy: number
  width: number
  height: number
}

const passesOf = (width: number, height: number, interlaced: boolean): Pass[] =>
  (interlaced ? ADAM7 : [[0, 0, 1, 1]])
    .map(([x0, y0, dx, dy]) => ({ x0, y0, dx, dy, width: Math.ceil((width - x0) / dx), height: Math.ceil((height - y0) / dy) }))
    .filter(pass => pass.width > 0 && pass.height > 0)

// inflateRows decompresses zlib data, given in pieces, row by row: each row is unfiltered as soon as it is complete
// and handed to onRow (its samples, valid until the next row) with its pass and row in the pass, holding only two
// rows at a time. false when the data is broken, a filter unknown, or there are more or fewer rows than the passes.
const inflateRows = async (
  pieces: Uint8Array<ArrayBuffer>[],
  passes: { rows: number; stride: number }[],
  bpp: number,
  onRow: (samples: Uint8Array, pass: number, y: number) => boolean,
): Promise<boolean> => {
  const stream = new DecompressionStream('deflate')
  const writer = stream.writable.getWriter()
  const writing = (async () => {
    for (const piece of pieces) await writer.write(piece)
    await writer.close()
  })().catch(() => {})
  const reader = stream.readable.getReader()
  let pass = 0
  let { rows, stride } = passes[0]
  let row = new Uint8Array(stride + 1)
  let above = new Uint8Array(stride + 1) // its samples start at 1; zeros for a pass's first row
  let filled = 0
  let y = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      for (let k = 0; k < value.length; ) {
        if (pass === passes.length) {
          await reader.cancel()
          return false
        }
        const take = Math.min(stride + 1 - filled, value.length - k)
        row.set(value.subarray(k, k + take), filled)
        filled += take
        k += take
        if (filled < stride + 1) continue
        if (!unfilterRow(row, above.subarray(1), bpp) || !onRow(row.subarray(1), pass, y)) {
          await reader.cancel()
          return false
        }
        ;[row, above] = [above, row]
        filled = 0
        if (++y < rows) continue
        y = 0
        if (++pass < passes.length) {
          ;({ rows, stride } = passes[pass])
          row = new Uint8Array(stride + 1)
          above = new Uint8Array(stride + 1)
        }
      }
    }
  } catch {
    return false
  }
  await writing
  return pass === passes.length && filled === 0
}

// RowWriter turns a row of `count` pixels into 0xAARRGGBB values at out[at], out[at + step], …; false when the row
// holds what WebP cannot show the same (16-bit samples that are not 8-bit ones widened) or an index past the palette
type RowWriter = (samples: Uint8Array, count: number, out: Uint32Array, at: number, step: number) => boolean

// readSample gives sample i of a row: packed several to a byte below 8 bits, two bytes (big-endian) at 16
const readSample = (depth: number): ((samples: Uint8Array, i: number) => number) => {
  if (depth === 8) return (samples, i) => samples[i]
  if (depth === 16) return (samples, i) => (samples[2 * i] << 8) | samples[2 * i + 1]
  const mask = (1 << depth) - 1
  return (samples, i) => (samples[(i * depth) >> 3] >> (8 - depth - ((i * depth) & 7))) & mask
}

const rowWriter = (colorType: number, depth: number, palette: Uint8Array | null, transparency: Uint8Array | null): RowWriter | null => {
  const read = readSample(depth)
  if (colorType === 3) {
    // A palette as ready pixels; an index past its end makes the file invalid. Colors past what the bit depth can
    // index are against the specification but cannot show, so they are left out of it rather than the file refused.
    if (!palette || !palette.length || palette.length % 3 || palette.length > 3 * 256) return null
    const colors = new Uint32Array(palette.length / 3)
    if (transparency && transparency.length > colors.length) return null
    for (let k = 0; k < colors.length; k++) {
      const alpha = transparency && k < transparency.length ? transparency[k] : 255
      colors[k] = ((alpha << 24) | (palette[3 * k] << 16) | (palette[3 * k + 1] << 8) | palette[3 * k + 2]) >>> 0
    }
    return (samples, count, out, at, step) => {
      for (let x = 0, i = at; x < count; x++, i += step) {
        const index = depth === 8 ? samples[x] : read(samples, x)
        if (index >= colors.length) return false
        out[i] = colors[index]
      }
      return true
    }
  }
  const channels = CHANNELS[colorType]
  // A transparent color key (gray or RGB only, which have no alpha): the raw samples of the transparent pixels
  if (transparency && (colorType & 4 || transparency.length !== 2 * channels)) return null
  const key = transparency && Array.from({ length: channels }, (_, c) => (transparency[2 * c] << 8) | transparency[2 * c + 1])
  // Samples below 8 bits (gray only) scale to 0–255 exactly: by 255, 85 or 17
  const scale = depth < 8 ? 255 / ((1 << depth) - 1) : 1
  const value = [0, 0, 0, 0]
  return (samples, count, out, at, step) => {
    for (let x = 0, s = 0, i = at; x < count; x++, s += channels, i += step) {
      let keyed = key !== null
      for (let c = 0; c < channels; c++) {
        const v = read(samples, s + c)
        if (keyed && v !== key![c]) keyed = false
        if (depth === 16) {
          if (v >> 8 !== (v & 255)) return false
          value[c] = v >> 8
        } else value[c] = v * scale
      }
      const [r, g, b] = channels >= 3 ? value : [value[0], value[0], value[0]]
      const alpha = keyed ? 0 : colorType === 4 ? value[1] : colorType === 6 ? value[3] : 255
      out[i] = ((alpha << 24) | (r << 16) | (g << 8) | b) >>> 0
    }
    return true
  }
}

// rgba8 is the fast way for 8-bit color types without a color key, where samples are bytes
const rgba8 = (colorType: number): RowWriter | null => {
  if (colorType === 6) {
    return (s, count, out, at, step) => {
      for (let x = 0, j = 0, i = at; x < count; x++, j += 4, i += step) out[i] = ((s[j + 3] << 24) | (s[j] << 16) | (s[j + 1] << 8) | s[j + 2]) >>> 0
      return true
    }
  }
  if (colorType === 2) {
    return (s, count, out, at, step) => {
      for (let x = 0, j = 0, i = at; x < count; x++, j += 3, i += step) out[i] = (0xff000000 | (s[j] << 16) | (s[j + 1] << 8) | s[j + 2]) >>> 0
      return true
    }
  }
  if (colorType === 0 || colorType === 4) {
    const alpha = colorType === 4
    return (s, count, out, at, step) => {
      for (let x = 0, j = 0, i = at; x < count; x++, j += alpha ? 2 : 1, i += step) {
        const v = s[j]
        out[i] = (((alpha ? s[j + 1] : 255) << 24) | (v << 16) | (v << 8) | v) >>> 0
      }
      return true
    }
  }
  return null
}

export const decodePng = async (bytes: Uint8Array<ArrayBuffer>): Promise<DecodedPng | null> => {
  if (bytes.length < 8 || SIGNATURE.some((v, i) => bytes[i] !== v)) return null
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let header: Uint8Array | null = null
  let palette: Uint8Array | null = null
  let transparency: Uint8Array | null = null
  let iccProfile: Uint8Array<ArrayBuffer> | undefined
  let srgb = false
  let gamma: Uint8Array | null = null
  let chromaticities: Uint8Array | null = null
  let cicp: Uint8Array | null = null
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
    else if (type === 'gAMA') gamma = data
    else if (type === 'cHRM') chromaticities = data
    else if (type === 'cICP') cicp = data
    // An animation (APNG): WebP can animate too, but converting one is a feature of its own
    else if (type === 'acTL') return null
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
  if (!width || !height || width > MAX_DIMENSION || height > MAX_DIMENSION) return null
  if (!DEPTHS[colorType]?.includes(depth) || compression || filterMethod || interlace > 1) return null

  // The color space, the chunks ranked as the specification ranks them: cICP first (only sRGB fits WebP, not HDR or
  // video systems), then the profile, then sRGB, then gAMA and cHRM. mDCV and cLLI only go with cICP.
  if (cicp) {
    if (cicp.length !== 4 || cicp[0] !== 1 || cicp[1] !== 13 || cicp[2] !== 0 || cicp[3] !== 1) return null
    iccProfile = undefined
  } else if (!iccProfile && !srgb && !srgbLike(gamma, chromaticities)) return null

  const write = (depth === 8 && !transparency && rgba8(colorType)) || rowWriter(colorType, depth, palette, transparency)
  if (!write) return null
  const channels = CHANNELS[colorType]
  const passes = passesOf(width, height, interlace === 1)
  const argb = new Uint32Array(width * height)
  const rows = passes.map(pass => ({ rows: pass.height, stride: Math.ceil((pass.width * channels * depth) / 8) }))
  const toPixels = (samples: Uint8Array, k: number, y: number): boolean => {
    const { x0, y0, dx, dy, width: count } = passes[k]
    return write(samples, count, argb, (y0 + y * dy) * width + x0, dx)
  }
  if (!(await inflateRows(idat, rows, Math.max(1, (channels * depth) >> 3), toPixels))) return null
  return { width, height, argb, ...(iccProfile && { iccProfile }) }
}
