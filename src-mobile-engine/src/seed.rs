//! Synthetic rows for the perf gate. Deterministic: a fixed-seed PRNG, so every run builds the
//! same table. Mixes the shapes that stress a list row: empty sender, very long subject, RTL text,
//! no snippet, attachments, unread, flagged.

use crate::db::{Engine, EngineError};

pub const ACCOUNT_ID: &str = "seed-account";
pub const FOLDER: &str = "INBOX";
/// A second account with an empty inbox, for the account switcher (no messages, no secret).
pub const SECOND_ACCOUNT_ID: &str = "seed-account-2";
/// Rows the perf gate scrolls through; the shell seeds this many on first open.
pub const PERF_ROWS: usize = 10_000;
const SEED: u64 = 0x4D41_494C_5641_554C;
/// Newest seeded message, 2026-11-05 00:00:00 UTC.
const NEWEST_MS: i64 = 1_793_836_800_000;

/// splitmix64: tiny, no dependency, good enough for fixture variety.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

const WORDS: &[&str] = &[
    "invoice", "meeting", "update", "weekend", "report", "photos", "schedule", "receipt", "reminder", "draft",
    "project", "budget", "travel", "review", "ticket", "welcome", "security", "newsletter", "order", "feedback",
];
const NAMES: &[&str] = &["Ada Lovelace", "Grace Hopper", "Linus T", "Marie Curie", "Jonas Petrauskas", "Ūla Žemaitė"];
const RTL_SUBJECTS: &[&str] = &["חשבונית לחודש נובמבר", "اجتماع الفريق غدا الساعة العاشرة", "תזכורת: תשלום ארנונה"];

fn sentence(rng: &mut Rng, words: u64) -> String {
    (0..words).map(|_| WORDS[rng.below(WORDS.len() as u64) as usize]).collect::<Vec<_>>().join(" ")
}

/// Replaces nothing: adds `count` rows (uids 1..=count) for [`ACCOUNT_ID`] / [`FOLDER`].
pub fn seed(engine: &Engine, count: usize) -> Result<(), EngineError> {
    engine.write(|c| {
        insert_account_and_folder(c, count)?;
        insert_rows(c, count)
    })
}

/// Makes sure [`ACCOUNT_ID`] / [`FOLDER`] holds at least `count` rows, in one write transaction.
/// Fewer (an empty table, or one left by an older, smaller seed) are topped up by re-running the
/// deterministic seed over uids 1..=count, which rewrites the rows that exist with the same values
/// and adds the rest. Returns whether it wrote anything; a second launch writes nothing.
pub fn ensure_seeded(engine: &Engine, count: usize) -> Result<bool, EngineError> {
    engine.write(|c| {
        insert_showcase(c)?;
        let n: i64 = c.query_row(
            "SELECT count(*) FROM messages WHERE account_id = ?1 AND folder = ?2",
            (ACCOUNT_ID, FOLDER),
            |r| r.get(0),
        )?;
        let wrote = n < count as i64;
        if wrote {
            insert_account_and_folder(c, count)?;
            insert_rows(c, count)?;
        }
        insert_showcase_bodies(c)?;
        Ok(wrote)
    })
}

/// A newsletter (remote images, a tracking pixel, links, an attachment) for the newest seeded row,
/// a plain text mail with links for the next, the network probe for the third and a large
/// newsletter for the fourth, cached as fetched bodies, so the viewer has
/// something to draw in screenshots without a server. `INSERT OR IGNORE` on every launch.
const SHOWCASE_HTML: &str = r##"<!doctype html><html><head><meta charset="utf-8"><title>Garden notes</title>
<style>.wrap{max-width:600px;margin:0 auto;font-family:Georgia,serif;color:#2d2a26}
.hero{background:#2f5d50;color:#fff;padding:28px 24px}.hero h1{margin:0;font-size:26px}
.card{padding:20px 24px;background:#fbf8f1;border-bottom:1px solid #e7e0d2}.btn{display:inline-block;padding:10px 18px;background:#c8553d;color:#fff;border-radius:6px;text-decoration:none}
@media (prefers-color-scheme: dark){.card{background:#171717}}</style></head>
<body style="margin:0;background:#efe9dc"><div class="wrap">
<a class="hero" href="https://example.com/garden" style="display:block;text-decoration:none"><h1>Garden notes, November</h1><p style="margin:8px 0 0">Bulbs, frost cloth and a soup to end the season.</p></a>
<img src="https://images.example.test/hero-tulips.jpg" alt="Tulip bulbs on a potting bench" width="600" height="300" style="display:block;width:100%;height:auto;background:#d9cfbb">
<div class="card"><h2 style="margin-top:0">Plant now, thank yourself in April</h2>
<p>Tulips want cold soil. Set them three bulbs deep, pointy end up, and water once. Read the full planting guide on <a href="https://example.com/">example.com</a>.</p>
<p><a class="btn" href="https://example.com/guide">Open the guide</a></p></div>
<div class="card"><h2 style="margin-top:0">Frost cloth, two ways</h2>
<img src="https://images.example.test/frost-cloth.jpg" alt="Rows covered with white cloth" width="552" height="240" style="width:100%;height:auto;background:#d9cfbb">
<p>Drape it at dusk, weigh the edges, take it off by mid-morning.</p></div>
<p style="padding:16px 24px;font-size:12px;color:#6b6358">You get this because you subscribed. <a href="https://example.com/unsubscribe" target="_self">Unsubscribe</a></p>
<img src="https://t.example.test/open.gif?u=42" width="1" height="1" alt="">
</div></body></html>"##;

const SHOWCASE_TEXT: &str = "Hi,\n\nThe minutes from Tuesday are below. The shared folder is at https://example.com/minutes\nand the booking form at www.example.com/rooms.\n\nAgenda:\n  1. Budget <draft> & timeline\n  2. Ask ann@example.test about the venue\n\nThanks,\nJonas\n";

/// The network probe (third newest row): every way a mail can try to reach a server, each on its
/// own https port of a request logger the device run starts on the host (`127.0.0.1` from the
/// iOS simulator, `10.0.2.2` from the Android emulator). https throughout, so the platform's
/// cleartext policy blocks nothing: what stays quiet is held by the frame. A TLS hello on a port
/// names the vector. Before Load images no port may be reached; after it only image loads
/// (9007, 9008, 9014, 9020).
const PROBE_HEAD: &str = r##"<meta http-equiv="refresh" content="0;url=https://HOST:9001/refresh">
<link rel="dns-prefetch" href="https://HOST:9002/"><link rel="preconnect" href="https://HOST:9003/"><link rel="stylesheet" href="https://HOST:9004/link.css">
<style>@import url(https://HOST:9005/import.css); @font-face{font-family:Probe;src:url(https://HOST:9006/font.woff)} body{font-family:Probe,serif} .bg{background:url(https://HOST:9007/bg.png)}</style>"##;
const PROBE_BODY: &str = r##"<p class="bg">Probe for HOST</p>
<div style="width:40px;height:40px;background:url(https://HOST:9008/inline-bg.png)"></div>
<template shadowrootmode="open"><link rel="stylesheet" href="https://HOST:9009/shadow.css"><img src="https://HOST:9010/shadow.png"></template>
<iframe src="https://HOST:9011/iframe"></iframe><object data="https://HOST:9012/object"></object><embed src="https://HOST:9013/embed">
<video poster="https://HOST:9014/poster.png" src="https://HOST:9015/video.mp4"></video>
<a href="#top" ping="https://HOST:9016/ping">a ping link</a>
<form action="https://HOST:9017/form" method="post"><input name="a" value="b"><button>Send</button></form>
<svg width="20" height="20"><image href="https://HOST:9018/svg.png" width="20" height="20"/></svg>
<audio src="https://HOST:9019/audio.mp3"></audio>
<img src="https://HOST:9020/img.png" width="40" height="40" alt="https image">
<a href="https://HOST:9021/link">a link (never tapped)</a>"##;
const PROBE_HOSTS: [&str; 2] = ["127.0.0.1", "10.0.2.2"];

fn probe_html() -> String {
    let each = |t: &str| PROBE_HOSTS.iter().map(|h| t.replace("HOST", h)).collect::<String>();
    format!("<!doctype html><html><head><title>Network probe</title>{}</head><body><h1>Network probe</h1>{}</body></html>", each(PROBE_HEAD), each(PROBE_BODY))
}

/// A real-world-sized newsletter (about 250 KB of html: a stylesheet and some 130 story cards,
/// each a table with an image, a paragraph and a link), for timing a large open.
fn large_newsletter() -> String {
    const PARA: &str = "Our gardens changed a lot this season, and so did the way we plan them. We moved the beds closer to the house, swapped half the lawn for clover, and kept a log of what the frost took and what it spared. The notes below are the short version: what to sow, what to cover, what to leave alone until spring, and which tools earned their place in the shed. Every story links to the long version with photos, measurements and the mistakes we made along the way, so you can skip the ones you already know and dig into the ones you do not. ";
    let mut out = String::from(r##"<!doctype html><html><head><meta charset="utf-8"><title>Weekly digest</title><style>
.wrap{max-width:600px;margin:0 auto;background:#ffffff}.card td{padding:16px 20px;font:15px/1.55 Georgia,serif;color:#2d2a26}
.card h2{margin:0 0 8px;font-size:20px}.more{display:inline-block;margin-top:8px;color:#c8553d;font-weight:bold}
@media (max-width:480px){.card td{padding:12px}}</style></head><body style="margin:0;background:#efe9dc"><div class="wrap">"##);
    let mut n = 0;
    while out.len() < 250_000 {
        n += 1;
        out.push_str(&format!(
            r##"<table class="card" role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-bottom:1px solid #e7e0d2"><tr><td>
<h2>Story {n}: notes from the beds</h2>
<img src="https://images.example.test/story-{n}.jpg" width="560" height="220" alt="Story {n}" style="display:block;width:100%;height:auto;background:#d9cfbb">
<p>{PARA}{PARA}</p><a class="more" href="https://example.com/story/{n}">Read story {n}</a></td></tr></table>
"##
        ));
    }
    out.push_str("</div></body></html>");
    out
}

fn insert_showcase_bodies(c: &rusqlite::Connection) -> Result<(), rusqlite::Error> {
    let mut st = c.prepare("SELECT uid FROM messages WHERE account_id = ?1 AND folder = ?2 ORDER BY date_ms DESC, uid DESC LIMIT 4")?;
    let uids = st.query_map((ACCOUNT_ID, FOLDER), |r| r.get::<_, i64>(0))?.collect::<Result<Vec<_>, _>>()?;
    if let Some(&uid) = uids.first() {
        crate::body::seed_body(c, ACCOUNT_ID, FOLDER, uid, Some(SHOWCASE_HTML), None, &[("Planting calendar 2027.pdf", "application/pdf", 245_760)])?;
    }
    if let Some(&uid) = uids.get(1) {
        crate::body::seed_body(c, ACCOUNT_ID, FOLDER, uid, None, Some(SHOWCASE_TEXT), &[])?;
    }
    if let Some(&uid) = uids.get(2) {
        crate::body::seed_body(c, ACCOUNT_ID, FOLDER, uid, Some(&probe_html()), None, &[])?;
    }
    if let Some(&uid) = uids.get(3) {
        crate::body::seed_body(c, ACCOUNT_ID, FOLDER, uid, Some(&large_newsletter()), None, &[])?;
    }
    Ok(())
}

/// The account and INBOX folder rows the seeded messages hang off. No secret: nothing connects.
fn insert_account_and_folder(c: &rusqlite::Connection, count: usize) -> Result<(), rusqlite::Error> {
    c.execute(
        "INSERT OR IGNORE INTO accounts (id, email, display_name, imap_host, imap_port, security, created_ms)
         VALUES (?1, 'seed@example.test', 'Seed', 'localhost', 993, 'ssl', ?2)",
        (ACCOUNT_ID, NEWEST_MS),
    )?;
    c.execute(
        "INSERT OR REPLACE INTO folders (account_id, path, name, special_use, delimiter, noselect, uid_validity, uid_next, unseen, total, synced_ms)
         VALUES (?1, ?2, ?2, '\\Inbox', '/', 0, 1, ?3, 0, ?4, ?5)",
        (ACCOUNT_ID, FOLDER, count as i64 + 1, count as i64, NEWEST_MS),
    )?;
    Ok(())
}

/// A second account and a few more folders, so the account switcher and the folder drawer have
/// something to show in screenshots. Rows only, no messages: nothing here can sync (no secret).
/// `INSERT OR IGNORE`, so every launch may run it and an existing install gains them too.
fn insert_showcase(c: &rusqlite::Connection) -> Result<(), rusqlite::Error> {
    c.execute(
        "INSERT OR IGNORE INTO accounts (id, email, display_name, imap_host, imap_port, security, created_ms)
         VALUES (?1, 'work@example.test', 'Work', 'localhost', 993, 'ssl', ?2)",
        (SECOND_ACCOUNT_ID, NEWEST_MS + 1),
    )?;
    let folders: &[(&str, &str, &str, Option<&str>, i64, i64)] = &[
        (ACCOUNT_ID, "Drafts", "Drafts", Some("\\Drafts"), 0, 0),
        (ACCOUNT_ID, "Sent", "Sent", Some("\\Sent"), 0, 0),
        (ACCOUNT_ID, "Archive", "Archive", Some("\\Archive"), 0, 0),
        (ACCOUNT_ID, "Junk", "Junk", Some("\\Junk"), 12, 0),
        (ACCOUNT_ID, "Trash", "Trash", Some("\\Trash"), 0, 0),
        (ACCOUNT_ID, "Projects", "Projects", None, 0, 1),
        (ACCOUNT_ID, "Projects/Garden", "Garden", None, 3, 0),
        (ACCOUNT_ID, "Projects/Taxes 2026", "Taxes 2026", None, 0, 0),
        (SECOND_ACCOUNT_ID, "INBOX", "INBOX", Some("\\Inbox"), 4, 0),
    ];
    for (account, path, name, special, unseen, noselect) in folders {
        c.execute(
            "INSERT OR IGNORE INTO folders (account_id, path, name, special_use, delimiter, noselect, uid_validity, uid_next, unseen, total, synced_ms)
             VALUES (?1, ?2, ?3, ?4, '/', ?5, 1, 1, ?6, 0, ?7)",
            (account, path, name, special, noselect, unseen, NEWEST_MS),
        )?;
    }
    Ok(())
}

fn insert_rows(c: &rusqlite::Connection, count: usize) -> Result<(), rusqlite::Error> {
    let mut rng = Rng(SEED);
    let mut st = c.prepare(
        "INSERT OR REPLACE INTO messages
         (account_id, folder, uid, subject, from_name, from_address, date_ms, snippet, seen, flagged, has_attachments)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
    )?;
    for i in 0..count {
        let uid = i as i64 + 1;
        let subject = match rng.below(10) {
            0 => RTL_SUBJECTS[rng.below(RTL_SUBJECTS.len() as u64) as usize].to_string(),
            1 => format!("{} {}", sentence(&mut rng, 30), "x".repeat(200)),
            2 => String::new(),
            _ => {
                let n = 2 + rng.below(6);
                sentence(&mut rng, n)
            }
        };
        let (from_name, from_address) = if rng.below(8) == 0 {
            (String::new(), format!("noreply{}@example.test", rng.below(50)))
        } else {
            let n = NAMES[rng.below(NAMES.len() as u64) as usize];
            (n.to_string(), format!("user{}@example.test", rng.below(500)))
        };
        let snippet = if rng.below(6) == 0 { String::new() } else {
            let n = 8 + rng.below(30);
            sentence(&mut rng, n)
        };
        // Spread over roughly 3 years, shuffled against uid so order is not just uid order.
        let date_ms = NEWEST_MS - (rng.below(3 * 365 * 24 * 3600) as i64) * 1000 - rng.below(1000) as i64;
        st.execute((
            ACCOUNT_ID,
            FOLDER,
            uid,
            subject,
            from_name,
            from_address,
            date_ms,
            snippet,
            (rng.below(3) != 0) as i64,
            (rng.below(12) == 0) as i64,
            (rng.below(5) == 0) as i64,
        ))?;
    }
    Ok(())
}
