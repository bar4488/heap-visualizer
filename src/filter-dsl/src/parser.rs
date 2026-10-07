use crate::lexer::{char_span, lex, Token, TokenKind};
use crate::{
    BinaryOp, Expr, ExprKind, ParseError, Span, UnaryOp, MAX_ARGUMENTS, MAX_DEPTH, MAX_NESTING,
    MAX_SET_MEMBERS, MAX_SOURCE_BYTES,
};

pub fn parse(source: &str) -> Result<Expr, ParseError> {
    // every span names whole characters, so a caller can always slice the
    // source with it — even where the lexer gave up mid-character
    parse_spanned(source).map_err(|error| ParseError {
        span: char_span(source, error.span),
        ..error
    })
}

fn parse_spanned(source: &str) -> Result<Expr, ParseError> {
    if source.len() > MAX_SOURCE_BYTES {
        return Err(ParseError::new(
            format!("filter source exceeds the {MAX_SOURCE_BYTES}-byte limit"),
            Span::new(MAX_SOURCE_BYTES, source.len()),
        ));
    }
    if source.trim().is_empty() {
        return Err(ParseError::new(
            "expected an expression",
            Span::new(0, source.len()),
        ));
    }

    let tokens = lex(source)?;
    // The removed spellings lex, so that each can name what replaced it
    // rather than arriving as "unexpected character" or "expected end of
    // expression". There is no compatibility mode: these are errors.
    for token in &tokens {
        let replacement = match token.kind {
            TokenKind::AndAnd => "`and`",
            TokenKind::OrOr => "`or`",
            TokenKind::Bang => "`not`",
            TokenKind::DotDot => "`range(lo, hi)`",
            _ => continue,
        };
        let spelling = &source[token.span.start..token.span.end];
        return Err(ParseError::new(
            format!("`{spelling}` is not part of this language; write {replacement}"),
            token.span,
        ));
    }
    let mut parser = Parser {
        tokens,
        current: 0,
        nesting: 0,
    };
    let node = parser.or_expr()?;
    if !parser.at(&TokenKind::Eof) {
        return Err(parser.unexpected("expected end of expression"));
    }
    Ok(node.expr)
}

/// A subtree and the number of nodes on its longest root-to-leaf path.
///
/// Every consumer of the tree — this parser's own `Clone` and `Drop`, and the
/// core's type checker, planner and evaluator — walks it recursively, so its
/// depth is what bounds their stack. Carrying the depth up as the tree is built
/// lets the parser refuse a tree that is too deep before anything recurses
/// over it, whatever shape made it deep: a run of `-` or `not`, a long `and`
/// or `+` chain, or a long field path.
struct Node {
    expr: Expr,
    depth: usize,
}

impl Node {
    fn leaf(expr: Expr) -> Self {
        Self { expr, depth: 1 }
    }
}

struct Parser {
    tokens: Vec<Token>,
    current: usize,
    nesting: usize,
}

impl Parser {
    fn or_expr(&mut self) -> Result<Node, ParseError> {
        let mut node = self.and_expr()?;
        while let Some(or) = self.take(&TokenKind::Or) {
            let right = self.and_expr()?;
            node = binary(BinaryOp::Or, or.span, node, right)?;
        }
        Ok(node)
    }

    fn and_expr(&mut self) -> Result<Node, ParseError> {
        let mut node = self.not_expr()?;
        while let Some(and) = self.take(&TokenKind::And) {
            let right = self.not_expr()?;
            node = binary(BinaryOp::And, and.span, node, right)?;
        }
        Ok(node)
    }

    /// `not` sits between `and` and the comparisons, exactly where Python puts
    /// it — so `not alloc.size == 64` negates the comparison rather than the
    /// field. The old `!` bound tighter than `==`, which is the one precedence
    /// this cutover changes rather than only respells.
    fn not_expr(&mut self) -> Result<Node, ParseError> {
        // iteratively, so a long run of `not` costs no parser stack
        let mut operators = Vec::new();
        while let Some(not) = self.take(&TokenKind::Not) {
            operators.push(not.span);
        }
        let mut node = self.comparison()?;
        for span in operators.into_iter().rev() {
            node = unary(UnaryOp::Not, span, node)?;
        }
        Ok(node)
    }

    /// Comparisons chain, the way they do in Python: `0 <= alloc.size < 4096`
    /// is the conjunction of its two links. Every operand is pure and
    /// side-effect free, so naming the middle one twice cannot change what the
    /// expression means.
    ///
    /// `in` and `is None` end a chain rather than continuing one. Python
    /// permits `a in b < c`; nobody writes it, and refusing it keeps the
    /// diagnostics specific.
    fn comparison(&mut self) -> Result<Node, ParseError> {
        let mut left = self.additive()?;
        let mut links: Vec<Node> = Vec::new();
        loop {
            if let Some((op, at)) = self.comparison_op() {
                // equality is the only comparison a set literal can appear in:
                // `alloc.tags == {"a", "aa"}` compares whole sets
                let right = if matches!(op, BinaryOp::Equal | BinaryOp::NotEqual)
                    && self.at(&TokenKind::LeftBrace)
                {
                    self.set()?
                } else {
                    self.additive()?
                };
                let shared = Node {
                    expr: right.expr.clone(),
                    depth: right.depth,
                };
                links.push(binary(op, at, left, shared)?);
                left = right;
                continue;
            }
            if let Some(token) = self.take(&TokenKind::In) {
                let right = if self.at(&TokenKind::LeftBrace) {
                    self.set()?
                } else {
                    self.additive()?
                };
                links.push(binary(BinaryOp::In, token.span, left, right)?);
                return conjoin(links);
            }
            if let Some(is) = self.take(&TokenKind::Is) {
                let negated = self.take(&TokenKind::Not).is_some();
                if let TokenKind::Identifier(name) = &self.peek().kind {
                    if name == "missing" {
                        return Err(ParseError::new(
                            "`is missing` is not part of this language; write `is None`",
                            is.span.join(self.peek().span),
                        ));
                    }
                }
                let end = self
                    .take(&TokenKind::None)
                    .ok_or_else(|| self.error_here("expected `None` after `is`"))?
                    .span;
                let span = left.expr.span.join(end);
                let depth = left.depth + 1;
                links.push(deepen(
                    Expr::new(
                        ExprKind::IsNone {
                            expr: Box::new(left.expr),
                            negated,
                        },
                        span,
                    ),
                    depth,
                    is.span,
                )?);
                return conjoin(links);
            }
            break;
        }
        if links.is_empty() {
            return Ok(left);
        }
        conjoin(links)
    }

    fn comparison_op(&mut self) -> Option<(BinaryOp, Span)> {
        for (token, op) in [
            (TokenKind::EqualEqual, BinaryOp::Equal),
            (TokenKind::BangEqual, BinaryOp::NotEqual),
            (TokenKind::LessEqual, BinaryOp::LessEqual),
            (TokenKind::Less, BinaryOp::Less),
            (TokenKind::GreaterEqual, BinaryOp::GreaterEqual),
            (TokenKind::Greater, BinaryOp::Greater),
        ] {
            if let Some(token) = self.take(&token) {
                return Some((op, token.span));
            }
        }
        None
    }

    fn set(&mut self) -> Result<Node, ParseError> {
        let open = self
            .take(&TokenKind::LeftBrace)
            .expect("set called without `{`");
        let mut members = Vec::new();
        let mut depth = 0;
        if !self.at(&TokenKind::RightBrace) {
            loop {
                if members.len() == MAX_SET_MEMBERS {
                    return Err(
                        self.error_here(format!("set exceeds the {MAX_SET_MEMBERS}-member limit"))
                    );
                }
                let member = self.constant()?;
                depth = depth.max(member.depth);
                members.push(member.expr);
                if self.take(&TokenKind::Comma).is_none() {
                    break;
                }
                if self.at(&TokenKind::RightBrace) {
                    break;
                }
            }
        }
        let close = self.expect(&TokenKind::RightBrace, "expected `}` after set")?;
        deepen(
            Expr::new(ExprKind::Set(members), open.span.join(close.span)),
            depth + 1,
            open.span,
        )
    }

    fn additive(&mut self) -> Result<Node, ParseError> {
        let mut node = self.unary_numeric()?;
        loop {
            let (op, token) = if let Some(token) = self.take(&TokenKind::Plus) {
                (BinaryOp::Add, token)
            } else if let Some(token) = self.take(&TokenKind::Minus) {
                (BinaryOp::Subtract, token)
            } else {
                break;
            };
            let right = self.unary_numeric()?;
            node = binary(op, token.span, node, right)?;
        }
        Ok(node)
    }

    /// Numeric unary minus binds more tightly than addition and less tightly
    /// than field access/calls, as in Python. Parse a run iteratively so a
    /// machine-generated chain cannot consume the Rust stack.
    fn unary_numeric(&mut self) -> Result<Node, ParseError> {
        if self.at(&TokenKind::Plus) {
            let plus = self.advance();
            return Err(ParseError::new(
                "unary plus is not part of this language",
                plus.span,
            ));
        }
        let mut operators = Vec::new();
        while let Some(minus) = self.take(&TokenKind::Minus) {
            operators.push(minus.span);
        }
        let mut node = self.postfix()?;
        for span in operators.into_iter().rev() {
            node = unary(UnaryOp::Negate, span, node)?;
        }
        Ok(node)
    }

    fn postfix(&mut self) -> Result<Node, ParseError> {
        let mut node = self.primary()?;
        loop {
            if self.take(&TokenKind::Dot).is_some() {
                let name_token = self.advance();
                let name = match name_token.kind {
                    TokenKind::Identifier(name) => name,
                    _ => {
                        return Err(ParseError::new(
                            "expected a field or method name after `.`",
                            name_token.span,
                        ))
                    }
                };
                let span = node.expr.span.join(name_token.span);
                node = deepen(
                    Expr::new(
                        ExprKind::Field {
                            base: Box::new(node.expr),
                            name,
                        },
                        span,
                    ),
                    node.depth + 1,
                    name_token.span,
                )?;
                if self.at(&TokenKind::LeftParen) {
                    node = self.call(node)?;
                }
            } else if let Some(open) = self.take(&TokenKind::LeftBracket) {
                let (key, key_span) = self.take_string()?;
                let close =
                    self.expect(&TokenKind::RightBracket, "expected `]` after field key")?;
                let span = node.expr.span.join(close.span);
                node = deepen(
                    Expr::new(
                        ExprKind::Index {
                            base: Box::new(node.expr),
                            key,
                        },
                        span,
                    ),
                    node.depth + 1,
                    open.span.join(close.span),
                )?;
                debug_assert!(open.span.end <= key_span.start);
            } else {
                break;
            }
        }
        Ok(node)
    }

    fn primary(&mut self) -> Result<Node, ParseError> {
        let token = self.advance();
        let expr = match token.kind {
            TokenKind::Identifier(name) => {
                // `range` takes call syntax and its own node: it is a builtin
                // that makes a half-open range, not a function over values
                if name == "range" && self.at(&TokenKind::LeftParen) {
                    return self.range_call(token.span);
                }
                let node = Node::leaf(Expr::new(ExprKind::Identifier(name), token.span));
                if self.at(&TokenKind::LeftParen) {
                    return self.call(node);
                }
                return Ok(node);
            }
            TokenKind::Integer(value) => Expr::new(ExprKind::Integer(value), token.span),
            TokenKind::Float(value) => Expr::new(ExprKind::Float(value), token.span),
            TokenKind::String(value) => Expr::new(ExprKind::String(value), token.span),
            TokenKind::True => Expr::new(ExprKind::Bool(true), token.span),
            TokenKind::False => Expr::new(ExprKind::Bool(false), token.span),
            TokenKind::LeftParen => {
                self.enter_nesting(token.span)?;
                let inner = self.or_expr();
                let result = match inner {
                    // parentheses add no node, so they add no depth
                    Ok(mut inner) => {
                        let close =
                            self.expect(&TokenKind::RightParen, "expected `)` after expression")?;
                        inner.expr.span = token.span.join(close.span);
                        Ok(inner)
                    }
                    Err(error) => Err(error),
                };
                self.nesting -= 1;
                return result;
            }
            _ => {
                return Err(ParseError::new("expected an expression", token.span));
            }
        };
        Ok(Node::leaf(expr))
    }

    /// `range(lo, hi)` — half-open, and exactly two bounds.
    fn range_call(&mut self, name: Span) -> Result<Node, ParseError> {
        let open = self
            .take(&TokenKind::LeftParen)
            .expect("range_call called without `(`");
        self.enter_nesting(open.span)?;
        let result = (|| {
            let start = self.or_expr()?;
            self.expect(&TokenKind::Comma, "range takes two bounds, as `range(lo, hi)`")?;
            let end = self.or_expr()?;
            let close = self.expect(&TokenKind::RightParen, "expected `)` after the range")?;
            let depth = start.depth.max(end.depth) + 1;
            deepen(
                Expr::new(
                    ExprKind::Range {
                        start: Box::new(start.expr),
                        end: Box::new(end.expr),
                    },
                    name.join(close.span),
                ),
                depth,
                name,
            )
        })();
        self.nesting -= 1;
        result
    }

    fn call(&mut self, callee: Node) -> Result<Node, ParseError> {
        let open = self
            .take(&TokenKind::LeftParen)
            .expect("call called without `(`");
        self.enter_nesting(open.span)?;
        let mut arguments = Vec::new();
        let mut depth = callee.depth;
        let result = (|| {
            if !self.at(&TokenKind::RightParen) {
                loop {
                    if arguments.len() == MAX_ARGUMENTS {
                        return Err(self.error_here(format!(
                            "call exceeds the {MAX_ARGUMENTS}-argument limit"
                        )));
                    }
                    let argument = self.or_expr()?;
                    depth = depth.max(argument.depth);
                    arguments.push(argument.expr);
                    if self.take(&TokenKind::Comma).is_none() {
                        break;
                    }
                    if self.at(&TokenKind::RightParen) {
                        return Err(self.error_here("trailing commas are not allowed in calls"));
                    }
                }
            }
            let close = self.expect(&TokenKind::RightParen, "expected `)` after arguments")?;
            let span = callee.expr.span.join(close.span);
            deepen(
                Expr::new(
                    ExprKind::Call {
                        callee: Box::new(callee.expr),
                        arguments,
                    },
                    span,
                ),
                depth + 1,
                open.span.join(close.span),
            )
        })();
        self.nesting -= 1;
        result
    }

    fn constant(&mut self) -> Result<Node, ParseError> {
        let minus = self.take(&TokenKind::Minus);
        if self.at(&TokenKind::Plus) {
            let plus = self.advance();
            return Err(ParseError::new(
                "unary plus is not part of this language",
                plus.span,
            ));
        }
        let token = self.advance();
        let value = match token.kind {
            TokenKind::Integer(value) => Expr::new(ExprKind::Integer(value), token.span),
            TokenKind::Float(value) => Expr::new(ExprKind::Float(value), token.span),
            TokenKind::String(value) => Expr::new(ExprKind::String(value), token.span),
            TokenKind::True => Expr::new(ExprKind::Bool(true), token.span),
            TokenKind::False => Expr::new(ExprKind::Bool(false), token.span),
            _ => return Err(ParseError::new(
                "set members must be number, string, or boolean constants",
                token.span,
            )),
        };
        if let Some(minus) = minus {
            if !matches!(value.kind, ExprKind::Integer(_) | ExprKind::Float(_)) {
                return Err(ParseError::new(
                    "unary minus requires a number",
                    minus.span.join(value.span),
                ));
            }
            unary(UnaryOp::Negate, minus.span, Node::leaf(value))
        } else {
            Ok(Node::leaf(value))
        }
    }

    fn take_string(&mut self) -> Result<(String, Span), ParseError> {
        let token = self.advance();
        match token.kind {
            TokenKind::String(value) => Ok((value, token.span)),
            _ => Err(ParseError::new("expected a string field key", token.span)),
        }
    }

    fn enter_nesting(&mut self, span: Span) -> Result<(), ParseError> {
        if self.nesting == MAX_NESTING {
            return Err(ParseError::new(
                format!("expression exceeds the nesting limit of {MAX_NESTING}"),
                span,
            ));
        }
        self.nesting += 1;
        Ok(())
    }

    fn expect(&mut self, kind: &TokenKind, message: &str) -> Result<Token, ParseError> {
        self.take(kind).ok_or_else(|| self.unexpected(message))
    }

    /// The error for a token that cannot continue the expression here — or,
    /// when that token is one of the removed infix operators, the error naming
    /// what replaced it. `contains` and `overlaps` lex as ordinary names (both
    /// are valid fields, and `overlaps` a method), so they surface here, where
    /// an operator was the only thing that could have followed.
    fn unexpected(&self, message: &str) -> ParseError {
        let token = self.peek();
        let replacement = match &token.kind {
            TokenKind::Identifier(name) if name == "contains" => "`needle in haystack`",
            TokenKind::Identifier(name) if name == "overlaps" => "`a.overlaps(b)`",
            _ => return self.error_here(message),
        };
        let TokenKind::Identifier(name) = &token.kind else {
            unreachable!("matched an identifier above");
        };
        ParseError::new(
            format!("`{name}` is not an operator in this language; write {replacement}"),
            token.span,
        )
    }

    fn take(&mut self, kind: &TokenKind) -> Option<Token> {
        if self.at(kind) {
            Some(self.advance())
        } else {
            None
        }
    }

    fn at(&self, kind: &TokenKind) -> bool {
        std::mem::discriminant(&self.peek().kind) == std::mem::discriminant(kind)
    }

    fn advance(&mut self) -> Token {
        let span = self.peek().span;
        let token = std::mem::replace(
            &mut self.tokens[self.current],
            Token {
                kind: TokenKind::Eof,
                span,
            },
        );
        if !matches!(token.kind, TokenKind::Eof) {
            self.current += 1;
        }
        token
    }

    fn peek(&self) -> &Token {
        &self.tokens[self.current]
    }

    fn error_here(&self, message: impl Into<String>) -> ParseError {
        ParseError::new(message, self.peek().span)
    }
}

/// `expr`, at `depth`, unless that is deeper than any consumer may recurse.
/// `at` is the operator or postfix that made it too deep, which is what the
/// diagnostic points at.
fn deepen(expr: Expr, depth: usize, at: Span) -> Result<Node, ParseError> {
    if depth > MAX_DEPTH {
        return Err(too_deep(at));
    }
    Ok(Node { expr, depth })
}

#[cold]
fn too_deep(at: Span) -> ParseError {
    ParseError::new(
        format!("expression exceeds the depth limit of {MAX_DEPTH} nested operations"),
        at,
    )
}

/// The links of a comparison chain, joined by `and` from the left.
fn conjoin(links: Vec<Node>) -> Result<Node, ParseError> {
    let mut links = links.into_iter();
    let mut node = links.next().expect("a chain has at least one link");
    for link in links {
        let at = link.expr.span;
        node = binary(BinaryOp::And, at, node, link)?;
    }
    Ok(node)
}

fn binary(op: BinaryOp, at: Span, left: Node, right: Node) -> Result<Node, ParseError> {
    let span = left.expr.span.join(right.expr.span);
    let depth = left.depth.max(right.depth) + 1;
    deepen(
        Expr::new(
            ExprKind::Binary {
                op,
                left: Box::new(left.expr),
                right: Box::new(right.expr),
            },
            span,
        ),
        depth,
        at,
    )
}

fn unary(op: UnaryOp, at: Span, operand: Node) -> Result<Node, ParseError> {
    let span = at.join(operand.expr.span);
    let depth = operand.depth + 1;
    deepen(
        Expr::new(
            ExprKind::Unary {
                op,
                expr: Box::new(operand.expr),
            },
            span,
        ),
        depth,
        at,
    )
}
