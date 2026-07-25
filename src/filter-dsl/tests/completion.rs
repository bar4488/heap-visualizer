use heap_visualizer_filter_dsl::{completion_context, CompletionSite, ExprKind, Span};

fn context(source: &str, cursor: usize) -> heap_visualizer_filter_dsl::CompletionContext {
    completion_context(source, cursor).expect("completion context")
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
fn comparison_values_carry_the_subject() {
    for (source, cursor, expected) in [
        ("site == ", 8, "site"),
        ("size > 0 && tag in {", 20, "tag"),
        ("thread == 2", 10, "thread"),
    ] {
        let got = context(source, cursor);
        let CompletionSite::Value { subject } = got.site else {
            panic!("value context for {source:?}");
        };
        assert!(matches!(subject.kind, ExprKind::Identifier(ref name) if name == expected));
    }
}

#[test]
fn string_values_replace_the_literal_and_preserve_utf8_spans() {
    let source = "site == \"héllo\"";
    let cursor = source.find("llo").unwrap();
    let got = context(source, cursor);
    assert_eq!(got.replacement, Span::new(8, source.len()));
    assert_eq!(got.prefix, "hé");
    assert!(matches!(got.site, CompletionSite::Value { .. }));

    let got = context("tag in {\"sus", 12);
    assert_eq!(got.replacement, Span::new(8, 12));
    assert_eq!(got.prefix, "sus");
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
