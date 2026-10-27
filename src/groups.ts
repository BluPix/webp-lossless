// Grouping blocks of an image by their symbol statistics, so that each group gets prefix codes of its own (the
// format's "meta prefix codes"): a sidebar, an editor and a photo on one screenshot code best with different
// codes. Groups are found by splitting one in two again and again, 2-means on histograms with cross-entropy as
// the distance, as long as a split saves bits by the exact measure the encoder passes in.

// The blocks' histograms, sparse: block b's symbols are symbols[start[b]] to symbols[start[b + 1] - 1]. The
// symbols of all alphabets are numbered together; alphabets gives where each one starts, and the end.
export interface Blocks {
  count: number
  size: number
  alphabets: number[]
  start: Uint32Array
  symbols: Uint32Array
  counts: Uint32Array
}

export interface Grouping {
  group: Uint16Array // each block's group
  histograms: Uint32Array[] // each group's symbol counts
}

const SMOOTHING = 0.25 // a symbol a group has not seen yet still costs something finite
const ROUNDS = 6

const sum = (blocks: Blocks, members: number[]): Uint32Array => {
  const histogram = new Uint32Array(blocks.size)
  for (const b of members) {
    for (let k = blocks.start[b]; k < blocks.start[b + 1]; k++) histogram[blocks.symbols[k]] += blocks.counts[k]
  }
  return histogram
}

// bitsPerSymbol is roughly what each symbol costs with codes made for this histogram: -log2 of its share
const bitsPerSymbol = (blocks: Blocks, histogram: Uint32Array): Float64Array => {
  const bits = new Float64Array(blocks.size)
  for (let a = 0; a + 1 < blocks.alphabets.length; a++) {
    const from = blocks.alphabets[a]
    const to = blocks.alphabets[a + 1]
    let total = 0
    for (let s = from; s < to; s++) total += histogram[s]
    const logTotal = Math.log2(total + SMOOTHING * (to - from))
    for (let s = from; s < to; s++) bits[s] = logTotal - Math.log2(histogram[s] + SMOOTHING)
  }
  return bits
}

const blockBits = (blocks: Blocks, b: number, bits: Float64Array): number => {
  let total = 0
  for (let k = blocks.start[b]; k < blocks.start[b + 1]; k++) total += blocks.counts[k] * bits[blocks.symbols[k]]
  return total
}

const blockSymbols = (blocks: Blocks, b: number): number => {
  let n = 0
  for (let k = blocks.start[b]; k < blocks.start[b + 1]; k++) n += blocks.counts[k]
  return n
}

interface Group {
  members: number[]
  histogram: Uint32Array
  bits: number
}
interface Split {
  halves: [Group, Group]
  saved: number
}

// split divides a group in two, starting with the blocks its statistics suit worse than the median one; null
// when that saves nothing. Blocks without symbols of their own (inside a long copy) go with the first half.
const split = (blocks: Blocks, group: Group, cost: (histogram: Uint32Array) => number): Split | null => {
  const bits = bitsPerSymbol(blocks, group.histogram)
  const perSymbol = new Map<number, number>()
  for (const b of group.members) {
    const n = blockSymbols(blocks, b)
    if (n) perSymbol.set(b, blockBits(blocks, b, bits) / n)
  }
  const coded = [...perSymbol.keys()]
  const empty = group.members.filter(b => !perSymbol.has(b))
  const median = [...perSymbol.values()].sort((x, y) => x - y)[coded.length >> 1]
  const worse = coded.filter(b => perSymbol.get(b)! > median)
  if (!worse.length || worse.length === coded.length) return null
  let tables = [bitsPerSymbol(blocks, sum(blocks, coded.filter(b => perSymbol.get(b)! <= median))), bitsPerSymbol(blocks, sum(blocks, worse))]
  let halves: [number[], number[]] = [[], []]
  for (let round = 0; round < ROUNDS; round++) {
    const next: [number[], number[]] = [[], []]
    for (const b of coded) next[blockBits(blocks, b, tables[1]) < blockBits(blocks, b, tables[0]) ? 1 : 0].push(b)
    if (!next[0].length || !next[1].length) return null
    const settled = next[1].length === halves[1].length && next[1].every((b, i) => b === halves[1][i])
    halves = next
    if (settled) break
    tables = halves.map(members => bitsPerSymbol(blocks, sum(blocks, members)))
  }
  halves[0] = halves[0].concat(empty)
  const [a, b] = halves.map(members => {
    const histogram = sum(blocks, members)
    return { members, histogram, bits: cost(histogram) }
  })
  const saved = group.bits - a.bits - b.bits
  return saved > 0 ? { halves: [a, b], saved } : null
}

// groupBlocks splits the blocks into at most maxGroups groups, each split the one that saves the most bits
export const groupBlocks = (blocks: Blocks, cost: (histogram: Uint32Array) => number, maxGroups: number): Grouping => {
  const all = Array.from({ length: blocks.count }, (_, b) => b)
  const histogram = sum(blocks, all)
  const groups: Group[] = [{ members: all, histogram, bits: cost(histogram) }]
  const splits = new Map<Group, Split | null>()
  while (groups.length < maxGroups) {
    let best: Split | null = null
    let bestGroup: Group | null = null
    for (const g of groups) {
      if (!splits.has(g)) splits.set(g, split(blocks, g, cost))
      const s = splits.get(g)!
      if (s && (!best || s.saved > best.saved)) {
        best = s
        bestGroup = g
      }
    }
    if (!best || !bestGroup) break
    groups.splice(groups.indexOf(bestGroup), 1, ...best.halves)
  }
  const group = new Uint16Array(blocks.count)
  groups.forEach((g, i) => g.members.forEach(b => (group[b] = i)))
  return { group, histograms: groups.map(g => g.histogram) }
}
