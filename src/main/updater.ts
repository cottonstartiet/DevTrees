import { autoUpdater } from 'electron-updater'
import { is } from '@electron-toolkit/utils'
import log from 'electron-log/main'

/**
 * Wire up auto-updates against the GitHub Releases published by the
 * "DevTrees Build" workflow. The packaged app reads the bundled app-update.yml
 * (generated from electron-builder.yml's `publish` block) to know which repo to
 * poll, then downloads the newest release's installer in the background and
 * installs it the next time the app quits.
 *
 * Auto-update only functions in a packaged build — electron-updater throws when
 * run from an unpacked dev tree — so we no-op in development.
 */
export function initAutoUpdater(): void {
  if (is.dev) {
    return
  }

  // Persist updater logs to disk (electron-log writes to the app's user-data
  // log directory) so update failures are diagnosable in the field, where the
  // console is not visible.
  log.transports.file.level = 'info'
  autoUpdater.logger = log

  // Download in the background as soon as an update is found, and apply it on
  // the next quit so the user is never interrupted mid-session.
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => {
    log.info('[updater] checking for update')
  })
  autoUpdater.on('update-available', (info) => {
    log.info(`[updater] update available: ${info.version}`)
  })
  autoUpdater.on('update-not-available', () => {
    log.info('[updater] no update available; running the latest version')
  })
  autoUpdater.on('download-progress', (progress) => {
    log.info(`[updater] downloading update: ${Math.round(progress.percent)}%`)
  })
  autoUpdater.on('update-downloaded', (info) => {
    log.info(`[updater] update ${info.version} downloaded; will install on quit`)
  })
  autoUpdater.on('error', (err) => {
    // Network failures, a private repo without a token, or no releases yet must
    // never crash the app — just log and continue.
    log.error('[updater] error:', err == null ? 'unknown' : (err.stack ?? err).toString())
  })

  // `checkForUpdatesAndNotify` checks, downloads, and surfaces a native
  // notification when an update is ready. It rejects on failure, so swallow it.
  autoUpdater.checkForUpdatesAndNotify().catch((err) => {
    log.error('[updater] checkForUpdatesAndNotify failed:', err)
  })
}
