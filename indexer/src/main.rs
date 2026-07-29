//! Helius webhook receiver for the compliance token (`work.md` §6).
//!
//! Subscribes (via `npm run setup-webhook`, see `scripts/setup-webhook.ts`) to
//! the mint and the transfer-hook program, and logs what it receives: enough
//! to show recent transfers, allowlist changes, and clawbacks in a frontend
//! later. Deliberately not a general-purpose Solana indexer — the DAS API
//! fallback and any richer decoding are cut for MVP per `work.md` §6/§1.1.
//!
//! Storage is an append-only JSONL file plus an in-memory mirror for reads.
//! No database: this is a demo-scale event log, not a production indexer.

use std::{
    fs::{File, OpenOptions},
    io::Write,
    net::SocketAddr,
    path::PathBuf,
    sync::{Arc, Mutex},
};

use axum::{
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};

mod deployment;
mod event;

use deployment::Deployment;
use event::{classify, Event};

struct AppState {
    deployment: Deployment,
    auth_token: Option<String>,
    events: Mutex<Vec<Event>>,
    log_file: Mutex<File>,
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt::init();

    let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("indexer/ has a parent directory")
        .to_path_buf();

    // Mirrors the TS scripts' `--env-file-if-exists=.env`: same repo-root
    // `.env`, same "copy .env.example and fill in" story for every part of
    // this project. Missing file is fine — real env vars still work.
    let _ = dotenvy::from_path(repo_root.join(".env"));

    let cluster = env_var("CLUSTER").unwrap_or_else(|| "devnet".to_string());
    let deployment = deployment::load(&repo_root, &cluster).unwrap_or_else(|err| {
        panic!("failed to load deployments/{cluster}.json: {err}. Run `npm run create-mint` first.")
    });

    let log_path = env_var("INDEXER_EVENT_LOG")
        .map(PathBuf::from)
        .unwrap_or_else(|| repo_root.join("indexer").join("events.jsonl"));
    let events = event::load_log(&log_path).unwrap_or_else(|err| {
        tracing::warn!("starting with an empty event log: {err}");
        Vec::new()
    });
    let log_file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .unwrap_or_else(|err| panic!("failed to open {}: {err}", log_path.display()));

    let auth_token = env_var("HELIUS_WEBHOOK_AUTH_TOKEN");
    if auth_token.is_none() {
        tracing::warn!(
            "HELIUS_WEBHOOK_AUTH_TOKEN unset — /webhook will accept unauthenticated requests. \
             Fine for local testing, not for a publicly reachable deployment."
        );
    }

    let state = Arc::new(AppState {
        deployment,
        auth_token,
        events: Mutex::new(events),
        log_file: Mutex::new(log_file),
    });

    let app = build_router(state);

    let port: u16 = env_var("INDEXER_PORT")
        .and_then(|v| v.parse().ok())
        .unwrap_or(8787);
    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    tracing::info!("listening on {addr}");
    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}

fn build_router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/healthz", get(healthz))
        .route("/webhook", post(webhook))
        .route("/events", get(list_events))
        .with_state(state)
}

fn env_var(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.trim().is_empty())
}

async fn healthz() -> &'static str {
    "ok"
}

/// Rejects deliveries whose `Authorization` header doesn't match
/// `HELIUS_WEBHOOK_AUTH_TOKEN` — the value Helius echoes back verbatim when
/// the webhook is created with a matching `authHeader`
/// (https://www.helius.dev/docs/api-reference/webhooks/create-webhook).
fn authorized(state: &AppState, headers: &HeaderMap) -> bool {
    match &state.auth_token {
        None => true,
        Some(expected) => headers
            .get("authorization")
            .and_then(|v| v.to_str().ok())
            .is_some_and(|got| got == expected),
    }
}

/// Helius enhanced webhooks POST a JSON array of transactions in one request
/// (confirmed against https://github.com/wkennedy/helius-webhooks-tutorial,
/// the sample Helius itself points to). A single object is also accepted, so
/// this endpoint is easy to hit by hand while testing.
async fn webhook(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> StatusCode {
    if !authorized(&state, &headers) {
        return StatusCode::UNAUTHORIZED;
    }

    let raw: serde_json::Value = match serde_json::from_slice(&body) {
        Ok(value) => value,
        Err(err) => {
            tracing::warn!("could not parse webhook body as JSON: {err}");
            return StatusCode::BAD_REQUEST;
        }
    };
    let transactions: Vec<serde_json::Value> = match raw {
        serde_json::Value::Array(items) => items,
        single => vec![single],
    };

    let mut events = state.events.lock().unwrap();
    let mut log_file = state.log_file.lock().unwrap();
    for transaction in &transactions {
        let event = classify(transaction, &state.deployment);
        if let Err(err) = append_to_log(&mut log_file, &event) {
            tracing::error!("failed to persist event: {err}");
            continue;
        }
        tracing::info!(kind = ?event.kind, signature = %event.signature, "recorded event");
        events.push(event);
    }

    StatusCode::OK
}

fn append_to_log(file: &mut File, event: &Event) -> std::io::Result<()> {
    let line = serde_json::to_string(event)?;
    writeln!(file, "{line}")?;
    file.flush()
}

#[derive(Deserialize)]
struct EventsQuery {
    limit: Option<usize>,
}

#[derive(Serialize, Deserialize)]
struct EventsResponse {
    events: Vec<Event>,
}

/// Most recent first, capped at `limit` (default 50).
async fn list_events(
    State(state): State<Arc<AppState>>,
    Query(query): Query<EventsQuery>,
) -> Json<EventsResponse> {
    let limit = query.limit.unwrap_or(50);
    let events = state.events.lock().unwrap();
    let selected = events.iter().rev().take(limit).cloned().collect();
    Json(EventsResponse { events: selected })
}

#[cfg(test)]
mod tests {
    use super::*;
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    fn test_state() -> Arc<AppState> {
        let dir = std::env::temp_dir().join(format!("indexer-test-{}", uuid_ish()));
        std::fs::create_dir_all(&dir).unwrap();
        let log_path = dir.join("events.jsonl");
        let log_file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)
            .unwrap();

        Arc::new(AppState {
            deployment: Deployment {
                cluster: "devnet".to_string(),
                hook_program_id: "DLfQ9dhxsXkur98Vze8L1sPHc14pVhkpdNSQqP3Qa3Bo".to_string(),
                mint: "3eV7Ejpm3R5WVftW2G4dPatnfHXdGyW8ZrrTzURHnicT".to_string(),
                allowlist: "ChNLQyCB6C23jfcRN1xhWj9dgtg4k138gRs4WN5HPJRX".to_string(),
                extra_account_meta_list: "BgNWreTXr4YvvBBLnz7PS4XRH9y2T25186KYZCkKAChn".to_string(),
                issuer: "2oE9AWmKKzJ2xMdJe4ay3wxebRxvYH27aymb3ZBMLFj2".to_string(),
                decimals: 6,
                created_at: "2026-07-29T06:57:57.995Z".to_string(),
            },
            auth_token: Some("test-secret".to_string()),
            events: Mutex::new(Vec::new()),
            log_file: Mutex::new(log_file),
        })
    }

    fn uuid_ish() -> u64 {
        use std::time::{SystemTime, UNIX_EPOCH};
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos() as u64
    }

    fn hook_execute_transfer(signature: &str, fee_payer: &str) -> serde_json::Value {
        serde_json::json!({
            "signature": signature,
            "slot": 123,
            "timestamp": 1_700_000_000,
            "feePayer": fee_payer,
            "type": "UNKNOWN",
            "description": "",
            "tokenTransfers": [{
                "fromUserAccount": "Alice111111111111111111111111111111111111",
                "toUserAccount": "Bob1111111111111111111111111111111111111",
                "mint": "3eV7Ejpm3R5WVftW2G4dPatnfHXdGyW8ZrrTzURHnicT",
                "tokenAmount": 4.0,
            }],
            "instructions": [{
                "programId": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
                "accounts": [],
                "data": "",
                "innerInstructions": [{
                    "programId": "DLfQ9dhxsXkur98Vze8L1sPHc14pVhkpdNSQqP3Qa3Bo",
                    "accounts": [],
                    "data": "",
                }],
            }],
        })
    }

    #[tokio::test]
    async fn rejects_missing_auth() {
        let state = test_state();
        let app = build_router(state);

        let response = app
            .oneshot(
                axum::http::Request::builder()
                    .method("POST")
                    .uri("/webhook")
                    .header("content-type", "application/json")
                    .body(axum::body::Body::from("[]"))
                    .unwrap(),
            )
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn records_a_hook_transfer_and_lists_it() {
        let state = test_state();
        let app = build_router(state);

        let payload = serde_json::json!([hook_execute_transfer(
            "sig-1",
            "IssuerXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
        )]);

        let response = app
            .clone()
            .oneshot(
                axum::http::Request::builder()
                    .method("POST")
                    .uri("/webhook")
                    .header("content-type", "application/json")
                    .header("authorization", "test-secret")
                    .body(axum::body::Body::from(payload.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let response = app
            .oneshot(
                axum::http::Request::builder()
                    .method("GET")
                    .uri("/events")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let body = response.into_body().collect().await.unwrap().to_bytes();
        let parsed: EventsResponse = serde_json::from_slice(&body).unwrap();
        assert_eq!(parsed.events.len(), 1);
        assert_eq!(parsed.events[0].signature, "sig-1");
        assert_eq!(parsed.events[0].kind, event::EventKind::Transfer);
    }
}
