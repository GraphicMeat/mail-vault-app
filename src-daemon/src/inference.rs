use candle_core::{Device, Tensor};
use candle_transformers::generation::LogitsProcessor;
use candle_transformers::models::quantized_llama::ModelWeights;
use std::path::Path;
use std::sync::Arc;
use tokenizers::Tokenizer;
use tokio::sync::Mutex;
use tracing::{info, warn, error};

/// Loaded model state — kept in memory between inference calls.
pub struct LoadedModel {
    pub model: ModelWeights,
    pub tokenizer: Tokenizer,
    pub device: Device,
    pub model_id: String,
}

/// Shared inference engine state.
pub struct InferenceEngine {
    loaded: Mutex<Option<LoadedModel>>,
}

impl InferenceEngine {
    pub fn new() -> Self {
        Self {
            loaded: Mutex::new(None),
        }
    }

    /// Check if a model is currently loaded.
    pub async fn is_loaded(&self) -> bool {
        self.loaded.lock().await.is_some()
    }

    /// Get the ID of the currently loaded model.
    pub async fn active_model_id(&self) -> Option<String> {
        self.loaded.lock().await.as_ref().map(|m| m.model_id.clone())
    }

    /// Load a GGUF model from disk.
    pub async fn load_model(&self, model_path: &Path, model_id: &str) -> Result<(), String> {
        info!("Loading GGUF model from {:?}", model_path);

        if !model_path.exists() {
            return Err(format!("Model file not found: {:?}", model_path));
        }

        let device = select_device();
        info!("Using device: {:?}", device);

        // Load GGUF weights
        let mut file = std::fs::File::open(model_path)
            .map_err(|e| format!("Failed to open model: {}", e))?;

        let model = {
            let gguf = candle_core::quantized::gguf_file::Content::read(&mut file)
                .map_err(|e| format!("Failed to read GGUF: {}", e))?;

            ModelWeights::from_gguf(gguf, &mut file, &device)
                .map_err(|e| format!("Failed to load model weights: {}", e))?
        };

        // Load tokenizer — look for tokenizer.json next to the model, or use HF hub
        let tokenizer = load_tokenizer(model_path)
            .map_err(|e| format!("Failed to load tokenizer: {}", e))?;

        let mut guard = self.loaded.lock().await;
        *guard = Some(LoadedModel {
            model,
            tokenizer,
            device,
            model_id: model_id.to_string(),
        });

        info!("Model {} loaded successfully", model_id);
        Ok(())
    }

    /// Unload the current model to free memory.
    pub async fn unload(&self) {
        let mut guard = self.loaded.lock().await;
        if let Some(ref m) = *guard {
            info!("Unloading model {}", m.model_id);
        }
        *guard = None;
    }

    /// Run inference: generate text from a prompt.
    pub async fn infer(&self, prompt: &str, max_tokens: usize) -> Result<String, String> {
        let mut guard = self.loaded.lock().await;
        let loaded = guard.as_mut()
            .ok_or_else(|| "No model loaded".to_string())?;

        let tokens = loaded.tokenizer.encode(prompt, true)
            .map_err(|e| format!("Tokenization failed: {}", e))?;

        let input_ids = tokens.get_ids();
        let mut all_tokens = input_ids.to_vec();

        let mut logits_processor = LogitsProcessor::new(42, Some(0.7), Some(0.9));

        // Build initial input tensor
        let input = Tensor::new(input_ids, &loaded.device)
            .map_err(|e| format!("Tensor creation failed: {}", e))?
            .unsqueeze(0)
            .map_err(|e| format!("Unsqueeze failed: {}", e))?;

        // Forward pass for the prompt
        let logits = loaded.model.forward(&input, 0)
            .map_err(|e| format!("Forward pass failed: {}", e))?;

        let logits = logits.squeeze(0)
            .map_err(|e| format!("Squeeze failed: {}", e))?;

        // Sample first generated token
        let next_token = logits_processor.sample(&logits)
            .map_err(|e| format!("Sampling failed: {}", e))?;
        all_tokens.push(next_token);

        // Autoregressive generation loop
        let mut generated = 1;
        let eos_token = find_eos_token(&loaded.tokenizer);

        while generated < max_tokens {
            let input = Tensor::new(&[next_token], &loaded.device)
                .map_err(|e| format!("Tensor creation failed: {}", e))?
                .unsqueeze(0)
                .map_err(|e| format!("Unsqueeze failed: {}", e))?;

            let logits = loaded.model.forward(&input, input_ids.len() + generated)
                .map_err(|e| format!("Forward pass failed: {}", e))?;

            let logits = logits.squeeze(0)
                .map_err(|e| format!("Squeeze failed: {}", e))?;

            let next_token_new = logits_processor.sample(&logits)
                .map_err(|e| format!("Sampling failed: {}", e))?;

            if Some(next_token_new) == eos_token {
                break;
            }

            all_tokens.push(next_token_new);
            generated += 1;
        }

        // Decode only the generated portion
        let generated_tokens = &all_tokens[input_ids.len()..];
        let output = loaded.tokenizer.decode(generated_tokens, true)
            .map_err(|e| format!("Decoding failed: {}", e))?;

        info!("Generated {} tokens", generated);
        Ok(output)
    }
}

/// Select the best available device (Metal on macOS, CPU elsewhere).
fn select_device() -> Device {
    #[cfg(feature = "metal")]
    {
        match Device::new_metal(0) {
            Ok(device) => {
                info!("Using Metal GPU");
                return device;
            }
            Err(e) => {
                warn!("Metal unavailable, falling back to CPU: {}", e);
            }
        }
    }
    info!("Using CPU");
    Device::Cpu
}

/// Load tokenizer.json from next to the model file, or download from HuggingFace.
fn load_tokenizer(model_path: &Path) -> Result<Tokenizer, String> {
    // Check for tokenizer.json next to the model
    if let Some(dir) = model_path.parent() {
        let tokenizer_path = dir.join("tokenizer.json");
        if tokenizer_path.exists() {
            info!("Loading tokenizer from {:?}", tokenizer_path);
            return Tokenizer::from_file(&tokenizer_path)
                .map_err(|e| format!("Failed to load tokenizer: {}", e));
        }
    }

    // Try to download from HuggingFace hub
    info!("Downloading tokenizer from HuggingFace hub...");
    let api = hf_hub::api::sync::Api::new()
        .map_err(|e| format!("HF API init failed: {}", e))?;

    // Determine the repo based on model filename
    let filename = model_path.file_name().and_then(|f| f.to_str()).unwrap_or("");
    let repo = if filename.contains("Llama-3.2-3B") {
        "meta-llama/Llama-3.2-3B-Instruct"
    } else if filename.contains("Llama-3.1-8B") || filename.contains("Meta-Llama-3.1-8B") {
        "meta-llama/Meta-Llama-3.1-8B-Instruct"
    } else {
        // Generic fallback — try llama3 tokenizer
        "meta-llama/Meta-Llama-3.1-8B-Instruct"
    };

    let repo = api.model(repo.to_string());
    let tokenizer_path = repo.get("tokenizer.json")
        .map_err(|e| format!("Failed to download tokenizer: {}", e))?;

    // Copy to models dir for future use
    if let Some(dir) = model_path.parent() {
        let local_path = dir.join("tokenizer.json");
        if let Err(e) = std::fs::copy(&tokenizer_path, &local_path) {
            warn!("Failed to cache tokenizer locally: {}", e);
        }
    }

    Tokenizer::from_file(&tokenizer_path)
        .map_err(|e| format!("Failed to load downloaded tokenizer: {}", e))
}

/// Find the EOS token ID in the tokenizer vocabulary.
fn find_eos_token(tokenizer: &Tokenizer) -> Option<u32> {
    // Common EOS tokens for Llama models
    for candidate in ["<|eot_id|>", "</s>", "<|end_of_text|>", "<eos>"] {
        if let Some(id) = tokenizer.token_to_id(candidate) {
            return Some(id);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_select_device() {
        let device = select_device();
        // Should not panic — returns CPU at minimum
        match device {
            Device::Cpu => {}
            _ => {} // Metal or other accelerator
        }
    }

    #[tokio::test]
    async fn test_engine_no_model() {
        let engine = InferenceEngine::new();
        assert!(!engine.is_loaded().await);
        assert!(engine.active_model_id().await.is_none());

        let result = engine.infer("test", 10).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("No model loaded"));
    }

    #[tokio::test]
    async fn test_engine_load_nonexistent() {
        let engine = InferenceEngine::new();
        let result = engine.load_model(Path::new("/nonexistent/model.gguf"), "test").await;
        assert!(result.is_err());
    }
}
