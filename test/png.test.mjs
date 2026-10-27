// Tests for PNG decoding (src/png.ts), the checked conversion (src/convert.ts) and the package entry (npm test).
// Needs Node >= 22.18.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { crc32, deflateSync } from 'node:zlib'
import { decode } from '@nktkas/webp'

const lib = path => import(new URL(`../src/${path}`, import.meta.url).href)
const { decodePng } = await lib('png.ts')
const { fingerprint, pngToWebp } = await lib('convert.ts')
const { encodeArgb, encodeLossless } = await lib('encode.ts')

// A small PNG writer: rows are filtered with the given filter types in turn, so decoding meets all of them
const chunk = (type, data = new Uint8Array()) => {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'latin1')
  Buffer.from(data).copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}
const paeth = (a, b, c) => {
  const p = a + b - c
  const [pa, pb, pc] = [Math.abs(p - a), Math.abs(p - b), Math.abs(p - c)]
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}
const ADAM7 = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]]
// png writes samples (one number per channel, of `depth` bits) as a PNG: packed below 8 bits, two bytes at 16, in
// Adam7 passes when interlaced
const png = ({ width, height, colorType, samples, filters = [0, 1, 2, 3, 4], depth = 8, interlace = 0, before = [], level = 6 }) => {
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType]
  const bpp = Math.max(1, (channels * depth) >> 3)
  const rows = []
  let n = 0
  for (const [x0, y0, dx, dy] of interlace ? ADAM7 : [[0, 0, 1, 1]]) {
    const w = Math.ceil((width - x0) / dx)
    const h = Math.ceil((height - y0) / dy)
    if (w <= 0 || h <= 0) continue
    let above = new Uint8Array(Math.ceil((w * channels * depth) / 8))
    for (let y = 0; y < h; y++) {
      const packed = new Uint8Array(above.length)
      for (let x = 0; x < w; x++) {
        for (let c = 0; c < channels; c++) {
          const v = samples[((y0 + y * dy) * width + x0 + x * dx) * channels + c]
          const i = x * channels + c
          if (depth === 16) packed.set([v >> 8, v & 255], 2 * i)
          else if (depth === 8) packed[i] = v
          else packed[(i * depth) >> 3] |= v << (8 - depth - ((i * depth) & 7))
        }
      }
      const filter = filters[n++ % filters.length]
      const row = new Uint8Array(packed.length + 1)
      row[0] = filter
      for (let x = 0; x < packed.length; x++) {
        const a = x >= bpp ? packed[x - bpp] : 0
        const b = above[x]
        const c = x >= bpp ? above[x - bpp] : 0
        const predicted = filter === 1 ? a : filter === 2 ? b : filter === 3 ? (a + b) >> 1 : filter === 4 ? paeth(a, b, c) : 0
        row[x + 1] = (packed[x] - predicted) & 0xff
      }
      rows.push(row)
      above = packed
    }
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.set([depth, colorType, 0, 0, interlace], 8)
  return new Uint8Array(Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    ...before,
    chunk('IDAT', deflateSync(Buffer.concat(rows), { level })),
    chunk('IEND'),
  ]))
}

let seed = 7
const random = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) >>> 16) & 0xff
const noise = n => Uint8Array.from({ length: n }, random)
// decodePng gives packed 0xAARRGGBB pixels; tests compare them as RGBA bytes
const rgbaOf = image => {
  const out = new Uint8Array(image.argb.length * 4)
  image.argb.forEach((p, i) => out.set([(p >>> 16) & 255, (p >>> 8) & 255, p & 255, p >>> 24], 4 * i))
  return out
}

test('PNG: RGB rows with every filter type decode exactly', async () => {
  const samples = noise(13 * 11 * 3)
  const image = await decodePng(png({ width: 13, height: 11, colorType: 2, samples }))
  assert.equal(image.width, 13)
  assert.equal(image.height, 11)
  for (let i = 0; i < 13 * 11; i++) {
    assert.deepEqual([...rgbaOf(image).subarray(4 * i, 4 * i + 4)], [...samples.subarray(3 * i, 3 * i + 3), 255])
  }
})

test('PNG: RGBA, gray, gray with alpha and a palette with transparency', async () => {
  const rgba = noise(9 * 7 * 4)
  assert.deepEqual(rgbaOf(await decodePng(png({ width: 9, height: 7, colorType: 6, samples: rgba }))), rgba)

  const gray = noise(5 * 4)
  const decodedGray = await decodePng(png({ width: 5, height: 4, colorType: 0, samples: gray }))
  assert.deepEqual([...rgbaOf(decodedGray).subarray(4, 8)], [gray[1], gray[1], gray[1], 255])

  const grayAlpha = noise(5 * 4 * 2)
  const decodedGrayAlpha = await decodePng(png({ width: 5, height: 4, colorType: 4, samples: grayAlpha }))
  assert.deepEqual([...rgbaOf(decodedGrayAlpha).subarray(4, 8)], [grayAlpha[2], grayAlpha[2], grayAlpha[2], grayAlpha[3]])

  const palette = chunk('PLTE', [255, 0, 0, 0, 255, 0, 0, 0, 255])
  const alpha = chunk('tRNS', [0, 128]) // the third color stays opaque
  const indexed = await decodePng(png({ width: 3, height: 1, colorType: 3, samples: [0, 1, 2], before: [palette, alpha] }))
  assert.deepEqual([...rgbaOf(indexed)], [255, 0, 0, 0, 0, 255, 0, 128, 0, 0, 255, 255])
})

test('PNG: an embedded color profile comes along; sRGB is plain', async () => {
  const profile = noise(300)
  const iccp = chunk('iCCP', Buffer.concat([Buffer.from('Display P3\0\0', 'latin1'), deflateSync(profile)]))
  const withProfile = await decodePng(png({ width: 2, height: 2, colorType: 2, samples: noise(12), before: [iccp] }))
  assert.deepEqual(withProfile.iccProfile, profile)
  const srgb = await decodePng(png({ width: 2, height: 2, colorType: 2, samples: noise(12), before: [chunk('sRGB', [0]), chunk('gAMA', [0, 0, 0xb1, 0x8f])] }))
  assert.ok(srgb && !srgb.iccProfile, 'gamma next to sRGB is what sRGB means')
})

const exif = orientation => {
  const tiff = Buffer.alloc(26)
  tiff.write('II', 0, 'latin1')
  tiff.writeUInt16LE(42, 2)
  tiff.writeUInt32LE(8, 4)
  tiff.writeUInt16LE(1, 8) // one entry
  tiff.writeUInt16LE(0x0112, 10) // orientation
  tiff.writeUInt16LE(3, 12) // SHORT
  tiff.writeUInt32LE(1, 14)
  tiff.writeUInt16LE(orientation, 18)
  return chunk('eXIf', tiff)
}

// expected gives the RGBA a viewer shows for samples, worked out from the specification on its own
const expected = ({ colorType, depth = 8, samples, palette, alpha = [], key }) => {
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType]
  const to8 = v => (depth === 16 ? v >> 8 : depth < 8 ? (v * 255) / (2 ** depth - 1) : v)
  const out = []
  for (let i = 0; i < samples.length; i += channels) {
    const s = Array.from(samples.slice(i, i + channels))
    if (colorType === 3) out.push(...palette.slice(3 * s[0], 3 * s[0] + 3), alpha[s[0]] ?? 255)
    else {
      const transparent = key && s.every((v, c) => v === key[c])
      const [r, g, b] = (colorType & 2 ? s : [s[0], s[0], s[0]]).map(to8)
      out.push(r, g, b, transparent ? 0 : colorType === 4 ? to8(s[1]) : colorType === 6 ? to8(s[3]) : 255)
    }
  }
  return Uint8Array.from(out)
}
// randomSamples gives samples below `limit`; at 16 bits 8-bit values widened, as WebP takes them
const randomSamples = (count, depth, limit = 2 ** Math.min(depth, 8)) =>
  Array.from({ length: count }, () => {
    const v = Math.floor((random() * 256 + random()) / 65536 * limit)
    return depth === 16 ? v * 257 : v
  })

test('PNG: every color type and bit depth, interlaced or not, decodes to the pixels the specification gives', async () => {
  const palette = Array.from({ length: 16 * 3 }, random)
  const plte = chunk('PLTE', palette)
  for (const [type, depths] of Object.entries({ 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] })) {
    const colorType = Number(type)
    const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType]
    for (const depth of depths) {
      for (const interlace of [0, 1]) {
        // sizes where some of the seven passes are empty, and one where every pass has several rows
        for (const [width, height] of [[1, 1], [3, 2], [13, 11]]) {
          const samples = randomSamples(width * height * channels, depth, colorType === 3 ? Math.min(2 ** depth, 16) : undefined)
          const name = `type ${colorType}, ${depth} bits, ${interlace ? 'interlaced' : 'not interlaced'}, ${width} × ${height}`
          const image = await decodePng(png({ width, height, colorType, depth, samples, interlace, before: colorType === 3 ? [plte] : [] }))
          assert.ok(image, name)
          assert.deepEqual(rgbaOf(image), expected({ colorType, depth, samples, palette }), name)
        }
      }
    }
  }
})

test('PNG: 16-bit samples convert when they are 8-bit ones widened; real 16-bit detail stays PNG', async () => {
  const widened = randomSamples(6 * 5 * 3, 16)
  assert.ok(await decodePng(png({ width: 6, height: 5, colorType: 2, depth: 16, samples: widened })))
  const detail = widened.map((v, i) => (i === 17 ? v + 1 : v))
  assert.equal(await decodePng(png({ width: 6, height: 5, colorType: 2, depth: 16, samples: detail })), null)
})

test('PNG: a transparent color key becomes alpha', async () => {
  const key = (...values) => chunk('tRNS', values.flatMap(v => [v >> 8, v & 255]))
  // gray at 2 bits, RGB at 8 and at 16 bits, with the key on some pixels
  const gray = [0, 1, 2, 3, 2, 1]
  const grayImage = await decodePng(png({ width: 3, height: 2, colorType: 0, depth: 2, samples: gray, before: [key(2)] }))
  assert.deepEqual(rgbaOf(grayImage), expected({ colorType: 0, depth: 2, samples: gray, key: [2] }))
  const rgb = [10, 20, 30, 10, 20, 31, 10, 20, 30, 0, 0, 0]
  const rgbImage = await decodePng(png({ width: 2, height: 2, colorType: 2, samples: rgb, before: [key(10, 20, 30)] }))
  assert.deepEqual(rgbaOf(rgbImage), expected({ colorType: 2, samples: rgb, key: [10, 20, 30] }))
  assert.deepEqual([...rgbaOf(rgbImage).subarray(0, 8)], [10, 20, 30, 0, 10, 20, 31, 255])
  const rgb16 = rgb.map(v => v * 257)
  const rgb16Image = await decodePng(png({ width: 2, height: 2, colorType: 2, depth: 16, samples: rgb16, before: [key(10 * 257, 20 * 257, 30 * 257)] }))
  assert.deepEqual(rgbaOf(rgb16Image), rgbaOf(rgbImage))
})

test('PNG: sRGB told by gAMA and cHRM converts; another gamma, other primaries or HDR stay PNG', async () => {
  const samples = noise(4 * 4 * 3)
  const base = { width: 4, height: 4, colorType: 2, samples }
  const u32s = (...values) => values.flatMap(v => [v >>> 24, (v >>> 16) & 255, (v >>> 8) & 255, v & 255])
  const gama = value => chunk('gAMA', u32s(value))
  const srgbChrm = [31270, 32900, 64000, 33000, 30000, 60000, 15000, 6000]
  const p3Chrm = [31270, 32900, 68000, 32000, 26500, 69000, 15000, 6000]
  const iccp = chunk('iCCP', Buffer.concat([Buffer.from('p\0\0', 'latin1'), deflateSync(noise(40))]))
  for (const [name, before] of Object.entries({
    'cHRM of sRGB alone, as ImageMagick writes': [chunk('cHRM', u32s(...srgbChrm))],
    'gAMA and cHRM of sRGB': [gama(45455), chunk('cHRM', u32s(...srgbChrm))],
    'gamma 0.45, as older tools write for 1/2.2': [gama(45000)],
    'cICP of sRGB': [chunk('cICP', [1, 13, 0, 1])],
    'a profile next to another gamma': [gama(100000), iccp],
  })) {
    assert.ok(await decodePng(png({ ...base, before })), name)
  }
  const withCicp = await decodePng(png({ ...base, before: [chunk('cICP', [1, 13, 0, 1]), iccp] }))
  assert.ok(withCicp && !withCicp.iccProfile, 'cICP of sRGB outranks a profile')
  for (const [name, before] of Object.entries({
    'linear gamma': [gama(100000)],
    'gamma 1.8, as old Macs had': [gama(55556)],
    'primaries of Display P3': [gama(45455), chunk('cHRM', u32s(...p3Chrm))],
    'HDR (PQ)': [chunk('cICP', [9, 16, 0, 1])],
    'narrow range': [chunk('cICP', [1, 13, 0, 0])],
    'HDR over a profile': [chunk('cICP', [9, 18, 0, 1]), iccp],
  })) {
    assert.equal(await decodePng(png({ ...base, before })), null, name)
  }
})

test('PNG: what WebP would not show the same, or a broken file, stays a PNG', async () => {
  const samples = noise(4 * 4 * 3)
  const base = { width: 4, height: 4, colorType: 2, samples }
  assert.ok(await decodePng(png({ ...base, before: [exif(1)] })), 'upright EXIF is fine')
  const plte = chunk('PLTE', [255, 0, 0, 0, 255, 0])
  for (const [name, options] of Object.entries({
    'an animation': { before: [chunk('acTL', [0, 0, 0, 2, 0, 0, 0, 0])] },
    'rotated by EXIF': { before: [exif(6)] },
    'a color key next to an alpha channel': { colorType: 6, samples: noise(4 * 4 * 4), before: [chunk('tRNS', [0, 1, 0, 2, 0, 3])] },
    'a palette index past the palette': { colorType: 3, samples: Array(16).fill(2), before: [plte] },
    'a palette image without a palette': { colorType: 3, samples: Array(16).fill(0) },
    'RGB at 4 bits, which PNG does not allow': { depth: 4, samples: Array(48).fill(1) },
  })) {
    assert.equal(await decodePng(png({ ...base, ...options })), null, name)
  }
  assert.equal(await decodePng(new Uint8Array([1, 2, 3])), null, 'not a PNG')
  const whole = png(base)
  assert.equal(await decodePng(whole.subarray(0, whole.length - 30)), null, 'cut short')
  // rows decompressed one by one: fewer or more rows than the header says are refused
  const withHeight = (file, height) => {
    const copy = new Uint8Array(file)
    new DataView(copy.buffer).setUint32(20, height) // IHDR height; its CRC is not checked
    return copy
  }
  assert.equal(await decodePng(withHeight(whole, 5)), null, 'a row missing')
  assert.equal(await decodePng(withHeight(whole, 3)), null, 'a row too many')
  assert.ok(await decodePng(withHeight(whole, 4)), 'the right height')
})

// A screenshot-like image: a sidebar, lines of "text" on a dark background
const screenshot = (width, height) => {
  const samples = new Uint8Array(width * height * 3)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const color = x < width / 6 ? [36, 41, 46] : y % 18 < 12 && (x * 31 + (y >> 4) * 17) % 97 < 40 ? [201, 209, 217] : [13, 17, 23]
      samples.set(color, (y * width + x) * 3)
    }
  }
  return samples
}

test('a screenshot becomes a smaller WebP with exactly its pixels and its color profile', async () => {
  const profile = noise(200)
  const iccp = chunk('iCCP', Buffer.concat([Buffer.from('p\0\0', 'latin1'), deflateSync(profile)]))
  const source = png({ width: 600, height: 300, colorType: 2, samples: screenshot(600, 300), filters: [0], level: 1, before: [iccp] })
  const webp = await pngToWebp(source)
  assert.ok(webp && webp.length < source.length / 4, `${webp?.length} vs ${source.length}`)
  const expected = await decodePng(source)
  assert.deepEqual(decode(webp).data, rgbaOf(expected))
  const text = new TextDecoder('latin1').decode(webp)
  assert.ok(text.includes('ICCP'), 'profile carried along')
  assert.ok(Buffer.from(webp).includes(Buffer.from(profile)))
})

test('a small PNG becomes WebP too, even where WebP would not be smaller', async () => {
  const samples = noise(3 * 2 * 3)
  const source = png({ width: 3, height: 2, colorType: 2, samples, level: 9 })
  const webp = await pngToWebp(source)
  assert.deepEqual(decode(webp).data, rgbaOf(await decodePng(source)))
})

test('an interlaced 4-bit palette with transparency becomes WebP with exactly its pixels', async () => {
  const palette = chunk('PLTE', Array.from({ length: 12 * 3 }, random))
  const alpha = chunk('tRNS', [0, 90, 255, 180])
  const source = png({ width: 37, height: 29, colorType: 3, depth: 4, samples: randomSamples(37 * 29, 4, 12), interlace: 1, before: [palette, alpha] })
  const webp = await pngToWebp(source)
  assert.deepEqual(decode(webp).data, rgbaOf(await decodePng(source)))
})

test('anything unexpected keeps the PNG', async () => {
  assert.equal(await pngToWebp(new Uint8Array([137, 80, 78, 71])), null)
  assert.equal(await pngToWebp(png({ width: 4, height: 4, colorType: 2, samples: noise(48), before: [chunk('acTL', [0, 0, 0, 2, 0, 0, 0, 0])] })), null)
})


test('encodeArgb takes packed pixels and gives the same file as encodeLossless', () => {
  const rgba = noise(37 * 23 * 4).map((v, i) => (i % 4 === 3 ? 255 : v))
  const argb = new Uint32Array(37 * 23)
  for (let i = 0; i < argb.length; i++) argb[i] = ((rgba[4 * i + 3] << 24) | (rgba[4 * i] << 16) | (rgba[4 * i + 1] << 8) | rgba[4 * i + 2]) >>> 0
  assert.deepEqual(encodeArgb(argb, 37, 23), encodeLossless(rgba, 37, 23))
})

test('the fingerprint changes with any single pixel and with the order', () => {
  const pixels = Uint32Array.from({ length: 1000 }, (_, i) => (0xff000000 | (i * 2654435761)) >>> 0)
  const of = px => fingerprint(px.length, i => px[i])
  const base = of(pixels)
  for (const at of [0, 1, 500, 999]) {
    for (const bit of [0, 7, 15, 24, 31]) {
      const changed = pixels.slice()
      changed[at] = (changed[at] ^ (1 << bit)) >>> 0
      assert.notEqual(of(changed), base, `pixel ${at}, bit ${bit}`)
    }
  }
  const swapped = pixels.slice()
  ;[swapped[3], swapped[4]] = [swapped[4], swapped[3]]
  assert.notEqual(of(swapped), base)
})

test('the package entry gives the encoder, the PNG decoder and the checked conversion', async () => {
  const entry = await lib('index.ts')
  for (const name of ['encodeLossless', 'encodeArgb', 'decodePng', 'pngToWebp', 'fingerprint']) {
    assert.equal(typeof entry[name], 'function', name)
  }
  const source = png({ width: 5, height: 3, colorType: 6, samples: noise(5 * 3 * 4) })
  assert.deepEqual(decode(await entry.pngToWebp(source)).data, rgbaOf(await entry.decodePng(source)))
})
