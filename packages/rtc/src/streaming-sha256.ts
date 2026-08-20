const K = new Uint32Array([
  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
  0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
  0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
  0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
  0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
]);

export class IncrementalSha256 {
  private readonly state = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
  private readonly block = new Uint8Array(64);
  private blockLength = 0;
  private bytesHashed = 0;
  private finished = false;

  update(input: ArrayBuffer | ArrayBufferView): this {
    if (this.finished) throw new Error("SHA-256 já foi finalizado.");
    const bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    this.bytesHashed += bytes.byteLength;
    let offset = 0;
    while (offset < bytes.byteLength) {
      const take = Math.min(64 - this.blockLength, bytes.byteLength - offset);
      this.block.set(bytes.subarray(offset, offset + take), this.blockLength);
      this.blockLength += take;
      offset += take;
      if (this.blockLength === 64) { this.compress(this.block); this.blockLength = 0; }
    }
    return this;
  }

  digestHex(): string {
    const digest = this.digest();
    return [...digest].map((value) => value.toString(16).padStart(2, "0")).join("");
  }

  digest(): Uint8Array {
    if (!this.finished) this.finish();
    const output = new Uint8Array(32);
    const view = new DataView(output.buffer);
    for (let index = 0; index < 8; index += 1) view.setUint32(index * 4, this.state[index]!, false);
    return output;
  }

  private finish(): void {
    this.finished = true;
    const bitLength = BigInt(this.bytesHashed) * 8n;
    this.block[this.blockLength++] = 0x80;
    if (this.blockLength > 56) { this.block.fill(0, this.blockLength); this.compress(this.block); this.blockLength = 0; }
    this.block.fill(0, this.blockLength, 56);
    const view = new DataView(this.block.buffer);
    view.setUint32(56, Number((bitLength >> 32n) & 0xffffffffn), false);
    view.setUint32(60, Number(bitLength & 0xffffffffn), false);
    this.compress(this.block);
  }

  private compress(chunk: Uint8Array): void {
    const words = new Uint32Array(64);
    const view = new DataView(chunk.buffer, chunk.byteOffset, 64);
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(index * 4, false);
    for (let index = 16; index < 64; index += 1) {
      const x = words[index - 15]!; const y = words[index - 2]!;
      words[index] = (words[index - 16]! + (rotr(x,7)^rotr(x,18)^(x>>>3)) + words[index - 7]! + (rotr(y,17)^rotr(y,19)^(y>>>10))) >>> 0;
    }
    let a=this.state[0]!,b=this.state[1]!,c=this.state[2]!,d=this.state[3]!,e=this.state[4]!,f=this.state[5]!,g=this.state[6]!,h=this.state[7]!;
    for (let index = 0; index < 64; index += 1) {
      const t1=(h+(rotr(e,6)^rotr(e,11)^rotr(e,25))+((e&f)^(~e&g))+K[index]!+words[index]!)>>>0;
      const t2=((rotr(a,2)^rotr(a,13)^rotr(a,22))+((a&b)^(a&c)^(b&c)))>>>0;
      h=g;g=f;f=e;e=(d+t1)>>>0;d=c;c=b;b=a;a=(t1+t2)>>>0;
    }
    this.state[0]=(this.state[0]!+a)>>>0; this.state[1]=(this.state[1]!+b)>>>0;
    this.state[2]=(this.state[2]!+c)>>>0; this.state[3]=(this.state[3]!+d)>>>0;
    this.state[4]=(this.state[4]!+e)>>>0; this.state[5]=(this.state[5]!+f)>>>0;
    this.state[6]=(this.state[6]!+g)>>>0; this.state[7]=(this.state[7]!+h)>>>0;
  }
}

export async function sha256BlobHex(blob: Blob): Promise<string> {
  const hasher = new IncrementalSha256();
  const reader = blob.stream().getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) hasher.update(value);
  }
  return hasher.digestHex();
}

function rotr(value: number, bits: number): number { return (value >>> bits) | (value << (32 - bits)); }
