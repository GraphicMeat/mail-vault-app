//! Archive (& back up) & delete from server: the job engine.
//!
//! The engine is generic over three seams so its state machine is tested
//! against in-memory fakes: `ops::ServerOps` (the mail server), `ops::LocalStore`
//! (vault + backup drive) and `ops::Env` (clock, allowance, yield-to-UI, saves,
//! events). The daemon supplies the real implementations. See the Part D design.

pub mod engine;
pub mod graph_ops;
pub mod imap_ops;
pub mod ops;
pub mod plan;
pub mod state;
pub mod throttle;
pub mod uidset;

pub use engine::{plan_job, progress_frame, run, FrameInfo, RunExit};
pub use ops::{
    Caps, Control, Env, Fetched, FolderInfo, ListPage, ListedMsg, LocalError, LocalStore, MoveResult, OpsError,
    ServerOps, StoreOutcome, Stored, Verify, VALIDITY_CHANGED,
};
pub use plan::{
    estimate_days, gmail_scope, in_scope, summarize, year_of, AllMailMap, FolderPlan, LocalCounts, PlanStore,
    PreviewListing, Selection, Summary,
};
pub use state::*;
pub use uidset::UidSet;
