mod auth;
mod events;
mod routes;
mod static_files;

use std::net::{IpAddr, Ipv4Addr, SocketAddr};

use axum::extract::DefaultBodyLimit;
use axum::http::{header, HeaderValue, Request};
use axum::middleware::{self, Next};
use axum::response::Response;
use axum::routing::{get, post};
use axum::Router;
use tauri::{AppHandle, Manager};

use crate::app_state::AppState;
use crate::error::{AppError, AppResult};

const DEV_PORT: u16 = 1430;

pub async fn start(app: AppHandle) -> AppResult<SocketAddr> {
    let address = SocketAddr::new(
        IpAddr::V4(Ipv4Addr::LOCALHOST),
        if cfg!(debug_assertions) { DEV_PORT } else { 0 },
    );
    let listener = tokio::net::TcpListener::bind(address)
        .await
        .map_err(|error| AppError::msg(format!("failed to bind loopback server: {error}")))?;
    let address = listener.local_addr()?;
    let (shutdown_tx, mut shutdown_rx) = tokio::sync::watch::channel(false);
    app.state::<AppState>()
        .set_server(address, shutdown_tx.clone());

    let state = app.clone();
    let router = Router::new()
        .route("/health", get(routes::health))
        .route("/ready", get(routes::health))
        .route("/auth", get(auth::exchange))
        .route("/api/session", get(auth::session))
        .route("/api/{domain}/{operation}", post(routes::dispatch))
        .route("/events", get(events::websocket))
        .fallback(static_files::serve)
        .layer(DefaultBodyLimit::max(2 * 1024 * 1024))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            security_headers,
        ))
        .with_state(state);

    tauri::async_runtime::spawn(async move {
        let result = axum::serve(listener, router)
            .with_graceful_shutdown(async move {
                while !*shutdown_rx.borrow() {
                    if shutdown_rx.changed().await.is_err() {
                        break;
                    }
                }
            })
            .await;
        if let Err(error) = result {
            eprintln!("[server] loopback server stopped: {error}");
        }
    });

    Ok(address)
}

async fn security_headers(
    axum::extract::State(app): axum::extract::State<AppHandle>,
    request: Request<axum::body::Body>,
    next: Next,
) -> Response {
    let state = app.state::<AppState>();
    let host_valid = request
        .headers()
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
        .map(|host| allowed_host(&state, host))
        .unwrap_or(false);
    if !host_valid {
        return (
            axum::http::StatusCode::BAD_REQUEST,
            "Invalid loopback host.",
        )
            .into_response();
    }

    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(
            "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; \
             form-action 'self'; img-src 'self' data:; font-src 'self' data:; \
             style-src 'self' 'unsafe-inline'; script-src 'self'; \
             connect-src 'self' ws://127.0.0.1:1420 ws://127.0.0.1:1430",
        ),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    headers
        .entry(header::CACHE_CONTROL)
        .or_insert(HeaderValue::from_static("no-store"));
    response
}

pub fn allowed_host(state: &AppState, host: &str) -> bool {
    let Some(address) = state.address() else {
        return false;
    };
    let port = address.port();
    host.eq_ignore_ascii_case(&format!("127.0.0.1:{port}"))
        || host.eq_ignore_ascii_case(&format!("localhost:{port}"))
        || (cfg!(debug_assertions)
            && (host.eq_ignore_ascii_case("localhost:1420")
                || host.eq_ignore_ascii_case("127.0.0.1:1420")))
}

pub fn allowed_origin(state: &AppState, origin: &str) -> bool {
    let Some(address) = state.address() else {
        return false;
    };
    let port = address.port();
    origin.eq_ignore_ascii_case(&format!("http://127.0.0.1:{port}"))
        || origin.eq_ignore_ascii_case(&format!("http://localhost:{port}"))
        || (cfg!(debug_assertions)
            && (origin.eq_ignore_ascii_case("http://localhost:1420")
                || origin.eq_ignore_ascii_case("http://127.0.0.1:1420")))
}

use axum::response::IntoResponse;
