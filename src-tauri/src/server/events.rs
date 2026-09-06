use std::sync::atomic::Ordering;
use std::time::Duration;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use futures_util::{SinkExt, StreamExt};
use tauri::{AppHandle, Manager};

use crate::app_state::{AppState, HostEvent};

use super::{allowed_origin, auth};

pub async fn websocket(
    State(app): State<AppHandle>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    let state = app.state::<AppState>();
    if auth::authenticated(&state, &headers).is_none() {
        return (StatusCode::UNAUTHORIZED, "Authentication required.").into_response();
    }
    let origin_valid = headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        .map(|origin| allowed_origin(&state, origin))
        .unwrap_or(false);
    if !origin_valid {
        return (StatusCode::FORBIDDEN, "Invalid WebSocket origin.").into_response();
    }
    ws.on_upgrade(move |socket| connected(app, socket))
}

async fn connected(app: AppHandle, socket: WebSocket) {
    let state = app.state::<AppState>();
    state.browser_clients.fetch_add(1, Ordering::Relaxed);
    let mut receiver = state.events.subscribe();
    let (mut sender, mut incoming) = socket.split();
    let hello = HostEvent {
        event: "host:hello".to_string(),
        data: serde_json::json!({ "version": state.app.package_info().version.to_string() }),
    };
    if let Ok(text) = serde_json::to_string(&hello) {
        let _ = sender.send(Message::Text(text.into())).await;
    }

    let send_task = async {
        loop {
            match tokio::time::timeout(Duration::from_secs(25), receiver.recv()).await {
                Ok(Ok(event)) => {
                    let Ok(text) = serde_json::to_string(&event) else {
                        continue;
                    };
                    if sender.send(Message::Text(text.into())).await.is_err() {
                        break;
                    }
                }
                Ok(Err(tokio::sync::broadcast::error::RecvError::Lagged(_))) => {
                    let resync = HostEvent {
                        event: "host:resync-required".to_string(),
                        data: serde_json::json!({}),
                    };
                    if let Ok(text) = serde_json::to_string(&resync) {
                        if sender.send(Message::Text(text.into())).await.is_err() {
                            break;
                        }
                    }
                }
                Ok(Err(_)) => break,
                Err(_) => {
                    if sender.send(Message::Ping(Vec::new().into())).await.is_err() {
                        break;
                    }
                }
            }
        }
    };

    let receive_task = async {
        while let Some(Ok(message)) = incoming.next().await {
            if matches!(message, Message::Close(_)) {
                break;
            }
        }
    };

    tokio::select! {
        _ = send_task => {}
        _ = receive_task => {}
    }
    state.browser_clients.fetch_sub(1, Ordering::Relaxed);
}
