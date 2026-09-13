use super::*;

fn eml(subject: &str) -> Vec<u8> {
    format!("From: A <a@x.test>\r\nTo: b@x.test\r\nSubject: {subject}\r\nMessage-ID: <{subject}@x.test>\r\nDate: Sat, 12 Sep 2026 10:00:00 +0000\r\nContent-Type: text/plain\r\n\r\nbody of {subject}\r\n").into_bytes()
}

#[test]
fn batch_keeps_one_slot_per_requested_uid_in_order() {
    let tmp = tempfile::tempdir().unwrap();
    let cur = tmp.path();
    std::fs::write(cur.join("5:2,S.eml"), eml("five")).unwrap();
    std::fs::write(cur.join("9:2,AF.eml"), eml("nine")).unwrap();
    std::fs::write(cur.join("12.eml"), eml("legacy")).unwrap(); // no colon: not a vault row
    std::fs::write(cur.join("14:2,.eml"), b"\xff\xfe not mime at all").unwrap();

    let out = read_light_batch_in(cur, &[9, 404, 5, 12, 14]);
    assert_eq!(out.len(), 5);
    let nine = out[0].as_ref().expect("uid 9");
    assert_eq!(nine.uid, 9);
    assert_eq!(nine.subject, "nine");
    assert!(nine.flags.iter().any(|f| f == "archived"));
    assert!(nine.flags.iter().any(|f| f == "\\Flagged"));
    assert!(out[1].is_none(), "missing uid");
    assert_eq!(out[2].as_ref().expect("uid 5").text.as_deref().map(str::trim), Some("body of five"));
    assert!(out[3].is_none(), "legacy name without colon stays invisible, as before");
}

#[test]
fn batch_matches_the_per_uid_lookup_it_replaces() {
    let tmp = tempfile::tempdir().unwrap();
    let cur = tmp.path();
    for uid in 1..=40u32 {
        std::fs::write(cur.join(format!("{uid}:2,S.eml")), eml(&format!("m{uid}"))).unwrap();
    }
    let uids: Vec<u32> = (0..=41).rev().collect();
    let batch = read_light_batch_in(cur, &uids);
    for (i, uid) in uids.iter().enumerate() {
        let single = find_file_by_uid(cur, *uid).and_then(|p| {
            let name = p.file_name()?.to_string_lossy().to_string();
            parse_eml_bytes_light(&std::fs::read(&p).ok()?, *uid, parse_flags_from_filename(&name)).ok()
        });
        assert_eq!(
            serde_json::to_value(&batch[i]).unwrap(),
            serde_json::to_value(&single).unwrap(),
            "uid {uid}"
        );
    }
}

#[test]
fn read_light_at_survives_a_rename_after_the_listing() {
    let tmp = tempfile::tempdir().unwrap();
    let cur = tmp.path();
    std::fs::write(cur.join("7:2,FS.eml"), eml("seven")).unwrap();

    let seven = read_light_at(cur, 7, Some(&cur.join("7:2,S.eml"))).expect("stale hint falls back to the uid lookup");
    assert_eq!(seven.uid, 7);
    assert!(seven.flags.iter().any(|f| f == "\\Flagged"));
    assert!(seven.flags.iter().any(|f| f == "\\Seen"));

    assert!(read_light_at(cur, 8, Some(&cur.join("8:2,.eml"))).is_none(), "no uid-8 file anywhere");
}
