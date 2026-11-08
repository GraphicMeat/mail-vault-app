//! What a finished send attempt means for the message: one verdict, one place.
//!
//! Both apps used to map a failed send onto "may have sent" / "terminal" /
//! "retry" with copies of the same three lines (IMAP, Graph, JMAP). The
//! outbox state machines on top (mobile outbox rows, the desktop outbox and
//! Scheduled Send) read the verdict and nothing else.

use crate::smtp::{self, PhasedSendError, SendPhase};

/// The outcome of one send attempt.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SendVerdict {
    /// The server accepted the message.
    Sent,
    /// The failure came after the message could have been accepted (a broken
    /// connection or timeout during or after the upload, Graph's or JMAP's
    /// "may have gone out"). Never sent again on its own: the user decides.
    MayHaveSent,
    /// The server's answer was final (a permanent refusal, a sign-in it
    /// refused, a size limit), so a retry cannot help. Nothing went out.
    Terminal,
    /// Nothing reached the server and a retry may work (no connection, a
    /// throttle, a temporary refusal).
    Transient,
}

impl SendVerdict {
    /// Only a proven not-sent, not-final failure may be sent again by itself.
    pub fn may_retry_automatically(self) -> bool {
        self == SendVerdict::Transient
    }

    /// The message may be on the recipient's side: no automatic resend, and
    /// the user is told to check Sent.
    pub fn is_uncertain(self) -> bool {
        self == SendVerdict::MayHaveSent
    }
}

/// The verdict for a failure described by the three facts every backend
/// reports: which side of the point of no return it fell on, whether the
/// server's answer was permanent (5xx), and the failure text (scrubbed or not).
/// A possible delivery outranks everything else: it is never terminal or retried.
pub fn classify_failure(phase: SendPhase, permanent: bool, message: &str) -> SendVerdict {
    if phase == SendPhase::MayHaveSent {
        SendVerdict::MayHaveSent
    } else if permanent || smtp::is_terminal_send_error(message) {
        SendVerdict::Terminal
    } else {
        SendVerdict::Transient
    }
}

/// [`classify_failure`] for the result of core's phased send. Scrubbing the
/// message never removes the marker phrases the terminal check reads, so the
/// scrubbed and the raw text classify alike.
pub fn classify(result: Result<(), &PhasedSendError>) -> SendVerdict {
    match result {
        Ok(()) => SendVerdict::Sent,
        Err(e) => classify_failure(e.phase, e.permanent, &e.message),
    }
}

/// A failure before any send could start (the message could not be built, the
/// account is gone, no usable settings): nothing went out. `permanent` is a
/// final answer (bad message, gone account); otherwise a retry may work.
pub fn classify_unsent(permanent: bool) -> SendVerdict {
    if permanent { SendVerdict::Terminal } else { SendVerdict::Transient }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn err(phase: SendPhase, permanent: bool, message: &str) -> PhasedSendError {
        PhasedSendError { phase, permanent, message: message.into() }
    }

    #[test]
    fn verdicts_for_every_input_shape() {
        use SendPhase::{MayHaveSent as May, NotSent};
        use SendVerdict::*;
        let cases: [(SendPhase, bool, &str, SendVerdict); 12] = [
            (NotSent, false, "connection refused", Transient),
            (NotSent, false, "timed out connecting", Transient),
            (NotSent, false, "E_JMAP_SUBMIT:serverFail: try later", Transient),
            (NotSent, true, "550 mailbox unavailable", Terminal),
            (NotSent, false, "Authentication failed for smtp.example.com", Terminal),
            (NotSent, false, "Microsoft refused to send as a@b.test.", Terminal),
            (NotSent, false, "E_JMAP_SUBMIT:forbiddenFrom: no", Terminal),
            (NotSent, false, "sign in again please", Transient),
            (May, false, "connection reset during DATA", MayHaveSent),
            (May, true, "x", MayHaveSent),
            (NotSent, false, "Check Sent before trying again: the message may have gone out.", Terminal),
            (May, false, "Check Sent before trying again: the message may have gone out.", MayHaveSent),
        ];
        for (phase, permanent, msg, want) in cases {
            assert_eq!(classify_failure(phase, permanent, msg), want, "{phase:?} {permanent} {msg}");
        }
    }

    #[test]
    fn the_sign_in_marker_is_terminal() {
        let msg = format!("Microsoft rejected the token. {}", smtp::SIGN_IN_AGAIN);
        assert_eq!(classify_failure(SendPhase::NotSent, false, &msg), SendVerdict::Terminal);
    }

    #[test]
    fn classify_reads_a_phased_error_and_a_success() {
        assert_eq!(classify(Ok(())), SendVerdict::Sent);
        let e = err(SendPhase::MayHaveSent, false, "lost the reply");
        assert_eq!(classify(Err(&e)), SendVerdict::MayHaveSent);
        let e = err(SendPhase::NotSent, true, "554 no");
        assert_eq!(classify(Err(&e)), SendVerdict::Terminal);
    }

    #[test]
    fn unsent_failures() {
        assert_eq!(classify_unsent(true), SendVerdict::Terminal);
        assert_eq!(classify_unsent(false), SendVerdict::Transient);
    }

    #[test]
    fn only_transient_retries_and_only_may_have_sent_is_uncertain() {
        for (v, retry, unsure) in [
            (SendVerdict::Sent, false, false),
            (SendVerdict::MayHaveSent, false, true),
            (SendVerdict::Terminal, false, false),
            (SendVerdict::Transient, true, false),
        ] {
            assert_eq!(v.may_retry_automatically(), retry, "{v:?}");
            assert_eq!(v.is_uncertain(), unsure, "{v:?}");
        }
    }
}
