use heap_visualizer_filter_dsl::{
    completion_context, BinaryOp, CompletionSite, Expr, ExprKind, OperandKind, Span,
    MAX_SOURCE_BYTES,
};

fn context(source: &str, cursor: usize) -> heap_visualizer_filter_dsl::CompletionContext {
    completion_context(source, cursor)
        .unwrap_or_else(|| panic!("completion context for {source:?} at {cursor}"))
}

#[test]
fn expression_and_operator_slots_are_distinct() {
    assert!(matches!(context("", 0).site, CompletionSite::Expression));
    assert!(matches!(
        context("size and ", 9).site,
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

    let got = context("size > 0 and free.", 18);
    let CompletionSite::Member { receiver } = got.site else {
        panic!("member context");
    };
    assert!(matches!(receiver.kind, ExprKind::Identifier(ref name) if name == "free"));
}

#[test]
fn operands_carry_the_left_expression_and_operator() {
    for (source, cursor, expected, operator) in [
        ("site == ", 8, "site", OperandKind::Binary(BinaryOp::Equal)),
        ("size > 0 and tags == {", 22, "tags", OperandKind::SetMember),
        ("size in ", 8, "size", OperandKind::Binary(BinaryOp::In)),
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
    // a range is a call now, so its second bound is an ordinary call argument
    let source = "address in range(0x1000, ";
    let CompletionSite::CallArgument { callee, index } = context(source, source.len()).site else {
        panic!("call argument context for the second bound");
    };
    assert!(matches!(callee.kind, ExprKind::Identifier(ref name) if name == "range"));
    assert_eq!(index, 1);
}

#[test]
fn none_keywords_have_their_own_context() {
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
    assert!(completion_context(&"x".repeat(MAX_SOURCE_BYTES + 1), 0).is_none());
}

/// A backslash escapes one character, not one byte: stepping a single byte
/// past `\é` used to land inside the `é` and panic on the next slice.
#[test]
fn an_escaped_multibyte_character_is_stepped_over_whole() {
    let source = "x == \"\\é\"";
    for cursor in (0..=source.len()).filter(|at| source.is_char_boundary(*at)) {
        completion_context(source, cursor);
    }
    let got = context(source, source.len() - 1);
    assert_eq!(got.replacement, Span::new(5, source.len()));
    assert_eq!(got.prefix, "\\é");
    completion_context("\"\\é", 3);
}

/// The source of `expr`, which completion parses out of a slice of the input,
/// so its spans are relative to that slice.
fn spelled(expr: &Expr) -> String {
    format!("{:?}", expr.kind)
}

fn operand(source: &str) -> (Expr, OperandKind) {
    match context(source, source.len()).site {
        CompletionSite::Operand { left, kind } => (left, kind),
        other => panic!("expected an operand context for {source:?}, got {other:?}"),
    }
}

/// The left operand is read back over calls, indexes and parentheses as
/// units, and over the additive operators a comparison binds more loosely
/// than.
#[test]
fn the_left_operand_steps_over_groups_and_sums() {
    let (left, kind) = operand("named(\"x\").malloc.site == ");
    assert_eq!(kind, OperandKind::Binary(BinaryOp::Equal));
    assert!(matches!(&left.kind, ExprKind::Field { name, .. } if name == "site"));
    assert_eq!(left.span, Span::new(0, "named(\"x\").malloc.site".len()));

    let source = "named(\"x\").malloc.site == \"";
    let got = context(source, source.len());
    assert_eq!(got.replacement, Span::new(source.len() - 1, source.len()));
    assert!(matches!(
        got.site,
        CompletionSite::Operand { kind: OperandKind::Binary(BinaryOp::Equal), ref left }
            if matches!(&left.kind, ExprKind::Field { name, .. } if name == "site")
    ));

    let (left, kind) = operand("len(alloc.tags) > ");
    assert_eq!(kind, OperandKind::Binary(BinaryOp::Greater));
    assert!(matches!(&left.kind, ExprKind::Call { .. }), "{}", spelled(&left));

    let (left, _) = operand("(alloc.size) == ");
    assert!(matches!(&left.kind, ExprKind::Field { name, .. } if name == "size"));

    let (left, _) = operand("alloc.size + 1 == ");
    assert!(
        matches!(&left.kind, ExprKind::Binary { op: BinaryOp::Add, .. }),
        "{}",
        spelled(&left)
    );

    // a sum continues left-associatively, and a comparison still stops it
    let (left, kind) = operand("x == a + b - ");
    assert_eq!(kind, OperandKind::Binary(BinaryOp::Subtract));
    assert!(matches!(&left.kind, ExprKind::Binary { op: BinaryOp::Add, .. }));
    let (left, _) = operand("0 <= alloc.size < ");
    assert!(matches!(&left.kind, ExprKind::Field { name, .. } if name == "size"));
    let (left, _) = operand("not alloc.size == ");
    assert!(matches!(&left.kind, ExprKind::Field { name, .. } if name == "size"));
    let (left, _) = operand("f(a, alloc.size >= ");
    assert!(matches!(&left.kind, ExprKind::Field { name, .. } if name == "size"));

    // a set member is found by its open brace, whatever the members before it
    let (left, kind) = operand("malloc.thread in {-1, ");
    assert_eq!(kind, OperandKind::SetMember);
    assert!(matches!(&left.kind, ExprKind::Field { name, .. } if name == "thread"));

    // a unary minus has no left operand
    assert!(!matches!(
        context("x == -", 6).site,
        CompletionSite::Operand { .. }
    ));
}

fn call_argument(source: &str) -> (Expr, usize) {
    match context(source, source.len()).site {
        CompletionSite::CallArgument { callee, index } => (callee, index),
        other => panic!("expected a call argument context for {source:?}, got {other:?}"),
    }
}

#[test]
fn a_callee_is_read_back_over_groups_and_counts_only_its_own_commas() {
    let (callee, index) = call_argument("named(\"x\").malloc.site.startswith(");
    assert_eq!(index, 0);
    assert!(matches!(&callee.kind, ExprKind::Field { name, .. } if name == "startswith"));

    let (callee, index) = call_argument("f(g(a, b), ");
    assert_eq!(index, 1);
    assert!(matches!(&callee.kind, ExprKind::Identifier(name) if name == "f"));

    let (_, index) = call_argument("alloc.span.overlaps(range(0, 1), ");
    assert_eq!(index, 1);

    let (callee, index) = call_argument("abs(alloc.size - 1).x(");
    assert_eq!(index, 0);
    assert!(matches!(&callee.kind, ExprKind::Field { name, .. } if name == "x"));

    // a parenthesised group is not a call
    assert!(!matches!(
        context("x and (", 7).site,
        CompletionSite::CallArgument { .. }
    ));
}

#[test]
fn a_string_before_in_completes_against_the_collection_after_it() {
    let collection = |source: &str, cursor: usize| match context(source, cursor).site {
        CompletionSite::Element { collection } => collection,
        other => panic!("{source:?}: {other:?}"),
    };
    let got = collection(r#""pa" in malloc.calls"#, 3);
    assert!(matches!(&got.kind, ExprKind::Field { name, .. } if name == "calls"));
    let got = collection(r#"x and "" in named("r").free.spans and y"#, 7);
    assert!(matches!(&got.kind, ExprKind::Field { name, .. } if name == "spans"));
    let ctx = context(r#""pa" in malloc.calls"#, 3);
    assert_eq!(ctx.replacement, Span::new(0, 4));
    assert_eq!(ctx.prefix, "pa");
    // an operand on the left still wins, and no collection means no site
    assert!(matches!(
        context(r#"malloc.site == "" in x"#, 16).site,
        CompletionSite::Operand { .. }
    ));
    assert!(completion_context(r#""pa" == malloc.site"#, 2).is_none());
}
