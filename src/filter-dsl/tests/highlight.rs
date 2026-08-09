use heap_visualizer_filter_dsl::{highlight, Class};

/// Every byte of the source is covered, in order and without gaps. The editor
/// rebuilds the text it shows from these runs alone, so a dropped byte would
/// silently change what the reader sees behind the textarea.
fn covers(source: &str) -> Vec<(Class, &str)> {
    let runs = highlight(source);
    let mut at = 0;
    for run in &runs {
        assert_eq!(run.span.start, at, "gap or overlap in {source:?}");
        assert!(run.span.end > run.span.start, "empty run in {source:?}");
        at = run.span.end;
    }
    assert_eq!(at, source.len(), "runs stop short in {source:?}");
    runs.iter()
        .map(|run| (run.class, &source[run.span.start..run.span.end]))
        .collect()
}

#[test]
fn classifies_the_shape_of_an_expression() {
    assert_eq!(
        covers(r#"alloc.size >= 4KiB"#),
        vec![
            (Class::Field, "alloc"),
            (Class::Operator, "."),
            (Class::Field, "size"),
            (Class::Plain, " "),
            (Class::Operator, ">="),
            (Class::Plain, " "),
            (Class::Number, "4KiB"),
        ]
    );
}

/// A name is a call only when a `(` follows it, which is the whole difference
/// between reading `alloc.span` and calling `alloc.span.overlaps(...)`.
#[test]
fn a_name_is_a_call_only_when_it_is_called() {
    let runs = covers("alloc.span.overlaps(range(1, 2))");
    assert!(runs.contains(&(Class::Field, "span")));
    assert!(runs.contains(&(Class::Function, "overlaps")));
    assert!(runs.contains(&(Class::Function, "range")));
    assert!(runs.contains(&(Class::Bracket, "(")));

    // and the same name, not called, is an ordinary field
    let runs = covers("malloc.fields.range == 1");
    assert!(runs.contains(&(Class::Field, "range")));
    assert!(!runs.iter().any(|(class, _)| *class == Class::Function));
}

#[test]
fn keywords_and_literals_are_their_own_classes() {
    let runs = covers(r#"not alloc.freed and malloc.site is None or "x" in alloc.tags"#);
    for keyword in ["not", "and", "is", "None", "or", "in"] {
        assert!(runs.contains(&(Class::Keyword, keyword)), "{keyword}: {runs:?}");
    }
    assert!(runs.contains(&(Class::String, "\"x\"")));
}

/// Highlighting runs on half-written source, so nothing here may fail. The
/// removed spellings colour as mistakes, which is the answer the parser gives
/// and the reader gets it sooner.
#[test]
fn invalid_and_incomplete_source_still_classifies() {
    assert!(covers("alloc.size >= ").contains(&(Class::Operator, ">=")));
    assert!(covers("alloc.").contains(&(Class::Operator, ".")));
    assert!(covers("\"unterminated").contains(&(Class::Invalid, "\"")));

    for (source, removed) in [
        ("a && b", "&&"),
        ("a || b", "||"),
        ("!freed", "!"),
        ("x in 1..2", ".."),
    ] {
        assert!(
            covers(source).contains(&(Class::Invalid, removed)),
            "{source:?} should mark {removed:?}"
        );
    }

    // a byte that cannot begin a token costs one run and does not stop the scan
    let runs = covers("alloc.size # 4");
    assert!(runs.contains(&(Class::Invalid, "#")));
    assert!(runs.contains(&(Class::Number, "4")));
}

#[test]
fn multibyte_text_keeps_its_byte_spans() {
    let runs = covers(r#"malloc.site == "héllo 😀""#);
    assert!(runs.contains(&(Class::String, "\"héllo 😀\"")));
}
