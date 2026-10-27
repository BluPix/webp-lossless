// A lossless WebP (VP8L) encoder in plain TypeScript, without WebAssembly, for pages whose CSP forbids it. It follows
// https://developers.google.com/speed/webp/docs/webp_lossless_bitstream_specification with the transforms that pay
// off on screenshots: subtract green and a per-block predictor, then LZ77 with a color cache. Flat areas and
// repeated rows, which make up most of a screenshot, become long backward references.
import { BitWriter } from './bits.ts'
import { groupBlocks } from './groups.ts'
import { type PrefixCode, writePrefixCode } from './huffman.ts'

const NUM_LITERALS = 256
const NUM_LENGTH_CODES = 24
const NUM_DISTANCE_CODES = 40
const MAX_DIMENSION = 16384
const MAX_MATCH = 4096
const MIN_MATCH = 4
// A copy from farther than the 120 nearby neighbours costs a distance with up to 19 extra bits; shorter ones than
// this cost more than coding their pixels (libwebp weighs every copy by its cost on higher levels instead)
const MIN_FAR = 8
// Distances above this cannot be coded: the largest distance code is 1 048 576, of which 120 are the 2D codes
const MAX_DISTANCE = (1 << 20) - 120
const HASH_BITS = 18
// The hash chain only needs positions a distance code can reach, so it is a ring of 2^20 instead of one per pixel
const WINDOW_BITS = 20
const MAX_CHAIN = 24
const CACHE_BITS = 11
const PREDICTOR_BITS = 5 // 32 × 32 pixel blocks share a predictor
const COLOR_CACHE_MULTIPLIER = 0x1e35a7bd
// Prefix codes per group of blocks: at most this many blocks (as libwebp) and groups
const MAX_BLOCKS = 2600
const MAX_GROUPS = 32

// Distance codes 1–120 stand for these (dx, dy) neighbours, nearest first
const DISTANCE_OFFSETS = [
  0, 1, 1, 0, 1, 1, -1, 1, 0, 2, 2, 0, 1, 2, -1, 2, 2, 1, -2, 1, 2, 2, -2, 2, 0, 3, 3, 0, 1, 3, -1, 3, 3, 1, -3, 1,
  2, 3, -2, 3, 3, 2, -3, 2, 0, 4, 4, 0, 1, 4, -1, 4, 4, 1, -4, 1, 3, 3, -3, 3, 2, 4, -2, 4, 4, 2, -4, 2, 0, 5,
  3, 4, -3, 4, 4, 3, -4, 3, 5, 0, 1, 5, -1, 5, 5, 1, -5, 1, 2, 5, -2, 5, 5, 2, -5, 2, 4, 4, -4, 4, 3, 5, -3, 5,
  5, 3, -5, 3, 0, 6, 6, 0, 1, 6, -1, 6, 6, 1, -6, 1, 2, 6, -2, 6, 6, 2, -6, 2, 4, 5, -4, 5, 5, 4, -5, 4, 3, 6,
  -3, 6, 6, 3, -6, 3, 0, 7, 7, 0, 1, 7, -1, 7, 5, 5, -5, 5, 7, 1, -7, 1, 4, 6, -4, 6, 6, 4, -6, 4, 2, 7, -2, 7,
  7, 2, -7, 2, 3, 7, -3, 7, 7, 3, -7, 3, 5, 6, -5, 6, 6, 5, -6, 5, 8, 0, 4, 7, -4, 7, 7, 4, -7, 4, 8, 1, 8, 2,
  6, 6, -6, 6, 8, 3, 5, 7, -5, 7, 7, 5, -7, 5, 8, 4, 6, 7, -6, 7, 7, 6, -7, 6, 8, 5, 7, 7, -7, 7, 8, 6, 8, 7,
]

export interface EncodeOptions {
  // An ICC color profile to carry along, such as the one in a screenshot's PNG, so colors look the same
  iccProfile?: Uint8Array<ArrayBuffer>
  // Whether pixels are predicted from their neighbours; by default whichever codes smaller. Screenshots of text
  // mostly code smaller without, as libwebp finds too: letters repeat pixel for pixel, which LZ77 copies, while
  // their residuals change with the surroundings. Photos need the predictor.
  predictor?: boolean
  // Whether LZ77 searches the whole window for repeats (through a hash chain) or only copies runs from the pixel to
  // the left and the row above, as libwebp's RLE does; by default whichever codes smaller, as libwebp picks too.
  // Screenshots repeat letters far apart. Photos repeat little but in runs, and a far copy of a few pixels costs
  // more than coding them, so they come out smaller without the search, and in about half the time.
  search?: boolean
  // Whether blocks with different statistics get prefix codes of their own; by default when that is smaller
  groups?: boolean
}

// encodeLossless encodes RGBA pixels (4 bytes per pixel, not premultiplied) as a lossless WebP file. Every pixel
// decodes to exactly the value it had. Images over 16384 pixels on a side cannot be WebP and throw.
export const encodeLossless = (
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  options: EncodeOptions = {},
): Uint8Array<ArrayBuffer> => {
  if (width < 1 || height < 1 || width > MAX_DIMENSION || height > MAX_DIMENSION) {
    throw new RangeError(`WebP takes 1 to ${MAX_DIMENSION} pixels on a side, not ${width} × ${height}`)
  }
  if (rgba.length !== width * height * 4) throw new RangeError('Expected 4 bytes per pixel')
  const argb = new Uint32Array(width * height)
  for (let i = 0, j = 0; i < argb.length; i++, j += 4) {
    argb[i] = ((rgba[j + 3] << 24) | (rgba[j] << 16) | (rgba[j + 1] << 8) | rgba[j + 2]) >>> 0
  }
  return encodeArgb(argb, width, height, options)
}

// encodeArgb is encodeLossless for pixels packed as 0xAARRGGBB, which it takes over: they change while encoding
// (into residuals, in place), so a large image's pixels are never copied.
export const encodeArgb = (
  argb: Uint32Array,
  width: number,
  height: number,
  options: EncodeOptions = {},
): Uint8Array<ArrayBuffer> => {
  if (width < 1 || height < 1 || width > MAX_DIMENSION || height > MAX_DIMENSION) {
    throw new RangeError(`WebP takes 1 to ${MAX_DIMENSION} pixels on a side, not ${width} × ${height}`)
  }
  if (argb.length !== width * height) throw new RangeError('Expected one value per pixel')
  let hasAlpha = false
  for (let i = 0; i < argb.length && !hasAlpha; i++) hasAlpha = argb[i] >>> 24 !== 255

  subtractGreen(argb)
  // One array for the LZ77 tokens of whichever way is being planned: one per pixel at most
  const chosen = choosePlan(argb, width, height, options, new Uint32Array(argb.length))
  const best = options.groups === false ? chosen : chosen.grouped(options.groups)

  const bw = new BitWriter(Math.max(1 << 16, (best.bits >> 3) + 64))
  bw.write(0x2f, 8) // signature
  bw.write(width - 1, 14)
  bw.write(height - 1, 14)
  bw.write(hasAlpha ? 1 : 0, 1)
  bw.write(0, 3) // version
  // Transforms are undone in reverse order: green is added back last
  bw.write(1, 1)
  bw.write(2, 2) // subtract green
  best.write(bw)
  return container(bw.finish(), width, height, hasAlpha, options.iccProfile)
}

// Plan is part of the bitstream worked out but not yet written, with its exact size
interface Plan {
  bits: number
  write: (bw: BitWriter) => void
}
// ImagePlan uses one set of prefix codes; grouped() gives the same with codes per group of blocks, when that is
// smaller or forced
interface ImagePlan extends Plan {
  grouped: (force?: boolean) => Plan
}

// choosePlan decides on a sample of the image whether the predictor pays and which LZ77 codes smaller (unless
// asked for one way), then plans only that way for the whole image. Planning every way for all pixels would take
// several times as long.
const choosePlan = (argb: Uint32Array, width: number, height: number, options: EncodeOptions, tokens: Uint32Array): ImagePlan => {
  const { predictor, search } = options.predictor === undefined || options.search === undefined ? bestOnSample(argb, width, height, options, tokens) : (options as Way)
  return (predictor ? predicted : direct)(argb, width, height)(search, tokens)
}

interface Way {
  predictor: boolean
  search: boolean
}

// Images up to this many pixels are decided on all of them; larger ones on stripes of rows spread evenly over the
// image, an eighth of it but at least this many pixels. A stripe is a whole row of predictor blocks, so blocks are
// chosen as for the image itself.
const SAMPLE_PIXELS = 1 << 20
const SAMPLE_SHARE = 8
const STRIPE_ROWS = 1 << PREDICTOR_BITS

// sample copies the rows the predictor is decided on, so the image itself stays as it is
export const sample = (argb: Uint32Array, width: number, height: number): { pixels: Uint32Array; height: number } => {
  const stripes = Math.ceil(Math.max(SAMPLE_PIXELS, argb.length / SAMPLE_SHARE) / (width * STRIPE_ROWS))
  if (argb.length <= SAMPLE_PIXELS || stripes * STRIPE_ROWS * 2 > height) return { pixels: argb.slice(), height }
  const pixels = new Uint32Array(stripes * STRIPE_ROWS * width)
  for (let k = 0; k < stripes; k++) {
    // the middle of each of `stripes` equal parts, on a block boundary
    const top = Math.floor(((k + 0.5) * height) / stripes / STRIPE_ROWS) * STRIPE_ROWS
    pixels.set(argb.subarray(top * width, (top + STRIPE_ROWS) * width), k * STRIPE_ROWS * width)
  }
  return { pixels, height: stripes * STRIPE_ROWS }
}

// bestOnSample plans the sample every way not fixed by the options, with one set of prefix codes, and returns the
// smallest; on a tie the way without the predictor and with the search. The tokens array is only scratch here.
const bestOnSample = (argb: Uint32Array, width: number, height: number, options: EncodeOptions, tokens: Uint32Array): Way => {
  const part = sample(argb, width, height)
  let best: Way = { predictor: false, search: true }
  let bestBits = Infinity
  // the way without the predictor comes first, as the predictor turns the sample into residuals
  for (const predictor of options.predictor === undefined ? [false, true] : [options.predictor]) {
    const plan = (predictor ? predicted : direct)(part.pixels, width, part.height)
    for (const search of options.search === undefined ? [true, false] : [options.search]) {
      const bits = plan(search, tokens).bits
      if (bits < bestBits) {
        bestBits = bits
        best = { predictor, search }
      }
    }
  }
  return best
}

// withImage puts transforms written by `before` (with their size) in front of a planned main image
const withImage = (beforeBits: number, before: (bw: BitWriter) => void, image: ImagePlan): ImagePlan => {
  const of = (plan: Plan): Plan => ({
    bits: beforeBits + plan.bits,
    write: bw => {
      before(bw)
      plan.write(bw)
    },
  })
  return { ...of(image), grouped: force => of(image.grouped(force)) }
}

// direct codes the pixels as they are after subtract green. It returns how to plan them with either LZ77.
const direct = (argb: Uint32Array, width: number, height: number) => (search: boolean, tokens: Uint32Array): ImagePlan =>
  withImage(1, bw => bw.write(0, 1) /* no more transforms */, planImage(argb, width, height, true, tokens, search))

// predicted codes each pixel's difference from a prediction, the predictors chosen per block. The pixels become
// the residuals straight away; it returns how to plan them with either LZ77.
const predicted = (argb: Uint32Array, width: number, height: number) => {
  const { modes, tilesX } = predict(argb, width, height)
  const modeImage = planImage(modes, tilesX, modes.length / tilesX, false)
  return (search: boolean, tokens: Uint32Array): ImagePlan =>
    withImage(
      1 + 2 + 3 + modeImage.bits + 1,
      bw => {
        bw.write(1, 1)
        bw.write(0, 2) // predictor
        bw.write(PREDICTOR_BITS - 2, 3)
        modeImage.write(bw)
        bw.write(0, 1) // no more transforms
      },
      planImage(argb, width, height, true, tokens, search),
    )
}

// subtractGreen leaves red and blue as differences from green, which they mostly follow
const subtractGreen = (argb: Uint32Array): void => {
  for (let i = 0; i < argb.length; i++) {
    const p = argb[i]
    const green = (p >>> 8) & 0xff
    const redBlue = ((p & 0x00ff00ff) | 0xff00ff00) - ((green << 16) | green)
    argb[i] = ((p & 0xff00ff00) | (redBlue & 0x00ff00ff)) >>> 0
  }
}

// The predictors work on each channel alone, except modes 0 and 11, so they run on the bytes of the pixels. Small
// integers stay unboxed in JavaScript engines; a whole pixel (0xff…… when opaque) is too large for that and
// slowed down every function call it crossed.
const clip255 = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : v)
// half rounds toward zero, as the format's ClampAddSubtractHalf divides
const half = (v: number): number => (v + (v >>> 31)) >> 1
const clampAddSubtractHalf = (l: number, t: number, tl: number): number => {
  const average = (l + t) >> 1
  return clip255(average + half(average - tl))
}
// channelPrediction is one channel's prediction from the same channel of the left, top, top-left and top-right
// neighbours: the predictors of the format, but 0 and 11
const channelPrediction = (mode: number, l: number, t: number, tl: number, tr: number): number => {
  switch (mode) {
    case 1: return l
    case 2: return t
    case 3: return tr
    case 4: return tl
    case 5: return (((l + tr) >> 1) + t) >> 1
    case 6: return (l + tl) >> 1
    case 7: return (l + t) >> 1
    case 8: return (tl + t) >> 1
    case 9: return (t + tr) >> 1
    case 10: return (((l + tl) >> 1) + ((t + tr) >> 1)) >> 1
    case 12: return clip255(l + t - tl)
    default: return clampAddSubtractHalf(l, t, tl)
  }
}
// Mode 0 predicts opaque black: 255 in the alpha byte, wherever the platform keeps it, 0 in the others
const ALPHA_BYTE = new Uint8Array(Uint32Array.of(0xff000000).buffer).indexOf(0xff)
// selected is where mode 11 (Select) takes the pixel at byte j from: the left neighbour or the top one, `up` bytes
// before
const selected = (u8: Uint8Array, j: number, up: number): number => {
  let toLeft = 0 // how far the gradient estimate is from left: |top - topLeft| per channel
  let toTop = 0
  for (let k = j; k < j + 4; k++) {
    const tl = u8[k - up - 4]
    toLeft += Math.abs(u8[k - up] - tl)
    toTop += Math.abs(u8[k - 4] - tl)
  }
  return toLeft < toTop ? j - 4 : j - up
}

// What a residual costs, roughly: the bits of each channel's distance from zero
const RESIDUAL_COST = Float64Array.from({ length: 256 }, (_, v) => Math.log2(1 + Math.min(v, 256 - v)))

// rowCost adds to `cost` what the residuals of one mode cost from byte j to end, within a row; `up` is a row in
// bytes. Each mode has a loop of its own, which keeps the loops small enough to compile well. The sum carries on
// from pixel to pixel, so equal costs of two modes come out equal and the first of them wins.
const rowCost = (u8: Uint8Array, mode: number, j: number, end: number, up: number, cost: number): number => {
  const C = RESIDUAL_COST
  const ul = up + 4 // back to the top-left neighbour
  const ur = up - 4 // back to the top-right one
  switch (mode) {
    case 0: for (; j < end; j += 4) { let c = 0; for (let k = j; k < j + 4; k++) c += C[(u8[k] - ((k & 3) === ALPHA_BYTE ? 255 : 0)) & 255]; cost += c } break
    case 1: for (; j < end; j += 4) { let c = 0; for (let k = j; k < j + 4; k++) c += C[(u8[k] - u8[k - 4]) & 255]; cost += c } break
    case 2: for (; j < end; j += 4) { let c = 0; for (let k = j; k < j + 4; k++) c += C[(u8[k] - u8[k - up]) & 255]; cost += c } break
    case 3: for (; j < end; j += 4) { let c = 0; for (let k = j; k < j + 4; k++) c += C[(u8[k] - u8[k - ur]) & 255]; cost += c } break
    case 4: for (; j < end; j += 4) { let c = 0; for (let k = j; k < j + 4; k++) c += C[(u8[k] - u8[k - ul]) & 255]; cost += c } break
    case 5: for (; j < end; j += 4) { let c = 0; for (let k = j; k < j + 4; k++) c += C[(u8[k] - ((((u8[k - 4] + u8[k - ur]) >> 1) + u8[k - up]) >> 1)) & 255]; cost += c } break
    case 6: for (; j < end; j += 4) { let c = 0; for (let k = j; k < j + 4; k++) c += C[(u8[k] - ((u8[k - 4] + u8[k - ul]) >> 1)) & 255]; cost += c } break
    case 7: for (; j < end; j += 4) { let c = 0; for (let k = j; k < j + 4; k++) c += C[(u8[k] - ((u8[k - 4] + u8[k - up]) >> 1)) & 255]; cost += c } break
    case 8: for (; j < end; j += 4) { let c = 0; for (let k = j; k < j + 4; k++) c += C[(u8[k] - ((u8[k - ul] + u8[k - up]) >> 1)) & 255]; cost += c } break
    case 9: for (; j < end; j += 4) { let c = 0; for (let k = j; k < j + 4; k++) c += C[(u8[k] - ((u8[k - up] + u8[k - ur]) >> 1)) & 255]; cost += c } break
    case 10: for (; j < end; j += 4) { let c = 0; for (let k = j; k < j + 4; k++) c += C[(u8[k] - ((((u8[k - 4] + u8[k - ul]) >> 1) + ((u8[k - up] + u8[k - ur]) >> 1)) >> 1)) & 255]; cost += c } break
    case 11: for (; j < end; j += 4) { const from = selected(u8, j, up); let c = 0; for (let k = 0; k < 4; k++) c += C[(u8[j + k] - u8[from + k]) & 255]; cost += c } break
    case 12: for (; j < end; j += 4) { let c = 0; for (let k = j; k < j + 4; k++) c += C[(u8[k] - clip255(u8[k - 4] + u8[k - up] - u8[k - ul])) & 255]; cost += c } break
    default: for (; j < end; j += 4) { let c = 0; for (let k = j; k < j + 4; k++) c += C[(u8[k] - clampAddSubtractHalf(u8[k - 4], u8[k - up], u8[k - ul])) & 255]; cost += c }
  }
  return cost
}

// predict picks for every block the predictor with the smallest residuals and turns the pixels into residuals in
// place, saving a copy of the image: from the last pixel to the first, so each pixel's left and upper neighbours
// are still the original ones when it is predicted. Returns the block modes (as the green channel of a small
// image). The first row predicts from the left, the first column from the top, as the format fixes it; the
// rightmost column's top-right neighbour is its own row's first pixel.
export const predict = (argb: Uint32Array, width: number, height: number) => {
  const u8 = new Uint8Array(argb.buffer, argb.byteOffset, argb.byteLength)
  const up = 4 * width
  const size = 1 << PREDICTOR_BITS
  const tilesX = Math.ceil(width / size)
  const tilesY = Math.ceil(height / size)
  const modes = new Uint32Array(tilesX * tilesY)
  for (let ty = 0; ty < tilesY; ty++) {
    const y0 = Math.max(ty * size, 1)
    const y1 = Math.min(height, ty * size + size)
    for (let tx = 0; tx < tilesX; tx++) {
      const x0 = Math.max(tx * size, 1)
      const x1 = Math.min(width, tx * size + size)
      let best = 2
      let bestCost = Infinity
      for (let mode = 0; mode < 14 && bestCost > 0; mode++) {
        let cost = 0
        for (let y = y0; y < y1 && cost < bestCost; y++) cost = rowCost(u8, mode, 4 * (y * width + x0), 4 * (y * width + x1), up, cost)
        if (cost < bestCost) {
          bestCost = cost
          best = mode
        }
      }
      modes[ty * tilesX + tx] = (0xff000000 | (best << 8)) >>> 0
    }
  }
  // The residuals, a row at a time from the last, each from its right end
  for (let y = height - 1; y > 0; y--) {
    const blocks = (y >> PREDICTOR_BITS) * tilesX
    for (let tx = tilesX - 1; tx >= 0; tx--) {
      const mode = (modes[blocks + tx] >>> 8) & 0xff
      const first = 4 * (y * width + Math.max(tx * size, 1))
      for (let j = 4 * (y * width + Math.min(width, tx * size + size) - 1); j >= first; j -= 4) {
        if (mode === 0) {
          u8[j + ALPHA_BYTE] -= 255
        } else if (mode === 11) {
          const from = selected(u8, j, up)
          for (let k = 0; k < 4; k++) u8[j + k] -= u8[from + k]
        } else {
          for (let k = j; k < j + 4; k++) u8[k] -= channelPrediction(mode, u8[k - 4], u8[k - up], u8[k - up - 4], u8[k - up + 4])
        }
      }
    }
    for (let k = y * up; k < y * up + 4; k++) u8[k] -= u8[k - up]
  }
  for (let k = up - 1; k >= 4; k--) u8[k] -= u8[k - 4]
  u8[ALPHA_BYTE] -= 255
  return { modes, tilesX }
}

// prefixOf splits an LZ77 length or distance (1 or more) into a prefix symbol and its extra bits
const prefixOf = (value: number): [symbol: number, bits: number, extra: number] => {
  const d = value - 1
  if (d < 4) return [d, 0, 0]
  const high = 31 - Math.clz32(d)
  const bits = high - 1
  return [2 * high + ((d >>> bits) & 1), bits, d & ((1 << bits) - 1)]
}

// Token kinds in the token stream, kept in the two low bits
const LITERAL = 0 // the rest is the pixel's index
const CACHED = 1 // the rest is the color cache index
const COPY = 2 // the rest is the length; the next entry is the distance code

// blockBits picks the block size for prefix codes per group: the smallest that keeps the blocks few
const blockBits = (width: number, height: number): number => {
  let bits = 4
  while (bits < 9 && Math.ceil(width / 2 ** bits) * Math.ceil(height / 2 ** bits) > MAX_BLOCKS) bits++
  return bits
}

// planImage works out how an entropy-coded image is coded: LZ77 and a color cache for the main image (its tokens
// written into the array given), plain literals for the small images of transforms. Sizes are exact: prefix codes are written to a scratch writer and
// the symbols counted with their code lengths. All five alphabets are counted in one histogram: green (with LZ77
// lengths and the color cache), red, blue, alpha, distance.
const planImage = (pixels: Uint32Array, width: number, height: number, main: boolean, into?: Uint32Array, search = true): ImagePlan => {
  const cacheBits = main ? CACHE_BITS : 0
  const tokens = main ? lz77(pixels, width, cacheBits, into ?? new Uint32Array(pixels.length), search) : literals(pixels.length)
  const greenSize = NUM_LITERALS + NUM_LENGTH_CODES + (cacheBits ? 1 << cacheBits : 0)
  const alphabets = [0, greenSize, greenSize + 256, greenSize + 512, greenSize + 768, greenSize + 768 + NUM_DISTANCE_CODES]
  const size = alphabets[5]
  const CACHE_SYMBOL = NUM_LITERALS + NUM_LENGTH_CODES

  // Counts for the whole image and, for the main image, per block
  const bBits = blockBits(width, height)
  const blocksX = Math.ceil(width / 2 ** bBits)
  const blockCount = blocksX * Math.ceil(height / 2 ** bBits)
  const blockOf = (pos: number): number => ((Math.floor(pos / width) >> bBits) * blocksX) + ((pos % width) >> bBits)
  const histogram = new Uint32Array(size)
  // counts of a block never exceed its pixels, which fit 16 bits up to blocks of 128 × 128
  const perBlock = main && blockCount > 1 ? (bBits <= 7 ? new Uint16Array(blockCount * size) : new Uint32Array(blockCount * size)) : null
  let extraBits = 0
  for (let t = 0, pos = 0; t < tokens.length; t++) {
    const base = perBlock ? blockOf(pos) * size : 0
    const count = (symbol: number) => {
      histogram[symbol]++
      if (perBlock) perBlock[base + symbol]++
    }
    const token = tokens[t]
    const kind = token & 3
    if (kind === LITERAL) {
      const p = pixels[token >>> 2]
      count((p >>> 8) & 0xff)
      count(alphabets[1] + ((p >>> 16) & 0xff))
      count(alphabets[2] + (p & 0xff))
      count(alphabets[3] + (p >>> 24))
      pos++
    } else if (kind === CACHED) {
      count(CACHE_SYMBOL + (token >>> 2))
      pos++
    } else {
      const [lengthSymbol, lengthBits] = prefixOf(token >>> 2)
      const [distanceSymbol, distanceBits] = prefixOf(tokens[++t])
      count(NUM_LITERALS + lengthSymbol)
      count(alphabets[4] + distanceSymbol)
      extraBits += lengthBits + distanceBits
      pos += token >>> 2
    }
  }

  const writeCodes = (bw: BitWriter, counts: Uint32Array): PrefixCode[] =>
    [0, 1, 2, 3, 4].map(a => writePrefixCode(bw, counts.subarray(alphabets[a], alphabets[a + 1])))
  // codesCost is what one set of prefix codes takes, with the symbols it codes
  const codesCost = (counts: Uint32Array): number => {
    const scratch = new BitWriter(1 << 12)
    const codes = writeCodes(scratch, counts)
    return scratch.length + codes.reduce((sum, code, a) => sum + code.cost(counts.subarray(alphabets[a], alphabets[a + 1])), 0)
  }
  const writeCache = (bw: BitWriter) => {
    if (cacheBits) {
      bw.write(1, 1)
      bw.write(cacheBits, 4)
    } else {
      bw.write(0, 1)
    }
  }
  const cacheHeader = cacheBits ? 5 : 1
  // writeTokens codes the pixels, each token with the prefix codes of the block where it starts
  const writeTokens = (bw: BitWriter, codesAt: (pos: number) => PrefixCode[]) => {
    for (let t = 0, pos = 0; t < tokens.length; t++) {
      const [greenCode, redCode, blueCode, alphaCode, distanceCode] = codesAt(pos)
      const token = tokens[t]
      const kind = token & 3
      if (kind === LITERAL) {
        const p = pixels[token >>> 2]
        greenCode.put(bw, (p >>> 8) & 0xff)
        redCode.put(bw, (p >>> 16) & 0xff)
        blueCode.put(bw, p & 0xff)
        alphaCode.put(bw, p >>> 24)
        pos++
      } else if (kind === CACHED) {
        greenCode.put(bw, CACHE_SYMBOL + (token >>> 2))
        pos++
      } else {
        const [lengthSymbol, lengthBits, lengthExtra] = prefixOf(token >>> 2)
        greenCode.put(bw, NUM_LITERALS + lengthSymbol)
        bw.write(lengthExtra, lengthBits)
        const [distanceSymbol, distanceBits, distanceExtra] = prefixOf(tokens[++t])
        distanceCode.put(bw, distanceSymbol)
        bw.write(distanceExtra, distanceBits)
        pos += token >>> 2
      }
    }
  }

  const single: Plan = {
    bits: cacheHeader + (main ? 1 : 0) + codesCost(histogram) + extraBits,
    write: bw => {
      writeCache(bw)
      if (main) bw.write(0, 1) // one set of prefix codes for the whole image
      const codes = writeCodes(bw, histogram)
      writeTokens(bw, () => codes)
    },
  }

  const grouped = (force = false): Plan => {
    if (!perBlock) return single
    const grouping = groupBlocks(sparse(perBlock, blockCount, size, alphabets), codesCost, MAX_GROUPS)
    if (grouping.histograms.length === 1 && !force) return single
    const groupImage = planImage(Uint32Array.from(grouping.group, g => (0xff000000 | (g << 8)) >>> 0), blocksX, blockCount / blocksX, false)
    const bits = cacheHeader + 1 + 3 + groupImage.bits + grouping.histograms.reduce((sum, h) => sum + codesCost(h), 0) + extraBits
    if (bits >= single.bits && !force) return single
    return {
      bits,
      write: bw => {
        writeCache(bw)
        bw.write(1, 1) // prefix codes per group of blocks
        bw.write(bBits - 2, 3)
        groupImage.write(bw)
        const codes = grouping.histograms.map(h => writeCodes(bw, h))
        writeTokens(bw, pos => codes[grouping.group[blockOf(pos)]])
      },
    }
  }

  return { ...single, grouped }
}

// sparse turns per-block histograms into lists of the symbols each block uses
const sparse = (perBlock: Uint16Array | Uint32Array, count: number, size: number, alphabets: number[]) => {
  let used = 0
  for (let i = 0; i < perBlock.length; i++) if (perBlock[i]) used++
  const start = new Uint32Array(count + 1)
  const symbols = new Uint32Array(used)
  const counts = new Uint32Array(used)
  for (let b = 0, k = 0; b < count; b++) {
    start[b] = k
    for (let s = 0, i = b * size; s < size; s++, i++) {
      if (perBlock[i]) {
        symbols[k] = s
        counts[k++] = perBlock[i]
      }
    }
    start[b + 1] = k
  }
  return { count, size, alphabets, start, symbols, counts }
}

const literals = (count: number): Uint32Array => Uint32Array.from({ length: count }, (_, i) => (i << 2) | LITERAL)

// distanceCodes maps the distances of the 120 nearby neighbours, for this width, to their short codes
const distanceCodes = (width: number): Map<number, number> => {
  const codes = new Map<number, number>()
  for (let code = 1; code <= 120; code++) {
    const distance = Math.max(1, DISTANCE_OFFSETS[2 * code - 2] + DISTANCE_OFFSETS[2 * code - 1] * width)
    if (!codes.has(distance)) codes.set(distance, code)
  }
  return codes
}

// lz77 turns pixels into tokens: copies of earlier runs, color cache hits and literals. Copies always try the
// pixel to the left and the one above first; with `search`, also earlier positions found through a hash chain over
// groups of MIN_MATCH pixels, which have to be longer from farther away (MIN_FAR). Matching is lazy, as in zlib: when a longer match starts at the next pixel, this one goes as a
// literal and the longer copy follows. The color cache follows what the decoder does: every pixel goes into it,
// copied ones included.
export const lz77 = (pixels: Uint32Array, width: number, cacheBits: number, tokens: Uint32Array, search: boolean): Uint32Array => {
  const n = pixels.length
  let count = 0
  const head = new Int32Array(search ? 1 << HASH_BITS : 0).fill(-1)
  const mask = (1 << WINDOW_BITS) - 1
  const chain = new Int32Array(search ? Math.min(n, mask + 1) : 0)
  const cache = new Uint32Array(1 << cacheBits)
  const cacheShift = 32 - cacheBits
  const nearCodes = distanceCodes(width)
  const farthestNear = Math.max(...nearCodes.keys())
  const nearest = width > 1 ? [1, width] : [1]
  // The hash covers MIN_MATCH pixels, so the chain holds only positions that can start a copy
  const hash = (i: number): number =>
    (Math.imul(pixels[i], COLOR_CACHE_MULTIPLIER) + Math.imul(pixels[i + 1], 0x9e3779b1) + Math.imul(pixels[i + 2], 0x85ebca6b) +
      Math.imul(pixels[i + 3], 0xc2b2ae35)) >>> (32 - HASH_BITS)
  const insert = (i: number): void => {
    if (i + MIN_MATCH > n) return
    const h = hash(i)
    chain[i & mask] = head[h]
    head[h] = i
  }
  const matchLength = (from: number, to: number, limit: number): number => {
    let length = 0
    while (length < limit && pixels[from + length] === pixels[to + length]) length++
    return length
  }

  // findMatch finds the longest match at i and leaves it in foundLength and foundDistance (no array per pixel)
  let foundLength = 0
  let foundDistance = 0
  const findMatch = (i: number): void => {
    const limit = Math.min(MAX_MATCH, n - i)
    let bestLength = 0
    let bestDistance = 0
    if (limit >= MIN_MATCH) {
      for (const distance of nearest) {
        if (distance > i) continue
        const length = matchLength(i - distance, i, limit)
        if (length > bestLength) {
          bestLength = length
          bestDistance = distance
        }
      }
      // limit >= MIN_MATCH, so the pixels the hash covers are all there
      for (let candidate = search && bestLength < limit ? head[hash(i)] : -1, tries = MAX_CHAIN; candidate >= 0 && tries > 0; candidate = chain[candidate & mask], tries--) {
        const distance = i - candidate
        if (distance > MAX_DISTANCE) break
        // The pixel that has to match for a longer copy, and one long enough for its distance, is compared first:
        // most candidates fail there without comparing the rest
        const least = (distance <= farthestNear ? MIN_MATCH : MIN_FAR) - 1
        const at = bestLength < least ? least : bestLength
        if (pixels[candidate + at] !== pixels[i + at]) continue
        const length = matchLength(candidate, i, limit)
        if (length > bestLength && (length >= MIN_FAR || nearCodes.has(distance))) {
          bestLength = length
          bestDistance = distance
          if (length === limit) break
        }
      }
    }
    foundLength = bestLength
    foundDistance = bestDistance
  }
  let inserted = 0 // positions before this one are in the hash chain
  const insertUpTo = (end: number) => {
    if (search) for (; inserted < end; inserted++) insert(inserted)
  }
  const literal = (i: number) => {
    const p = pixels[i]
    if (cacheBits) {
      const key = Math.imul(p, COLOR_CACHE_MULTIPLIER) >>> cacheShift
      tokens[count++] = cache[key] === p ? (key << 2) | CACHED : (i << 2) | LITERAL
      cache[key] = p
    } else {
      tokens[count++] = (i << 2) | LITERAL
    }
  }

  // ahead is where the lazy look found a longer match; nothing is inserted in between, so it stands
  let ahead = -1
  let aheadLength = 0
  let aheadDistance = 0
  for (let i = 0; i < n; ) {
    if (i !== ahead) findMatch(i)
    const length = i === ahead ? aheadLength : foundLength
    const distance = i === ahead ? aheadDistance : foundDistance
    if (length < MIN_MATCH) {
      literal(i)
      insertUpTo(++i)
      continue
    }
    if (length < MAX_MATCH && i + 1 < n) {
      insertUpTo(i + 1)
      findMatch(i + 1)
      if (foundLength > length) {
        ahead = i + 1
        aheadLength = foundLength
        aheadDistance = foundDistance
        literal(i)
        i++
        continue
      }
    }
    tokens[count++] = (length << 2) | COPY
    tokens[count++] = nearCodes.get(distance) ?? distance + 120
    insertUpTo(i + length)
    for (const end = i + length; i < end; i++) {
      if (cacheBits) cache[Math.imul(pixels[i], COLOR_CACHE_MULTIPLIER) >>> cacheShift] = pixels[i]
    }
  }
  return tokens.subarray(0, count)
}

// container wraps the bitstream in a RIFF file; with an ICC profile, in the extended format that can carry one
const container = (vp8l: Uint8Array, width: number, height: number, alpha: boolean, icc?: Uint8Array): Uint8Array<ArrayBuffer> => {
  const chunks: [string, Uint8Array][] = []
  if (icc?.length) {
    const header = new Uint8Array(10)
    header[0] = 0x20 | (alpha ? 0x10 : 0) // ICC profile, alpha
    for (let k = 0; k < 3; k++) {
      header[4 + k] = ((width - 1) >>> (8 * k)) & 0xff
      header[7 + k] = ((height - 1) >>> (8 * k)) & 0xff
    }
    chunks.push(['VP8X', header], ['ICCP', icc])
  }
  chunks.push(['VP8L', vp8l])
  const size = 4 + chunks.reduce((sum, [, data]) => sum + 8 + data.length + (data.length & 1), 0)
  const out = new Uint8Array(8 + size)
  const view = new DataView(out.buffer)
  const fourCC = (at: number, tag: string) => {
    for (let k = 0; k < 4; k++) out[at + k] = tag.charCodeAt(k)
  }
  fourCC(0, 'RIFF')
  view.setUint32(4, size, true)
  fourCC(8, 'WEBP')
  let at = 12
  for (const [tag, data] of chunks) {
    fourCC(at, tag)
    view.setUint32(at + 4, data.length, true)
    out.set(data, at + 8)
    at += 8 + data.length + (data.length & 1)
  }
  return out
}
