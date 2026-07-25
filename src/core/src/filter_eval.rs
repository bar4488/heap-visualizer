use heap_visualizer_filter_dsl::{
    completion_context, BinaryOp, CompletionSite, Expr, ExprKind, OperandKind, Span, UnaryOp, Unit,
};

use crate::json::push_json_str;
use crate::store::{Store, NONE_U16, NONE_U32};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Type {
    Bool,
    Int,
    String,
    Range,
    Set(ValueKind),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ValueKind {
    Bool,
    Int,
    String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct CheckedType {
    ty: Type,
    optional: bool,
}

impl CheckedType {
    const fn required(ty: Type) -> Self {
        Self {
            ty,
            optional: false,
        }
    }

    const fn optional(ty: Type) -> Self {
        Self { ty, optional: true }
    }

    fn value_kind(self) -> Option<ValueKind> {
        match self.ty {
            Type::Bool => Some(ValueKind::Bool),
            Type::Int => Some(ValueKind::Int),
            Type::String => Some(ValueKind::String),
            _ => None,
        }
    }
}

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

fn field_type(name: &str, expr: &Expr) -> Result<CheckedType, EvalError> {
    Ok(match name {
        "id" | "address" | "end" | "size" | "seq" | "time" => CheckedType::required(Type::Int),
        "usable" | "thread" | "lifetime" => CheckedType::optional(Type::Int),
        "span" => CheckedType::required(Type::Range),
        "site" | "tag" => CheckedType::optional(Type::String),
        "stack" => CheckedType::required(Type::String),
        "freed" => CheckedType::required(Type::Bool),
        _ => return Err(EvalError::at(expr, format!("unknown field `{name}`"))),
    })
}

fn same_values(left: CheckedType, right: CheckedType) -> bool {
    left.value_kind().is_some() && left.value_kind() == right.value_kind()
}

fn check_type(expr: &Expr, store: &Store) -> Result<CheckedType, EvalError> {
    let required = |ty| Ok(CheckedType::required(ty));
    match &expr.kind {
        ExprKind::Bool(_) => required(Type::Bool),
        ExprKind::Integer(value) => {
            integer(value.value, value.unit, &store.unit)
                .map_err(|message| EvalError::at(expr, message))?;
            required(Type::Int)
        }
        ExprKind::String(_) => required(Type::String),
        ExprKind::Identifier(name) => field_type(name, expr),
        ExprKind::Unary {
            op: UnaryOp::Not,
            expr: inner,
        } => {
            let ty = check_type(inner, store)?;
            if ty.ty == Type::Bool {
                required(Type::Bool)
            } else {
                Err(EvalError::at(expr, "`!` requires bool"))
            }
        }
        ExprKind::IsMissing { expr: inner, .. } => {
            check_type(inner, store)?;
            required(Type::Bool)
        }
        ExprKind::Set(items) => {
            let Some(first) = items.first() else {
                return Err(EvalError::at(expr, "cannot infer the type of an empty set"));
            };
            let first = check_type(first, store)?;
            let Some(kind) = first.value_kind() else {
                return Err(EvalError::at(expr, "set members must be scalar values"));
            };
            for item in &items[1..] {
                if check_type(item, store)?.value_kind() != Some(kind) {
                    return Err(EvalError::at(expr, "set members must have one type"));
                }
            }
            required(Type::Set(kind))
        }
        ExprKind::Range { start, end } => {
            if check_type(start, store)?.ty == Type::Int && check_type(end, store)?.ty == Type::Int
            {
                required(Type::Range)
            } else {
                Err(EvalError::at(expr, "range bounds must be numeric"))
            }
        }
        ExprKind::Field { base, name } => {
            if matches!(&base.kind, ExprKind::Identifier(root) if root == "death") {
                match name.as_str() {
                    "seq" | "time" => Ok(CheckedType::optional(Type::Int)),
                    _ => Err(EvalError::at(expr, format!("unknown death field `{name}`"))),
                }
            } else {
                Err(EvalError::at(expr, "field access is not valid here"))
            }
        }
        ExprKind::Call { callee, arguments } => match &callee.kind {
            ExprKind::Identifier(name) if name == "abs" => {
                if arguments.len() == 1 && check_type(&arguments[0], store)?.ty == Type::Int {
                    required(Type::Int)
                } else {
                    Err(EvalError::at(expr, "abs requires one number"))
                }
            }
            ExprKind::Field { base, name } => {
                if arguments.len() != 1
                    || check_type(base, store)?.ty != Type::String
                    || check_type(&arguments[0], store)?.ty != Type::String
                {
                    return Err(EvalError::at(
                        expr,
                        format!("`{name}` requires one string argument"),
                    ));
                }
                match name.as_str() {
                    "contains" | "starts_with" | "ends_with" => required(Type::Bool),
                    _ => Err(EvalError::at(
                        expr,
                        format!("unknown string method `{name}`"),
                    )),
                }
            }
            _ => Err(EvalError::at(expr, "unknown function")),
        },
        ExprKind::Index { .. } => Err(EvalError::at(expr, "custom fields are not available yet")),
        ExprKind::Binary { op, left, right } => {
            let left_ty = check_type(left, store)?;
            let right_ty = if *op == BinaryOp::In
                && matches!(&right.kind, ExprKind::Set(items) if items.is_empty())
            {
                CheckedType::required(Type::Set(left_ty.value_kind().unwrap_or(ValueKind::Bool)))
            } else {
                check_type(right, store)?
            };
            match op {
                BinaryOp::And | BinaryOp::Or => {
                    if left_ty.ty == Type::Bool && right_ty.ty == Type::Bool {
                        required(Type::Bool)
                    } else {
                        Err(EvalError::at(expr, "boolean operators require bool"))
                    }
                }
                BinaryOp::Equal | BinaryOp::NotEqual => {
                    if same_values(left_ty, right_ty) {
                        required(Type::Bool)
                    } else {
                        Err(EvalError::at(
                            expr,
                            "equality operands have incompatible types",
                        ))
                    }
                }
                BinaryOp::Less
                | BinaryOp::LessEqual
                | BinaryOp::Greater
                | BinaryOp::GreaterEqual => {
                    if same_values(left_ty, right_ty)
                        && matches!(left_ty.ty, Type::Int | Type::String)
                    {
                        required(Type::Bool)
                    } else {
                        Err(EvalError::at(
                            expr,
                            "ordering operands have incompatible types",
                        ))
                    }
                }
                BinaryOp::Add | BinaryOp::Subtract => {
                    if left_ty.ty == Type::Int && right_ty.ty == Type::Int {
                        required(Type::Int)
                    } else {
                        Err(EvalError::at(expr, "arithmetic requires numbers"))
                    }
                }
                BinaryOp::In => {
                    let compatible = match right_ty.ty {
                        Type::Range => left_ty.ty == Type::Int,
                        Type::Set(kind) => left_ty.value_kind() == Some(kind),
                        _ => false,
                    };
                    if compatible {
                        required(Type::Bool)
                    } else {
                        Err(EvalError::at(
                            expr,
                            "`in` requires a compatible set or range",
                        ))
                    }
                }
                BinaryOp::Overlaps => {
                    if left_ty.ty == Type::Range && right_ty.ty == Type::Range {
                        required(Type::Bool)
                    } else {
                        Err(EvalError::at(expr, "`overlaps` requires two ranges"))
                    }
                }
            }
        }
    }
}

pub fn check(expr: &Expr, store: &Store) -> Result<(), EvalError> {
    let ty = check_type(expr, store)?;
    if ty.ty == Type::Bool {
        Ok(())
    } else {
        Err(EvalError::at(expr, "filter expression must produce bool"))
    }
}

struct CompletionItem {
    label: String,
    insert: String,
    kind: &'static str,
    detail: Option<&'static str>,
    rank: u8,
}

fn item(
    label: &str,
    insert: impl Into<String>,
    kind: &'static str,
    detail: Option<&'static str>,
    rank: u8,
) -> CompletionItem {
    CompletionItem {
        label: label.into(),
        insert: insert.into(),
        kind,
        detail,
        rank,
    }
}

fn string_item(label: &str, detail: &'static str, in_set: bool) -> CompletionItem {
    let mut insert = String::new();
    push_json_str(&mut insert, label);
    if !in_set {
        insert.push(' ');
    }
    CompletionItem {
        label: label.into(),
        insert,
        kind: "value",
        detail: Some(detail),
        rank: 0,
    }
}

fn expression_items(expected: Option<Type>) -> Vec<CompletionItem> {
    let descriptors = [
        ("abs", "function", "number -> number", Type::Int, "abs(", 2),
        ("address", "field", "address", Type::Int, "address ", 2),
        ("end", "field", "address", Type::Int, "end ", 2),
        ("false", "value", "bool", Type::Bool, "false ", 1),
        ("freed", "field", "bool", Type::Bool, "freed ", 2),
        ("id", "field", "integer", Type::Int, "id ", 2),
        (
            "lifetime",
            "field",
            "time, optional",
            Type::Int,
            "lifetime ",
            2,
        ),
        ("seq", "field", "integer", Type::Int, "seq ", 2),
        (
            "site",
            "field",
            "string, optional",
            Type::String,
            "site ",
            2,
        ),
        ("size", "field", "bytes", Type::Int, "size ", 2),
        ("span", "field", "address range", Type::Range, "span ", 2),
        ("stack", "field", "string", Type::String, "stack ", 2),
        ("tag", "field", "string, optional", Type::String, "tag ", 2),
        (
            "thread",
            "field",
            "integer, optional",
            Type::Int,
            "thread ",
            2,
        ),
        ("time", "field", "time", Type::Int, "time ", 2),
        ("true", "value", "bool", Type::Bool, "true ", 1),
        (
            "usable",
            "field",
            "bytes, optional",
            Type::Int,
            "usable ",
            2,
        ),
    ];
    let mut items: Vec<_> = descriptors
        .into_iter()
        .filter(|(_, _, _, ty, _, _)| expected.is_none_or(|expected| expected == *ty))
        .map(|(label, kind, detail, _, insert, rank)| item(label, insert, kind, Some(detail), rank))
        .collect();
    if expected.is_none() {
        items.push(item("death", "death.", "field", Some("event namespace"), 2));
    }
    items
}

fn operator_items(ty: CheckedType, leading_space: bool) -> Vec<CompletionItem> {
    let mut labels: Vec<(&str, Option<&str>)> = match ty.ty {
        Type::Bool => vec![("&&", None), ("||", None), ("==", None), ("!=", None)],
        Type::Int => vec![
            ("+", None),
            ("-", None),
            ("==", None),
            ("!=", None),
            ("<", None),
            ("<=", None),
            (">", None),
            (">=", None),
            ("in", Some("set or half-open range")),
        ],
        Type::String => vec![
            ("==", None),
            ("!=", None),
            ("<", None),
            ("<=", None),
            (">", None),
            (">=", None),
            ("in", Some("set")),
        ],
        Type::Range => vec![("overlaps", Some("half-open range"))],
        Type::Set(_) => Vec::new(),
    };
    if ty.optional {
        labels.push(("is", Some("missing test")));
    }
    labels
        .into_iter()
        .map(|(label, detail)| {
            let separator = if leading_space { " " } else { "" };
            item(label, format!("{separator}{label} "), "operator", detail, 0)
        })
        .collect()
}

fn member_items(receiver: &Expr, store: &Store) -> Vec<CompletionItem> {
    if matches!(&receiver.kind, ExprKind::Identifier(name) if name == "death") {
        return vec![
            item("seq", "seq ", "member", Some("integer, optional"), 0),
            item("time", "time ", "member", Some("time, optional"), 0),
        ];
    }
    if check_type(receiver, store).is_ok_and(|ty| ty.ty == Type::String) {
        return vec![
            item("contains", "contains(", "member", Some("string -> bool"), 0),
            item(
                "ends_with",
                "ends_with(",
                "member",
                Some("string -> bool"),
                0,
            ),
            item(
                "starts_with",
                "starts_with(",
                "member",
                Some("string -> bool"),
                0,
            ),
        ];
    }
    Vec::new()
}

fn observed_items(
    subject: &Expr,
    store: &Store,
    labels: &[String],
    in_set: bool,
) -> Vec<CompletionItem> {
    let ExprKind::Identifier(name) = &subject.kind else {
        return Vec::new();
    };
    match name.as_str() {
        "site" => store
            .sites
            .iter()
            .map(|value| string_item(value, "observed site", in_set))
            .collect(),
        "thread" => store
            .thrs
            .iter()
            .map(|value| {
                let label = value.to_string();
                let insert = if in_set {
                    label.clone()
                } else {
                    format!("{label} ")
                };
                item(&label, insert, "value", Some("observed thread"), 0)
            })
            .collect(),
        "tag" => labels
            .iter()
            .map(|value| string_item(value, "current tag", in_set))
            .collect(),
        _ => Vec::new(),
    }
}

fn operand_items(
    left: &Expr,
    kind: OperandKind,
    store: &Store,
    labels: &[String],
) -> Vec<CompletionItem> {
    let left_ty = check_type(left, store).ok();
    match kind {
        OperandKind::SetMember => {
            let mut items = observed_items(left, store, labels, true);
            if left_ty.is_some_and(|ty| ty.ty == Type::Bool) {
                items.push(item("false", "false", "value", Some("bool"), 1));
                items.push(item("true", "true", "value", Some("bool"), 1));
            }
            items
        }
        OperandKind::RangeEnd => expression_items(Some(Type::Int)),
        OperandKind::Binary(BinaryOp::In) => {
            let mut items = vec![item("{", "{", "operator", Some("constant set"), 0)];
            if left_ty.is_some_and(|ty| ty.ty == Type::Int) {
                items.extend(expression_items(Some(Type::Int)));
            }
            items
        }
        OperandKind::Binary(operator) => {
            let expected = match operator {
                BinaryOp::Equal
                | BinaryOp::NotEqual
                | BinaryOp::Less
                | BinaryOp::LessEqual
                | BinaryOp::Greater
                | BinaryOp::GreaterEqual => left_ty.map(|ty| ty.ty),
                BinaryOp::Add | BinaryOp::Subtract => Some(Type::Int),
                BinaryOp::Overlaps => Some(Type::Range),
                BinaryOp::And | BinaryOp::Or => Some(Type::Bool),
                BinaryOp::In => unreachable!(),
            };
            let mut items = observed_items(left, store, labels, false);
            items.extend(expression_items(expected));
            items
        }
    }
}

fn call_argument_items(callee: &Expr, store: &Store) -> Vec<CompletionItem> {
    match &callee.kind {
        ExprKind::Identifier(name) if name == "abs" => expression_items(Some(Type::Int)),
        ExprKind::Field { base, name }
            if matches!(name.as_str(), "contains" | "starts_with" | "ends_with")
                && check_type(base, store).is_ok_and(|ty| ty.ty == Type::String) =>
        {
            expression_items(Some(Type::String))
        }
        _ => Vec::new(),
    }
}

pub fn push_completions_json(
    out: &mut String,
    source: &str,
    cursor: usize,
    store: &Store,
    labels: &[String],
) {
    let Some(context) = completion_context(source, cursor) else {
        return;
    };
    let mut replacement = context.replacement;
    let mut prefix = context.prefix.clone();
    let mut items = match &context.site {
        CompletionSite::Expression => expression_items(None),
        CompletionSite::Exact { expression } => {
            if matches!(&expression.kind, ExprKind::Identifier(name) if name == "death") {
                replacement = Span::new(context.replacement.end, context.replacement.end);
                prefix.clear();
                vec![item(".", ".", "operator", Some("death members"), 0)]
            } else if let Ok(ty) = check_type(expression, store) {
                replacement = Span::new(context.replacement.end, context.replacement.end);
                prefix.clear();
                operator_items(ty, true)
            } else {
                expression_items(None)
            }
        }
        CompletionSite::Operator { expression } => check_type(expression, store)
            .map_or_else(|_| Vec::new(), |ty| operator_items(ty, false)),
        CompletionSite::Member { receiver } => member_items(receiver, store),
        CompletionSite::Operand { left, kind } => operand_items(left, *kind, store, labels),
        CompletionSite::CallArgument { callee, index } => {
            if *index == 0 {
                call_argument_items(callee, store)
            } else {
                Vec::new()
            }
        }
        CompletionSite::SetDelimiter => vec![
            item(",", ", ", "operator", Some("another set member"), 0),
            item("}", "}", "operator", Some("close set"), 0),
        ],
        CompletionSite::AfterIs { negated } => {
            if *negated {
                vec![item("missing", "missing ", "operator", None, 0)]
            } else {
                vec![
                    item("missing", "missing ", "operator", None, 0),
                    item("not", "not ", "operator", Some("follow with missing"), 0),
                ]
            }
        }
    };
    items.retain(|candidate| candidate.label.starts_with(&prefix));
    items.sort_by(|left, right| {
        left.rank
            .cmp(&right.rank)
            .then_with(|| left.label.cmp(&right.label))
    });
    let has_more = items.len() > 50;
    items.truncate(50);
    if items.is_empty() {
        return;
    }

    out.push_str(",\"completions\":{\"start\":");
    out.push_str(&replacement.start.to_string());
    out.push_str(",\"end\":");
    out.push_str(&replacement.end.to_string());
    out.push_str(",\"items\":[");
    for (index, candidate) in items.iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        out.push_str("{\"label\":");
        push_json_str(out, &candidate.label);
        out.push_str(",\"insertText\":");
        push_json_str(out, &candidate.insert);
        out.push_str(",\"kind\":");
        push_json_str(out, candidate.kind);
        if let Some(detail) = candidate.detail {
            out.push_str(",\"detail\":");
            push_json_str(out, detail);
        }
        out.push('}');
    }
    out.push(']');
    if has_more {
        out.push_str(",\"hasMore\":true");
    }
    out.push('}');
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
