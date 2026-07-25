use heap_visualizer_filter_dsl::{BinaryOp, Expr, ExprKind, Span, UnaryOp, Unit};

use crate::store::{Store, NONE_U16, NONE_U32};

#[derive(Clone, Debug)]
enum Value {
    Bool(bool),
    Int(i128),
    String(String),
    Range(i128, i128),
    Set(Vec<Value>),
    Missing,
}

#[derive(Debug)]
pub struct EvalError {
    pub message: String,
    pub span: Span,
}

impl EvalError {
    fn at(expr: &Expr, message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            span: expr.span,
        }
    }
}

fn integer(value: u128, unit: Option<Unit>, time_unit: &str) -> Result<i128, String> {
    let mul: u128 = match unit {
        None | Some(Unit::Bytes) => 1,
        Some(Unit::Kibibytes) => 1024,
        Some(Unit::Mebibytes) => 1024 * 1024,
        Some(Unit::Gibibytes) => 1024 * 1024 * 1024,
        Some(Unit::Nanoseconds) => time_factor(time_unit, 1)?,
        Some(Unit::Microseconds) => time_factor(time_unit, 1_000)?,
        Some(Unit::Milliseconds) => time_factor(time_unit, 1_000_000)?,
        Some(Unit::Seconds) => time_factor(time_unit, 1_000_000_000)?,
    };
    value
        .checked_mul(mul)
        .and_then(|v| i128::try_from(v).ok())
        .ok_or_else(|| "integer literal overflows".to_string())
}

fn time_factor(unit: &str, nanos: u128) -> Result<u128, String> {
    let per_tick = match unit {
        "ns" => 1,
        "us" => 1_000,
        "ms" => 1_000_000,
        "s" => 1_000_000_000,
        _ => return Err("time literals are unavailable for a tick trace".into()),
    };
    Ok(nanos / per_tick)
}

fn field(
    name: &str,
    s: &Store,
    e: u32,
    labels: &[String],
    expr: &Expr,
) -> Result<Value, EvalError> {
    let i = e as usize;
    Ok(match name {
        "id" => Value::Int(s.id[i] as i128),
        "address" => Value::Int(s.addr[i] as i128),
        "end" => Value::Int((s.addr[i] + s.span(e)) as i128),
        "span" => Value::Range(s.addr[i] as i128, (s.addr[i] + s.span(e)) as i128),
        "size" => Value::Int(s.size[i] as i128),
        "usable" => {
            let v = s.usable_at(e);
            if v == 0 {
                Value::Missing
            } else {
                Value::Int(v as i128)
            }
        }
        "seq" => Value::Int(e as i128),
        "time" => Value::Int(s.t[i] as i128),
        "site" => {
            let id = s.site[i];
            if id == NONE_U32 {
                Value::Missing
            } else {
                Value::String(s.sites[id as usize].clone())
            }
        }
        "thread" => {
            let id = s.thr_idx[i];
            if id == NONE_U16 {
                Value::Missing
            } else {
                Value::Int(s.thrs[id as usize] as i128)
            }
        }
        "stack" => {
            let id = s.stack_at(e);
            if id == NONE_U32 {
                Value::Missing
            } else {
                Value::String(s.stacks[id as usize].clone())
            }
        }
        "tag" => {
            let id = s.tag[i] as usize;
            if id == 0 || id > labels.len() {
                Value::Missing
            } else {
                Value::String(labels[id - 1].clone())
            }
        }
        "freed" => Value::Bool(s.death[i] != NONE_U32),
        "lifetime" => {
            let d = s.death[i];
            if d == NONE_U32 {
                Value::Missing
            } else {
                Value::Int((s.t[d as usize] - s.t[i]) as i128)
            }
        }
        _ => return Err(EvalError::at(expr, format!("unknown field `{name}`"))),
    })
}

fn equal(a: &Value, b: &Value) -> Result<bool, String> {
    match (a, b) {
        (Value::Missing, _) | (_, Value::Missing) => Ok(false),
        (Value::Bool(a), Value::Bool(b)) => Ok(a == b),
        (Value::Int(a), Value::Int(b)) => Ok(a == b),
        (Value::String(a), Value::String(b)) => Ok(a == b),
        _ => Err("equality operands have incompatible types".into()),
    }
}

fn order(a: &Value, b: &Value, op: BinaryOp) -> Result<bool, String> {
    let ord = match (a, b) {
        (Value::Missing, _) | (_, Value::Missing) => return Ok(false),
        (Value::Int(a), Value::Int(b)) => a.cmp(b),
        (Value::String(a), Value::String(b)) => a.cmp(b),
        _ => return Err("ordering operands have incompatible types".into()),
    };
    Ok(match op {
        BinaryOp::Less => ord.is_lt(),
        BinaryOp::LessEqual => ord.is_le(),
        BinaryOp::Greater => ord.is_gt(),
        BinaryOp::GreaterEqual => ord.is_ge(),
        _ => false,
    })
}

pub fn evaluate(expr: &Expr, s: &Store, e: u32, labels: &[String]) -> Result<bool, EvalError> {
    match eval(expr, s, e, labels)? {
        Value::Bool(v) => Ok(v),
        Value::Missing => Ok(false),
        _ => Err(EvalError::at(expr, "filter expression must produce bool")),
    }
}

fn eval(expr: &Expr, s: &Store, e: u32, labels: &[String]) -> Result<Value, EvalError> {
    let err = |m: String| EvalError::at(expr, m);
    Ok(match &expr.kind {
        ExprKind::Bool(v) => Value::Bool(*v),
        ExprKind::Integer(v) => Value::Int(integer(v.value, v.unit, &s.unit).map_err(err)?),
        ExprKind::String(v) => Value::String(v.clone()),
        ExprKind::Identifier(name) => field(name, s, e, labels, expr)?,
        ExprKind::Unary {
            op: UnaryOp::Not,
            expr: inner,
        } => match eval(inner, s, e, labels)? {
            Value::Bool(v) => Value::Bool(!v),
            Value::Missing => Value::Bool(false),
            _ => return Err(EvalError::at(expr, "`!` requires bool")),
        },
        ExprKind::IsMissing {
            expr: inner,
            negated,
        } => Value::Bool(matches!(eval(inner, s, e, labels)?, Value::Missing) ^ *negated),
        ExprKind::Set(items) => Value::Set(
            items
                .iter()
                .map(|x| eval(x, s, e, labels))
                .collect::<Result<_, _>>()?,
        ),
        ExprKind::Range { start, end } => {
            match (eval(start, s, e, labels)?, eval(end, s, e, labels)?) {
                (Value::Int(a), Value::Int(b)) => Value::Range(a, b),
                _ => return Err(EvalError::at(expr, "range bounds must be numeric")),
            }
        }
        ExprKind::Field { base, name } => {
            if let ExprKind::Identifier(root) = &base.kind {
                if root == "death" {
                    let d = s.death[e as usize];
                    if d == NONE_U32 {
                        Value::Missing
                    } else {
                        match name.as_str() {
                            "seq" => Value::Int(d as i128),
                            "time" => Value::Int(s.t[d as usize] as i128),
                            _ => {
                                return Err(EvalError::at(
                                    expr,
                                    format!("unknown death field `{name}`"),
                                ))
                            }
                        }
                    }
                } else {
                    return Err(EvalError::at(
                        expr,
                        format!("unknown field `{root}.{name}`"),
                    ));
                }
            } else {
                return Err(EvalError::at(expr, "field access is not valid here"));
            }
        }
        ExprKind::Call { callee, arguments } => {
            let args = arguments
                .iter()
                .map(|x| eval(x, s, e, labels))
                .collect::<Result<Vec<_>, _>>()?;
            match &callee.kind {
                ExprKind::Identifier(name) if name == "abs" && args.len() == 1 => match args[0] {
                    Value::Int(v) => Value::Int(v.abs()),
                    _ => return Err(EvalError::at(expr, "abs requires a number")),
                },
                ExprKind::Field { base, name } if args.len() == 1 => {
                    let hay = eval(base, s, e, labels)?;
                    match (&hay, &args[0]) {
                        (Value::Missing, _) | (_, Value::Missing) => Value::Bool(false),
                        (Value::String(a), Value::String(b)) => Value::Bool(match name.as_str() {
                            "contains" => a.contains(b),
                            "starts_with" => a.starts_with(b),
                            "ends_with" => a.ends_with(b),
                            _ => {
                                return Err(EvalError::at(
                                    expr,
                                    format!("unknown string method `{name}`"),
                                ))
                            }
                        }),
                        _ => {
                            return Err(EvalError::at(
                                expr,
                                format!("`{name}` requires string operands"),
                            ))
                        }
                    }
                }
                _ => return Err(EvalError::at(expr, "unknown function")),
            }
        }
        ExprKind::Index { .. } => {
            return Err(EvalError::at(expr, "custom fields are not available yet"))
        }
        ExprKind::Binary { op, left, right } => {
            if *op == BinaryOp::And || *op == BinaryOp::Or {
                let a = evaluate(left, s, e, labels)?;
                if (*op == BinaryOp::And && !a) || (*op == BinaryOp::Or && a) {
                    Value::Bool(a)
                } else {
                    Value::Bool(evaluate(right, s, e, labels)?)
                }
            } else {
                let a = eval(left, s, e, labels)?;
                let b = eval(right, s, e, labels)?;
                match op {
                    BinaryOp::Equal => Value::Bool(equal(&a, &b).map_err(err)?),
                    BinaryOp::NotEqual => Value::Bool(
                        if matches!(a, Value::Missing) || matches!(b, Value::Missing) {
                            false
                        } else {
                            !equal(&a, &b).map_err(err)?
                        },
                    ),
                    BinaryOp::Less
                    | BinaryOp::LessEqual
                    | BinaryOp::Greater
                    | BinaryOp::GreaterEqual => Value::Bool(order(&a, &b, *op).map_err(err)?),
                    BinaryOp::Add | BinaryOp::Subtract => match (a, b) {
                        (Value::Int(x), Value::Int(y)) => {
                            Value::Int(if *op == BinaryOp::Add { x + y } else { x - y })
                        }
                        _ => Value::Missing,
                    },
                    BinaryOp::In => Value::Bool(match b {
                        Value::Range(lo, hi) => matches!(a, Value::Int(v) if lo <= v && v < hi),
                        Value::Set(values) => values.iter().any(|v| equal(&a, v).unwrap_or(false)),
                        _ => return Err(EvalError::at(expr, "`in` requires a set or range")),
                    }),
                    BinaryOp::Overlaps => Value::Bool(match (a, b) {
                        (Value::Range(a0, a1), Value::Range(b0, b1)) => a0 < b1 && b0 < a1,
                        _ => return Err(EvalError::at(expr, "`overlaps` requires two ranges")),
                    }),
                    BinaryOp::And | BinaryOp::Or => unreachable!(),
                }
            }
        }
    })
}
