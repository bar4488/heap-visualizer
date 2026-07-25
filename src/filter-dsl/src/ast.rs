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
    Overlaps,
    Add,
    Subtract,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Expr {
    pub kind: ExprKind,
    pub span: Span,
}

impl Expr {
    pub(crate) fn new(kind: ExprKind, span: Span) -> Self {
        Self { kind, span }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ExprKind {
    Bool(bool),
    Integer(IntegerLiteral),
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
    Range {
        start: Box<Expr>,
        end: Box<Expr>,
    },
    IsMissing {
        expr: Box<Expr>,
        negated: bool,
    },
}
