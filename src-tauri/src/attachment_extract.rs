//! The platform seam for PDF/OCR text extraction. Starts as a no-op on every
//! platform; Task 7 (macOS PDFKit/Vision) and Task 8 (non-macOS pdf-extract
//! subprocess) replace `current_extractor()`'s body without touching any of
//! its callers.

use mailvault_core::search_index::attachments::{ExtractError, TextExtractor};

#[cfg(target_os = "macos")]
mod imp {
    use super::{ExtractError, TextExtractor};
    use objc2::AllocAnyThread;
    use objc2_foundation::NSData;
    use objc2_pdf_kit::PDFDocument;

    pub struct NativeExtractor;

    impl TextExtractor for NativeExtractor {
        fn pdf_text_layer(&self, bytes: &[u8]) -> Result<(String, usize), ExtractError> {
            let data = NSData::with_bytes(bytes);
            let doc = unsafe { PDFDocument::initWithData(PDFDocument::alloc(), &data) };
            // `initWithData` returns `None` when the bytes don't parse as a
            // PDF at all (truncated, corrupt, mislabeled) — not specifically
            // because it's encrypted. A structurally valid encrypted PDF
            // constructs fine and is caught by `isLocked()` below.
            let Some(doc) = doc else {
                return Err(ExtractError::Permanent("failed"));
            };
            if unsafe { doc.isLocked() } {
                return Err(ExtractError::Permanent("encrypted"));
            }
            let pages = unsafe { doc.pageCount() } as usize;
            let text = unsafe { doc.string() }.map(|s| s.to_string()).unwrap_or_default();
            Ok((text, pages.max(1)))
        }

        fn pdf_ocr(&self, _bytes: &[u8], _max_pages: usize) -> Result<String, ExtractError> {
            // Rendering pages to images (PDFPage::thumbnailOfSize_forBox, an
            // NSImage — AppKit, not covered by objc2-pdf-kit/objc2-vision
            // alone) and running Vision on each is real work beyond a first
            // pass; land text-layer PDFs and standalone image OCR first, then
            // a follow-up wires PDFPage -> NSImage -> CGImage -> Vision.
            Err(ExtractError::Permanent("unsupported"))
        }

        fn image_ocr(&self, bytes: &[u8], _mime: &str) -> Result<String, ExtractError> {
            use objc2_foundation::NSArray;
            use objc2_vision::{VNImageRequestHandler, VNRecognizeTextRequest, VNRequest, VNRequestTextRecognitionLevel};

            let data = NSData::with_bytes(bytes);
            let handler = VNImageRequestHandler::initWithData_options(
                VNImageRequestHandler::alloc(),
                &data,
                &objc2_foundation::NSDictionary::new(),
            );

            let request = VNRecognizeTextRequest::new();
            request.setRecognitionLevel(VNRequestTextRecognitionLevel::Accurate);

            let request_ref: &VNRequest = &request;
            let requests = NSArray::from_slice(&[request_ref]);
            if handler.performRequests_error(&requests).is_err() {
                return Err(ExtractError::Transient("vision request failed".into()));
            }

            // `performRequests_error`'s `Err` only covers scheduling-level
            // failure; the synchronous objc2-vision 0.3.2 API has no
            // per-request `.error()` to tell "genuinely found nothing" apart
            // from "failed internally" when `results()` comes back `None`.
            // Treat `None` as retryable rather than risk recording a false
            // "ok" that never gets another sweep. `Some(empty array)` means
            // Vision ran fine and found zero text regions — that's a real
            // empty-text success, not a failure.
            let results = request.results();
            let Some(results) = results else {
                return Err(ExtractError::Transient("vision returned no results".into()));
            };
            let mut out = String::new();
            for obs in results.iter() {
                if let Some(candidate) = obs.topCandidates(1).iter().next() {
                    out.push_str(&candidate.string().to_string());
                    out.push('\n');
                }
            }
            Ok(out)
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use super::{ExtractError, TextExtractor};
    use std::io::Write;
    use std::process::{Command, Stdio};
    use std::time::Duration;

    pub struct NativeExtractor;

    impl TextExtractor for NativeExtractor {
        fn pdf_text_layer(&self, bytes: &[u8]) -> Result<(String, usize), ExtractError> {
            // `pdf-extract` panics on malformed input, and a panic here would
            // take the whole app (or the search-index worker thread) down
            // with it. Re-exec ourselves as `mailvault --extract-pdf` so the
            // parsing happens in a disposable child process instead: see
            // `extract_pdf_subprocess_main` in `main.rs` for the child side.
            let exe = std::env::current_exe().map_err(|e| ExtractError::Transient(e.to_string()))?;
            let mut child = Command::new(exe)
                .arg("--extract-pdf")
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()
                .map_err(|e| ExtractError::Transient(e.to_string()))?;
            child
                .stdin
                .take()
                .unwrap()
                .write_all(bytes)
                .map_err(|e| ExtractError::Transient(e.to_string()))?;

            // The 30s cap is enforced here, by the parent, not by the child:
            // a subprocess with a bug should be killed, not trusted to
            // self-limit. `wait_with_output` has no timeout variant, so it
            // runs on a helper thread and we just stop waiting on it.
            let (tx, rx) = std::sync::mpsc::channel();
            std::thread::spawn(move || {
                let _ = tx.send(child.wait_with_output());
            });
            let output = match rx.recv_timeout(Duration::from_secs(30)) {
                Ok(Ok(o)) => o,
                Ok(Err(e)) => return Err(ExtractError::Transient(e.to_string())),
                Err(_) => return Err(ExtractError::Transient("pdf extraction timed out".into())),
            };

            if !output.status.success() {
                // A non-zero (or, on a signal-killed abort, altogether
                // missing) exit code is indistinguishable from here between
                // "this exact file will never parse", "transient OOM on this
                // input", and everything in between — `ExitStatus` alone
                // can't tell us which. `catch_unwind` in the child normally
                // turns a `pdf-extract` panic into a clean exit(1), but that
                // guard is not guaranteed (see the comment on
                // `extract_pdf_subprocess_main` in main.rs about the
                // workspace's `panic = "abort"` profile setting actually
                // being ignored today, but not something to build on staying
                // that way). So any failure here stays `Transient`, never
                // `Permanent` — a bad exit code is never treated as a
                // verdict on the file itself.
                return Err(ExtractError::Transient(format!("extract-pdf exited {:?}", output.status)));
            }
            let text = String::from_utf8_lossy(&output.stdout).into_owned();
            // Page count is not surfaced by this subprocess mode. `extract()`'s
            // OCR-fallback heuristic (Task 3) uses the page count only to scale
            // its "is this a scanned PDF" threshold before trying OCR — and
            // `pdf_ocr` below is unconditionally `Permanent("unsupported")` on
            // this platform, so that threshold never actually gets to fire a
            // second attempt. A thin text layer ends at "unsupported" either
            // way, never a wrong "ok". Do not read `1` as a real page count if
            // non-macOS OCR is ever added — wire up
            // `pdf_extract::extract_text_from_mem_by_pages` for a real count first.
            Ok((text, 1))
        }

        fn pdf_ocr(&self, _bytes: &[u8], _max_pages: usize) -> Result<String, ExtractError> {
            Err(ExtractError::Permanent("unsupported"))
        }

        fn image_ocr(&self, _bytes: &[u8], _mime: &str) -> Result<String, ExtractError> {
            Err(ExtractError::Permanent("unsupported"))
        }
    }
}

pub fn current_extractor() -> imp::NativeExtractor {
    imp::NativeExtractor
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    #[test]
    fn pdfkit_extracts_the_text_layer_of_a_real_pdf() {
        let bytes = std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/hello.pdf")).unwrap();
        let extractor = current_extractor();
        let (text, pages) = extractor.pdf_text_layer(&bytes).unwrap();
        assert!(text.contains("Hello"), "got: {text:?}");
        assert_eq!(pages, 1);
    }

    #[test]
    fn pdfkit_rejects_garbage_bytes_as_failed_not_encrypted() {
        let extractor = current_extractor();
        let err = extractor.pdf_text_layer(b"not a pdf, just garbage bytes").unwrap_err();
        match err {
            ExtractError::Permanent(state) => assert_eq!(state, "failed"),
            ExtractError::Transient(msg) => panic!("expected Permanent(\"failed\"), got Transient({msg:?})"),
        }
    }
}

#[cfg(all(test, not(target_os = "macos")))]
mod tests {
    #[test]
    fn extract_pdf_subprocess_mode_reads_stdin_writes_stdout() {
        let bytes = std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/hello.pdf")).unwrap();
        let mut child = std::process::Command::new(env!("CARGO_BIN_EXE_mailvault"))
            .arg("--extract-pdf")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        use std::io::Write;
        child.stdin.take().unwrap().write_all(&bytes).unwrap();
        let out = child.wait_with_output().unwrap();
        assert!(out.status.success());
        assert!(String::from_utf8_lossy(&out.stdout).contains("Hello"));
    }
}
