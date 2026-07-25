---
id: T010
title: Establish the standalone filter DSL parser
status: done
updated: 2026-07-25
---

# T010: Establish the Standalone Filter DSL Parser

## Outcome

A dependency-free Rust crate parses the allocation filter grammar from
[E010](../explorations/E010-filter-expression-language.md) into a public,
source-spanned syntax tree without coupling the language to the WASM engine.

## Done when

- [x] `src/filter-dsl/` builds and tests independently of `src/core/`.
- [x] Every syntax example in E010 parses.
- [x] Precedence, postfix access/calls, sets, ranges, missing tests, canonical
  units, JSON string escapes, and byte spans are asserted.
- [x] Invalid tokens, malformed expressions, comparison chaining, and bounded
  source/nesting/argument limits produce source-spanned errors.
- [x] The existing core suite remains green.

## Non-goals

- Name resolution or type checking.
- Compiling or evaluating predicates.
- A dependency from `src/core/` to the new crate.
- Filter UI or persistence changes.

## Result

Added the zero-dependency `heap-visualizer-filter-dsl` crate with separate AST,
error, lexer, and parser modules. The parser consumes token values into the AST
without duplicating identifier and string allocations. It enforces the E010
8 KiB source, nesting, call-argument, and set-member bounds.

Verification:

```text
cargo fmt --manifest-path src/filter-dsl/Cargo.toml -- --check
cargo clippy --manifest-path src/filter-dsl/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src/filter-dsl/Cargo.toml
  15 passed
cargo check --manifest-path src/filter-dsl/Cargo.toml --target wasm32-unknown-unknown
cargo test --manifest-path src/core/Cargo.toml
  33 passed
node --test 'src/web/**/*.test.ts'
  5 test files passed
```
