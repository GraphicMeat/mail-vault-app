//! The Archive & delete engine against fakes: no network, no disk except the
//! job-file tests. See docs/superpowers/plans/2026-09-29-part-d-design.md.

mod abd_fake;

use abd_fake::*;
use mailvault_core::abd::*;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::Ordering;

// ── helpers ─────────────────────────────────────────────────────────────────

fn day() -> i64 {
    ms(2025, 6, 1, 12, 0)
}

/// `n` messages "<folder>-<i>@t" in a plain folder; returns their uids.
fn seed(rig: &mut Rig, folder: &str, n: usize) -> Vec<u32> {
    (1..=n)
        .map(|i| rig.server.add_msg(folder, &format!("{folder}-{i}@t"), day() + i as i64 * 1000, 100))
        .collect()
}

async fn done(rig: &mut Rig) {
    assert_eq!(rig.plan_and_run().await, RunExit::Completed);
}

fn kept(rig: &Rig, folder: &str, why: KeptReason) -> Vec<u32> {
    rig.folder_state(folder).kept.get(&why).map(|s| s.iter().collect()).unwrap_or_default()
}

fn sample_job() -> JobFile {
    JobFile::create(NewJob {
        account_id: "acc-1".to_string(),
        account_email: "a@b.test".to_string(),
        host: "imap.example.test".to_string(),
        provider: Provider::Imap,
        mode: Mode::ArchiveDelete,
        timing: Timing::AfterAll,
        delete_mode: DeleteMode::MoveToTrash,
        scope: Scope {
            folders: vec!["INBOX".to_string()],
            dates: DateScope::All,
            date_choice: "all".to_string(),
            year_bounds: year_bounds(0, 2020, 2026),
        },
        now_ms: 1_790_000_000_000,
    })
}

fn sel(folders: &[&str], dates: DateScope, offset: i32) -> Selection {
    Selection {
        folders: folders.iter().map(|s| s.to_string()).collect(),
        dates,
        year_bounds: year_bounds(offset, 2015, 2030),
        mode: Mode::ArchiveDelete,
        delete_mode: DeleteMode::MoveToTrash,
    }
}

fn preview_of(server: &FakeServer) -> PreviewListing {
    server.preview("p1")
}

fn fetches(rig: &Rig) -> usize {
    rig.sh.cmds_named("fetch").len()
}

// ── uid sets and job files ──────────────────────────────────────────────────

#[test]
fn uidset_round_trips_through_the_imap_range_string() {
    let mut s = UidSet::new();
    s.extend((1..=500).chain([502]).chain(600..=900));
    assert_eq!(s.to_imap(), "1:500,502,600:900");
    assert_eq!(s.len(), 500 + 1 + 301);
    assert_eq!(UidSet::parse(&s.to_imap()).unwrap(), s);
    let json = serde_json::to_string(&s).unwrap();
    assert_eq!(json, "\"1:500,502,600:900\"");
    let back: UidSet = serde_json::from_str(&json).unwrap();
    assert_eq!(back, s);

    s.insert(501);
    assert_eq!(s.to_imap(), "1:502,600:900");
    s.remove(250);
    assert_eq!(s.to_imap(), "1:249,251:502,600:900");
    assert!(!s.contains(250) && s.contains(249) && s.contains(251));
    s.remove(1);
    assert_eq!(s.to_imap(), "2:249,251:502,600:900");

    assert_eq!(UidSet::new().to_imap(), "");
    assert_eq!(UidSet::parse("").unwrap(), UidSet::new());
    assert!(UidSet::new().is_empty());

    let a = UidSet::from_uids([1, 2, 3, 7]);
    let b = UidSet::from_uids([2, 7]);
    assert_eq!(a.difference(&b).iter().collect::<Vec<u32>>(), vec![1, 3]);

    let mut r = UidSet::new();
    for u in [9, 3, 5, 4, 1, 2, 10] {
        r.insert(u);
    }
    assert_eq!(r.to_imap(), "1:5,9:10");
}

#[test]
fn uidset_parse_rejects_garbage() {
    for bad in ["a", "1:", "x:5", "5:1", "0", "1,,2", "1:2:3", "-1", "*", "1:*", "99999999999", " 1 2"] {
        assert!(UidSet::parse(bad).is_err(), "'{bad}' must not parse");
    }
    assert!(serde_json::from_str::<UidSet>("\"nope\"").is_err());
}

#[test]
fn a_temp_job_file_never_loads_as_a_job() {
    let dir = tempfile::tempdir().unwrap();
    let jd = job_dir(dir.path(), "acc-1").unwrap();
    std::fs::create_dir_all(&jd).unwrap();
    let job = sample_job();
    // The temp name fsx::write_atomic uses, holding a perfectly valid job.
    std::fs::write(jd.join(".job.json.tmp-1-1"), serde_json::to_vec(&job).unwrap()).unwrap();
    assert!(load_job(&jd).unwrap().is_none(), "a leftover temp is not the record");

    save_job(&jd, &job).unwrap();
    std::fs::write(jd.join(".job.json.tmp-2-1"), b"{ half a fi").unwrap();
    assert_eq!(load_job(&jd).unwrap().unwrap().job_id, job.job_id);

    // Saving again leaves no new temp behind.
    save_job(&jd, &job).unwrap();
    let mut names: Vec<String> =
        std::fs::read_dir(&jd).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().to_string()).collect();
    names.sort();
    assert_eq!(names, vec![".job.json.tmp-1-1", ".job.json.tmp-2-1", "job.json"]);
}

#[test]
fn a_corrupt_job_file_is_reported_and_left_alone() {
    let dir = tempfile::tempdir().unwrap();
    let jd = job_dir(dir.path(), "acc-1").unwrap();
    std::fs::create_dir_all(&jd).unwrap();
    std::fs::write(jd.join("job.json"), b"{\"version\":1,\"jobId\":").unwrap();
    let err = load_job(&jd).unwrap_err();
    assert!(err.contains("unreadable job file"), "{err}");
    assert_eq!(std::fs::read(jd.join("job.json")).unwrap(), b"{\"version\":1,\"jobId\":".to_vec());

    // A job from a newer app is not silently reset either.
    let mut j = sample_job();
    j.version = JOB_VERSION + 1;
    std::fs::write(jd.join("job.json"), serde_json::to_vec(&j).unwrap()).unwrap();
    assert!(load_job(&jd).is_err());
}

#[test]
fn an_account_id_must_be_safe_as_a_path_part() {
    let d = std::path::Path::new("/tmp/x");
    assert!(job_dir(d, "acc-1_A").is_ok());
    for bad in ["", "../x", "a/b", "a b", &"a".repeat(81)] {
        assert!(job_dir(d, bad).is_err(), "'{bad}'");
    }
}

#[test]
fn job_file_json_shapes_are_the_contract() {
    // T5 and T7 build against these literal strings.
    let range = DateScope::Range { since_ms: Some(5), before_ms: None };
    assert_eq!(serde_json::to_string(&range).unwrap(), r#"{"kind":"range","sinceMs":5,"beforeMs":null}"#);
    assert_eq!(serde_json::to_string(&DateScope::All).unwrap(), r#"{"kind":"all"}"#);
    assert_eq!(serde_json::to_string(&DateScope::Years { years: vec![2023] }).unwrap(), r#"{"kind":"years","years":[2023]}"#);
    let waiting = JobStatus::Waiting { reason: WaitReason::DailyLimit, until_ms: Some(9) };
    assert_eq!(serde_json::to_string(&waiting).unwrap(), r#"{"state":"waiting","reason":"daily_limit","untilMs":9}"#);
    assert_eq!(serde_json::to_string(&JobStatus::Running { phase: Phase::Download }).unwrap(), r#"{"state":"running","phase":"download"}"#);
    assert_eq!(serde_json::to_string(&JobStatus::Paused { reason: PauseReason::DriveUnavailable }).unwrap(), r#"{"state":"paused","reason":"drive_unavailable"}"#);

    // A whole job survives a round trip with sets, kept reasons and failures.
    let mut job = sample_job();
    let mut fs = FolderState { path: "INBOX".to_string(), plan_file: "plan-000.json".to_string(), ..Default::default() };
    fs.stored.extend(1..=300);
    fs.keep(7, KeptReason::DownloadFailed);
    fs.failures.insert(9, 2);
    fs.deleting = Some(DeleteBatch { uids: UidSet::from_uids([1, 2]), via: "INBOX".to_string(), via_uids: UidSet::from_uids([1, 2]), started_ms: 4 });
    job.folders.push(fs);
    let text = serde_json::to_string(&job).unwrap();
    assert!(text.contains("\"stored\":\"1:300\""), "{text}");
    assert!(text.contains("\"download_failed\":\"7\""), "{text}");
    let back: JobFile = serde_json::from_str(&text).unwrap();
    assert_eq!(back.folders[0].stored.len(), 300);
    assert!(back.folders[0].is_kept(7));
    assert_eq!(back.folders[0].failures.get(&9), Some(&2));
    assert!(back.folders[0].deleting.is_some());
}

#[test]
fn plan_file_round_trips_columns_of_equal_length() {
    let dir = tempfile::tempdir().unwrap();
    let plan = FolderPlan {
        version: 1,
        path: "INBOX".to_string(),
        graph_folder_id: None,
        uid_validity: Some(7),
        uids: vec![1, 5, 9],
        internal_ms: vec![10, 20, 30],
        sizes: vec![100, 200, 300],
        message_ids: vec![Some("a@t".to_string()), None, Some("c@t".to_string())],
        gm_msgids: Some(vec![11, 12, 13]),
        graph_ids: None,
    };
    save_plan(dir.path(), "plan-000.json", &plan).unwrap();
    // A leftover temp file and an unrelated name are never read as plans.
    std::fs::write(dir.path().join(".plan-001.json.tmp-1-1"), b"garbage").unwrap();
    std::fs::write(dir.path().join("plan-1.json"), b"garbage").unwrap();
    let all = load_plans(dir.path()).unwrap();
    assert_eq!(all.len(), 1);
    assert_eq!(all["plan-000.json"], plan);

    let mut bad = plan.clone();
    bad.sizes.pop();
    assert!(save_plan(dir.path(), "plan-002.json", &bad).is_err());
    std::fs::write(dir.path().join("plan-003.json"), serde_json::to_vec(&bad).unwrap()).unwrap();
    assert!(load_plans(dir.path()).is_err(), "a torn plan must not drive a delete");

    let mut unsorted = plan.clone();
    unsorted.uids = vec![5, 1, 9];
    assert!(unsorted.check().is_err());
    assert!(is_plan_file_name("plan-012.json") && !is_plan_file_name("plan-12.json") && !is_plan_file_name(".plan-012.json"));
}

#[test]
fn the_all_mail_map_looks_up_by_gm_msgid() {
    let m = AllMailMap::from_pairs("[Gmail]/All Mail", 3, vec![(30, 3), (10, 1), (20, 2)]);
    assert_eq!(m.gm_msgids, vec![10, 20, 30]);
    assert_eq!(m.uid_for(20), Some(2));
    assert_eq!(m.uid_for(99), None);
    m.check().unwrap();
}

// ── classification ──────────────────────────────────────────────────────────

#[test]
fn classify_imap_knows_gmails_wordings() {
    use mailvault_core::abd::throttle::{classify_imap, Signal};
    assert_eq!(classify_imap("NO [ALERT] Account exceeded command or bandwidth limits. (Failure)"), Signal::ProviderLimit);
    assert_eq!(classify_imap("NO [OVERQUOTA] Quota exceeded"), Signal::ProviderLimit);
    assert_eq!(classify_imap("Account exceeded bandwidth"), Signal::ProviderLimit);
    assert_eq!(classify_imap("NO [THROTTLED] Too many commands"), Signal::Throttled);
    assert_eq!(classify_imap("* BYE [ALERT] Too many simultaneous connections. (Failure)"), Signal::TooManyConnections);
    assert_eq!(classify_imap("Login failed for user@example.com"), Signal::SignIn);
    assert_eq!(classify_imap("XOAUTH2 auth failed for x"), Signal::SignIn);
    assert_eq!(classify_imap("OAuth2 access token missing"), Signal::SignIn);
    assert_eq!(classify_imap("connection reset by peer"), Signal::ConnectionLost);
    assert_eq!(classify_imap("command timed out"), Signal::Timeout);
    assert_eq!(classify_imap("message not found"), Signal::Gone);
    assert_eq!(classify_imap("NO something else"), Signal::Other);
}

#[test]
fn classify_graph_reads_retry_after() {
    use mailvault_core::abd::throttle::{classify_graph, Signal};
    assert_eq!(classify_graph("Graph move failed (429:retry_after=7) slow down"), (Signal::Throttled, Some(7)));
    assert_eq!(classify_graph("Graph move failed (429) slow down"), (Signal::Throttled, None));
    assert_eq!(classify_graph("Graph list failed (401) expired"), (Signal::SignIn, None));
    assert_eq!(classify_graph("Graph list failed (503) busy"), (Signal::Throttled, None));
    assert_eq!(classify_graph("Graph get failed (404) gone"), (Signal::Gone, None));
    assert_eq!(classify_graph("Graph get failed (500) boom"), (Signal::Other, None));
    assert!(matches!(OpsError::from_graph("x (429:retry_after=7)"), OpsError::Throttled { retry_after_secs: Some(7), .. }));
    assert!(matches!(OpsError::from_imap("Account exceeded command or bandwidth limits"), OpsError::ProviderLimit(_)));
    assert!(matches!(OpsError::from_imap("[ALERT] Too many simultaneous connections"), OpsError::TooManyConnections(_)));
    assert!(matches!(OpsError::from_graph("(401)"), OpsError::SignIn(_)));
}

// ── dates and the dry run ───────────────────────────────────────────────────

#[test]
fn year_buckets_use_local_bounds_not_utc() {
    let at = ms(2024, 12, 31, 22, 30);
    assert_eq!(year_of(at, &year_bounds(7200, 2020, 2030)), Some(2025), "22:30Z is 00:30 on Jan 1 at +02:00");
    assert_eq!(year_of(at, &year_bounds(0, 2020, 2030)), Some(2024));
    assert_eq!(year_of(ms(2010, 1, 1, 0, 0), &year_bounds(0, 2020, 2030)), None);
    assert!(in_scope(at, &DateScope::Years { years: vec![2025] }, &year_bounds(7200, 2020, 2030)));
    assert!(!in_scope(at, &DateScope::Years { years: vec![2024] }, &year_bounds(7200, 2020, 2030)));
}

#[test]
fn older_than_two_years_cuts_at_january_first() {
    let bounds = year_bounds(7200, 2015, 2030);
    let cut = bounds.iter().find(|b| b.year == 2024).unwrap().start_ms; // now is 2026
    assert_eq!(cut, ms(2023, 12, 31, 22, 0));
    let scope = DateScope::Range { since_ms: None, before_ms: Some(cut) };
    assert!(in_scope(ms(2023, 12, 31, 21, 59), &scope, &bounds), "23:59 local on Dec 31 2023 is older");
    assert!(!in_scope(ms(2023, 12, 31, 22, 0), &scope, &bounds), "00:00 local on Jan 1 2024 is not");
    // This year = since Jan 1.
    let this = bounds.iter().find(|b| b.year == 2026).unwrap().start_ms;
    let scope = DateScope::Range { since_ms: Some(this), before_ms: None };
    assert!(in_scope(ms(2026, 6, 1, 0, 0), &scope, &bounds));
    assert!(!in_scope(ms(2025, 12, 31, 12, 0), &scope, &bounds));
    assert!(in_scope(ms(2020, 1, 1, 0, 0), &DateScope::All, &bounds));
}

fn dated_server() -> FakeServer {
    let sh = Shared::new(start_ms());
    let mut s = FakeServer::standard(sh, &["INBOX", "Work"]);
    for (y, n) in [(2022, 1), (2023, 2), (2024, 3), (2025, 4)] {
        for i in 0..n {
            s.add_msg("INBOX", &format!("in-{y}-{i}@t"), ms(y, 6, 1, 12, 0), 50);
        }
    }
    s.add_msg("Work", "w-2024@t", ms(2024, 2, 1, 12, 0), 50);
    s
}

#[test]
fn year_counts_match_the_listing() {
    let s = dated_server();
    let p = preview_of(&s);
    let sum = summarize(&p, &sel(&["INBOX", "Work"], DateScope::All, 0), &LocalCounts::default(), None, None);
    let years: Vec<(i32, u64)> = sum.years.iter().map(|y| (y.year, y.count)).collect();
    assert_eq!(years, vec![(2022, 1), (2023, 2), (2024, 4), (2025, 4)]);
    assert_eq!(sum.total.count, 11);
    let inbox = sum.folders.iter().find(|f| f.path == "INBOX").unwrap();
    let by: Vec<(i32, u64)> = inbox.by_year.iter().map(|y| (y.year, y.count)).collect();
    assert_eq!(by, vec![(2022, 1), (2023, 2), (2024, 3), (2025, 4)]);
    // Untouched folders still get a row and their own years.
    let only_inbox = summarize(&p, &sel(&["INBOX"], DateScope::All, 0), &LocalCounts::default(), None, None);
    assert_eq!(only_inbox.total.count, 10);
    assert!(only_inbox.folders.iter().any(|f| f.path == "Work" && f.by_year.len() == 1));
    // The date choice narrows the folder counts but "Choose years" keeps every year.
    let narrowed = summarize(&p, &sel(&["INBOX"], DateScope::Years { years: vec![2023] }, 0), &LocalCounts::default(), None, None);
    assert_eq!(narrowed.total.count, 2);
    assert_eq!(narrowed.years.len(), 4);
    let last = summarize(&p, &sel(&["INBOX"], DateScope::Years { years: vec![2025] }, 0), &LocalCounts::default(), None, None);
    assert_eq!(last.total.count, 4);
}

#[test]
fn summary_counts_already_archived_and_on_drive() {
    let s = dated_server();
    let p = preview_of(&s);
    let mut lc = LocalCounts::default();
    lc.archived.insert("INBOX".to_string(), [1u32, 2].into_iter().collect());
    lc.on_drive = Some(HashMap::from([("INBOX".to_string(), [1u32].into_iter().collect::<HashSet<u32>>())]));
    let mut selection = sel(&["INBOX"], DateScope::All, 0);
    let plain = summarize(&p, &selection, &lc, None, None);
    let inbox = plain.folders.iter().find(|f| f.path == "INBOX").unwrap();
    assert_eq!(inbox.already_archived, 2);
    assert_eq!(inbox.already_on_drive, 0, "archive-only mode does not look at the drive");
    selection.mode = Mode::ArchiveBackupDelete;
    let backup = summarize(&p, &selection, &lc, None, None);
    let inbox = backup.folders.iter().find(|f| f.path == "INBOX").unwrap();
    assert_eq!(inbox.already_on_drive, 1);
    // Bytes to download leave out what is already in the vault.
    let inbox_msgs: Vec<u64> = s.folder("INBOX").msgs.values().map(|m| m.raw.len() as u64).collect();
    let all: u64 = inbox_msgs.iter().sum();
    assert_eq!(backup.total.bytes, all);
    assert_eq!(backup.total.to_download_bytes, all - inbox_msgs[0] - inbox_msgs[1]);
    assert!(backup.can_delete && backup.can_empty);
}

#[test]
fn estimate_days_uses_the_daily_limit_and_what_is_left_today() {
    assert_eq!(estimate_days(5000, Some(1500), Some(2000)), Some(3));
    assert_eq!(estimate_days(1000, Some(1500), Some(2000)), Some(1));
    assert_eq!(estimate_days(4000, None, Some(2000)), Some(2));
    assert_eq!(estimate_days(4001, None, Some(2000)), Some(3));
    assert_eq!(estimate_days(2500, Some(0), Some(2000)), Some(3));
    assert_eq!(estimate_days(100, Some(50), None), None);
    assert_eq!(estimate_days(100, None, None), None);
}

#[test]
fn the_estimate_falls_back_to_gmails_own_cap() {
    let sh = Shared::new(start_ms());
    let mut s = FakeServer::gmail(sh, &["Work"]);
    s.add_gmail_msg("a@t", day(), 100, &["Work"]);
    let p = preview_of(&s);
    let selection = sel(&["Work"], DateScope::All, 0);
    let capped_off = summarize(&p, &selection, &LocalCounts::default(), None, None);
    assert!(capped_off.estimate.gmail_cap);
    assert_eq!(capped_off.estimate.daily_limit_bytes, Some(2500 * 1024 * 1024));
    assert_eq!(capped_off.estimate.days, Some(1));
    let user = summarize(&p, &selection, &LocalCounts::default(), Some(400), Some(1000));
    assert!(!user.estimate.gmail_cap);
    assert_eq!(user.estimate.daily_limit_bytes, Some(1000));
    let plain = FakeServer::standard(Shared::new(start_ms()), &["INBOX"]);
    let none = summarize(&preview_of(&plain), &sel(&["INBOX"], DateScope::All, 0), &LocalCounts::default(), None, None);
    assert_eq!(none.estimate.days, None);
    assert!(!none.estimate.gmail_cap);
}

#[test]
fn the_summary_warns_about_what_will_not_work() {
    // No Trash: the job cannot delete.
    let mut s = dated_server();
    s.has_trash = false;
    let sum = summarize(&preview_of(&s), &sel(&["INBOX"], DateScope::All, 0), &LocalCounts::default(), None, None);
    assert!(!sum.can_delete);
    assert!(sum.warnings.contains(&"cannot_delete".to_string()));
    // No UIDPLUS: no exact expunge.
    let mut s = dated_server();
    s.caps.uidplus = false;
    let mut selection = sel(&["INBOX", "Trash"], DateScope::All, 0);
    selection.delete_mode = DeleteMode::MoveToTrashAndEmpty;
    let sum = summarize(&preview_of(&s), &selection, &LocalCounts::default(), None, None);
    assert!(sum.can_delete && !sum.can_empty);
    assert!(sum.warnings.contains(&"cannot_empty".to_string()));
    assert!(sum.warnings.contains(&"trash_in_scope".to_string()));
    // Neither MOVE nor UIDPLUS.
    let mut s = dated_server();
    s.caps = Caps { uidplus: false, move_cmd: false, gmail_ext: false };
    let sum = summarize(&preview_of(&s), &sel(&["INBOX"], DateScope::All, 0), &LocalCounts::default(), None, None);
    assert!(!sum.can_delete);
    // A Gmail message on two labels.
    let mut g = FakeServer::gmail(Shared::new(start_ms()), &["Work", "Clients"]);
    g.add_gmail_msg("m@t", day(), 10, &["Work", "Clients"]);
    let sum = summarize(&preview_of(&g), &sel(&["Work"], DateScope::All, 0), &LocalCounts::default(), None, None);
    assert!(sum.warnings.contains(&"multi_label".to_string()));
    assert_eq!(sum.total.unique_messages, 1);
    let both = summarize(&preview_of(&g), &sel(&["Work", "Clients"], DateScope::All, 0), &LocalCounts::default(), None, None);
    assert_eq!(both.total.count, 2);
    assert_eq!(both.total.unique_messages, 1);
}

// ── planning ────────────────────────────────────────────────────────────────

#[tokio::test]
async fn plan_files_are_saved_before_the_job_names_them() {
    let mut rig = Rig::imap(&["INBOX", "Work"], Mode::ArchiveDelete, Timing::AfterAll, DeleteMode::MoveToTrash);
    seed(&mut rig, "INBOX", 2);
    seed(&mut rig, "Work", 2);
    rig.select(&["INBOX", "Work"]);
    assert_eq!(rig.plan().await, RunExit::Completed);
    assert_eq!(rig.env.plan_saves.borrow().clone(), vec!["plan-000.json", "plan-001.json"]);
    let tl = rig.sh.timeline.borrow();
    let last_plan = tl.iter().rposition(|e| matches!(e, Ev::Local("save_plan", _))).unwrap();
    let first_job = tl.iter().position(|e| *e == Ev::Save).unwrap();
    assert!(last_plan < first_job, "the job file may only name plan files that exist");
    drop(tl);
    let saved = rig.env.last_saved();
    assert_eq!(saved.folders.len(), 2);
    assert_eq!(saved.folders[0].plan_file, "plan-000.json");
    assert_eq!(saved.folders[0].scoped, 2);
    assert_eq!(rig.plans.get("plan-000.json").unwrap().message_ids[0].as_deref(), Some("INBOX-1@t"));
}

#[tokio::test]
async fn an_archived_copy_with_a_matching_message_id_is_not_downloaded() {
    let mut rig = Rig::imap(&["INBOX"], Mode::ArchiveDelete, Timing::AfterAll, DeleteMode::MoveToTrash);
    seed(&mut rig, "INBOX", 4);
    rig.local.put_vault("INBOX", 1, raw_msg("INBOX-1@t", 100), true);
    rig.local.put_vault("INBOX", 2, raw_msg("someone-else@t", 100), true);
    rig.local.put_vault("INBOX", 3, raw_msg("INBOX-3@t", 100), false); // a cache copy, not archived
    rig.select(&["INBOX"]);
    assert_eq!(rig.plan().await, RunExit::Completed);
    let fs = rig.folder_state("INBOX");
    assert!(fs.stored.contains(1) && fs.vault_ok.contains(1));
    assert!(fs.is_kept(2), "another message's archived copy sits at this uid");
    assert_eq!(kept(&rig, "INBOX", KeptReason::VaultMismatch), vec![2]);
    assert!(!fs.stored.contains(3));
    assert_eq!(rig.run().await, RunExit::Completed);
    assert!(rig.server.fetch_count.get(&("INBOX".to_string(), 1)).is_none());
    assert!(rig.server.fetch_count.get(&("INBOX".to_string(), 2)).is_none());
    assert_eq!(rig.server.fetch_count[&("INBOX".to_string(), 3)], 1);
    assert_eq!(rig.server.uids_in("INBOX"), vec![2], "the mismatched one stays on the server");
    assert!(rig.local.vault.borrow()["INBOX"][&3].archived, "the cache copy was replaced");
}

#[tokio::test]
async fn an_empty_scope_completes_at_once() {
    let mut rig = Rig::imap(&["INBOX"], Mode::ArchiveDelete, Timing::AfterAll, DeleteMode::MoveToTrash);
    seed(&mut rig, "INBOX", 2);
    rig.select(&[]);
    done(&mut rig).await;
    assert_eq!(rig.server.uids_in("INBOX").len(), 2);
    assert_eq!(fetches(&rig), 0);
}

// ── the phase machine ───────────────────────────────────────────────────────

#[tokio::test]
async fn after_all_deletes_nothing_until_every_folder_is_verified() {
    let mut rig = Rig::imap(&["INBOX", "Work"], Mode::ArchiveDelete, Timing::AfterAll, DeleteMode::MoveToTrash);
    seed(&mut rig, "INBOX", 3);
    seed(&mut rig, "Work", 3);
    rig.select(&["INBOX", "Work"]);
    done(&mut rig).await;
    let last_store = *rig.sh.local_events("store_archived").last().unwrap();
    let first_move = rig.sh.cmds_named("move")[0].0;
    assert!(first_move > last_store, "a move went out before the last email was saved");
    assert!(rig.server.uids_in("INBOX").is_empty() && rig.server.uids_in("Work").is_empty());
    assert_eq!(rig.server.ids_in("Trash").len(), 6);
    assert_eq!(rig.local.vault_uids("INBOX").len(), 3);
    assert_eq!(rig.folder_state("Work").deleted.len(), 3);
    assert_eq!(rig.env.last_saved().status, JobStatus::Completed);
}

#[tokio::test]
async fn as_saved_deletes_each_batch_right_after_its_verify() {
    let mut rig = Rig::imap(&["INBOX", "Work"], Mode::ArchiveDelete, Timing::AsSaved, DeleteMode::MoveToTrash);
    seed(&mut rig, "INBOX", 3);
    seed(&mut rig, "Work", 3);
    rig.select(&["INBOX", "Work"]);
    done(&mut rig).await;
    let moves = rig.sh.cmds_named("move");
    assert_eq!(moves.len(), 2);
    let last_store = *rig.sh.local_events("store_archived").last().unwrap();
    assert!(moves[0].0 < last_store, "the first folder was deleted before the second was saved");
    let first_verify = rig.sh.local_events("verify_vault")[0];
    assert!(moves[0].0 > first_verify);
    assert_eq!(moves[0].1.folder, "INBOX");
    assert_eq!(moves[1].1.folder, "Work");
}

#[tokio::test]
async fn a_crash_between_verify_and_delete_deletes_nothing_and_refetches_nothing() {
    let mut rig = Rig::imap(&["INBOX"], Mode::ArchiveDelete, Timing::AfterAll, DeleteMode::MoveToTrash);
    seed(&mut rig, "INBOX", 5);
    rig.select(&["INBOX"]);
    assert_eq!(rig.plan().await, RunExit::Completed);
    // Die on the save that would record the intent to delete.
    rig.env.crash_when(|job, _| job.folders.iter().any(|f| f.deleting.is_some()));
    assert!(matches!(rig.run().await, RunExit::Failed(_)));
    assert!(rig.sh.cmds_named("move").is_empty(), "no command may follow a failed save");
    assert_eq!(rig.server.uids_in("INBOX").len(), 5);
    assert_eq!(rig.server.fetches_total, 5);

    rig.restart_from_last_save();
    let snapshot = rig.folder_state("INBOX");
    assert_eq!(snapshot.vault_ok.len(), 5, "the verified set was saved before the delete step");
    assert!(snapshot.deleting.is_none());
    let mark = rig.sh.timeline.borrow().len();
    let verifies_before = rig.local.verify_calls.get();
    assert_eq!(rig.run().await, RunExit::Completed);
    assert_eq!(rig.server.fetches_total, 5, "nothing verified is downloaded again");
    assert!(rig.local.verify_calls.get() > verifies_before, "the files are checked again before the delete");
    let first_move = rig.sh.cmds_named("move")[0].0;
    let fresh_verify = rig.sh.local_events("verify_vault").into_iter().filter(|i| *i >= mark).min().unwrap();
    assert!(fresh_verify < first_move);
    assert!(rig.server.uids_in("INBOX").is_empty());
}

#[tokio::test]
async fn a_crash_after_the_move_was_sent_rechecks_the_server_first() {
    let mut rig = Rig::imap(&["INBOX"], Mode::ArchiveDelete, Timing::AfterAll, DeleteMode::MoveToTrash);
    seed(&mut rig, "INBOX", 4);
    rig.select(&["INBOX"]);
    assert_eq!(rig.plan().await, RunExit::Completed);
    // Die on the save that records the move.
    rig.env.crash_when(|job, _| job.folders.iter().any(|f| !f.deleted.is_empty()));
    assert!(matches!(rig.run().await, RunExit::Failed(_)));
    assert_eq!(rig.sh.cmds_named("move").len(), 1);
    assert!(rig.server.uids_in("INBOX").is_empty(), "the server did move them");

    rig.restart_from_last_save();
    assert!(rig.folder_state("INBOX").deleting.is_some(), "the intent was durable");
    assert!(rig.folder_state("INBOX").deleted.is_empty());
    assert_eq!(rig.run().await, RunExit::Completed);
    assert_eq!(rig.sh.cmds_named("move").len(), 1, "no second MOVE");
    assert!(!rig.sh.cmds_named("present").is_empty(), "the server was asked first");
    let fs = rig.folder_state("INBOX");
    assert_eq!(fs.deleted.len(), 4);
    assert!(fs.deleting.is_none());
    assert_eq!(rig.server.ids_in("Trash").len(), 4);
}

#[tokio::test]
async fn a_retried_move_after_a_lost_answer_does_not_move_twice() {
    let mut rig = Rig::imap(&["INBOX"], Mode::ArchiveDelete, Timing::AfterAll, DeleteMode::MoveToTrash);
    seed(&mut rig, "INBOX", 3);
    rig.select(&["INBOX"]);
    // The server moves them, then the answer is lost.
    rig.server.faults.push(
        Fault::new("move", OpsError::Throttled { retry_after_secs: None, text: "connection reset".to_string() }).execute_first(),
    );
    done(&mut rig).await;
    assert_eq!(rig.sh.cmds_named("move").len(), 1);
    assert_eq!(rig.folder_state("INBOX").deleted.len(), 3);
    assert_eq!(rig.server.ids_in("Trash").len(), 3);
}

#[tokio::test]
async fn resume_after_a_kill_mid_batch_repeats_no_download() {
    let mut rig = Rig::imap(&["INBOX"], Mode::ArchiveDelete, Timing::AfterAll, DeleteMode::MoveToTrash);
    seed(&mut rig, "INBOX", 60);
    rig.select(&["INBOX"]);
    assert_eq!(rig.plan().await, RunExit::Completed);
    // Die on the save that follows the second batch: its files are on disk,
    // the job file does not know.
    rig.env.crash_when(|job, _| job.folders.first().map_or(false, |f| f.vault_ok.len() >= 50));
    assert!(matches!(rig.run().await, RunExit::Failed(_)));
    assert_eq!(rig.server.fetches_total, 50);
    rig.restart_from_last_save();
    assert_eq!(rig.folder_state("INBOX").vault_ok.len(), 25);
    assert_eq!(rig.run().await, RunExit::Completed);
    assert_eq!(rig.server.fetches_total, 60);
    assert!(rig.server.fetch_count.values().all(|c| *c == 1), "a verified uid was fetched twice");
    assert_eq!(rig.local.stores.borrow().len(), 60);
    assert!(rig.server.uids_in("INBOX").is_empty());
}

#[tokio::test]
async fn a_file_removed_after_verify_is_kept_on_the_server() {
    let mut rig = Rig::imap(&["INBOX"], Mode::ArchiveDelete, Timing::AfterAll, DeleteMode::MoveToTrash);
    seed(&mut rig, "INBOX", 3);
    rig.select(&["INBOX"]);
    // verify_vault call 1 is the batch check, call 2 the check before the delete.
    *rig.local.remove_before_verify.borrow_mut() = Some(("INBOX".to_string(), 2, 2));
    done(&mut rig).await;
    assert_eq!(rig.server.uids_in("INBOX"), vec![2]);
    assert_eq!(kept(&rig, "INBOX", KeptReason::VaultMissing), vec![2]);
    assert_eq!(rig.server.ids_in("Trash").len(), 2);
    assert_eq!(rig.folder_state("INBOX").deleted.len(), 2);
}

#[tokio::test]
async fn a_swapped_vault_file_is_kept_on_the_server() {
    let mut rig = Rig::imap(&["INBOX"], Mode::ArchiveDelete, Timing::AfterAll, DeleteMode::MoveToTrash);
    seed(&mut rig, "INBOX", 3);
    rig.select(&["INBOX"]);
    // Between the batch check and the check before the delete, another
    // program puts a different message's file at uid 3.
    *rig.local.before_verify.borrow_mut() = Some((
        2,
        Box::new(|l: &FakeLocal| l.swap_vault_raw("INBOX", 3, raw_msg("not-this-one@t", 10))),
    ));
    done(&mut rig).await;
    assert_eq!(kept(&rig, "INBOX", KeptReason::VaultMismatch), vec![3]);
    assert_eq!(rig.server.uids_in("INBOX"), vec![3]);
    assert_eq!(rig.server.ids_in("Trash").len(), 2);
}

#[tokio::test]
async fn backup_mode_never_deletes_without_a_mirror_copy() {
    let mut rig = Rig::imap(&["INBOX"], Mode::ArchiveBackupDelete, Timing::AfterAll, DeleteMode::MoveToTrash);
    seed(&mut rig, "INBOX", 3);
    rig.select(&["INBOX"]);
    // The drive loses the copy of uid 2 between the copy and the delete.
    *rig.local.remove_mirror_before_path_check.borrow_mut() = Some(("INBOX".to_string(), 2));
    done(&mut rig).await;
    assert_eq!(rig.server.uids_in("INBOX"), vec![2]);
    assert_eq!(kept(&rig, "INBOX", KeptReason::MirrorMissing), vec![2]);
    assert_eq!(rig.local.mirror_uids("INBOX"), vec![1, 3]);
    assert_eq!(rig.folder_state("INBOX").mirror_ok.len(), 3, "it was on the drive when it was copied");
    assert_eq!(rig.local.mirror_copy_calls.get(), 1);
    assert_eq!(rig.local.mirror_path_calls.get(), 1, "the delete step re-checks by exact path");
}

#[tokio::test]
async fn archive_mode_never_touches_the_mirror() {
    let mut rig = Rig::imap(&["INBOX"], Mode::ArchiveDelete, Timing::AsSaved, DeleteMode::MoveToTrash);
    seed(&mut rig, "INBOX", 3);
    rig.select(&["INBOX"]);
    done(&mut rig).await;
    assert_eq!(rig.local.mirror_copy_calls.get(), 0);
    assert_eq!(rig.local.mirror_path_calls.get(), 0);
    assert!(rig.local.mirror_uids("INBOX").is_empty());
    assert_eq!(rig.server.uids_in("INBOX").len(), 0);
}

#[tokio::test]
async fn a_missing_drive_pauses_and_deletes_nothing() {
    let mut rig = Rig::imap(&["INBOX"], Mode::ArchiveBackupDelete, Timing::AsSaved, DeleteMode::MoveToTrash);
    seed(&mut rig, "INBOX", 3);
    rig.select(&["INBOX"]);
    rig.local.drive_gone.set(true);
    assert_eq!(rig.plan_and_run().await, RunExit::Paused(PauseReason::DriveUnavailable));
    assert_eq!(rig.server.uids_in("INBOX").len(), 3);
    assert!(rig.sh.cmds_named("move").is_empty());
    assert_eq!(rig.env.last_saved().status, JobStatus::Paused { reason: PauseReason::DriveUnavailable });
    assert_eq!(rig.local.vault_uids("INBOX").len(), 3, "the vault copies were made");

    // The drive comes back: same job, no new download, then the delete.
    rig.local.drive_gone.set(false);
    assert_eq!(rig.run().await, RunExit::Completed);
    assert_eq!(rig.server.fetches_total, 3);
    assert_eq!(rig.local.mirror_uids("INBOX"), vec![1, 2, 3]);
    assert!(rig.server.uids_in("INBOX").is_empty());
}

#[tokio::test]
async fn a_drive_lost_right_before_the_delete_pauses_it() {
    let mut rig = Rig::imap(&["INBOX"], Mode::ArchiveBackupDelete, Timing::AfterAll, DeleteMode::MoveToTrash);
    seed(&mut rig, "INBOX", 3);
    rig.select(&["INBOX"]);
    // The copies were made; the drive is gone when the delete step re-checks.
    *rig.local.before_mirror_path_check.borrow_mut() = Some(Box::new(|l: &FakeLocal| l.drive_gone.set(true)));
    assert_eq!(rig.plan_and_run().await, RunExit::Paused(PauseReason::DriveUnavailable));
    assert!(rig.sh.cmds_named("move").is_empty(), "no vault-only delete");
    assert_eq!(rig.server.uids_in("INBOX").len(), 3);
    let saved = rig.env.last_saved();
    assert!(saved.folders[0].deleting.is_none(), "the intent is only written after the checks pass");
    assert_eq!(saved.status, JobStatus::Paused { reason: PauseReason::DriveUnavailable });
    rig.local.drive_gone.set(false);
    assert_eq!(rig.run().await, RunExit::Completed);
    assert!(rig.server.uids_in("INBOX").is_empty());
    assert_eq!(rig.server.fetches_total, 3);
}

#[tokio::test]
async fn a_vault_that_goes_away_pauses_the_job() {
    let mut rig = Rig::imap(&["INBOX"], Mode::ArchiveDelete, Timing::AfterAll, DeleteMode::MoveToTrash);
    seed(&mut rig, "INBOX", 2);
    rig.select(&["INBOX"]);
    assert_eq!(rig.plan().await, RunExit::Completed);
    rig.local.vault_gone.set(true);
    assert_eq!(rig.run().await, RunExit::Paused(PauseReason::VaultUnavailable));
    assert_eq!(rig.server.uids_in("INBOX").len(), 2);
    rig.local.vault_gone.set(false);
    assert_eq!(rig.run().await, RunExit::Completed);
}

#[tokio::test]
async fn a_changed_uidvalidity_stops_deletes_in_that_folder() {
    let mut rig = Rig::imap(&["INBOX"], Mode::ArchiveDelete, Timing::AsSaved, DeleteMode::MoveToTrash);
    seed(&mut rig, "INBOX", 50);
    rig.select(&["INBOX"]);
    rig.server.bump_validity_after_moves = Some(1);
    done(&mut rig).await;
    assert_eq!(rig.sh.cmds_named("move").len(), 1, "nothing more is deleted after the change");
    assert_eq!(rig.server.uids_in("INBOX").len(), 25);
    let fs = rig.folder_state("INBOX");
    assert!(fs.stale);
    assert_eq!(kept(&rig, "INBOX", KeptReason::ServerChanged).len(), 25);
    assert_eq!(fs.deleted.len(), 25);
    assert_eq!(rig.env.last_frame()["staleFolders"], serde_json::json!(["INBOX"]));
}

#[tokio::test]
async fn a_folder_that_changed_before_the_run_is_left_alone() {
    let mut rig = Rig::imap(&["INBOX"], Mode::ArchiveDelete, Timing::AfterAll, DeleteMode::MoveToTrash);
    seed(&mut rig, "INBOX", 4);
    rig.select(&["INBOX"]);
    assert_eq!(rig.plan().await, RunExit::Completed);
    rig.server.folder_mut("INBOX").validity += 1;
    assert_eq!(rig.run().await, RunExit::Completed);
    assert_eq!(fetches(&rig), 0);
    assert!(rig.sh.cmds_named("move").is_empty());
    assert_eq!(kept(&rig, "INBOX", KeptReason::ServerChanged).len(), 4);
    assert_eq!(rig.server.uids_in("INBOX").len(), 4);
}

// ── delete modes ────────────────────────────────────────────────────────────

#[tokio::test]
async fn move_mode_leaves_the_messages_in_trash() {
    let mut rig = Rig::imap(&["INBOX"], Mode::ArchiveDelete, Timing::AfterAll, DeleteMode::MoveToTrash);
    rig.server.add_msg("Trash", "old-1@t", day(), 10);
    seed(&mut rig, "INBOX", 3);
    rig.select(&["INBOX"]);
    done(&mut rig).await;
    assert_eq!(rig.server.ids_in("Trash").len(), 4);
    assert!(rig.sh.cmds_named("expunge").is_empty());
}

#[tokio::test]
async fn empty_mode_expunges_exactly_the_moved_trash_uids() {
    let mut rig = Rig::imap(&["INBOX"], Mode::ArchiveDelete, Timing::AsSaved, DeleteMode::MoveToTrashAndEmpty);
    rig.server.add_msg("Trash", "old-1@t", day(), 10);
    rig.server.add_msg("Trash", "old-2@t", day(), 10);
    seed(&mut rig, "INBOX", 3);
    rig.select(&["INBOX"]);
    done(&mut rig).await;
    assert_eq!(rig.server.ids_in("Trash"), vec!["old-1@t", "old-2@t"], "the rest of Trash is not touched");
    assert_eq!(rig.server.expunges.len(), 1);
    let (asked, done_uids) = &rig.server.expunges[0];
    assert_eq!(asked, done_uids);
    assert_eq!(done_uids.len(), 3);
    assert!(done_uids.iter().all(|u| *u > 2), "only the uids the move created");
    let fs = rig.folder_state("INBOX");
    assert_eq!(fs.emptied.len(), 3);
    assert_eq!(fs.deleted.len(), 3);
    assert!(fs.trash_pending.is_empty());
}

#[tokio::test]
async fn a_trash_uid_whose_message_id_differs_is_not_expunged() {
    let mut rig = Rig::imap(&["INBOX"], Mode::ArchiveDelete, Timing::AfterAll, DeleteMode::MoveToTrashAndEmpty);
    rig.server.add_msg("Trash", "old-1@t", day(), 10);
    seed(&mut rig, "INBOX", 2);
    rig.server.scramble_copyuid = true; // COPYUID answers in the wrong order
    rig.select(&["INBOX"]);
    done(&mut rig).await;
    let ids = rig.server.ids_in("Trash");
    assert_eq!(ids.len(), 3, "nothing was removed from Trash");
    assert!(rig.server.expunges[0].1.is_empty());
    assert_eq!(kept(&rig, "INBOX", KeptReason::NotEmptied).len(), 2);
    assert_eq!(rig.folder_state("INBOX").emptied.len(), 0);
}

#[tokio::test]
async fn without_copyuid_the_trash_uid_is_found_by_message_id() {
    let mut rig = Rig::imap(&["INBOX"], Mode::ArchiveDelete, Timing::AfterAll, DeleteMode::MoveToTrashAndEmpty);
    rig.server.caps.move_cmd = false; // UIDPLUS only: COPY + STORE + UID EXPUNGE, no COPYUID
    rig.server.add_msg("Trash", "old-1@t", day(), 10);
    seed(&mut rig, "INBOX", 3);
    rig.select(&["INBOX"]);
    done(&mut rig).await;
    assert_eq!(rig.server.ids_in("Trash"), vec!["old-1@t"]);
    assert_eq!(rig.folder_state("INBOX").emptied.len(), 3);
    assert!(!rig.sh.cmds_named("find_in_trash").is_empty());
}

#[tokio::test]
async fn an_older_trash_copy_with_the_same_message_id_is_never_expunged() {
    let mut rig = Rig::imap(&["INBOX"], Mode::ArchiveDelete, Timing::AfterAll, DeleteMode::MoveToTrashAndEmpty);
    rig.server.caps.move_cmd = false;
    rig.server.add_msg("Trash", "INBOX-1@t", day(), 10); // the user's own older copy
    seed(&mut rig, "INBOX", 2);
    rig.select(&["INBOX"]);
    done(&mut rig).await;
    // uid 1 is ambiguous (two Trash copies): left. uid 2 is unique: removed.
    assert_eq!(kept(&rig, "INBOX", KeptReason::NotEmptied), vec![1]);
    let ids = rig.server.ids_in("Trash");
    assert_eq!(ids.iter().filter(|i| *i == "INBOX-1@t").count(), 2);
    assert!(!ids.contains(&"INBOX-2@t".to_string()));
    assert_eq!(rig.folder_state("INBOX").emptied.len(), 1);
}

#[tokio::test]
async fn no_move_and_no_uidplus_refuses_deletes() {
    let mut rig = Rig::imap(&["INBOX"], Mode::ArchiveDelete, Timing::AsSaved, DeleteMode::MoveToTrash);
    rig.server.caps = Caps { uidplus: false, move_cmd: false, gmail_ext: false };
    seed(&mut rig, "INBOX", 3);
    rig.select(&["INBOX"]);
    done(&mut rig).await;
    assert!(rig.sh.cmds_named("move").is_empty());
    assert_eq!(rig.server.uids_in("INBOX").len(), 3);
    assert_eq!(kept(&rig, "INBOX", KeptReason::CannotDelete).len(), 3);
    assert_eq!(rig.local.vault_uids("INBOX").len(), 3, "the archive part still ran");
}

#[tokio::test]
async fn no_trash_folder_refuses_deletes() {
    let mut rig = Rig::imap(&["INBOX"], Mode::ArchiveDelete, Timing::AfterAll, DeleteMode::MoveToTrash);
    rig.server.has_trash = false;
    seed(&mut rig, "INBOX", 2);
    rig.select(&["INBOX"]);
    done(&mut rig).await;
    assert!(rig.sh.cmds_named("move").is_empty());
    assert_eq!(kept(&rig, "INBOX", KeptReason::CannotDelete).len(), 2);
}

#[tokio::test]
async fn no_uidplus_disables_empty() {
    let mut rig = Rig::imap(&["INBOX"], Mode::ArchiveDelete, Timing::AfterAll, DeleteMode::MoveToTrashAndEmpty);
    rig.server.caps = Caps { uidplus: false, move_cmd: true, gmail_ext: false };
    seed(&mut rig, "INBOX", 3);
    rig.select(&["INBOX"]);
    done(&mut rig).await;
    assert!(rig.sh.cmds_named("expunge").is_empty(), "a plain EXPUNGE is never sent");
    assert_eq!(rig.server.ids_in("Trash").len(), 3);
    assert_eq!(kept(&rig, "INBOX", KeptReason::NotEmptied).len(), 3);
    assert_eq!(rig.folder_state("INBOX").deleted.len(), 3);
}

#[tokio::test]
async fn trash_in_scope_is_left_in_trash_when_only_moving() {
    let mut rig = Rig::imap(&["INBOX"], Mode::ArchiveDelete, Timing::AsSaved, DeleteMode::MoveToTrash);
    seed(&mut rig, "Trash", 3);
    rig.select(&["Trash"]);
    done(&mut rig).await;
    assert!(rig.sh.cmds_named("move").is_empty());
    assert_eq!(rig.server.ids_in("Trash").len(), 3);
    assert_eq!(kept(&rig, "Trash", KeptReason::AlreadyInTrash).len(), 3);
    assert_eq!(rig.local.vault_uids("Trash").len(), 3, "they were archived first");
}

#[tokio::test]
async fn trash_in_scope_is_expunged_exactly_when_emptying() {
    let mut rig = Rig::imap(&["INBOX"], Mode::ArchiveDelete, Timing::AsSaved, DeleteMode::MoveToTrashAndEmpty);
    seed(&mut rig, "Trash", 3);
    rig.select(&["Trash"]);
    done(&mut rig).await;
    assert!(rig.sh.cmds_named("move").is_empty());
    assert!(rig.server.ids_in("Trash").is_empty());
    assert_eq!(rig.folder_state("Trash").emptied.len(), 3);
    assert_eq!(rig.server.expunges[0].0, vec![1, 2, 3]);
}

// ── Gmail ───────────────────────────────────────────────────────────────────

#[tokio::test]
async fn gmail_deletes_the_all_mail_copy_once_every_ticked_copy_is_verified() {
    let mut rig = Rig::gmail(&["Work", "Clients"], Mode::ArchiveDelete, Timing::AsSaved, DeleteMode::MoveToTrash);
    let a1 = rig.server.add_gmail_msg("m1@t", day(), 50, &["Work", "Clients"]);
    let a2 = rig.server.add_gmail_msg("m2@t", day() + 1000, 50, &["Work"]);
    rig.select(&["Work", "Clients"]);
    done(&mut rig).await;
    let moves = rig.sh.cmds_named("move");
    assert_eq!(moves.len(), 2);
    assert!(moves.iter().all(|(_, c)| c.folder == "[Gmail]/All Mail"), "Gmail deletes go through All Mail");
    assert_eq!(moves[0].1.uids, vec![a2], "the two-label message waits for its second copy");
    assert_eq!(moves[1].1.uids, vec![a1]);
    let clients_store = rig
        .sh
        .timeline
        .borrow()
        .iter()
        .position(|e| matches!(e, Ev::Local("store_archived", f) if f == "Clients"))
        .unwrap();
    assert!(moves[1].0 > clients_store);
    for f in ["Work", "Clients", "[Gmail]/All Mail"] {
        assert!(rig.server.uids_in(f).is_empty(), "{f} still holds mail");
    }
    assert_eq!(rig.server.ids_in("[Gmail]/Trash").len(), 2);
    assert_eq!(rig.folder_state("Work").deleted.len(), 2);
    assert_eq!(rig.folder_state("Clients").deleted.len(), 1);
    assert_eq!(rig.local.vault_uids("Work").len(), 2);
    assert_eq!(rig.local.vault_uids("Clients").len(), 1);
}

#[tokio::test]
async fn gmail_after_all_waits_for_every_folder_too() {
    let mut rig = Rig::gmail(&["Work", "Clients"], Mode::ArchiveDelete, Timing::AfterAll, DeleteMode::MoveToTrash);
    rig.server.add_gmail_msg("m1@t", day(), 50, &["Work", "Clients"]);
    rig.server.add_gmail_msg("m2@t", day() + 1000, 50, &["Clients"]);
    rig.select(&["Work", "Clients"]);
    done(&mut rig).await;
    let last_store = *rig.sh.local_events("store_archived").last().unwrap();
    assert!(rig.sh.cmds_named("move")[0].0 > last_store);
    assert!(rig.server.uids_in("[Gmail]/All Mail").is_empty());
}

#[tokio::test]
async fn gmail_all_mail_goes_after_the_label_folders() {
    let mut rig = Rig::gmail(&["Work", "Clients"], Mode::ArchiveDelete, Timing::AfterAll, DeleteMode::MoveToTrash);
    rig.server.add_gmail_msg("m1@t", day(), 50, &["Work"]);
    rig.server.add_gmail_msg("m2@t", day() + 1000, 50, &["Clients"]);
    rig.server.add_gmail_msg("m3@t", day() + 2000, 50, &[]);
    rig.server.add_gmail_only("[Gmail]/Spam", "spam1@t", day(), 50);
    rig.select(&["[Gmail]/Spam", "[Gmail]/All Mail", "Clients", "Work"]);
    assert_eq!(rig.plan().await, RunExit::Completed);
    let order: Vec<String> = rig.env.last_saved().folders.iter().map(|f| f.path.clone()).collect();
    assert_eq!(order, vec!["Work", "Clients", "[Gmail]/All Mail", "[Gmail]/Spam"]);
    assert_eq!(rig.job.folders[2].role, FolderRole::AllMail);
    assert_eq!(rig.run().await, RunExit::Completed);
    let fetch_folders: Vec<String> = rig.sh.cmds_named("fetch").into_iter().map(|(_, c)| c.folder).collect();
    let first_all_mail = fetch_folders.iter().position(|f| f == "[Gmail]/All Mail").unwrap();
    assert!(fetch_folders[..first_all_mail].iter().all(|f| f == "Work" || f == "Clients"));
    assert!(fetch_folders.iter().skip(first_all_mail).all(|f| f != "Work" && f != "Clients"));
    assert_eq!(fetch_folders.last().unwrap(), "[Gmail]/Spam");
}

#[tokio::test]
async fn gmail_all_mail_ticked_adds_only_unlabelled_mail() {
    let mut rig = Rig::gmail(&["Work"], Mode::ArchiveDelete, Timing::AfterAll, DeleteMode::MoveToTrash);
    let labelled = rig.server.add_gmail_msg("lab@t", day(), 50, &["Work"]);
    let bare = rig.server.add_gmail_msg("un@t", day() + 1000, 50, &[]);
    rig.select(&["[Gmail]/All Mail"]);
    assert_eq!(rig.plan().await, RunExit::Completed);
    assert_eq!(rig.job.folders.len(), 1);
    assert_eq!(rig.job.folders[0].scoped, 1);
    assert_eq!(rig.plans.get("plan-000.json").unwrap().uids, vec![bare]);
    assert_eq!(rig.run().await, RunExit::Completed);
    assert_eq!(rig.server.uids_in("[Gmail]/All Mail"), vec![labelled]);
    assert_eq!(rig.server.uids_in("Work").len(), 1, "the labelled message was not in scope");
    assert_eq!(rig.server.ids_in("[Gmail]/Trash"), vec!["un@t"]);
}

#[tokio::test]
async fn a_verified_gmail_duplicate_is_copied_locally_not_downloaded() {
    let mut rig = Rig::gmail(&["Work", "Clients"], Mode::ArchiveDelete, Timing::AsSaved, DeleteMode::MoveToTrash);
    rig.server.add_gmail_msg("m1@t", day(), 50, &["Work", "Clients"]);
    rig.server.add_gmail_msg("m2@t", day() + 1000, 50, &["Work"]);
    rig.select(&["Work", "Clients"]);
    done(&mut rig).await;
    assert_eq!(rig.server.fetches_total, 2, "the Clients copy of m1 is not downloaded");
    assert!(rig.server.fetch_count.get(&("Clients".to_string(), 1)).is_none());
    assert_eq!(rig.local.reads.get(), 1);
    assert_eq!(rig.local.stores.borrow().len(), 3);
    let work = rig.local.vault.borrow()["Work"][&1].raw.clone();
    let clients = rig.local.vault.borrow()["Clients"][&1].raw.clone();
    assert_eq!(work, clients);
}

#[tokio::test]
async fn a_gmail_message_without_an_all_mail_copy_stays_on_the_server() {
    let mut rig = Rig::gmail(&["Work"], Mode::ArchiveDelete, Timing::AfterAll, DeleteMode::MoveToTrash);
    rig.server.add_gmail_msg("m1@t", day(), 50, &["Work"]);
    rig.server.folder_mut("[Gmail]/All Mail").msgs.clear();
    rig.select(&["Work"]);
    done(&mut rig).await;
    assert_eq!(kept(&rig, "Work", KeptReason::NoAllMailCopy), vec![1]);
    assert!(rig.sh.cmds_named("move").is_empty());
    assert_eq!(rig.server.uids_in("Work").len(), 1);
}

#[tokio::test]
async fn a_gmail_copy_that_fails_blocks_its_siblings() {
    let mut rig = Rig::gmail(&["Work", "Clients"], Mode::ArchiveDelete, Timing::AfterAll, DeleteMode::MoveToTrash);
    let pre = rig.server.add_gmail_msg("pre@t", day(), 50, &["Work"]); // Work uid 1
    let shared = rig.server.add_gmail_msg("m1@t", day() + 1000, 50, &["Work", "Clients"]); // Work uid 2, Clients uid 1
    // The Work copy of m1 can never be downloaded.
    rig.server.faults.push(Fault::new("fetch", OpsError::Other("boom".to_string())).uid(2).times(usize::MAX));
    rig.select(&["Work", "Clients"]);
    done(&mut rig).await;
    let moves = rig.sh.cmds_named("move");
    assert_eq!(moves.len(), 1, "only the message whose every copy is safe is deleted");
    assert_eq!(moves[0].1.uids, vec![pre]);
    assert_eq!(rig.server.uids_in("[Gmail]/All Mail"), vec![shared]);
    assert_eq!(kept(&rig, "Work", KeptReason::DownloadFailed), vec![2]);
    assert_eq!(kept(&rig, "Clients", KeptReason::DownloadFailed), vec![1], "the good copy waits with its failed twin");
    assert_eq!(rig.server.uids_in("Clients"), vec![1]);
}

// ── limits, throttling, pacing ──────────────────────────────────────────────

#[tokio::test]
async fn the_daily_allowance_waits_until_utc_midnight_then_continues() {
    let mut rig = Rig::imap(&["INBOX"], Mode::ArchiveDelete, Timing::AfterAll, DeleteMode::MoveToTrash);
    seed(&mut rig, "INBOX", 5);
    let size = rig.server.folder("INBOX").msgs.values().next().unwrap().raw.len() as u64;
    rig.env.limit.set(Some(size * 2 + size / 2));
    rig.select(&["INBOX"]);
    done(&mut rig).await;
    let midnight1 = ms(2026, 9, 30, 0, 0) + 60_000;
    let midnight2 = ms(2026, 10, 1, 0, 0) + 60_000;
    let untils: Vec<i64> = rig.env.sleeps.borrow().iter().map(|s| s.1).collect();
    assert_eq!(untils, vec![midnight1, midnight2]);
    assert_eq!(rig.server.fetches_total, 5);
    let waits = rig
        .env
        .frames
        .borrow()
        .iter()
        .filter(|f| f["status"]["state"] == "waiting" && f["status"]["reason"] == "daily_limit")
        .count();
    assert!(waits >= 2);
    assert_eq!(
        rig.env.frames.borrow().iter().find(|f| f["status"]["reason"] == "daily_limit").unwrap()["status"]["untilMs"],
        serde_json::json!(midnight1)
    );
    assert!(rig.server.uids_in("INBOX").is_empty());
}

#[tokio::test]
async fn a_message_bigger_than_the_whole_day_still_goes_on_a_fresh_day() {
    let mut rig = Rig::imap(&["INBOX"], Mode::ArchiveDelete, Timing::AfterAll, DeleteMode::MoveToTrash);
    seed(&mut rig, "INBOX", 2);
    rig.env.limit.set(Some(10));
    rig.select(&["INBOX"]);
    done(&mut rig).await;
    assert_eq!(rig.server.fetches_total, 2, "it must not wait forever");
}

#[tokio::test]
async fn a_provider_limit_retries_every_hour() {
    let mut rig = Rig::imap(&["INBOX"], Mode::ArchiveDelete, Timing::AfterAll, DeleteMode::MoveToTrash);
    seed(&mut rig, "INBOX", 2);
    rig.server.faults.push(
        Fault::new("fetch", OpsError::ProviderLimit("Account exceeded command or bandwidth limits".to_string())).times(3),
    );
    rig.select(&["INBOX"]);
    done(&mut rig).await;
    assert_eq!(rig.env.slept_ms(), vec![3_600_000, 3_600_000, 3_600_000]);
    let f = rig.env.frames.borrow().iter().find(|f| f["status"]["reason"] == "provider_limit").cloned().unwrap();
    assert_eq!(f["status"]["state"], "waiting");
    assert!(f["providerLimitSinceMs"].is_i64() || f["providerLimitSinceMs"].is_u64());
    assert_eq!(rig.server.uids_in("INBOX").len(), 0);
    assert!(rig.env.last_frame()["providerLimitSinceMs"].is_null(), "cleared after a success");
}

#[tokio::test]
async fn throttling_backs_off_and_never_fails_the_job() {
    let mut rig = Rig::imap(&["INBOX"], Mode::ArchiveDelete, Timing::AfterAll, DeleteMode::MoveToTrash);
    seed(&mut rig, "INBOX", 2);
    rig.server.faults.push(
        Fault::new("fetch", OpsError::Throttled { retry_after_secs: None, text: "[THROTTLED] slow down".to_string() }).times(3),
    );
    rig.select(&["INBOX"]);
    done(&mut rig).await;
    assert_eq!(rig.env.slept_ms(), vec![30_000, 60_000, 120_000]);
    assert!(rig.env.frames.borrow().iter().any(|f| f["status"]["reason"] == "throttled"));
    assert_eq!(rig.server.uids_in("INBOX").len(), 0);
    assert_eq!(kept(&rig, "INBOX", KeptReason::DownloadFailed).len(), 0);
}

#[tokio::test]
async fn too_many_connections_backs_off_from_two_minutes() {
    let mut rig = Rig::imap(&["INBOX"], Mode::ArchiveDelete, Timing::AfterAll, DeleteMode::MoveToTrash);
    seed(&mut rig, "INBOX", 1);
    rig.server.faults.push(
        Fault::new("fetch", OpsError::TooManyConnections("[ALERT] Too many simultaneous connections".to_string())).times(2),
    );
    rig.select(&["INBOX"]);
    done(&mut rig).await;
    assert_eq!(rig.env.slept_ms(), vec![120_000, 240_000]);
}

#[tokio::test]
async fn a_retry_after_longer_than_the_backoff_wins() {
    let mut rig = Rig::imap(&["INBOX"], Mode::ArchiveDelete, Timing::AfterAll, DeleteMode::MoveToTrash);
    seed(&mut rig, "INBOX", 1);
    rig.server.faults.push(Fault::new("fetch", OpsError::Throttled { retry_after_secs: Some(600), text: "429".to_string() }));
    rig.select(&["INBOX"]);
    done(&mut rig).await;
    assert_eq!(rig.env.slept_ms(), vec![600_000]);
}

#[tokio::test]
async fn offline_polls_every_minute() {
    let mut rig = Rig::imap(&["INBOX"], Mode::ArchiveDelete, Timing::AfterAll, DeleteMode::MoveToTrash);
    seed(&mut rig, "INBOX", 1);
    rig.server.faults.push(Fault::new("fetch", OpsError::Offline("dns".to_string())).times(2));
    rig.select(&["INBOX"]);
    done(&mut rig).await;
    assert_eq!(rig.env.slept_ms(), vec![60_000, 60_000]);
    assert!(rig.env.frames.borrow().iter().any(|f| f["status"]["reason"] == "offline"));
}

#[tokio::test]
async fn three_failures_keep_a_message_on_the_server() {
    let mut rig = Rig::imap(&["INBOX"], Mode::ArchiveDelete, Timing::AfterAll, DeleteMode::MoveToTrash);
    seed(&mut rig, "INBOX", 4);
    rig.server.faults.push(Fault::new("fetch", OpsError::Other("boom".to_string())).uid(2).times(usize::MAX));
    rig.select(&["INBOX"]);
    done(&mut rig).await;
    assert_eq!(rig.server.fetch_count.get(&("INBOX".to_string(), 2)), None, "the failing fetch never succeeded");
    assert_eq!(rig.sh.cmds_named("fetch").iter().filter(|(_, c)| c.uids == vec![2]).count(), 3);
    assert_eq!(kept(&rig, "INBOX", KeptReason::DownloadFailed), vec![2]);
    assert_eq!(rig.server.uids_in("INBOX"), vec![2]);
    assert_eq!(rig.server.ids_in("Trash").len(), 3);
    assert_eq!(rig.env.last_saved().status, JobStatus::Completed);
    assert_eq!(rig.env.last_frame()["counts"]["kept"], 1);
    assert_eq!(rig.env.last_frame()["counts"]["keptByReason"]["download_failed"], 1);
}

#[tokio::test]
async fn a_gone_message_is_left_alone() {
    let mut rig = Rig::imap(&["INBOX"], Mode::ArchiveDelete, Timing::AfterAll, DeleteMode::MoveToTrash);
    seed(&mut rig, "INBOX", 3);
    rig.server.faults.push(Fault::new("fetch", OpsError::Gone).uid(2));
    rig.select(&["INBOX"]);
    done(&mut rig).await;
    assert_eq!(kept(&rig, "INBOX", KeptReason::ServerChanged), vec![2]);
    assert_eq!(rig.server.uids_in("INBOX"), vec![2]);
}

#[tokio::test]
async fn a_move_the_server_keeps_refusing_leaves_the_mail_where_it_is() {
    let mut rig = Rig::imap(&["INBOX"], Mode::ArchiveDelete, Timing::AfterAll, DeleteMode::MoveToTrash);
    seed(&mut rig, "INBOX", 2);
    rig.server.faults.push(Fault::new("move", OpsError::Other("NO [CANNOT] nope".to_string())).times(usize::MAX));
    rig.select(&["INBOX"]);
    done(&mut rig).await;
    assert_eq!(kept(&rig, "INBOX", KeptReason::CannotDelete).len(), 2);
    assert_eq!(rig.server.uids_in("INBOX").len(), 2);
    assert_eq!(rig.sh.cmds_named("move").len(), 3, "three tries, then it stops");
}

#[tokio::test]
async fn a_sign_in_failure_pauses_for_a_token() {
    let mut rig = Rig::imap(&["INBOX"], Mode::ArchiveDelete, Timing::AfterAll, DeleteMode::MoveToTrash);
    seed(&mut rig, "INBOX", 3);
    rig.server.faults.push(Fault::new("fetch", OpsError::SignIn("Login failed for a@b.test".to_string())));
    rig.select(&["INBOX"]);
    assert_eq!(rig.plan_and_run().await, RunExit::Paused(PauseReason::SignInNeeded));
    assert_eq!(rig.env.last_saved().status, JobStatus::Paused { reason: PauseReason::SignInNeeded });
    assert_eq!(rig.server.uids_in("INBOX").len(), 3);
    // The token arrives: the worker runs the same job again.
    assert_eq!(rig.run().await, RunExit::Completed);
    assert!(rig.server.uids_in("INBOX").is_empty());
}

#[tokio::test]
async fn no_credentials_pauses_before_any_server_command() {
    let mut rig = Rig::imap(&["INBOX"], Mode::ArchiveDelete, Timing::AfterAll, DeleteMode::MoveToTrash);
    seed(&mut rig, "INBOX", 2);
    rig.select(&["INBOX"]);
    assert_eq!(rig.plan().await, RunExit::Completed);
    let before = rig.sh.server_cmds().len();
    rig.env.creds.set(false);
    assert_eq!(rig.run().await, RunExit::Paused(PauseReason::SignInNeeded));
    assert_eq!(rig.sh.server_cmds().len(), before);
    rig.env.creds.set(true);
    assert_eq!(rig.run().await, RunExit::Completed);
}

// ── control ─────────────────────────────────────────────────────────────────

#[tokio::test]
async fn pause_and_resume_continue_the_same_run() {
    let mut rig = Rig::imap(&["INBOX"], Mode::ArchiveDelete, Timing::AfterAll, DeleteMode::MoveToTrash);
    seed(&mut rig, "INBOX", 4);
    rig.select(&["INBOX"]);
    assert_eq!(rig.plan().await, RunExit::Completed);
    let sh = rig.sh.clone();
    let base = rig.env.yields.get();
    let hook_ctl = rig.ctl.clone();
    *rig.env.on_yield.borrow_mut() = Some(Box::new(move |n| {
        if n == base + 4 {
            hook_ctl.pause.store(true, Ordering::SeqCst);
        }
    }));
    let Rig { job, plans, server, local, env, ctl, .. } = &mut rig;
    let env: &FakeEnv = env;
    let ctl: &Control = ctl;
    let local: &FakeLocal = local;
    let plans: &PlanStore = plans;
    let runner = run(job, plans, server, local, env, ctl);
    let driver = async {
        let mut spins = 0;
        loop {
            if env.frames.borrow().iter().any(|f| f["status"]["state"] == "paused") {
                break;
            }
            spins += 1;
            assert!(spins < 10_000, "the job never paused");
            tokio::task::yield_now().await;
        }
        let before = sh.cmds_named("fetch").len();
        for _ in 0..50 {
            tokio::task::yield_now().await;
        }
        assert_eq!(before, sh.cmds_named("fetch").len(), "the job kept working while paused");
        assert!(before < 4);
        ctl.pause.store(false, Ordering::SeqCst);
        ctl.wake.notify_one();
    };
    let (exit, _) = tokio::join!(runner, driver);
    assert_eq!(exit, RunExit::Completed);
    let states: Vec<JobStatus> = rig.env.statuses();
    assert!(states.contains(&JobStatus::Paused { reason: PauseReason::User }), "the pause was saved");
    assert_eq!(rig.server.fetches_total, 4);
    assert!(rig.server.uids_in("INBOX").is_empty());
}

#[tokio::test]
async fn cancel_keeps_what_was_not_deleted_on_the_server() {
    let mut rig = Rig::imap(&["INBOX"], Mode::ArchiveDelete, Timing::AsSaved, DeleteMode::MoveToTrash);
    seed(&mut rig, "INBOX", 60);
    rig.select(&["INBOX"]);
    let hook_ctl = rig.ctl.clone();
    rig.server.on_fetch = Some(Box::new(move |n| {
        if n == 30 {
            hook_ctl.cancel.store(true, Ordering::SeqCst);
        }
    }));
    assert_eq!(rig.plan_and_run().await, RunExit::Cancelled);
    assert_eq!(rig.env.last_saved().status, JobStatus::Cancelled);
    let frame = rig.env.last_frame();
    assert_eq!(frame["finished"], true);
    assert_eq!(frame["outcome"], "cancelled");
    assert_eq!(rig.server.uids_in("INBOX").len(), 35, "the first batch was already deleted");
    assert_eq!(rig.server.ids_in("Trash").len(), 25);
    assert!(rig.env.last_saved().finished_ms.is_some());
}

#[tokio::test]
async fn a_finished_job_is_not_run_again() {
    let mut rig = Rig::imap(&["INBOX"], Mode::ArchiveDelete, Timing::AfterAll, DeleteMode::MoveToTrash);
    seed(&mut rig, "INBOX", 2);
    rig.select(&["INBOX"]);
    done(&mut rig).await;
    let cmds = rig.sh.server_cmds().len();
    assert_eq!(rig.run().await, RunExit::Completed);
    assert_eq!(rig.sh.server_cmds().len(), cmds);
}

#[tokio::test]
async fn a_failed_save_stops_the_run_before_anything_else_is_sent() {
    let mut rig = Rig::imap(&["INBOX"], Mode::ArchiveDelete, Timing::AfterAll, DeleteMode::MoveToTrash);
    seed(&mut rig, "INBOX", 3);
    rig.select(&["INBOX"]);
    assert_eq!(rig.plan().await, RunExit::Completed);
    let cmds = rig.sh.server_cmds().len();
    rig.env.crash_when(|_, _| true);
    let exit = rig.run().await;
    assert!(matches!(exit, RunExit::Failed(ref m) if m.contains("could not save")), "{exit:?}");
    assert_eq!(rig.sh.server_cmds().len(), cmds, "no command after a failed save");
    // The last good state is still a resumable one.
    assert!(!rig.env.last_saved().status.is_finished());
}

// ── Graph ───────────────────────────────────────────────────────────────────

#[tokio::test]
async fn graph_tally_counts_body_bytes_per_utc_day() {
    let sh = Shared::new(ms(2026, 9, 29, 23, 50));
    let mut server = FakeServer::new(sh.clone(), Provider::Graph);
    server.add_folder("Inbox", FolderRole::Normal);
    server.add_folder("Trash", FolderRole::Trash);
    server.add_msg("Inbox", "g1@t", day(), 100);
    server.add_msg("Inbox", "g2@t", day() + 1000, 300);
    let second = server.folder("Inbox").msgs[&2].raw.len() as u64;
    let clock = sh.clone();
    server.on_fetch = Some(Box::new(move |n| {
        if n == 2 {
            clock.clock.set(ms(2026, 9, 30, 0, 10));
        }
    }));
    let mut rig = Rig::with_server(sh, server, Mode::ArchiveDelete, Timing::AfterAll, DeleteMode::MoveToTrash);
    rig.select(&["Inbox"]);
    done(&mut rig).await;
    let tally = rig.job.graph_tally.clone().unwrap();
    assert_eq!(tally.day, "2026-09-30");
    assert_eq!(tally.bytes, second, "the first day's bytes are not carried over");
    assert_eq!(rig.server.uids_in("Inbox").len(), 0, "Graph messages are moved to Deleted Items too");
    assert_eq!(rig.folder_state("Inbox").deleted.len(), 2);
    assert!(rig.env.last_frame()["counts"]["deleted"] == 2);
}

#[tokio::test]
async fn the_graph_tally_counts_against_the_allowance() {
    let sh = Shared::new(start_ms());
    let mut server = FakeServer::new(sh.clone(), Provider::Graph);
    server.add_folder("Inbox", FolderRole::Normal);
    server.add_folder("Trash", FolderRole::Trash);
    server.add_msg("Inbox", "g1@t", day(), 100);
    server.add_msg("Inbox", "g2@t", day() + 1000, 100);
    let size = server.folder("Inbox").msgs[&1].raw.len() as u64;
    let mut rig = Rig::with_server(sh, server, Mode::ArchiveDelete, Timing::AfterAll, DeleteMode::MoveToTrash);
    // The wire counter sees nothing of Graph; the job's own tally must stop it.
    rig.env.limit.set(Some(size + size / 2));
    rig.select(&["Inbox"]);
    done(&mut rig).await;
    assert_eq!(rig.env.sleeps.borrow().len(), 1, "one wait for the day's limit");
    assert_eq!(rig.server.fetches_total, 2);
}

// ── yielding, listings, frames ──────────────────────────────────────────────

#[tokio::test]
async fn the_engine_yields_before_every_server_command() {
    let mut rig = Rig::imap(&["INBOX", "Work"], Mode::ArchiveBackupDelete, Timing::AsSaved, DeleteMode::MoveToTrashAndEmpty);
    seed(&mut rig, "INBOX", 30);
    seed(&mut rig, "Work", 3);
    rig.select(&["INBOX", "Work"]);
    done(&mut rig).await;
    let tl = rig.sh.timeline.borrow();
    let mut cmds = 0;
    for (i, ev) in tl.iter().enumerate() {
        match ev {
            Ev::Server(_) | Ev::Local("store_archived", _) => {
                assert!(i > 0);
                assert_eq!(tl[i - 1], Ev::Yield, "event {i} ({ev:?}) was not preceded by a yield");
                cmds += 1;
            }
            _ => {}
        }
    }
    assert!(cmds > 30);
    assert!(rig.env.yields.get() >= cmds);
}

#[tokio::test]
async fn the_archived_listing_is_read_once_per_folder_not_per_batch() {
    let mut rig = Rig::imap(&["INBOX"], Mode::ArchiveBackupDelete, Timing::AsSaved, DeleteMode::MoveToTrash);
    seed(&mut rig, "INBOX", 60);
    rig.select(&["INBOX"]);
    done(&mut rig).await;
    assert_eq!(rig.local.listing_count("INBOX"), 2, "once to plan, once to run");
    assert_eq!(rig.local.mirror_copy_calls.get(), 3, "one copy per batch");
    assert_eq!(rig.local.mirror_path_calls.get(), 3, "one exact-path check per delete batch");
    assert_eq!(rig.sh.cmds_named("move").len(), 3);
}

#[tokio::test]
async fn a_delete_batch_reports_its_folders_to_the_local_store() {
    let mut rig = Rig::imap(&["INBOX"], Mode::ArchiveDelete, Timing::AfterAll, DeleteMode::MoveToTrash);
    seed(&mut rig, "INBOX", 3);
    rig.select(&["INBOX"]);
    done(&mut rig).await;
    let hook = rig.local.deleted_hook.borrow().clone();
    assert_eq!(hook, vec![("INBOX".to_string(), vec![1, 2, 3])]);
}

#[tokio::test]
async fn progress_frames_carry_the_contract_shape() {
    let mut rig = Rig::imap(&["INBOX"], Mode::ArchiveBackupDelete, Timing::AsSaved, DeleteMode::MoveToTrashAndEmpty);
    seed(&mut rig, "INBOX", 4);
    rig.select(&["INBOX"]);
    done(&mut rig).await;
    let f = rig.env.last_frame();
    for key in [
        "jobId", "accountId", "accountEmail", "mode", "timing", "deleteMode", "provider", "status", "counts",
        "downloadedBytes", "remainingBytes", "daysLeft", "dailyLimitBytes", "currentFolder", "staleFolders",
        "providerLimitSinceMs", "finished", "outcome", "error", "updatedMs",
    ] {
        assert!(f.get(key).is_some(), "frame lacks {key}: {f}");
    }
    assert_eq!(f["mode"], "archive_backup_delete");
    assert_eq!(f["timing"], "as_saved");
    assert_eq!(f["deleteMode"], "move_to_trash_and_empty");
    assert_eq!(f["provider"], "imap");
    assert_eq!(f["status"], serde_json::json!({"state": "completed"}));
    assert_eq!(f["finished"], true);
    assert_eq!(f["outcome"], "completed");
    assert_eq!(f["counts"]["scoped"], 4);
    assert_eq!(f["counts"]["stored"], 4);
    assert_eq!(f["counts"]["vaultVerified"], 4);
    assert_eq!(f["counts"]["onDrive"], 4);
    assert_eq!(f["counts"]["deleted"], 4);
    assert_eq!(f["counts"]["emptied"], 4);
    assert_eq!(f["counts"]["kept"], 0);
    assert_eq!(f["remainingBytes"], 0);
    let finished_frames = rig.env.frames.borrow().iter().filter(|f| f["finished"] == true).count();
    assert_eq!(finished_frames, 1, "the terminal frame is sent exactly once");
    // A running frame reads as running with its phase.
    let running = rig.env.frames.borrow().iter().find(|f| f["status"]["state"] == "running").cloned().unwrap();
    assert!(running["status"]["phase"].is_string());
    // A frame can also be built from a job file alone (after a restart).
    let from_disk = progress_frame(&rig.env.last_saved(), &FrameInfo::default());
    assert_eq!(from_disk["counts"]["deleted"], 4);
}
