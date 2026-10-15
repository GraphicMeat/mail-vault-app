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
    let pool = &state.blitz;
    let (mut registered, fresh): (Vec<String>, Vec<String>) = wanted.into_iter().partition(|f| pool.has_font(f));
    let root: PathBuf = gf::fonts_root(&state.app_dir);
    let (frames, names) = tokio::task::spawn_blocking(move || frames_for(&root, &fresh)).await.map_err(|_| super::UNAVAILABLE.to_string())?;
    pool.register_fonts(frames).await;
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

    /// The real network for the by-hand tests below: no redirects, the body
    /// capped while it streams in, css2's woff2 chosen by a current browser's
    /// User-Agent (the app's own fetcher in handlers/fonts.rs does the same).
    struct NetFetch {
        rt: tokio::runtime::Runtime,
        client: reqwest::Client,
    }

    impl NetFetch {
        fn new() -> Self {
            let client = reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(20))
                .user_agent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .unwrap();
            Self { rt: tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap(), client }
        }
    }

    impl gf::Fetch for NetFetch {
        fn get(&self, url: &str, cap: usize) -> Result<Vec<u8>, gf::FetchError> {
            self.rt.block_on(async {
                let transient = |e: reqwest::Error| gf::FetchError::Transient(e.to_string());
                let mut response = self.client.get(url).send().await.map_err(transient)?;
                let status = response.status().as_u16();
                if status != 200 {
                    return Err(gf::FetchError::Status(status));
                }
                let mut body = Vec::new();
                while let Some(chunk) = response.chunk().await.map_err(transient)? {
                    if body.len() + chunk.len() > cap {
                        return Err(gf::FetchError::TooLarge);
                    }
                    body.extend_from_slice(&chunk);
                }
                Ok(body)
            })
        }
    }

    /// Lora as the app installs it (both files, the manifest's eight faces, in
    /// css2 order), sent to the Blitz worker as `render.fonts` sends it, with
    /// IBM Plex Mono after it in the stack. Returns the `textRuns` answers of a
    /// probe paragraph at each of `weights`, then of Plex Mono alone.
    fn real_lora_probe_runs(weights: &[u16]) -> Vec<Value> {
        let dir = std::env::temp_dir().join(format!("mv-fonts-lora-{}", uuid::Uuid::new_v4()));
        let root = gf::fonts_root(&dir);
        let entry = gf::find("Lora").unwrap();
        let manifest = gf::install(&root, entry, &NetFetch::new(), &gf::InstallOptions { retry_delays: &gf::RETRY_DELAYS }, &mut |_, _| {}, &mut || {}).unwrap();
        println!("[F1] manifest {:?}", manifest.files.iter().map(|f| (f.file.as_str(), f.weight, f.subset.as_str())).collect::<Vec<_>>());
        let (mut frames, _) = frames_for(&root, &["Lora".to_string()]);
        let _ = std::fs::remove_dir_all(&dir);
        let mono = std::fs::read(format!("{}/../src/assets/fonts/ibm-plex-mono-latin-400.woff2", env!("CARGO_MANIFEST_DIR"))).unwrap();
        frames.push(json!({"family": "Plex", "faces": [{"data": base64::engine::general_purpose::STANDARD.encode(mono), "weight": 400, "style": "normal"}]}));
        let probe = "Sphinx of black quartz, judge my vow 0123456789";
        let mut lines = vec![json!({"op": "fonts", "families": frames})];
        let stacks: Vec<String> = weights.iter().map(|w| format!("{w} 24px/36px 'Lora', 'Plex'")).chain(["400 24px/36px 'Plex'".to_string()]).collect();
        for (i, stack) in stacks.iter().enumerate() {
            let html = format!(r#"<body style="margin:0"><p style="margin:0;white-space:nowrap;font:{stack}">{probe}</p></body>"#);
            lines.push(json!({"op": "open", "req": 100 + i, "doc": 1 + i, "html": html, "cssWidth": 900, "scale": 1.0, "allowRemote": false}));
            lines.push(json!({"op": "textRuns", "req": 200 + i, "doc": 1 + i, "index": 0}));
        }
        let input: String = lines.iter().map(|l| format!("{l}\n")).collect();
        let mut out = Vec::new();
        mailvault_render::worker::run_with_fonts(std::io::Cursor::new(input.into_bytes()), &mut out, |_| {}, mailvault_render::fonts::FontLibrary::new(false)).unwrap();
        let answers: Vec<Value> = String::from_utf8(out).unwrap().lines().map(|l| serde_json::from_str(l).unwrap()).collect();
        (0..stacks.len())
            .map(|i| {
                let runs = answers.iter().find(|v| v["req"] == 200 + i).unwrap()["ok"]["runs"].clone();
                let w: f64 = runs.as_array().unwrap().iter().map(|r| r["w"].as_f64().unwrap()).sum();
                let texts: Vec<&str> = runs.as_array().unwrap().iter().map(|r| r["text"].as_str().unwrap()).collect();
                println!("[F1] {}: {} runs, width {w:.2}, {texts:?}", stacks[i], texts.len());
                runs
            })
            .collect()
    }

    fn width(runs: &Value) -> f64 {
        runs.as_array().unwrap().iter().map(|r| r["w"].as_f64().unwrap()).sum()
    }

    /// F1, by hand only (`cargo test -p mailvault-daemon real_lora -- --ignored
    /// --nocapture`): the real Lora files draw the probe's Latin letters in
    /// Lora, in one run, not in the next family.
    #[test]
    #[ignore = "reaches fonts.googleapis.com"]
    fn real_lora_draws_latin_text_in_lora_in_blitz() {
        let runs = real_lora_probe_runs(&[400]);
        let (lora, plex) = (&runs[0], &runs[1]);
        assert_eq!(lora.as_array().unwrap().len(), 1, "one font for the whole probe: {lora}");
        assert!((width(lora) - width(plex)).abs() > 20.0, "Lora probe {} is Plex Mono's width {}", width(lora), width(plex));
    }

    /// By hand only: Lora is one variable file per subset; its 700 face draws bold.
    #[test]
    #[ignore = "reaches fonts.googleapis.com"]
    fn real_lora_bold_is_wider_than_regular_in_blitz() {
        let runs = real_lora_probe_runs(&[400, 700]);
        assert!(width(&runs[1]) > width(&runs[0]) + 5.0, "700 {} vs 400 {}", width(&runs[1]), width(&runs[0]));
    }
}
