//! Which update feed a build follows, and whether an offered version replaces
//! the installed one. Shared by Sparkle (macOS) and tauri-plugin-updater
//! (Windows, Linux) so both platforms apply one rule.

/// A saved `updateTrack` wins. Anything else (unset, or a value from an older
/// or newer catalogue) follows the build: a nightly build follows nightlies.
pub fn follows_nightly(track: Option<&str>, app_version: &str) -> bool {
    match track {
        Some("nightly") => true,
        Some("stable") => false,
        _ => app_version.contains("-nightly"),
    }
}

/// Whether `offered` should replace `installed`.
///
/// Mirrors Sparkle's order on macOS, where a nightly's CFBundleVersion is
/// `x.y.z.YYYYMMDD.HHMM`: within one `x.y.z` a stable release ranks 0, a dated
/// nightly (`x.y.z-nightly.YYYYMMDDHHMM.g<sha>`) ranks by its stamp, and any
/// other prerelease (the undated `x.y.z-nightly.<sha>` builds before the stamp
/// existed) ranks just above stable. So a nightly beats the stable it was built
/// from and loses to the next stable. Plain semver would do the opposite: it
/// ranks `2.16.0-nightly` below `2.16.0` and orders nightlies by commit hash.
pub fn is_newer(installed: &str, offered: &str) -> bool {
    match (rank(installed), rank(offered)) {
        (Some(installed), Some(offered)) => offered > installed,
        _ => false,
    }
}

fn rank(version: &str) -> Option<(u64, u64, u64, u64)> {
    let version = version.split('+').next()?;
    let (core, pre) = match version.split_once('-') {
        Some((core, pre)) => (core, Some(pre)),
        None => (version, None),
    };
    let mut parts = core.split('.').map(|p| p.parse::<u64>().ok());
    let (major, minor, patch) = (parts.next()??, parts.next()??, parts.next()??);
    if parts.next().is_some() {
        return None;
    }
    let stamp = match pre {
        None => 0,
        Some(pre) => pre
            .strip_prefix("nightly.")
            .and_then(|rest| rest.split('.').next())
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(1),
    };
    Some((major, minor, patch, stamp))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_explicit_track_wins_over_the_build() {
        assert!(follows_nightly(Some("nightly"), "2.12.0"));
        assert!(!follows_nightly(Some("stable"), "2.12.0-nightly.202609240647.gabc1234"));
    }

    #[test]
    fn with_no_choice_the_build_picks_its_track() {
        assert!(follows_nightly(None, "2.12.0-nightly.abc1234"));
        assert!(!follows_nightly(None, "2.12.0"));
        assert!(!follows_nightly(Some("beta"), "2.12.0"));
    }

    #[test]
    fn nightlies_order_by_their_stamp_not_their_hash() {
        assert!(is_newer("2.16.0-nightly.202609240647.gfff0000", "2.16.0-nightly.202609250647.g0000000"));
        assert!(!is_newer("2.16.0-nightly.202609250647.g0000000", "2.16.0-nightly.202609240647.gfff0000"));
        assert!(!is_newer("2.16.0-nightly.202609240647.gabc1234", "2.16.0-nightly.202609240647.gabc1234"));
    }

    #[test]
    fn a_nightly_beats_its_base_stable_and_loses_to_the_next() {
        // Stable user switching to nightly gets one.
        assert!(is_newer("2.16.0", "2.16.0-nightly.202609240647.gabc1234"));
        // Nightly user on the stable track is not moved back to older code...
        assert!(!is_newer("2.16.0-nightly.202609240647.gabc1234", "2.16.0"));
        // ...until a newer stable ships.
        assert!(is_newer("2.16.0-nightly.202609240647.gabc1234", "2.17.0"));
        assert!(!is_newer("2.17.0", "2.16.0-nightly.202612010000.gabc1234"));
    }

    #[test]
    fn an_undated_nightly_ranks_between_stable_and_any_dated_nightly() {
        assert!(is_newer("2.16.0-nightly.0835eb4", "2.16.0-nightly.202609250647.gabc1234"));
        assert!(!is_newer("2.16.0-nightly.0835eb4", "2.16.0"));
        assert!(is_newer("2.16.0", "2.16.0-nightly.0835eb4"));
    }

    #[test]
    fn stable_releases_compare_numerically() {
        assert!(is_newer("2.9.0", "2.10.0"));
        assert!(!is_newer("2.10.0", "2.9.0"));
        assert!(!is_newer("2.15.0", "2.15.0"));
    }

    #[test]
    fn an_unreadable_version_never_offers_an_update() {
        assert!(!is_newer("2.15.0", "garbage"));
        assert!(!is_newer("garbage", "2.15.0"));
        assert!(!is_newer("2.15", "2.16.0"));
    }
}
