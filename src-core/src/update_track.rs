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

/// One entry of GitHub's `GET /repos/{owner}/{repo}/releases`, the fields the
/// update dialog reads.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct GithubRelease {
    pub tag_name: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub published_at: Option<String>,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub draft: bool,
    #[serde(default)]
    pub prerelease: bool,
}

/// What the update dialog shows for one release.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseNote {
    pub version: String,
    pub name: String,
    pub published_at: String,
    pub body: String,
}

/// The published releases an update from `from` to `to` brings in, newest
/// first: after `from`, up to and including `to`, in the same order
/// `is_newer` uses. Drafts never; prereleases only when asked. A tag that is
/// not a version (the rolling `nightly` release) and an unreadable `from` or
/// `to` give nothing rather than every release.
pub fn release_notes_between(releases: Vec<GithubRelease>, from: &str, to: &str, include_prereleases: bool) -> Vec<ReleaseNote> {
    let (Some(from), Some(to)) = (rank(from), rank(to)) else {
        return Vec::new();
    };
    let mut kept: Vec<_> = releases
        .into_iter()
        .filter(|r| !r.draft && (include_prereleases || !r.prerelease))
        .filter_map(|r| {
            let version = r.tag_name.strip_prefix('v').unwrap_or(&r.tag_name).to_string();
            let at = rank(&version).filter(|at| *at > from && *at <= to)?;
            Some((at, ReleaseNote {
                version,
                name: r.name.unwrap_or_default(),
                published_at: r.published_at.unwrap_or_default(),
                body: r.body.unwrap_or_default(),
            }))
        })
        .collect();
    kept.sort_by(|a, b| b.0.cmp(&a.0));
    kept.into_iter().map(|(_, note)| note).collect()
}

/// The git ref a version was built from, for GitHub's compare API: a nightly
/// names its commit (`x.y.z-nightly.<stamp>.g<sha>`, or `x.y.z-nightly.<sha>`
/// from before the stamp), a release its `v` tag. Anything else has none.
pub fn git_ref(version: &str) -> Option<String> {
    rank(version)?;
    let version = version.split('+').next()?;
    match version.split_once("-nightly.") {
        Some((_, rest)) => rest
            .rsplit('.')
            .next()
            .map(|s| s.trim_start_matches('g'))
            .filter(|s| s.len() >= 7 && s.chars().all(|c| c.is_ascii_hexdigit()))
            .map(str::to_string),
        None if !version.contains('-') => Some(format!("v{version}")),
        None => None,
    }
}

/// GitHub's `GET /repos/{owner}/{repo}/compare/{base}...{head}`, the fields
/// the update dialog reads. `commits` is oldest first and capped at 250.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct GithubCompare {
    #[serde(default)]
    pub html_url: String,
    #[serde(default)]
    pub total_commits: usize,
    #[serde(default)]
    pub commits: Vec<GithubCommit>,
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct GithubCommit {
    pub sha: String,
    #[serde(default)]
    pub html_url: String,
    pub commit: GithubCommitDetail,
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct GithubCommitDetail {
    #[serde(default)]
    pub message: String,
    #[serde(default)]
    pub author: Option<GithubCommitAuthor>,
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct GithubCommitAuthor {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub date: String,
}

/// What the update dialog lists for one commit: its subject line only.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitNote {
    pub sha: String,
    pub subject: String,
    pub author: String,
    pub date: String,
    pub url: String,
}

/// The commits an update brings in, newest first. `total` can exceed the list
/// (GitHub stops at 250); `url` is the full comparison on github.com.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitLog {
    pub total: usize,
    pub url: String,
    pub commits: Vec<CommitNote>,
}

pub fn commit_log(compare: GithubCompare) -> CommitLog {
    let commits = compare
        .commits
        .into_iter()
        .rev()
        .map(|c| {
            let author = c.commit.author.unwrap_or(GithubCommitAuthor { name: String::new(), date: String::new() });
            CommitNote {
                sha: c.sha.chars().take(7).collect(),
                subject: c.commit.message.lines().next().unwrap_or_default().to_string(),
                author: author.name,
                date: author.date,
                url: c.html_url,
            }
        })
        .collect::<Vec<_>>();
    CommitLog { total: compare.total_commits.max(commits.len()), url: compare.html_url, commits }
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

    fn release(tag: &str, draft: bool, prerelease: bool) -> GithubRelease {
        GithubRelease {
            tag_name: tag.into(),
            name: Some(format!("MailVault {tag}")),
            published_at: Some("2026-09-25T13:45:06Z".into()),
            body: Some(format!("### Fixed\r\n- **{tag}.** fixed")),
            draft,
            prerelease,
        }
    }

    fn versions(notes: &[ReleaseNote]) -> Vec<&str> {
        notes.iter().map(|n| n.version.as_str()).collect()
    }

    #[test]
    fn release_notes_cover_after_the_installed_up_to_the_offered_newest_first() {
        let releases = ["v2.14.0", "v2.16.0", "v2.13.1", "v2.17.0", "v2.15.0"]
            .into_iter().map(|tag| release(tag, false, false)).collect();
        let notes = release_notes_between(releases, "2.14.0", "2.16.0", false);
        assert_eq!(versions(&notes), ["2.16.0", "2.15.0"]);
    }

    #[test]
    fn release_notes_skip_drafts() {
        let releases = vec![release("v2.16.0", true, false), release("v2.15.0", false, false)];
        assert_eq!(versions(&release_notes_between(releases, "2.14.0", "2.16.0", false)), ["2.15.0"]);
    }

    #[test]
    fn release_notes_skip_prereleases_unless_asked() {
        let releases = || vec![release("v2.16.0", false, false), release("v2.16.1-beta.1", false, true)];
        assert_eq!(versions(&release_notes_between(releases(), "2.15.0", "2.17.0", false)), ["2.16.0"]);
        assert_eq!(versions(&release_notes_between(releases(), "2.15.0", "2.17.0", true)), ["2.16.1-beta.1", "2.16.0"]);
    }

    #[test]
    fn release_notes_ignore_tags_that_are_not_versions() {
        // The rolling nightly release is tagged `nightly`.
        let releases = ["nightly", "garbage", "v2.16", "v2.16.0"]
            .into_iter().map(|tag| release(tag, false, false)).collect();
        assert_eq!(versions(&release_notes_between(releases, "2.15.0", "2.16.0", true)), ["2.16.0"]);
    }

    #[test]
    fn release_notes_are_empty_when_either_end_is_unreadable() {
        // The modal falls back to "unknown" when the feed names no version.
        let releases = || vec![release("v2.15.0", false, false), release("v2.16.0", false, false)];
        assert!(release_notes_between(releases(), "2.14.0", "unknown", false).is_empty());
        assert!(release_notes_between(releases(), "", "2.16.0", false).is_empty());
    }

    #[test]
    fn a_release_note_carries_the_bare_version_name_date_and_body() {
        let mut bare = release("v2.15.0", false, false);
        bare.name = None;
        bare.body = None;
        bare.published_at = None;
        let notes = release_notes_between(vec![release("v2.16.0", false, false), bare], "2.14.0", "2.16.0", false);
        assert_eq!(
            serde_json::to_value(&notes).unwrap(),
            serde_json::json!([
                { "version": "2.16.0", "name": "MailVault v2.16.0", "publishedAt": "2026-09-25T13:45:06Z",
                  "body": "### Fixed\r\n- **v2.16.0.** fixed" },
                { "version": "2.15.0", "name": "", "publishedAt": "", "body": "" },
            ])
        );
    }

    #[test]
    fn a_github_release_reads_from_the_api_shape() {
        let parsed: Vec<GithubRelease> = serde_json::from_value(serde_json::json!([
            { "tag_name": "v2.16.0", "name": "MailVault v2.16.0", "draft": false, "prerelease": false,
              "published_at": "2026-09-25T13:45:06Z", "body": "### Added", "assets": [] },
            { "tag_name": "nightly", "name": null, "draft": false, "prerelease": true, "published_at": null, "body": null },
        ])).unwrap();
        assert_eq!(parsed[0].tag_name, "v2.16.0");
        assert!(parsed[1].prerelease);
        assert_eq!(parsed[1].body, None);
    }

    #[test]
    fn an_unreadable_version_never_offers_an_update() {
        assert!(!is_newer("2.15.0", "garbage"));
        assert!(!is_newer("garbage", "2.15.0"));
        assert!(!is_newer("2.15", "2.16.0"));
    }

    #[test]
    fn a_nightly_names_its_commit_and_a_release_its_tag() {
        assert_eq!(git_ref("2.16.0-nightly.202609240647.gabc1234").as_deref(), Some("abc1234"));
        assert_eq!(git_ref("2.16.0-nightly.0835eb4").as_deref(), Some("0835eb4"));
        assert_eq!(git_ref("2.16.0").as_deref(), Some("v2.16.0"));
        assert_eq!(git_ref("2.16.1-beta.1"), None);
        assert_eq!(git_ref("unknown"), None);
        assert_eq!(git_ref(""), None);
    }

    #[test]
    fn a_commit_log_lists_subjects_newest_first() {
        let compare: GithubCompare = serde_json::from_value(serde_json::json!({
            "html_url": "https://github.com/o/r/compare/v2.15.0...v2.16.0",
            "total_commits": 300,
            "commits": [
                { "sha": "1111111aaaa", "html_url": "u1",
                  "commit": { "message": "fix: older\n\nbody", "author": { "name": "A", "date": "2026-09-01T00:00:00Z" } } },
                { "sha": "2222222bbbb", "html_url": "u2", "commit": { "message": "feat: newer", "author": null } },
            ],
        }))
        .unwrap();
        let log = commit_log(compare);
        assert_eq!(log.total, 300);
        assert_eq!(log.url, "https://github.com/o/r/compare/v2.15.0...v2.16.0");
        assert_eq!(
            serde_json::to_value(&log.commits).unwrap(),
            serde_json::json!([
                { "sha": "2222222", "subject": "feat: newer", "author": "", "date": "", "url": "u2" },
                { "sha": "1111111", "subject": "fix: older", "author": "A", "date": "2026-09-01T00:00:00Z", "url": "u1" },
            ])
        );
    }
}
