//! PDF text and OCR for the daemon's search index (moved from the app, spec 2026-09-14 §5.2).

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
            // Every Obj-C temporary these frameworks hand back is autoreleased.
            // The index worker is a long-lived thread with no run loop, so its
            // top-level pool only drains when the thread exits — i.e. never.
            // Without this the daemon grew ~780MB of Vision/PDFKit leftovers
            // (5k live `CRImageReaderOutput`, IOSurface-backed) over one day.
            objc2::rc::autoreleasepool(|_| {
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
            })
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

            // Same pool rule as `pdf_text_layer` — Vision is the worst
            // offender of the two (every recognised image leaks its reader
            // output and the IOSurface behind it).
            objc2::rc::autoreleasepool(|_| {
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
            })
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use super::{ExtractError, TextExtractor};
    use std::io::{Read, Write};
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    pub struct NativeExtractor;

    impl TextExtractor for NativeExtractor {
        fn pdf_text_layer(&self, bytes: &[u8]) -> Result<(String, usize), ExtractError> {
            // `pdf-extract` panics on malformed input, and a panic here would
            // take the whole daemon (or the search-index worker thread) down
            // with it. Re-exec ourselves as `mailvault-daemon --extract-pdf` so
            // the parsing happens in a disposable child process instead: see
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

            // Read stdout on its own thread so a slow/stuck child doesn't
            // block this function — but keep `child` itself here, unmoved,
            // so a timeout can actually call `child.kill()` on it (mirrors
            // `shutdown_daemon_child`'s kill-then-wait shape, minus the
            // SIGTERM grace period: an attachment extraction has no state
            // worth flushing, so going straight to a hard kill is fine).
            // The previous version moved `child` into the wait thread and
            // only gave up *waiting* on timeout — the child process (and the
            // thread blocked on it) kept running forever. On a PDF crafted
            // to hang, and since a timeout is reported as `Transient` and
            // retried on every future sweep, that leaked one more orphaned
            // process and thread per retry.
            let mut stdout = child.stdout.take().expect("stdout was piped");
            let (tx, rx) = std::sync::mpsc::channel();
            std::thread::spawn(move || {
                let mut buf = Vec::new();
                let result = stdout.read_to_end(&mut buf).map(|_| buf);
                let _ = tx.send(result);
            });

            let deadline = Instant::now() + Duration::from_secs(30);
            let status = loop {
                match child.try_wait() {
                    Ok(Some(status)) => break status,
                    Ok(None) => {
                        if Instant::now() >= deadline {
                            // Kill and reap right here — don't block further
                            // waiting for it (a process that ignores SIGKILL
                            // is an OS-level problem outside this code's
                            // scope). Killing the child closes its stdout,
                            // which unblocks the reader thread above almost
                            // immediately; we don't wait on that either.
                            let _ = child.kill();
                            let _ = child.wait();
                            return Err(ExtractError::Transient("pdf extraction timed out".into()));
                        }
                        std::thread::sleep(Duration::from_millis(50));
                    }
                    Err(e) => return Err(ExtractError::Transient(e.to_string())),
                }
            };

            // The child has already exited, so its stdout pipe is closed and
            // the reader thread above is finishing (or finished) reading
            // whatever it wrote; a short recv timeout is just a safety net,
            // not an expected wait.
            let stdout_bytes = match rx.recv_timeout(Duration::from_secs(5)) {
                Ok(Ok(buf)) => buf,
                Ok(Err(e)) => return Err(ExtractError::Transient(e.to_string())),
                Err(_) => return Err(ExtractError::Transient("failed to read extract-pdf output".into())),
            };

            if !status.success() {
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
                return Err(ExtractError::Transient(format!("extract-pdf exited {:?}", status)));
            }
            let text = String::from_utf8_lossy(&stdout_bytes).into_owned();
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

    #[test]
    fn vision_reads_the_text_of_a_rendered_page() {
        let bytes = std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/hello.png")).unwrap();
        let text = current_extractor().image_ocr(&bytes, "image/png").unwrap();
        assert!(text.to_lowercase().contains("hello"), "got: {text:?}");
    }

    /// Regression guard for the autorelease pools in `imp`: without them the
    /// index worker thread accumulates every Vision temporary it ever made
    /// (a live daemon reached 780MB of IOSurface-backed `CRImageReaderOutput`
    /// over one day). `#[ignore]`d because it measures the process footprint,
    /// which only means anything when the test runs alone.
    /// Run with: `cargo test -p mailvault-daemon --bin mailvault-daemon
    ///            vision_ocr_does_not_grow -- --ignored --test-threads=1`
    #[test]
    #[ignore]
    fn vision_ocr_does_not_grow_the_footprint() {
        let bytes = std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/hello.png")).unwrap();
        let extractor = current_extractor();
        for _ in 0..20 {
            let _ = extractor.image_ocr(&bytes, "image/png");
        }
        let baseline = footprint_bytes();
        for _ in 0..200 {
            let _ = extractor.image_ocr(&bytes, "image/png");
        }
        let grew = footprint_bytes().saturating_sub(baseline);
        eprintln!("200 OCR calls grew the footprint by {}MB", grew / (1024 * 1024));
        assert!(
            grew < 64 * 1024 * 1024,
            "200 OCR calls grew the footprint by {}MB — an autorelease pool is missing",
            grew / (1024 * 1024)
        );
    }

    /// `vmmap` rather than `task_info`: IOSurface is shared memory, so RSS
    /// does not see the leak this test exists to catch.
    fn footprint_bytes() -> u64 {
        let out = std::process::Command::new("/usr/bin/vmmap")
            .args(["--summary", &std::process::id().to_string()])
            .output()
            .expect("vmmap");
        let text = String::from_utf8_lossy(&out.stdout);
        let line = text
            .lines()
            .find(|l| l.starts_with("Physical footprint:"))
            .unwrap_or_else(|| panic!("no footprint line in vmmap output: {text}"));
        let value = line.split_whitespace().last().unwrap();
        let (number, scale) = value.split_at(value.len() - 1);
        let scale = match scale {
            "K" => 1024.0,
            "M" => 1024.0 * 1024.0,
            "G" => 1024.0 * 1024.0 * 1024.0,
            other => panic!("unexpected footprint unit {other:?} in {line:?}"),
        };
        (number.parse::<f64>().expect("footprint number") * scale) as u64
    }
}
