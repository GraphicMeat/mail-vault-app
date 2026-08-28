//! Finding the spelling dictionaries WebKitGTK will actually use.
//!
//! macOS and Windows carry a system checker, so this only matters on Linux —
//! but the logic is plain filesystem and string work, and it is tested
//! everywhere rather than only on the platform that runs it.
//!
//! WebKitGTK looks words up through enchant, so **enchant's own answer is the
//! only one that matches what the user will see**. A directory scan can find a
//! dictionary in a place enchant does not consult and promise underlines that
//! never appear; it is the fallback for a system without the enchant CLI, not
//! the first question.

use std::path::PathBuf;

/// Where enchant's hunspell backend looks, plus `$SNAP` for a copy staged
/// inside a confined snap, where the absolute paths below belong to the base
/// snap rather than to us. Order is search order.
pub fn dictionary_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();

    // DICPATH is hunspell's own override, and the one lever a user has.
    if let Some(p) = std::env::var_os("DICPATH") {
        dirs.extend(std::env::split_paths(&p));
    }
    if let Some(home) = std::env::var_os("XDG_DATA_HOME") {
        dirs.push(PathBuf::from(home).join("hunspell"));
    } else if let Some(home) = dirs::home_dir() {
        dirs.push(home.join(".local/share/hunspell"));
    }
    if let Some(snap) = std::env::var_os("SNAP") {
        let snap = PathBuf::from(snap);
        dirs.push(snap.join("usr/share/hunspell"));
        dirs.push(snap.join("usr/share/myspell/dicts"));
    }
    dirs.push(PathBuf::from("/usr/share/hunspell"));
    dirs.push(PathBuf::from("/usr/share/myspell/dicts"));
    dirs.push(PathBuf::from("/usr/share/myspell"));
    dirs.push(PathBuf::from("/usr/local/share/hunspell"));
    dirs
}

/// Hunspell dictionaries are `<tag>.dic`. The same directories also hold
/// hyphenation (`hyph_*`) and thesaurus (`th_*`) files, which are not
/// dictionaries and must never be offered as languages.
pub fn scan(dirs: &[PathBuf]) -> Vec<String> {
    let mut tags: Vec<String> = Vec::new();
    for dir in dirs {
        let Ok(entries) = std::fs::read_dir(dir) else { continue };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            let Some(tag) = name.strip_suffix(".dic") else { continue };
            if tag.is_empty() || tag.starts_with("hyph_") || tag.starts_with("th_") {
                continue;
            }
            if !tags.iter().any(|t| t == tag) {
                tags.push(tag.to_string());
            }
        }
    }
    tags.sort();
    tags
}

/// `enchant-lsmod-2 -list-dicts` prints one dictionary per line, as
/// `en_US (Hunspell)`. `None` means the tool is not installed — which is not
/// the same answer as "no dictionaries", so the caller falls back to `scan`
/// rather than reporting an empty list.
pub fn ask_enchant() -> Option<Vec<String>> {
    for bin in ["enchant-lsmod-2", "enchant-lsmod"] {
        let Ok(out) = std::process::Command::new(bin).arg("-list-dicts").output() else { continue };
        if !out.status.success() {
            continue;
        }
        return Some(parse_lsmod(&String::from_utf8_lossy(&out.stdout)));
    }
    None
}

pub fn parse_lsmod(stdout: &str) -> Vec<String> {
    let mut tags: Vec<String> = stdout
        .lines()
        .filter_map(|l| l.split_whitespace().next())
        .filter(|t| !t.is_empty())
        .map(|t| t.to_string())
        .collect();
    tags.sort();
    tags.dedup();
    tags
}

/// Every dictionary available, enchant's answer preferred over a disk scan.
pub fn available() -> Vec<String> {
    ask_enchant().unwrap_or_else(|| scan(&dictionary_dirs()))
}

/// What to hand WebKitGTK. The locale's own dictionary first when it is
/// installed — a checker that accepts every word in five languages is not far
/// off no checker at all — and everything found otherwise, so a user whose
/// `LANG` says nothing useful still gets underlines.
pub fn preferred_languages(found: &[String]) -> Vec<String> {
    let locale = std::env::var("LC_ALL")
        .or_else(|_| std::env::var("LC_MESSAGES"))
        .or_else(|_| std::env::var("LANG"))
        .unwrap_or_default();
    let locale = locale.split('.').next().unwrap_or("").replace('-', "_");
    if !locale.is_empty() {
        if let Some(exact) = found.iter().find(|t| t.eq_ignore_ascii_case(&locale)) {
            return vec![exact.clone()];
        }
        if let Some(lang) = locale.split('_').next().filter(|l| !l.is_empty()) {
            let prefix = format!("{}_", lang).to_lowercase();
            if let Some(same) = found
                .iter()
                .find(|t| t.eq_ignore_ascii_case(lang) || t.to_lowercase().starts_with(&prefix))
            {
                return vec![same.clone()];
            }
        }
    }
    found.to_vec()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn scan_reads_dic_files_and_skips_hyphenation_and_thesaurus() {
        let dir = tempfile::tempdir().unwrap();
        for f in ["en_US.dic", "en_US.aff", "lt_LT.dic", "hyph_en_US.dic", "th_en_US_v2.dic", "README"] {
            fs::write(dir.path().join(f), "x").unwrap();
        }
        assert_eq!(scan(&[dir.path().to_path_buf()]), vec!["en_US", "lt_LT"]);
    }

    #[test]
    fn scan_of_a_missing_directory_is_empty_not_an_error() {
        assert!(scan(&[PathBuf::from("/nonexistent/hunspell")]).is_empty());
    }

    #[test]
    fn scan_dedupes_a_tag_that_two_directories_both_carry() {
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        fs::write(a.path().join("en_US.dic"), "x").unwrap();
        fs::write(b.path().join("en_US.dic"), "x").unwrap();
        assert_eq!(scan(&[a.path().to_path_buf(), b.path().to_path_buf()]), vec!["en_US"]);
    }

    #[test]
    fn parse_lsmod_takes_the_tag_and_drops_the_provider() {
        let out = "en_US (Hunspell)\nlt_LT (Hunspell)\nen_US (AppleSpell)\n\n";
        assert_eq!(parse_lsmod(out), vec!["en_US", "lt_LT"]);
    }

    #[test]
    fn preferred_languages_picks_the_locale_then_its_language_then_everything() {
        let found: Vec<String> = ["de_DE", "en_GB", "en_US"].iter().map(|s| s.to_string()).collect();

        std::env::set_var("LC_ALL", "en_GB.UTF-8");
        assert_eq!(preferred_languages(&found), vec!["en_GB"]);

        // A locale with no exact dictionary falls back to the same language.
        std::env::set_var("LC_ALL", "en_IE.UTF-8");
        assert_eq!(preferred_languages(&found), vec!["en_GB"]);

        // A locale with nothing installed checks against everything found,
        // rather than silently checking against nothing.
        std::env::set_var("LC_ALL", "lt_LT.UTF-8");
        assert_eq!(preferred_languages(&found), found);

        std::env::remove_var("LC_ALL");
    }
}
