// The SMTP client (build/send MIME, connection test) lives in
// mailvault_core::smtp so the daemon shares the same implementation. This
// module is a pure re-export — no app-local logic sits on top of it.
// (dns.rs used to be the file with app-local logic on top of a re-export,
// `mail_dns_health`; Task 5.8 moved that into mailvault_core::dns too, and
// with nothing left calling into it -- same as this file today, dead since
// Task 5.5 moved every smtp_* command to the daemon -- deleted dns.rs
// outright instead of leaving an unreferenced file. This file's own
// cleanup is 5.9's job, not 5.8's; left as-is here.)
pub use mailvault_core::smtp::*;
