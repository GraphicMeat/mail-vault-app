//! Handing a cached attachment to the system previewer or share sheet. The engine's cache file is
//! `<cache>/att/<64 hex>` with no extension; QuickLook, Android viewers and share targets need a
//! real name. So the shell checks that the path JS sent really is one of those cache files, then
//! puts a named link (or copy) of it in a fresh per-open directory under `<cache>/share/`, which is
//! the only directory the Android FileProvider exposes. The directory is removed when the
//! previewer or sheet closes (iOS) or by a later sweep (Android has no close callback).

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Why a path was refused.
#[derive(Debug, PartialEq, Eq)]
pub enum PathError {
    /// Not a finished file of the attachment cache.
    Invalid(&'static str),
    /// Was one, but is gone (evicted): fetch again.
    Gone,
}

/// The cache file JS named, checked: `given` must be `<att_dir>/<64 lowercase hex>` spelled
/// exactly so (no `..`, no other directory), a regular file and not a symlink, and must resolve
/// inside `att_dir` once both are canonicalised. Returns the canonical path.
pub fn validate_cache_file(given: &Path, att_dir: &Path) -> Result<PathBuf, PathError> {
    if !given.is_absolute() {
        return Err(PathError::Invalid("not absolute"));
    }
    let (Some(parent), Some(name)) = (given.parent(), given.file_name().and_then(|n| n.to_str())) else {
        return Err(PathError::Invalid("no file name"));
    };
    if parent != att_dir {
        return Err(PathError::Invalid("not in the attachment cache"));
    }
    if !(name.len() == 64 && name.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))) {
        return Err(PathError::Invalid("not a cache file name"));
    }
    let meta = match fs::symlink_metadata(given) {
        Ok(m) => m,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Err(PathError::Gone),
        Err(_) => return Err(PathError::Invalid("unreadable")),
    };
    if !meta.file_type().is_file() {
        return Err(PathError::Invalid("not a regular file"));
    }
    let real = fs::canonicalize(given).map_err(|_| PathError::Gone)?;
    let real_dir = fs::canonicalize(att_dir).map_err(|_| PathError::Invalid("no attachment cache"))?;
    if real.parent() != Some(real_dir.as_path()) {
        return Err(PathError::Invalid("outside the attachment cache"));
    }
    Ok(real)
}

/// Longest name we hand out, in bytes (filesystems allow 255; leave room).
pub const MAX_NAME_BYTES: usize = 120;
const MAX_EXT_CHARS: usize = 10;

/// A filename from the attachment's metadata made safe to create and to show: path separators,
/// control and bidi-override characters taken out, no leading dots or spaces, no trailing dots or
/// spaces, at most [`MAX_NAME_BYTES`] bytes with the extension kept. An empty result becomes
/// `attachment` plus the extension the MIME type implies; a name with no extension gets that
/// extension too.
pub fn sanitize_filename(name: &str, mime: &str) -> String {
    let cleaned: String = name
        .chars()
        .filter(|c| !c.is_control() && !is_bidi_control(*c))
        .map(|c| if matches!(c, '/' | '\\' | ':' | '\0') { '_' } else { c })
        .collect();
    let trimmed = cleaned.trim_start_matches(|c: char| c == '.' || c.is_whitespace());
    let trimmed = trimmed.trim_end_matches(|c: char| c == '.' || c.is_whitespace());

    let (stem, ext) = split_ext(trimmed);
    let mime_ext = ext_for_mime(mime);
    // When the name's extension and the MIME type disagree, the MIME type's extension is appended:
    // QuickLook (iOS) picks by extension and Android by MIME type, so both now see the same type.
    let (stem, ext) = match (ext, mime_ext) {
        (Some(e), Some(m)) if !same_ext(e, m) => (trimmed, Some(m.to_string())),
        (Some(e), _) => (stem, Some(e.to_string())),
        (None, m) => (stem, m.map(str::to_string)),
    };
    let stem = if stem.trim().is_empty() { "attachment" } else { stem };
    let suffix = ext.map(|e| format!(".{e}")).unwrap_or_default();
    let room = MAX_NAME_BYTES.saturating_sub(suffix.len());
    let mut out = String::new();
    for c in stem.chars() {
        if out.len() + c.len_utf8() > room {
            break;
        }
        out.push(c);
    }
    let out = out.trim_end_matches(|c: char| c == '.' || c.is_whitespace());
    let out = if out.is_empty() { "attachment" } else { out };
    format!("{out}{suffix}")
}

/// `name` split at its last dot when what follows is a plausible extension (1 to 10 letters or
/// digits) and something comes before it.
fn split_ext(name: &str) -> (&str, Option<&str>) {
    if let Some(i) = name.rfind('.') {
        let (stem, ext) = (&name[..i], &name[i + 1..]);
        if !stem.trim().is_empty()
            && (1..=MAX_EXT_CHARS).contains(&ext.chars().count())
            && ext.chars().all(|c| c.is_ascii_alphanumeric())
        {
            return (stem, Some(ext));
        }
    }
    (name, None)
}

/// Characters that change or hide what the name shows: bidi controls, zero-width characters, the
/// word joiner, the BOM, the Mongolian vowel separator, and line/paragraph separators.
fn is_bidi_control(c: char) -> bool {
    matches!(
        c,
        '\u{200B}'..='\u{200F}'
            | '\u{061C}'
            | '\u{180E}'
            | '\u{2028}'..='\u{202E}'
            | '\u{2060}'..='\u{2064}'
            | '\u{2066}'..='\u{2069}'
            | '\u{FEFF}'
    )
}

/// The same type under two spellings counts as agreeing.
fn same_ext(name_ext: &str, mime_ext: &str) -> bool {
    let norm = |e: &str| match e.to_ascii_lowercase().as_str() {
        "jpeg" | "jpe" => "jpg".to_string(),
        "htm" => "html".to_string(),
        "text" => "txt".to_string(),
        "mpga" => "mp3".to_string(),
        other => other.to_string(),
    };
    norm(name_ext) == norm(mime_ext)
}

/// The extension for a few common types; None for anything else.
pub fn ext_for_mime(mime: &str) -> Option<&'static str> {
    Some(match sanitize_mime(mime).as_str() {
        "application/pdf" => "pdf",
        "image/jpeg" => "jpg",
        "image/png" => "png",
        "image/gif" => "gif",
        "image/heic" => "heic",
        "image/webp" => "webp",
        "text/plain" => "txt",
        "text/html" => "html",
        "text/csv" => "csv",
        "text/calendar" => "ics",
        "application/zip" => "zip",
        "application/msword" => "doc",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document" => "docx",
        "application/vnd.ms-excel" => "xls",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" => "xlsx",
        "application/vnd.ms-powerpoint" => "ppt",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation" => "pptx",
        "message/rfc822" => "eml",
        "audio/mpeg" => "mp3",
        "video/mp4" => "mp4",
        _ => return None,
    })
}

/// `type/subtype` in lower case from RFC 6838 restricted-name characters, parameters dropped;
/// anything else is `application/octet-stream`.
pub fn sanitize_mime(mime: &str) -> String {
    let base = mime.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    let ok_part = |s: &str| {
        !s.is_empty()
            && s.len() <= 127
            && s.bytes().all(|b| b.is_ascii_alphanumeric() || b"!#$&^_.+-".contains(&b))
    };
    match base.split_once('/') {
        Some((t, s)) if ok_part(t) && ok_part(s) => base,
        _ => "application/octet-stream".to_string(),
    }
}

static COUNTER: AtomicU64 = AtomicU64::new(0);

/// A new, empty directory under `share_root` (created if missing) that no other open uses.
pub fn new_stage_dir(share_root: &Path) -> io::Result<PathBuf> {
    fs::create_dir_all(share_root)?;
    for _ in 0..16 {
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = share_root.join(format!("{:x}-{:x}-{n:x}", nanos, std::process::id()));
        match fs::create_dir(&dir) {
            Ok(()) => return Ok(dir),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        }
    }
    Err(io::Error::new(io::ErrorKind::AlreadyExists, "no free stage directory"))
}

/// `src` under `name` in a fresh directory of `share_root`: a hard link when the filesystem allows
/// one (no copy, and the cache can evict its own name meanwhile), else a copy. Returns the file.
pub fn stage(src: &Path, name: &str, share_root: &Path) -> io::Result<PathBuf> {
    let dir = new_stage_dir(share_root)?;
    let target = dir.join(name);
    let made = fs::hard_link(src, &target).or_else(|_| fs::copy(src, &target).map(|_| ()));
    if let Err(e) = made {
        let _ = fs::remove_dir_all(&dir);
        return Err(e);
    }
    Ok(target)
}

/// Removes the per-open directory holding `staged` (the file's parent), if it is a direct child of
/// `share_root`. Never touches anything else.
pub fn unstage(staged: &Path, share_root: &Path) {
    if let Some(dir) = staged.parent() {
        if dir.parent() == Some(share_root) {
            let _ = fs::remove_dir_all(dir);
        }
    }
}

/// Removes per-open directories under `share_root` last changed more than `older_than` ago (all of
/// them for `Duration::ZERO`). Returns how many went.
pub fn sweep(share_root: &Path, older_than: Duration) -> usize {
    let Ok(entries) = fs::read_dir(share_root) else { return 0 };
    let now = SystemTime::now();
    let mut removed = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(meta) = fs::symlink_metadata(&path) else { continue };
        let age = meta.modified().ok().and_then(|t| now.duration_since(t).ok()).unwrap_or(Duration::ZERO);
        if age < older_than {
            continue;
        }
        let gone = if meta.is_dir() { fs::remove_dir_all(&path) } else { fs::remove_file(&path) };
        if gone.is_ok() {
            removed += 1;
        }
    }
    removed
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fresh temp directory per test, removed on drop.
    struct Tmp(PathBuf);
    impl Tmp {
        fn new(tag: &str) -> Tmp {
            let dir = new_stage_dir(&std::env::temp_dir().join("mv-native-tests")).unwrap();
            let dir = dir.join(tag);
            fs::create_dir_all(&dir).unwrap();
            Tmp(dir)
        }
    }
    impl Drop for Tmp {
        fn drop(&mut self) {
            if let Some(p) = self.0.parent() {
                let _ = fs::remove_dir_all(p);
            }
        }
    }

    const HASH: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    fn cache(t: &Tmp) -> (PathBuf, PathBuf) {
        let att = t.0.join("att");
        fs::create_dir_all(&att).unwrap();
        let file = att.join(HASH);
        fs::write(&file, b"%PDF-1.4 test").unwrap();
        (att, file)
    }

    #[test]
    fn a_cache_file_is_accepted() {
        let t = Tmp::new("ok");
        let (att, file) = cache(&t);
        let real = validate_cache_file(&file, &att).unwrap();
        assert_eq!(fs::read(real).unwrap(), b"%PDF-1.4 test");
    }

    #[test]
    fn paths_outside_the_cache_are_refused() {
        let t = Tmp::new("out");
        let (att, _) = cache(&t);
        let outside = t.0.join(HASH);
        fs::write(&outside, b"secret").unwrap();
        assert!(matches!(validate_cache_file(&outside, &att), Err(PathError::Invalid(_))));
        // `..` that lands back in the cache is still refused: the spelling must be exact.
        let dotted = att.join("..").join("att").join(HASH);
        assert!(matches!(validate_cache_file(&dotted, &att), Err(PathError::Invalid(_))));
        let up = att.join("..").join(HASH);
        assert!(matches!(validate_cache_file(&up, &att), Err(PathError::Invalid(_))));
        assert!(matches!(validate_cache_file(Path::new(HASH), &att), Err(PathError::Invalid(_))));
        assert!(matches!(validate_cache_file(Path::new("/etc/passwd"), &att), Err(PathError::Invalid(_))));
    }

    #[test]
    fn only_finished_cache_names_count() {
        let t = Tmp::new("names");
        let (att, _) = cache(&t);
        for name in [
            format!("{HASH}.part"),
            format!("{HASH}.part.meta"),
            HASH.to_uppercase(),
            HASH[..63].to_string(),
            "mobile.db".to_string(),
        ] {
            let p = att.join(&name);
            fs::write(&p, b"x").unwrap();
            assert!(matches!(validate_cache_file(&p, &att), Err(PathError::Invalid(_))), "{name}");
        }
    }

    #[test]
    fn a_missing_file_is_gone() {
        let t = Tmp::new("gone");
        let (att, file) = cache(&t);
        fs::remove_file(&file).unwrap();
        assert_eq!(validate_cache_file(&file, &att), Err(PathError::Gone));
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_are_refused() {
        let t = Tmp::new("link");
        let (att, file) = cache(&t);
        fs::remove_file(&file).unwrap();
        let target = t.0.join("private.db");
        fs::write(&target, b"secret").unwrap();
        std::os::unix::fs::symlink(&target, &file).unwrap();
        assert!(matches!(validate_cache_file(&file, &att), Err(PathError::Invalid(_))));
        // A directory under a cache name is not a file either.
        fs::remove_file(&file).unwrap();
        fs::create_dir(&file).unwrap();
        assert!(matches!(validate_cache_file(&file, &att), Err(PathError::Invalid(_))));
    }

    #[cfg(unix)]
    #[test]
    fn a_cache_dir_symlinked_elsewhere_resolves_consistently() {
        // The real cache dir may sit behind a symlink (iOS /var -> /private/var): still accepted.
        let t = Tmp::new("dirlink");
        let (att, _) = cache(&t);
        let alias = t.0.join("alias");
        std::os::unix::fs::symlink(&att, &alias).unwrap();
        assert!(validate_cache_file(&alias.join(HASH), &alias).is_ok());
    }

    #[test]
    fn filenames_are_sanitised() {
        let pdf = "application/pdf";
        assert_eq!(sanitize_filename("Planting calendar 2027.pdf", pdf), "Planting calendar 2027.pdf");
        assert_eq!(sanitize_filename("../../etc/passwd", "text/plain"), "_.._etc_passwd.txt");
        assert_eq!(sanitize_filename("..\\..\\boot.ini", "text/plain"), "_.._boot.ini.txt");
        assert_eq!(sanitize_filename(".hidden.pdf", pdf), "hidden.pdf");
        assert_eq!(sanitize_filename("...", pdf), "attachment.pdf");
        assert_eq!(sanitize_filename("", pdf), "attachment.pdf");
        assert_eq!(sanitize_filename("   ", "application/x-unknown"), "attachment");
        assert_eq!(sanitize_filename("a\u{0}b\nc\td.pdf", pdf), "abcd.pdf");
        assert_eq!(sanitize_filename("invoice\u{202E}fdp.exe", pdf), "invoicefdp.exe.pdf");
        assert_eq!(sanitize_filename("report", pdf), "report.pdf");
        assert_eq!(sanitize_filename("report", "application/x-unknown"), "report");
        assert_eq!(sanitize_filename("C:report.pdf", pdf), "C_report.pdf");
        assert_eq!(sanitize_filename("trailing. . ", pdf), "trailing.pdf");
        assert_eq!(sanitize_filename(".pdf", pdf), "pdf.pdf");
    }

    #[test]
    fn invisible_characters_are_dropped() {
        let pdf = "application/pdf";
        for c in ['\u{200B}', '\u{200C}', '\u{200D}', '\u{2060}', '\u{FEFF}', '\u{180E}', '\u{2028}', '\u{2029}', '\u{202E}', '\u{2066}'] {
            assert_eq!(sanitize_filename(&format!("in{c}voice.pdf"), pdf), "invoice.pdf", "U+{:04X}", c as u32);
        }
    }

    // The name's extension decides what QuickLook shows (iOS), the MIME type what Android opens:
    // when they disagree, the MIME type's extension is appended, so both read the same type and
    // the name keeps what the sender called it. Equivalent spellings (jpeg/jpg, htm/html) agree.
    #[test]
    fn an_extension_that_disagrees_with_the_mime_type_gets_the_mime_one() {
        assert_eq!(sanitize_filename("invoice.pdf.exe", "application/pdf"), "invoice.pdf.exe.pdf");
        assert_eq!(sanitize_filename("report.html", "application/pdf"), "report.html.pdf");
        assert_eq!(sanitize_filename("Report.PDF", "application/pdf"), "Report.PDF");
        assert_eq!(sanitize_filename("photo.jpeg", "image/jpeg"), "photo.jpeg");
        assert_eq!(sanitize_filename("page.htm", "text/html"), "page.htm");
        // An unknown MIME type says nothing: the name's extension stays alone.
        assert_eq!(sanitize_filename("archive.7z", "application/x-7z-compressed"), "archive.7z");
        assert_eq!(sanitize_filename("archive.7z", "application/octet-stream"), "archive.7z");
        let long = sanitize_filename(&format!("{}.html", "a".repeat(300)), "application/pdf");
        assert!(long.len() <= MAX_NAME_BYTES && long.ends_with(".pdf"), "{long}");
    }

    #[test]
    fn long_names_keep_their_extension() {
        let name = format!("{}.pdf", "a".repeat(500));
        let out = sanitize_filename(&name, "application/pdf");
        assert!(out.len() <= MAX_NAME_BYTES, "{}", out.len());
        assert!(out.ends_with(".pdf"));
        // Multi-byte characters are never cut in half.
        let wide = format!("{}.docx", "Ž".repeat(300));
        let out = sanitize_filename(&wide, "");
        assert!(out.len() <= MAX_NAME_BYTES && out.ends_with(".docx") && out.starts_with('Ž'));
    }

    #[test]
    fn mime_types_are_checked() {
        assert_eq!(sanitize_mime("Application/PDF; name=x"), "application/pdf");
        assert_eq!(sanitize_mime("image/svg+xml"), "image/svg+xml");
        assert_eq!(sanitize_mime("text/html\r\nX: y"), "application/octet-stream");
        assert_eq!(sanitize_mime("nonsense"), "application/octet-stream");
        assert_eq!(sanitize_mime("*/*"), "application/octet-stream");
        assert_eq!(sanitize_mime(""), "application/octet-stream");
        assert_eq!(ext_for_mime("image/JPEG"), Some("jpg"));
        assert_eq!(ext_for_mime("application/x-unknown"), None);
    }

    #[test]
    fn staging_names_a_copy_and_unstage_removes_it() {
        let t = Tmp::new("stage");
        let (att, file) = cache(&t);
        let real = validate_cache_file(&file, &att).unwrap();
        let share = t.0.join("share");
        let a = stage(&real, "Calendar.pdf", &share).unwrap();
        let b = stage(&real, "Calendar.pdf", &share).unwrap();
        assert_ne!(a, b, "each open gets its own directory");
        assert_eq!(a.file_name().unwrap(), "Calendar.pdf");
        assert_eq!(fs::read(&a).unwrap(), b"%PDF-1.4 test");
        // The cache may evict its own name: the staged file stays readable.
        fs::remove_file(&file).unwrap();
        assert_eq!(fs::read(&b).unwrap(), b"%PDF-1.4 test");
        unstage(&a, &share);
        assert!(!a.exists() && !a.parent().unwrap().exists());
        assert!(b.exists());
        // Never outside share/.
        let stray = t.0.join("keep.txt");
        fs::write(&stray, b"x").unwrap();
        unstage(&stray, &share);
        assert!(stray.exists());
    }

    #[test]
    fn sweep_removes_only_old_directories() {
        let t = Tmp::new("sweep");
        let (att, file) = cache(&t);
        let real = validate_cache_file(&file, &att).unwrap();
        let share = t.0.join("share");
        let a = stage(&real, "a.pdf", &share).unwrap();
        assert_eq!(sweep(&share, Duration::from_secs(3600)), 0);
        assert!(a.exists());
        assert_eq!(sweep(&share, Duration::ZERO), 1);
        assert!(!a.exists());
        assert!(real.exists(), "the cache file is never swept");
        assert_eq!(sweep(&t.0.join("missing"), Duration::ZERO), 0);
    }
}
