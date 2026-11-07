//! Files the user picked to attach to an outgoing mail. The shell copies each pick into
//! `<cache>/out/<16 hex>/<name>` and gives the page only the handle `out/<16 hex>/<name>`, relative
//! to the cache dir; the page hands that handle back with a draft. Before the engine reads one, it
//! checks the handle here: the page is not trusted to name a file.

use std::fs;
use std::path::{Path, PathBuf};

/// The file a handle names, checked. Spelled exactly `out/<dir>/<name>` with `/` separators: three
/// non-empty components, none `.` or `..`, no `\`, `:` or NUL anywhere (so no absolute path, drive
/// or other root on any platform). The file must exist as a regular file (not a symlink) and,
/// once canonicalised, sit two levels under the canonical `<cache>/out`. Returns the canonical path.
pub fn resolve_outgoing(cache_dir: &Path, handle: &str) -> Result<PathBuf, String> {
    let bad = || "not an outgoing attachment".to_string();
    if handle.contains(['\\', ':', '\0']) {
        return Err(bad());
    }
    let parts: Vec<&str> = handle.split('/').collect();
    let ["out", dir, name] = parts.as_slice() else { return Err(bad()) };
    if [dir, name].iter().any(|c| c.is_empty() || **c == "." || **c == "..") {
        return Err(bad());
    }
    let out = cache_dir.join("out");
    let path = out.join(dir).join(name);
    let meta = fs::symlink_metadata(&path).map_err(|_| "the attachment is gone".to_string())?;
    if !meta.file_type().is_file() {
        return Err(bad());
    }
    let real = fs::canonicalize(&path).map_err(|_| "the attachment is gone".to_string())?;
    let real_out = fs::canonicalize(&out).map_err(|_| bad())?;
    if real.parent().and_then(Path::parent) != Some(real_out.as_path()) {
        return Err(bad());
    }
    Ok(real)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cache() -> (tempfile::TempDir, PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let cache = tmp.path().join("cache");
        fs::create_dir_all(cache.join("out").join("ab")).unwrap();
        fs::write(cache.join("out").join("ab").join("x.pdf"), b"%PDF-1.4 out").unwrap();
        fs::create_dir_all(cache.join("att")).unwrap();
        fs::write(cache.join("att").join("x"), b"incoming").unwrap();
        (tmp, cache)
    }

    #[test]
    fn an_outgoing_handle_resolves_only_under_cache_out() {
        let (_tmp, cache) = cache();
        let ok = resolve_outgoing(&cache, "out/ab/x.pdf").unwrap();
        assert_eq!(fs::read(&ok).unwrap(), b"%PDF-1.4 out");
        assert!(ok.ends_with("out/ab/x.pdf"));
        for bad in [
            "../att/x",
            "out/../../etc",
            "out/../att/x",
            "/etc/passwd",
            "/out/ab/x.pdf",
            "out/ab/",
            "out/ab",
            "out//x.pdf",
            "out/./x.pdf",
            "out/ab/./x.pdf",
            "out/ab/x.pdf/",
            "out\\ab\\x.pdf",
            "C:out/ab/x.pdf",
            "att/ab/x.pdf",
            "out/ab/x.pdf\0",
            "",
        ] {
            assert!(resolve_outgoing(&cache, bad).is_err(), "{bad:?} was accepted");
        }
        // Absolute paths are refused even when they point at the very file.
        let abs = cache.join("out").join("ab").join("x.pdf");
        assert!(resolve_outgoing(&cache, abs.to_str().unwrap()).is_err());
    }

    #[test]
    fn a_missing_or_non_file_handle_is_refused() {
        let (_tmp, cache) = cache();
        assert!(resolve_outgoing(&cache, "out/ab/missing.pdf").is_err());
        fs::create_dir_all(cache.join("out").join("ab").join("dir")).unwrap();
        assert!(resolve_outgoing(&cache, "out/ab/dir").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_under_out_is_refused() {
        let (_tmp, cache) = cache();
        let secret = cache.join("att").join("x");
        std::os::unix::fs::symlink(&secret, cache.join("out").join("ab").join("link.pdf")).unwrap();
        assert!(resolve_outgoing(&cache, "out/ab/link.pdf").is_err());
        // A directory symlinked out of `out/` does not count either.
        std::os::unix::fs::symlink(cache.join("att"), cache.join("out").join("cd")).unwrap();
        assert!(resolve_outgoing(&cache, "out/cd/x").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn a_cache_dir_behind_a_symlink_still_resolves() {
        // iOS: /var -> /private/var.
        let (tmp, cache) = cache();
        let alias = tmp.path().join("alias");
        std::os::unix::fs::symlink(&cache, &alias).unwrap();
        assert!(resolve_outgoing(&alias, "out/ab/x.pdf").is_ok());
    }
}
