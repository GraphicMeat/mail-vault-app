//! Google Fonts on demand: the curated catalogue, the css2 request, the
//! parse of its `@font-face` blocks, and the install of one family's woff2
//! files under `<app_dir>/fonts/<slug>/`.
//!
//! Only a family in the catalogue (`src/data/googleFonts.json`, the same file
//! the app browses) is ever requested, and only `https://fonts.gstatic.com/`
//! files are fetched, so no caller can make the daemon fetch a URL of its
//! choosing. The network is behind `Fetch`: the daemon supplies the real one
//! (`handlers::fonts`), the tests a fake.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

/// The Network Activity purpose of every font request.
pub const PURPOSE: &str = "fonts";
pub const CSS_HOST: &str = "fonts.googleapis.com";
pub const FILE_HOST: &str = "fonts.gstatic.com";
/// The weights a family is downloaded in, where it has them.
pub const WANTED_WEIGHTS: [u16; 4] = [400, 500, 600, 700];
/// The subsets kept; every other block of the stylesheet is ignored.
pub const SUBSETS: [&str; 2] = ["latin", "latin-ext"];
/// A latin woff2 is tens of KB; anything this big is not one.
pub const MAX_FILE_BYTES: usize = 1_500_000;
pub const MAX_CSS_BYTES: usize = 256 * 1024;
pub const MANIFEST: &str = "manifest.json";

const CATALOGUE_JSON: &str = include_str!("../../src/data/googleFonts.json");

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
pub struct CatalogueEntry {
    pub family: String,
    pub category: String,
    pub weights: Vec<u16>,
    pub subsets: Vec<String>,
}

#[derive(Deserialize)]
struct Catalogue {
    families: Vec<CatalogueEntry>,
}

pub fn catalogue() -> &'static [CatalogueEntry] {
    static CAT: OnceLock<Vec<CatalogueEntry>> = OnceLock::new();
    CAT.get_or_init(|| serde_json::from_str::<Catalogue>(CATALOGUE_JSON).map(|c| c.families).unwrap_or_default())
}

/// The catalogue entry named exactly `family`.
pub fn find(family: &str) -> Option<&'static CatalogueEntry> {
    catalogue().iter().find(|e| e.family == family)
}

/// `Open Sans` -> `open-sans`: the family's directory name.
pub fn slug(family: &str) -> String {
    family.split_whitespace().map(|w| w.to_ascii_lowercase()).collect::<Vec<_>>().join("-")
}

/// The weights to ask for: the wanted ones the family has, else its closest to 400.
pub fn download_weights(entry: &CatalogueEntry) -> Vec<u16> {
    let wanted: Vec<u16> = WANTED_WEIGHTS.iter().copied().filter(|w| entry.weights.contains(w)).collect();
    if !wanted.is_empty() {
        return wanted;
    }
    entry.weights.iter().copied().min_by_key(|w| (i32::from(*w) - 400).abs()).into_iter().collect()
}

/// The css2 stylesheet URL. No weights asks for the family's default face.
pub fn css2_url(family: &str, weights: &[u16]) -> String {
    // Catalogue names are letters, digits and spaces only (a test holds it).
    let name = family.replace(' ', "+");
    let axis = if weights.is_empty() {
        String::new()
    } else {
        format!(":wght@{}", weights.iter().map(u16::to_string).collect::<Vec<_>>().join(";"))
    };
    format!("https://{CSS_HOST}/css2?family={name}{axis}&display=swap")
}

/// One `@font-face` block kept from the stylesheet.
#[derive(Debug, Clone, PartialEq)]
pub struct Face {
    pub subset: String,
    pub weight: u16,
    pub style: String,
    pub unicode_range: String,
    pub url: String,
}

/// The normal-style latin and latin-ext faces in `weights`, in stylesheet
/// order. A block whose file is not on `fonts.gstatic.com`, or whose
/// unicode-range is not a plain range list, is dropped.
pub fn parse_css(css: &str, weights: &[u16]) -> Vec<Face> {
    let mut faces = Vec::new();
    let mut rest = css;
    let mut subset = String::new();
    loop {
        let comment = rest.find("/*");
        let block = rest.find("@font-face");
        match (comment, block) {
            (Some(c), b) if b.map_or(true, |b| c < b) => {
                let Some(end) = rest[c..].find("*/") else { break };
                subset = rest[c + 2..c + end].trim().to_string();
                rest = &rest[c + end + 2..];
            }
            (_, Some(b)) => {
                let after = &rest[b..];
                let (Some(open), Some(close)) = (after.find('{'), after.find('}')) else { break };
                if close < open {
                    break;
                }
                if let Some(face) = face_of(&subset, &after[open + 1..close], weights) {
                    faces.push(face);
                }
                rest = &after[close + 1..];
            }
            _ => break,
        }
    }
    faces
}

fn face_of(subset: &str, body: &str, weights: &[u16]) -> Option<Face> {
    if !SUBSETS.contains(&subset) {
        return None;
    }
    let mut style = None;
    let mut weight = None;
    let mut url = None;
    let mut range = None;
    for decl in body.split(';') {
        let Some((key, value)) = decl.split_once(':') else { continue };
        let value = value.trim();
        match key.trim() {
            "font-style" => style = Some(value.to_string()),
            "font-weight" => weight = value.parse::<u16>().ok(),
            "src" => {
                let start = value.find("url(")? + 4;
                let end = value[start..].find(')')? + start;
                url = Some(value[start..end].trim_matches(|c| c == '\'' || c == '"').to_string());
            }
            "unicode-range" => range = Some(value.to_string()),
            _ => {}
        }
    }
    let (style, weight, url, unicode_range) = (style?, weight?, url?, range?);
    let wanted = style == "normal" && weights.contains(&weight) && is_allowed_font_url(&url) && is_valid_unicode_range(&unicode_range);
    wanted.then(|| Face { subset: subset.to_string(), weight, style, unicode_range, url })
}

/// `https://fonts.gstatic.com/...` and nothing else: no other host, port,
/// credentials or scheme.
pub fn is_allowed_font_url(url: &str) -> bool {
    let Ok(parsed) = url::Url::parse(url) else { return false };
    parsed.scheme() == "https"
        && parsed.host_str() == Some(FILE_HOST)
        && parsed.port().is_none()
        && parsed.username().is_empty()
        && parsed.password().is_none()
}

/// `U+0000-00FF, U+0131, U+04??`: what a `FontFace`'s `unicodeRange` may be.
pub fn is_valid_unicode_range(range: &str) -> bool {
    !range.is_empty()
        && range.len() <= 4096
        && range.split(',').all(|part| {
            let Some(hex) = part.trim().strip_prefix("U+") else { return false };
            !hex.is_empty() && hex.chars().all(|c| c.is_ascii_hexdigit() || c == '?' || c == '-')
        })
}

pub fn is_woff2(bytes: &[u8]) -> bool {
    bytes.len() > 4 && &bytes[..4] == b"wOF2"
}

/// A manifest's file name: `<subset>-<weight>.woff2`, never a path.
fn is_font_file_name(name: &str) -> bool {
    name.strip_suffix(".woff2").is_some_and(|stem| {
        !stem.is_empty() && !stem.starts_with('.') && stem.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
    })
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ManifestFile {
    pub file: String,
    pub weight: u16,
    pub style: String,
    pub subset: String,
    pub unicode_range: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub family: String,
    pub category: String,
    pub files: Vec<ManifestFile>,
    pub bytes: u64,
}

/// `<app_dir>/fonts`: never the vault, which may be on a drive that is gone.
pub fn fonts_root(app_dir: &Path) -> PathBuf {
    app_dir.join("fonts")
}

pub fn family_dir(root: &Path, entry: &CatalogueEntry) -> PathBuf {
    root.join(slug(&entry.family))
}

/// The family's manifest, if it is installed whole: it parses, names this
/// catalogue family, and every file it lists is there.
pub fn read_manifest(root: &Path, entry: &CatalogueEntry) -> Option<Manifest> {
    let dir = family_dir(root, entry);
    let raw = std::fs::read(dir.join(MANIFEST)).ok()?;
    let manifest: Manifest = serde_json::from_slice(&raw).ok()?;
    let whole = manifest.family == entry.family
        && !manifest.files.is_empty()
        && manifest.files.iter().all(|f| is_font_file_name(&f.file) && dir.join(&f.file).is_file());
    whole.then_some(manifest)
}

/// Every family installed whole, by name.
pub fn list(root: &Path) -> Vec<Manifest> {
    let Ok(dirs) = std::fs::read_dir(root) else { return Vec::new() };
    let mut out: Vec<Manifest> = dirs
        .flatten()
        // A symlink is never followed: only real directories this code made.
        .filter(|d| d.file_type().is_ok_and(|t| t.is_dir()))
        .filter_map(|d| {
            let name = d.file_name().into_string().ok()?;
            let entry = catalogue().iter().find(|e| slug(&e.family) == name)?;
            read_manifest(root, entry)
        })
        .collect();
    out.sort_by(|a, b| a.family.cmp(&b.family));
    out
}

/// The family's files with their bytes, or `None` if it is not installed whole.
pub fn read_files(root: &Path, entry: &CatalogueEntry) -> Option<Vec<(ManifestFile, Vec<u8>)>> {
    let manifest = read_manifest(root, entry)?;
    let dir = family_dir(root, entry);
    manifest.files.into_iter().map(|f| std::fs::read(dir.join(&f.file)).ok().map(|bytes| (f, bytes))).collect()
}

/// Removes the family's directory. `false` when there was none.
pub fn remove(root: &Path, entry: &CatalogueEntry) -> std::io::Result<bool> {
    let dir = family_dir(root, entry);
    match std::fs::remove_dir_all(&dir) {
        Ok(()) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e),
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum FetchError {
    /// Worth another try: a timeout, a dropped connection.
    Transient(String),
    /// The server answered with this status.
    Status(u16),
    /// The body passed the size cap.
    TooLarge,
    Other(String),
}

impl FetchError {
    fn retryable(&self) -> bool {
        matches!(self, FetchError::Transient(_)) || matches!(self, FetchError::Status(s) if *s == 429 || *s >= 500)
    }
}

/// One GET, its body capped at `cap` bytes.
pub trait Fetch {
    fn get(&self, url: &str, cap: usize) -> Result<Vec<u8>, FetchError>;
}

#[derive(Debug, Clone, PartialEq)]
pub enum FontError {
    Unknown,
    Network(String),
    Refused(u16),
    Invalid(String),
    Disk(String),
}

impl FontError {
    /// What the app words its message by.
    pub fn code(&self) -> &'static str {
        match self {
            FontError::Unknown => "E_FONT_UNKNOWN",
            FontError::Network(_) => "E_FONT_NETWORK",
            FontError::Refused(_) => "E_FONT_REFUSED",
            FontError::Invalid(_) => "E_FONT_INVALID",
            FontError::Disk(_) => "E_FONT_DISK",
        }
    }
}

impl std::fmt::Display for FontError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FontError::Unknown => write!(f, "not a catalogue font"),
            FontError::Network(e) => write!(f, "network: {e}"),
            FontError::Refused(s) => write!(f, "HTTP {s}"),
            FontError::Invalid(e) => write!(f, "invalid: {e}"),
            FontError::Disk(e) => write!(f, "disk: {e}"),
        }
    }
}

/// How `install` runs: the pauses before each retry of a transient failure.
pub struct InstallOptions<'a> {
    pub retry_delays: &'a [Duration],
}

pub const RETRY_DELAYS: [Duration; 2] = [Duration::from_secs(1), Duration::from_secs(3)];

/// Downloads and installs one family, once: an installed family answers its
/// manifest without a request. Files first, each written atomically under a
/// dot-prefixed temp name, the manifest last, so a family with a manifest is
/// complete. A failed install leaves no directory behind. `between` runs
/// before every file (the daemon yields to the user there); `progress` hears
/// files done of total.
pub fn install(
    root: &Path,
    entry: &CatalogueEntry,
    fetch: &dyn Fetch,
    options: &InstallOptions,
    progress: &mut dyn FnMut(usize, usize),
    between: &mut dyn FnMut(),
) -> Result<Manifest, FontError> {
    if find(&entry.family).is_none() {
        return Err(FontError::Unknown);
    }
    if let Some(manifest) = read_manifest(root, entry) {
        return Ok(manifest);
    }
    let dir = family_dir(root, entry);
    // Whatever is there has no manifest: a download cut off earlier.
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).map_err(|e| FontError::Disk(e.to_string()))?;
    let out = install_into(&dir, entry, fetch, options, progress, between);
    if out.is_err() {
        let _ = std::fs::remove_dir_all(&dir);
    }
    out
}

fn install_into(
    dir: &Path,
    entry: &CatalogueEntry,
    fetch: &dyn Fetch,
    options: &InstallOptions,
    progress: &mut dyn FnMut(usize, usize),
    between: &mut dyn FnMut(),
) -> Result<Manifest, FontError> {
    let mut weights = download_weights(entry);
    let css = match get_with_retry(fetch, &css2_url(&entry.family, &weights), MAX_CSS_BYTES, options) {
        // css2 refuses the whole request when one listed weight does not
        // exist: the family's default face is always there.
        Err(FetchError::Status(400)) if weights != [400] => {
            weights = vec![400];
            get_with_retry(fetch, &css2_url(&entry.family, &[]), MAX_CSS_BYTES, options)
        }
        other => other,
    }
    .map_err(font_error)?;
    let faces = parse_css(&String::from_utf8_lossy(&css), &weights);
    if faces.is_empty() {
        return Err(FontError::Invalid("the stylesheet held no latin face".into()));
    }

    // A variable font serves several weights from one file: fetch each once.
    let mut urls: Vec<(String, String)> = Vec::new();
    let mut files = Vec::new();
    for face in &faces {
        let file = match urls.iter().find(|(url, _)| *url == face.url) {
            Some((_, file)) => file.clone(),
            None => {
                let file = format!("{}-{}.woff2", face.subset, face.weight);
                urls.push((face.url.clone(), file.clone()));
                file
            }
        };
        files.push(ManifestFile {
            file,
            weight: face.weight,
            style: face.style.clone(),
            subset: face.subset.clone(),
            unicode_range: face.unicode_range.clone(),
        });
    }

    let total = urls.len();
    progress(0, total);
    let mut bytes = 0u64;
    for (i, (url, file)) in urls.iter().enumerate() {
        between();
        let body = get_with_retry(fetch, url, MAX_FILE_BYTES, options).map_err(font_error)?;
        if !is_woff2(&body) {
            return Err(FontError::Invalid(format!("{file} is not a woff2 file")));
        }
        crate::fsx::write_atomic(&dir.join(file), &body).map_err(|e| FontError::Disk(e.to_string()))?;
        bytes += body.len() as u64;
        progress(i + 1, total);
    }

    let manifest = Manifest { family: entry.family.clone(), category: entry.category.clone(), files, bytes };
    let json = serde_json::to_vec_pretty(&manifest).map_err(|e| FontError::Disk(e.to_string()))?;
    crate::fsx::write_atomic(&dir.join(MANIFEST), &json).map_err(|e| FontError::Disk(e.to_string()))?;
    Ok(manifest)
}

fn get_with_retry(fetch: &dyn Fetch, url: &str, cap: usize, options: &InstallOptions) -> Result<Vec<u8>, FetchError> {
    let mut delays = options.retry_delays.iter();
    loop {
        match fetch.get(url, cap) {
            Err(e) if e.retryable() => match delays.next() {
                Some(delay) => std::thread::sleep(*delay),
                None => return Err(e),
            },
            other => return other,
        }
    }
}

fn font_error(e: FetchError) -> FontError {
    match e {
        FetchError::Transient(msg) => FontError::Network(msg),
        FetchError::Status(s) if s == 429 || s >= 500 => FontError::Network(format!("HTTP {s}")),
        FetchError::Status(s) => FontError::Refused(s),
        FetchError::TooLarge => FontError::Invalid("a file passed the size cap".into()),
        FetchError::Other(msg) => FontError::Network(msg),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::HashMap;

    const CSS: &str = include_str!("../tests/fixtures/google_fonts_css2.css");
    const WOFF2: &[u8] = b"wOF2\0\x01\0\0fake font body";

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mv-gfonts-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn roboto() -> &'static CatalogueEntry {
        find("Roboto").expect("Roboto is in the catalogue")
    }

    /// Answers from a table; records every URL asked for. A URL mapped to a
    /// list of answers gives them in turn (the last one repeats).
    struct Fake {
        answers: HashMap<String, Vec<Result<Vec<u8>, FetchError>>>,
        asked: RefCell<Vec<String>>,
    }

    impl Fake {
        fn new() -> Self {
            Fake { answers: HashMap::new(), asked: RefCell::new(Vec::new()) }
        }
        fn with(mut self, url: &str, answers: Vec<Result<Vec<u8>, FetchError>>) -> Self {
            self.answers.insert(url.to_string(), answers);
            self
        }
        fn roboto_files(self) -> Self {
            self.with("https://fonts.gstatic.com/s/roboto/v47/KFO7CnqEu92Fr1ME7kSn66aGLdTylUAMa3-UBGEe.woff2", vec![Ok(WOFF2.to_vec())])
                .with("https://fonts.gstatic.com/s/roboto/v47/KFO7CnqEu92Fr1ME7kSn66aGLdTylUAMa3yUBA.woff2", vec![Ok(WOFF2.to_vec())])
        }
    }

    impl Fetch for Fake {
        fn get(&self, url: &str, cap: usize) -> Result<Vec<u8>, FetchError> {
            let n = self.asked.borrow().iter().filter(|u| *u == url).count();
            self.asked.borrow_mut().push(url.to_string());
            let Some(list) = self.answers.get(url) else { return Err(FetchError::Status(404)) };
            let out = list[n.min(list.len() - 1)].clone();
            match out {
                Ok(body) if body.len() > cap => Err(FetchError::TooLarge),
                other => other,
            }
        }
    }

    const NO_WAIT: InstallOptions<'static> = InstallOptions { retry_delays: &[Duration::ZERO, Duration::ZERO] };

    fn run(root: &Path, entry: &CatalogueEntry, fetch: &dyn Fetch) -> Result<Manifest, FontError> {
        install(root, entry, fetch, &NO_WAIT, &mut |_, _| {}, &mut || {})
    }

    fn roboto_css_url() -> String {
        css2_url("Roboto", &[400, 500, 600, 700])
    }

    #[test]
    fn the_catalogue_is_about_a_hundred_valid_distinct_families() {
        let cat = catalogue();
        assert!(cat.len() >= 90, "{} families", cat.len());
        let mut seen = std::collections::HashSet::new();
        for e in cat {
            assert!(seen.insert(e.family.as_str()), "{} twice", e.family);
            assert!(!e.family.is_empty() && e.family.chars().all(|c| c.is_ascii_alphanumeric() || c == ' '), "{}", e.family);
            assert!(["sans", "serif", "mono", "display", "handwriting"].contains(&e.category.as_str()), "{}", e.family);
            assert!(!download_weights(e).is_empty(), "{}", e.family);
            assert!(e.subsets.iter().all(|s| SUBSETS.contains(&s.as_str())), "{}", e.family);
        }
    }

    #[test]
    fn finds_a_family_only_by_its_exact_name() {
        assert_eq!(find("Open Sans").map(|e| e.category.as_str()), Some("sans"));
        assert!(find("open sans").is_none());
        assert!(find("../Roboto").is_none());
        assert!(find("Comic Sans MS").is_none());
    }

    #[test]
    fn slugs_are_lowercase_words_joined_by_dashes() {
        assert_eq!(slug("Open Sans"), "open-sans");
        assert_eq!(slug("Source Serif 4"), "source-serif-4");
        assert_eq!(slug("Roboto"), "roboto");
    }

    #[test]
    fn asks_for_the_wanted_weights_the_family_has() {
        assert_eq!(download_weights(roboto()), vec![400, 500, 600, 700]);
        assert_eq!(download_weights(find("PT Sans").unwrap()), vec![400, 700]);
        assert_eq!(download_weights(find("Lobster").unwrap()), vec![400]);
        let light = CatalogueEntry { family: "X".into(), category: "sans".into(), weights: vec![100, 300], subsets: vec![] };
        assert_eq!(download_weights(&light), vec![300]);
    }

    #[test]
    fn builds_the_css2_url_with_the_family_encoded() {
        assert_eq!(
            css2_url("Open Sans", &[400, 700]),
            "https://fonts.googleapis.com/css2?family=Open+Sans:wght@400;700&display=swap"
        );
        assert_eq!(css2_url("Lobster", &[]), "https://fonts.googleapis.com/css2?family=Lobster&display=swap");
    }

    #[test]
    fn parses_normal_latin_faces_in_the_wanted_weights_from_gstatic_only() {
        let faces = parse_css(CSS, &[400, 500, 600, 700]);
        let seen: Vec<_> = faces.iter().map(|f| (f.subset.as_str(), f.weight)).collect();
        // No cyrillic, no italic, no 900, and the 500 on another host is dropped.
        assert_eq!(seen, [("latin-ext", 400), ("latin", 400), ("latin-ext", 700), ("latin", 700)]);
        assert!(faces.iter().all(|f| f.style == "normal" && f.url.starts_with("https://fonts.gstatic.com/")));
        assert!(faces[1].unicode_range.starts_with("U+0000-00FF, U+0131"));
    }

    #[test]
    fn a_stylesheet_that_is_not_css_parses_to_nothing() {
        assert!(parse_css("<html>quota exceeded</html>", &[400]).is_empty());
        assert!(parse_css("", &[400]).is_empty());
        assert!(parse_css("/* latin */ @font-face { font-weight: 400; src: url(", &[400]).is_empty());
    }

    #[test]
    fn only_gstatic_https_urls_are_allowed() {
        assert!(is_allowed_font_url("https://fonts.gstatic.com/s/roboto/v47/a.woff2"));
        for bad in [
            "http://fonts.gstatic.com/s/a.woff2",
            "https://fonts.gstatic.com.evil.test/a.woff2",
            "https://evil.test/fonts.gstatic.com/a.woff2",
            "https://user@fonts.gstatic.com/a.woff2",
            "https://fonts.gstatic.com:8443/a.woff2",
            "file:///etc/passwd",
            "https://FONTS.GSTATIC.COM@evil.test/a.woff2",
            "",
        ] {
            assert!(!is_allowed_font_url(bad), "{bad}");
        }
    }

    #[test]
    fn a_unicode_range_is_ranges_and_nothing_else() {
        assert!(is_valid_unicode_range("U+0000-00FF, U+0131, U+04??"));
        assert!(!is_valid_unicode_range(""));
        assert!(!is_valid_unicode_range("U+0000-00FF; } body { color: red"));
        assert!(!is_valid_unicode_range("url(x)"));
    }

    #[test]
    fn checks_the_woff2_signature() {
        assert!(is_woff2(WOFF2));
        assert!(!is_woff2(b"<html>"));
        assert!(!is_woff2(b"wOF"));
    }

    #[test]
    fn installs_each_distinct_file_once_and_writes_the_manifest_last() {
        let root = scratch("install");
        let fake = Fake::new().with(&roboto_css_url(), vec![Ok(CSS.as_bytes().to_vec())]).roboto_files();
        let mut seen = Vec::new();
        let manifest = install(&root, roboto(), &fake, &NO_WAIT, &mut |done, total| seen.push((done, total)), &mut || {}).unwrap();

        // Two distinct URLs (a variable font serves 400 and 700 from one file).
        assert_eq!(fake.asked.borrow().len(), 3, "{:?}", fake.asked.borrow());
        assert_eq!(seen, [(0, 2), (1, 2), (2, 2)]);
        assert_eq!(manifest.family, "Roboto");
        assert_eq!(manifest.files.len(), 4);
        let dir = root.join("roboto");
        for f in &manifest.files {
            assert!(dir.join(&f.file).is_file(), "{}", f.file);
            assert!(f.file.ends_with(".woff2") && !f.file.contains('/'));
        }
        assert!(dir.join(MANIFEST).is_file());
        let names: Vec<_> = std::fs::read_dir(&dir).unwrap().flatten().map(|e| e.file_name().into_string().unwrap()).collect();
        assert!(names.iter().all(|n| !n.starts_with('.')), "a temp file survived: {names:?}");
        assert_eq!(list(&root), vec![manifest.clone()]);
        assert_eq!(read_manifest(&root, roboto()), Some(manifest));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn an_installed_family_is_not_downloaded_again() {
        let root = scratch("once");
        let fake = Fake::new().with(&roboto_css_url(), vec![Ok(CSS.as_bytes().to_vec())]).roboto_files();
        run(&root, roboto(), &fake).unwrap();
        let asked = fake.asked.borrow().len();
        run(&root, roboto(), &fake).unwrap();
        assert_eq!(fake.asked.borrow().len(), asked);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn retries_a_transient_failure_and_a_server_error() {
        let root = scratch("retry");
        let fake = Fake::new()
            .with(&roboto_css_url(), vec![Err(FetchError::Transient("timed out".into())), Err(FetchError::Status(503)), Ok(CSS.as_bytes().to_vec())])
            .roboto_files();
        assert!(run(&root, roboto(), &fake).is_ok());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn gives_up_after_the_retries_and_leaves_nothing_behind() {
        let root = scratch("giveup");
        let fake = Fake::new()
            .with(&roboto_css_url(), vec![Ok(CSS.as_bytes().to_vec())])
            .with("https://fonts.gstatic.com/s/roboto/v47/KFO7CnqEu92Fr1ME7kSn66aGLdTylUAMa3-UBGEe.woff2", vec![Ok(WOFF2.to_vec())])
            .with("https://fonts.gstatic.com/s/roboto/v47/KFO7CnqEu92Fr1ME7kSn66aGLdTylUAMa3yUBA.woff2", vec![Err(FetchError::Transient("reset".into()))]);
        let err = run(&root, roboto(), &fake).unwrap_err();
        assert_eq!(err.code(), "E_FONT_NETWORK");
        assert!(!root.join("roboto").exists(), "a half-installed family stayed");
        assert!(list(&root).is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_refused_weight_list_falls_back_to_the_default_face() {
        let root = scratch("fallback");
        let fake = Fake::new()
            .with(&roboto_css_url(), vec![Err(FetchError::Status(400))])
            .with(&css2_url("Roboto", &[]), vec![Ok(CSS.as_bytes().to_vec())])
            .roboto_files();
        let manifest = run(&root, roboto(), &fake).unwrap();
        assert!(manifest.files.iter().all(|f| f.weight == 400), "{:?}", manifest.files);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_not_found_is_not_retried() {
        let root = scratch("404");
        let fake = Fake::new().with(&roboto_css_url(), vec![Err(FetchError::Status(404))]);
        assert_eq!(run(&root, roboto(), &fake).unwrap_err(), FontError::Refused(404));
        assert_eq!(fake.asked.borrow().len(), 1);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn refuses_a_file_that_is_not_woff2_or_too_big() {
        for (body, tag) in [(b"<html>blocked</html>".to_vec(), "html"), (vec![b'w'; MAX_FILE_BYTES + 1], "big")] {
            let root = scratch(tag);
            let fake = Fake::new()
                .with(&roboto_css_url(), vec![Ok(CSS.as_bytes().to_vec())])
                .with("https://fonts.gstatic.com/s/roboto/v47/KFO7CnqEu92Fr1ME7kSn66aGLdTylUAMa3-UBGEe.woff2", vec![Ok(body)]);
            assert_eq!(run(&root, roboto(), &fake).unwrap_err().code(), "E_FONT_INVALID", "{tag}");
            assert!(!root.join("roboto").exists());
            let _ = std::fs::remove_dir_all(&root);
        }
    }

    #[test]
    fn a_stylesheet_with_no_usable_face_is_invalid() {
        let root = scratch("empty");
        let fake = Fake::new().with(&roboto_css_url(), vec![Ok(b"/* nothing */".to_vec())]);
        assert_eq!(run(&root, roboto(), &fake).unwrap_err().code(), "E_FONT_INVALID");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn list_skips_partial_foreign_and_tampered_directories() {
        let root = scratch("list");
        let fake = Fake::new().with(&roboto_css_url(), vec![Ok(CSS.as_bytes().to_vec())]).roboto_files();
        run(&root, roboto(), &fake).unwrap();
        // No manifest: a download cut off by a quit.
        std::fs::create_dir_all(root.join("lato")).unwrap();
        std::fs::write(root.join("lato").join("latin-400.woff2"), WOFF2).unwrap();
        // A manifest for a family not in the catalogue.
        std::fs::create_dir_all(root.join("evil")).unwrap();
        std::fs::write(root.join("evil").join(MANIFEST), r#"{"family":"Evil","category":"sans","files":[],"bytes":0}"#).unwrap();
        // A manifest naming a file outside its directory.
        let dir = root.join("lora");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join(MANIFEST),
            r#"{"family":"Lora","category":"serif","files":[{"file":"../roboto/manifest.json","weight":400,"style":"normal","subset":"latin","unicodeRange":"U+0000-00FF"}],"bytes":1}"#,
        )
        .unwrap();
        let names: Vec<_> = list(&root).into_iter().map(|m| m.family).collect();
        assert_eq!(names, ["Roboto"]);
        assert!(read_files(&root, find("Lora").unwrap()).is_none());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_family_whose_file_went_missing_is_not_installed() {
        let root = scratch("missing");
        let fake = Fake::new().with(&roboto_css_url(), vec![Ok(CSS.as_bytes().to_vec())]).roboto_files();
        let manifest = run(&root, roboto(), &fake).unwrap();
        std::fs::remove_file(root.join("roboto").join(&manifest.files[0].file)).unwrap();
        assert!(list(&root).is_empty());
        assert!(read_manifest(&root, roboto()).is_none());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn reads_and_removes_an_installed_family() {
        let root = scratch("read");
        let fake = Fake::new().with(&roboto_css_url(), vec![Ok(CSS.as_bytes().to_vec())]).roboto_files();
        run(&root, roboto(), &fake).unwrap();
        let files = read_files(&root, roboto()).unwrap();
        assert_eq!(files.len(), 4);
        assert!(files.iter().all(|(_, bytes)| bytes == WOFF2));
        assert!(remove(&root, roboto()).unwrap());
        assert!(!root.join("roboto").exists());
        assert!(!remove(&root, roboto()).unwrap());
        assert!(read_files(&root, roboto()).is_none());
        let _ = std::fs::remove_dir_all(&root);
    }
}
