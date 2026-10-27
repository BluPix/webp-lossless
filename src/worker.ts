// Converts a PNG to lossless WebP off the main thread, as a large photo takes seconds. It gets the PNG's bytes and
// answers with the WebP's, or null when the PNG cannot be converted faithfully.
import { pngToWebp } from './convert.ts'

self.onmessage = async (e: MessageEvent<Uint8Array<ArrayBuffer>>) => {
  const webp = await pngToWebp(e.data)
  self.postMessage(webp, { transfer: webp ? [webp.buffer] : [] })
}
