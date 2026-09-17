// The SMTP client (build/send MIME, connection test) lives in
// mailvault_core::smtp so the daemon shares the same implementation. This
// module is a pure re-export — no app-local logic sits on top of it (unlike
// dns.rs, which keeps `mail_dns_health` here).
pub use mailvault_core::smtp::*;
