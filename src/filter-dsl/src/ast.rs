/// A half-open UTF-8 byte range in the original source.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct Span {
    pub start: usize,
    pub end: usize,
}

impl Span {
    pub const fn new(start: usize, end: usize) -> Self {
        Self { start, end }
    }

    pub const fn join(self, other: Self) -> Self {
        Self::new(self.start, other.end)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Unit {
    Bytes,
    Kibibytes,
    Mebibytes,
    Gibibytes,
    Nanoseconds,
    Microseconds,
    Milliseconds,
    Seconds,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct IntegerLiteral {
    pub value: u128,
    pub hexadecimal: bool,
    pub unit: Option<Unit>,
}

/// A decimal literal carrying a fraction or an exponent — `0.5`, `1e-3`,
/// `1.5MiB`. The value is the parsed double; the unit multiplies it later,
/// where the trace's time unit is known.
///
/// This is the one literal that is not `Eq`, which is why the expression tree
/// is `PartialEq` only.
#[derive(Clone, Debug, PartialEq)]
pub struct FloatLiteral {
    pub value: f64,
    pub unit: Option<Unit>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum UnaryOp {
    Not,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BinaryOp {
    Or,
    And,
    Equal,
    NotEqual,
    Less,
    LessEqual,
    Greater,
    GreaterEqual,
    In,
    Add,
    Subtract,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Expr {
    pub kind: ExprKind,
    pub span: Span,
}

impl Expr {
    pub(crate) fn new(kind: ExprKind, span: Span) -> Self {
        Self { kind, span }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum ExprKind {
    Bool(bool),
    Integer(IntegerLiteral),
    Float(FloatLiteral),
    String(String),
    Identifier(String),
    Unary {
        op: UnaryOp,
        expr: Box<Expr>,
    },
    Binary {
        op: BinaryOp,
        left: Box<Expr>,
        right: Box<Expr>,
    },
    Field {
        base: Box<Expr>,
        name: String,
    },
    Index {
        base: Box<Expr>,
        key: String,
    },
    Call {
        callee: Box<Expr>,
        arguments: Vec<Expr>,
    },
    Set(Vec<Expr>),
    /// `range(lo, hi)`, half-open. Written as a call and parsed into its own
    /// node, the way Python's `range` is a builtin rather than a literal.
    Range {
        start: Box<Expr>,
        end: Box<Expr>,
    },
    /// `x is None` / `x is not None`.
    IsNone {
        expr: Box<Expr>,
        negated: bool,
    },
}
