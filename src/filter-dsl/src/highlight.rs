//! Classifying source for syntax highlighting.
//!
//! Highlighting runs on **every keystroke**, over source that is usually
//! incomplete and often invalid, so this never fails: an unlexable byte is a
//! token of its own rather than an error that stops the scan. It is also the
//! only consumer that cares where the whitespace is, since the editor
//! reconstructs the text from the tokens.
//!
//! This is the same lexer the parser uses. Highlighting from a second,
//! hand-written tokenizer would give the grammar two owners in two languages,
//! which is the thing `PROTOCOL.md` calls out under "one fact, one owner".

use crate::lexer::{lex_lossy, TokenKind};
use crate::Span;

/// What a run of source is, for the purpose of colouring it.
///
/// Deliberately coarse: these are the distinctions a reader uses to see the
/// shape of an expression, not the parser's categories.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u8)]
pub enum Class {
    /// Whitespace and anything else that carries no colour.
    Plain = 0,
    /// `and`, `or`, `not`, `in`, `is`, `None`, `true`, `false`.
    Keyword = 1,
    /// A name being read: `alloc`, `size`, a custom field key.
    Field = 2,
    /// A name being called: `abs`, `len`, `named`, `range`, `startswith`.
    Function = 3,
    /// A string literal, including its quotes.
    String = 4,
    /// A number literal, including any unit suffix.
    Number = 5,
    /// `==`, `<`, `+`, `.`, `,` and friends.
    Operator = 6,
    /// `(`, `)`, `{`, `}`, `[`, `]`.
    Bracket = 7,
    /// A byte that cannot begin a token, or a spelling this language removed.
    Invalid = 8,
}

/// One classified run of source. Spans tile the input in order and without
/// gaps, so the editor can rebuild the text from them alone.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Highlight {
    pub class: Class,
    pub span: Span,
}

/// Classify every byte of `source`.
///
/// Never fails and never allocates per byte beyond the output. The spans
/// returned cover `source` exactly: highlighting that dropped a byte would
/// silently change the text the reader sees behind the textarea.
pub fn highlight(source: &str) -> Vec<Highlight> {
    let mut out: Vec<Highlight> = Vec::new();
    let mut at = 0usize;
    let tokens = lex_lossy(source);
    for (index, token) in tokens.iter().enumerate() {
        if token.span.start > at {
            push(&mut out, Class::Plain, Span::new(at, token.span.start));
        }
        // a name is a call when a `(` follows it, which is what tells
        // `alloc.size` from `alloc.span.overlaps(...)`
        let called = matches!(&token.kind, TokenKind::Identifier(_))
            && matches!(
                tokens.get(index + 1).map(|next| &next.kind),
                Some(TokenKind::LeftParen)
            );
        let class = match &token.kind {
            TokenKind::And
            | TokenKind::Or
            | TokenKind::Not
            | TokenKind::In
            | TokenKind::Is
            | TokenKind::None
            | TokenKind::True
            | TokenKind::False => Class::Keyword,
            TokenKind::Identifier(_) if called => Class::Function,
            TokenKind::Identifier(_) => Class::Field,
            TokenKind::String(_) => Class::String,
            TokenKind::Integer(_) | TokenKind::Float(_) => Class::Number,
            TokenKind::LeftParen
            | TokenKind::RightParen
            | TokenKind::LeftBrace
            | TokenKind::RightBrace
            | TokenKind::LeftBracket
            | TokenKind::RightBracket => Class::Bracket,
            // the removed spellings colour as mistakes, which is the same
            // answer the parser gives and the reader sees it sooner
            TokenKind::AndAnd | TokenKind::OrOr | TokenKind::Bang | TokenKind::DotDot => {
                Class::Invalid
            }
            TokenKind::Invalid => Class::Invalid,
            TokenKind::Eof => continue,
            _ => Class::Operator,
        };
        push(&mut out, class, token.span);
        at = token.span.end;
    }
    if at < source.len() {
        push(&mut out, Class::Plain, Span::new(at, source.len()));
    }
    out
}

/// Append a run, merging it into the previous one when they share a class and
/// touch — fewer, longer runs mean fewer elements for the editor to build.
fn push(out: &mut Vec<Highlight>, class: Class, span: Span) {
    if span.start == span.end {
        return;
    }
    if let Some(last) = out.last_mut() {
        if last.class == class && last.span.end == span.start {
            last.span.end = span.end;
            return;
        }
    }
    out.push(Highlight { class, span });
}
