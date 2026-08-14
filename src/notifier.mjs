const DEBOUNCE_MS = 30_000

/**
 * Watches the dsh downlink streams (/api/events.mux + /api/events.host) and
 * emits desktop notifications for approval requests and finished turns.
 * Pure Node (native WebSocket in Node >=22), zero dependencies.
 */
export class DshNotifier {
  constructor({ baseUrl, notify, log = () => {}, debounceMs = DEBOUNCE_MS }) {
    this.baseUrl = baseUrl.replace(/\/$/, '')
    this.notify = notify
    this.log = log
    this.debounceMs = debounceMs
    this.sockets = []
    this.stopping = false
    this.titles = new Map()
    this.lastNotified = new Map()
    this._timers = []
  }

  start() {
    this.stopping = false
    this._open('events.mux', this._handleMux.bind(this))
    this._open('events.host', this._handleHost.bind(this))
  }

  stop() {
    this.stopping = true
    for (const s of this.sockets) {
      try { s.close() } catch { /* already closed */ }
    }
    this.sockets = []
    for (const t of this._timers) clearTimeout(t)
    this._timers = []
  }

  _open(path, onMessage) {
    const url = `${this.baseUrl}/api/${path}`
    const sock = new WebSocket(url)
    this.sockets.push(sock)

    sock.addEventListener('open', () => this.log(`ws open: ${path}`))
    sock.addEventListener('message', (ev) => {
      let msg
      try {
        msg = JSON.parse(String(ev.data))
      } catch {
        return
      }
      if (msg?.type !== 'server-request') return
      try {
        onMessage(msg.method, msg.payload ?? {})
      } catch (err) {
        this.log(`frame error on ${path}: ${err.message}`)
      }
    })
    sock.addEventListener('close', () => {
      const i = this.sockets.indexOf(sock)
      if (i >= 0) this.sockets.splice(i, 1)
      if (!this.stopping) {
        this.log(`ws closed: ${path}, reconnecting`)
        const t = setTimeout(() => this._open(path, onMessage), 500 + Math.random() * 500)
        this._timers.push(t)
      }
    })
    sock.addEventListener('error', () => {
      // close follows; reconnection handled there
    })
  }

  _handleMux(method, payload) {
    switch (method) {
      case 'approval/requested': {
        const { sessionId, toolName = 'tool', reason } = payload
        const title = this._title(sessionId)
        const body = reason ? `${toolName}: ${reason}` : `${toolName} 请求权限`
        this._fire('approval', sessionId, `${title} · 权限请求`, body)
        break
      }
      case 'session/event': {
        const { sessionId, event } = payload
        if (event?.type === 'turn/end') {
          const title = this._title(sessionId)
          this._fire('turn', sessionId, `${title} · 任务完成`, 'Agent 已完成一轮对话')
        }
        break
      }
      case 'session/projection': {
        if (payload.key === 'title' && typeof payload.value === 'string' && payload.value) {
          this.titles.set(payload.sessionId, payload.value)
        }
        break
      }
      default:
        break
    }
  }

  _handleHost(method, payload) {
    void method
    void payload
  }

  _title(sessionId) {
    return this.titles.get(sessionId) || 'dsh'
  }

  _fire(kind, sessionId, title, body) {
    const key = `${kind}:${sessionId}`
    const now = Date.now()
    const last = this.lastNotified.get(key) ?? 0
    if (now - last < this.debounceMs) return
    this.lastNotified.set(key, now)
    this.notify(title, body, sessionId)
  }
}
