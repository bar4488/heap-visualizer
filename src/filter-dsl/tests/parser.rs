use heap_visualizer_filter_dsl::{
    parse, BinaryOp, Expr, ExprKind, Span, UnaryOp, Unit, MAX_ARGUMENTS, MAX_NESTING,
    MAX_SOURCE_BYTES,
};

fn binary(expr: &Expr) -> (BinaryOp, &Expr, &Expr) {
    match &expr.kind {
        ExprKind::Binary { op, left, right } => (*op, left, right),
        other => panic!("expected binary expression, got {other:?}"),
    }
}

fn identifier(expr: &Expr) -> &str {
    match &expr.kind {
        ExprKind::Identifier(name) => name,
        other => panic!("expected identifier, got {other:?}"),
    }
}

#[test]
fn parses_the_documented_examples() {
    for source in [
        "alloc.size >= 4KiB",
        "malloc.site == \"json_node\" and malloc.thread in {2, 4}",
        "alloc.span.overlaps(range(0x7f00_0000, 0x7f10_0000))",
        "\"suspect\" in alloc.tags and alloc.lifetime > 500ms",
        "alloc.tags == {\"suspect\", \"parser\"}",
        "alloc.freed and malloc.site.startswith(\"xml_\")",
        "\"parse_config\" in malloc.stack",
        "malloc.fields.pool == \"gfx\" and malloc.fields.refs >= 3",
        "malloc.fields[\"allocator-class\"] == \"small\"",
        "alloc.address >= named(\"request root\").address - 0x100",
        "abs(malloc.seq - named(\"request root\").seq) <= 10",
        "malloc.site is None",
        "malloc.site is not None",
        "0 <= alloc.size < 4096",
        "len(alloc.tags) > 1",
        "free.fields.reason == \"shutdown\"",
        "alloc.address in range(0x1000, 0x1800)",
    ] {
        parse(source).unwrap_or_else(|error| panic!("{source:?}: {error}"));
    }
}

#[test]
fn precedence_is_postfix_additive_comparison_not_and_or() {
    let expr = parse("not freed or size + 1 >= 4 and site == \"x\"").unwrap();
    let (op, left, right) = binary(&expr);
    assert_eq!(op, BinaryOp::Or);
    assert!(matches!(
        left.kind,
        ExprKind::Unary {
            op: UnaryOp::Not,
            ..
        }
    ));

    let (op, comparison, site) = binary(right);
    assert_eq!(op, BinaryOp::And);
    assert_eq!(binary(comparison).0, BinaryOp::GreaterEqual);
    assert_eq!(binary(binary(comparison).1).0, BinaryOp::Add);
    assert_eq!(binary(site).0, BinaryOp::Equal);
}

/// Python puts `not` looser than the comparisons, so it negates the whole
/// comparison. The old `!` bound tighter, which is the one precedence this
/// language changed rather than only respelled.
#[test]
fn not_is_looser_than_a_comparison() {
    let expr = parse("not size == 64").unwrap();
    let ExprKind::Unary { op: UnaryOp::Not, expr: inner } = &expr.kind else {
        panic!("expected `not` outermost, got {:?}", expr.kind);
    };
    assert_eq!(binary(inner).0, BinaryOp::Equal);
}

/// `0 <= size < 4096` is the conjunction of its links, as in Python.
#[test]
fn comparisons_chain() {
    let expr = parse("0 <= size < 4096").unwrap();
    let (op, left, right) = binary(&expr);
    assert_eq!(op, BinaryOp::And);
    assert_eq!(binary(left).0, BinaryOp::LessEqual);
    assert_eq!(binary(right).0, BinaryOp::Less);
    // the shared operand appears in both links
    assert_eq!(identifier(binary(left).2), "size");
    assert_eq!(identifier(binary(right).1), "size");

    let long = parse("1 < a <= b < 4").unwrap();
    assert_eq!(binary(&long).0, BinaryOp::And);
}

/// Each removed spelling names what replaced it. There is no compatibility
/// mode, so these are errors and not warnings.
#[test]
fn the_removed_spellings_name_their_replacement() {
    for (source, replacement) in [
        ("a && b", "`and`"),
        ("a || b", "`or`"),
        ("!freed", "`not`"),
        ("address in 0x10..0x20", "`range(lo, hi)`"),
    ] {
        let error = parse(source).unwrap_err();
        assert!(
            error.message.contains(replacement),
            "{source:?}: expected {replacement}, got {error}"
        );
    }
}

#[test]
fn range_is_a_call_with_two_bounds() {
    let expr = parse("address in range(0x10, 0x20)").unwrap();
    let (op, _, right) = binary(&expr);
    assert_eq!(op, BinaryOp::In);
    let ExprKind::Range { start, end } = &right.kind else {
        panic!("expected a range, got {:?}", right.kind);
    };
    assert_eq!(integer_value(start), 16);
    assert_eq!(integer_value(end), 32);

    assert!(parse("address in range(1)").unwrap_err().message.contains("two bounds"));
    assert!(parse("address in range(1, 2, 3)").unwrap_err().message.contains("expected `)`"));
}

#[test]
fn overlaps_is_a_method_on_a_range() {
    let expr = parse("span.overlaps(range(0x10, 0x20))").unwrap();
    let ExprKind::Call { callee, arguments } = &expr.kind else {
        panic!("expected a method call");
    };
    assert_eq!(arguments.len(), 1);
    assert!(matches!(&arguments[0].kind, ExprKind::Range { .. }));
    assert!(matches!(&callee.kind, ExprKind::Field { name, .. } if name == "overlaps"));
}

#[test]
fn binary_operators_are_left_associative() {
    let expr = parse("a - b - c").unwrap();
    let (op, left, right) = binary(&expr);
    assert_eq!(op, BinaryOp::Subtract);
    assert_eq!(identifier(right), "c");
    assert_eq!(binary(left).0, BinaryOp::Subtract);
}

#[test]
fn field_index_call_and_method_are_source_spanned() {
    let source = "named(\"root\").field[\"allocator-class\"].starts_with(\"s\")";
    let expr = parse(source).unwrap();
    assert_eq!(expr.span, Span::new(0, source.len()));
    let ExprKind::Call { callee, arguments } = &expr.kind else {
        panic!("expected outer method call");
    };
    assert_eq!(arguments.len(), 1);
    let ExprKind::Field { name, .. } = &callee.kind else {
        panic!("expected method field");
    };
    assert_eq!(name, "starts_with");
}

#[test]
fn parses_sets_ranges_and_missing_tests() {
    let set = parse("thread in {1, 2,}").unwrap();
    let (op, _, values) = binary(&set);
    assert_eq!(op, BinaryOp::In);
    assert!(matches!(&values.kind, ExprKind::Set(items) if items.len() == 2));

    let range = parse("address in range(0x10, 0x20)").unwrap();
    assert!(matches!(
        &binary(&range).2.kind,
        ExprKind::Range { start: _, end: _ }
    ));

    let none = parse("site is not None").unwrap();
    assert!(matches!(none.kind, ExprKind::IsNone { negated: true, .. }));
    let none = parse("site is None").unwrap();
    assert!(matches!(none.kind, ExprKind::IsNone { negated: false, .. }));
}

#[test]
fn sets_compare_for_equality_and_contains_one_member() {
    let equality = parse("tags == {\"a\", \"aa\"}").unwrap();
    let (op, left, right) = binary(&equality);
    assert_eq!(op, BinaryOp::Equal);
    assert_eq!(identifier(left), "tags");
    assert!(matches!(&right.kind, ExprKind::Set(items) if items.len() == 2));

    let empty = parse("tags != {}").unwrap();
    let (op, _, right) = binary(&empty);
    assert_eq!(op, BinaryOp::NotEqual);
    assert!(matches!(&right.kind, ExprKind::Set(items) if items.is_empty()));

    // membership is `in`, the same operator sets, strings and stacks all use
    let membership = parse("\"a\" in tags").unwrap();
    let (op, left, right) = binary(&membership);
    assert_eq!(op, BinaryOp::In);
    assert!(matches!(&left.kind, ExprKind::String(value) if value == "a"));
    assert_eq!(identifier(right), "tags");

    // and a set literal is not an operand of the ordering comparisons
    assert!(parse("tags < {\"a\"}").is_err());
}

#[test]
fn parses_canonical_integer_forms_and_units() {
    let expr = parse("size >= 0x1_0000").unwrap();
    let integer = binary(&expr).2;
    assert!(matches!(
        &integer.kind,
        ExprKind::Integer(value)
            if value.value == 65_536 && value.hexadecimal && value.unit.is_none()
    ));

    let expr = parse("lifetime > 500ms").unwrap();
    let integer = binary(&expr).2;
    assert!(matches!(
        &integer.kind,
        ExprKind::Integer(value)
            if value.value == 500 && value.unit == Some(Unit::Milliseconds)
    ));
}

#[test]
fn strings_use_json_escapes_including_surrogate_pairs() {
    let expr = parse(r#"name == "line\n\uD83D\uDE80""#).unwrap();
    assert!(matches!(
        &binary(&expr).2.kind,
        ExprKind::String(value) if value == "line\n🚀"
    ));
}

#[test]
fn rejects_noncanonical_or_malformed_tokens() {
    for (source, message) in [
        ("size = 1", "unexpected character `=`"),
        ("true ^ false", "unexpected character `^`"),
        ("1__0", "invalid underscore"),
        ("10_", "cannot end with an underscore"),
        ("0x", "expected digits after `0x`"),
        ("1kb", "unknown numeric unit `kb`"),
        ("\"\\q\"", "invalid string escape"),
        ("\"\\u1🚀\"", "Unicode escape must contain"),
        ("# comment", "unexpected character `#`"),
    ] {
        let error = parse(source).unwrap_err();
        assert!(
            error.message.contains(message),
            "{source:?}: expected {message:?}, got {error}"
        );
    }
}

#[test]
fn rejects_nonconstant_set_members() {
    let error = parse("thread in {other}").unwrap_err();
    assert!(error.message.contains("set members must be"));
}

#[test]
fn only_identifiers_and_methods_are_callable() {
    let error = parse("\"not a function\"()").unwrap_err();
    assert_eq!(error.message, "expected end of expression");

    parse("function()").unwrap();
    parse("site.startswith(\"x\")").unwrap();
}

#[test]
fn errors_point_at_the_unexpected_token() {
    let error = parse("size >= and site").unwrap_err();
    assert_eq!(error.message, "expected an expression");
    assert_eq!(error.span, Span::new(8, 11));

    let error = parse("site is nope").unwrap_err();
    assert_eq!(error.message, "expected `None` after `is`");
    assert_eq!(error.span, Span::new(8, 12));
}

#[test]
fn empty_source_is_not_an_expression() {
    let error = parse(" \n ").unwrap_err();
    assert_eq!(error.message, "expected an expression");
    assert_eq!(error.span, Span::new(0, 3));
}

#[test]
fn enforces_source_nesting_and_argument_limits() {
    let source = "x".repeat(MAX_SOURCE_BYTES + 1);
    assert!(parse(&source).unwrap_err().message.contains("byte limit"));

    let source = format!(
        "{}x{}",
        "(".repeat(MAX_NESTING + 1),
        ")".repeat(MAX_NESTING + 1)
    );
    assert!(parse(&source)
        .unwrap_err()
        .message
        .contains("nesting limit"));

    let arguments = (0..=MAX_ARGUMENTS)
        .map(|_| "x")
        .collect::<Vec<_>>()
        .join(",");
    assert!(parse(&format!("f({arguments})"))
        .unwrap_err()
        .message
        .contains("argument limit"));
}

#[test]
fn long_unary_chains_do_not_recurse_in_the_parser() {
    let source = format!("{}true", "not ".repeat(1_000));
    parse(&source).unwrap();
}

#[test]
fn keywords_are_not_bare_field_names() {
    let error = parse("fields.None").unwrap_err();
    assert_eq!(error.message, "expected a field or method name after `.`");
    parse("fields[\"None\"]").unwrap();
    // `overlaps` and `contains` are ordinary names now, not operators
    parse("fields.overlaps").unwrap();
    parse("fields.contains").unwrap();
}

// --- float literals --------------------------------------------------------

fn float(expr: &Expr) -> &heap_visualizer_filter_dsl::FloatLiteral {
    match &expr.kind {
        ExprKind::Float(value) => value,
        other => panic!("expected float literal, got {other:?}"),
    }
}

fn integer_value(expr: &Expr) -> u128 {
    match &expr.kind {
        ExprKind::Integer(value) => value.value,
        other => panic!("expected integer literal, got {other:?}"),
    }
}

#[test]
fn a_fraction_or_an_exponent_makes_a_float() {
    for (source, value) in [
        ("0.5", 0.5),
        ("1.25", 1.25),
        ("1e-3", 1e-3),
        ("2.5e6", 2.5e6),
        ("1E3", 1e3),
        ("1_000.5", 1000.5),
    ] {
        let parsed = parse(source).unwrap();
        assert_eq!(float(&parsed).value, value, "{source}");
    }
    // no fraction and no exponent is still an integer
    let parsed = parse("42").unwrap();
    assert_eq!(integer_value(&parsed), 42);
    let parsed = parse("0x10").unwrap();
    assert_eq!(integer_value(&parsed), 16);
}

#[test]
fn a_float_literal_takes_a_unit() {
    let parsed = parse("1.5MiB").unwrap();
    let literal = float(&parsed);
    assert_eq!(literal.value, 1.5);
    assert_eq!(literal.unit, Some(Unit::Mebibytes));
    let parsed = parse("2.5ms").unwrap();
    assert_eq!(float(&parsed).unit, Some(Unit::Milliseconds));
    // `e` is an exponent only before digits; otherwise it is read as a unit
    assert!(parse("2e").unwrap_err().message.contains("unknown numeric unit"));
}

/// `..` is gone, but it still lexes as one token so that the diagnostic can
/// name `range(lo, hi)`. That matters most between two floats, where lexing it
/// as `0.2.` + `.8` would report something unrelated instead.
#[test]
fn the_old_range_operator_still_lexes_as_one_token() {
    for source in ["size in 0..10", "x in 0.2..0.8"] {
        let error = parse(source).unwrap_err();
        assert!(
            error.message.contains("`range(lo, hi)`"),
            "{source:?}: got {error}"
        );
        assert_eq!(&source[error.span.start..error.span.end], "..");
    }
}

#[test]
fn a_range_takes_float_bounds() {
    let parsed = parse("x in range(0.2, 0.8)").unwrap();
    let (_, _, end) = binary(&parsed);
    match &end.kind {
        ExprKind::Range { start, end } => {
            assert_eq!(float(start).value, 0.2);
            assert_eq!(float(end).value, 0.8);
        }
        other => panic!("expected range, got {other:?}"),
    }
}

#[test]
fn a_float_is_a_set_member() {
    let parsed = parse("x in {0.5, 1.5}").unwrap();
    match &binary(&parsed).2.kind {
        ExprKind::Set(items) => {
            assert_eq!(items.len(), 2);
            assert_eq!(float(&items[0]).value, 0.5);
        }
        other => panic!("expected set, got {other:?}"),
    }
}
