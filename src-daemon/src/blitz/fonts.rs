//! `render.fonts`: the mail's Google Fonts for the Blitz worker. Reads the
//! installed faces through the same core functions as `fonts.read`
//! (handlers/fonts.rs) and hands them to the worker's font library. Families
//! not installed are skipped: the frontend downloads them first
//! (fontService familyForMail) and asks again when they are ready.
//!
//! The worker keeps the first faces it sees for a family and ignores later
//! ones, so a family is sent once, with every installed face in one frame; the
//! host remembers it and replays it to a respawned worker.
use crate::server::DaemonState;
use base64::Engine;
use mailvault_core::google_fonts as gf;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// (worker family frames, names read) for `families`, from disk. A family that
/// is not in the catalogue or not installed whole is skipped.
pub(crate) fn frames_for(root: &Path, families: &[String]) -> (Vec<Value>, Vec<String>) {
    let mut frames = Vec::new();
    let mut names = Vec::new();
    for name in families {
        let Some(entry) = gf::find(name) else { continue };
        let Some(files) = gf::read_files(root, entry) else { continue };
        if files.is_empty() {
            continue;
        }
        let faces: Vec<Value> = files
            .into_iter()
            .map(|(f, bytes)| {
                json!({
                    "data": base64::engine::general_purpose::STANDARD.encode(bytes),
                    "weight": f.weight,
                    "style": f.style,
                    "unicodeRange": f.unicode_range,
                })
            })
            .collect();
        frames.push(json!({"family": entry.family, "faces": faces}));
        names.push(entry.family.clone());
    }
    (frames, names)
}

/// `render.fonts {families}` -> `{registered}`: the asked-for families the
/// worker now has (installed ones; those it already had are not sent again).
pub(crate) async fn render_fonts(state: &Arc<DaemonState>, params: &Value) -> Result<Value, String> {
    let mut wanted: Vec<String> = params["families"].as_array().map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_owned)).collect()).unwrap_or_default();
    let mut seen = std::collections::HashSet::new();
    wanted.retain(|f| seen.insert(f.clone()));
    let host = &state.blitz;
    let (mut registered, fresh): (Vec<String>, Vec<String>) = wanted.into_iter().partition(|f| host.has_font(f));
    let root: PathBuf = gf::fonts_root(&state.app_dir);
    let (frames, names) = tokio::task::spawn_blocking(move || frames_for(&root, &fresh)).await.map_err(|_| super::UNAVAILABLE.to_string())?;
    host.register_fonts(frames).await;
    registered.extend(names);
    Ok(json!({"registered": registered}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use mailvault_core::google_fonts as gf;

    /// Installs `family` the way `gf::install` leaves it: a manifest listing the
    /// files, written last, beside the files themselves.
    fn install(root: &std::path::Path, family: &str, faces: &[(u16, &str, &str, &str)]) {
        let entry = gf::find(family).expect("catalogue family");
        let dir = gf::family_dir(root, entry);
        std::fs::create_dir_all(&dir).unwrap();
        let mut files = Vec::new();
        for (i, (weight, style, subset, range)) in faces.iter().enumerate() {
            let file = format!("face-{i}.woff2");
            std::fs::write(dir.join(&file), b"wOF2fake").unwrap();
            files.push(gf::ManifestFile { file, weight: *weight, style: style.to_string(), subset: subset.to_string(), unicode_range: range.to_string() });
        }
        let manifest = gf::Manifest { family: entry.family.clone(), category: entry.category.clone(), files, bytes: 8 };
        std::fs::write(dir.join(gf::MANIFEST), serde_json::to_vec(&manifest).unwrap()).unwrap();
    }

    #[test]
    fn frames_for_reads_installed_faces_and_skips_unknown_or_missing() {
        let dir = tempfile::tempdir().unwrap();
        let root = gf::fonts_root(dir.path());
        install(&root, "Lora", &[(400, "normal", "latin", "U+0000-00FF"), (700, "italic", "latin-ext", "U+0100-02AF")]);
        let (frames, names) = frames_for(&root, &["Lora".into(), "Not A Font".into(), "Roboto".into()]);
        assert_eq!(names, vec!["Lora".to_string()]);
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0]["family"], "Lora");
        let faces = frames[0]["faces"].as_array().unwrap();
        assert_eq!(faces.len(), 2, "every installed face, in one frame");
        assert_eq!(faces[0]["weight"], 400);
        assert_eq!(faces[1]["style"], "italic");
        assert!(faces[0]["unicodeRange"].as_str().is_some());
        assert_eq!(faces[0]["data"], base64::engine::general_purpose::STANDARD.encode(b"wOF2fake"));
    }
}
