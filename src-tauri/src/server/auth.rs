use axum::extract::{Query, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Redirect, Response};
use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::app_state::{AppState, BrowserSession};

const SESSION_COOKIE: &str = "devtrees_session";
const CSRF_COOKIE: &str = "devtrees_csrf";

#[derive(serde::Deserialize)]
pub struct ExchangeQuery {
    token: String,
    #[serde(default = "default_next")]
    next: String,
}

fn default_next() -> String {
    "/".to_string()
}

pub async fn exchange(
    State(app): State<AppHandle>,
    Query(query): Query<ExchangeQuery>,
) -> Response {
    let state = app.state::<AppState>();
    let Some((session_token, csrf_token)) = state.auth.exchange(&query.token) else {
        return (StatusCode::UNAUTHORIZED, "Invalid or expired launch token.").into_response();
    };
    let next = safe_next(&query.next);
    let destination = if cfg!(debug_assertions) {
        format!("http://127.0.0.1:1420{next}")
    } else {
        next
    };
    let mut response = Redirect::to(&destination).into_response();
    response.headers_mut().append(
        header::SET_COOKIE,
        HeaderValue::from_str(&format!(
            "{SESSION_COOKIE}={session_token}; HttpOnly; SameSite=Strict; Path=/"
        ))
        .unwrap(),
    );
    response.headers_mut().append(
        header::SET_COOKIE,
        HeaderValue::from_str(&format!(
            "{CSRF_COOKIE}={csrf_token}; SameSite=Strict; Path=/"
        ))
        .unwrap(),
    );
    response
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionResponse {
    csrf_token: String,
}

pub async fn session(State(app): State<AppHandle>, headers: HeaderMap) -> Response {
    let state = app.state::<AppState>();
    match authenticated(&state, &headers) {
        Some(session) => axum::Json(SessionResponse {
            csrf_token: session.csrf_token,
        })
        .into_response(),
        None => (StatusCode::UNAUTHORIZED, "Authentication required.").into_response(),
    }
}

pub fn authenticated(state: &AppState, headers: &HeaderMap) -> Option<BrowserSession> {
    let token = cookie(headers, SESSION_COOKIE)?;
    state.auth.session(&token)
}

pub fn csrf_valid(state: &AppState, headers: &HeaderMap) -> bool {
    let Some(session) = authenticated(state, headers) else {
        return false;
    };
    let header_token = headers
        .get("x-devtrees-csrf")
        .and_then(|value| value.to_str().ok());
    let cookie_token = cookie(headers, CSRF_COOKIE);
    header_token == Some(session.csrf_token.as_str())
        && cookie_token.as_deref() == Some(session.csrf_token.as_str())
}

fn cookie(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(header::COOKIE)?
        .to_str()
        .ok()?
        .split(';')
        .filter_map(|part| part.trim().split_once('='))
        .find_map(|(key, value)| (key == name).then(|| value.to_string()))
}

fn safe_next(value: &str) -> String {
    if value.starts_with('/') && !value.starts_with("//") {
        value.to_string()
    } else {
        "/".to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redirect_path_stays_local() {
        assert_eq!(safe_next("/sessions"), "/sessions");
        assert_eq!(safe_next("//evil.example"), "/");
        assert_eq!(safe_next("https://evil.example"), "/");
    }
}
