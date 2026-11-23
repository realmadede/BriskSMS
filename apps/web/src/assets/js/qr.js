/*
 * Small QR code encoder for the console: byte mode, error correction level M, versions 1 to 10
 * (up to 213 bytes). Used for the phone pairing code and the authenticator set-up code, so
 * neither secret ever leaves the browser to be drawn by someone else's service.
 *
 *   BriskQR.toSvg('text')  ->  '<svg ...>' string
 */
(function (root) {
  'use strict';

  // Version -> [error-correction codewords per block, [[blocks, data codewords per block], ...]] (level M)
  const BLOCKS = [
    null,
    [10, [[1, 16]]],
    [16, [[1, 28]]],
    [26, [[1, 44]]],
    [18, [[2, 32]]],
    [24, [[2, 43]]],
    [16, [[4, 27]]],
    [18, [[4, 31]]],
    [22, [[2, 38], [2, 39]]],
    [22, [[3, 36], [2, 37]]],
    [26, [[4, 43], [1, 44]]],
  ];
  const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
  const MAX_VERSION = 10;

  // Arithmetic in GF(256) for Reed-Solomon
  const EXP = new Uint8Array(512);
  const LOG = new Uint8Array(256);
  for (let i = 0, x = 1; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 256) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

  function rsRemainder(data, degree) {
    let gen = [1];
    for (let i = 0; i < degree; i++) {
      const next = new Array(gen.length + 1).fill(0);
      for (let j = 0; j < gen.length; j++) {
        next[j] ^= gen[j];
        next[j + 1] ^= mul(gen[j], EXP[i]);
      }
      gen = next;
    }
    const rem = new Array(degree).fill(0);
    for (const d of data) {
      const factor = d ^ rem.shift();
      rem.push(0);
      if (factor) for (let i = 0; i < degree; i++) rem[i] ^= mul(gen[i + 1], factor);
    }
    return rem;
  }

  function dataCapacity(version) {
    return BLOCKS[version][1].reduce((sum, [count, cw]) => sum + count * cw, 0);
  }

  // Text -> data codewords + error correction, interleaved in transmission order
  function buildCodewords(text, version) {
    const bytes = Array.from(new TextEncoder().encode(text));
    const bits = [];
    const put = (value, length) => { for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1); };
    put(0b0100, 4);
    put(bytes.length, version < 10 ? 8 : 16);
    bytes.forEach((b) => put(b, 8));
    const capacityBits = dataCapacity(version) * 8;
    put(0, Math.min(4, capacityBits - bits.length));
    while (bits.length % 8) bits.push(0);
    const data = [];
    for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(''), 2));
    for (let pad = 0xec; data.length < dataCapacity(version); pad ^= 0xec ^ 0x11) data.push(pad);

    const [ecLen, groups] = BLOCKS[version];
    const dataBlocks = [];
    let offset = 0;
    for (const [count, cw] of groups) {
      for (let i = 0; i < count; i++) {
        dataBlocks.push(data.slice(offset, offset + cw));
        offset += cw;
      }
    }
    const ecBlocks = dataBlocks.map((block) => rsRemainder(block, ecLen));
    const out = [];
    const longest = Math.max(...dataBlocks.map((b) => b.length));
    for (let i = 0; i < longest; i++) dataBlocks.forEach((b) => { if (i < b.length) out.push(b[i]); });
    for (let i = 0; i < ecLen; i++) ecBlocks.forEach((b) => out.push(b[i]));
    return out;
  }

  const MASKS = [
    (x, y) => (x + y) % 2 === 0,
    (x, y) => y % 2 === 0,
    (x, y) => x % 3 === 0,
    (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
    (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
    (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
  ];

  function penalty(m) {
    const size = m.length;
    let score = 0;
    let dark = 0;
    const lines = [];
    for (let a = 0; a < size; a++) {
      let row = '';
      let col = '';
      for (let b = 0; b < size; b++) {
        row += m[a][b] ? '1' : '0';
        col += m[b][a] ? '1' : '0';
        if (m[a][b]) dark++;
      }
      lines.push(row, col);
    }
    for (const line of lines) {
      const runs = line.match(/0+|1+/g);
      for (const run of runs) if (run.length >= 5) score += 3 + (run.length - 5);
      for (const pattern of ['10111010000', '00001011101']) {
        let at = line.indexOf(pattern);
        while (at >= 0) { score += 40; at = line.indexOf(pattern, at + 1); }
      }
    }
    for (let y = 0; y < size - 1; y++) {
      for (let x = 0; x < size - 1; x++) {
        const v = m[y][x];
        if (v === m[y][x + 1] && v === m[y + 1][x] && v === m[y + 1][x + 1]) score += 3;
      }
    }
    const total = size * size;
    score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
    return score;
  }

  function buildMatrix(text) {
    let version = 1;
    const length = new TextEncoder().encode(text).length;
    while (version <= MAX_VERSION && 4 + (version < 10 ? 8 : 16) + 8 * length > dataCapacity(version) * 8) version++;
    if (version > MAX_VERSION) throw new Error('Text is too long for the QR code');

    const size = 17 + 4 * version;
    const m = Array.from({ length: size }, () => new Array(size).fill(false));
    const fixed = Array.from({ length: size }, () => new Array(size).fill(false));
    const set = (x, y, dark) => {
      if (x < 0 || y < 0 || x >= size || y >= size) return;
      m[y][x] = dark;
      fixed[y][x] = true;
    };

    for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
    for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
      for (let dy = -4; dy <= 4; dy++) {
        for (let dx = -4; dx <= 4; dx++) {
          set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 2 && Math.max(Math.abs(dx), Math.abs(dy)) !== 4);
        }
      }
    }
    const pos = ALIGN[version];
    for (let i = 0; i < pos.length; i++) {
      for (let j = 0; j < pos.length; j++) {
        if ((i === 0 && j === 0) || (i === 0 && j === pos.length - 1) || (i === pos.length - 1 && j === 0)) continue;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) set(pos[i] + dx, pos[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }

    const drawFormat = (mask) => {
      const data = mask; // level M is 00
      let rem = data;
      for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
      const bits = ((data << 10) | rem) ^ 0x5412;
      const bit = (i) => ((bits >>> i) & 1) !== 0;
      for (let i = 0; i <= 5; i++) set(8, i, bit(i));
      set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
      for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
      for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(i));
      for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(i));
      set(8, size - 8, true);
    };
    drawFormat(0);
    if (version >= 7) {
      let rem = version;
      for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
      const bits = (version << 12) | rem;
      for (let i = 0; i < 18; i++) {
        const dark = ((bits >>> i) & 1) !== 0;
        const a = size - 11 + (i % 3);
        const b = Math.floor(i / 3);
        set(a, b, dark);
        set(b, a, dark);
      }
    }

    const codewords = buildCodewords(text, version);
    let i = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert;
          if (!fixed[y][x] && i < codewords.length * 8) {
            m[y][x] = ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0;
            i++;
          }
        }
      }
    }

    let best = null;
    let bestScore = Infinity;
    for (let mask = 0; mask < 8; mask++) {
      const trial = m.map((row) => row.slice());
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fixed[y][x] && MASKS[mask](x, y)) trial[y][x] = !trial[y][x];
      // Format bits depend on the mask, so they are written in before scoring
      const score = penalty(withFormat(trial, mask, size));
      if (score < bestScore) { best = withFormat(trial, mask, size); bestScore = score; }
    }
    return best;
  }

  // Writes the format information for `mask` into a copy of the matrix
  function withFormat(matrix, mask, size) {
    const m = matrix.map((row) => row.slice());
    let rem = mask;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((mask << 10) | rem) ^ 0x5412;
    const bit = (i) => ((bits >>> i) & 1) !== 0;
    const put = (x, y, dark) => { m[y][x] = dark; };
    for (let i = 0; i <= 5; i++) put(8, i, bit(i));
    put(8, 7, bit(6)); put(8, 8, bit(7)); put(7, 8, bit(8));
    for (let i = 9; i < 15; i++) put(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) put(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) put(8, size - 15 + i, bit(i));
    put(8, size - 8, true);
    return m;
  }

  function toSvg(text, options) {
    const quiet = 4;
    const matrix = buildMatrix(String(text));
    const size = matrix.length + quiet * 2;
    let path = '';
    matrix.forEach((row, y) => row.forEach((dark, x) => { if (dark) path += `M${x + quiet} ${y + quiet}h1v1h-1z`; }));
    const label = (options && options.label) || 'QR code';
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" role="img" aria-label="${label}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
  }

  const api = { toSvg, buildMatrix, rsRemainder };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BriskQR = api;
})(typeof window !== 'undefined' ? window : globalThis);
