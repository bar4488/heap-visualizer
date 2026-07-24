//! Minimal single-pass JSON scanner for heapl lines.
//!
//! Tolerant by construction: unknown fields are skipped, field order is free,
//! and only the value shapes the spec uses (string, integer, array of strings,
//! object) are decoded. Numbers with fractions/exponents are read via f64.

pub struct Scan<'a> {
    pub b: &'a [u8],
    pub i: usize,
}

impl<'a> Scan<'a> {
    pub fn new(b: &'a [u8]) -> Self {
        Scan { b, i: 0 }
    }

    pub fn ws(&mut self) {
        while self.i < self.b.len() && matches!(self.b[self.i], b' ' | b'\t' | b'\r' | b'\n') {
            self.i += 1;
        }
    }

    pub fn peek(&self) -> u8 {
        if self.i < self.b.len() {
            self.b[self.i]
        } else {
            0
        }
    }

    pub fn eat(&mut self, c: u8) -> bool {
        self.ws();
        if self.peek() == c {
            self.i += 1;
            true
        } else {
            false
        }
    }

    /// Parse a JSON string, returning the raw span between the quotes
    /// (escapes not yet processed). Returns None on malformed input.
    pub fn string_span(&mut self) -> Option<(usize, usize)> {
        self.ws();
        if self.peek() != b'"' {
            return None;
        }
        self.i += 1;
        let start = self.i;
        while self.i < self.b.len() {
            match self.b[self.i] {
                b'"' => {
                    let end = self.i;
                    self.i += 1;
                    return Some((start, end));
                }
                b'\\' => self.i += 2,
                _ => self.i += 1,
            }
        }
        None
    }

    /// Parse a signed integer value. Values with '.' 'e' 'E' fall back to f64
    /// and are truncated. Returns None on malformed input.
    pub fn integer(&mut self) -> Option<i64> {
        self.ws();
        let start = self.i;
        if self.peek() == b'-' {
            self.i += 1;
        }
        let dig_start = self.i;
        while self.i < self.b.len() && self.b[self.i].is_ascii_digit() {
            self.i += 1;
        }
        if self.i == dig_start {
            return None;
        }
        if matches!(self.peek(), b'.' | b'e' | b'E') {
            // consume the rest of the number, parse as f64
            while self.i < self.b.len()
                && matches!(self.b[self.i], b'0'..=b'9' | b'.' | b'e' | b'E' | b'+' | b'-')
            {
                self.i += 1;
            }
            let s = core::str::from_utf8(&self.b[start..self.i]).ok()?;
            return s.parse::<f64>().ok().map(|f| f as i64);
        }
        let neg = self.b[start] == b'-';
        let mut v: i64 = 0;
        for &c in &self.b[dig_start..self.i] {
            v = v.saturating_mul(10).saturating_add((c - b'0') as i64);
        }
        Some(if neg { -v } else { v })
    }

    /// Skip any JSON value, returning its raw span.
    pub fn skip_value(&mut self) -> Option<(usize, usize)> {
        self.ws();
        let start = self.i;
        match self.peek() {
            b'"' => {
                self.string_span()?;
            }
            b'{' | b'[' => {
                let mut depth = 0usize;
                while self.i < self.b.len() {
                    match self.b[self.i] {
                        b'{' | b'[' => {
                            depth += 1;
                            self.i += 1;
                        }
                        b'}' | b']' => {
                            depth -= 1;
                            self.i += 1;
                            if depth == 0 {
                                break;
                            }
                        }
                        b'"' => {
                            self.string_span()?;
                        }
                        _ => self.i += 1,
                    }
                }
                if depth != 0 {
                    return None;
                }
            }
            b't' => self.i += 4, // true
            b'f' => self.i += 5, // false
            b'n' => self.i += 4, // null
            _ => {
                // number
                let s = self.i;
                while self.i < self.b.len()
                    && matches!(self.b[self.i], b'0'..=b'9' | b'.' | b'e' | b'E' | b'+' | b'-')
                {
                    self.i += 1;
                }
                if self.i == s {
                    return None;
                }
            }
        }
        if self.i > self.b.len() {
            return None;
        }
        Some((start, self.i))
    }
}

/// Unescape a raw JSON string span into a String.
pub fn unescape(raw: &[u8]) -> String {
    if !raw.contains(&b'\\') {
        return String::from_utf8_lossy(raw).into_owned();
    }
    let mut out = String::with_capacity(raw.len());
    let mut i = 0;
    while i < raw.len() {
        let c = raw[i];
        if c == b'\\' && i + 1 < raw.len() {
            i += 1;
            match raw[i] {
                b'"' => out.push('"'),
                b'\\' => out.push('\\'),
                b'/' => out.push('/'),
                b'n' => out.push('\n'),
                b't' => out.push('\t'),
                b'r' => out.push('\r'),
                b'b' => out.push('\u{8}'),
                b'f' => out.push('\u{c}'),
                b'u' => {
                    if i + 4 < raw.len() {
                        let hex = core::str::from_utf8(&raw[i + 1..i + 5]).unwrap_or("");
                        if let Ok(cp) = u32::from_str_radix(hex, 16) {
                            i += 4;
                            if (0xd800..0xdc00).contains(&cp) {
                                // high surrogate: combine with the following
                                // \uDC00-\uDFFF escape into one code point
                                let lo = if raw.len() >= i + 7
                                    && raw[i + 1] == b'\\'
                                    && raw[i + 2] == b'u'
                                {
                                    core::str::from_utf8(&raw[i + 3..i + 7])
                                        .ok()
                                        .and_then(|h| u32::from_str_radix(h, 16).ok())
                                        .filter(|c| (0xdc00..0xe000).contains(c))
                                } else {
                                    None
                                };
                                match lo {
                                    Some(lo) => {
                                        let c = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00);
                                        out.push(char::from_u32(c).unwrap_or('\u{fffd}'));
                                        i += 6; // the "\uXXXX" of the low half
                                    }
                                    None => out.push('\u{fffd}'), // unpaired
                                }
                            } else {
                                out.push(char::from_u32(cp).unwrap_or('\u{fffd}'));
                            }
                        } else {
                            i += 4;
                        }
                    }
                }
                other => out.push(other as char),
            }
            i += 1;
        } else {
            // copy a full UTF-8 sequence
            let len = utf8_len(c);
            let end = (i + len).min(raw.len());
            out.push_str(&String::from_utf8_lossy(&raw[i..end]));
            i = end;
        }
    }
    out
}

fn utf8_len(b: u8) -> usize {
    if b < 0x80 {
        1
    } else if b < 0xe0 {
        2
    } else if b < 0xf0 {
        3
    } else {
        4
    }
}

/// Parse a `"0x..."` hex address (raw span from string_span) into u64.
/// Accepts upper/lowercase and a missing 0x prefix; also plain decimal.
pub fn parse_addr(raw: &[u8]) -> Option<u64> {
    let s = if raw.len() > 2 && raw[0] == b'0' && (raw[1] | 0x20) == b'x' {
        &raw[2..]
    } else {
        // decimal string addresses are tolerated
        let mut v: u64 = 0;
        let mut all_dec = !raw.is_empty();
        for &c in raw {
            if c.is_ascii_digit() {
                v = v.wrapping_mul(10).wrapping_add((c - b'0') as u64);
            } else {
                all_dec = false;
                break;
            }
        }
        if all_dec {
            return Some(v);
        }
        raw
    };
    if s.is_empty() || s.len() > 16 {
        return None;
    }
    let mut v: u64 = 0;
    for &c in s {
        let d = match c {
            b'0'..=b'9' => c - b'0',
            b'a'..=b'f' => c - b'a' + 10,
            b'A'..=b'F' => c - b'A' + 10,
            _ => return None,
        };
        v = (v << 4) | d as u64;
    }
    Some(v)
}

/// Append a JSON-escaped string to `out` (including surrounding quotes).
pub fn push_json_str(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", c as u32));
            }
            c => out.push(c),
        }
    }
    out.push('"');
}
