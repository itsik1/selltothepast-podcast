#!/usr/bin/env node
/**
 * Generate the toolbar icons. Kept as a script rather than committed-and-forgotten
 * binaries so the colours can be changed in one place: node tools/gen-icons.js
 */
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const BG = [11, 95, 187];     // accent blue, matches popup.css
const FG = [255, 255, 255];

function png(size) {
  const r = size * 0.22;                  // corner radius
  const cx = size / 2, cy = size / 2;
  const outer = size * 0.30, inner = size * 0.17;

  const raw = Buffer.alloc(size * (size * 4 + 1));
  let p = 0;
  for (let y = 0; y < size; y++) {
    raw[p++] = 0;                          // PNG filter byte: none
    for (let x = 0; x < size; x++) {
      // rounded-square mask
      const dx = Math.max(r - x, 0, x - (size - r));
      const dy = Math.max(r - y, 0, y - (size - r));
      const corner = Math.hypot(dx, dy);
      const insideBox = corner <= r;

      // ring: a bite out of the square so the mark reads at 16px
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      const onRing = d <= outer && d >= inner;

      const [cr, cg, cb] = onRing ? FG : BG;
      const a = insideBox ? 255 : 0;
      raw[p++] = cr; raw[p++] = cg; raw[p++] = cb; raw[p++] = a;
    }
  }

  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 6;    // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

let TABLE = null;
function crc32(buf) {
  if (!TABLE) {
    TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      TABLE[n] = c;
    }
  }
  let c = -1;
  for (const b of buf) c = TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

const dir = path.join(__dirname, '..', 'icons');
fs.mkdirSync(dir, { recursive: true });
for (const size of [16, 48, 128]) {
  const file = path.join(dir, `icon${size}.png`);
  fs.writeFileSync(file, png(size));
  console.log('wrote', path.relative(process.cwd(), file));
}
