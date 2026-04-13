use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::Mutex;
use tracing::{info, warn, error};

// ── Model Registry ─────────────────────────────────────────────────────────

/// A model available for download.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelInfo {
    pub id: String,
    pub name: String,
    pub description: String,
    pub filename: String,
    pub url: String,
    pub tokenizer_url: String,
    pub size_bytes: u64,
    pub sha256: String,
    pub min_ram_gb: u32,
    pub recommended: bool,
}

/// Status of a model on disk.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelStatus {
    pub id: String,
    pub name: String,
    pub size_bytes: u64,
    pub downloaded: bool,
    pub active: bool,
    pub recommended: bool,
}

/// Built-in model registry — models available for download.
pub fn get_model_registry() -> Vec<ModelInfo> {
    vec![
        ModelInfo {
            id: "llama3.2-1b".into(),
            name: "Llama 3.2 1B (Fast)".into(),
            description: "Fastest classification. ~700MB RAM, works on any machine.".into(),
            filename: "Llama-3.2-1B-Instruct-Q4_K_M.gguf".into(),
            url: "https://huggingface.co/bartowski/Llama-3.2-1B-Instruct-GGUF/resolve/main/Llama-3.2-1B-Instruct-Q4_K_M.gguf".into(),
            tokenizer_url: "https://huggingface.co/bartowski/Llama-3.2-1B-Instruct-GGUF/resolve/main/tokenizer.json".into(),
            size_bytes: 776_089_792, // ~740MB
            sha256: String::new(),
            min_ram_gb: 4,
            recommended: true,
        },
        ModelInfo {
            id: "llama3.2-3b".into(),
            name: "Llama 3.2 3B".into(),
            description: "Good balance of speed and quality. Works on 8GB RAM machines.".into(),
            filename: "Llama-3.2-3B-Instruct-Q4_K_M.gguf".into(),
            url: "https://huggingface.co/bartowski/Llama-3.2-3B-Instruct-GGUF/resolve/main/Llama-3.2-3B-Instruct-Q4_K_M.gguf".into(),
            tokenizer_url: "https://huggingface.co/bartowski/Llama-3.2-3B-Instruct-GGUF/resolve/main/tokenizer.json".into(),
            size_bytes: 2_019_377_408, // ~1.9GB
            sha256: String::new(),
            min_ram_gb: 8,
            recommended: false,
        },
        ModelInfo {
            id: "llama3.1-8b".into(),
            name: "Llama 3.1 8B".into(),
            description: "Best quality, slowest. Needs 16GB RAM.".into(),
            filename: "Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf".into(),
            url: "https://huggingface.co/bartowski/Meta-Llama-3.1-8B-Instruct-GGUF/resolve/main/Meta-Llama-3.1-8B-Instruct-Q4_K_M.gguf".into(),
            tokenizer_url: "https://huggingface.co/bartowski/Meta-Llama-3.1-8B-Instruct-GGUF/resolve/main/tokenizer.json".into(),
            size_bytes: 4_920_916_992, // ~4.6GB
            sha256: String::new(),
            min_ram_gb: 16,
            recommended: true,
        },
    ]
}

// ── Model Storage ──────────────────────────────────────────────────────────

fn models_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("models")
}

fn model_path(data_dir: &Path, filename: &str) -> PathBuf {
    models_dir(data_dir).join(filename)
}

/// List models with their download status.
pub fn list_models(data_dir: &Path, active_model_id: Option<&str>) -> Vec<ModelStatus> {
    let registry = get_model_registry();
    registry
        .iter()
        .map(|m| {
            let path = model_path(data_dir, &m.filename);
            let downloaded = path.exists();
            let actual_size = if downloaded {
                fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0)
            } else {
                0
            };
            ModelStatus {
                id: m.id.clone(),
                name: m.name.clone(),
                size_bytes: if downloaded { actual_size } else { m.size_bytes },
                downloaded,
                active: active_model_id == Some(m.id.as_str()),
                recommended: m.recommended,
            }
        })
        .collect()
}

/// Delete a downloaded model file.
pub fn delete_model(data_dir: &Path, model_id: &str) -> Result<(), String> {
    let registry = get_model_registry();
    let model = registry.iter().find(|m| m.id == model_id)
        .ok_or_else(|| format!("Unknown model: {}", model_id))?;

    let path = model_path(data_dir, &model.filename);
    if path.exists() {
        fs::remove_file(&path).map_err(|e| format!("Failed to delete model: {}", e))?;
        info!("Deleted model {} ({:?})", model_id, path);
    }
    Ok(())
}

// ── Model Download ─────────────────────────────────────────────────────────

/// Download state shared across the download task and status queries.
#[derive(Debug, Clone, Serialize)]
pub struct DownloadProgress {
    pub model_id: String,
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
    pub status: DownloadStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum DownloadStatus {
    Idle,
    Downloading,
    Verifying,
    Complete,
    Failed(String),
    Cancelled,
}

/// Shared download state.
pub struct LlmState {
    pub download_progress: Mutex<DownloadProgress>,
    pub cancel_flag: Mutex<bool>,
    pub active_model_id: Mutex<Option<String>>,
    pub data_dir: PathBuf,
}

impl LlmState {
    pub fn new(data_dir: PathBuf) -> Self {
        Self {
            download_progress: Mutex::new(DownloadProgress {
                model_id: String::new(),
                downloaded_bytes: 0,
                total_bytes: 0,
                status: DownloadStatus::Idle,
            }),
            cancel_flag: Mutex::new(false),
            active_model_id: Mutex::new(None),
            data_dir,
        }
    }
}

/// Download a model file with progress tracking.
pub async fn download_model(state: Arc<LlmState>, model_id: &str) -> Result<(), String> {
    let registry = get_model_registry();
    let model = registry.iter().find(|m| m.id == model_id)
        .ok_or_else(|| format!("Unknown model: {}", model_id))?;

    let dir = models_dir(&state.data_dir);
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create models dir: {}", e))?;

    let dest = model_path(&state.data_dir, &model.filename);
    let temp_dest = dest.with_extension("gguf.part");

    // Reset state
    {
        let mut progress = state.download_progress.lock().await;
        *progress = DownloadProgress {
            model_id: model_id.to_string(),
            downloaded_bytes: 0,
            total_bytes: model.size_bytes,
            status: DownloadStatus::Downloading,
        };
        *state.cancel_flag.lock().await = false;
    }

    info!("Starting download of {} ({} bytes) from {}", model.name, model.size_bytes, model.url);

    // Support resuming partial downloads
    let mut resume_from: u64 = 0;
    if temp_dest.exists() {
        resume_from = fs::metadata(&temp_dest).map(|m| m.len()).unwrap_or(0);
        info!("Resuming download from byte {}", resume_from);
    }

    let client = reqwest::Client::new();
    let mut request = client.get(&model.url);
    if resume_from > 0 {
        request = request.header("Range", format!("bytes={}-", resume_from));
    }

    let response = request.send().await
        .map_err(|e| format!("Download request failed: {}", e))?;

    if !response.status().is_success() && response.status().as_u16() != 206 {
        let status = response.status();
        return Err(format!("Download failed with HTTP {}", status));
    }

    let total = if resume_from > 0 {
        model.size_bytes
    } else {
        response.content_length().unwrap_or(model.size_bytes)
    };

    {
        let mut progress = state.download_progress.lock().await;
        progress.total_bytes = total;
        progress.downloaded_bytes = resume_from;
    }

    // Stream to file
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&temp_dest)
        .map_err(|e| format!("Failed to open temp file: {}", e))?;

    let mut downloaded = resume_from;
    let mut stream = response.bytes_stream();

    use futures::StreamExt;
    while let Some(chunk) = stream.next().await {
        // Check cancel
        if *state.cancel_flag.lock().await {
            let mut progress = state.download_progress.lock().await;
            progress.status = DownloadStatus::Cancelled;
            info!("Download cancelled at {} bytes", downloaded);
            return Err("Download cancelled".into());
        }

        let chunk = chunk.map_err(|e| format!("Download stream error: {}", e))?;
        file.write_all(&chunk).map_err(|e| format!("Failed to write: {}", e))?;
        downloaded += chunk.len() as u64;

        let mut progress = state.download_progress.lock().await;
        progress.downloaded_bytes = downloaded;
    }

    file.flush().map_err(|e| format!("Failed to flush: {}", e))?;
    drop(file);

    info!("Download complete: {} bytes", downloaded);

    // Verify SHA256 if we have a checksum
    if !model.sha256.is_empty() {
        let mut progress = state.download_progress.lock().await;
        progress.status = DownloadStatus::Verifying;
        drop(progress);

        let checksum = compute_sha256(&temp_dest)?;
        if checksum != model.sha256 {
            let _ = fs::remove_file(&temp_dest);
            let mut progress = state.download_progress.lock().await;
            progress.status = DownloadStatus::Failed("Checksum mismatch".into());
            return Err("SHA256 checksum mismatch — download may be corrupted".into());
        }
        info!("SHA256 verified: {}", checksum);
    }

    // Move to final location
    fs::rename(&temp_dest, &dest)
        .map_err(|e| format!("Failed to move model file: {}", e))?;

    // Download tokenizer.json if not already present
    let tokenizer_path = dir.join("tokenizer.json");
    if !tokenizer_path.exists() && !model.tokenizer_url.is_empty() {
        info!("Downloading tokenizer from {}", model.tokenizer_url);
        match download_tokenizer(&model.tokenizer_url, &tokenizer_path).await {
            Ok(()) => info!("Tokenizer saved to {:?}", tokenizer_path),
            Err(e) => warn!("Failed to download tokenizer (classification may not work): {}", e),
        }
    }

    let mut progress = state.download_progress.lock().await;
    progress.status = DownloadStatus::Complete;

    info!("Model {} ready at {:?}", model.name, dest);
    Ok(())
}

/// Cancel an in-progress download.
pub async fn cancel_download(state: Arc<LlmState>) {
    *state.cancel_flag.lock().await = true;
}

/// Get current download progress.
pub async fn get_download_progress(state: &LlmState) -> DownloadProgress {
    state.download_progress.lock().await.clone()
}

/// Download tokenizer.json from a URL to the models directory.
async fn download_tokenizer(url: &str, dest: &Path) -> Result<(), String> {
    let client = reqwest::Client::new();
    let response = client.get(url).send().await
        .map_err(|e| format!("request error: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status()));
    }

    let bytes = response.bytes().await
        .map_err(|e| format!("Failed to read response: {}", e))?;

    fs::write(dest, &bytes)
        .map_err(|e| format!("Failed to write tokenizer: {}", e))?;

    Ok(())
}

// ── Helpers ────────────────────────────────────────────────────────────────

fn compute_sha256(path: &Path) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    use std::io::Read;

    let mut file = fs::File::open(path)
        .map_err(|e| format!("Failed to open file for checksum: {}", e))?;

    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 8192];
    loop {
        let n = file.read(&mut buffer)
            .map_err(|e| format!("Failed to read file for checksum: {}", e))?;
        if n == 0 { break; }
        hasher.update(&buffer[..n]);
    }

    let hash = hasher.finalize();
    Ok(hash.iter().map(|b| format!("{:02x}", b)).collect())
}

// ── LLM Status ─────────────────────────────────────────────────────────────

/// Overall LLM engine status for the frontend.
#[derive(Debug, Clone, Serialize)]
pub struct LlmStatus {
    pub status: String, // "ready", "no-model", "downloading", "loading", "error"
    pub active_model: Option<String>,
    pub download: Option<DownloadProgress>,
    pub models_dir: String,
}

pub async fn get_status(state: &LlmState) -> LlmStatus {
    let active = state.active_model_id.lock().await.clone();
    let progress = state.download_progress.lock().await.clone();

    let status = if progress.status == DownloadStatus::Downloading {
        "downloading".to_string()
    } else if active.is_some() {
        "ready".to_string()
    } else {
        // Check if any model is downloaded
        let models = list_models(&state.data_dir, active.as_deref());
        if models.iter().any(|m| m.downloaded) {
            "ready".to_string() // Model exists but not loaded yet
        } else {
            "no-model".to_string()
        }
    };

    let download = if progress.status != DownloadStatus::Idle {
        Some(progress)
    } else {
        None
    };

    LlmStatus {
        status,
        active_model: active,
        download,
        models_dir: models_dir(&state.data_dir).to_string_lossy().into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_model_registry() {
        let registry = get_model_registry();
        assert!(registry.len() >= 2);
        assert!(registry.iter().any(|m| m.recommended));
        assert!(registry.iter().all(|m| !m.url.is_empty()));
    }

    #[test]
    fn test_list_models_no_downloads() {
        let dir = std::env::temp_dir().join("mailvault-test-llm-list");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        let models = list_models(&dir, None);
        assert!(models.iter().all(|m| !m.downloaded));
        assert!(models.iter().all(|m| !m.active));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_delete_nonexistent_model() {
        let dir = std::env::temp_dir().join("mailvault-test-llm-delete");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();

        // Should succeed silently
        let result = delete_model(&dir, "llama3.1-8b");
        assert!(result.is_ok());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_delete_unknown_model() {
        let dir = std::env::temp_dir().join("mailvault-test-llm-unknown");
        let result = delete_model(&dir, "nonexistent-model");
        assert!(result.is_err());
    }
}
