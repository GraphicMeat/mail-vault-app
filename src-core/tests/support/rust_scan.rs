//! Reading Rust source as shipped, for the ratchets that scan source text
//! (core's and the daemon's `tests/module_layers.rs` include this file).
//! `tests/unit/helpers/rustSources.js` (`rustNonTestCode`) is the JS twin.

/// One source line: its code with comments blanked (string and char
/// literals kept), and how many `{` and `}` it holds outside literals.
#[derive(Default)]
struct Line {
    code: String,
    open: i32,
    close: i32,
}

fn is_ident(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// Splits `src` into lines, blanking `//` and `/* */` comments and counting
/// braces outside string, raw string and char literals (a `"https://..."`
/// or a `'{'` is not a comment or a brace).
fn lex(src: &str) -> Vec<Line> {
    let s: Vec<char> = src.chars().collect();
    let at = |i: usize| s.get(i).copied().unwrap_or('\0');
    let mut lines = vec![Line::default()];
    let mut i = 0;
    let mut block = 0usize;
    // Inside a string: `Some(None)` a plain one, `Some(Some(n))` a raw one
    // closed by `"` and n `#`.
    let mut string: Option<Option<usize>> = None;
    while i < s.len() {
        let c = s[i];
        if c == '\n' {
            lines.push(Line::default());
            i += 1;
            continue;
        }
        let line = lines.last_mut().unwrap();
        if block > 0 {
            if c == '*' && at(i + 1) == '/' {
                block -= 1;
                i += 2;
            } else if c == '/' && at(i + 1) == '*' {
                block += 1;
                i += 2;
            } else {
                i += 1;
            }
            continue;
        }
        if let Some(raw) = string {
            line.code.push(c);
            match raw {
                None if c == '\\' && at(i + 1) != '\n' => {
                    line.code.push(at(i + 1));
                    i += 2;
                    continue;
                }
                None if c == '"' => string = None,
                Some(n) if c == '"' && (1..=n).all(|k| at(i + k) == '#') => {
                    line.code.extend(std::iter::repeat('#').take(n));
                    string = None;
                    i += 1 + n;
                    continue;
                }
                _ => {}
            }
            i += 1;
            continue;
        }
        if c == '/' && at(i + 1) == '/' {
            while i < s.len() && s[i] != '\n' {
                i += 1;
            }
            continue;
        }
        if c == '/' && at(i + 1) == '*' {
            block = 1;
            i += 2;
            continue;
        }
        if c == '"' {
            string = Some(None);
            line.code.push(c);
            i += 1;
            continue;
        }
        // r"..", r#".."#, br#".."#: an `r` that starts a token.
        let starts_token = i == 0 || !is_ident(at(i - 1)) || (at(i - 1) == 'b' && (i == 1 || !is_ident(at(i - 2))));
        if c == 'r' && starts_token {
            let hashes = (1..).take_while(|&k| at(i + k) == '#').count();
            if at(i + 1 + hashes) == '"' {
                line.code.extend(s[i..i + 2 + hashes].iter());
                string = Some(Some(hashes));
                i += 2 + hashes;
                continue;
            }
        }
        // A char literal ('x', '\n', '\u{7b}'); a lifetime ('a) is not one.
        if c == '\'' {
            let end = if at(i + 1) == '\\' {
                (i + 2..(i + 12).min(s.len())).find(|&j| s[j] == '\'')
            } else if at(i + 2) == '\'' {
                Some(i + 2)
            } else {
                None
            };
            if let Some(end) = end {
                line.code.extend(s[i..=end].iter());
                i = end + 1;
                continue;
            }
        }
        match c {
            '{' => line.open += 1,
            '}' => line.close += 1,
            _ => {}
        }
        line.code.push(c);
        i += 1;
    }
    lines
}

/// What follows a `#[cfg(test)]` or `#[cfg(all(test, ..))]` attribute that
/// opens `code`, or `None`.
fn after_test_cfg(code: &str) -> Option<&str> {
    let t = code.trim_start();
    if let Some(rest) = t.strip_prefix("#[cfg(test)]") {
        return Some(rest);
    }
    let all = t.strip_prefix("#[cfg(all(")?;
    let first = all.split([',', ')']).next()?.trim();
    (first == "test").then(|| t.find(']').map_or("", |end| &t[end + 1..]))
}

/// Drops leading attributes (`#[path = ".."]`, `#[test]`) from an item line.
fn strip_attributes(mut code: &str) -> &str {
    loop {
        let t = code.trim_start();
        if !t.starts_with("#[") {
            return code;
        }
        match t.find(']') {
            Some(end) => code = &t[end + 1..],
            None => return "",
        }
    }
}

/// The file's code with every item a test cfg gates dropped (a `mod x;` line,
/// a `mod x { .. }` on one line or many, a test fn, a `thread_local!`), with
/// the attributes between the cfg and the item, and with comments blanked.
/// Dropped lines stay as empty lines. Code after an early test item is kept:
/// it is production code.
pub fn non_test_code(src: &str) -> String {
    let mut out = String::new();
    let mut skipping = false;
    let mut opened = false;
    let mut depth = 0i32;
    for line in lex(src) {
        let mut code = line.code.as_str();
        if !skipping {
            match after_test_cfg(code) {
                None => {
                    out.push_str(code);
                    out.push('\n');
                    continue;
                }
                Some(rest) => {
                    skipping = true;
                    opened = false;
                    depth = 0;
                    code = rest;
                }
            }
        }
        out.push('\n');
        if !opened {
            code = strip_attributes(code);
            if code.trim().is_empty() && line.open == 0 {
                continue;
            }
        }
        depth += line.open - line.close;
        opened |= line.open > 0;
        if if opened { depth <= 0 } else { code.trim_end().ends_with(';') } {
            skipping = false;
        }
    }
    out
}

/// Fixtures every scanner that reads through `non_test_code` must pass.
pub fn assert_non_test_code_sees_production_code() {
    let seen = non_test_code;
    assert!(seen("// crate::maildir::x\nlet a = 1; // crate::maildir\n").find("maildir").is_none());
    assert!(seen("/* crate::maildir */ let a = 1;\n").find("maildir").is_none());
    assert!(seen("fn a() {}\n#[cfg(test)]\nmod tests {\n use crate::maildir;\n}\n").find("maildir").is_none());
    let after_helper = "#[cfg(test)]\nmod pause {\n    use crate::a;\n    fn f() {\n    }\n}\nuse crate::maildir;\n#[cfg(test)]\nmod tests {\n    use crate::b;\n}\n";
    let code = seen(after_helper);
    assert!(code.contains("crate::maildir"), "code after a test helper module is production code");
    assert!(!code.contains("crate::a") && !code.contains("crate::b"), "{code}");
    for early in [
        "#[cfg(test)]\nmod tests;\n",
        "#[cfg(test)]\npub(crate) mod helpers;\n",
        "#[cfg(test)]\n#[path = \"x_tests.rs\"]\nmod tests;\n",
        "#[cfg(test)] mod tests;\n",
        "#[cfg(test)]\nmod one { fn now_ms() {} }\n",
        "#[cfg(all(test, target_os = \"macos\"))]\npub(crate) mod mac {\n    fn now_ms() {}\n}\n",
        "#[cfg(test)]\nthread_local! {\n    static X: u8 = 0;\n}\n",
        "#[cfg(test)]\n#[test]\nfn now_ms() {\n}\n",
        // Braces and comment marks inside literals are text, not structure.
        "#[cfg(test)]\nmod t {\n    fn now_ms() { let u = \"https://x.test/{\"; for c in ['}', '{'] {} }\n}\n",
        "#[cfg(test)]\nmod t {\n    fn now_ms<'a>(s: &'a str) { let r = r#\"}\"#; let b = br\"}\"; }\n}\n",
    ] {
        let code = seen(&format!("{early}use crate::maildir;\n"));
        assert!(code.contains("crate::maildir"), "code after {early:?} is production code: {code:?}");
        assert!(!code.contains("now_ms") && !code.contains("static X") && !code.contains("mod "), "{early:?} left {code:?}");
    }
    assert!(seen("#[cfg(not(test))]\nfn now_ms() {}\n").contains("now_ms"), "cfg(not(test)) ships");
    assert!(seen("#[cfg(all(not(test), unix))]\nfn now_ms() {}\n").contains("now_ms"), "cfg(all(not(test), ..)) ships");
    assert!(seen("let u = \"https://x.test\"; let v = 1;\n").contains("let v = 1;"), "a // inside a string is not a comment");
}
