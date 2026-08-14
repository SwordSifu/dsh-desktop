/**
 * Renders the official DeepSeek mark (icons/deepseek-mark.svg) as the app
 * icons: black mark on white (icon.png) / transparent (tray.png) background.
 * Uses sharp (present in node_modules as a dsh dependency) so no extra
 * packages are needed.
 */
import sharp from 'sharp'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const mark = join(root, 'icons', 'deepseek-mark.svg')
const WHITE = { r: 255, g: 255, b: 255, alpha: 255 }
const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 }

async function render(size, background) {
  const logo = await sharp(mark, { density: 600 })
    .resize(Math.round(size * 0.8), Math.round(size * 0.8), { fit: 'contain' })
    .png()
    .toBuffer()
  const bg = await sharp({ create: { width: size, height: size, channels: 4, background } })
    .composite([{ input: logo, gravity: 'center' }])
    .png()
    .toBuffer()
  return bg
}

mkdirSync(join(root, 'icons'), { recursive: true })
writeFileSync(join(root, 'icons', 'icon.png'), await render(256, WHITE))
writeFileSync(join(root, 'icons', 'tray.png'), await render(16, TRANSPARENT))
console.log('deepseek icons written (256px black-on-white + 16px transparent tray)')
