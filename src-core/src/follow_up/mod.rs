//! Follow-up ("remind me if no reply") rules shared by the desktop daemon and
//! the phone engine. The worker that polls servers stays per platform; what
//! counts as a reply, and the IMAP server check, live here.

pub mod imap_check;
pub mod matcher;
