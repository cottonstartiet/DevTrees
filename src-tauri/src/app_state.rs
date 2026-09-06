use std::collections::{HashMap, HashSet};
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Mutex;

use serde::Serialize;
use tauri::AppHandle;
use tokio::sync::{broadcast, watch};

use crate::db::DbState;
use crate::settings::SettingsStore;
use crate::terminal_sessions::TerminalSessionMonitor;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostEvent {
    pub event: String,
    pub data: serde_json::Value,
}

#[derive(Clone)]
pub struct BrowserSession {
    pub csrf_token: String,
}

#[derive(Default)]
pub struct AuthState {
    launch_tokens: Mutex<HashSet<String>>,
    sessions: Mutex<HashMap<String, BrowserSession>>,
}

impl AuthState {
    pub fn issue_launch_token(&self) -> String {
        let token =
            uuid::Uuid::new_v4().simple().to_string() + &uuid::Uuid::new_v4().simple().to_string();
        if let Ok(mut tokens) = self.launch_tokens.lock() {
            tokens.insert(token.clone());
        }
        token
    }

    pub fn exchange(&self, token: &str) -> Option<(String, String)> {
        let accepted = self
            .launch_tokens
            .lock()
            .ok()
            .map(|mut tokens| tokens.remove(token))
            .unwrap_or(false);
        if !accepted {
            return None;
        }
        let session_token =
            uuid::Uuid::new_v4().simple().to_string() + &uuid::Uuid::new_v4().simple().to_string();
        let csrf_token = uuid::Uuid::new_v4().simple().to_string();
        self.sessions.lock().ok()?.insert(
            session_token.clone(),
            BrowserSession {
                csrf_token: csrf_token.clone(),
            },
        );
        Some((session_token, csrf_token))
    }

    pub fn session(&self, token: &str) -> Option<BrowserSession> {
        self.sessions.lock().ok()?.get(token).cloned()
    }
}

pub struct ServerRuntime {
    pub address: Option<SocketAddr>,
    pub shutdown: Option<watch::Sender<bool>>,
}

pub struct AppState {
    pub app: AppHandle,
    pub db: DbState,
    pub terminal_sessions: TerminalSessionMonitor,
    pub auth: AuthState,
    pub events: broadcast::Sender<HostEvent>,
    pub browser_clients: AtomicUsize,
    pub shutting_down: AtomicBool,
    pub settings: SettingsStore,
    server: Mutex<ServerRuntime>,
}

impl AppState {
    pub fn new(
        app: AppHandle,
        db: DbState,
        terminal_sessions: TerminalSessionMonitor,
        settings: SettingsStore,
    ) -> Self {
        let (events, _) = broadcast::channel(512);
        Self {
            app,
            db,
            terminal_sessions,
            auth: AuthState::default(),
            events,
            browser_clients: AtomicUsize::new(0),
            shutting_down: AtomicBool::new(false),
            settings,
            server: Mutex::new(ServerRuntime {
                address: None,
                shutdown: None,
            }),
        }
    }

    pub fn set_server(&self, address: SocketAddr, shutdown: watch::Sender<bool>) {
        if let Ok(mut server) = self.server.lock() {
            server.address = Some(address);
            server.shutdown = Some(shutdown);
        }
    }

    pub fn address(&self) -> Option<SocketAddr> {
        self.server.lock().ok()?.address
    }

    pub fn base_url(&self) -> Option<String> {
        let address = self.address()?;
        Some(format!("http://127.0.0.1:{}", address.port()))
    }

    pub fn browser_url(&self, path: &str) -> Option<String> {
        let base = self.base_url()?;
        let token = self.auth.issue_launch_token();
        let next = if path.starts_with('/') { path } else { "/" };
        Some(format!(
            "{base}/auth?token={token}&next={}",
            encode_query(next)
        ))
    }

    pub fn open_browser(&self, path: &str) -> Result<(), String> {
        use tauri_plugin_opener::OpenerExt;
        let url = self
            .browser_url(path)
            .ok_or_else(|| "The local DevTrees server is not ready.".to_string())?;
        self.app
            .opener()
            .open_url(url, None::<&str>)
            .map_err(|error| error.to_string())
    }

    pub fn broadcast<T: Serialize>(&self, event: &str, payload: &T) {
        if let Ok(data) = serde_json::to_value(payload) {
            let _ = self.events.send(HostEvent {
                event: event.to_string(),
                data,
            });
        }
    }

    pub fn has_browser_clients(&self) -> bool {
        self.browser_clients.load(Ordering::Relaxed) > 0
    }

    pub fn stop_server(&self) {
        self.shutting_down.store(true, Ordering::Relaxed);
        if let Ok(server) = self.server.lock() {
            if let Some(shutdown) = &server.shutdown {
                let _ = shutdown.send(true);
            }
        }
    }
}

fn encode_query(value: &str) -> String {
    value
        .bytes()
        .map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (byte as char).to_string()
            }
            _ => format!("%{byte:02X}"),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn launch_tokens_are_single_use() {
        let auth = AuthState::default();
        let token = auth.issue_launch_token();
        let (session, csrf) = auth.exchange(&token).expect("first exchange should work");
        assert!(auth.exchange(&token).is_none());
        assert_eq!(auth.session(&session).unwrap().csrf_token, csrf);
    }
}
