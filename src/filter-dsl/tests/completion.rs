use heap_visualizer_filter_dsl::{
    completion_context, BinaryOp, CompletionSite, ExprKind, OperandKind, Span,
};

fn context(source: &str, cursor: usize) -> heap_visualizer_filter_dsl::CompletionContext {
    completion_context(source, cursor)
        .unwrap_or_else(|| panic!("completion context for {source:?} at {cursor}"))
}

#[test]
fn expression_and_operator_slots_are_distinct() {
    assert!(matches!(context("", 0).site, CompletionSite::Expression));
    assert!(matches!(
        context("size && ", 8).site,
        CompletionSite::Expression
    ));

    let got = context("size ", 5);
    assert_eq!(got.replacement, Span::new(5, 5));
    assert!(matches!(got.site, CompletionSite::Operator { .. }));

    let got = context("span ove", 8);
    assert_eq!(got.prefix, "ove");
    assert_eq!(got.replacement, Span::new(5, 8));
    assert!(matches!(got.site, CompletionSite::Operator { .. }));

    let got = context("span", 4);
    assert!(matches!(got.site, CompletionSite::Exact { .. }));
}

#[test]
fn identifier_completion_replaces_the_whole_token() {
    let got = context("siZZe", 2);
    assert_eq!(got.prefix, "si");
    assert_eq!(got.replacement, Span::new(0, 5));
    assert!(matches!(got.site, CompletionSite::Expression));
}

#[test]
fn member_context_carries_the_receiver() {
    let got = context("site.sta", 8);
    assert_eq!(got.prefix, "sta");
    assert_eq!(got.replacement, Span::new(5, 8));
    let CompletionSite::Member { receiver } = got.site else {
        panic!("member context");
    };
    assert!(matches!(receiver.kind, ExprKind::Identifier(ref name) if name == "site"));

    let got = context("size > 0 && death.", 18);
    let CompletionSite::Member { receiver } = got.site else {
        panic!("member context");
    };
    assert!(matches!(receiver.kind, ExprKind::Identifier(ref name) if name == "death"));
}

#[test]
fn operands_carry_the_left_expression_and_operator() {
    for (source, cursor, expected, operator) in [
        ("site == ", 8, "site", OperandKind::Binary(BinaryOp::Equal)),
        ("size > 0 && tags == {", 21, "tags", OperandKind::SetMember),
        (
            "tags contains ",
            14,
            "tags",
            OperandKind::Binary(BinaryOp::Contains),
        ),
        (
            "span overlaps ",
            14,
            "span",
            OperandKind::Binary(BinaryOp::Overlaps),
        ),
        ("size + ", 7, "size", OperandKind::Binary(BinaryOp::Add)),
        (
            "size == si",
            10,
            "size",
            OperandKind::Binary(BinaryOp::Equal),
        ),
    ] {
        let got = context(source, cursor);
        let CompletionSite::Operand { left, kind } = got.site else {
            panic!("operand context for {source:?}");
        };
        assert_eq!(kind, operator);
        assert!(matches!(left.kind, ExprKind::Identifier(ref name) if name == expected));
    }
}

#[test]
fn string_values_replace_the_literal_and_preserve_utf8_spans() {
    let source = "site == \"héllo\"";
    let cursor = source.find("llo").unwrap();
    let got = context(source, cursor);
    assert_eq!(got.replacement, Span::new(8, source.len()));
    assert_eq!(got.prefix, "hé");
    assert!(matches!(got.site, CompletionSite::Operand { .. }));

    let got = context("tags == {\"sus", 13);
    assert_eq!(got.replacement, Span::new(9, 13));
    assert_eq!(got.prefix, "sus");
    assert!(matches!(
        got.site,
        CompletionSite::Operand {
            kind: OperandKind::SetMember,
            ..
        }
    ));

    let got = context("site == \"", 9);
    assert_eq!(got.replacement, Span::new(8, 9));
    assert_eq!(got.prefix, "");

    let source = "site == \"a\"";
    assert!(matches!(
        context(source, source.len()).site,
        CompletionSite::Operator { .. }
    ));
}

#[test]
fn call_arguments_and_set_delimiters_are_distinct() {
    let got = context("abs(", 4);
    assert!(matches!(
        got.site,
        CompletionSite::CallArgument {
            callee: heap_visualizer_filter_dsl::Expr {
                kind: ExprKind::Identifier(ref name),
                ..
            },
            index: 0,
        } if name == "abs"
    ));

    let source = "site.contains(\"";
    let got = context(source, source.len());
    assert!(matches!(
        got.site,
        CompletionSite::CallArgument { index: 0, .. }
    ));

    assert!(matches!(
        context("tags == {\"suspect\"", 18).site,
        CompletionSite::SetDelimiter
    ));
    assert!(matches!(
        context("tags == {\"a\", ", 14).site,
        CompletionSite::Operand {
            kind: OperandKind::SetMember,
            ..
        }
    ));
    let source = "span overlaps 0x1000..";
    assert!(matches!(
        context(source, source.len()).site,
        CompletionSite::Operand {
            kind: OperandKind::RangeEnd,
            ..
        }
    ));
}

#[test]
fn missing_keywords_have_their_own_context() {
    assert!(matches!(
        context("site is ", 8).site,
        CompletionSite::AfterIs { negated: false }
    ));
    let got = context("site is no", 10);
    assert_eq!(got.prefix, "no");
    assert!(matches!(
        got.site,
        CompletionSite::AfterIs { negated: false }
    ));
    assert!(matches!(
        context("site is not ", 12).site,
        CompletionSite::AfterIs { negated: true }
    ));
}

#[test]
fn invalid_cursor_and_source_limits_return_no_context() {
    assert!(completion_context("é", 1).is_none());
    assert!(completion_context("x", 2).is_none());
    assert!(completion_context(&"x".repeat(8193), 0).is_none());
}
