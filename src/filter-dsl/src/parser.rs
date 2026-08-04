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
        while self.take(&TokenKind::OrOr).is_some() {
            let right = self.and_expr()?;
            expr = binary(BinaryOp::Or, expr, right);
        }
        Ok(expr)
    }

    fn and_expr(&mut self) -> Result<Expr, ParseError> {
        let mut expr = self.comparison()?;
        while self.take(&TokenKind::AndAnd).is_some() {
            let right = self.comparison()?;
            expr = binary(BinaryOp::And, expr, right);
        }
        Ok(expr)
    }

    fn comparison(&mut self) -> Result<Expr, ParseError> {
        let left = self.additive()?;
        let op = if self.take(&TokenKind::EqualEqual).is_some() {
            Some(BinaryOp::Equal)
        } else if self.take(&TokenKind::BangEqual).is_some() {
            Some(BinaryOp::NotEqual)
        } else if self.take(&TokenKind::LessEqual).is_some() {
            Some(BinaryOp::LessEqual)
        } else if self.take(&TokenKind::Less).is_some() {
            Some(BinaryOp::Less)
        } else if self.take(&TokenKind::GreaterEqual).is_some() {
            Some(BinaryOp::GreaterEqual)
        } else if self.take(&TokenKind::Greater).is_some() {
            Some(BinaryOp::Greater)
        } else {
            None
        };
        if let Some(op) = op {
            // equality is the only comparison a set literal can appear in:
            // `tags == {"a", "aa"}` compares whole sets
            let right = if matches!(op, BinaryOp::Equal | BinaryOp::NotEqual)
                && self.at(&TokenKind::LeftBrace)
            {
                self.set()?
            } else {
                self.additive()?
            };
            return Ok(binary(op, left, right));
        }
        if self.take(&TokenKind::In).is_some() {
            let right = if self.at(&TokenKind::LeftBrace) {
                self.set()?
            } else {
                self.range()?
            };
            return Ok(binary(BinaryOp::In, left, right));
        }
        if self.take(&TokenKind::Overlaps).is_some() {
            let right = self.range()?;
            return Ok(binary(BinaryOp::Overlaps, left, right));
        }
        if self.take(&TokenKind::Contains).is_some() {
            let right = self.additive()?;
            return Ok(binary(BinaryOp::Contains, left, right));
        }
        if self.take(&TokenKind::Is).is_some() {
            let negated = self.take(&TokenKind::Not).is_some();
            let end = self
                .take(&TokenKind::Missing)
                .ok_or_else(|| self.error_here("expected `missing` after `is`"))?
                .span;
            let span = left.span.join(end);
            return Ok(Expr::new(
                ExprKind::IsMissing {
                    expr: Box::new(left),
                    negated,
                },
                span,
            ));
        }
        Ok(left)
    }

    fn range(&mut self) -> Result<Expr, ParseError> {
        let start = self.additive()?;
        self.expect(&TokenKind::DotDot, "expected `..` in range")?;
        let end = self.additive()?;
        let span = start.span.join(end.span);
        Ok(Expr::new(
            ExprKind::Range {
                start: Box::new(start),
                end: Box::new(end),
            },
            span,
        ))
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
        let mut expr = self.unary_expr()?;
        loop {
            let op = if self.take(&TokenKind::Plus).is_some() {
                Some(BinaryOp::Add)
            } else if self.take(&TokenKind::Minus).is_some() {
                Some(BinaryOp::Subtract)
            } else {
                None
            };
            let Some(op) = op else { break };
            let right = self.unary_expr()?;
            expr = binary(op, expr, right);
        }
        Ok(expr)
    }

    fn unary_expr(&mut self) -> Result<Expr, ParseError> {
        let mut operators = Vec::new();
        while let Some(not) = self.take(&TokenKind::Bang) {
            operators.push(not.span);
        }
        let mut expr = self.postfix()?;
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

    fn postfix(&mut self) -> Result<Expr, ParseError> {
        let mut expr = self.primary()?;
        loop {
            if self.take(&TokenKind::Dot).is_some() {
                let name_token = self.advance();
                // `contains` is also a binary operator keyword; after `.` it is
                // the string method, so accept it as an ordinary name here
                let name = match name_token.kind {
                    TokenKind::Identifier(name) => name,
                    TokenKind::Contains => "contains".to_owned(),
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
