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
const png = ({ width, height, colorType, samples, filters = [0, 1, 2, 3, 4], depth = 8, interlace = 0, before = [], level = 6 }) => {
  const bpp = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType]
  const stride = width * bpp
  const raw = Buffer.alloc(height * (stride + 1))
  for (let y = 0; y < height; y++) {
    const filter = filters[y % filters.length]
    raw[y * (stride + 1)] = filter
    for (let x = 0; x < stride; x++) {
      const v = samples[y * stride + x]
      const a = x >= bpp ? samples[y * stride + x - bpp] : 0
      const b = y > 0 ? samples[(y - 1) * stride + x] : 0
      const c = x >= bpp && y > 0 ? samples[(y - 1) * stride + x - bpp] : 0
      const predicted = [0, a, b, (a + b) >> 1, paeth(a, b, c)][filter]
      raw[y * (stride + 1) + 1 + x] = (v - predicted) & 0xff
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
    chunk('IDAT', deflateSync(raw, { level })),
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

test('PNG: what WebP could not show the same stays a PNG', async () => {
  const samples = noise(4 * 4 * 3)
  const base = { width: 4, height: 4, colorType: 2, samples }
  assert.ok(await decodePng(png({ ...base, before: [exif(1)] })), 'upright EXIF is fine')
  for (const [name, options] of Object.entries({
    '16 bits per channel': { depth: 16, samples: noise(4 * 4 * 6) },
    interlaced: { interlace: 1 },
    'gamma without sRGB or a profile': { before: [chunk('gAMA', [0, 0, 0xb1, 0x8f])] },
    'HDR color space': { before: [chunk('cICP', [9, 16, 0, 1])] },
    'a transparent color key': { before: [chunk('tRNS', [0, 1, 0, 2, 0, 3])] },
    'rotated by EXIF': { before: [exif(6)] },
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

test('anything unexpected keeps the PNG', async () => {
  assert.equal(await pngToWebp(new Uint8Array([137, 80, 78, 71])), null)
  assert.equal(await pngToWebp(png({ width: 4, height: 4, colorType: 2, samples: noise(48), interlace: 1 })), null)
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
