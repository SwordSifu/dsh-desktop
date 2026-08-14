import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, delimiter } from 'node:path'

export const URL_RE = /https?:\/\/[0-9a-z._:[\]]+/i

export function parseUrlFromLine(line) {
  const m = URL_RE.exec(line ?? '')
  return m ? m[0] : null
}

export function parseBootOutput(text) {
  if (!text) return null
  for (const line of String(text).split(/\r?\n/)) {
    const url = parseUrlFromLine(line)
    if (url) return url
  }
  return null
}

export function findNodePath() {
  const envNode = process.env.DSH_DESKTOP_NODE
  if (envNode && existsSync(envNode)) return envNode
  // Packaged app: bundled node.exe next to the executable's resources.
  const bundled = process.resourcesPath ? join(process.resourcesPath, 'node', process.platform === 'win32' ? 'node.exe' : 'node') : null
  if (bundled && existsSync(bundled)) return bundled
  const names = process.platform === 'win32' ? ['node.exe', 'node'] : ['node']
  const pathVar = process.env.PATH ?? process.env.Path ?? ''
  for (const dir of pathVar.split(delimiter)) {
    if (!dir) continue
    for (const name of names) {
      const candidate = join(dir, name)
      if (existsSync(candidate)) return candidate
    }
  }
  throw new Error('node executable not found; set DSH_DESKTOP_NODE to point at a node binary')
}

/**
 * Manages the `dsh web` child process: spawn, boot-URL discovery,
 * health check, crash restart with backoff, and graceful teardown.
 * Pure Node (no Electron imports) so it is unit-testable.
 */
export class ManagedDsh {
  constructor({
    nodePath,
    binPath,
    args = [],
    cwd,
    maxRestarts = 3,
    restartBaseMs = 500,
    readyTimeoutMs = 120_000,
    stopTimeoutMs = 5_000,
    log = () => {},
  }) {
    this.nodePath = nodePath
    this.binPath = binPath
    this.args = args
    this.cwd = cwd
    this.maxRestarts = maxRestarts
    this.restartBaseMs = restartBaseMs
    this.readyTimeoutMs = readyTimeoutMs
    this.stopTimeoutMs = stopTimeoutMs
    this.log = log

    this.child = null
    this.url = null
    this.restartCount = 0
    this.stopping = false
    this.bootBuffer = ''
    this._readyResolve = null
    this._readyPromise = null
    this._exitedOnce = false
  }

  get running() {
    return this.child !== null && this.child.exitCode === null && !this.stopping
  }

  /** Starts the child and resolves with { url } once the server answers. Rejects on boot timeout. */
  start() {
    this.stopping = false
    const ready = new Promise((resolve, reject) => {
      this._readyResolve = resolve
      this._readyReject = reject
      this._bootTimer = setTimeout(() => {
        this.log('boot timeout')
        this._settled = true
        reject(new Error('boot timeout'))
        this.kill()
      }, this.readyTimeoutMs)
    })
    this._readyPromise = ready
    // Auto-restart spawns are not awaited by anyone; swallow the rejection so
    // a crash that precedes boot does not surface as an unhandled rejection.
    ready.catch(() => {})
    this._spawn()
    return ready
  }

  _spawn() {
    this.log(`spawn: ${this.nodePath} ${this.binPath} ${this.args.join(' ')}`)
    const child = spawn(this.nodePath, [this.binPath, ...this.args], {
      cwd: this.cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.child = child
    this.bootBuffer = ''
    this._exitedOnce = false

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      this.bootBuffer += chunk
      const line = chunk.split(/\r?\n/)[0]
      if (!this.url) {
        const url = parseBootOutput(chunk)
        if (url) this._onBooted(url)
      }
      if (line) this.log(`[dsh:out] ${line}`)
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      const line = chunk.split(/\r?\n/)[0]
      if (line) this.log(`[dsh:err] ${line}`)
    })

    child.on('error', (err) => {
      this.log(`spawn error: ${err.message}`)
      this._onExited(-1, err.message)
    })
    child.on('exit', (code, signal) => {
      this.log(`exit code=${code} signal=${signal}`)
      this.child = null
      if (this._readyPromise && !this._settled) {
        this._readyReject(new Error(`dsh exited before boot (code=${code})`))
        this._settled = true
      }
      if (!this.stopping) this._onExited(code, signal)
    })
  }

  _onBooted(url) {
    this.url = url
    clearTimeout(this._bootTimer)
    this.log(`booted: ${url}`)
    this._checkHealth(url).then((ok) => {
      if (ok) {
        // Only a health-checked server counts as a successful boot, so the
        // restart budget is reset here, not when the URL line appears.
        this.restartCount = 0
        if (this._readyResolve && !this._settled) {
          this._settled = true
          this._readyResolve({ url })
        }
      } else {
        this.log('health check failed, waiting for more output')
      }
    })
  }

  async _checkHealth(url) {
    const deadline = Date.now() + this.readyTimeoutMs
    while (Date.now() < deadline && this.running) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(3_000) })
        if (res.ok) return true
      } catch {
        // not up yet
      }
      await new Promise((r) => setTimeout(r, 500))
    }
    return false
  }

  _onExited(code, signal) {
    if (this._exitedOnce) return
    this._exitedOnce = true
    clearTimeout(this._bootTimer)
    this.url = null
    this._readyPromise = null
    this._readyResolve = null
    this._readyReject = null
    this._settled = false
    if (this.stopping) return
    if (this.restartCount >= this.maxRestarts) {
      this.log('max restarts reached, giving up')
      this.onGiveUp?.(code, signal)
      return
    }
    const delay = this.restartBaseMs * 2 ** this.restartCount
    this.restartCount += 1
    this.log(`restarting in ${delay}ms (attempt ${this.restartCount}/${this.maxRestarts})`)
    setTimeout(() => {
      if (!this.stopping) void this.start()
    }, delay)
  }

  /** Resolves when the current child exits; resolves immediately if none is live. */
  waitForExit() {
    const child = this.child
    if (!child || child.exitCode !== null) return Promise.resolve()
    return new Promise((resolve) => child.once('exit', resolve))
  }

  /** Graceful stop: SIGTERM, escalate to SIGKILL after stopTimeoutMs. Resolves on exit. */
  stop() {
    if (this.stopping) return this._stoppedPromise
    this.stopping = true
    this.log('stop requested')
    const child = this.child
    if (!child || child.exitCode !== null) {
      this.log('no live child to stop')
      this._stoppedPromise = Promise.resolve()
      return this._stoppedPromise
    }
    this._stoppedPromise = new Promise((resolve) => {
      const force = setTimeout(() => {
        this.log('SIGTERM timed out, killing')
        try { child.kill('SIGKILL') } catch { /* already gone */ }
      }, this.stopTimeoutMs)
      child.once('exit', () => {
        clearTimeout(force)
        resolve()
      })
      try { child.kill('SIGTERM') } catch { clearTimeout(force); resolve() }
    })
    return this._stoppedPromise
  }

  /** Hard kill without graceful dance (used on app quit). */
  kill() {
    this.stopping = true
    if (this.child && this.child.exitCode === null) {
      try { this.child.kill('SIGKILL') } catch { /* already gone */ }
    }
  }
}
