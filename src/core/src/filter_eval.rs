use heap_visualizer_filter_dsl::{
    completion_context, BinaryOp, CompletionSite, Expr, ExprKind, OperandKind, Span, UnaryOp, Unit,
};

use crate::json::push_json_str;
use crate::store::{
    Store, FIELD_BOOL, FIELD_FLOAT, FIELD_INT, FIELD_OTHER, FIELD_SCALARS, FIELD_STRING, NONE_U16,
    NONE_U32,
};

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
    #[cfg(test)]
    pub fn rows(&self) -> usize {
        self.values.len()
    }

    /// Where `key` sits in the resolved rows, for a plan that wants to read it
    /// by index rather than by name once per event.
    pub(crate) fn key_index(&self, key: &str) -> Option<usize> {
        self.keys.iter().position(|k| k == key)
    }

    /// The value of the key at `index` in the fragment interned at `fragment`.
    pub(crate) fn at(&self, index: usize, fragment: u32) -> Value {
        self.at_ref(index, fragment).cloned().unwrap_or(Value::Missing)
    }

    /// The same, borrowed — the scan paths that read a custom value per event
    /// must not clone a String to do it.
    pub(crate) fn at_ref(&self, index: usize, fragment: u32) -> Option<&Value> {
        if fragment == NONE_U32 {
            return None;
        }
        match self.values.get(fragment as usize)?.get(index)? {
            Value::Missing => None,
            value => Some(value),
        }
    }

    /// The value of `key` in the fragment interned at `fragment`, which is
    /// `NONE_U32` for an event carrying no custom fields at all.
    #[cfg(test)]
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

/// Which event's fragment a custom field reads: the allocation's own creator
/// record, or the record that freed it.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum FieldRoot {
    Alloc,
    Death,
}

/// One of the three objects every field hangs off.
///
/// `alloc` is the allocation — what it is and how long it lived. `malloc` is
/// the record that created it, `free` the record that ended it. Nothing is
/// reachable except through one of them.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum Ns {
    Alloc,
    Malloc,
    Free,
}

impl Ns {
    pub(crate) fn parse(name: &str) -> Option<Self> {
        Some(match name {
            "alloc" => Ns::Alloc,
            "malloc" => Ns::Malloc,
            "free" => Ns::Free,
            _ => return None,
        })
    }

    pub(crate) const fn label(self) -> &'static str {
        match self {
            Ns::Alloc => "alloc",
            Ns::Malloc => "malloc",
            Ns::Free => "free",
        }
    }

    /// Which record's custom fields `<ns>.fields` reads. `alloc` has none:
    /// custom fields belong to records, and an allocation is not one.
    const fn field_root(self) -> Option<FieldRoot> {
        match self {
            Ns::Alloc => None,
            Ns::Malloc => Some(FieldRoot::Alloc),
            Ns::Free => Some(FieldRoot::Death),
        }
    }
}

/// What a field path names, once the namespace and any `named()` subject in
/// front of it have been peeled off.
#[derive(Clone, Copy, Debug)]
pub(crate) enum Leaf<'a> {
    /// A built-in field, as `alloc.size` or `malloc.seq`.
    Builtin { ns: Ns, name: &'a str },
    /// A custom trace field, as `malloc.fields.pool` or `free.fields["k"]`.
    Custom { root: FieldRoot, key: &'a str },
}

/// A resolved field reference: what it names, and whose.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Path<'a> {
    /// The `named("x")` call this path hangs off, if any. `None` is the
    /// allocation being tested.
    pub subject: Option<&'a Expr>,
    pub leaf: Leaf<'a>,
}

/// The namespace an expression is, plus the `named()` call in front of it.
///
/// `alloc` on its own, and `named("x").alloc` — a named allocation exposes the
/// same three objects the subject does, so every path reads the same whoever
/// it is about.
fn ns_of(expr: &Expr) -> Option<(Ns, Option<&Expr>)> {
    match &expr.kind {
        ExprKind::Identifier(name) => Ns::parse(name).map(|ns| (ns, None)),
        ExprKind::Field { base, name } if is_named_call(base) => {
            Ns::parse(name).map(|ns| (ns, Some(&**base)))
        }
        _ => None,
    }
}

/// Recognize every field path the language has. Everything else — a method
/// call, a literal, arithmetic — is not one, and the caller handles it.
///
/// The shapes are `<ns>.<name>`, `<ns>.fields.<key>`, `<ns>.fields["<key>"]`,
/// and each of those behind `named("x").`.
pub(crate) fn resolve_path(expr: &Expr) -> Option<Path<'_>> {
    let (base, name) = match &expr.kind {
        ExprKind::Field { base, name } => (base, name.as_str()),
        ExprKind::Index { base, key } => (base, key.as_str()),
        _ => return None,
    };
    // `<ns>.<name>` — an index is never a built-in, so only a Field reaches it
    if let Some((ns, subject)) = ns_of(base) {
        return matches!(expr.kind, ExprKind::Field { .. }).then_some(Path {
            subject,
            leaf: Leaf::Builtin { ns, name },
        });
    }
    // `<ns>.fields.<key>` and `<ns>.fields["<key>"]`
    let ExprKind::Field {
        base: inner,
        name: fields,
    } = &base.kind
    else {
        return None;
    };
    if fields != "fields" {
        return None;
    }
    let (ns, subject) = ns_of(inner)?;
    Some(Path {
        subject,
        leaf: Leaf::Custom {
            root: ns.field_root()?,
            key: name,
        },
    })
}

/// The custom field an expression names, for the passes that only care about
/// those — collecting keys to resolve, and reading one during evaluation.
pub(crate) fn custom_field(expr: &Expr) -> Option<(FieldRoot, &str)> {
    match resolve_path(expr)?.leaf {
        Leaf::Custom { root, key } => Some((root, key)),
        Leaf::Builtin { .. } => None,
    }
}

/// True for a `named(...)` call, whatever its argument turns out to be.
fn is_named_call(expr: &Expr) -> bool {
    matches!(&expr.kind, ExprKind::Call { callee, .. }
        if matches!(&callee.kind, ExprKind::Identifier(name) if name == "named"))
}

/// True for `<ns>.fields` with no key on it yet — a reference the user has
/// started and not finished.
fn is_field_root(expr: &Expr) -> bool {
    matches!(&expr.kind, ExprKind::Field { base, name }
        if name == "fields" && ns_of(base).is_some_and(|(ns, _)| ns.field_root().is_some()))
}

/// Every built-in field of one object: the completion catalog, and the same
/// list `field_type` accepts.
fn ns_fields(ns: Ns) -> &'static [(&'static str, &'static str, Type)] {
    match ns {
        Ns::Alloc => &[
            ("address", "address", Type::Int),
            ("end", "address", Type::Int),
            ("freed", "bool", Type::Bool),
            ("id", "integer", Type::Int),
            ("lifetime", "time, optional", Type::Int),
            ("size", "bytes", Type::Int),
            ("span", "address range", Type::Range),
            ("tags", "string set", Type::Set(ValueKind::String)),
            ("usable", "bytes, optional", Type::Int),
        ],
        Ns::Malloc => &[
            ("seq", "integer", Type::Int),
            ("site", "string, optional", Type::String),
            ("stack", "string", Type::String),
            ("thread", "integer, optional", Type::Int),
            ("time", "time", Type::Int),
        ],
        Ns::Free => &[
            ("seq", "integer, optional", Type::Int),
            ("time", "time, optional", Type::Int),
        ],
    }
}

pub fn schema(store: &Store, from: usize, count: usize) -> serde_json::Value {
    fn type_name(ty: Type) -> &'static str {
        match ty {
            Type::Bool => "bool",
            Type::Int => "integer",
            Type::Float => "float",
            Type::String => "string",
            Type::Range => "range",
            Type::Set(ValueKind::String) => "string-set",
            Type::Set(ValueKind::Bool) => "bool-set",
            Type::Set(ValueKind::Int) => "integer-set",
            Type::Set(ValueKind::Float) => "float-set",
            Type::Allocation => "allocation",
        }
    }
    fn fields(ns: Ns) -> Vec<serde_json::Value> {
        ns_fields(ns).iter().map(|(name, detail, ty)| serde_json::json!({
            "name": name, "type": type_name(*ty), "description": detail,
        })).collect()
    }
    let total = store.fields.len();
    let end = from.saturating_add(count).min(total);
    let custom: Vec<_> = store.fields[from.min(total)..end].iter().map(|field| serde_json::json!({
        "name": field.name,
        "type": match field.scalar() {
            Some(FIELD_BOOL) => Some("bool"),
            Some(FIELD_INT) => Some("integer"),
            Some(FIELD_FLOAT) => Some("float"),
            Some(FIELD_STRING) => Some("string"),
            _ => None,
        },
        "optional": field.optional(),
        "events": field.events,
    })).collect();
    serde_json::json!({
        "namespaces": [
            { "name": "alloc", "fields": fields(Ns::Alloc), "customFields": false },
            { "name": "malloc", "fields": fields(Ns::Malloc), "customFields": true },
            { "name": "free", "fields": fields(Ns::Free), "customFields": true }
        ],
        "customFields": custom,
        "customFieldPage": {
            "from": from, "count": end.saturating_sub(from), "total": total,
            "next": (end < total).then_some(end)
        },
        "customFieldPaths": ["malloc.fields.<name>", "free.fields.<name>"],
        "functions": [{ "name": "named", "signature": "named(string) -> allocation" }],
        "operators": ["and", "or", "not", "==", "!=", "<", "<=", ">", ">=", "in", "is none", "is not none", "+", "-", "*", "/", "%"],
        "literals": ["integer", "float", "string", "bool", "none", "set", "half-open-range"]
    })
}

/// The fields of one object, as completion items.
fn ns_field_items(ns: Ns, expected: Option<Type>, ctx: &Ctx) -> Vec<CompletionItem> {
    let mut items: Vec<_> = ns_fields(ns)
        .iter()
        .filter(|(_, _, ty)| expected.is_none_or(|want| fits(want, *ty)))
        .map(|(label, detail, _)| item(label, &format!("{label} "), "member", Some(detail), 0))
        .collect();
    // `fields.` only where the trace actually carries one, so completion never
    // advertises a surface the checker will reject (ANL-003)
    if ns.field_root().is_some() && expected.is_none() && !field_key_items(ctx).is_empty() {
        items.push(item("fields", "fields.", "member", Some("trace fields"), 1));
    }
    items
}

fn collect_keys(expr: &Expr, out: &mut Vec<String>) {
    if let Some((_, key)) = custom_field(expr) {
        if !out.iter().any(|k| k == key) {
            out.push(key.to_string());
        }
    }
    let mut visit = |child: &Expr| collect_keys(child, out);
    match &expr.kind {
        ExprKind::Unary { expr, .. } | ExprKind::IsNone { expr, .. } => visit(expr),
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
                    // a number: integral text parses as an integer, and
                    // anything with a fraction or an exponent as a float.
                    // Parsing everything as i128 is what made a fractional
                    // field silently missing (T034).
                    _ => core::str::from_utf8(&bytes[vlo..vhi]).map_or(
                        Value::Missing,
                        |text| {
                            if text.bytes().any(|c| matches!(c, b'.' | b'e' | b'E')) {
                                text.parse::<f64>().map_or(Value::Missing, Value::Float)
                            } else {
                                text.parse::<i128>().map_or_else(
                                    // wider than i128: keep it as the number
                                    // it approximately is rather than dropping
                                    // the field
                                    |_| text.parse::<f64>().map_or(Value::Missing, Value::Float),
                                    Value::Int,
                                )
                            }
                        },
                    ),
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
    Float,
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
    Float,
    String,
}

impl ValueKind {
    const fn numeric(self) -> bool {
        matches!(self, ValueKind::Int | ValueKind::Float)
    }
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
            Type::Float => Some(ValueKind::Float),
            Type::String => Some(ValueKind::String),
            _ => None,
        }
    }

    const fn numeric(self) -> bool {
        matches!(self.ty, Type::Int | Type::Float)
    }
}

#[derive(Clone, Debug)]
pub(crate) enum Value {
    Bool(bool),
    Int(i128),
    Float(f64),
    String(String),
    /// Half-open, and numeric in either representation: `0x10..0x20` and
    /// `0.2..0.8` are both ranges.
    /// Read by the test oracle; the plan lowers a range to its two bounds.
    #[cfg_attr(not(test), allow(dead_code))]
    Range(Num, Num),
    Set(Vec<Value>),
    Missing,
}

/// A number in the representation it was written in. Kept apart rather than
/// widened to f64 so that comparing a large integer — an address, a
/// nanosecond timestamp — against a float stays exact.
#[derive(Clone, Copy, Debug)]
pub(crate) enum Num {
    Int(i128),
    Float(f64),
}

impl Value {
    pub(crate) const fn num(&self) -> Option<Num> {
        match self {
            Value::Int(v) => Some(Num::Int(*v)),
            Value::Float(v) => Some(Num::Float(*v)),
            _ => None,
        }
    }
}

/// Order two numbers exactly, whatever the mix of representations. `None`
/// only for NaN, which is unordered against everything including itself.
///
/// The integer side is never converted with `as f64`: above 2^53 that
/// conversion rounds, and `id == 9007199254740993` would then answer true for
/// the allocation next to it.
pub(crate) fn cmp_num(a: Num, b: Num) -> Option<core::cmp::Ordering> {
    use core::cmp::Ordering;
    match (a, b) {
        (Num::Int(a), Num::Int(b)) => Some(a.cmp(&b)),
        (Num::Float(a), Num::Float(b)) => a.partial_cmp(&b),
        (Num::Int(a), Num::Float(b)) => cmp_int_float(a, b),
        (Num::Float(a), Num::Int(b)) => cmp_int_float(b, a).map(Ordering::reverse),
    }
}

/// Compare an integer against a float without rounding either one: split the
/// float into its integral and fractional parts and compare those.
fn cmp_int_float(a: i128, b: f64) -> Option<core::cmp::Ordering> {
    use core::cmp::Ordering;
    if b.is_nan() {
        return None;
    }
    // beyond the integer range entirely, including the infinities
    if b > i128::MAX as f64 {
        return Some(Ordering::Less);
    }
    if b < i128::MIN as f64 {
        return Some(Ordering::Greater);
    }
    let whole = b.trunc();
    Some(match a.cmp(&(whole as i128)) {
        Ordering::Equal => {
            // equal integral parts: the fraction decides, and its sign
            // follows the float's own (`-2.5` truncates towards zero)
            let fraction = b - whole;
            if fraction > 0.0 {
                Ordering::Less
            } else if fraction < 0.0 {
                Ordering::Greater
            } else {
                Ordering::Equal
            }
        }
        other => other,
    })
}


/// Whether a value of type `have` may stand where `want` is expected. Only
/// numbers are interchangeable: an integer operand fits a float slot and the
/// other way round, and the comparison that follows is exact.
const fn fits(want: Type, have: Type) -> bool {
    matches!(
        (want, have),
        (Type::Int | Type::Float, Type::Int | Type::Float)
    ) || matches_exactly(want, have)
}

const fn matches_exactly(want: Type, have: Type) -> bool {
    match (want, have) {
        (Type::Bool, Type::Bool)
        | (Type::String, Type::String)
        | (Type::Range, Type::Range)
        | (Type::Allocation, Type::Allocation) => true,
        (Type::Set(a), Type::Set(b)) => a as u8 == b as u8,
        _ => false,
    }
}

#[derive(Debug)]
pub struct EvalError {
    pub message: String,
    pub span: Span,
}

impl EvalError {
    pub(crate) fn at(expr: &Expr, message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            span: expr.span,
        }
    }
}

/// The type of one built-in field, by the object it hangs off.
///
/// This table is the language's field list. `alloc` is the allocation,
/// `malloc` and `free` the two records that bound it — so `site` and `thread`
/// live on `malloc`, which is the record that actually carries them, and an
/// `F` record carries neither.
fn field_type(ns: Ns, name: &str, expr: &Expr) -> Result<CheckedType, EvalError> {
    let ty = match (ns, name) {
        (Ns::Alloc, "id" | "address" | "end" | "size") => CheckedType::required(Type::Int),
        (Ns::Alloc, "span") => CheckedType::required(Type::Range),
        (Ns::Alloc, "usable" | "lifetime") => CheckedType::optional(Type::Int),
        // memberships are a set, empty rather than missing when untagged
        (Ns::Alloc, "tags") => CheckedType::required(Type::Set(ValueKind::String)),
        (Ns::Alloc, "freed") => CheckedType::required(Type::Bool),
        (Ns::Malloc, "seq" | "time") => CheckedType::required(Type::Int),
        (Ns::Malloc, "site") => CheckedType::optional(Type::String),
        (Ns::Malloc, "thread") => CheckedType::optional(Type::Int),
        (Ns::Malloc, "stack") => CheckedType::required(Type::String),
        (Ns::Free, "seq" | "time") => CheckedType::optional(Type::Int),
        (_, "fields") => {
            return Err(EvalError::at(
                expr,
                match ns.field_root() {
                    Some(_) => format!(
                        "`{ns}.fields` needs a key, as `{ns}.fields.pool`",
                        ns = ns.label()
                    ),
                    // an allocation is not a record, so it carries none
                    None => "custom fields are on `malloc` and `free`, not on `alloc`".to_string(),
                },
            ))
        }
        _ => {
            return Err(EvalError::at(
                expr,
                match moved_field(name) {
                    Some(home) if home != ns => format!(
                        "`{}` is on `{}`, not on `{}`",
                        name,
                        home.label(),
                        ns.label()
                    ),
                    _ => format!("`{}` has no field `{name}`", ns.label()),
                },
            ))
        }
    };
    Ok(ty)
}

/// The object a field actually lives on, for the diagnostic when it was asked
/// for on the wrong one — `alloc.site` is the mistake worth naming, because
/// the site is a property of the allocation to a reader and a property of the
/// record to the format.
fn moved_field(name: &str) -> Option<Ns> {
    Some(match name {
        "id" | "address" | "end" | "span" | "size" | "usable" | "lifetime" | "tags" | "freed" => {
            Ns::Alloc
        }
        "site" | "thread" | "stack" => Ns::Malloc,
        _ => return None,
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
        Some(FIELD_FLOAT) => Ok(CheckedType::optional(Type::Float)),
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
pub(crate) fn named_event(arguments: &[Expr], expr: &Expr, ctx: &Ctx) -> Result<u32, EvalError> {
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
        (FIELD_FLOAT, "float"),
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

/// Whether two operands may be compared. Identical value kinds may, and so
/// may any two numbers — an integer field against a float literal is the
/// ordinary case, not a type error.
fn same_values(left: CheckedType, right: CheckedType) -> bool {
    match (left.value_kind(), right.value_kind()) {
        (Some(a), Some(b)) => a == b || (a.numeric() && b.numeric()),
        _ => false,
    }
}

/// A short rendering of a method receiver, so the `contains` diagnostic can
/// name the expression the writer already typed.
fn source_hint(expr: &Expr) -> String {
    match resolve_path(expr).map(|path| path.leaf) {
        Some(Leaf::Builtin { ns, name }) => format!("{}.{name}", ns.label()),
        Some(Leaf::Custom { key, .. }) => key.to_string(),
        None => "the string".to_string(),
    }
}

/// The type of a resolved path. A `named()` subject is checked here too, so
/// an unresolvable name reports itself rather than arriving as a type error.
fn path_type(path: Path, expr: &Expr, ctx: &Ctx) -> Result<CheckedType, EvalError> {
    if let Some(subject) = path.subject {
        // `?` rather than `is_ok_and`: the name's own diagnostic is the useful
        // one, not "field access is not valid"
        check_type(subject, ctx)?;
    }
    match path.leaf {
        Leaf::Builtin { ns, name } => field_type(ns, name, expr),
        Leaf::Custom { key, .. } => custom_field_type(key, expr, ctx),
    }
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
        ExprKind::Float(value) => {
            float(value.value, value.unit, &ctx.store.unit)
                .map_err(|message| EvalError::at(expr, message))?;
            required(Type::Float)
        }
        ExprKind::String(_) => required(Type::String),
        ExprKind::Identifier(name) => Err(EvalError::at(
            expr,
            match Ns::parse(name) {
                Some(ns) => format!(
                    "`{ns}` needs a field, as `{ns}.{example}`",
                    ns = ns.label(),
                    example = match ns {
                        Ns::Alloc => "size",
                        Ns::Malloc => "site",
                        Ns::Free => "seq",
                    }
                ),
                // the old flat spelling, which is the mistake worth naming
                None => match moved_field(name) {
                    Some(home) => format!("write `{}.{name}`", home.label()),
                    None => format!("unknown field `{name}`"),
                },
            },
        )),
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
        ExprKind::IsNone { expr: inner, .. } => {
            // only an optional value can be None; on anything else the test
            // is a constant, which is a mistake worth reporting rather than
            // silently answering false — `tags` is a set, empty when untagged
            if check_type(inner, ctx)?.optional {
                required(Type::Bool)
            } else {
                Err(EvalError::at(expr, "`is None` requires an optional field"))
            }
        }
        ExprKind::Set(items) => {
            let Some(first) = items.first() else {
                return Err(EvalError::at(expr, "cannot infer the type of an empty set"));
            };
            let first = check_type(first, ctx)?;
            let Some(mut kind) = first.value_kind() else {
                return Err(EvalError::at(expr, "set members must be scalar values"));
            };
            for item in &items[1..] {
                match check_type(item, ctx)?.value_kind() {
                    Some(other) if other == kind => {}
                    // a set mixing integers and floats is a set of numbers;
                    // its members keep their own representation, so
                    // membership stays exact
                    Some(other) if other.numeric() && kind.numeric() => kind = ValueKind::Float,
                    _ => return Err(EvalError::at(expr, "set members must have one type")),
                }
            }
            required(Type::Set(kind))
        }
        ExprKind::Range { start, end } => {
            if check_type(start, ctx)?.numeric() && check_type(end, ctx)?.numeric() {
                required(Type::Range)
            } else {
                Err(EvalError::at(expr, "range bounds must be numeric"))
            }
        }
        ExprKind::Field { base, name } => {
            let Some(path) = resolve_path(expr) else {
                // the name's own diagnostic first: `named(malloc.site).seq`
                // is wrong about the argument, not about the namespace
                if is_named_call(base) {
                    check_type(base, ctx)?;
                }
                // an unfinished or misspelled path: say which part is wrong
                return Err(EvalError::at(
                    expr,
                    match ns_of(base) {
                        Some((ns, _)) => format!("`{}` has no field `{name}`", ns.label()),
                        // `alloc.fields.x`: the namespace is real, but an
                        // allocation is not a record and carries no fields
                        None if matches!(&base.kind, ExprKind::Field { base: inner, name }
                            if name == "fields" && ns_of(inner).is_some()) =>
                        {
                            "custom fields are on `malloc` and `free`, not on `alloc`".to_string()
                        }
                        None if is_named_call(base) => format!(
                            "a named allocation exposes `alloc`, `malloc` and `free`, as `named(\"x\").alloc.{name}`"
                        ),
                        None => "field access is not valid here".to_string(),
                    },
                ));
            };
            path_type(path, expr, ctx)
        }
        ExprKind::Call { callee, arguments } => match &callee.kind {
            ExprKind::Identifier(name) if name == "len" => {
                let [argument] = arguments.as_slice() else {
                    return Err(EvalError::at(expr, "len takes one set"));
                };
                return if check_type(argument, ctx)?.member_kind().is_some() {
                    Ok(CheckedType::required(Type::Int))
                } else {
                    Err(EvalError::at(expr, "len takes a set, as `len(alloc.tags)`"))
                };
            }
            ExprKind::Identifier(name) if name == "abs" => {
                let argument = match arguments.as_slice() {
                    [only] => check_type(only, ctx)?,
                    _ => return Err(EvalError::at(expr, "abs requires one number")),
                };
                if argument.numeric() {
                    // abs of a float is a float: the result keeps the
                    // representation it was given
                    required(argument.ty)
                } else {
                    Err(EvalError::at(expr, "abs requires one number"))
                }
            }
            // a method: the two string tests, or `overlaps` on a range
            ExprKind::Field { base, name } => {
                let [argument] = arguments.as_slice() else {
                    return Err(EvalError::at(expr, format!("`{name}` takes one argument")));
                };
                match name.as_str() {
                    "startswith" | "endswith" => {
                        if check_type(base, ctx)?.ty != Type::String
                            || check_type(argument, ctx)?.ty != Type::String
                        {
                            return Err(EvalError::at(
                                expr,
                                format!("`{name}` requires one string argument"),
                            ));
                        }
                        required(Type::Bool)
                    }
                    "overlaps" => {
                        if check_type(base, ctx)?.ty != Type::Range
                            || check_type(argument, ctx)?.ty != Type::Range
                        {
                            return Err(EvalError::at(
                                expr,
                                "`overlaps` compares two ranges, as `alloc.span.overlaps(range(lo, hi))`",
                            ));
                        }
                        required(Type::Bool)
                    }
                    // the spellings this language deliberately does not have
                    "contains" => Err(EvalError::at(
                        expr,
                        format!("write `x in {}`", source_hint(base)),
                    )),
                    "starts_with" => Err(EvalError::at(expr, "write `startswith`")),
                    "ends_with" => Err(EvalError::at(expr, "write `endswith`")),
                    _ => Err(EvalError::at(expr, format!("unknown method `{name}`"))),
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
        ExprKind::Index { .. } => match resolve_path(expr) {
            Some(path) => path_type(path, expr, ctx),
            None => Err(EvalError::at(
                expr,
                "only `malloc.fields[...]` and `free.fields[...]` take a key",
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
                        && matches!(left_ty.ty, Type::Int | Type::Float | Type::String)
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
                    if left_ty.numeric() && right_ty.numeric() {
                        // exact while both sides are integers; a float
                        // operand makes the result a float
                        required(if left_ty.ty == Type::Float || right_ty.ty == Type::Float {
                            Type::Float
                        } else {
                            Type::Int
                        })
                    } else {
                        Err(EvalError::at(expr, "arithmetic requires numbers"))
                    }
                }
                BinaryOp::In => {
                    // one operator for every membership: a set, a substring of
                    // a string or a stack, and a half-open range
                    let compatible = match right_ty.ty {
                        Type::Range => left_ty.numeric(),
                        Type::Set(kind) => left_ty
                            .value_kind()
                            .is_some_and(|have| have == kind || (have.numeric() && kind.numeric())),
                        Type::String => left_ty.ty == Type::String,
                        _ => false,
                    };
                    if compatible {
                        required(Type::Bool)
                    } else {
                        Err(EvalError::at(
                            expr,
                            "`in` requires a set, a string, or a range on the right",
                        ))
                    }
                }

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

/// What can start an expression: the three objects, the functions, and the
/// two boolean constants.
///
/// A namespace is offered only when it holds a field of the wanted type, so
/// `alloc.` does not appear where a string belongs.
fn expression_items(expected: Option<Type>, ctx: &Ctx) -> Vec<CompletionItem> {
    let mut items = Vec::new();
    for ns in [Ns::Alloc, Ns::Malloc, Ns::Free] {
        let fits_here = ns_fields(ns)
            .iter()
            .any(|(_, _, ty)| expected.is_none_or(|want| fits(want, *ty)))
            || (expected.is_none()
                && ns.field_root().is_some()
                && !field_key_items(ctx).is_empty());
        if fits_here {
            items.push(item(
                ns.label(),
                &format!("{}.", ns.label()),
                "field",
                Some(match ns {
                    Ns::Alloc => "the allocation",
                    Ns::Malloc => "the record that created it",
                    Ns::Free => "the record that freed it",
                }),
                2,
            ));
        }
    }
    if expected.is_none_or(|want| fits(want, Type::Bool)) {
        items.push(item("false", "false ", "value", Some("bool"), 1));
        items.push(item("true", "true ", "value", Some("bool"), 1));
    }
    if expected.is_none_or(|want| fits(want, Type::Int)) {
        items.push(item("abs", "abs(", "function", Some("number -> number"), 2));
        items.push(item("len", "len(", "function", Some("set -> integer"), 2));
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
    items
}

/// The filter type of a catalogued field, or None when it cannot be filtered.
fn catalog_type(info: &crate::store::FieldInfo) -> Option<Type> {
    match info.scalar()? {
        FIELD_BOOL => Some(Type::Bool),
        FIELD_INT => Some(Type::Int),
        FIELD_FLOAT => Some(Type::Float),
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
                Some(FIELD_FLOAT) => "float, optional",
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
            Value::Int(_) | Value::Float(_) => {
                let label = number_source(&value);
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

/// A number as filter source. Rust's float Display is the shortest text that
/// reads back as the same double, so an offered value round-trips: inserting
/// it and comparing with `==` matches the record it came from.
fn number_source(value: &Value) -> String {
    match value {
        Value::Int(v) => v.to_string(),
        Value::Float(v) => {
            let text = v.to_string();
            // `1e20` prints without a dot or an exponent; as source that is
            // an integer literal, which compares exactly against the float
            // anyway, so nothing needs rewriting here
            text
        }
        _ => String::new(),
    }
}

fn operator_items(ty: CheckedType, leading_space: bool) -> Vec<CompletionItem> {
    let mut labels: Vec<(&str, Option<&str>)> = match ty.ty {
        Type::Bool => vec![("and", None), ("or", None), ("==", None), ("!=", None)],
        Type::Int | Type::Float => vec![
            ("+", None),
            ("-", None),
            ("==", None),
            ("!=", None),
            ("<", None),
            ("<=", None),
            (">", None),
            (">=", None),
            ("in", Some("set or range()")),
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
        // `overlaps` is a method, so a range advances through its `.`
        Type::Range => vec![(".", Some("overlaps"))],
        // and membership reads `"x" in alloc.tags`, so the set side offers
        // only the two whole-set comparisons
        Type::Set(_) => vec![
            ("==", Some("the whole set")),
            ("!=", Some("the whole set")),
        ],
        // a reference is not a value: the only thing to do with it is read a
        // field, and that is a member completion rather than an operator
        Type::Allocation => Vec::new(),
    };
    if ty.optional {
        labels.push(("is", Some("None test")));
    }
    labels
        .into_iter()
        .map(|(label, detail)| {
            let separator = if leading_space { " " } else { "" };
            item(label, format!("{separator}{label} "), "operator", detail, 0)
        })
        .collect()
}

/// What can follow a `.`.
fn member_items(receiver: &Expr, ctx: &Ctx) -> Vec<CompletionItem> {
    // `alloc.`, `malloc.`, `free.` — and the same behind a `named()`
    if let Some((ns, _)) = ns_of(receiver) {
        return ns_field_items(ns, None, ctx);
    }
    // `malloc.fields.` / `free.fields.`
    if is_field_root(receiver) {
        return field_key_items(ctx);
    }
    // `named("x").` exposes the same three objects the subject does
    if check_type(receiver, ctx).is_ok_and(|ty| ty.ty == Type::Allocation) {
        return expression_items(None, ctx)
            .into_iter()
            .filter(|candidate| candidate.kind == "field")
            .map(|candidate| {
                item(
                    &candidate.label,
                    &candidate.insert,
                    "member",
                    candidate.detail,
                    0,
                )
            })
            .collect();
    }
    match check_type(receiver, ctx).map(|ty| ty.ty) {
        Ok(Type::String) => vec![
            item("endswith", "endswith(", "member", Some("string -> bool"), 0),
            item(
                "startswith",
                "startswith(",
                "member",
                Some("string -> bool"),
                0,
            ),
        ],
        Ok(Type::Range) => vec![item(
            "overlaps",
            "overlaps(range(",
            "member",
            Some("range -> bool"),
            0,
        )],
        _ => Vec::new(),
    }
}


fn observed_items(subject: &Expr, ctx: &Ctx, in_set: bool) -> Vec<CompletionItem> {
    let Some(path) = resolve_path(subject) else {
        return Vec::new();
    };
    let name = match path.leaf {
        Leaf::Custom { key, .. } => return observed_field_values(key, ctx, in_set),
        Leaf::Builtin { ns: Ns::Malloc | Ns::Alloc, name } => name,
        Leaf::Builtin { .. } => return Vec::new(),
    };
    match name {
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
        // a set-typed left operand compares only to a set literal
        OperandKind::Binary(BinaryOp::Equal | BinaryOp::NotEqual)
            if left_ty.is_some_and(|ty| ty.member_kind().is_some()) =>
        {
            vec![item("{", "{", "operator", Some("constant set"), 0)]
        }
        // `in` takes a set, a range, or — for a string left operand — the
        // string or stack to look inside
        OperandKind::Binary(BinaryOp::In) => {
            let mut items = vec![item("{", "{", "operator", Some("constant set"), 0)];
            match left_ty.map(|ty| ty.ty) {
                Some(Type::Int | Type::Float) => {
                    items.push(item(
                        "range(",
                        "range(",
                        "function",
                        Some("half-open range"),
                        0,
                    ));
                    items.extend(expression_items(Some(Type::Int), ctx));
                }
                Some(Type::String) => items.extend(expression_items(Some(Type::String), ctx)),
                _ => {}
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
            if matches!(name.as_str(), "startswith" | "endswith")
                && check_type(base, ctx).is_ok_and(|ty| ty.ty == Type::String) =>
        {
            expression_items(Some(Type::String), ctx)
        }
        // `overlaps` takes a range, and `range(` is the only way to write one
        ExprKind::Field { base, name }
            if name == "overlaps"
                && check_type(base, ctx).is_ok_and(|ty| ty.ty == Type::Range) =>
        {
            vec![item(
                "range",
                "range(",
                "function",
                Some("half-open range"),
                0,
            )]
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
            if ns_of(expression).is_some() || is_field_root(expression) {
                replacement = Span::new(context.replacement.end, context.replacement.end);
                prefix.clear();
                let detail = if is_field_root(expression) {
                    "trace field keys"
                } else {
                    "fields of this object"
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
                vec![item("None", "None ", "operator", None, 0)]
            } else {
                vec![
                    item("None", "None ", "operator", None, 0),
                    item("not", "not ", "operator", Some("follow with None"), 0),
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

pub(crate) fn integer(value: u128, unit: Option<Unit>, time_unit: &str) -> Result<i128, String> {
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

/// A float literal in the trace's own unit. The unit multiplies the value,
/// exactly as it does for an integer literal, so `size > 1.5MiB` reads the
/// same as `size > 1572864`.
pub(crate) fn float(value: f64, unit: Option<Unit>, time_unit: &str) -> Result<f64, String> {
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
    let scaled = value * mul as f64;
    if scaled.is_finite() {
        Ok(scaled)
    } else {
        Err("float literal overflows".to_string())
    }
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
pub(crate) fn custom_fragment(root: FieldRoot, s: &Store, e: u32) -> u32 {
    match root {
        FieldRoot::Alloc => s.extra_at(e),
        FieldRoot::Death => match s.death[e as usize] {
            NONE_U32 => NONE_U32,
            death => s.extra_at(death),
        },
    }
}

pub(crate) fn field_value(
    ns: Ns,
    name: &str,
    ctx: &Ctx,
    e: u32,
    expr: &Expr,
) -> Result<Value, EvalError> {
    let s = ctx.store;
    let i = e as usize;
    let death = |value: fn(&Store, u32, usize) -> Value| match s.death[i] {
        NONE_U32 => Value::Missing,
        d => value(s, d, i),
    };
    Ok(match (ns, name) {
        (Ns::Alloc, "id") => Value::Int(s.id[i] as i128),
        (Ns::Alloc, "address") => Value::Int(s.addr[i] as i128),
        (Ns::Alloc, "end") => Value::Int((s.addr[i] + s.span(e)) as i128),
        (Ns::Alloc, "span") => Value::Range(
            Num::Int(s.addr[i] as i128),
            Num::Int((s.addr[i] + s.span(e)) as i128),
        ),
        (Ns::Alloc, "size") => Value::Int(s.size[i] as i128),
        (Ns::Alloc, "usable") => match s.usable_at(e) {
            0 => Value::Missing,
            v => Value::Int(v as i128),
        },
        // every membership, in tag-id order; empty for an untagged allocation
        (Ns::Alloc, "tags") => Value::Set(
            s.tag_ids(e)
                .filter_map(|id| ctx.labels.get(id as usize - 1).cloned())
                .map(Value::String)
                .collect(),
        ),
        (Ns::Alloc, "freed") => Value::Bool(s.death[i] != NONE_U32),
        (Ns::Alloc, "lifetime") => death(|s, d, i| Value::Int((s.t[d as usize] - s.t[i]) as i128)),
        (Ns::Malloc, "seq") => Value::Int(e as i128),
        (Ns::Malloc, "time") => Value::Int(s.t[i] as i128),
        (Ns::Malloc, "site") => match s.site[i] {
            NONE_U32 => Value::Missing,
            id => Value::String(s.sites[id as usize].clone()),
        },
        (Ns::Malloc, "thread") => match s.thr_idx[i] {
            NONE_U16 => Value::Missing,
            id => Value::Int(s.thrs[id as usize] as i128),
        },
        (Ns::Malloc, "stack") => match s.stack_at(e) {
            NONE_U32 => Value::Missing,
            id => Value::String(s.stacks[id as usize].clone()),
        },
        (Ns::Free, "seq") => death(|_, d, _| Value::Int(d as i128)),
        (Ns::Free, "time") => death(|s, d, _| Value::Int(s.t[d as usize] as i128)),
        _ => return Err(EvalError::at(expr, format!("`{}` has no field `{name}`", ns.label()))),
    })
}

/// Widen for arithmetic only, where a float result is already inexact.
/// Comparison never goes through this.
#[cfg(test)]
fn as_f64(n: Num) -> f64 {
    match n {
        Num::Int(v) => v as f64,
        Num::Float(v) => v,
    }
}

fn equal(a: &Value, b: &Value) -> Result<bool, String> {
    if let (Some(a), Some(b)) = (a.num(), b.num()) {
        // exact, across representations: `0.5 == 1/2` is not a thing the
        // language has, but `refcount == 2.0` is, and it answers true
        return Ok(cmp_num(a, b).is_some_and(|o| o.is_eq()));
    }
    match (a, b) {
        (Value::Missing, _) | (_, Value::Missing) => Ok(false),
        (Value::Bool(a), Value::Bool(b)) => Ok(a == b),
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

#[cfg(test)]
fn order(a: &Value, b: &Value, op: BinaryOp) -> Result<bool, String> {
    if let (Some(a), Some(b)) = (a.num(), b.num()) {
        // NaN is unordered: every comparison against it is false, which is
        // what `cmp_num` returning None means here
        let Some(ord) = cmp_num(a, b) else {
            return Ok(false);
        };
        return Ok(ordered(ord, op));
    }
    let ord = match (a, b) {
        (Value::Missing, _) | (_, Value::Missing) => return Ok(false),
        (Value::String(a), Value::String(b)) => a.cmp(b),
        _ => return Err("ordering operands have incompatible types".into()),
    };
    Ok(ordered(ord, op))
}

pub(crate) fn ordered(ord: core::cmp::Ordering, op: BinaryOp) -> bool {
    match op {
        BinaryOp::Less => ord.is_lt(),
        BinaryOp::LessEqual => ord.is_le(),
        BinaryOp::Greater => ord.is_gt(),
        BinaryOp::GreaterEqual => ord.is_ge(),
        _ => false,
    }
}

/// The tree-walking evaluator, kept as the **test oracle** for the lowered
/// plan and called from nowhere else. [D008] is why: an Apply executes a
/// compiled plan, and what makes that safe to believe is a second
/// implementation the tests can compare it against, expression by expression.
///
/// [D008]: ../../../docs/decisions/D008-the-filter-evaluator-is-a-lowered-plan.md
#[cfg(test)]
pub fn evaluate(expr: &Expr, ctx: &Ctx, e: u32) -> Result<bool, EvalError> {
    match eval(expr, ctx, e)? {
        Value::Bool(v) => Ok(v),
        Value::Missing => Ok(false),
        _ => Err(EvalError::at(expr, "filter expression must produce bool")),
    }
}

#[cfg(test)]
fn eval(expr: &Expr, ctx: &Ctx, e: u32) -> Result<Value, EvalError> {
    let err = |m: String| EvalError::at(expr, m);
    Ok(match &expr.kind {
        ExprKind::Bool(v) => Value::Bool(*v),
        ExprKind::Integer(v) => Value::Int(integer(v.value, v.unit, &ctx.store.unit).map_err(err)?),
        ExprKind::Float(v) => Value::Float(float(v.value, v.unit, &ctx.store.unit).map_err(err)?),
        ExprKind::String(v) => Value::String(v.clone()),
        ExprKind::Identifier(name) => {
            return Err(EvalError::at(expr, format!("`{name}` is not a value")))
        }
        ExprKind::Unary {
            op: UnaryOp::Not,
            expr: inner,
        } => match eval(inner, ctx, e)? {
            Value::Bool(v) => Value::Bool(!v),
            Value::Missing => Value::Bool(false),
            _ => return Err(EvalError::at(expr, "`not` requires bool")),
        },
        ExprKind::IsNone {
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
            match (eval(start, ctx, e)?.num(), eval(end, ctx, e)?.num()) {
                (Some(a), Some(b)) => Value::Range(a, b),
                _ => return Err(EvalError::at(expr, "range bounds must be numeric")),
            }
        }
        ExprKind::Field { .. } | ExprKind::Index { .. } => {
            let Some(path) = resolve_path(expr) else {
                return Err(EvalError::at(expr, "field access is not valid here"));
            };
            let subject = match path.subject {
                Some(call) => match &call.kind {
                    ExprKind::Call { arguments, .. } => named_event(arguments, call, ctx)?,
                    _ => return Err(EvalError::at(expr, "expected a named allocation")),
                },
                None => e,
            };
            match path.leaf {
                Leaf::Builtin { ns, name } => field_value(ns, name, ctx, subject, expr)?,
                Leaf::Custom { root, key } => {
                    ctx.fields.get(key, custom_fragment(root, ctx.store, subject))
                }
            }
        }
        ExprKind::Call { callee, arguments } => {
            let args = arguments
                .iter()
                .map(|x| eval(x, ctx, e))
                .collect::<Result<Vec<_>, _>>()?;
            match &callee.kind {
                ExprKind::Identifier(name) if name == "len" && args.len() == 1 => match &args[0] {
                    Value::Set(values) => Value::Int(values.len() as i128),
                    Value::Missing => Value::Missing,
                    _ => return Err(EvalError::at(expr, "len takes a set")),
                },
                ExprKind::Identifier(name) if name == "abs" && args.len() == 1 => match args[0] {
                    Value::Int(v) => Value::Int(v.abs()),
                    Value::Float(v) => Value::Float(v.abs()),
                    Value::Missing => Value::Missing,
                    _ => return Err(EvalError::at(expr, "abs requires a number")),
                },
                ExprKind::Field { base, name } if args.len() == 1 => {
                    let receiver = eval(base, ctx, e)?;
                    match (&receiver, &args[0], name.as_str()) {
                        (Value::Missing, _, _) | (_, Value::Missing, _) => Value::Bool(false),
                        (Value::String(a), Value::String(b), "startswith") => {
                            Value::Bool(a.starts_with(b))
                        }
                        (Value::String(a), Value::String(b), "endswith") => {
                            Value::Bool(a.ends_with(b))
                        }
                        // half-open, so each must begin before the other ends
                        (Value::Range(a0, a1), Value::Range(b0, b1), "overlaps") => Value::Bool(
                            cmp_num(*a0, *b1).is_some_and(|o| o.is_lt())
                                && cmp_num(*b0, *a1).is_some_and(|o| o.is_lt()),
                        ),
                        _ => {
                            return Err(EvalError::at(
                                expr,
                                format!("`{name}` does not apply to these operands"),
                            ))
                        }
                    }
                }
                ExprKind::Identifier(name) if name == "named" => {
                    return Err(EvalError::at(
                        expr,
                        "`named(...)` is an allocation; read a field of it, as `named(\"x\").alloc.address`",
                    ))
                }
                _ => return Err(EvalError::at(expr, "unknown function")),
            }
        }
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
                    BinaryOp::Add | BinaryOp::Subtract => match (a.num(), b.num()) {
                        (Some(Num::Int(x)), Some(Num::Int(y))) => {
                            Value::Int(if *op == BinaryOp::Add { x + y } else { x - y })
                        }
                        (Some(x), Some(y)) => {
                            let (x, y) = (as_f64(x), as_f64(y));
                            Value::Float(if *op == BinaryOp::Add { x + y } else { x - y })
                        }
                        _ => Value::Missing,
                    },
                    BinaryOp::In => Value::Bool(match b {
                        // half-open, and exact: the bound and the value are
                        // compared in their own representations
                        Value::Range(lo, hi) => a.num().is_some_and(|v| {
                            cmp_num(lo, v).is_some_and(|o| o.is_le())
                                && cmp_num(v, hi).is_some_and(|o| o.is_lt())
                        }),
                        Value::Set(values) => member(&values, &a),
                        // the substring test, which `in` also spells
                        Value::String(hay) => match &a {
                            Value::String(needle) => hay.contains(needle.as_str()),
                            Value::Missing => false,
                            _ => {
                                return Err(EvalError::at(
                                    expr,
                                    "`in` requires a string on the left",
                                ))
                            }
                        },
                        Value::Missing => false,
                        _ => {
                            return Err(EvalError::at(
                                expr,
                                "`in` requires a set, a string, or a range",
                            ))
                        }
                    }),
                    BinaryOp::And | BinaryOp::Or => unreachable!(),
                }
            }
        }
    })
}
