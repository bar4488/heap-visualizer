//! Parser for the heap visualizer's allocation filter DSL.
//!
//! This crate deliberately has no dependencies and no knowledge of the heap
//! store. It turns source text into a source-spanned syntax tree; name
//! resolution, type checking, and execution belong to later layers.

mod ast;
mod completion;
mod error;
mod highlight;
mod lexer;
mod parser;
#[cfg(target_arch = "wasm32")]
mod wasm;

pub use ast::{BinaryOp, Expr, ExprKind, FloatLiteral, IntegerLiteral, Span, UnaryOp, Unit};
pub use completion::{completion_context, CompletionContext, CompletionSite, OperandKind};
pub use highlight::{highlight, Class, Highlight};
pub use error::ParseError;
pub use parser::parse;

/// Maximum accepted source length in UTF-8 bytes — the 16 KiB every filter
/// endpoint accepts (API-003).
pub const MAX_SOURCE_BYTES: usize = 16 * 1024;
/// Maximum nested parenthesized expressions and calls.
pub const MAX_NESTING: usize = 32;
/// Maximum depth of the syntax tree: the most nodes on any root-to-leaf path.
///
/// Every consumer walks the tree recursively — the core's type checker,
/// planner and evaluator, and the tree's own `Clone`, `Drop` and `PartialEq` —
/// so this, not the source length, is what bounds their stack. Measured on the
/// core's check-and-query path, a level costs under 1 KiB of stack in a release
/// build and about 8 KiB in an unoptimised one. 128 levels is then about
/// 100 KiB released, a twentieth of the 2 MiB a spawned or tokio thread gets,
/// and about 1 MiB in a debug test, still half of one. Nothing written by hand
/// comes near it: parentheses add no depth, and a long list of alternatives is
/// one `in {…}` rather than a chain of `or`.
pub const MAX_DEPTH: usize = 128;
/// Maximum arguments in one function or method call.
pub const MAX_ARGUMENTS: usize = 16;
/// Maximum source members in one set.
pub const MAX_SET_MEMBERS: usize = 4_096;
