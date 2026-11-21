import { app, BrowserWindow, Menu, Tray, nativeImage, net, protocol, shell } from 'electron'
import { pathToFileURL } from 'node:url'
import { videoFile } from './video'
import { ensureContentTables } from './content'
import { join } from 'node:path'
import { openDb, getSettings, log } from './db'
import { registerIpc, changed, setLanguageListener } from './ipc'
import { tr } from './i18n'
import { flushSecrets, loadSecrets } from './secrets'
import { startScheduler, stopScheduler, syncMetrics } from './scheduler'
import { ensureTable as ensureGcalTable } from './gcal'

let win: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false

const resource = (name: string): string =>
  app.isPackaged ? join(process.resourcesPath, 'resources', name) : join(app.getAppPath(), 'resources', name)

function createWindow(show: boolean): void {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1080,
    minHeight: 680,
    show: false,
    backgroundColor: '#000000',
    title: 'AllinMKT',
    icon: resource('icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  win.once('ready-to-show', () => show && win?.show())
  win.on('close', (e) => {
    if (!quitting && getSettings().closeToTray) {
      e.preventDefault()
      win?.hide()
    }
  })
  // Los enlaces externos se abren en el navegador del sistema.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
}

function showWindow(): void {
  if (!win) createWindow(true)
  else {
    win.show()
    win.focus()
  }
}

function createTray(): void {
  const icon = nativeImage.createFromPath(resource('tray.png'))
  tray = new Tray(icon)
  tray.setToolTip('AllinMKT')
  setTrayMenu()
  tray.on('click', showWindow)
}

function setTrayMenu(): void {
  tray?.setContextMenu(
    Menu.buildFromTemplate([
      { label: tr('Abrir AllinMKT'), click: showWindow },
      { label: tr('Sincronizar métricas'), click: () => void syncMetrics() },
      { type: 'separator' },
      {
        label: tr('Salir'),
        click: () => {
          quitting = true
          app.quit()
        }
      }
    ])
  )
}

// allin-media://video/<archivo> sirve los vídeos generados a la interfaz (con saltos en la
// reproducción), sin abrir el acceso a file:// ni a ninguna otra carpeta.
protocol.registerSchemesAsPrivileged([{ scheme: 'allin-media', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } }])

function registerMediaProtocol(): void {
  protocol.handle('allin-media', (req) => {
    const file = videoFile(decodeURIComponent(new URL(req.url).pathname))
    if (!file) return new Response('No encontrado', { status: 404 })
    return net.fetch(pathToFileURL(file).toString(), { headers: req.headers, bypassCustomProtocolHandlers: true })
  })
}

/**
 * En desarrollo la app no debe sobrevivir a `npm run dev`. Si se cierra la terminal o se mata
 * electron-vite, Electron se quedaba huérfano en la bandeja con el código viejo y, como tiene el
 * bloqueo de instancia única, cada `npm run dev` nuevo solo traía al frente esa copia antigua.
 */
function bindToDevSession(): void {
  const quit = (): void => {
    quitting = true
    app.quit()
  }
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(sig, quit)
  // process.ppid se lee en cada acceso: si cambia, el proceso que nos lanzó ha muerto.
  const parent = process.ppid
  setInterval(() => {
    if (process.ppid !== parent) quit()
  }, 2000).unref()
}

if (!app.isPackaged) bindToDevSession()

if (!app.requestSingleInstanceLock()) {
  if (!app.isPackaged) {
    console.warn('[AllinMKT] Ya hay otra copia abierta: se ha traído su ventana al frente y esta se cierra. Si es una copia antigua, ciérrala (bandeja › Salir o `pkill -f AllinMKT/node_modules/electron`) y vuelve a lanzar `npm run dev`.')
  }
  app.quit()
} else {
  app.on('second-instance', showWindow)
  app.whenReady().then(async () => {
    app.setAppUserModelId('com.allinmkt.app')
    openDb()
    // Antes que nada que lea credenciales (IPC, programador, conectores).
    await loadSecrets()
    ensureGcalTable()
    ensureContentTables()
    registerIpc()
    setLanguageListener(setTrayMenu)
    registerMediaProtocol()
    createWindow(!process.argv.includes('--hidden'))
    try {
      createTray()
    } catch (e) {
      log('warn', 'app', `Sin icono en la bandeja: ${e instanceof Error ? e.message : e}`)
    }
    startScheduler(changed)
  })
  let flushed = false
  app.on('before-quit', (e) => {
    quitting = true
    stopScheduler()
    // Los secretos se cifran y guardan en segundo plano: esperamos a que terminen.
    if (!flushed) {
      e.preventDefault()
      void flushSecrets().finally(() => {
        flushed = true
        app.quit()
      })
    }
  })
  // Con la bandeja activa la app sigue viva aunque se cierren las ventanas.
  app.on('window-all-closed', () => {
    if (!getSettings().closeToTray) app.quit()
  })
  app.on('activate', showWindow)
}
