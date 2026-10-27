// Prefix codes of the WebP lossless format: length-limited canonical Huffman codes, sent as code lengths the way
// DEFLATE sends them (https://developers.google.com/speed/webp/docs/webp_lossless_bitstream_specification).
import type { BitWriter } from './bits.ts'

const MAX_CODE_LENGTH = 15
const MAX_CODE_LENGTH_CODE_LENGTH = 7
// The order in which the lengths of the code-length code are sent
const CODE_LENGTH_ORDER = [17, 18, 0, 1, 2, 3, 4, 5, 16, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]
const REPEAT_PREVIOUS = 16 // repeats the previous non-zero length 3–6 times
const REPEAT_ZERO_SHORT = 17 // 3–10 zeros
const REPEAT_ZERO_LONG = 18 // 11–138 zeros

// huffmanDepths builds a Huffman tree over the weights (sorted ascending) and returns each leaf's depth
const huffmanDepths = (weights: number[]): number[] => {
  const leaves = weights.length
  const nodeWeight = new Float64Array(2 * leaves - 1)
  const parent = new Int32Array(2 * leaves - 1)
  nodeWeight.set(weights)
  // Two queues: leaves in order, and inner nodes, which are created in order of weight too
  let leaf = 0
  let inner = leaves
  let next = leaves
  const takeSmallest = (): number =>
    leaf < leaves && (inner >= next || nodeWeight[leaf] <= nodeWeight[inner]) ? leaf++ : inner++
  while (next < 2 * leaves - 1) {
    const a = takeSmallest()
    const b = takeSmallest()
    nodeWeight[next] = nodeWeight[a] + nodeWeight[b]
    parent[a] = parent[b] = next
    next++
  }
  const depth = new Int32Array(2 * leaves - 1)
  for (let node = 2 * leaves - 3; node >= 0; node--) depth[node] = depth[parent[node]] + 1
  return Array.from(depth.subarray(0, leaves))
}

// codeLengths gives every symbol with a non-zero count a code length of at most maxLength bits. The code is
// complete (every bit pattern decodes), as libwebp requires; a single symbol gets length 1 and is sent in 0 bits.
// Too deep trees are flattened by raising the smallest counts, as libwebp does.
export const codeLengths = (counts: ArrayLike<number>, maxLength: number): Uint8Array => {
  const lengths = new Uint8Array(counts.length)
  const used: number[] = []
  for (let s = 0; s < counts.length; s++) if (counts[s] > 0) used.push(s)
  if (used.length === 1) lengths[used[0]] = 1
  if (used.length < 2) return lengths
  if (used.length > 2 ** maxLength) throw new RangeError(`${used.length} symbols do not fit in ${maxLength}-bit codes`)
  for (let floor = 1; ; floor *= 2) {
    const order = used.slice().sort((a, b) => Math.max(counts[a], floor) - Math.max(counts[b], floor) || a - b)
    const depths = huffmanDepths(order.map(s => Math.max(counts[s], floor)))
    if (Math.max(...depths) > maxLength) continue
    order.forEach((s, i) => (lengths[s] = depths[i]))
    return lengths
  }
}

// PrefixCode turns symbols into bits: canonical codes, bit-reversed as the bitstream is read least significant
// bit first. A code with a single symbol takes no bits at all.
export class PrefixCode {
  readonly lengths: Uint8Array
  private readonly codes: Uint16Array
  private readonly single: boolean

  constructor(lengths: Uint8Array) {
    this.lengths = lengths
    this.codes = new Uint16Array(lengths.length)
    const perLength = new Uint16Array(MAX_CODE_LENGTH + 1)
    let symbols = 0
    for (const length of lengths) {
      if (length) {
        perLength[length]++
        symbols++
      }
    }
    this.single = symbols <= 1
    const nextCode = new Uint16Array(MAX_CODE_LENGTH + 1)
    for (let length = 1, code = 0; length <= MAX_CODE_LENGTH; length++) {
      code = (code + perLength[length - 1]) << 1
      nextCode[length] = code
    }
    for (let s = 0; s < lengths.length; s++) {
      const length = lengths[s]
      if (!length) continue
      let code = nextCode[length]++
      let reversed = 0
      for (let i = 0; i < length; i++, code >>= 1) reversed = (reversed << 1) | (code & 1)
      this.codes[s] = reversed
    }
  }

  put(bw: BitWriter, symbol: number): void {
    if (!this.single) bw.write(this.codes[symbol], this.lengths[symbol])
  }

  // cost is how many bits symbols with these counts take
  cost(counts: ArrayLike<number>): number {
    if (this.single) return 0
    let bits = 0
    for (let s = 0; s < counts.length; s++) bits += counts[s] * this.lengths[s]
    return bits
  }
}

// lengthTokens run-length encodes code lengths with the repeat symbols 16, 17 and 18: [symbol, extra bits value]
const lengthTokens = (lengths: Uint8Array): [number, number][] => {
  const tokens: [number, number][] = []
  for (let i = 0; i < lengths.length; ) {
    const value = lengths[i]
    let run = 1
    while (i + run < lengths.length && lengths[i + run] === value) run++
    i += run
    if (value === 0) {
      while (run >= 11) {
        const n = Math.min(138, run)
        tokens.push([REPEAT_ZERO_LONG, n - 11])
        run -= n
      }
      if (run >= 3) {
        tokens.push([REPEAT_ZERO_SHORT, run - 3])
        run = 0
      }
    } else {
      tokens.push([value, 0])
      run--
      while (run >= 3) {
        const n = Math.min(6, run)
        tokens.push([REPEAT_PREVIOUS, n - 3])
        run -= n
      }
    }
    for (; run > 0; run--) tokens.push([value, 0])
  }
  return tokens
}

const EXTRA_BITS: Record<number, number> = { [REPEAT_PREVIOUS]: 2, [REPEAT_ZERO_SHORT]: 3, [REPEAT_ZERO_LONG]: 7 }

// writePrefixCode sends the code for symbols with these counts and returns it for coding them. Up to two symbols
// below 256 go as a "simple" code, anything else as code lengths compressed with a code-length code.
export const writePrefixCode = (bw: BitWriter, counts: ArrayLike<number>): PrefixCode => {
  const lengths = codeLengths(counts, MAX_CODE_LENGTH)
  const used: number[] = []
  for (let s = 0; s < lengths.length; s++) if (lengths[s]) used.push(s)

  if (used.length <= 2 && used.every(s => s < 256)) {
    if (used.length === 0) used.push(0)
    bw.write(1, 1)
    bw.write(used.length - 1, 1)
    if (used[0] < 2) {
      bw.write(0, 1)
      bw.write(used[0], 1)
    } else {
      bw.write(1, 1)
      bw.write(used[0], 8)
    }
    if (used.length === 2) bw.write(used[1], 8)
    const simple = new Uint8Array(lengths.length)
    for (const s of used) simple[s] = 1
    return new PrefixCode(simple)
  }

  bw.write(0, 1)
  const tokens = lengthTokens(lengths)
  const tokenCounts = new Uint32Array(19)
  for (const [symbol] of tokens) tokenCounts[symbol]++
  const lengthCode = new PrefixCode(codeLengths(tokenCounts, MAX_CODE_LENGTH_CODE_LENGTH))
  let sent = CODE_LENGTH_ORDER.length
  while (sent > 4 && lengthCode.lengths[CODE_LENGTH_ORDER[sent - 1]] === 0) sent--
  bw.write(sent - 4, 4)
  for (let i = 0; i < sent; i++) bw.write(lengthCode.lengths[CODE_LENGTH_ORDER[i]], 3)
  bw.write(0, 1) // lengths follow for the whole alphabet
  for (const [symbol, extra] of tokens) {
    lengthCode.put(bw, symbol)
    if (symbol >= REPEAT_PREVIOUS) bw.write(extra, EXTRA_BITS[symbol])
  }
  return new PrefixCode(lengths)
}
