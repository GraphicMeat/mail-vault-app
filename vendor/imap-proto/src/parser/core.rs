use nom::{
    branch::alt,
    bytes::streaming::{tag, tag_no_case, take, take_while, take_while1},
    character::streaming::{char, digit1},
    combinator::{map, map_res, opt},
    multi::{separated_list0, separated_list1},
    sequence::{delimited, preceded, tuple},
    IResult, Needed,
};

use std::borrow::Cow;
use std::str::{from_utf8, FromStr};

// ----- number -----

// number          = 1*DIGIT
//                    ; Unsigned 32-bit integer
//                    ; (0 <= n < 4,294,967,296)
pub fn number(i: &[u8]) -> IResult<&[u8], u32> {
    let (i, bytes) = digit1(i)?;
    match from_utf8(bytes).ok().and_then(|s| u32::from_str(s).ok()) {
        Some(v) => Ok((i, v)),
        None => Err(nom::Err::Error(nom::error::make_error(
            i,
            nom::error::ErrorKind::MapRes,
        ))),
    }
}

// same as `number` but 64-bit
pub fn number_64(i: &[u8]) -> IResult<&[u8], u64> {
    let (i, bytes) = digit1(i)?;
    match from_utf8(bytes).ok().and_then(|s| u64::from_str(s).ok()) {
        Some(v) => Ok((i, v)),
        None => Err(nom::Err::Error(nom::error::make_error(
            i,
            nom::error::ErrorKind::MapRes,
        ))),
    }
}

// seq-range       = seq-number ":" seq-number
//                    ; two seq-number values and all values between
//                    ; these two regardless of order.
//                    ; seq-number is a nz-number
pub fn sequence_range(i: &[u8]) -> IResult<&[u8], std::ops::RangeInclusive<u32>> {
    map(tuple((number, tag(":"), number)), |(s, _, e)| s..=e)(i)
}

// sequence-set    = (seq-number / seq-range) *("," sequence-set)
//                     ; set of seq-number values, regardless of order.
//                     ; Servers MAY coalesce overlaps and/or execute the
//                     ; sequence in any order.
pub fn sequence_set(i: &[u8]) -> IResult<&[u8], Vec<std::ops::RangeInclusive<u32>>> {
    separated_list1(tag(","), alt((sequence_range, map(number, |n| n..=n))))(i)
}

// ----- string -----

// string = quoted / literal
pub fn string(i: &[u8]) -> IResult<&[u8], &[u8]> {
    alt((quoted, literal))(i)
}

// string bytes as utf8
pub fn string_utf8(i: &[u8]) -> IResult<&[u8], &str> {
    map_res(string, from_utf8)(i)
}

/// MailVault patch: string bytes as text, replacing anything that is not UTF-8.
///
/// BODYSTRUCTURE params, ids and descriptions carry filenames, and one
/// Latin-1 byte in `("NAME" "R\xE9sum\xE9.pdf")` used to fail the whole FETCH
/// line — which kills the connection and the mailbox with it. A mojibake
/// filename is a far better outcome than no mail. ENVELOPE keeps byte
/// `nstring`, so nothing there is affected.
pub fn string_lossy(i: &[u8]) -> IResult<&[u8], Cow<'_, str>> {
    map(string, String::from_utf8_lossy)(i)
}

/// `nstring_utf8`'s lossy twin — see `string_lossy`.
pub fn nstring_lossy(i: &[u8]) -> IResult<&[u8], Option<Cow<'_, str>>> {
    alt((map(nil, |_| None), map(string_lossy, Some)))(i)
}

// quoted = DQUOTE *QUOTED-CHAR DQUOTE
//
// MailVault patch. Hand-rolled instead of nom's `escaped(...)` so that an
// UNESCAPED inner quote counts as content instead of ending the string.
// iCloud (imap.mail.me.com) puts them in ENVELOPE message-ids:
//
//     "<"392889836.11.1529401004417.JavaMail.tomcat"@host>"
//
// (Apple developer forum thread 724704 — a long-standing, unfixed server bug.)
// Stock imap-proto ends the string at the first inner quote, the rest of the
// FETCH line then fails to parse, and async-imap marks the connection dead and
// yields one Err — so a single message costs the user the whole mailbox and the
// app shows "Server error".
//
// A `"` therefore closes the string only when the next byte is SP, `)`, `]`, CR
// or LF. That follower set is safe: every IMAP production that can hold a
// quoted-string is followed by exactly one of them — another SP-separated item,
// the end of a parenthesised list, the end of a resp-text-code, or the line's
// CRLF. Any other byte means the quote belonged to the value.
//
// Streaming semantics are kept throughout: a string that has not been closed
// yet (or a closer with nothing behind it to judge) is Incomplete, so the
// decoder reads more bytes rather than failing. Escapes are returned verbatim,
// exactly as before — callers still unescape downstream.
pub fn quoted(i: &[u8]) -> IResult<&[u8], &[u8]> {
    if i.is_empty() {
        return Err(nom::Err::Incomplete(Needed::new(1)));
    }
    if i[0] != b'"' {
        // Same shape `char('"')` gave.
        return Err(nom::Err::Error(nom::error::make_error(
            i,
            nom::error::ErrorKind::Char,
        )));
    }

    let mut at = 1;
    while at < i.len() {
        match i[at] {
            b'\\' => match i.get(at + 1) {
                None => return Err(nom::Err::Incomplete(Needed::new(1))),
                Some(b'\\') | Some(b'"') => at += 2,
                Some(_) => {
                    return Err(nom::Err::Error(nom::error::make_error(
                        &i[at..],
                        nom::error::ErrorKind::OneOf,
                    )))
                }
            },
            b'"' => match i.get(at + 1) {
                None => return Err(nom::Err::Incomplete(Needed::new(1))),
                Some(b' ') | Some(b')') | Some(b']') | Some(b'\r') | Some(b'\n') => {
                    return Ok((&i[at + 1..], &i[1..at]))
                }
                Some(_) => at += 1, // iCloud's unescaped inner quote — content
            },
            b if is_quoted_char(b) => at += 1,
            _ => {
                return Err(nom::Err::Error(nom::error::make_error(
                    &i[at..],
                    nom::error::ErrorKind::TakeWhile1,
                )))
            }
        }
    }
    Err(nom::Err::Incomplete(Needed::new(1)))
}

// QUOTED-CHAR, widened to 8 bits. RFC 3501 says TEXT-CHAR (%x01-7F, no CR/LF),
// but real servers put raw Latin-1 / UTF-8 bytes in quoted filenames, and
// refusing the byte kills the entire FETCH stream rather than one field.
// `\` and `"` are handled by the scanner in `quoted`.
fn is_quoted_char(c: u8) -> bool {
    c != 0 && c != b'\r' && c != b'\n'
}

// quoted bytes as utf8
pub fn quoted_utf8(i: &[u8]) -> IResult<&[u8], &str> {
    map_res(quoted, from_utf8)(i)
}

// quoted-specials = DQUOTE / "\"
pub fn is_quoted_specials(c: u8) -> bool {
    c == b'"' || c == b'\\'
}

/// literal = "{" number "}" CRLF *CHAR8
///            ; Number represents the number of CHAR8s
pub fn literal(input: &[u8]) -> IResult<&[u8], &[u8]> {
    let mut parser = tuple((tag(b"{"), number, tag(b"}"), tag("\r\n")));

    let (remaining, (_, count, _, _)) = parser(input)?;

    let (remaining, data) = take(count)(remaining)?;

    Ok((remaining, data))
}

// ----- astring ----- atom (roughly) or string

// astring = 1*ASTRING-CHAR / string
pub fn astring(i: &[u8]) -> IResult<&[u8], &[u8]> {
    alt((take_while1(is_astring_char), string))(i)
}

// astring bytes as utf8
pub fn astring_utf8(i: &[u8]) -> IResult<&[u8], &str> {
    map_res(astring, from_utf8)(i)
}

// ASTRING-CHAR = ATOM-CHAR / resp-specials
pub fn is_astring_char(c: u8) -> bool {
    is_atom_char(c) || is_resp_specials(c)
}

// ATOM-CHAR = <any CHAR except atom-specials>
pub fn is_atom_char(c: u8) -> bool {
    is_char(c) && !is_atom_specials(c)
}

// atom-specials = "(" / ")" / "{" / SP / CTL / list-wildcards / quoted-specials / resp-specials
pub fn is_atom_specials(c: u8) -> bool {
    c == b'('
        || c == b')'
        || c == b'{'
        || c == b' '
        || c < 32
        || is_list_wildcards(c)
        || is_quoted_specials(c)
        || is_resp_specials(c)
}

// resp-specials = "]"
pub fn is_resp_specials(c: u8) -> bool {
    c == b']'
}

// atom = 1*ATOM-CHAR
pub fn atom(i: &[u8]) -> IResult<&[u8], &str> {
    map_res(take_while1(is_atom_char), from_utf8)(i)
}

// ----- nstring ----- nil or string

// nstring = string / nil
pub fn nstring(i: &[u8]) -> IResult<&[u8], Option<&[u8]>> {
    alt((map(nil, |_| None), map(string, Some)))(i)
}

// nstring bytes as utf8
pub fn nstring_utf8(i: &[u8]) -> IResult<&[u8], Option<&str>> {
    alt((map(nil, |_| None), map(string_utf8, Some)))(i)
}

// nil = "NIL"
pub fn nil(i: &[u8]) -> IResult<&[u8], &[u8]> {
    tag_no_case("NIL")(i)
}

// ----- text -----

// text = 1*TEXT-CHAR
pub fn text(i: &[u8]) -> IResult<&[u8], &str> {
    map_res(take_while(is_text_char), from_utf8)(i)
}

// TEXT-CHAR = <any CHAR except CR and LF>
pub fn is_text_char(c: u8) -> bool {
    is_char(c) && c != b'\r' && c != b'\n'
}

// CHAR = %x01-7F
//          ; any 7-bit US-ASCII character,
//          ;  excluding NUL
// From RFC5234
pub fn is_char(c: u8) -> bool {
    matches!(c, 0x01..=0x7F)
}

// ----- others -----

// list-wildcards = "%" / "*"
pub fn is_list_wildcards(c: u8) -> bool {
    c == b'%' || c == b'*'
}

pub fn paren_delimited<'a, F, O, E>(f: F) -> impl FnMut(&'a [u8]) -> IResult<&'a [u8], O, E>
where
    F: FnMut(&'a [u8]) -> IResult<&'a [u8], O, E>,
    E: nom::error::ParseError<&'a [u8]>,
{
    delimited(char('('), f, char(')'))
}

pub fn parenthesized_nonempty_list<'a, F, O, E>(
    f: F,
) -> impl FnMut(&'a [u8]) -> IResult<&'a [u8], Vec<O>, E>
where
    F: FnMut(&'a [u8]) -> IResult<&'a [u8], O, E>,
    E: nom::error::ParseError<&'a [u8]>,
{
    delimited(char('('), separated_list1(char(' '), f), char(')'))
}

pub fn parenthesized_list<'a, F, O, E>(f: F) -> impl FnMut(&'a [u8]) -> IResult<&'a [u8], Vec<O>, E>
where
    F: FnMut(&'a [u8]) -> IResult<&'a [u8], O, E>,
    E: nom::error::ParseError<&'a [u8]>,
{
    delimited(
        char('('),
        separated_list0(char(' '), f),
        preceded(
            opt(char(' ')), // Surgemail sometimes sends a space before the closing bracket.
            char(')'),
        ),
    )
}

pub fn opt_opt<'a, F, O, E>(mut f: F) -> impl FnMut(&'a [u8]) -> IResult<&'a [u8], Option<O>, E>
where
    F: FnMut(&'a [u8]) -> IResult<&'a [u8], Option<O>, E>,
{
    move |i: &[u8]| match f(i) {
        Ok((i, o)) => Ok((i, o)),
        Err(nom::Err::Error(_)) => Ok((i, None)),
        Err(e) => Err(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use assert_matches::assert_matches;

    #[test]
    fn test_quoted() {
        // A closing quote is one followed by SP / ")" / "]" / CRLF. The
        // terminators here were `???` before the MailVault patch; see `quoted`.
        let (rem, val) = quoted(br#""Hello")??"#).unwrap();
        assert_eq!(rem, b")??");
        assert_eq!(val, b"Hello");

        // Allowed escapes...
        assert_eq!(
            quoted(br#""Hello \" ")??"#),
            Ok((&b")??"[..], &br#"Hello \" "#[..]))
        );
        assert_eq!(
            quoted(br#""Hello \\ ")??"#),
            Ok((&b")??"[..], &br#"Hello \\ "#[..]))
        );

        // Not allowed escapes...
        assert!(quoted(br#""Hello \a ")??"#).is_err());
        assert!(quoted(br#""Hello \z ")??"#).is_err());
        assert!(quoted(br#""Hello \? ")??"#).is_err());

        let (rem, val) = quoted(br#""Hello \"World\"")??"#).unwrap();
        assert_eq!(rem, br#")??"#);
        // Should it be this (Hello \"World\") ...
        assert_eq!(val, br#"Hello \"World\""#);
        // ... or this (Hello "World")?
        //assert_eq!(val, br#"Hello "World""#); // fails

        // Test Incomplete
        assert_matches!(quoted(br#""#), Err(nom::Err::Incomplete(_)));
        assert_matches!(quoted(br#""\"#), Err(nom::Err::Incomplete(_)));
        assert_matches!(quoted(br#""Hello "#), Err(nom::Err::Incomplete(_)));

        // Test Error
        assert_matches!(quoted(br"\"), Err(nom::Err::Error(_)));
    }

    // ── MailVault patch: iCloud's unescaped inner quotes ────────────────────

    #[test]
    fn an_unescaped_inner_quote_is_content() {
        // The shape iCloud puts in ENVELOPE message-ids.
        let input = br#""<"392889836.11.1529401004417.JavaMail.tomcat"@host>")"#;
        let (rem, val) = quoted(input).unwrap();
        assert_eq!(rem, b")");
        assert_eq!(
            val,
            &br#"<"392889836.11.1529401004417.JavaMail.tomcat"@host>"#[..]
        );
    }

    #[test]
    fn an_empty_quoted_string_still_parses() {
        assert_eq!(quoted(br#""" "#), Ok((&b" "[..], &b""[..])));
    }

    #[test]
    fn escapes_come_back_verbatim() {
        assert_eq!(quoted(br#""a\"b" "#), Ok((&b" "[..], &br#"a\"b"#[..])));
    }

    #[test]
    fn two_quoted_strings_in_a_row_still_split() {
        let (rem, first) = quoted(br#""a" "b")"#).unwrap();
        assert_eq!(first, b"a");
        assert_eq!(rem, br#" "b")"#);
        let (rem, second) = quoted(&rem[1..]).unwrap();
        assert_eq!(second, b"b");
        assert_eq!(rem, b")");
    }

    #[test]
    fn an_unterminated_or_unjudgeable_string_is_incomplete() {
        // No closer at all.
        assert_matches!(quoted(br#""abc"#), Err(nom::Err::Incomplete(_)));
        // A closer with nothing behind it: the next byte decides, so wait.
        assert_matches!(quoted(br#""abc""#), Err(nom::Err::Incomplete(_)));
        // A closer followed by content: keep scanning, then run out.
        assert_matches!(quoted(br#""abc"x"#), Err(nom::Err::Incomplete(_)));
    }

    #[test]
    fn an_eight_bit_byte_is_content_not_an_error() {
        let (rem, val) = quoted(b"\"R\xe9sum\xe9.pdf\")").unwrap();
        assert_eq!(rem, b")");
        assert_eq!(val, b"R\xe9sum\xe9.pdf");
    }

    #[test]
    fn a_lossy_string_replaces_invalid_utf8() {
        let (_, val) = string_lossy(b"\"R\xe9sum\xe9.pdf\")").unwrap();
        assert!(val.contains('\u{FFFD}'), "got {val:?}");
        assert!(val.ends_with(".pdf"), "got {val:?}");
    }

    #[test]
    fn test_string_literal() {
        match string(b"{3}\r\nXYZ") {
            Ok((_, value)) => {
                assert_eq!(value, b"XYZ");
            }
            rsp => panic!("unexpected response {rsp:?}"),
        }
    }

    #[test]
    fn test_string_literal_containing_null() {
        match string(b"{5}\r\nX\0Y\0Z") {
            Ok((_, value)) => {
                assert_eq!(value, b"X\0Y\0Z");
            }
            rsp => panic!("unexpected response {rsp:?}"),
        }
    }

    #[test]
    fn test_astring() {
        match astring(b"text ") {
            Ok((_, value)) => {
                assert_eq!(value, b"text");
            }
            rsp => panic!("unexpected response {rsp:?}"),
        }
    }

    #[test]
    fn test_sequence_range() {
        match sequence_range(b"23:28 ") {
            Ok((_, value)) => {
                assert_eq!(*value.start(), 23);
                assert_eq!(*value.end(), 28);
                assert_eq!(value.collect::<Vec<u32>>(), vec![23, 24, 25, 26, 27, 28]);
            }
            rsp => panic!("Unexpected response {rsp:?}"),
        }
    }

    #[test]
    fn test_sequence_set() {
        match sequence_set(b"1,2:8,10,15:30 ") {
            Ok((_, value)) => {
                assert_eq!(value.len(), 4);
                let v = &value[0];
                assert_eq!(*v.start(), 1);
                assert_eq!(*v.end(), 1);
                let v = &value[1];
                assert_eq!(*v.start(), 2);
                assert_eq!(*v.end(), 8);
                let v = &value[2];
                assert_eq!(*v.start(), 10);
                assert_eq!(*v.end(), 10);
                let v = &value[3];
                assert_eq!(*v.start(), 15);
                assert_eq!(*v.end(), 30);
            }
            rsp => panic!("Unexpected response {rsp:?}"),
        }
    }
}
