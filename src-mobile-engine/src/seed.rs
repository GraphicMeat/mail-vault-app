//! Synthetic rows for the perf gate. Deterministic: a fixed-seed PRNG, so every run builds the
//! same table. Mixes the shapes that stress a list row: empty sender, very long subject, RTL text,
//! no snippet, attachments, unread, flagged.

use crate::db::{Engine, EngineError};

pub const ACCOUNT_ID: &str = "seed-account";
pub const FOLDER: &str = "INBOX";
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
    engine.write(|c| insert_rows(c, count))
}

/// Makes sure [`ACCOUNT_ID`] / [`FOLDER`] holds at least `count` rows, in one write transaction.
/// Fewer (an empty table, or one left by an older, smaller seed) are topped up by re-running the
/// deterministic seed over uids 1..=count, which rewrites the rows that exist with the same values
/// and adds the rest. Returns whether it wrote anything; a second launch writes nothing.
pub fn ensure_seeded(engine: &Engine, count: usize) -> Result<bool, EngineError> {
    engine.write(|c| {
        let n: i64 = c.query_row(
            "SELECT count(*) FROM messages WHERE account_id = ?1 AND folder = ?2",
            (ACCOUNT_ID, FOLDER),
            |r| r.get(0),
        )?;
        if n >= count as i64 {
            return Ok(false);
        }
        insert_rows(c, count)?;
        Ok(true)
    })
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
