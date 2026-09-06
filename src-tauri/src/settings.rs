use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::paths::legacy_user_data_dir;

const SETTINGS_FILE: &str = "host-settings.json";
const AUTOSTART_VALUE: &str = "DevTrees";

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostSettings {
    #[serde(default)]
    pub launch_at_sign_in: bool,
}

pub struct SettingsStore {
    path: PathBuf,
    value: Mutex<HostSettings>,
}

impl SettingsStore {
    pub fn load() -> AppResult<Self> {
        let path = legacy_user_data_dir()?.join(SETTINGS_FILE);
        let value = fs::read_to_string(&path)
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default();
        Ok(Self {
            path,
            value: Mutex::new(value),
        })
    }

    pub fn get(&self) -> HostSettings {
        self.value
            .lock()
            .map(|value| value.clone())
            .unwrap_or_default()
    }

    pub fn update_launch_at_sign_in(&self, enabled: bool) -> AppResult<HostSettings> {
        set_autostart(enabled)?;
        let mut value = self
            .value
            .lock()
            .map_err(|_| AppError::msg("settings mutex poisoned"))?;
        value.launch_at_sign_in = enabled;
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(&self.path, serde_json::to_vec_pretty(&*value)?)?;
        Ok(value.clone())
    }
}

#[cfg(windows)]
fn set_autostart(enabled: bool) -> AppResult<()> {
    use winreg::enums::{HKEY_CURRENT_USER, KEY_READ, KEY_WRITE};
    use winreg::RegKey;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let (key, _) = hkcu.create_subkey_with_flags(
        r"Software\Microsoft\Windows\CurrentVersion\Run",
        KEY_READ | KEY_WRITE,
    )?;
    if enabled {
        let exe = std::env::current_exe()?;
        key.set_value(
            AUTOSTART_VALUE,
            &format!("\"{}\" --autostart", exe.display()),
        )?;
    } else {
        let _ = key.delete_value(AUTOSTART_VALUE);
    }
    Ok(())
}

#[cfg(not(windows))]
fn set_autostart(_enabled: bool) -> AppResult<()> {
    Err(AppError::msg(
        "Launch at sign-in is currently available only on Windows.",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn launch_at_sign_in_defaults_off() {
        assert!(!HostSettings::default().launch_at_sign_in);
    }
}
