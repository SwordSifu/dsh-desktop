import { app, BrowserWindow, Tray, Menu, Notification, nativeImage } from 'electron'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { ManagedDsh, findNodePath } from './dsh-process.mjs'
import { DshNotifier } from './notifier.mjs'
import { Settings } from './settings.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DSH_BIN = fileURLToPath(import.meta.resolve('@deepseek-ai/dsh/lib/bin.js'))
const APP_ID = 'com.dsh.desktop'

let quitting = false
let mainWindow = null
let tray = null
let dshProcess = null
let notifier = null
let settings = null
let bootLoop = null

function log(...args) {
  console.log('[dsh-desktop]', ...args)
}

let bootedUrl = null

function dataUrl(html) {
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html)
}

const LOADING_HTML = dataUrl(`<!doctype html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;background:#0b1220;color:#93a3bd;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh">
<div style="text-align:center">
  <div style="font-size:18px;color:#dbe4f0">正在启动 DeepSeek Harness…</div>
  <div style="margin-top:10px;font-size:13px">首次启动可能需要一点时间</div>
</div>
</body></html>`)

function errorHtml(msg) {
  return dataUrl(`<!doctype html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;background:#0b1220;color:#93a3bd;font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh">
<div style="text-align:center;max-width:480px;padding:24px">
  <div style="font-size:18px;color:#f0a8a8">启动失败</div>
  <div style="margin-top:12px;font-size:13px;line-height:1.6">${msg}</div>
  <div style="margin-top:12px;font-size:13px">应用会在后台自动重试；你也可以从托盘菜单退出后重新打开。</div>
</div>
</body></html>`)
}

function createWindow() {
  const { width, height } = settings.get('window')
  mainWindow = new BrowserWindow({
    width,
    height,
    minWidth: 940,
    minHeight: 600,
    show: false,
    icon: join(__dirname, '..', 'icons', 'icon.png'),
    backgroundColor: '#0b1220',
    title: 'DeepSeek Harness',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  mainWindow.on('ready-to-show', () => mainWindow.show())
  mainWindow.on('resize', () => {
    if (!mainWindow.isMaximized() && !mainWindow.isMinimized()) {
      settings.set('window', mainWindow.getBounds())
    }
  })
  mainWindow.on('close', (e) => {
    if (settings.get('minimizeToTray') && !quitting) {
      e.preventDefault()
      mainWindow.hide()
    } else {
      app.quit()
    }
  })
  mainWindow.on('closed', () => {
    mainWindow = null
  })
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', (e, target) => {
    const allowed = target.startsWith('data:') || (bootedUrl != null && target.startsWith(bootedUrl))
    if (!allowed) e.preventDefault()
  })

  void mainWindow.loadURL(LOADING_HTML)
}

function showBootError(msg) {
  if (!mainWindow) createWindow()
  void mainWindow.loadURL(errorHtml(msg))
}

function setupTray() {
  tray = new Tray(nativeImage.createFromPath(join(__dirname, '..', 'icons', 'tray.png')))
  tray.setToolTip('DeepSeek Harness')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示 / 隐藏', click: toggleWindow },
    { type: 'separator' },
    {
      label: '开机自启',
      type: 'checkbox',
      checked: settings.get('autostart'),
      click: (item) => {
        settings.set('autostart', item.checked)
        app.setLoginItemSettings({ openAtLogin: item.checked, openAsHidden: true })
      },
    },
    {
      label: '最小化到托盘',
      type: 'checkbox',
      checked: settings.get('minimizeToTray'),
      click: (item) => settings.set('minimizeToTray', item.checked),
    },
    { type: 'separator' },
    { label: '退出', click: () => { quitting = true; void shutdown() } },
  ]))
  tray.on('click', toggleWindow)
}

function toggleWindow() {
  if (!mainWindow) return
  if (mainWindow.isVisible() && !mainWindow.isMinimized()) {
    mainWindow.hide()
  } else {
    mainWindow.show()
    mainWindow.focus()
  }
}

function notify(title, body, sessionId) {
  if (!Notification.isSupported()) return
  const n = new Notification({ title, body })
  n.on('click', () => {
    if (mainWindow) {
      mainWindow.show()
      mainWindow.focus()
    }
  })
  n.show()
}

async function bootDshLoop() {
  while (!quitting) {
    try {
      const { url } = await dshProcess.start()
      log('dsh ready at', url)
      bootedUrl = url
      if (!mainWindow) createWindow()
      void mainWindow.loadURL(url)
      if (notifier) notifier.stop()
      notifier = new DshNotifier({ baseUrl: url, notify, log })
      notifier.start()
      // Wait for this child to exit (or for quit) before looping back; a
      // successful boot must not immediately spawn a second dsh process.
      await dshProcess.waitForExit()
    } catch (err) {
      log('boot failed:', err.message)
      showBootError('dsh 进程未能启动。')
      await new Promise((r) => setTimeout(r, 500))
    }
  }
}

async function shutdown() {
  quitting = true
  if (notifier) { notifier.stop(); notifier = null }
  if (dshProcess) {
    await dshProcess.stop()
    dshProcess.kill()
  }
  app.quit()
}

app.setAppUserModelId(APP_ID)

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      mainWindow.show()
      mainWindow.focus()
    }
  })

  app.on('before-quit', () => {
    quitting = true
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      // keep running in tray
    }
  })

  app.whenReady().then(() => {
    settings = new Settings(app.getPath('userData'))
    log('userData:', app.getPath('userData'))

    const nodePath = findNodePath()
    dshProcess = new ManagedDsh({
      nodePath,
      binPath: DSH_BIN,
      args: ['web', '--port', '0'],
      cwd: app.getPath('userData'),
      log,
    })
    dshProcess.onGiveUp = (code, signal) => {
      log(`dsh gave up after restarts (code=${code} signal=${signal})`)
      showBootError(`dsh 进程反复启动失败（code=${code}${signal ? ` signal=${signal}` : ''}）。`)
    }

    setupTray()
    createWindow()
    bootLoop = bootDshLoop()
  })
}
