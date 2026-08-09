use crate::{FloatLiteral, IntegerLiteral, ParseError, Span, Unit};

#[derive(Clone, Debug, PartialEq)]
pub(crate) enum TokenKind {
    Identifier(String),
    Integer(IntegerLiteral),
    Float(FloatLiteral),
    String(String),
    True,
    False,
    In,
    Is,
    Not,
    And,
    Or,
    None,
    /// Removed spellings, lexed only so the parser can name what replaced
    /// them instead of reporting an unexpected character.
    AndAnd,
    OrOr,
    Bang,
    EqualEqual,
    BangEqual,
    Less,
    LessEqual,
    Greater,
    GreaterEqual,
    Plus,
    Minus,
    Dot,
    DotDot,
    Comma,
    LeftParen,
    RightParen,
    LeftBrace,
    RightBrace,
    LeftBracket,
    RightBracket,
    /// A byte that cannot begin a token. Only `lex_lossy` produces this; the
    /// parser's `lex` reports it as an error instead.
    Invalid,
    Eof,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Token {
    pub kind: TokenKind,
    pub span: Span,
}

/// Lex as much as possible, never failing: an unlexable byte becomes an
/// `Invalid` token and the scan continues past it.
///
/// This exists for highlighting, which runs on every keystroke over source
/// that is usually half-written. It shares the whole token definition with
/// `lex` so the two can never disagree about what a word is.
pub(crate) fn lex_lossy(source: &str) -> Vec<Token> {
    let mut lexer = Lexer {
        source,
        offset: 0,
        tokens: Vec::new(),
    };
    while lexer.offset < source.len() {
        lexer.skip_whitespace();
        if lexer.offset == source.len() {
            break;
        }
        let start = lexer.offset;
        if lexer.token().is_err() {
            // step over exactly one character, so a bad byte costs one token
            // and never loops
            let width = lexer.rest().chars().next().map_or(1, char::len_utf8);
            lexer.offset = start + width;
            lexer.tokens.push(Token {
                kind: TokenKind::Invalid,
                span: Span::new(start, lexer.offset),
            });
        }
    }
    lexer.tokens
}

pub(crate) fn lex(source: &str) -> Result<Vec<Token>, ParseError> {
    let mut lexer = Lexer {
        source,
        offset: 0,
        tokens: Vec::new(),
    };
    while lexer.offset < source.len() {
        lexer.skip_whitespace();
        if lexer.offset == source.len() {
            break;
        }
        lexer.token()?;
    }
    lexer.tokens.push(Token {
        kind: TokenKind::Eof,
        span: Span::new(source.len(), source.len()),
    });
    Ok(lexer.tokens)
}

struct Lexer<'a> {
    source: &'a str,
    offset: usize,
    tokens: Vec<Token>,
}

impl Lexer<'_> {
    fn skip_whitespace(&mut self) {
        while let Some(ch) = self.rest().chars().next() {
            if !ch.is_whitespace() {
                break;
            }
            self.offset += ch.len_utf8();
        }
    }

    fn token(&mut self) -> Result<(), ParseError> {
        let start = self.offset;
        let rest = self.rest();
        let first = rest.chars().next().expect("token called at EOF");

        if first.is_ascii_alphabetic() || first == '_' {
            self.identifier();
            return Ok(());
        }
        if first.is_ascii_digit() {
            return self.integer();
        }
        if first == '"' {
            return self.string();
        }

        let (kind, width) = match rest.as_bytes() {
            [b'&', b'&', ..] => (TokenKind::AndAnd, 2),
            [b'|', b'|', ..] => (TokenKind::OrOr, 2),
            [b'=', b'=', ..] => (TokenKind::EqualEqual, 2),
            [b'!', b'=', ..] => (TokenKind::BangEqual, 2),
            [b'<', b'=', ..] => (TokenKind::LessEqual, 2),
            [b'>', b'=', ..] => (TokenKind::GreaterEqual, 2),
            [b'.', b'.', ..] => (TokenKind::DotDot, 2),
            [b'!', ..] => (TokenKind::Bang, 1),
            [b'<', ..] => (TokenKind::Less, 1),
            [b'>', ..] => (TokenKind::Greater, 1),
            [b'+', ..] => (TokenKind::Plus, 1),
            [b'-', ..] => (TokenKind::Minus, 1),
            [b'.', ..] => (TokenKind::Dot, 1),
            [b',', ..] => (TokenKind::Comma, 1),
            [b'(', ..] => (TokenKind::LeftParen, 1),
            [b')', ..] => (TokenKind::RightParen, 1),
            [b'{', ..] => (TokenKind::LeftBrace, 1),
            [b'}', ..] => (TokenKind::RightBrace, 1),
            [b'[', ..] => (TokenKind::LeftBracket, 1),
            [b']', ..] => (TokenKind::RightBracket, 1),
            _ => {
                return Err(ParseError::new(
                    format!("unexpected character `{first}`"),
                    Span::new(start, start + first.len_utf8()),
                ));
            }
        };
        self.offset += width;
        self.tokens.push(Token {
            kind,
            span: Span::new(start, self.offset),
        });
        Ok(())
    }

    fn identifier(&mut self) {
        let start = self.offset;
        self.offset += self
            .rest()
            .chars()
            .take_while(|ch| ch.is_ascii_alphanumeric() || *ch == '_')
            .map(char::len_utf8)
            .sum::<usize>();
        let text = &self.source[start..self.offset];
        let kind = match text {
            "true" => TokenKind::True,
            "false" => TokenKind::False,
            "in" => TokenKind::In,
            "is" => TokenKind::Is,
            "not" => TokenKind::Not,
            "and" => TokenKind::And,
            "or" => TokenKind::Or,
            "None" => TokenKind::None,
            // `overlaps`, `contains` and `len` are ordinary identifiers: the
            // first two are method names now, and the third a function
            _ => TokenKind::Identifier(text.to_owned()),
        };
        self.tokens.push(Token {
            kind,
            span: Span::new(start, self.offset),
        });
    }

    /// True when the byte `ahead` positions past the cursor is a digit.
    fn digit_at(&self, ahead: usize) -> bool {
        self.rest().as_bytes().get(ahead).is_some_and(u8::is_ascii_digit)
    }

    fn eat_digits(&mut self) {
        while self.rest().as_bytes().first().is_some_and(u8::is_ascii_digit) {
            self.offset += 1;
        }
    }

    fn integer(&mut self) -> Result<(), ParseError> {
        let start = self.offset;
        let hexadecimal = self.rest().starts_with("0x");
        if hexadecimal {
            self.offset += 2;
        }
        let digits_start = self.offset;
        let mut saw_digit = false;
        let mut previous_underscore = false;

        while let Some(ch) = self.rest().chars().next() {
            let digit = if hexadecimal {
                ch.is_ascii_hexdigit()
            } else {
                ch.is_ascii_digit()
            };
            if digit {
                saw_digit = true;
                previous_underscore = false;
                self.offset += 1;
            } else if ch == '_' {
                if !saw_digit || previous_underscore {
                    return Err(ParseError::new(
                        "invalid underscore in integer literal",
                        Span::new(self.offset, self.offset + 1),
                    ));
                }
                previous_underscore = true;
                self.offset += 1;
            } else {
                break;
            }
        }
        if !saw_digit {
            return Err(ParseError::new(
                "expected digits after `0x`",
                Span::new(start, self.offset),
            ));
        }
        if previous_underscore {
            return Err(ParseError::new(
                "integer literal cannot end with an underscore",
                Span::new(self.offset - 1, self.offset),
            ));
        }

        let digits_end = self.offset;

        // A fraction or an exponent makes this a float. Both are decimal-only,
        // and both are consumed before the unit suffix is read, so `1e-3` is
        // an exponent rather than a literal in an unknown unit `e`.
        let mut float = false;
        if !hexadecimal {
            // The dot is a decimal point only when a digit follows it, which
            // is what keeps `0..8` a range whose lower bound is `0` and
            // `0.2..0.8` a range between two floats.
            if self.rest().starts_with('.') && self.digit_at(1) {
                float = true;
                self.offset += 1;
                self.eat_digits();
            }
            let exponent = self.rest().as_bytes().first().is_some_and(|c| *c == b'e' || *c == b'E');
            let signed = self.rest().as_bytes().get(1).is_some_and(|c| *c == b'+' || *c == b'-');
            if exponent && (self.digit_at(1) || (signed && self.digit_at(2))) {
                float = true;
                self.offset += if signed { 2 } else { 1 };
                self.eat_digits();
            }
        }
        let number_end = self.offset;

        while self
            .rest()
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphabetic)
        {
            self.offset += 1;
        }
        let suffix = &self.source[number_end..self.offset];
        let unit = match suffix {
            "" => None,
            "B" => Some(Unit::Bytes),
            "KiB" => Some(Unit::Kibibytes),
            "MiB" => Some(Unit::Mebibytes),
            "GiB" => Some(Unit::Gibibytes),
            "ns" => Some(Unit::Nanoseconds),
            "us" => Some(Unit::Microseconds),
            "ms" => Some(Unit::Milliseconds),
            "s" => Some(Unit::Seconds),
            _ => {
                return Err(ParseError::new(
                    format!("unknown numeric unit `{suffix}`"),
                    Span::new(number_end, self.offset),
                ));
            }
        };

        if float {
            let text: String = self.source[start..number_end]
                .chars()
                .filter(|ch| *ch != '_')
                .collect();
            let value = text.parse::<f64>().map_err(|_| {
                ParseError::new("invalid float literal", Span::new(start, number_end))
            })?;
            if !value.is_finite() {
                return Err(ParseError::new(
                    "float literal overflows",
                    Span::new(start, number_end),
                ));
            }
            self.tokens.push(Token {
                kind: TokenKind::Float(FloatLiteral { value, unit }),
                span: Span::new(start, self.offset),
            });
            return Ok(());
        }

        let digits: String = self.source[digits_start..digits_end]
            .chars()
            .filter(|ch| *ch != '_')
            .collect();
        let radix = if hexadecimal { 16 } else { 10 };
        let value = u128::from_str_radix(&digits, radix).map_err(|_| {
            ParseError::new("integer literal is too large", Span::new(start, digits_end))
        })?;
        self.tokens.push(Token {
            kind: TokenKind::Integer(IntegerLiteral {
                value,
                hexadecimal,
                unit,
            }),
            span: Span::new(start, self.offset),
        });
        Ok(())
    }

    fn string(&mut self) -> Result<(), ParseError> {
        let start = self.offset;
        self.offset += 1;
        let mut value = String::new();

        loop {
            let ch = self.rest().chars().next().ok_or_else(|| {
                ParseError::new(
                    "unterminated string literal",
                    Span::new(start, self.source.len()),
                )
            })?;
            match ch {
                '"' => {
                    self.offset += 1;
                    break;
                }
                '\\' => {
                    self.offset += 1;
                    self.escape(&mut value)?;
                }
                ch if ch <= '\u{1f}' => {
                    return Err(ParseError::new(
                        "unescaped control character in string literal",
                        Span::new(self.offset, self.offset + ch.len_utf8()),
                    ));
                }
                _ => {
                    value.push(ch);
                    self.offset += ch.len_utf8();
                }
            }
        }

        self.tokens.push(Token {
            kind: TokenKind::String(value),
            span: Span::new(start, self.offset),
        });
        Ok(())
    }

    fn escape(&mut self, value: &mut String) -> Result<(), ParseError> {
        let escape_start = self.offset.saturating_sub(1);
        let escaped = self.rest().chars().next().ok_or_else(|| {
            ParseError::new(
                "unterminated string escape",
                Span::new(escape_start, self.source.len()),
            )
        })?;
        self.offset += escaped.len_utf8();
        match escaped {
            '"' | '\\' | '/' => value.push(escaped),
            'b' => value.push('\u{0008}'),
            'f' => value.push('\u{000c}'),
            'n' => value.push('\n'),
            'r' => value.push('\r'),
            't' => value.push('\t'),
            'u' => {
                let first = self.hex_escape(escape_start)?;
                if (0xd800..=0xdbff).contains(&first) {
                    if !self.rest().starts_with("\\u") {
                        return Err(ParseError::new(
                            "high surrogate must be followed by a low surrogate",
                            Span::new(escape_start, self.offset),
                        ));
                    }
                    self.offset += 2;
                    let second = self.hex_escape(escape_start)?;
                    if !(0xdc00..=0xdfff).contains(&second) {
                        return Err(ParseError::new(
                            "high surrogate must be followed by a low surrogate",
                            Span::new(escape_start, self.offset),
                        ));
                    }
                    let scalar =
                        0x1_0000 + (((first - 0xd800) as u32) << 10) + (second - 0xdc00) as u32;
                    value.push(char::from_u32(scalar).expect("valid surrogate pair"));
                } else if (0xdc00..=0xdfff).contains(&first) {
                    return Err(ParseError::new(
                        "unexpected low surrogate",
                        Span::new(escape_start, self.offset),
                    ));
                } else {
                    value.push(char::from_u32(first as u32).expect("non-surrogate codepoint"));
                }
            }
            _ => {
                return Err(ParseError::new(
                    format!("invalid string escape `\\{escaped}`"),
                    Span::new(escape_start, self.offset),
                ));
            }
        }
        Ok(())
    }

    fn hex_escape(&mut self, escape_start: usize) -> Result<u16, ParseError> {
        if self.rest().len() < 4 {
            return Err(ParseError::new(
                "incomplete Unicode escape",
                Span::new(escape_start, self.source.len()),
            ));
        }
        let raw = &self.rest().as_bytes()[..4];
        if !raw.iter().all(u8::is_ascii_hexdigit) {
            return Err(ParseError::new(
                "Unicode escape must contain four hexadecimal digits",
                Span::new(self.offset, self.offset + 4),
            ));
        }
        let raw = std::str::from_utf8(raw).expect("hexadecimal digits are UTF-8");
        let value = u16::from_str_radix(raw, 16).expect("validated hexadecimal");
        self.offset += 4;
        Ok(value)
    }

    fn rest(&self) -> &str {
        &self.source[self.offset..]
    }
}
