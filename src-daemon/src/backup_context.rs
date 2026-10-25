//! Ordered observations only. Retirement and delayed lifecycle decisions stay native.
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashSet};

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Observation {
    pub surface_id: String,
    pub session_id: String,
    pub sequence: u64,
    pub kind: String,
    pub last_activity_at: Option<i64>,
    pub loading: Option<bool>,
    pub visibility: Option<String>,
    pub online: Option<bool>,
    pub observed_at: Option<i64>,
    pub heartbeat_gap: Option<i64>,
}
impl Observation {
    pub fn parse(value: &Value) -> Result<Self, String> {
        let o: Self =
            serde_json::from_value(value.clone()).map_err(|_| "errors.settingsInvalid")?;
        let identity = [&o.surface_id, &o.session_id]
            .iter()
            .all(|s| !s.is_empty() && s.len() <= 256);
        let retire = o.kind == "retire";
        let facts = o.last_activity_at.is_some_and(|t| t >= 0)
            && o.observed_at.is_some_and(|t| t >= 0)
            && o.loading.is_some()
            && o.online.is_some()
            && matches!(o.visibility.as_deref(), Some("visible" | "hidden"));
        if !identity
            || o.sequence == 0
            || (!retire && (!matches!(o.kind.as_str(), "attach" | "update") || !facts))
            || o.heartbeat_gap.is_some_and(|g| g < 0)
            || (retire
                && (o.loading.is_some()
                    || o.online.is_some()
                    || o.visibility.is_some()
                    || o.last_activity_at.is_some()
                    || o.observed_at.is_some()
                    || o.heartbeat_gap.is_some()))
        {
            return Err("errors.settingsInvalid".into());
        }
        Ok(o)
    }
}
#[derive(Default, Clone)]
struct Surface {
    sequence: u64,
    retired: bool,
    live: bool,
    loading: bool,
    observed: i64,
    online: bool,
    visible: bool,
    wake_at: Option<i64>,
    visible_at: Option<i64>,
}
#[derive(Default)]
pub(super) struct Context {
    sessions: BTreeMap<(String, String), Surface>,
    destroyed: HashSet<String>,
    retired_generations: HashSet<String>,
    pub last_activity: i64,
    network_at: i64,
    offline: bool,
}
impl Context {
    pub fn observe(&mut self, o: Observation, now: i64) -> Value {
        let key = (o.surface_id.clone(), o.session_id.clone());
        let s = self.sessions.entry(key).or_default();
        let accepted = !o.surface_id.rsplit_once(':').is_some_and(|(generation,_)|self.retired_generations.contains(generation))
            && !self.destroyed.contains(&o.surface_id)
            && !s.retired
            && o.sequence > s.sequence
            && (o.kind != "update" || s.live);
        if accepted {
            s.sequence = o.sequence;
            if o.kind == "retire" {
                s.retired = true;
                s.live = false;
                s.wake_at = None;
                s.visible_at = None;
            } else {
                let was_live = s.live;
                s.live = true;
                s.loading = o.loading.unwrap();
                self.last_activity = self.last_activity.max(o.last_activity_at.unwrap());
                let observed = o.observed_at.unwrap();
                if observed >= s.observed {
                    s.observed = observed;
                    s.online = o.online.unwrap();
                    if observed >= self.network_at {
                        if self.offline && s.online {
                            s.wake_at = Some(now.saturating_add(12_000));
                        }
                        self.network_at = observed;
                        self.offline = !s.online;
                    }
                    let visible = o.visibility.as_deref() == Some("visible");
                    if was_live && visible && !s.visible {
                        s.visible_at = Some(now.saturating_add(17_000));
                    }
                    s.visible = visible;
                    if o.heartbeat_gap.is_some_and(|g| g > 150_000) {
                        s.wake_at = Some(now.saturating_add(12_000));
                    }
                }
            }
        }
        json!({"accepted":accepted,"surfaceId":o.surface_id,"sessionId":o.session_id,"sequence":s.sequence,"retired":s.retired})
    }
    pub fn retire_surface(&mut self, surface: Option<&str>) {
        if let Some(id) = surface {
            self.destroyed.insert(id.into());
        }
        for ((id, _), s) in &mut self.sessions {
            if surface.is_none_or(|id_to_retire| id == id_to_retire) {
                s.retired = true;
                s.live = false;
                s.wake_at = None;
                s.visible_at = None;
            }
        }
    }
    pub fn retire_generation(&mut self, generation: &str) {
        self.retired_generations.insert(generation.into());
        for ((id,_), source) in &mut self.sessions {
            if id.rsplit_once(':').is_some_and(|(prefix,_)|prefix == generation) {
                source.retired = true; source.live = false; source.wake_at = None; source.visible_at = None;
            }
        }
    }
    pub fn observed(&self) -> bool {
        !self.sessions.is_empty()
    }
    pub fn loading(&self) -> bool {
        self.sessions.values().any(|s| s.live && s.loading)
    }
    pub fn interrupted(&self, now: i64) -> bool {
        self.offline
            || self
                .sessions
                .values()
                .any(|s| s.live && s.wake_at.is_some_and(|at| at > now))
    }
    pub fn paused(&self, now: i64) -> bool {
        self.interrupted(now)
            || self
                .sessions
                .values()
                .any(|s| s.live && s.visible_at.is_some_and(|at| at > now))
    }
    pub fn deadline(&self, now: i64) -> Option<i64> {
        self.sessions
            .values()
            .filter(|s| s.live)
            .flat_map(|s| [s.wake_at, s.visible_at])
            .flatten()
            .filter(|at| *at > now)
            .min()
    }
}
