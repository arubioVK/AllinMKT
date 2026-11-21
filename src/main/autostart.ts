import { app } from 'electron'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

// Arranque con el sistema, minimizado en la bandeja, para que las publicaciones salgan a su hora.
// Windows usa el registro (setLoginItemSettings); en Linux escribimos un .desktop en ~/.config/autostart.

export function applyAutostart(enabled: boolean): void {
  if (process.platform === 'linux') {
    const dir = join(homedir(), '.config', 'autostart')
    const file = join(dir, 'allinmkt.desktop')
    if (!enabled) {
      if (existsSync(file)) rmSync(file)
      return
    }
    const exec = process.env.APPIMAGE || process.execPath
    const args = app.isPackaged ? '--hidden' : `"${app.getAppPath()}" --hidden`
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      file,
      `[Desktop Entry]\nType=Application\nName=AllinMKT\nExec="${exec}" ${args}\nX-GNOME-Autostart-enabled=true\nTerminal=false\n`
    )
    return
  }
  app.setLoginItemSettings({ openAtLogin: enabled, args: ['--hidden'] })
}
