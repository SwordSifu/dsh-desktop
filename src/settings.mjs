import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

const DEFAULTS = {
  autostart: false,
  minimizeToTray: true,
  window: { width: 1280, height: 820 },
}

/** Minimal JSON persistence in a directory owned by the shell. */
export class Settings {
  constructor(dir) {
    this.file = join(dir, 'settings.json')
    this.data = { ...DEFAULTS }
    if (existsSync(this.file)) {
      try {
        this.data = { ...DEFAULTS, ...JSON.parse(readFileSync(this.file, 'utf8')) }
      } catch {
        // corrupt file: fall back to defaults
      }
    }
  }

  get(key) {
    return this.data[key]
  }

  set(key, value) {
    this.data[key] = value
    this.save()
  }

  save() {
    mkdirSync(dirname(this.file), { recursive: true })
    writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8')
  }
}
