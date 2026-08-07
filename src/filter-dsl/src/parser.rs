use crate::lexer::{lex, Token, TokenKind};
use crate::{
    BinaryOp, Expr, ExprKind, ParseError, Span, UnaryOp, MAX_ARGUMENTS, MAX_NESTING,
    MAX_SET_MEMBERS, MAX_SOURCE_BYTES,
};

pub fn parse(source: &str) -> Result<Expr, ParseError> {
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
    let expr = parser.or_expr()?;
    if !parser.at(&TokenKind::Eof) {
        return Err(parser.error_here("expected end of expression"));
    }
    Ok(expr)
}

struct Parser {
    tokens: Vec<Token>,
    current: usize,
    nesting: usize,
}

impl Parser {
    fn or_expr(&mut self) -> Result<Expr, ParseError> {
        let mut expr = self.and_expr()?;
        while self.take(&TokenKind::Or).is_some() {
            let right = self.and_expr()?;
            expr = binary(BinaryOp::Or, expr, right);
        }
        Ok(expr)
    }

    fn and_expr(&mut self) -> Result<Expr, ParseError> {
        let mut expr = self.not_expr()?;
        while self.take(&TokenKind::And).is_some() {
            let right = self.not_expr()?;
            expr = binary(BinaryOp::And, expr, right);
        }
        Ok(expr)
    }

    /// `not` sits between `and` and the comparisons, exactly where Python puts
    /// it — so `not alloc.size == 64` negates the comparison rather than the
    /// field. The old `!` bound tighter than `==`, which is the one precedence
    /// this cutover changes rather than only respells.
    fn not_expr(&mut self) -> Result<Expr, ParseError> {
        // iteratively, so a long run of `not` costs no parser stack
        let mut operators = Vec::new();
        while let Some(not) = self.take(&TokenKind::Not) {
            operators.push(not.span);
        }
        let mut expr = self.comparison()?;
        for span in operators.into_iter().rev() {
            let joined = span.join(expr.span);
            expr = Expr::new(
                ExprKind::Unary {
                    op: UnaryOp::Not,
                    expr: Box::new(expr),
                },
                joined,
            );
        }
        Ok(expr)
    }

    /// Comparisons chain, the way they do in Python: `0 <= alloc.size < 4096`
    /// is the conjunction of its two links. Every operand is pure and
    /// side-effect free, so naming the middle one twice cannot change what the
    /// expression means.
    ///
    /// `in` and `is None` end a chain rather than continuing one. Python
    /// permits `a in b < c`; nobody writes it, and refusing it keeps the
    /// diagnostics specific.
    fn comparison(&mut self) -> Result<Expr, ParseError> {
        let first = self.additive()?;
        let mut left = first.clone();
        let mut links: Vec<Expr> = Vec::new();
        loop {
            if let Some(op) = self.comparison_op() {
                // equality is the only comparison a set literal can appear in:
                // `alloc.tags == {"a", "aa"}` compares whole sets
                let right = if matches!(op, BinaryOp::Equal | BinaryOp::NotEqual)
                    && self.at(&TokenKind::LeftBrace)
                {
                    self.set()?
                } else {
                    self.additive()?
                };
                links.push(binary(op, left, right.clone()));
                left = right;
                continue;
            }
            if self.take(&TokenKind::In).is_some() {
                let right = if self.at(&TokenKind::LeftBrace) {
                    self.set()?
                } else {
                    self.additive()?
                };
                links.push(binary(BinaryOp::In, left, right));
                break;
            }
            if self.take(&TokenKind::Is).is_some() {
                let negated = self.take(&TokenKind::Not).is_some();
                let end = self
                    .take(&TokenKind::None)
                    .ok_or_else(|| self.error_here("expected `None` after `is`"))?
                    .span;
                let span = left.span.join(end);
                links.push(Expr::new(
                    ExprKind::IsNone {
                        expr: Box::new(left),
                        negated,
                    },
                    span,
                ));
                break;
            }
            break;
        }
        let mut links = links.into_iter();
        let Some(mut expr) = links.next() else {
            return Ok(first);
        };
        for link in links {
            expr = binary(BinaryOp::And, expr, link);
        }
        Ok(expr)
    }

    fn comparison_op(&mut self) -> Option<BinaryOp> {
        for (token, op) in [
            (TokenKind::EqualEqual, BinaryOp::Equal),
            (TokenKind::BangEqual, BinaryOp::NotEqual),
            (TokenKind::LessEqual, BinaryOp::LessEqual),
            (TokenKind::Less, BinaryOp::Less),
            (TokenKind::GreaterEqual, BinaryOp::GreaterEqual),
            (TokenKind::Greater, BinaryOp::Greater),
        ] {
            if self.take(&token).is_some() {
                return Some(op);
            }
        }
        None
    }

    fn set(&mut self) -> Result<Expr, ParseError> {
        let open = self
            .take(&TokenKind::LeftBrace)
            .expect("set called without `{`");
        let mut members = Vec::new();
        if !self.at(&TokenKind::RightBrace) {
            loop {
                if members.len() == MAX_SET_MEMBERS {
                    return Err(
                        self.error_here(format!("set exceeds the {MAX_SET_MEMBERS}-member limit"))
                    );
                }
                members.push(self.constant()?);
                if self.take(&TokenKind::Comma).is_none() {
                    break;
                }
                if self.at(&TokenKind::RightBrace) {
                    break;
                }
            }
        }
        let close = self.expect(&TokenKind::RightBrace, "expected `}` after set")?;
        Ok(Expr::new(
            ExprKind::Set(members),
            open.span.join(close.span),
        ))
    }

    fn additive(&mut self) -> Result<Expr, ParseError> {
        let mut expr = self.postfix()?;
        loop {
            let op = if self.take(&TokenKind::Plus).is_some() {
                Some(BinaryOp::Add)
            } else if self.take(&TokenKind::Minus).is_some() {
                Some(BinaryOp::Subtract)
            } else {
                None
            };
            let Some(op) = op else { break };
            let right = self.postfix()?;
            expr = binary(op, expr, right);
        }
        Ok(expr)
    }

    fn postfix(&mut self) -> Result<Expr, ParseError> {
        let mut expr = self.primary()?;
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
                let span = expr.span.join(name_token.span);
                expr = Expr::new(
                    ExprKind::Field {
                        base: Box::new(expr),
                        name,
                    },
                    span,
                );
                if self.at(&TokenKind::LeftParen) {
                    expr = self.call(expr)?;
                }
            } else if let Some(open) = self.take(&TokenKind::LeftBracket) {
                let (key, key_span) = self.take_string()?;
                let close =
                    self.expect(&TokenKind::RightBracket, "expected `]` after field key")?;
                let span = expr.span.join(close.span);
                expr = Expr::new(
                    ExprKind::Index {
                        base: Box::new(expr),
                        key,
                    },
                    span,
                );
                debug_assert!(open.span.end <= key_span.start);
            } else {
                break;
            }
        }
        Ok(expr)
    }

    fn primary(&mut self) -> Result<Expr, ParseError> {
        let token = self.advance();
        let expr = match token.kind {
            TokenKind::Identifier(name) => {
                // `range` takes call syntax and its own node: it is a builtin
                // that makes a half-open range, not a function over values
                if name == "range" && self.at(&TokenKind::LeftParen) {
                    return self.range_call(token.span);
                }
                let expr = Expr::new(ExprKind::Identifier(name), token.span);
                if self.at(&TokenKind::LeftParen) {
                    return self.call(expr);
                }
                expr
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
                    Ok(mut inner) => {
                        let close =
                            self.expect(&TokenKind::RightParen, "expected `)` after expression")?;
                        inner.span = token.span.join(close.span);
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
        Ok(expr)
    }

    /// `range(lo, hi)` — half-open, and exactly two bounds.
    fn range_call(&mut self, name: Span) -> Result<Expr, ParseError> {
        let open = self
            .take(&TokenKind::LeftParen)
            .expect("range_call called without `(`");
        self.enter_nesting(open.span)?;
        let result = (|| {
            let start = self.or_expr()?;
            self.expect(&TokenKind::Comma, "range takes two bounds, as `range(lo, hi)`")?;
            let end = self.or_expr()?;
            let close = self.expect(&TokenKind::RightParen, "expected `)` after the range")?;
            Ok(Expr::new(
                ExprKind::Range {
                    start: Box::new(start),
                    end: Box::new(end),
                },
                name.join(close.span),
            ))
        })();
        self.nesting -= 1;
        result
    }

    fn call(&mut self, callee: Expr) -> Result<Expr, ParseError> {
        let open = self
            .take(&TokenKind::LeftParen)
            .expect("call called without `(`");
        self.enter_nesting(open.span)?;
        let mut arguments = Vec::new();
        let result = (|| {
            if !self.at(&TokenKind::RightParen) {
                loop {
                    if arguments.len() == MAX_ARGUMENTS {
                        return Err(self.error_here(format!(
                            "call exceeds the {MAX_ARGUMENTS}-argument limit"
                        )));
                    }
                    arguments.push(self.or_expr()?);
                    if self.take(&TokenKind::Comma).is_none() {
                        break;
                    }
                    if self.at(&TokenKind::RightParen) {
                        return Err(self.error_here("trailing commas are not allowed in calls"));
                    }
                }
            }
            let close = self.expect(&TokenKind::RightParen, "expected `)` after arguments")?;
            let span = callee.span.join(close.span);
            Ok(Expr::new(
                ExprKind::Call {
                    callee: Box::new(callee),
                    arguments,
                },
                span,
            ))
        })();
        self.nesting -= 1;
        result
    }

    fn constant(&mut self) -> Result<Expr, ParseError> {
        let token = self.advance();
        match token.kind {
            TokenKind::Integer(value) => Ok(Expr::new(ExprKind::Integer(value), token.span)),
            TokenKind::Float(value) => Ok(Expr::new(ExprKind::Float(value), token.span)),
            TokenKind::String(value) => Ok(Expr::new(ExprKind::String(value), token.span)),
            TokenKind::True => Ok(Expr::new(ExprKind::Bool(true), token.span)),
            TokenKind::False => Ok(Expr::new(ExprKind::Bool(false), token.span)),
            _ => Err(ParseError::new(
                "set members must be number, string, or boolean constants",
                token.span,
            )),
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
        self.take(kind).ok_or_else(|| self.error_here(message))
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

fn binary(op: BinaryOp, left: Expr, right: Expr) -> Expr {
    let span = left.span.join(right.span);
    Expr::new(
        ExprKind::Binary {
            op,
            left: Box::new(left),
            right: Box::new(right),
        },
        span,
    )
}
