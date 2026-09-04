import { describe, it, expect } from 'vitest';
import { previewKind } from '../attachmentUtils';

// What the viewer can render in-app. The kind decides which surface the
// preview dialog uses; null means the row offers download only.
describe('previewKind', () => {
  it('renders images and PDFs, nothing else', () => {
    expect(previewKind({ contentType: 'image/png' })).toBe('image');
    expect(previewKind({ contentType: 'image/jpeg; name="a.jpg"' })).toBe('image');
    expect(previewKind({ contentType: 'application/pdf' })).toBe('pdf');
    expect(previewKind({ contentType: 'application/zip' })).toBeNull();
    expect(previewKind({ contentType: 'text/plain' })).toBeNull();
  });

  it('falls back to the file extension when the type is generic', () => {
    expect(previewKind({ contentType: 'application/octet-stream', filename: 'scan.PDF' })).toBe('pdf');
    expect(previewKind({ contentType: 'application/octet-stream', filename: 'IMG_1.jpeg' })).toBe('image');
    expect(previewKind({ contentType: 'application/octet-stream', filename: 'data.bin' })).toBeNull();
    expect(previewKind({})).toBeNull();
  });
});
