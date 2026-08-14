/**
 * Generates simple PNG icons (tray 16x16, window 256x256) with no dependencies:
 * a rounded square in DeepSeek blue with two white "chat lines".
 * PNG encoding via zlib + hand-rolled CRC32.
 */
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const scanlines = Buffer.alloc(size * (1 + size * 4))
  for (let y = 0; y < size; y++) {
    const rowStart = y * (1 + size * 4)
    scanlines[rowStart] = 0
    rgba.copy(scanlines, rowStart + 1, y * size * 4, (y + 1) * size * 4)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(scanlines, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const BLUE = [77, 107, 254, 255]

function render(size) {
  const s = size / 256 // design at 256px, scale down
  const r = 56 * s
  const cx = 128 * s
  const cy = 128 * s
  const half = 92 * s
  const rgba = Buffer.alloc(size * size * 4)

  const inRounded = (x, y) => {
    const dx = Math.max(Math.abs(x - cx) - (half - r), 0)
    const dy = Math.max(Math.abs(y - cy) - (half - r), 0)
    return dx * dx + dy * dy <= r * r
  }
  const inBar = (x, y) => {
    const bw = 118 * s
    const bh = 26 * s
    const yOffs = [-34 * s, 34 * s]
    return yOffs.some((off) => Math.abs(y - (cy + off)) < bh / 2 && Math.abs(x - cx) < bw / 2)
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4
      if (inRounded(x, y)) {
        if (inBar(x, y)) {
          rgba[i] = 255
          rgba[i + 1] = 255
          rgba[i + 2] = 255
          rgba[i + 3] = 255
        } else {
          rgba.set(BLUE, i)
        }
      } else {
        rgba[i + 3] = 0
      }
    }
  }
  return rgba
}

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'icons')
mkdirSync(outDir, { recursive: true })
writeFileSync(join(outDir, 'tray.png'), encodePng(16, render(16)))
writeFileSync(join(outDir, 'icon.png'), encodePng(256, render(256)))
console.log('icons written to', outDir)
