//! A compact set of uids: sorted, merged, inclusive ranges.
//!
//! Serialized as the IMAP set string (`"1:500,502,600:900"`), so 300k uids
//! processed in order cost a few bytes and only exceptions fragment the set.

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::collections::BTreeMap;

#[derive(Clone, Default, PartialEq, Eq, Debug)]
pub struct UidSet(BTreeMap<u32, u32>); // start -> end (inclusive)

impl UidSet {
    pub fn new() -> Self {
        UidSet(BTreeMap::new())
    }

    pub fn from_uids(uids: impl IntoIterator<Item = u32>) -> Self {
        let mut s = UidSet::new();
        s.extend(uids);
        s
    }

    pub fn insert(&mut self, uid: u32) {
        if self.contains(uid) {
            return;
        }
        self.insert_range(uid, uid);
    }

    /// Add `a..=b` (both inclusive, `a <= b`), merging with every range it
    /// overlaps or touches.
    fn insert_range(&mut self, a: u32, b: u32) {
        let mut start = a;
        let mut end = b;
        let left = self.0.range(..=a).next_back().map(|(&s, &e)| (s, e));
        if let Some((s, e)) = left {
            if e.saturating_add(1) >= a {
                start = start.min(s);
                end = end.max(e);
                self.0.remove(&s);
            }
        }
        let hi = b.saturating_add(1);
        let keys: Vec<u32> = self.0.range(a..=hi).map(|(&s, _)| s).collect();
        for s in keys {
            if let Some(e) = self.0.remove(&s) {
                end = end.max(e);
            }
        }
        self.0.insert(start, end);
    }

    pub fn extend(&mut self, uids: impl IntoIterator<Item = u32>) {
        for u in uids {
            self.insert(u);
        }
    }

    pub fn remove(&mut self, uid: u32) {
        let found = self.0.range(..=uid).next_back().map(|(&s, &e)| (s, e));
        if let Some((s, e)) = found {
            if e >= uid {
                self.0.remove(&s);
                if s < uid {
                    self.0.insert(s, uid - 1);
                }
                if uid < e {
                    self.0.insert(uid + 1, e);
                }
            }
        }
    }

    pub fn contains(&self, uid: u32) -> bool {
        self.0.range(..=uid).next_back().map_or(false, |(_, &e)| e >= uid)
    }

    pub fn len(&self) -> u64 {
        self.0.iter().map(|(&s, &e)| (e - s) as u64 + 1).sum()
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    pub fn iter(&self) -> impl Iterator<Item = u32> + '_ {
        self.0.iter().flat_map(|(&s, &e)| s..=e)
    }

    pub fn difference(&self, other: &UidSet) -> UidSet {
        let mut out = UidSet::new();
        for u in self.iter() {
            if !other.contains(u) {
                out.insert(u);
            }
        }
        out
    }

    /// `""` when empty.
    pub fn to_imap(&self) -> String {
        let mut parts: Vec<String> = Vec::with_capacity(self.0.len());
        for (&s, &e) in self.0.iter() {
            if s == e {
                parts.push(s.to_string());
            } else {
                parts.push(format!("{s}:{e}"));
            }
        }
        parts.join(",")
    }

    /// Rejects anything that is not `n` or `n:m` (`n <= m`, both >= 1) joined
    /// by commas. Never panics. The empty string is the empty set.
    pub fn parse(s: &str) -> Result<UidSet, String> {
        let s = s.trim();
        let mut out = UidSet::new();
        if s.is_empty() {
            return Ok(out);
        }
        for tok in s.split(',') {
            let tok = tok.trim();
            let num = |t: &str| -> Result<u32, String> {
                if t.is_empty() || !t.bytes().all(|b| b.is_ascii_digit()) {
                    return Err(format!("bad uid set element '{tok}'"));
                }
                let n: u32 = t.parse().map_err(|_| format!("bad uid set element '{tok}'"))?;
                if n == 0 {
                    return Err(format!("bad uid set element '{tok}'"));
                }
                Ok(n)
            };
            match tok.split_once(':') {
                Some((a, b)) => {
                    let (a, b) = (num(a)?, num(b)?);
                    if a > b {
                        return Err(format!("reversed range '{tok}'"));
                    }
                    out.insert_range(a, b);
                }
                None => {
                    let n = num(tok)?;
                    out.insert_range(n, n);
                }
            }
        }
        Ok(out)
    }
}

impl Serialize for UidSet {
    fn serialize<S: Serializer>(&self, ser: S) -> Result<S::Ok, S::Error> {
        ser.serialize_str(&self.to_imap())
    }
}

impl<'de> Deserialize<'de> for UidSet {
    fn deserialize<D: Deserializer<'de>>(de: D) -> Result<Self, D::Error> {
        let s = String::deserialize(de)?;
        UidSet::parse(&s).map_err(serde::de::Error::custom)
    }
}
