//! The platform seam for PDF/OCR text extraction. Starts as a no-op on every
//! platform; Task 7 (macOS PDFKit/Vision) and Task 8 (non-macOS pdf-extract
//! subprocess) replace `current_extractor()`'s body without touching any of
//! its callers.

use mailvault_core::search_index::attachments::NoOcrExtractor;

pub fn current_extractor() -> NoOcrExtractor {
    NoOcrExtractor
}
