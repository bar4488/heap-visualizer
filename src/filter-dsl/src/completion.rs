use crate::lexer::{lex, Token, TokenKind};
use crate::{parse, BinaryOp, Expr, Span, MAX_SOURCE_BYTES};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OperandKind {
    Binary(BinaryOp),
    SetMember,
    RangeEnd,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CompletionSite {
    Expression,
    Exact { expression: Expr },
    Operator { expression: Expr },
    Member { receiver: Expr },
    Operand { left: Expr, kind: OperandKind },
    CallArgument { callee: Expr, index: usize },
    SetDelimiter,
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
        let site = operand_context(source, replacement.start)
            .or_else(|| call_argument_context(source, replacement.start));
        return site.map(|site| CompletionContext {
            replacement,
            prefix,
            site,
        });
    }

    let replacement = identifier_at_cursor(source, cursor);
    let prefix = source[replacement.start..cursor].to_owned();
    let before = &source[..replacement.start];
    let trimmed = before.trim_end();

    if trimmed.ends_with('.') && !trimmed.ends_with("..") {
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

    if replacement.start == replacement.end {
        if let Some(site) = set_delimiter_context(source, replacement.start) {
            return Some(CompletionContext {
                replacement,
                prefix,
                site,
            });
        }
    }

    if let Some(site) = operand_context(source, replacement.start)
        .or_else(|| call_argument_context(source, replacement.start))
    {
        return Some(CompletionContext {
            replacement,
            prefix,
            site,
        });
    }

    if replacement.end == cursor && !prefix.is_empty() {
        if let Ok(expression) = parse(source[..cursor].trim_end()) {
            return Some(CompletionContext {
                replacement,
                prefix,
                site: CompletionSite::Exact { expression },
            });
        }
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
        if cursor > start && (cursor < end || (!closed && cursor == end)) {
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

fn operand_context(source: &str, value_start: usize) -> Option<CompletionSite> {
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
                | TokenKind::Overlaps
                | TokenKind::Contains
                | TokenKind::Plus
                | TokenKind::Minus
                | TokenKind::DotDot
        )
    })?;
    let after = &meaningful[op + 1..];
    // `in` and equality can be followed by a set literal, so the cursor may sit
    // at a member rather than at the operand itself
    let takes_set = matches!(
        meaningful[op].kind,
        TokenKind::In | TokenKind::EqualEqual | TokenKind::BangEqual
    );
    if takes_set
        && after
            .first()
            .is_some_and(|token| matches!(token.kind, TokenKind::LeftBrace))
    {
        if !after
            .last()
            .is_some_and(|token| matches!(token.kind, TokenKind::LeftBrace | TokenKind::Comma))
        {
            return None;
        }
        return operand_site(source, meaningful, op, OperandKind::SetMember);
    }
    if !after.is_empty() {
        return None;
    }
    let kind = match meaningful[op].kind {
        TokenKind::EqualEqual => OperandKind::Binary(BinaryOp::Equal),
        TokenKind::BangEqual => OperandKind::Binary(BinaryOp::NotEqual),
        TokenKind::Less => OperandKind::Binary(BinaryOp::Less),
        TokenKind::LessEqual => OperandKind::Binary(BinaryOp::LessEqual),
        TokenKind::Greater => OperandKind::Binary(BinaryOp::Greater),
        TokenKind::GreaterEqual => OperandKind::Binary(BinaryOp::GreaterEqual),
        TokenKind::Overlaps => OperandKind::Binary(BinaryOp::Overlaps),
        TokenKind::Contains => OperandKind::Binary(BinaryOp::Contains),
        TokenKind::Plus => OperandKind::Binary(BinaryOp::Add),
        TokenKind::Minus => OperandKind::Binary(BinaryOp::Subtract),
        TokenKind::DotDot => OperandKind::RangeEnd,
        TokenKind::In => OperandKind::Binary(BinaryOp::In),
        _ => return None,
    };
    operand_site(source, meaningful, op, kind)
}

/// The completion site for the operator at `op`, with the left operand parsed
/// back out of the source that precedes it.
fn operand_site(
    source: &str,
    meaningful: &[Token],
    op: usize,
    kind: OperandKind,
) -> Option<CompletionSite> {
    let start = meaningful[..op]
        .iter()
        .rposition(|token| {
            matches!(
                token.kind,
                TokenKind::AndAnd
                    | TokenKind::OrOr
                    | TokenKind::EqualEqual
                    | TokenKind::BangEqual
                    | TokenKind::Less
                    | TokenKind::LessEqual
                    | TokenKind::Greater
                    | TokenKind::GreaterEqual
                    | TokenKind::In
                    | TokenKind::Overlaps
                    | TokenKind::Contains
                    | TokenKind::Plus
                    | TokenKind::Minus
                    | TokenKind::DotDot
                    | TokenKind::LeftParen
                    | TokenKind::LeftBrace
                    | TokenKind::Comma
            )
        })
        .map_or(0, |index| meaningful[index].span.end);
    let end = meaningful[op].span.start;
    let left_source = source[start..end].trim();
    let left = parse(left_source).ok()?;
    Some(CompletionSite::Operand { left, kind })
}

fn call_argument_context(source: &str, value_start: usize) -> Option<CompletionSite> {
    let tokens = lex(&source[..value_start]).ok()?;
    let meaningful = &tokens[..tokens.len().saturating_sub(1)];
    let mut depth = 0usize;
    let mut open = None;
    for (index, token) in meaningful.iter().enumerate().rev() {
        match token.kind {
            TokenKind::RightParen => depth += 1,
            TokenKind::LeftParen if depth > 0 => depth -= 1,
            TokenKind::LeftParen => {
                open = Some(index);
                break;
            }
            _ => {}
        }
    }
    let open = open?;
    if open == 0 {
        return None;
    }
    let callee_end = meaningful[open].span.start;
    let callee_start = meaningful[..open]
        .iter()
        .rposition(|token| {
            matches!(
                token.kind,
                TokenKind::AndAnd
                    | TokenKind::OrOr
                    | TokenKind::EqualEqual
                    | TokenKind::BangEqual
                    | TokenKind::Less
                    | TokenKind::LessEqual
                    | TokenKind::Greater
                    | TokenKind::GreaterEqual
                    | TokenKind::Plus
                    | TokenKind::Minus
                    | TokenKind::Comma
                    | TokenKind::LeftParen
            )
        })
        .map_or(0, |index| meaningful[index].span.end);
    let callee = parse(source[callee_start..callee_end].trim()).ok()?;
    let index = meaningful[open + 1..]
        .iter()
        .filter(|token| matches!(token.kind, TokenKind::Comma))
        .count();
    Some(CompletionSite::CallArgument { callee, index })
}

fn set_delimiter_context(source: &str, cursor: usize) -> Option<CompletionSite> {
    let tokens = lex(&source[..cursor]).ok()?;
    let meaningful = &tokens[..tokens.len().saturating_sub(1)];
    let open = meaningful
        .iter()
        .rposition(|token| matches!(token.kind, TokenKind::LeftBrace))?;
    if meaningful[open + 1..]
        .iter()
        .any(|token| matches!(token.kind, TokenKind::RightBrace))
    {
        return None;
    }
    let last = meaningful.last()?;
    if matches!(
        last.kind,
        TokenKind::String(_) | TokenKind::Integer(_) | TokenKind::True | TokenKind::False
    ) {
        Some(CompletionSite::SetDelimiter)
    } else {
        None
    }
}
