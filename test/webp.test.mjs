// Tests for the lossless WebP encoder in src/ (npm test). Needs Node >= 22.18.
// An independent decoder written in JavaScript (@nktkas/webp) checks that every pixel comes back as it was.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decode } from '@nktkas/webp'

const lib = path => import(new URL(`../src/${path}`, import.meta.url).href)
const { encodeLossless, lz77, predict, sample } = await lib('encode.ts')
const { codeLengths } = await lib('huffman.ts')
const { groupBlocks } = await lib('groups.ts')

let seed = 1
const random = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) >>> 16) & 0xff

// image makes RGBA pixels from pixel(x, y) → [r, g, b, a]
const image = (width, height, pixel) => {
  const rgba = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) rgba.set(pixel(x, y), (y * width + x) * 4)
  return rgba
}

const assertLossless = (rgba, width, height, options) => {
  const webp = encodeLossless(rgba, width, height, options)
  const out = decode(webp)
  assert.equal(out.width, width)
  assert.equal(out.height, height)
  const first = rgba.findIndex((v, i) => out.data[i] !== v)
  assert.equal(first, -1, `byte ${first} (pixel ${first >> 2}) differs`)
  return webp
}

const opaqueNoise = () => [random(), random(), random(), 255]
const cases = {
  'a single opaque pixel': [1, 1, () => [10, 20, 30, 255]],
  'a fully transparent pixel keeps its color': [1, 1, () => [10, 20, 30, 0]],
  'one row': [97, 1, opaqueNoise],
  'one column': [1, 71, opaqueNoise],
  'a flat area': [300, 200, () => [240, 240, 240, 255]],
  'gradients across block edges': [257, 129, (x, y) => [x & 255, y & 255, (x * y) & 255, 255]],
  'noise in every channel, alpha too': [123, 77, () => [random(), random(), random(), random()]],
  'text-like stripes': [640, 120, (x, y) => (((x >> 1) ^ (y >> 2)) & 5 ? [30, 30, 30, 255] : [250, 250, 250, 255])],
  'more colors than the cache holds': [400, 300, (x, y) => [(x * 7) & 255, (y * 13) & 255, (x ^ y) & 255, 255]],
}
// Every way of coding is checked, not only the one the encoder picks
const ways = {
  chosen: {},
  'with the predictor': { predictor: true },
  'without the predictor': { predictor: false },
  'with groups of prefix codes': { groups: true },
  'with one set of prefix codes': { groups: false },
  'with the predictor and groups': { predictor: true, groups: true },
  'without the LZ77 search': { search: false },
  'with the predictor, without the LZ77 search': { predictor: true, search: false },
}
for (const [name, [width, height, pixel]] of Object.entries(cases)) {
  test(`lossless: ${name}`, () => {
    const rgba = image(width, height, pixel)
    for (const options of Object.values(ways)) assertLossless(rgba, width, height, options)
  })
}

test('the predictor is used where it makes the file smaller: photos yes, text no', () => {
  const sizes = rgba => Object.fromEntries(Object.entries(ways).map(([way, o]) => [way, encodeLossless(rgba, 320, 200, { groups: false, ...o }).length]))
  const text = sizes(image(320, 200, (x, y) => (y % 14 < 9 && ((x * 7 + (y >> 4) * 13) % 23) < 11 ? [230, 230, 230, 255] : [20, 24, 30, 255])))
  const photo = sizes(image(320, 200, (x, y) => [(x + y) & 255, (x * 2 + (y >> 1) + (random() & 3)) & 255, (y * 2) & 255, 255]))
  assert.ok(text['without the predictor'] < text['with the predictor'], JSON.stringify(text))
  assert.ok(photo['with the predictor'] < photo['without the predictor'], JSON.stringify(photo))
  for (const s of [text, photo]) assert.equal(s.chosen, Math.min(s['with the predictor'], s['without the predictor']))
})

test('large images decide the predictor on stripes of rows spread over them, small ones on every pixel', () => {
  const rows = (width, height) => Uint32Array.from({ length: width * height }, (_, i) => Math.floor(i / width))
  const small = rows(1000, 1000)
  const all = sample(small, 1000, 1000)
  assert.equal(all.height, 1000)
  assert.deepEqual(all.pixels, small)
  assert.notEqual(all.pixels, small, 'a copy: the image itself stays as it is')

  const width = 4000
  const height = 3000
  const part = sample(rows(width, height), width, height)
  assert.equal(part.pixels.length, width * part.height)
  assert.ok(part.pixels.length >= (width * height) / 8 && part.height < height / 2, `${part.height} rows`)
  const stripes = []
  for (let y = 0; y < part.height; y += 32) {
    const top = part.pixels[y * width]
    assert.equal(top % 32, 0, 'a stripe is a whole row of predictor blocks')
    for (let r = 0; r < 32; r++) assert.equal(part.pixels[(y + r) * width + width - 1], top + r)
    stripes.push(top)
  }
  assert.ok(stripes.every((top, k) => k === 0 || top > stripes[k - 1]), 'in order, none twice')
  assert.ok(stripes[0] < height / 8 && stripes.at(-1) > (height * 7) / 8, `spread over the image: ${stripes}`)
})

test('the predictor decided on a sample: a large photo gets it, a large screenshot not', () => {
  const width = 1600
  const height = 1400 // 2.2 Mpx: the smallest images decided on a sample
  const text = image(width, height, (x, y) => (y % 14 < 9 && ((x * 7 + (y >> 4) * 13) % 23) < 11 ? [230, 230, 230, 255] : [20, 24, 30, 255]))
  const photo = image(width, height, (x, y) => [(x + y) & 255, (x * 2 + (y >> 1) + (random() & 3)) & 255, (y * 2) & 255, 255])
  for (const [rgba, wins] of [[text, false], [photo, true]]) {
    const chosen = assertLossless(rgba, width, height, { groups: false }).length
    assert.equal(chosen, encodeLossless(rgba, width, height, { groups: false, predictor: wins }).length)
    assert.ok(chosen < encodeLossless(rgba, width, height, { groups: false, predictor: !wins }).length)
  }
})

test('each of the 14 predictors is picked where it fits and decodes as the specification defines it', () => {
  // Every block of 32 × 32 is made by one predictor, as the specification defines them, with a little noise
  let seed = 9
  const random = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) >>> 16) & 0xff
  const clip = v => Math.min(255, Math.max(0, v))
  const avg = (a, b) => (a + b) >> 1
  const channel = (mode, L, T, TL, TR) => [255, L, T, TR, TL, avg(avg(L, TR), T), avg(L, TL), avg(L, T), avg(TL, T), avg(T, TR),
    avg(avg(L, TL), avg(T, TR)), null, clip(L + T - TL), clip(avg(L, T) + Math.trunc((avg(L, T) - TL) / 2))][mode]
  const width = 14 * 32 * 2
  const height = 64
  const rgba = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4
      if (x === 0 || y === 0 || x === width - 1) {
        for (let c = 0; c < 4; c++) rgba[o + c] = random()
        continue
      }
      const mode = (x >> 5) % 14
      const at = d => rgba.subarray(o + d * 4, o + d * 4 + 4)
      const [L, T, TL, TR] = [at(-1), at(-width), at(-width - 1), at(-width + 1)]
      let select = null
      if (mode === 11) {
        let toLeft = 0
        let toTop = 0
        for (let c = 0; c < 4; c++) {
          toLeft += Math.abs(T[c] - TL[c])
          toTop += Math.abs(L[c] - TL[c])
        }
        select = toLeft < toTop ? L : T
      }
      for (let c = 0; c < 4; c++) {
        const p = mode === 0 ? (c === 3 ? 255 : 0) : select ? select[c] : channel(mode, L[c], T[c], TL[c], TR[c])
        // Select needs more noise, or it keeps taking the top pixel and is no different from predictor 2
        rgba[o + c] = mode === 11 && random() < 48 ? random() : (p + (random() < 40 ? random() & 3 : 0)) & 255
      }
    }
  }
  const argb = new Uint32Array(width * height)
  for (let i = 0; i < argb.length; i++) argb[i] = ((rgba[4 * i + 3] << 24) | (rgba[4 * i] << 16) | (rgba[4 * i + 1] << 8) | rgba[4 * i + 2]) >>> 0
  const picked = [...predict(argb, width, height).modes].map(m => (m >>> 8) & 0xff)
  assert.deepEqual(picked, Array.from({ length: picked.length }, (_, b) => (b % (width / 32)) % 14))
  assertLossless(rgba, width, height, { predictor: true })
})

test('LZ77 searches far where it codes smaller, as for text, and else copies only runs, as for a noisy photo', () => {
  const sizes = (rgba, width, height) =>
    Object.fromEntries(Object.entries({ chosen: {}, search: { search: true }, runs: { search: false } }).map(([way, o]) => [way, encodeLossless(rgba, width, height, { groups: false, ...o }).length]))
  // letters repeat 23 pixels apart, which only the search finds
  const text = sizes(image(320, 200, (x, y) => (y % 14 < 9 && ((x * 7 + (y >> 4) * 13) % 23) < 11 ? [230, 230, 230, 255] : [20, 24, 30, 255])), 320, 200)
  // the residuals of a little noise repeat a few pixels at a time by chance, far apart: such copies cost more than they save
  const photo = sizes(image(600, 400, (x, y) => [(x / 5 + y / 7 + (random() % 3)) & 255, (x / 3 + (random() % 3)) & 255, (y / 4 + (random() % 3)) & 255, 255]), 600, 400)
  assert.ok(text.search < text.runs, JSON.stringify(text))
  assert.ok(photo.runs < photo.search, JSON.stringify(photo))
  for (const s of [text, photo]) assert.equal(s.chosen, Math.min(s.search, s.runs))
})

test('LZ77 copies from far away only when they are long enough to pay, from nearby from 4 pixels', () => {
  // Noise with no repeats but three planted ones
  const width = 100
  const pixels = Uint32Array.from({ length: width * 100 }, (_, i) => (0xff000000 | Math.imul(i + 1, 0x9e3779b1) >>> 8) >>> 0)
  const plant = (from, to, length) => pixels.copyWithin(to, from, from + length)
  plant(200, 8000, 6) // far, short
  plant(300, 8100, 10) // far, long enough
  plant(5000, 5201, 4) // (1, 2) away: a near distance code
  const copies = search => {
    const tokens = lz77(pixels, width, 0, new Uint32Array(pixels.length), search)
    const found = []
    for (let t = 0, pos = 0; t < tokens.length; t++) {
      if ((tokens[t] & 3) === 2) {
        found.push([pos, tokens[t] >>> 2, tokens[++t]])
        pos += tokens[t - 1] >>> 2
      } else {
        pos++
      }
    }
    return found
  }
  assert.deepEqual(copies(true), [[5201, 4, 7], [8100, 10, 7800 + 120]])
  assert.deepEqual(copies(false), [], 'without the search only the left and upper neighbours are tried')
})

test('lossless: repeats near and far use both kinds of distance codes', () => {
  const width = 211
  const height = 160
  const top = image(width, 40, opaqueNoise)
  const rgba = new Uint8Array(width * height * 4)
  rgba.set(top) // noise
  rgba.set(top, width * 40 * 4) // the same 40 rows again: one long distance
  for (let y = 80; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // each pixel copies the one 3 to the left and 2 rows up: a 2D neighbour code
      const from = x >= 3 ? ((y - 2) * width + x - 3) * 4 : (y * width + x) * 4 - 4 * width
      rgba.set(rgba.subarray(from, from + 4), (y * width + x) * 4)
    }
  }
  assertLossless(rgba, width, height)
})

test('a screenshot-like image is far smaller than its pixels, a flat one tiny', () => {
  const width = 1200
  const height = 700
  const ui = image(width, height, (x, y) =>
    x < 200 ? [36, 41, 46, 255] : y % 18 < 12 && (x * 31 + (y >> 4) * 17) % 97 < 40 ? [201, 209, 217, 255] : [13, 17, 23, 255],
  )
  assert.ok(assertLossless(ui, width, height).length < (width * height) / 20)
  assert.ok(assertLossless(image(1920, 1080, () => [255, 255, 255, 255]), 1920, 1080).length < 1000)
})

test('an ICC profile goes into an extended container next to the image', () => {
  const icc = Uint8Array.from({ length: 101 }, (_, i) => i) // odd length: padded
  const rgba = image(33, 17, (x, y) => [x, y, 7, x === 3 ? 128 : 255])
  const webp = assertLossless(rgba, 33, 17, { iccProfile: icc })
  const text = (at, length = 4) => String.fromCharCode(...webp.subarray(at, at + length))
  const u32 = at => new DataView(webp.buffer, webp.byteOffset).getUint32(at, true)
  assert.equal(text(0), 'RIFF')
  assert.equal(u32(4), webp.length - 8)
  assert.equal(text(8), 'WEBP')
  assert.equal(text(12), 'VP8X')
  assert.equal(webp[20], 0x20 | 0x10, 'flags: ICC profile and alpha')
  assert.equal(webp[24] | (webp[25] << 8) | (webp[26] << 16), 32, 'width - 1')
  assert.equal(webp[27] | (webp[28] << 8) | (webp[29] << 16), 16, 'height - 1')
  assert.equal(text(30), 'ICCP')
  assert.equal(u32(34), icc.length)
  assert.deepEqual(webp.subarray(38, 38 + icc.length), icc)
  assert.equal(text(38 + icc.length + 1), 'VP8L')
  assert.equal(text(12, 4), 'VP8X')
  assert.equal(String.fromCharCode(...encodeLossless(rgba, 33, 17).subarray(12, 16)), 'VP8L', 'without a profile: simple')
})

test('sizes WebP cannot hold are refused', () => {
  assert.throws(() => encodeLossless(new Uint8Array(16385 * 4), 16385, 1), RangeError)
  assert.throws(() => encodeLossless(new Uint8Array(0), 0, 0), RangeError)
  assert.throws(() => encodeLossless(new Uint8Array(7), 1, 1), RangeError)
})

// libwebp, which browsers use, rejects prefix codes that leave bit patterns unused
const kraft = lengths => lengths.reduce((sum, l) => sum + (l ? 2 ** -l : 0), 0)

test('prefix codes are complete and never longer than allowed', () => {
  // The code-length code has 19 symbols in at most 7 bits, the others up to 2328 symbols in 15 bits
  for (const [maxLength, symbols] of [[7, 19], [15, 2328]]) {
    for (let round = 0; round < 50; round++) {
      const counts = Array.from({ length: 2 + (random() * symbols >> 8) }, () => (random() < 60 ? 0 : random() ** (1 + (round % 4))))
      if (counts.filter(Boolean).length < 2) counts[0] = counts[1] = 1
      const lengths = codeLengths(counts, maxLength)
      assert.ok(Math.max(...lengths) <= maxLength)
      assert.equal(kraft(lengths), 1)
      counts.forEach((c, s) => assert.equal(lengths[s] > 0, c > 0, `symbol ${s}`))
    }
  }
  // Fibonacci counts make the deepest Huffman trees; they must be flattened to the limit
  const fibonacci = [1, 1]
  while (fibonacci.length < 40) fibonacci.push(fibonacci.at(-1) + fibonacci.at(-2))
  const deep = codeLengths(fibonacci, 15)
  assert.equal(Math.max(...deep), 15)
  assert.equal(kraft(deep), 1)
  assert.throws(() => codeLengths(new Array(129).fill(1), 7), RangeError, 'more symbols than codes of 7 bits')
})

test('a lone symbol gets length 1 (sent in no bits), no symbols no lengths', () => {
  assert.deepEqual([...codeLengths([0, 0, 5, 0], 15)], [0, 0, 1, 0])
  assert.deepEqual([...codeLengths([0, 0, 0], 15)], [0, 0, 0])
})


test('blocks with different statistics get prefix codes of their own', () => {
  // A screen of two parts: text on the left, noise on the right, each a few blocks wide
  const width = 512
  const height = 256
  const rgba = image(width, height, (x, y) =>
    x < 256 ? (y % 12 < 8 && (x * 5 + (y >> 3) * 7) % 13 < 6 ? [220, 220, 220, 255] : [16, 18, 22, 255]) : [random(), random(), random(), 255])
  // Without the LZ77 search, which copies the text half in few long runs and leaves the codes little to separate
  const way = { predictor: false, search: false }
  const one = assertLossless(rgba, width, height, { ...way, groups: false }).length
  const grouped = assertLossless(rgba, width, height, { ...way, groups: true }).length
  assert.ok(grouped < one, `${grouped} vs ${one}`)
  assert.equal(encodeLossless(rgba, width, height, way).length, grouped, 'chosen when smaller')
})

test('grouping separates blocks of different statistics and keeps alike ones together', () => {
  // 40 blocks in one alphabet of 200 symbols: the even ones use symbols 0–9, the odd ones 100–109
  const blocks = (alike) => {
    const start = new Uint32Array(41)
    const symbols = []
    const counts = []
    for (let b = 0; b < 40; b++) {
      start[b] = symbols.length
      for (let s = 0; s < 10; s++) {
        symbols.push((alike || b % 2 === 0 ? 0 : 100) + s)
        counts.push(5 + ((b * 7 + s * 3) % 11))
      }
    }
    start[40] = symbols.length
    return { count: 40, size: 200, alphabets: [0, 200], start, symbols: Uint32Array.from(symbols), counts: Uint32Array.from(counts) }
  }
  // the bits of a Shannon code, and 100 bits for each set of codes
  const cost = histogram => {
    const total = histogram.reduce((a, b) => a + b, 0)
    return 100 + histogram.reduce((bits, n) => bits + (n ? n * Math.log2(total / n) : 0), 0)
  }
  const mixed = groupBlocks(blocks(false), cost, 8)
  assert.equal(mixed.histograms.length, 2)
  for (let b = 2; b < 40; b++) assert.equal(mixed.group[b], mixed.group[b % 2], `block ${b}`)
  assert.equal(groupBlocks(blocks(true), cost, 8).histograms.length, 1)
})
