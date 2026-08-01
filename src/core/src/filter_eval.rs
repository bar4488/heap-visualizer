use heap_visualizer_filter_dsl::{
    completion_context, BinaryOp, CompletionSite, Expr, ExprKind, OperandKind, Span, UnaryOp, Unit,
};

use crate::json::push_json_str;
use crate::store::{Store, FIELD_BOOL, FIELD_INT, FIELD_OTHER, FIELD_SCALARS, FIELD_STRING, NONE_U16, NONE_U32};

/// Everything checking and evaluation need besides the expression and the
/// event: the trace, the analysis objects the web layer owns, and the custom
/// field values resolved for this expression.
pub struct Ctx<'a> {
    pub store: &'a Store,
    /// Tag names by id order, pushed in by the web layer.
    pub labels: &'a [String],
    /// Creator event -> user-given name, pushed in by the web layer.
    pub names: &'a [(u32, String)],
    pub fields: &'a FieldValues,
}

impl<'a> Ctx<'a> {
    /// A context for checking or completing, before any field is resolved.
    /// Evaluation needs `with_fields`; checking never reads a value.
    pub fn new(store: &'a Store, labels: &'a [String], names: &'a [(u32, String)]) -> Self {
        Self {
            store,
            labels,
            names,
            fields: FieldValues::none(),
        }
    }

    /// The creator event carrying `name`, or the count when that is not
    /// exactly one — `named()` is a reference to a single allocation.
    fn named(&self, name: &str) -> Result<u32, usize> {
        let mut found = None;
        let mut count = 0;
        for (event, label) in self.names {
            if label == name {
                count += 1;
                found.get_or_insert(*event);
            }
        }
        match (count, found) {
            (1, Some(event)) => Ok(event),
            _ => Err(count),
        }
    }

    pub fn with_fields(self, fields: &'a FieldValues) -> Self {
        Self { fields, ..self }
    }
}

/// Custom field values, resolved once per interned extras fragment rather
/// than once per event.
///
/// The fragments are deduplicated at parse time, so a trace of a million
/// events carrying three distinct combinations of custom keys resolves three
/// times. Without this the per-event filter scan would re-parse a JSON
/// fragment for every event it looks at.
#[derive(Default)]
pub struct FieldValues {
    /// Referenced key names, in first-seen order.
    keys: Vec<String>,
    /// `values[fragment][key]`, parallel to `store.extras` and `keys`.
    values: Vec<Vec<Value>>,
}

impl FieldValues {
    pub fn none() -> &'static Self {
        static NONE: FieldValues = FieldValues {
            keys: Vec::new(),
            values: Vec::new(),
        };
        &NONE
    }

    /// Resolve every custom key `expr` references, for every distinct
    /// fragment in the trace. Call once per filter, not once per event.
    pub fn resolve(expr: &Expr, store: &Store) -> Self {
        let mut keys = Vec::new();
        collect_keys(expr, &mut keys);
        if keys.is_empty() {
            return Self::default();
        }
        let values = store
            .extras
            .iter()
            .map(|fragment| resolve_fragment(fragment, &keys))
            .collect();
        Self { keys, values }
    }

    /// Distinct fragments resolved, for the test that guards the "once per
    /// fragment, not once per event" property this type exists for.
    pub fn rows(&self) -> usize {
        self.values.len()
    }

    /// The value of `key` in the fragment interned at `fragment`, which is
    /// `NONE_U32` for an event carrying no custom fields at all.
    fn get(&self, key: &str, fragment: u32) -> Value {
        if fragment == NONE_U32 {
            return Value::Missing;
        }
        let Some(index) = self.keys.iter().position(|k| k == key) else {
            return Value::Missing;
        };
        self.values
            .get(fragment as usize)
            .and_then(|row| row.get(index))
            .cloned()
            .unwrap_or(Value::Missing)
    }
}

/// Which event's fragment a custom field reads: the allocation's own, or the
/// one on the event that freed it.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum FieldRoot {
    Alloc,
    Death,
}

/// Recognize `field.k`, `field["k"]`, `death.field.k` and `death.field["k"]`.
/// Everything else — including `death.seq` and a string method call — is not a
/// custom field reference and is handled by the caller.
fn custom_field(expr: &Expr) -> Option<(FieldRoot, &str)> {
    let (base, key) = match &expr.kind {
        ExprKind::Field { base, name } => (base, name.as_str()),
        ExprKind::Index { base, key } => (base, key.as_str()),
        _ => return None,
    };
    match &base.kind {
        ExprKind::Identifier(root) if root == "field" => Some((FieldRoot::Alloc, key)),
        ExprKind::Field { base: inner, name } if name == "field" => {
            matches!(&inner.kind, ExprKind::Identifier(root) if root == "death")
                .then_some((FieldRoot::Death, key))
        }
        _ => None,
    }
}

/// True for a `named(...)` call, whatever its argument turns out to be.
fn is_named_call(expr: &Expr) -> bool {
    matches!(&expr.kind, ExprKind::Call { callee, .. }
        if matches!(&callee.kind, ExprKind::Identifier(name) if name == "named"))
}

/// True for `field` / `death.field` with no key on it yet — a reference the
/// user has started and not finished.
fn is_field_root(expr: &Expr) -> bool {
    match &expr.kind {
        ExprKind::Identifier(name) => name == "field",
        ExprKind::Field { base, name } => {
            name == "field" && matches!(&base.kind, ExprKind::Identifier(r) if r == "death")
        }
        _ => false,
    }
}

fn collect_keys(expr: &Expr, out: &mut Vec<String>) {
    if let Some((_, key)) = custom_field(expr) {
        if !out.iter().any(|k| k == key) {
            out.push(key.to_string());
        }
    }
    let mut visit = |child: &Expr| collect_keys(child, out);
    match &expr.kind {
        ExprKind::Unary { expr, .. } | ExprKind::IsMissing { expr, .. } => visit(expr),
        ExprKind::Binary { left, right, .. } | ExprKind::Range { start: left, end: right } => {
            visit(left);
            visit(right);
        }
        ExprKind::Field { base, .. } | ExprKind::Index { base, .. } => visit(base),
        ExprKind::Call { callee, arguments } => {
            visit(callee);
            arguments.iter().for_each(visit);
        }
        ExprKind::Set(items) => items.iter().for_each(visit),
        _ => {}
    }
}

/// Read the wanted keys out of one raw object-body fragment in a single scan,
/// so a fragment is parsed once however many keys the expression names.
fn resolve_fragment(fragment: &str, keys: &[String]) -> Vec<Value> {
    let bytes = fragment.as_bytes();
    let mut out = vec![Value::Missing; keys.len()];
    let mut sc = crate::json::Scan::new(bytes);
    loop {
        let Some((lo, hi)) = sc.string_span() else {
            break;
        };
        if !sc.eat(b':') {
            break;
        }
        let name = crate::json::unescape(&bytes[lo..hi]);
        sc.ws();
        let shape = sc.peek();
        let Some((vlo, vhi)) = sc.skip_value() else {
            break;
        };
        // a repeated key keeps its first value, matching the catalog's count
        if let Some(index) = keys.iter().position(|k| *k == name) {
            if matches!(out[index], Value::Missing) {
                out[index] = match shape {
                    b'"' => Value::String(crate::json::unescape(&bytes[vlo + 1..vhi - 1])),
                    b't' => Value::Bool(true),
                    b'f' => Value::Bool(false),
                    // null, objects and arrays are all missing to the
                    // evaluator; the checker has already rejected the last two
                    b'n' | b'{' | b'[' => Value::Missing,
                    _ => core::str::from_utf8(&bytes[vlo..vhi])
                        .ok()
                        .and_then(|t| t.parse::<i128>().ok())
                        .map_or(Value::Missing, Value::Int),
                };
            }
        }
        if !sc.eat(b',') {
            break;
        }
    }
    out
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Type {
    Bool,
    Int,
    String,
    Range,
    Set(ValueKind),
    /// One allocation, reached through `named("x")`. Not a value: it has no
    /// equality or ordering, and only a field read gets anything out of it.
    Allocation,
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

    fn member_kind(self) -> Option<ValueKind> {
        match self.ty {
            Type::Set(kind) => Some(kind),
            _ => None,
        }
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

const fn scalar_type(kind: ValueKind) -> Type {
    match kind {
        ValueKind::Bool => Type::Bool,
        ValueKind::Int => Type::Int,
        ValueKind::String => Type::String,
    }
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
        "site" => CheckedType::optional(Type::String),
        // memberships are a set, empty rather than missing when untagged
        "tags" => CheckedType::required(Type::Set(ValueKind::String)),
        "stack" => CheckedType::required(Type::String),
        "freed" => CheckedType::required(Type::Bool),
        // a started custom field reference, not a field of its own
        "field" => {
            return Err(EvalError::at(
                expr,
                "`field` needs a key, as `field.pool` or `field[\"pool\"]`",
            ))
        }
        _ => return Err(EvalError::at(expr, format!("unknown field `{name}`"))),
    })
}

/// Type a custom field against the catalog the load pass built. A key is
/// always optional: it may be absent from an event's fragment, or present as
/// JSON `null`, and both are missing.
fn custom_field_type(key: &str, expr: &Expr, ctx: &Ctx) -> Result<CheckedType, EvalError> {
    let Some(info) = ctx.store.fields.iter().find(|f| f.name == key) else {
        return Err(EvalError::at(
            expr,
            format!("no trace field `{key}` in this trace"),
        ));
    };
    match info.scalar() {
        Some(FIELD_BOOL) => Ok(CheckedType::optional(Type::Bool)),
        Some(FIELD_INT) => Ok(CheckedType::optional(Type::Int)),
        Some(FIELD_STRING) => Ok(CheckedType::optional(Type::String)),
        _ if info.types & FIELD_SCALARS == 0 => Err(EvalError::at(
            expr,
            format!("`{key}` holds an object or an array, which cannot be filtered"),
        )),
        _ => Err(EvalError::at(
            expr,
            format!(
                "`{key}` holds {} in this trace, so it has no single type to filter on",
                shape_list(info.types)
            ),
        )),
    }
}

/// The string constant `named(...)` takes. E010 resolves the reference while
/// compiling, so the argument cannot be an expression.
fn named_argument<'a>(arguments: &'a [Expr], expr: &Expr) -> Result<&'a str, EvalError> {
    match arguments {
        [Expr {
            kind: ExprKind::String(name),
            ..
        }] => Ok(name),
        _ => Err(EvalError::at(
            expr,
            "named requires one string constant, as `named(\"request root\")`",
        )),
    }
}

/// Resolve `named("x")` against the names the web layer pushed in. Zero and
/// several are both errors: the reference names one allocation, and a filter
/// that silently picked one of two would be wrong in a way nothing reports.
fn named_event(arguments: &[Expr], expr: &Expr, ctx: &Ctx) -> Result<u32, EvalError> {
    let name = named_argument(arguments, expr)?;
    ctx.named(name).map_err(|count| {
        EvalError::at(
            expr,
            match count {
                0 => format!("no allocation is named `{name}`"),
                _ => format!("{count} allocations are named `{name}`; the name must be unique"),
            },
        )
    })
}

fn shape_list(types: u8) -> String {
    let mut names = Vec::new();
    for (bit, name) in [
        (FIELD_BOOL, "bool"),
        (FIELD_INT, "integer"),
        (FIELD_STRING, "string"),
        (FIELD_OTHER, "object or array"),
    ] {
        if types & bit != 0 {
            names.push(name);
        }
    }
    match names.split_last() {
        Some((last, [])) => (*last).to_string(),
        Some((last, rest)) => format!("{} and {last}", rest.join(", ")),
        None => "nothing".to_string(),
    }
}

fn same_values(left: CheckedType, right: CheckedType) -> bool {
    left.value_kind().is_some() && left.value_kind() == right.value_kind()
}

fn check_type(expr: &Expr, ctx: &Ctx) -> Result<CheckedType, EvalError> {
    let required = |ty| Ok(CheckedType::required(ty));
    match &expr.kind {
        ExprKind::Bool(_) => required(Type::Bool),
        ExprKind::Integer(value) => {
            integer(value.value, value.unit, &ctx.store.unit)
                .map_err(|message| EvalError::at(expr, message))?;
            required(Type::Int)
        }
        ExprKind::String(_) => required(Type::String),
        ExprKind::Identifier(name) => field_type(name, expr),
        ExprKind::Unary {
            op: UnaryOp::Not,
            expr: inner,
        } => {
            let ty = check_type(inner, ctx)?;
            if ty.ty == Type::Bool {
                required(Type::Bool)
            } else {
                Err(EvalError::at(expr, "`!` requires bool"))
            }
        }
        ExprKind::IsMissing { expr: inner, .. } => {
            // only an optional value can be missing; on anything else the test
            // is a constant, which is a mistake worth reporting rather than
            // silently answering false — `tags` is a set, empty when untagged
            if check_type(inner, ctx)?.optional {
                required(Type::Bool)
            } else {
                Err(EvalError::at(expr, "`is missing` requires an optional field"))
            }
        }
        ExprKind::Set(items) => {
            let Some(first) = items.first() else {
                return Err(EvalError::at(expr, "cannot infer the type of an empty set"));
            };
            let first = check_type(first, ctx)?;
            let Some(kind) = first.value_kind() else {
                return Err(EvalError::at(expr, "set members must be scalar values"));
            };
            for item in &items[1..] {
                if check_type(item, ctx)?.value_kind() != Some(kind) {
                    return Err(EvalError::at(expr, "set members must have one type"));
                }
            }
            required(Type::Set(kind))
        }
        ExprKind::Range { start, end } => {
            if check_type(start, ctx)?.ty == Type::Int && check_type(end, ctx)?.ty == Type::Int
            {
                required(Type::Range)
            } else {
                Err(EvalError::at(expr, "range bounds must be numeric"))
            }
        }
        ExprKind::Field { base, name } => {
            if let Some((_, key)) = custom_field(expr) {
                custom_field_type(key, expr, ctx)
            } else if is_named_call(base) {
                // `?` rather than `is_ok_and`: an unresolvable name must
                // surface its own diagnostic, not "field access is not valid"
                check_type(base, ctx)?;
                // the fields of a named allocation are the ordinary fields
                field_type(name, expr)
            } else if matches!(&base.kind, ExprKind::Identifier(root) if root == "death") {
                match name.as_str() {
                    "seq" | "time" => Ok(CheckedType::optional(Type::Int)),
                    // `death.field` alone is a started reference, not a typo
                    "field" => Err(EvalError::at(
                        expr,
                        "`death.field` needs a key, as `death.field.reason`",
                    )),
                    _ => Err(EvalError::at(expr, format!("unknown death field `{name}`"))),
                }
            } else {
                Err(EvalError::at(expr, "field access is not valid here"))
            }
        }
        ExprKind::Call { callee, arguments } => match &callee.kind {
            ExprKind::Identifier(name) if name == "abs" => {
                if arguments.len() == 1 && check_type(&arguments[0], ctx)?.ty == Type::Int {
                    required(Type::Int)
                } else {
                    Err(EvalError::at(expr, "abs requires one number"))
                }
            }
            ExprKind::Field { base, name } => {
                if arguments.len() != 1
                    || check_type(base, ctx)?.ty != Type::String
                    || check_type(&arguments[0], ctx)?.ty != Type::String
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
            ExprKind::Identifier(name) if name == "named" => {
                // resolved while checking, so a name that is gone or ambiguous
                // is a diagnostic rather than a filter that quietly matches
                named_event(arguments, expr, ctx)?;
                required(Type::Allocation)
            }
            _ => Err(EvalError::at(expr, "unknown function")),
        },
        ExprKind::Index { .. } => match custom_field(expr) {
            Some((_, key)) => custom_field_type(key, expr, ctx),
            None => Err(EvalError::at(
                expr,
                "only `field[...]` and `death.field[...]` take a key",
            )),
        },
        ExprKind::Binary { op, left, right } => {
            let left_ty = check_type(left, ctx)?;
            // an empty set literal has no type of its own; against `in` or an
            // equality it takes its member type from the left operand
            let right_ty = if matches!(&right.kind, ExprKind::Set(items) if items.is_empty())
                && matches!(op, BinaryOp::In | BinaryOp::Equal | BinaryOp::NotEqual)
            {
                let kind = left_ty
                    .member_kind()
                    .or_else(|| left_ty.value_kind())
                    .unwrap_or(ValueKind::Bool);
                CheckedType::required(Type::Set(kind))
            } else {
                check_type(right, ctx)?
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
                    let same_sets = left_ty.member_kind().is_some()
                        && left_ty.member_kind() == right_ty.member_kind();
                    if same_values(left_ty, right_ty) || same_sets {
                        required(Type::Bool)
                    } else if left_ty.member_kind().is_some()
                        && left_ty.member_kind() == right_ty.value_kind()
                    {
                        Err(EvalError::at(
                            expr,
                            "a set compares to a set; use `contains` to test one member",
                        ))
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
                BinaryOp::Contains => match left_ty.member_kind() {
                    Some(kind) if right_ty.value_kind() == Some(kind) => required(Type::Bool),
                    Some(_) => Err(EvalError::at(
                        expr,
                        "`contains` requires a member of the set's type",
                    )),
                    None => Err(EvalError::at(expr, "`contains` requires a set on the left")),
                },
            }
        }
    }
}

pub fn check(expr: &Expr, ctx: &Ctx) -> Result<(), EvalError> {
    let ty = check_type(expr, ctx)?;
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

fn expression_items(expected: Option<Type>, ctx: &Ctx) -> Vec<CompletionItem> {
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
        (
            "tags",
            "field",
            "string set",
            Type::Set(ValueKind::String),
            "tags ",
            2,
        ),
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
    // `named(...)` reads a field, so it fits wherever that field's type does
    if !ctx.names.is_empty() {
        items.push(item(
            "named",
            "named(\"",
            "function",
            Some("one named allocation"),
            2,
        ));
    }
    // `field.` is offered only when this trace actually carries a filterable
    // custom field of the wanted type — ANL-003 forbids advertising a surface
    // the evaluator will reject
    if ctx
        .store
        .fields
        .iter()
        .any(|f| catalog_type(f).is_some_and(|ty| expected.is_none_or(|want| want == ty)))
    {
        items.push(item(
            "field",
            "field.",
            "field",
            Some("trace fields"),
            2,
        ));
    }
    items
}

/// The filter type of a catalogued field, or None when it cannot be filtered.
fn catalog_type(info: &crate::store::FieldInfo) -> Option<Type> {
    match info.scalar()? {
        FIELD_BOOL => Some(Type::Bool),
        FIELD_INT => Some(Type::Int),
        FIELD_STRING => Some(Type::String),
        _ => None,
    }
}

fn identifier_shaped(key: &str) -> bool {
    let mut chars = key.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Catalogued keys offered after `field.` / `death.field.`. Only
/// identifier-shaped keys can be completed here — a key needing brackets is
/// reachable from the Filter panel's catalog listing instead.
fn field_key_items(ctx: &Ctx) -> Vec<CompletionItem> {
    ctx.store
        .fields
        .iter()
        .filter(|f| identifier_shaped(&f.name) && catalog_type(f).is_some())
        .map(|f| {
            let detail = match f.scalar() {
                Some(FIELD_BOOL) => "bool, optional",
                Some(FIELD_INT) => "integer, optional",
                _ => "string, optional",
            };
            item(&f.name, format!("{} ", f.name), "member", Some(detail), 0)
        })
        .collect()
}

/// Distinct values a custom key was seen holding, for operand completion —
/// the same affordance `site` and `thread` already have. Scans the interned
/// fragments, of which there are far fewer than events.
fn observed_field_values(key: &str, ctx: &Ctx, in_set: bool) -> Vec<CompletionItem> {
    let keys = [key.to_string()];
    let mut items = Vec::new();
    let mut seen: Vec<Value> = Vec::new();
    for fragment in &ctx.store.extras {
        let value = resolve_fragment(fragment, &keys).remove(0);
        if matches!(value, Value::Missing) || seen.iter().any(|v| equal(v, &value).unwrap_or(false))
        {
            continue;
        }
        match &value {
            Value::String(text) => items.push(string_item(text, "observed value", in_set)),
            Value::Int(number) => {
                let label = number.to_string();
                let insert = if in_set {
                    label.clone()
                } else {
                    format!("{label} ")
                };
                items.push(item(&label, insert, "value", Some("observed value"), 0));
            }
            // bool has two values and they are already offered as literals
            _ => {}
        }
        seen.push(value);
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
        Type::Set(_) => vec![
            ("==", Some("the whole set")),
            ("!=", Some("the whole set")),
            ("contains", Some("one member")),
        ],
        // a reference is not a value: the only thing to do with it is read a
        // field, and that is a member completion rather than an operator
        Type::Allocation => Vec::new(),
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

fn member_items(receiver: &Expr, ctx: &Ctx) -> Vec<CompletionItem> {
    if matches!(&receiver.kind, ExprKind::Identifier(name) if name == "death") {
        let mut items = vec![
            item("seq", "seq ", "member", Some("integer, optional"), 0),
            item("time", "time ", "member", Some("time, optional"), 0),
        ];
        if !field_key_items(ctx).is_empty() {
            items.push(item(
                "field",
                "field.",
                "member",
                Some("fields on the freeing event"),
                1,
            ));
        }
        return items;
    }
    // `field.` and `death.field.`
    if is_field_root(receiver) {
        return field_key_items(ctx);
    }
    if check_type(receiver, ctx).is_ok_and(|ty| ty.ty == Type::Allocation) {
        return expression_items(None, ctx)
            .into_iter()
            .filter(|c| c.kind == "field" && !matches!(c.label.as_str(), "death" | "field"))
            .map(|c| item(&c.label, c.insert.trim_end(), "member", c.detail, 0))
            .collect();
    }
    if check_type(receiver, ctx).is_ok_and(|ty| ty.ty == Type::String) {
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

fn observed_items(subject: &Expr, ctx: &Ctx, in_set: bool) -> Vec<CompletionItem> {
    if let Some((_, key)) = custom_field(subject) {
        return observed_field_values(key, ctx, in_set);
    }
    let ExprKind::Identifier(name) = &subject.kind else {
        return Vec::new();
    };
    match name.as_str() {
        "site" => ctx
            .store
            .sites
            .iter()
            .map(|value| string_item(value, "observed site", in_set))
            .collect(),
        "thread" => ctx
            .store
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
        "tags" => ctx
            .labels
            .iter()
            .map(|value| string_item(value, "current tag", in_set))
            .collect(),
        _ => Vec::new(),
    }
}

fn operand_items(left: &Expr, kind: OperandKind, ctx: &Ctx) -> Vec<CompletionItem> {
    let left_ty = check_type(left, ctx).ok();
    match kind {
        OperandKind::SetMember => {
            let mut items = observed_items(left, ctx, true);
            if left_ty.is_some_and(|ty| ty.ty == Type::Bool) {
                items.push(item("false", "false", "value", Some("bool"), 1));
                items.push(item("true", "true", "value", Some("bool"), 1));
            }
            items
        }
        OperandKind::RangeEnd => expression_items(Some(Type::Int), ctx),
        // a set-typed left operand compares only to a set literal
        OperandKind::Binary(BinaryOp::Equal | BinaryOp::NotEqual)
            if left_ty.is_some_and(|ty| ty.member_kind().is_some()) =>
        {
            vec![item("{", "{", "operator", Some("constant set"), 0)]
        }
        OperandKind::Binary(BinaryOp::In) => {
            let mut items = vec![item("{", "{", "operator", Some("constant set"), 0)];
            if left_ty.is_some_and(|ty| ty.ty == Type::Int) {
                items.extend(expression_items(Some(Type::Int), ctx));
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
                BinaryOp::Contains => left_ty.and_then(CheckedType::member_kind).map(scalar_type),
                BinaryOp::And | BinaryOp::Or => Some(Type::Bool),
                BinaryOp::In => unreachable!(),
            };
            let mut items = observed_items(left, ctx, false);
            items.extend(expression_items(expected, ctx));
            items
        }
    }
}

fn call_argument_items(callee: &Expr, ctx: &Ctx) -> Vec<CompletionItem> {
    match &callee.kind {
        ExprKind::Identifier(name) if name == "named" => {
            let mut names: Vec<&String> = ctx.names.iter().map(|(_, name)| name).collect();
            names.sort_unstable();
            names.dedup();
            names
                .into_iter()
                .map(|name| string_item(name, "named allocation", false))
                .collect()
        }
        ExprKind::Identifier(name) if name == "abs" => expression_items(Some(Type::Int), ctx),
        ExprKind::Field { base, name }
            if matches!(name.as_str(), "contains" | "starts_with" | "ends_with")
                && check_type(base, ctx).is_ok_and(|ty| ty.ty == Type::String) =>
        {
            expression_items(Some(Type::String), ctx)
        }
        _ => Vec::new(),
    }
}

pub fn push_completions_json(out: &mut String, source: &str, cursor: usize, ctx: &Ctx) {
    let Some(context) = completion_context(source, cursor) else {
        return;
    };
    let mut replacement = context.replacement;
    let mut prefix = context.prefix.clone();
    let mut items = match &context.site {
        CompletionSite::Expression => expression_items(None, ctx),
        CompletionSite::Exact { expression } => {
            if matches!(&expression.kind, ExprKind::Identifier(name) if name == "death")
                || is_field_root(expression)
            {
                replacement = Span::new(context.replacement.end, context.replacement.end);
                prefix.clear();
                let detail = if is_field_root(expression) {
                    "trace field keys"
                } else {
                    "death members"
                };
                vec![item(".", ".", "operator", Some(detail), 0)]
            } else if let Ok(ty) = check_type(expression, ctx) {
                replacement = Span::new(context.replacement.end, context.replacement.end);
                prefix.clear();
                operator_items(ty, true)
            } else {
                expression_items(None, ctx)
            }
        }
        CompletionSite::Operator { expression } => check_type(expression, ctx)
            .map_or_else(|_| Vec::new(), |ty| operator_items(ty, false)),
        CompletionSite::Member { receiver } => member_items(receiver, ctx),
        CompletionSite::Operand { left, kind } => operand_items(left, *kind, ctx),
        CompletionSite::CallArgument { callee, index } => {
            if *index == 0 {
                call_argument_items(callee, ctx)
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

/// The extras fragment a custom field reads for creator event `e`: its own,
/// or the one on the event that freed it. `NONE_U32` when there is no such
/// event, or it carried no custom fields — both are missing.
fn custom_fragment(root: FieldRoot, s: &Store, e: u32) -> u32 {
    match root {
        FieldRoot::Alloc => s.extra_at(e),
        FieldRoot::Death => match s.death[e as usize] {
            NONE_U32 => NONE_U32,
            death => s.extra_at(death),
        },
    }
}

fn field(name: &str, ctx: &Ctx, e: u32, expr: &Expr) -> Result<Value, EvalError> {
    let s = ctx.store;
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
        // every membership, in tag-id order; empty for an untagged allocation
        "tags" => Value::Set(
            s.tag_ids(e)
                .filter_map(|id| ctx.labels.get(id as usize - 1).cloned())
                .map(Value::String)
                .collect(),
        ),
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
        // set equality is exact and order-insensitive: same members, both ways
        (Value::Set(a), Value::Set(b)) => Ok(contains_all(a, b) && contains_all(b, a)),
        _ => Err("equality operands have incompatible types".into()),
    }
}

fn contains_all(haystack: &[Value], needles: &[Value]) -> bool {
    needles.iter().all(|needle| member(haystack, needle))
}

fn member(haystack: &[Value], needle: &Value) -> bool {
    haystack
        .iter()
        .any(|value| equal(value, needle).unwrap_or(false))
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

pub fn evaluate(expr: &Expr, ctx: &Ctx, e: u32) -> Result<bool, EvalError> {
    match eval(expr, ctx, e)? {
        Value::Bool(v) => Ok(v),
        Value::Missing => Ok(false),
        _ => Err(EvalError::at(expr, "filter expression must produce bool")),
    }
}

fn eval(expr: &Expr, ctx: &Ctx, e: u32) -> Result<Value, EvalError> {
    let err = |m: String| EvalError::at(expr, m);
    Ok(match &expr.kind {
        ExprKind::Bool(v) => Value::Bool(*v),
        ExprKind::Integer(v) => Value::Int(integer(v.value, v.unit, &ctx.store.unit).map_err(err)?),
        ExprKind::String(v) => Value::String(v.clone()),
        ExprKind::Identifier(name) => field(name, ctx, e, expr)?,
        ExprKind::Unary {
            op: UnaryOp::Not,
            expr: inner,
        } => match eval(inner, ctx, e)? {
            Value::Bool(v) => Value::Bool(!v),
            Value::Missing => Value::Bool(false),
            _ => return Err(EvalError::at(expr, "`!` requires bool")),
        },
        ExprKind::IsMissing {
            expr: inner,
            negated,
        } => Value::Bool(matches!(eval(inner, ctx, e)?, Value::Missing) ^ *negated),
        ExprKind::Set(items) => Value::Set(
            items
                .iter()
                .map(|x| eval(x, ctx, e))
                .collect::<Result<_, _>>()?,
        ),
        ExprKind::Range { start, end } => {
            match (eval(start, ctx, e)?, eval(end, ctx, e)?) {
                (Value::Int(a), Value::Int(b)) => Value::Range(a, b),
                _ => return Err(EvalError::at(expr, "range bounds must be numeric")),
            }
        }
        ExprKind::Field { base, name } => {
            if let Some((root, key)) = custom_field(expr) {
                ctx.fields.get(key, custom_fragment(root, ctx.store, e))
            } else if let ExprKind::Call { callee, arguments } = &base.kind {
                if matches!(&callee.kind, ExprKind::Identifier(f) if f == "named") {
                    let target = named_event(arguments, base, ctx)?;
                    field(name, ctx, target, expr)?
                } else {
                    return Err(EvalError::at(expr, "field access is not valid here"));
                }
            } else if let ExprKind::Identifier(root) = &base.kind {
                if root == "death" {
                    let d = ctx.store.death[e as usize];
                    if d == NONE_U32 {
                        Value::Missing
                    } else {
                        match name.as_str() {
                            "seq" => Value::Int(d as i128),
                            "time" => Value::Int(ctx.store.t[d as usize] as i128),
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
                .map(|x| eval(x, ctx, e))
                .collect::<Result<Vec<_>, _>>()?;
            match &callee.kind {
                ExprKind::Identifier(name) if name == "abs" && args.len() == 1 => match args[0] {
                    Value::Int(v) => Value::Int(v.abs()),
                    _ => return Err(EvalError::at(expr, "abs requires a number")),
                },
                ExprKind::Field { base, name } if args.len() == 1 => {
                    let hay = eval(base, ctx, e)?;
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
                ExprKind::Identifier(name) if name == "named" => {
                    return Err(EvalError::at(
                        expr,
                        "`named(...)` is an allocation; read a field of it, as `named(\"x\").address`",
                    ))
                }
                _ => return Err(EvalError::at(expr, "unknown function")),
            }
        }
        ExprKind::Index { .. } => match custom_field(expr) {
            Some((root, key)) => ctx.fields.get(key, custom_fragment(root, ctx.store, e)),
            None => {
                return Err(EvalError::at(
                    expr,
                    "only `field[...]` and `death.field[...]` take a key",
                ))
            }
        },
        ExprKind::Binary { op, left, right } => {
            if *op == BinaryOp::And || *op == BinaryOp::Or {
                let a = evaluate(left, ctx, e)?;
                if (*op == BinaryOp::And && !a) || (*op == BinaryOp::Or && a) {
                    Value::Bool(a)
                } else {
                    Value::Bool(evaluate(right, ctx, e)?)
                }
            } else {
                let a = eval(left, ctx, e)?;
                let b = eval(right, ctx, e)?;
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
                        Value::Set(values) => member(&values, &a),
                        _ => return Err(EvalError::at(expr, "`in` requires a set or range")),
                    }),
                    BinaryOp::Contains => Value::Bool(match a {
                        Value::Set(values) => member(&values, &b),
                        _ => {
                            return Err(EvalError::at(
                                expr,
                                "`contains` requires a set on the left",
                            ))
                        }
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
