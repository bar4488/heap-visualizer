//! Parser for the heap visualizer's allocation filter DSL.
//!
//! This crate deliberately has no dependencies and no knowledge of the heap
//! store. It turns source text into a source-spanned syntax tree; name
//! resolution, type checking, and execution belong to later layers.

mod ast;
mod completion;
mod error;
mod lexer;
mod parser;

pub use ast::{BinaryOp, Expr, ExprKind, FloatLiteral, IntegerLiteral, Span, UnaryOp, Unit};
pub use completion::{completion_context, CompletionContext, CompletionSite, OperandKind};
pub use error::ParseError;
pub use parser::parse;

/// Maximum accepted source length in UTF-8 bytes.
pub const MAX_SOURCE_BYTES: usize = 8 * 1024;
/// Maximum nested parenthesized expressions and calls.
pub const MAX_NESTING: usize = 32;
/// Maximum arguments in one function or method call.
pub const MAX_ARGUMENTS: usize = 16;
/// Maximum source members in one set.
pub const MAX_SET_MEMBERS: usize = 4_096;
