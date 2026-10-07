//! Deterministic fuzzing of the three entry points that see half-written
//! source on every keystroke. None may panic, at any cursor, and every span
//! they return must name whole characters.

use heap_visualizer_filter_dsl::{completion_context, highlight, parse, Expr, ExprKind, Span};

/// Tokens, partial tokens and characters chosen to reach the lexer's and
/// completion's edge cases: escapes, multibyte text next to every kind of
/// literal, unbalanced brackets, and the removed spellings.
const ALPHABET: &[&str] = &[
    "a", "x", "alloc", ".", "size", "named", "range", "len", "contains", "overlaps",
    "missing", " ", "  ", "\n", "(", ")", "{", "}", "[", "]", "\"", "\\", "\\u", "\\u12",
    "é", "€", "🚀", "\u{a0}", "..", ",", "==", "!=", "<", "<=", ">", ">=", "-", "+", "1",
    "0x", "0X", "e", "E", "_", "9", "1.5", "KiB", "ms", "in", "is", "not", "None", "and",
    "or", "true", "&&", "||", "!", "#",
];

/// xorshift64: deterministic, so a failure reproduces from the seed.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }

    fn below(&mut self, bound: usize) -> usize {
        (self.next() % bound as u64) as usize
    }
}

fn assert_whole(source: &str, span: Span, what: &str) {
    assert!(
        span.start <= span.end
            && span.end <= source.len()
            && source.is_char_boundary(span.start)
            && source.is_char_boundary(span.end),
        "{what} span {span:?} splits {source:?}"
    );
}

/// Every span in a tree parsed from `source` names whole characters of it.
fn assert_tree(source: &str, expr: &Expr) {
    assert_whole(source, expr.span, "expression");
    match &expr.kind {
        ExprKind::Unary { expr, .. } | ExprKind::IsNone { expr, .. } => assert_tree(source, expr),
        ExprKind::Binary { left, right, .. } => {
            assert_tree(source, left);
            assert_tree(source, right);
        }
        ExprKind::Field { base, .. } | ExprKind::Index { base, .. } => assert_tree(source, base),
        ExprKind::Call { callee, arguments } => {
            assert_tree(source, callee);
            for argument in arguments {
                assert_tree(source, argument);
            }
        }
        ExprKind::Set(members) => {
            for member in members {
                assert_tree(source, member);
            }
        }
        ExprKind::Range { start, end } => {
            assert_tree(source, start);
            assert_tree(source, end);
        }
        ExprKind::Bool(_)
        | ExprKind::Integer(_)
        | ExprKind::Float(_)
        | ExprKind::String(_)
        | ExprKind::Identifier(_) => {}
    }
}

fn check(source: &str) {
    match parse(source) {
        Ok(expr) => assert_tree(source, &expr),
        Err(error) => assert_whole(source, error.span, "error"),
    }

    let mut at = 0;
    for run in highlight(source) {
        assert_eq!(run.span.start, at, "highlight gap in {source:?}");
        assert!(run.span.end > run.span.start, "empty run in {source:?}");
        assert_whole(source, run.span, "highlight");
        at = run.span.end;
    }
    assert_eq!(at, source.len(), "highlight stops short in {source:?}");

    // every byte offset, so a cursor inside a character is tried too (it must
    // be refused, not sliced)
    for cursor in 0..=source.len() {
        let Some(context) = completion_context(source, cursor) else {
            continue;
        };
        assert!(source.is_char_boundary(cursor), "cursor {cursor} in {source:?}");
        assert_whole(source, context.replacement, "replacement");
        assert!(
            context.replacement.start <= cursor && cursor <= context.replacement.end,
            "replacement {:?} misses cursor {cursor} in {source:?}",
            context.replacement
        );
        assert_eq!(
            context.prefix,
            source[context.replacement.start..cursor].trim_start_matches('"'),
            "prefix in {source:?} at {cursor}"
        );
    }
}

#[test]
fn random_source_never_panics_and_spans_name_whole_characters() {
    let mut rng = Rng(0x5eed_f11e_d5c0_ffee);
    for _ in 0..20_000 {
        let length = rng.below(16);
        let source: String = (0..length)
            .map(|_| ALPHABET[rng.below(ALPHABET.len())])
            .collect();
        check(&source);
    }
}

/// The review's reproductions, each of which panicked or overflowed.
#[test]
fn known_crashes_stay_fixed() {
    for source in [
        "x == \"\\é\"",
        "\"\\é",
        "0x€",
        "1e€",
        "\"\\é€",
        "x == \"\\u12€\"",
        "named(\"x\").malloc.site == \"",
        "f(g(a, b), ",
    ] {
        check(source);
    }
    for source in [
        format!("alloc.size == {}1", "-".repeat(8_100)),
        format!("alloc.size == {}1", "1+".repeat(4_000)),
    ] {
        assert!(parse(&source).is_err());
        highlight(&source);
        completion_context(&source, source.len());
    }
}
