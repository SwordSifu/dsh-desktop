import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseUrlFromLine, parseBootOutput, ManagedDsh, findNodePath } from '../src/dsh-process.mjs'
import { DshNotifier } from '../src/notifier.mjs'

const FAKE_OK = `
const http = require('http');
const s = http.createServer((req, res) => res.end('ok'));
s.listen(0, '127.0.0.1', () => {
  console.log('dsh web: http://127.0.0.1:' + s.address().port);
  process.on('SIGTERM', () => s.close(() => process.exit(0)));
});
`

const FAKE_CRASH = `
console.log('dsh web: http://127.0.0.1:1');
setTimeout(() => process.exit(1), 50);
`

const FAKE_NEVER = `
setInterval(() => {}, 1000);
`

test('parseUrlFromLine extracts the URL', () => {
  assert.equal(parseUrlFromLine('dsh web: http://127.0.0.1:10318'), 'http://127.0.0.1:10318')
  assert.equal(parseUrlFromLine('  something else  '), null)
  assert.equal(parseUrlFromLine(null), null)
})

test('parseBootOutput scans multi-line output', () => {
  const out = 'welcome banner\nloading...\ndsh web: http://127.0.0.1:3080\nmore lines'
  assert.equal(parseBootOutput(out), 'http://127.0.0.1:3080')
  assert.equal(parseBootOutput('nothing here'), null)
  assert.equal(parseBootOutput(''), null)
})

test('findNodePath returns an existing node binary', () => {
  const p = findNodePath()
  assert.ok(p.length > 0)
})

test('ManagedDsh boots, serves, and stops gracefully', async () => {
  const managed = new ManagedDsh({
    nodePath: findNodePath(),
    binPath: '-e',
    args: [FAKE_OK],
  })
  const { url } = await managed.start()
  const res = await fetch(url)
  assert.equal(res.status, 200)
  assert.ok(url.startsWith('http://127.0.0.1:'))

  await managed.stop()
  assert.equal(managed.running, false)
  await managed.waitForExit()
  assert.equal(managed.running, false, 'waitForExit resolves after stop')
})

test('ManagedDsh restarts after crash and recovers', async () => {
  const nodePath = findNodePath()
  const managed = new ManagedDsh({
    nodePath,
    binPath: '-e',
    args: [FAKE_CRASH],
    restartBaseMs: 100,
    maxRestarts: 3,
  })
  await assert.rejects(managed.start(), /exited before boot/)
  await managed.stop()
})

test('ManagedDsh gives up after max restarts', async () => {
  const nodePath = findNodePath()
  const managed = new ManagedDsh({
    nodePath,
    binPath: '-e',
    args: [FAKE_CRASH],
    restartBaseMs: 50,
    maxRestarts: 1,
  })
  let gaveUp = false
  managed.onGiveUp = () => { gaveUp = true }
  await assert.rejects(managed.start(), /exited before boot/)
  await new Promise((r) => setTimeout(r, 400))
  assert.equal(gaveUp, true)
})

test('ManagedDsh rejects boot on timeout', async () => {
  const managed = new ManagedDsh({
    nodePath: findNodePath(),
    binPath: '-e',
    args: [FAKE_NEVER],
    readyTimeoutMs: 800,
    restartBaseMs: 50,
  })
  await assert.rejects(managed.start(), /exited before boot|boot timeout/)
  await managed.kill()
})

test('DshNotifier notifies on approval and turn end, debounces', () => {
  const fired = []
  const n = new DshNotifier({ baseUrl: 'http://127.0.0.1:1', notify: (t, b, id) => fired.push([t, b, id]) })

  n._handleMux('session/projection', { sessionId: 's1', key: 'title', value: '我的会话', seq: 1 })
  n._handleMux('approval/requested', { sessionId: 's1', approvalId: 'a1', toolName: 'bash', reason: 'run rm -rf' })
  assert.equal(fired.length, 1)
  assert.equal(fired[0][0], '我的会话 · 权限请求')
  assert.match(fired[0][1], /bash/)

  n._handleMux('approval/requested', { sessionId: 's1', approvalId: 'a2', toolName: 'bash' })
  assert.equal(fired.length, 1, 'debounced within window')

  n._handleMux('session/event', { sessionId: 's1', event: { type: 'turn/end' } })
  assert.equal(fired.length, 2)
  assert.equal(fired[1][0], '我的会话 · 任务完成')

  n._handleMux('session/event', { sessionId: 's1', event: { type: 'user/message' } })
  assert.equal(fired.length, 2, 'non turn/end events ignored')
})

test('DshNotifier uses fallback title and per-session debounce', () => {
  const fired = []
  const n = new DshNotifier({ baseUrl: 'http://127.0.0.1:1', notify: (t) => fired.push(t) })
  n._handleMux('approval/requested', { sessionId: 's2', toolName: 'fs' })
  assert.equal(fired[0], 'dsh · 权限请求')

  n._handleMux('session/event', { sessionId: 's2', event: { type: 'turn/end' } })
  n._handleMux('session/event', { sessionId: 's3', event: { type: 'turn/end' } })
  assert.equal(fired.length, 3, 'different sessions not debounced together')
})
