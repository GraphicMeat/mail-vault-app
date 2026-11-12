// The shared "Rust source as shipped" reader (helpers/rustSources.js) that
// every source-scanning test goes through. The scanners used to cut a file at
// its first test module, so code after an early test helper was never seen.
// src-core/tests/support/rust_scan.rs holds the same fixtures for the Rust side.
import { describe, expect, it } from 'vitest';
import { rustNonTestCode } from './helpers/rustSources.js';

describe('rustNonTestCode', () => {
  it('blanks comments and drops a trailing test module', () => {
    expect(rustNonTestCode('// crate::maildir::x\nlet a = 1; // crate::maildir\n')).not.toContain('maildir');
    expect(rustNonTestCode('fn a() {}\n#[cfg(test)]\nmod tests {\n use crate::maildir;\n}\n')).not.toContain('maildir');
  });

  it('keeps the code after an early test helper module', () => {
    const code = rustNonTestCode('#[cfg(test)]\nmod pause {\n    use crate::a;\n    fn f() {\n    }\n}\nuse crate::maildir;\n#[cfg(test)]\nmod tests {\n    use crate::b;\n}\n');
    expect(code).toContain('crate::maildir');
    expect(code).not.toContain('crate::a');
    expect(code).not.toContain('crate::b');
  });

  it.each([
    '#[cfg(test)]\nmod tests;\n',
    '#[cfg(test)]\npub(crate) mod helpers;\n',
    '#[cfg(test)]\n#[path = "x_tests.rs"]\nmod tests;\n',
    '#[cfg(test)] mod tests;\n',
    '#[cfg(test)] #[path = "x_tests.rs"] mod tests;\n',
    '#[cfg(test)]\nmod one { fn now_ms() {} }\n',
    '#[cfg(all(test, target_os = "macos"))]\npub(crate) mod mac {\n    fn now_ms() {}\n}\n',
    '#[cfg(test)]\nthread_local! {\n    static X: u8 = 0;\n}\n',
    '#[cfg(test)]\n#[test]\nfn now_ms() {\n}\n',
    // Braces and comment marks inside literals are text, not structure.
    '#[cfg(test)]\nmod t {\n    fn now_ms() { let u = "https://x.test/{"; for c in [\'}\', \'{\'] {} }\n}\n',
    '#[cfg(test)]\nmod t {\n    fn now_ms<\'a>(s: &\'a str) { let r = r#"}"#; let b = br"}"; }\n}\n',
  ])('drops %j and keeps what follows', (early) => {
    const code = rustNonTestCode(`${early}use crate::maildir;\n`);
    expect(code).toContain('crate::maildir');
    expect(code).not.toMatch(/now_ms|static X|mod /);
  });

  it('keeps cfg(not(test)) code: it ships', () => {
    expect(rustNonTestCode('#[cfg(not(test))]\nfn now_ms() {}\n')).toContain('now_ms');
    expect(rustNonTestCode('#[cfg(all(not(test), unix))]\nfn now_ms() {}\n')).toContain('now_ms');
  });

  it('blanks block comments and reads // inside a string as text', () => {
    expect(rustNonTestCode('/* crate::maildir */ let a = 1;\n')).not.toContain('maildir');
    expect(rustNonTestCode('let u = "https://x.test"; let v = 1;\n')).toContain('let v = 1;');
  });
});
