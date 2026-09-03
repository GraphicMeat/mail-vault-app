//! Files dropped on the window through Tauri's native drag-drop.
//!
//! The webview never sees a native drop's bytes: wry reads the pasteboard
//! paths, Tauri emits them as `tauri://drag-drop`, and the compose window
//! asks for the contents here. Only paths from the most recent drop may be
//! read — the command is reachable by any script in the webview.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use base64::Engine as _;

#[derive(Default)]
pub struct DroppedPaths(Mutex<HashSet<PathBuf>>);

impl DroppedPaths {
    pub fn remember(&self, paths: &[PathBuf]) {
        let mut set = self.0.lock().unwrap_or_else(|e| e.into_inner());
        set.clear();
        set.extend(paths.iter().cloned());
    }

    fn permitted(&self, path: &Path) -> bool {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).contains(path)
    }
}

#[derive(serde::Serialize, Debug, PartialEq)]
pub struct DroppedFile {
    pub name: String,
    pub size: u64,
    /// Base64 of the file, the shape the compose window keeps attachments in.
    pub content: String,
}

/// ponytail: 50 MB cap — nothing bigger gets through SMTP anyway.
const MAX_BYTES: u64 = 50 * 1024 * 1024;

pub fn read_permitted(state: &DroppedPaths, paths: &[String]) -> Result<Vec<DroppedFile>, String> {
    paths
        .iter()
        .map(|p| {
            let path = PathBuf::from(p);
            let name = path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| p.clone());
            if !state.permitted(&path) {
                return Err(format!("{name}: not a file dropped on the window"));
            }
            let meta = std::fs::metadata(&path).map_err(|e| format!("{name}: {e}"))?;
            if meta.len() > MAX_BYTES {
                return Err(format!("{name}: larger than 50 MB"));
            }
            let bytes = std::fs::read(&path).map_err(|e| format!("{name}: {e}"))?;
            Ok(DroppedFile {
                name,
                size: meta.len(),
                content: base64::engine::general_purpose::STANDARD.encode(bytes),
            })
        })
        .collect()
}

#[tauri::command]
pub fn read_dropped_files(
    paths: Vec<String>,
    state: tauri::State<'_, DroppedPaths>,
) -> Result<Vec<DroppedFile>, String> {
    read_permitted(&state, &paths)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str, bytes: &[u8]) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mv-dropped-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        std::fs::write(&path, bytes).unwrap();
        path
    }

    #[test]
    fn reads_only_the_paths_of_the_latest_drop() {
        let shot = scratch("Screenshot 2026-09-03 at 12.04.41.png", b"png");
        let other = scratch("elsewhere.txt", b"secret");
        let state = DroppedPaths::default();

        let refused = read_permitted(&state, &[shot.to_string_lossy().into_owned()]);
        assert!(refused.unwrap_err().contains("not a file dropped on the window"));

        state.remember(&[shot.clone()]);
        let files = read_permitted(&state, &[shot.to_string_lossy().into_owned()]).unwrap();
        assert_eq!(
            files,
            vec![DroppedFile {
                name: "Screenshot 2026-09-03 at 12.04.41.png".into(),
                size: 3,
                content: "cG5n".into(),
            }]
        );
        assert!(read_permitted(&state, &[other.to_string_lossy().into_owned()]).is_err());

        state.remember(&[other.clone()]);
        assert!(read_permitted(&state, &[shot.to_string_lossy().into_owned()]).is_err());
    }
}
