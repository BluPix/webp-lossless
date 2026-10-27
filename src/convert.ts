// Converting a PNG to lossless WebP. The WebP is decoded again by an independent decoder and compared with the PNG
// through a 64-bit fingerprint of all pixels, so a fault in the encoder cannot change an image: any single changed
// pixel always changes the fingerprint, several only miss it with a chance of 2^-64. The fingerprint, rather than
// the pixels themselves, is kept while encoding, as a large photo's pixels take 80 MB per copy. A PNG that cannot
// be converted faithfully, or anything unexpected, gives null, so the caller keeps the PNG.
import { decode } from '@nktkas/webp'
import { encodeArgb } from './encode.ts'
import { decodePng } from './png.ts'

// fingerprint hashes pixels (0xAARRGGBB, in order) in two lanes; each step is a bijection of the lane, so a
// difference in one pixel carries through to the end
export const fingerprint = (count: number, pixel: (i: number) => number): string => {
  let a = 0x811c9dc5
  let b = 0x9e3779b9
  for (let i = 0; i < count; i++) {
    const p = pixel(i)
    a = Math.imul(a ^ p, 0x01000193)
    b = Math.imul(b ^ p, 0x5bd1e995)
    b ^= b >>> 15
  }
  return `${count}:${a >>> 0}:${b >>> 0}`
}

const fingerprintOf = (argb: Uint32Array): string => fingerprint(argb.length, i => argb[i])

export const pngToWebp = async (png: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer> | null> => {
  try {
    const image = await decodePng(png)
    if (!image) return null
    const { width, height, iccProfile } = image
    const expected = fingerprintOf(image.argb)
    // The encoder takes the pixels over; nothing else may hold them, so they can go once it is done with them
    const take = () => {
      const pixels = image.argb
      image.argb = new Uint32Array(0)
      return pixels
    }
    const webp = encodeArgb(take(), width, height, { iccProfile })
    const check = decode(webp)
    const rgba = check.data
    const actual = fingerprint(check.width * check.height, i => ((rgba[4 * i + 3] << 24) | (rgba[4 * i] << 16) | (rgba[4 * i + 1] << 8) | rgba[4 * i + 2]) >>> 0)
    return check.width === width && check.height === height && actual === expected ? webp : null
  } catch {
    return null
  }
}
