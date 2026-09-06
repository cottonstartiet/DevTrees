use axum::extract::State;
use axum::http::{header, HeaderMap, HeaderValue, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use tauri::{AppHandle, Manager};

use crate::app_state::AppState;

use super::auth;

include!(concat!(env!("OUT_DIR"), "/embedded_web_assets.rs"));

pub async fn serve(State(app): State<AppHandle>, headers: HeaderMap, uri: Uri) -> Response {
    let state = app.state::<AppState>();
    if auth::authenticated(&state, &headers).is_none() {
        return (
            StatusCode::UNAUTHORIZED,
            "Open DevTrees from the tray to authenticate this browser.",
        )
            .into_response();
    }

    let requested = uri.path().trim_start_matches('/');
    let path = if requested.is_empty() {
        "index.html"
    } else {
        requested
    };
    let (resolved, bytes) = find(path)
        .map(|bytes| (path, bytes))
        .or_else(|| find("index.html").map(|bytes| ("index.html", bytes)))
        .unwrap();
    let mime = mime_guess::from_path(resolved).first_or_octet_stream();
    let mut response = bytes.to_vec().into_response();
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(mime.as_ref()).unwrap(),
    );
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        if resolved == "index.html" {
            HeaderValue::from_static("no-store")
        } else if resolved.contains("/assets/") || resolved.starts_with("assets/") {
            HeaderValue::from_static("public, max-age=31536000, immutable")
        } else {
            HeaderValue::from_static("no-cache")
        },
    );
    response
}

fn find(path: &str) -> Option<&'static [u8]> {
    EMBEDDED_WEB_ASSETS
        .iter()
        .find_map(|(name, bytes)| (*name == path).then_some(*bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_shell_is_available() {
        assert!(find("index.html").is_some());
    }
}
