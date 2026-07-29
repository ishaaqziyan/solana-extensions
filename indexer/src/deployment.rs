//! Reads `deployments/<cluster>.json`, written by `npm run create-mint`
//! (`scripts/lib/config.ts`'s `saveDeployment`). Field names mirror that
//! file's `Deployment` interface exactly so the indexer never drifts from
//! whatever the TS scripts actually deployed.

use std::path::Path;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Deployment {
    pub cluster: String,
    #[serde(rename = "hookProgramId")]
    pub hook_program_id: String,
    pub mint: String,
    pub allowlist: String,
    #[serde(rename = "extraAccountMetaList")]
    pub extra_account_meta_list: String,
    pub issuer: String,
    pub decimals: u8,
    #[serde(rename = "createdAt")]
    pub created_at: String,
}

pub fn load(repo_root: &Path, cluster: &str) -> std::io::Result<Deployment> {
    let path = repo_root
        .join("deployments")
        .join(format!("{cluster}.json"));
    let raw = std::fs::read_to_string(&path)?;
    serde_json::from_str(&raw)
        .map_err(|err| std::io::Error::new(std::io::ErrorKind::InvalidData, err))
}
