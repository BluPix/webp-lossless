# webp-lossless

A lossless WebP encoder in plain TypeScript, without WebAssembly. It turns a PNG, such as a screenshot pasted from
the clipboard, into a WebP file with exactly the same pixels, typically about a quarter of the PNG for screenshots
of text and about two thirds for photos. It compresses about as well as `cwebp -lossless -m 4`.

It was written for a web app whose Content Security Policy forbids WebAssembly. The good WebP encoders for the
browser are libwebp compiled to WebAssembly, which needs `'wasm-unsafe-eval'`. The browser's own canvas is no
substitute: Chrome makes a lossless WebP almost as large as the PNG, Safari cannot make WebP at all, and reading
pixels through a canvas may change them (color management, premultiplied alpha, noise added against
fingerprinting).

## Status: not maintained

This code is published as is, under the MIT license. There is no npm package and no support, and issues or pull
requests will most likely go unanswered. Copy the files you need into your project and change them as you like.

## Results

| Image | Pixels | PNG | webp-lossless | `cwebp -lossless -m 4` |
| --- | --- | --- | --- | --- |
| screenshot of a code editor | 3840 × 2160 | 862 kB | 191 kB, 0.4 s | 191 kB, 0.2 s |
| screenshot of documentation | 3840 × 2160 | 615 kB | 172 kB, 0.4 s | 165 kB, 0.2 s |
| screenshot of a web page with a photo | 3840 × 2160 | 3 856 kB | 2 689 kB, 1.6 s | 2 768 kB, 3.0 s |
| photo of a concert | 2501 × 2848 | 7 479 kB | 5 205 kB, 1.9 s | 5 202 kB, 2.6 s |
| photo of a nebula | 3888 × 5184 | 20 897 kB | 13 197 kB, 4.9 s | 13 211 kB, 8.0 s |
| image with added noise | 3840 × 2160 | 2 583 kB | 1 696 kB, 1.3 s | 1 727 kB, 2.6 s |

The PNG files were written by ImageMagick with its default settings. The webp-lossless times are the whole
`pngToWebp`: decoding the PNG, encoding, decoding the WebP again and checking every pixel, in Node 24 on a Mac with
an Apple M processor. The cwebp times (libwebp 1.6.0) are the whole command on the same machine, encoding from a
PPM file. libwebp's `dwebp` decodes all six files to the original pixels.

## Install

Install the release, which comes compiled to JavaScript with types:

```sh
npm install https://github.com/BluPix/webp-lossless/releases/download/1.0.0/webp-lossless-1.0.0.tgz
```

npm records the file's checksum, so a later install fails rather than takes a different file. Or copy `src/` into
your project: it is TypeScript with `.ts` extensions in imports, as bundlers such as Vite or esbuild take it, and
Node 22.18 and later run it directly.

## Usage

Converting a PNG, with a check that the WebP holds exactly its pixels:

```ts
import { pngToWebp } from 'webp-lossless'

const webp = await pngToWebp(new Uint8Array(await file.arrayBuffer()))
// null when the PNG cannot be converted faithfully (see below): keep the PNG then
const out = webp ? new Blob([webp], { type: 'image/webp' }) : file
```

A large photo takes seconds, so in a page run it in a worker. The worker, `webp-lossless/worker` (`src/worker.ts`
when copied), takes the PNG's bytes and answers with the WebP's, or null. With Vite:

```ts
import PngWorker from 'webp-lossless/worker?worker'

const worker = new PngWorker()
worker.onmessage = (e: MessageEvent<Uint8Array | null>) => {
  // e.data is the WebP, or null to keep the PNG
}
worker.postMessage(png, [png.buffer])
```

Encoding pixels you already have, 4 bytes per pixel, red, green, blue and alpha, not premultiplied:

```ts
import { encodeLossless } from 'webp-lossless'

const webp = encodeLossless(rgba, width, height)
```

`encodeArgb` does the same for pixels packed as `0xAARRGGBB` in a `Uint32Array` and changes them while encoding,
so a large image is never copied. Both take options: `iccProfile` to carry a color profile along, and `predictor`,
`search` and `groups` to force a choice the encoder otherwise makes itself.

## Which PNG converts

`pngToWebp` decodes the PNG itself, row by row, so it gets the file's exact pixels. Every color type and bit depth
converts, interlaced or not, palettes and transparent color keys included, and sRGB however the file states it. It
returns null instead of a WebP that would look different from the PNG, and for a broken file:

- 16-bit samples with detail beyond 8 bits, as WebP holds 8 bits per channel (16-bit files that hold 8-bit values
  convert),
- an animation (APNG),
- a color space other than sRGB without an embedded profile: another gamma or other primaries in gAMA and cHRM, or
  HDR in cICP,
- an EXIF orientation that turns or mirrors the image,
- more than 16384 pixels on a side, the most WebP can hold.

After encoding, the WebP is decoded by an independent decoder, [@nktkas/webp](https://jsr.io/@nktkas/webp), and
compared with the PNG through a 64-bit fingerprint of all pixels. A single changed pixel always changes the
fingerprint, so a fault in the encoder cannot pass for a good file. An independent decoder is the point: one
written alongside the encoder could share its misreading of the specification.

The encoder is lossless only. For photos where some loss is fine, the canvas makes a JPEG in every browser and a
lossy WebP in Chrome and Firefox, several times smaller.

## How it works

It follows the [WebP lossless bitstream](https://www.rfc-editor.org/rfc/rfc9649) (RFC 9649):

- **Subtract green** first, always.
- **Predictor:** each 32 × 32 block gets the one of the 14 predictors with the smallest residuals. Screenshots of
  text usually code smaller without any, as letters repeat pixel for pixel while their residuals change with the
  surroundings.
- **LZ77** either searches the whole window through a hash chain, with lazy matching, or only copies runs from the
  pixel to the left and the row above, as libwebp's RLE does. Text needs the search, photos code smaller without
  it, since a far copy of a few pixels costs more than the pixels. A 2048-entry color cache follows.
- **The choice is made on a sample:** whether to predict and which LZ77 to use is decided on stripes of rows
  spread over the image, an eighth of it, and only the winner is encoded for the whole image.
- **Prefix codes per group of blocks:** blocks with different statistics, like a sidebar, code and a photo on one
  screen, are grouped by 2-means with cross-entropy as the distance, when that makes the file smaller.
- **A color profile** goes into an extended container next to the image.

Not used: the color transform, which made files 0.4 to 1 % larger on screenshots and photos, and color indexing,
so a PNG with a small palette can come out a few percent larger as WebP. What remains between this encoder and
libwebp on screenshots is mostly libwebp's cost-based LZ77 parsing.

## Tests

```sh
npm install
npm test
```

The tests type-check the source and encode generated images every way the encoder can, each checked pixel for
pixel by the independent decoder. They need Node 22.18 or later. The PNG decoder was also checked against
ImageMagick on the whole [PngSuite](http://www.schaik.com/pngsuite/): every file it converts gives ImageMagick's
pixels.

## Releasing

A pushed tag such as `1.0.1` makes GitHub Actions run the tests, build the tarball and publish it as a release.
A release made in the web UI with a new tag gets the tarball the same way. The version comes from the tag, so
`package.json` in the repository stays at `0.0.0-development`.

## Credits

- The format is Google's, specified in [RFC 9649](https://www.rfc-editor.org/rfc/rfc9649).
- Several decisions follow [libwebp](https://chromium.googlesource.com/webm/libwebp) (BSD-3-Clause): choosing
  between LZ77 and runs, the limit on blocks with their own statistics, flattening too deep prefix code trees. No
  libwebp code is copied.
- [@nktkas/webp](https://jsr.io/@nktkas/webp) (MIT) checks the output.
- Written by Jiří Němec with Claude, an AI assistant by Anthropic.

## License

MIT, see [LICENSE](LICENSE).
