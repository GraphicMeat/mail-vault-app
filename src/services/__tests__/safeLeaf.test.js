import { describe, it, expect } from 'vitest';
import { safeLeaf } from '../attachmentUtils';

// A sender picks the attachment name, and Download joins it onto ~/Downloads
// with a `path.join` that resolves `..`. Only a plain file name may survive.
describe('safeLeaf', () => {
  it('keeps only the last path component', () => {
    expect(safeLeaf('../../x.exe')).toBe('x.exe');
    expect(safeLeaf('..\\..\\x.exe')).toBe('x.exe');
    expect(safeLeaf('/etc/passwd')).toBe('passwd');
  });

  it('never returns a name that points at a directory', () => {
    for (const name of ['..', '.', '', 'dir/', 'a/..', undefined, null]) {
      expect(safeLeaf(name)).toBe('attachment');
    }
  });

  it('turns Win32-invalid characters into underscores, so no NTFS stream is addressed', () => {
    expect(safeLeaf('a.pdf:x.exe')).toBe('a.pdf_x.exe');
    expect(safeLeaf('Re: invoice.pdf')).toBe('Re_ invoice.pdf');
    expect(safeLeaf('<a>|"b"?*\u0001.txt')).toBe('_a___b____.txt');
  });

  it('leaves an ordinary name alone', () => {
    expect(safeLeaf('Rechnung März (2).pdf')).toBe('Rechnung März (2).pdf');
  });
});
