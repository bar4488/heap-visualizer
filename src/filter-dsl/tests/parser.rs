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
        "size >= 4KiB",
        "site == \"json_node\" && thread in {2, 4}",
        "span overlaps 0x7f00_0000..0x7f10_0000",
        "tag in {\"suspect\", \"parser\"} && lifetime > 500ms",
        "freed && site.starts_with(\"xml_\")",
        "stack.contains(\"parse_config\")",
        "field.pool == \"gfx\" && field.refs >= 3",
        "field[\"allocator-class\"] == \"small\"",
        "address >= named(\"request root\").address - 0x100",
        "address <= named(\"request root\").address",
        "abs(seq - named(\"request root\").seq) <= 10",
        "site is missing",
    ] {
        parse(source).unwrap_or_else(|error| panic!("{source:?}: {error}"));
    }
}

#[test]
fn precedence_is_postfix_unary_additive_comparison_and_or() {
    let expr = parse("!freed || size + 1 >= 4 && site == \"x\"").unwrap();
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

    let range = parse("address in 0x10..0x20").unwrap();
    assert!(matches!(
        &binary(&range).2.kind,
        ExprKind::Range { start: _, end: _ }
    ));

    let missing = parse("site is not missing").unwrap();
    assert!(matches!(
        missing.kind,
        ExprKind::IsMissing { negated: true, .. }
    ));
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
        ("true & false", "unexpected character `&`"),
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
fn rejects_comparison_chaining_and_nonconstant_sets() {
    let error = parse("0 <= size < 10").unwrap_err();
    assert_eq!(error.message, "expected end of expression");
    assert_eq!(error.span, Span::new(10, 11));

    let error = parse("thread in {other}").unwrap_err();
    assert!(error.message.contains("set members must be"));
}

#[test]
fn only_identifiers_and_methods_are_callable() {
    let error = parse("\"not a function\"()").unwrap_err();
    assert_eq!(error.message, "expected end of expression");

    parse("function()").unwrap();
    parse("site.contains(\"x\")").unwrap();
}

#[test]
fn errors_point_at_the_unexpected_token() {
    let error = parse("size >= && site").unwrap_err();
    assert_eq!(error.message, "expected an expression");
    assert_eq!(error.span, Span::new(8, 10));

    let error = parse("site is nope").unwrap_err();
    assert_eq!(error.message, "expected `missing` after `is`");
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
    let source = format!("{}true", "!".repeat(1_000));
    parse(&source).unwrap();
}

#[test]
fn keywords_are_not_bare_field_names() {
    let error = parse("field.missing").unwrap_err();
    assert_eq!(error.message, "expected a field or method name after `.`");
    parse("field[\"missing\"]").unwrap();
}
