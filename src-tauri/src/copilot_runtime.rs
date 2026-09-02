use github_copilot_sdk::{Client, ClientOptions};
use tokio::sync::Mutex;

use crate::error::{AppError, AppResult};

#[derive(Default)]
pub struct CopilotRuntime {
    client: Mutex<Option<Client>>,
}

impl CopilotRuntime {
    pub async fn client(&self) -> AppResult<Client> {
        let mut client = self.client.lock().await;
        if let Some(existing) = client.as_ref() {
            return Ok(existing.clone());
        }

        let started = Client::start(ClientOptions::default())
            .await
            .map_err(|error| AppError::msg(format!("Copilot SDK error: {error}")))?;
        *client = Some(started.clone());
        Ok(started)
    }

    pub async fn shutdown(&self) {
        if let Some(client) = self.client.lock().await.take() {
            let _ = client.stop().await;
        }
    }
}
