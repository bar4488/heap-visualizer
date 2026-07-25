use crate::lexer::{lex, Token, TokenKind};
use crate::{parse, Expr, Span, MAX_SOURCE_BYTES};

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CompletionSite {
    Expression,
    Operator { expression: Expr },
    Member { receiver: Expr },
    Value { subject: Expr },
    AfterIs { negated: bool },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CompletionContext {
    pub replacement: Span,
    pub prefix: String,
    pub site: CompletionSite,
}

/// Describes the syntactic slot at `cursor`, which is a UTF-8 byte offset.
///
/// This deliberately accepts incomplete source. It never produces an
/// executable recovered tree: the returned expressions only describe the
/// already-complete receiver or left operand surrounding the cursor.
pub fn completion_context(source: &str, cursor: usize) -> Option<CompletionContext> {
    if source.len() > MAX_SOURCE_BYTES || cursor > source.len() || !source.is_char_boundary(cursor)
    {
        return None;
    }

    if let Some((replacement, prefix)) = string_at_cursor(source, cursor) {
        return comparison_subject(source, replacement.start).map(|subject| CompletionContext {
            replacement,
            prefix,
            site: CompletionSite::Value { subject },
        });
    }

    let replacement = identifier_at_cursor(source, cursor);
    let prefix = source[replacement.start..cursor].to_owned();
    let before = &source[..replacement.start];
    let trimmed = before.trim_end();

    if trimmed.ends_with('.') {
        return receiver_before_dot(source, trimmed.len() - 1).map(|receiver| CompletionContext {
            replacement,
            prefix,
            site: CompletionSite::Member { receiver },
        });
    }

    if let Some(negated) = after_is(trimmed) {
        return Some(CompletionContext {
            replacement,
            prefix,
            site: CompletionSite::AfterIs { negated },
        });
    }

    if let Some(subject) = comparison_subject(source, replacement.start) {
        return Some(CompletionContext {
            replacement,
            prefix,
            site: CompletionSite::Value { subject },
        });
    }

    if !trimmed.is_empty() {
        if let Ok(expression) = parse(trimmed) {
            return Some(CompletionContext {
                replacement,
                prefix,
                site: CompletionSite::Operator { expression },
            });
        }
    }

    Some(CompletionContext {
        replacement,
        prefix,
        site: CompletionSite::Expression,
    })
}

fn identifier_at_cursor(source: &str, cursor: usize) -> Span {
    let bytes = source.as_bytes();
    let mut start = cursor;
    while start > 0 && is_identifier_continue(bytes[start - 1]) {
        start -= 1;
    }
    let mut end = cursor;
    while end < bytes.len() && is_identifier_continue(bytes[end]) {
        end += 1;
    }
    if start < end && !is_identifier_start(bytes[start]) {
        Span::new(cursor, cursor)
    } else {
        Span::new(start, end)
    }
}

fn is_identifier_start(byte: u8) -> bool {
    byte.is_ascii_alphabetic() || byte == b'_'
}

fn is_identifier_continue(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

fn string_at_cursor(source: &str, cursor: usize) -> Option<(Span, String)> {
    let bytes = source.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'"' {
            i += source[i..].chars().next()?.len_utf8();
            continue;
        }
        let start = i;
        i += 1;
        let mut escaped = false;
        let mut closed = false;
        while i < bytes.len() {
            let byte = bytes[i];
            if escaped {
                escaped = false;
                i += 1;
            } else if byte == b'\\' {
                escaped = true;
                i += 1;
            } else if byte == b'"' {
                i += 1;
                closed = true;
                break;
            } else {
                i += source[i..].chars().next()?.len_utf8();
            }
        }
        let end = i;
        if cursor > start && cursor <= end {
            let prefix_end = cursor.min(end.saturating_sub(closed as usize));
            return Some((
                Span::new(start, end),
                source[start + 1..prefix_end].to_owned(),
            ));
        }
    }
    None
}

fn after_is(source: &str) -> Option<bool> {
    let tokens = lex(source).ok()?;
    let meaningful = &tokens[..tokens.len().saturating_sub(1)];
    match meaningful {
        [.., Token {
            kind: TokenKind::Is,
            ..
        }] => Some(false),
        [.., Token {
            kind: TokenKind::Is,
            ..
        }, Token {
            kind: TokenKind::Not,
            ..
        }] => Some(true),
        _ => None,
    }
}

fn receiver_before_dot(source: &str, dot: usize) -> Option<Expr> {
    let tokens = lex(&source[..dot]).ok()?;
    let token = tokens
        .iter()
        .rev()
        .find(|token| !matches!(token.kind, TokenKind::Eof))?;
    parse(&source[token.span.start..token.span.end]).ok()
}

fn comparison_subject(source: &str, value_start: usize) -> Option<Expr> {
    let tokens = lex(&source[..value_start]).ok()?;
    let meaningful = &tokens[..tokens.len().saturating_sub(1)];
    let op = meaningful.iter().rposition(|token| {
        matches!(
            token.kind,
            TokenKind::EqualEqual
                | TokenKind::BangEqual
                | TokenKind::Less
                | TokenKind::LessEqual
                | TokenKind::Greater
                | TokenKind::GreaterEqual
                | TokenKind::In
        )
    })?;
    if meaningful[op + 1..]
        .iter()
        .any(|token| !matches!(token.kind, TokenKind::LeftBrace | TokenKind::Comma))
    {
        return None;
    }
    let start = meaningful[..op]
        .iter()
        .rposition(|token| {
            matches!(
                token.kind,
                TokenKind::AndAnd | TokenKind::OrOr | TokenKind::LeftParen | TokenKind::Comma
            )
        })
        .map_or(0, |index| meaningful[index].span.end);
    let end = meaningful[op].span.start;
    parse(source[start..end].trim()).ok()
}
