//! Turns a raw Helius enhanced-transaction JSON object into our own event
//! log entry.
//!
//! Deliberately shallow: no instruction-data decoding, just program-ID
//! presence and Helius's own `tokenTransfers` summary. That's enough to tell
//! "the hook ran and value moved" (a transfer) from "the hook ran and nothing
//! moved" (an allowlist change) — matching `work.md` §6's "simple event log"
//! scope, not a general Token-2022 instruction decoder.

use std::{fs::File, io::BufRead, path::Path};

use serde::{Deserialize, Serialize};

use crate::deployment::Deployment;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EventKind {
    /// The hook program ran and a matching-mint token amount moved.
    Transfer,
    /// The hook program ran but no token amount moved — `AddAddress` /
    /// `RemoveAddress` on the allowlist.
    AllowlistChange,
    /// A matching-mint token amount moved without the hook program showing
    /// up in the top-level or inner instructions Helius reported.
    UnhookedTransfer,
    /// Doesn't touch the mint or the hook program; logged for visibility.
    Other,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenMovement {
    pub from: String,
    pub to: String,
    pub amount: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Event {
    pub signature: String,
    pub slot: u64,
    pub timestamp: i64,
    pub fee_payer: String,
    pub kind: EventKind,
    /// `kind == Transfer` where the fee payer is the configured issuer and
    /// isn't the token source — the pattern this repo's own
    /// `demo-clawback.ts` produces (issuer pays and signs as permanent
    /// delegate) versus `demo-transfer.ts` (holder pays and signs). It is a
    /// heuristic, not a decode of who actually signed as authority: a relayer
    /// paying gas for a holder's transfer would also read `false` here
    /// (correctly), but a holder who happens to reimburse the issuer's gas
    /// for something else would not be distinguishable from this field alone.
    pub likely_clawback: bool,
    pub token_movements: Vec<TokenMovement>,
    /// Helius's own classification, kept for debugging — not used for
    /// `kind`, since it doesn't know about this project's custom hook
    /// program.
    pub helius_type: String,
    pub description: String,
}

fn program_ids(transaction: &serde_json::Value) -> Vec<String> {
    let mut ids = Vec::new();
    let Some(instructions) = transaction.get("instructions").and_then(|v| v.as_array()) else {
        return ids;
    };
    for instruction in instructions {
        if let Some(id) = instruction.get("programId").and_then(|v| v.as_str()) {
            ids.push(id.to_string());
        }
        if let Some(inner) = instruction
            .get("innerInstructions")
            .and_then(|v| v.as_array())
        {
            for inner_instruction in inner {
                if let Some(id) = inner_instruction.get("programId").and_then(|v| v.as_str()) {
                    ids.push(id.to_string());
                }
            }
        }
    }
    ids
}

fn token_movements(transaction: &serde_json::Value, mint: &str) -> Vec<TokenMovement> {
    let Some(transfers) = transaction.get("tokenTransfers").and_then(|v| v.as_array()) else {
        return Vec::new();
    };
    transfers
        .iter()
        .filter(|t| t.get("mint").and_then(|v| v.as_str()) == Some(mint))
        .filter_map(|t| {
            Some(TokenMovement {
                from: t.get("fromUserAccount")?.as_str()?.to_string(),
                to: t.get("toUserAccount")?.as_str()?.to_string(),
                amount: t.get("tokenAmount").and_then(|v| v.as_f64()).unwrap_or(0.0),
            })
        })
        .collect()
}

fn string_field(transaction: &serde_json::Value, key: &str) -> String {
    transaction
        .get(key)
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string()
}

pub fn classify(transaction: &serde_json::Value, deployment: &Deployment) -> Event {
    let ids = program_ids(transaction);
    let hook_ran = ids.iter().any(|id| id == &deployment.hook_program_id);
    let movements = token_movements(transaction, &deployment.mint);
    let moved_value = !movements.is_empty();

    let kind = match (hook_ran, moved_value) {
        (true, true) => EventKind::Transfer,
        (true, false) => EventKind::AllowlistChange,
        (false, true) => EventKind::UnhookedTransfer,
        (false, false) => EventKind::Other,
    };

    let fee_payer = string_field(transaction, "feePayer");
    let likely_clawback = kind == EventKind::Transfer
        && fee_payer == deployment.issuer
        && movements.iter().any(|m| m.from != deployment.issuer);

    Event {
        signature: string_field(transaction, "signature"),
        slot: transaction
            .get("slot")
            .and_then(|v| v.as_u64())
            .unwrap_or(0),
        timestamp: transaction
            .get("timestamp")
            .and_then(|v| v.as_i64())
            .unwrap_or(0),
        fee_payer,
        kind,
        likely_clawback,
        token_movements: movements,
        helius_type: string_field(transaction, "type"),
        description: string_field(transaction, "description"),
    }
}

/// Replays a previous run's JSONL log at startup. Skips (and warns about)
/// individually corrupt lines rather than refusing to start — a torn last
/// write shouldn't take down the whole event log.
pub fn load_log(path: &Path) -> std::io::Result<Vec<Event>> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(err) => return Err(err),
    };
    let reader = std::io::BufReader::new(file);
    let mut events = Vec::new();
    for (line_number, line) in reader.lines().enumerate() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        match serde_json::from_str::<Event>(&line) {
            Ok(event) => events.push(event),
            Err(err) => tracing::warn!("skipping malformed log line {line_number}: {err}"),
        }
    }
    Ok(events)
}
