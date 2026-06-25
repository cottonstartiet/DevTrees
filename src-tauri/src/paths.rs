use std::path::PathBuf;

use crate::error::{AppError, AppResult};

/// Resolve the directory the Electron build used for app data, so the Tauri build
/// reads and writes the SAME database/files as an existing Electron install and
/// users lose no data on upgrade.
///
/// Electron's `userData` path is `app.getPath('appData')` + the package name. The
/// package name was `devtrees`, and `appData` maps to the per-platform roaming
/// config dir — exactly what `dirs::config_dir()` returns:
///   - Windows: `%APPDATA%` (Roaming)            -> `%APPDATA%\devtrees`
///   - macOS:   `~/Library/Application Support`  -> `.../devtrees`
///   - Linux:   `~/.config`                      -> `~/.config/devtrees`
pub fn legacy_user_data_dir() -> AppResult<PathBuf> {
    let base =
        dirs::config_dir().ok_or_else(|| AppError::msg("could not resolve app data directory"))?;
    Ok(base.join("devtrees"))
}
