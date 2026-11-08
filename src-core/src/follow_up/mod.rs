//! Follow-up ("remind me if no reply") rules shared by the desktop daemon and
//! the phone engine. The worker that polls servers stays per platform; what
//! counts as a reply lives here.

pub mod matcher;
