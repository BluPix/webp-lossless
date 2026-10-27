// BitWriter packs values least significant bit first, the order in which the WebP lossless bitstream is read.

export class BitWriter {
  private buf: Uint8Array
  private pos = 0
  private acc = 0 // pending bits, fewer than 8 between calls
  private used = 0

  constructor(capacity = 1 << 16) {
    this.buf = new Uint8Array(capacity)
  }

  // write appends the low `bits` bits of value; at most 24 bits at a time
  write(value: number, bits: number): void {
    this.acc |= value << this.used
    this.used += bits
    while (this.used >= 8) {
      if (this.pos === this.buf.length) this.grow()
      this.buf[this.pos++] = this.acc & 0xff
      this.acc >>>= 8
      this.used -= 8
    }
  }

  // bits written so far
  get length(): number {
    return this.pos * 8 + this.used
  }

  // finish pads the last byte with zero bits and returns everything written
  finish(): Uint8Array {
    if (this.used > 0) this.write(0, 8 - this.used)
    return this.buf.subarray(0, this.pos)
  }

  private grow(): void {
    const next = new Uint8Array(this.buf.length * 2)
    next.set(this.buf)
    this.buf = next
  }
}
