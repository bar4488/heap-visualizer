//! Lowering a checked filter expression to a plan over the store's columns,
//! and executing that plan 64 events at a time.
//!
//! [D008] is the rule this module exists to keep: an Apply compiles the
//! checked tree once and the scan executes the compiled form. Nothing here
//! visits a syntax node, compares a field name as a string, or allocates once
//! per event.
//!
//! Two structural facts do most of the work.
//!
//! **Every string in the language lives in a dictionary.** Sites, threads and
//! stacks are interned by the parser, and custom fields are resolved once per
//! distinct extras fragment. So a string predicate is decided over the
//! *dictionary* while lowering — four sites, not a million events — and the
//! per-event step is one id load and one bit test. `starts_with` on a site
//! column then costs exactly what `==` on it costs, which is why E010's worry
//! that stack substring predicates would have to be slower does not survive
//! lowering.
//!
//! **The output and the tag indexes are both blocked by 64.** The match bitset
//! is words of 64 events, and [D009]'s `tag_members` is a bitset per tag over
//! the same blocks. `tags contains "x"` is therefore not a per-event test at
//! all: it is one 64-bit load. The executor works a block at a time and
//! carries an `active` mask down the tree, so `&&` narrows what the next
//! clause looks at and an expensive clause only ever touches events a cheaper
//! one left alive.
//!
//! [D008]: ../../../docs/decisions/D008-the-filter-evaluator-is-a-lowered-plan.md
//! [D009]: ../../../docs/decisions/D009-tag-membership-has-one-owner-and-derived-indexes.md

use heap_visualizer_filter_dsl::{BinaryOp, Expr, ExprKind, UnaryOp};

use crate::filter_eval::{
    cmp_num, custom_field, custom_fragment, field_value, float, integer, named_event, ordered,
    Ctx, EvalError, FieldRoot, FieldValues, Num, Value,
};
use crate::store::{Store, NONE_U16, NONE_U32, OP_M, OP_R};

// ------------------------------------------------------------------ columns

/// A numeric column, read straight out of the store.
///
/// `None` is the missing value: E010's rule is that every operation on one is
/// false, and returning `None` here is how that reaches the comparison.
#[derive(Clone, Copy, Debug)]
enum NumCol {
    Id,
    Addr,
    End,
    Size,
    Seq,
    Time,
    Usable,
    Lifetime,
    DeathSeq,
    DeathTime,
}

impl NumCol {
    #[inline]
    fn get(self, s: &Store, e: u32) -> Option<i128> {
        let i = e as usize;
        Some(match self {
            NumCol::Id => s.id[i] as i128,
            NumCol::Addr => s.addr[i] as i128,
            NumCol::End => (s.addr[i] + s.span(e)) as i128,
            NumCol::Size => s.size[i] as i128,
            NumCol::Seq => e as i128,
            NumCol::Time => s.t[i] as i128,
            NumCol::Usable => match s.usable_at(e) {
                0 => return None,
                v => v as i128,
            },
            NumCol::Lifetime => match s.death[i] {
                NONE_U32 => return None,
                d => (s.t[d as usize] - s.t[i]) as i128,
            },
            NumCol::DeathSeq => match s.death[i] {
                NONE_U32 => return None,
                d => d as i128,
            },
            NumCol::DeathTime => match s.death[i] {
                NONE_U32 => return None,
                d => s.t[d as usize] as i128,
            },
        })
    }

    /// The plain `u64` column this is, when it is one: never missing, and
    /// readable without arithmetic. `End` is excluded because it is a sum, and
    /// the optional columns because they carry a sentinel.
    const fn plain(self) -> Option<U64Col> {
        Some(match self {
            NumCol::Id => U64Col::Id,
            NumCol::Addr => U64Col::Addr,
            NumCol::Size => U64Col::Size,
            NumCol::Time => U64Col::Time,
            NumCol::Seq => U64Col::Seq,
            _ => return None,
        })
    }
}

/// A column that is one `u64` per event, with no sentinel and no arithmetic.
#[derive(Clone, Copy, Debug)]
enum U64Col {
    Id,
    Addr,
    Size,
    Time,
    /// The event index itself, so there is no column to read.
    Seq,
}

impl U64Col {
    fn slice(self, s: &Store) -> Option<&[u64]> {
        Some(match self {
            U64Col::Id => &s.id,
            U64Col::Addr => &s.addr,
            U64Col::Size => &s.size,
            U64Col::Time => &s.t,
            U64Col::Seq => return None,
        })
    }
}

/// A dictionary-backed column: the event holds a small id, and the value that
/// id stands for lives in a table with far fewer entries than there are
/// events.
#[derive(Clone, Copy, Debug)]
enum DictCol {
    Site,
    Thread,
    Stack,
    /// A custom trace field. The dictionary is the interned extras fragment
    /// table and `key` indexes the keys `FieldValues` resolved.
    Field { root: FieldRoot, key: usize },
}

impl DictCol {
    fn len(self, s: &Store) -> usize {
        match self {
            DictCol::Site => s.sites.len(),
            DictCol::Thread => s.thrs.len(),
            DictCol::Stack => s.stacks.len(),
            DictCol::Field { .. } => s.extras.len(),
        }
    }

    /// What entry `id` stands for. `Missing` for a custom key the fragment
    /// does not carry, which is why the whole dictionary is walked rather than
    /// assumed dense.
    fn value(self, id: usize, s: &Store, fv: &FieldValues) -> Value {
        match self {
            DictCol::Site => Value::String(s.sites[id].clone()),
            DictCol::Thread => Value::Int(s.thrs[id] as i128),
            DictCol::Stack => Value::String(s.stacks[id].clone()),
            DictCol::Field { key, .. } => fv.at(key, id as u32),
        }
    }

    /// The value for one event, without cloning — the fallback paths that
    /// survive to the scan use this.
    #[inline]
    fn num_at(self, s: &Store, fv: &FieldValues, e: u32) -> Option<Num> {
        match self {
            DictCol::Thread => match s.thr_idx[e as usize] {
                NONE_U16 => None,
                t => Some(Num::Int(s.thrs[t as usize] as i128)),
            },
            DictCol::Field { key, .. } => match fv.at_ref(key, custom_fragment_of(self, s, e)) {
                Some(Value::Int(v)) => Some(Num::Int(*v)),
                Some(Value::Float(v)) => Some(Num::Float(*v)),
                _ => None,
            },
            _ => None,
        }
    }

    #[inline]
    fn str_at<'a>(self, s: &'a Store, fv: &'a FieldValues, e: u32) -> Option<&'a str> {
        match self {
            DictCol::Site => match s.site[e as usize] {
                NONE_U32 => None,
                id => Some(&s.sites[id as usize]),
            },
            DictCol::Stack => match s.stack_at(e) {
                NONE_U32 => None,
                id => Some(&s.stacks[id as usize]),
            },
            DictCol::Field { key, .. } => match fv.at_ref(key, custom_fragment_of(self, s, e)) {
                Some(Value::String(v)) => Some(v),
                _ => None,
            },
            DictCol::Thread => None,
        }
    }
}

#[inline]
fn custom_fragment_of(col: DictCol, s: &Store, e: u32) -> u32 {
    match col {
        DictCol::Field { root, .. } => custom_fragment(root, s, e),
        _ => NONE_U32,
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum StrOp {
    Contains,
    StartsWith,
    EndsWith,
}

impl StrOp {
    fn test(self, haystack: &str, needle: &str) -> bool {
        match self {
            StrOp::Contains => haystack.contains(needle),
            StrOp::StartsWith => haystack.starts_with(needle),
            StrOp::EndsWith => haystack.ends_with(needle),
        }
    }
}

// ------------------------------------------------------------------ the plan

/// A lowered numeric expression. Constant-folded, so `named("x").size` and
/// `4KiB` are both `Const` by the time the scan runs.
#[derive(Clone, Debug)]
enum Scalar {
    Const(Num),
    Col(NumCol),
    Dict(DictCol),
    Add(Box<(Scalar, Scalar)>),
    Sub(Box<(Scalar, Scalar)>),
    Abs(Box<Scalar>),
}

impl Scalar {
    #[inline]
    fn get(&self, s: &Store, fv: &FieldValues, e: u32) -> Option<Num> {
        match self {
            Scalar::Const(v) => Some(*v),
            Scalar::Col(col) => col.get(s, e).map(Num::Int),
            Scalar::Dict(col) => col.num_at(s, fv, e),
            Scalar::Add(pair) => arith(&pair.0, &pair.1, s, fv, e, false),
            Scalar::Sub(pair) => arith(&pair.0, &pair.1, s, fv, e, true),
            Scalar::Abs(inner) => match inner.get(s, fv, e)? {
                Num::Int(v) => v.checked_abs().map(Num::Int),
                Num::Float(v) => Some(Num::Float(v.abs())),
            },
        }
    }

    fn cost(&self) -> u32 {
        match self {
            Scalar::Const(_) => 0,
            Scalar::Col(_) => 1,
            Scalar::Dict(_) => 2,
            Scalar::Abs(inner) => 2 + inner.cost(),
            Scalar::Add(pair) | Scalar::Sub(pair) => 2 + pair.0.cost() + pair.1.cost(),
        }
    }
}

#[inline]
fn arith(a: &Scalar, b: &Scalar, s: &Store, fv: &FieldValues, e: u32, sub: bool) -> Option<Num> {
    match (a.get(s, fv, e)?, b.get(s, fv, e)?) {
        // exact while both sides are integers, and checked: an overflow makes
        // the enclosing comparison false rather than wrapping or trapping
        (Num::Int(a), Num::Int(b)) => if sub { a.checked_sub(b) } else { a.checked_add(b) }
            .map(Num::Int),
        (a, b) => {
            let (a, b) = (widen(a), widen(b));
            Some(Num::Float(if sub { a - b } else { a + b }))
        }
    }
}

#[inline]
const fn widen(n: Num) -> f64 {
    match n {
        Num::Int(v) => v as f64,
        Num::Float(v) => v,
    }
}

/// One node of the compiled predicate. Every variant answers for a whole
/// 64-event block at once.
#[derive(Clone, Debug)]
enum Pred {
    Const(bool),
    And(Box<[Pred]>),
    Or(Box<[Pred]>),
    Not(Box<Pred>),
    /// `tags contains "x"` — one word out of `tag_members`, no per-event work.
    TagWord(u8),
    /// `tags` is non-empty — one word out of the derived union index.
    TagAny,
    /// Exact set equality against a constant tag set, word-wise: every wanted
    /// tag present, and no tag outside the set present.
    TagsEq(Box<[u8]>),
    /// Decided over the dictionary while lowering; per event this is an id
    /// load and a bit test. A missing id is always false, which is the
    /// false-propagation rule — `is missing` is `Missing` below instead.
    Dict { col: DictCol, bits: Box<[u64]> },
    /// Whether a dictionary column has a value at all.
    DictPresent { col: DictCol, bits: Box<[u64]>, want: bool },
    /// The hot shape specialized all the way down: a plain `u64` column
    /// against a `u64` constant, which is the loop the floor control in
    /// E019-bench measures. Nothing is optional, nothing widens to `i128`,
    /// and the comparison is monomorphic per branch so it vectorizes.
    U64Cmp { col: U64Col, op: BinaryOp, rhs: u64 },
    /// The same shape where the column is optional or the constant does not
    /// fit a `u64`.
    NumCmp { col: NumCol, op: BinaryOp, rhs: Num },
    /// Anything else numeric, including column against column.
    Cmp { left: Scalar, op: BinaryOp, right: Scalar },
    /// Membership in a constant numeric set, sorted at lowering.
    NumIn { left: Scalar, set: Box<[Num]> },
    /// Presence of a numeric column: `is missing`, `is not missing`, `freed`.
    Present { col: NumCol, want: bool },
    /// Two dictionary columns compared to each other. Rare, and the one place
    /// a string comparison survives to the scan — still allocation-free.
    DictStrCmp { left: DictCol, right: DictCol, op: BinaryOp },
    /// A string method whose receiver is a dictionary column but whose
    /// argument is not constant. Also rare.
    DictStrOp { left: DictCol, right: DictCol, op: StrOp },
}

impl Pred {
    /// Rough per-event cost, used to order `&&`/`||` children so a cheap
    /// clause narrows the active mask before an expensive one reads it. Every
    /// clause yields a definite bool and nothing has side effects, so
    /// reordering cannot change the answer.
    fn cost(&self) -> u32 {
        match self {
            Pred::Const(_) | Pred::TagWord(_) | Pred::TagAny => 0,
            Pred::TagsEq(want) => 1 + want.len() as u32,
            Pred::Dict { .. } | Pred::DictPresent { .. } | Pred::Present { .. } => 2,
            Pred::U64Cmp { .. } => 3,
            Pred::NumCmp { .. } => 4,
            Pred::NumIn { left, set } => 4 + left.cost() + set.len().max(1).ilog2(),
            Pred::Cmp { left, right, .. } => 4 + left.cost() + right.cost(),
            Pred::DictStrCmp { .. } | Pred::DictStrOp { .. } => 12,
            Pred::Not(inner) => inner.cost(),
            Pred::And(cs) | Pred::Or(cs) => cs.iter().map(Pred::cost).sum(),
        }
    }
}

/// A compiled filter: the predicate, plus the creator mask it is intersected
/// with so that a non-allocation event can never match.
pub struct Plan {
    root: Pred,
    creators: Vec<u64>,
    creator_count: u32,
}

impl Plan {
    pub fn creator_count(&self) -> u32 {
        self.creator_count
    }
}

// ------------------------------------------------------------------ lowering

/// Compile a checked expression. `check` has already run, so a diagnostic here
/// means lowering met a shape the checker admits and this module does not — a
/// bug rather than bad input, but reported rather than panicked on.
pub fn lower(expr: &Expr, ctx: &Ctx) -> Result<Plan, EvalError> {
    let root = pred(expr, ctx)?;
    let s = ctx.store;
    let mut creators = vec![0u64; (s.len() as usize).div_ceil(64).max(1)];
    let mut creator_count = 0;
    for e in 0..s.len() {
        if matches!(s.op[e as usize], OP_M | OP_R) {
            creators[e as usize / 64] |= 1 << (e % 64);
            creator_count += 1;
        }
    }
    Ok(Plan {
        root,
        creators,
        creator_count,
    })
}

fn pred(expr: &Expr, ctx: &Ctx) -> Result<Pred, EvalError> {
    match &expr.kind {
        ExprKind::Bool(v) => Ok(Pred::Const(*v)),
        ExprKind::Unary {
            op: UnaryOp::Not,
            expr: inner,
        } => Ok(not(pred(inner, ctx)?)),
        ExprKind::IsMissing {
            expr: inner,
            negated,
        } => presence(inner, ctx, *negated),
        ExprKind::Identifier(name) if name == "freed" => Ok(Pred::Present {
            col: NumCol::DeathSeq,
            want: true,
        }),
        ExprKind::Binary { op, left, right } => binary(expr, *op, left, right, ctx),
        ExprKind::Call { .. } => string_method(expr, ctx),
        _ => {
            if let Some(Value::Bool(v)) = constant(expr, ctx)? {
                return Ok(Pred::Const(v));
            }
            // a boolean custom field standing alone: `field.live`
            match dict_col(expr, ctx)? {
                Some(col) => Ok(dict_pred(col, ctx, |value| {
                    matches!(value, Value::Bool(true))
                })),
                None => Err(EvalError::at(expr, "filter expression must produce bool")),
            }
        }
    }
}

fn not(p: Pred) -> Pred {
    match p {
        Pred::Const(v) => Pred::Const(!v),
        Pred::Not(inner) => *inner,
        Pred::Present { col, want } => Pred::Present { col, want: !want },
        Pred::DictPresent { col, bits, want } => Pred::DictPresent {
            col,
            bits,
            want: !want,
        },
        other => Pred::Not(Box::new(other)),
    }
}

fn binary(
    expr: &Expr,
    op: BinaryOp,
    left: &Expr,
    right: &Expr,
    ctx: &Ctx,
) -> Result<Pred, EvalError> {
    match op {
        BinaryOp::And | BinaryOp::Or => {
            let mut parts = Vec::new();
            flatten(op, left, right, ctx, &mut parts)?;
            Ok(join(op, parts))
        }
        BinaryOp::Overlaps => {
            // half-open [a,b) and [c,d) overlap exactly when a < d and c < b
            let (a, b) = range_bounds(left, ctx)?;
            let (c, d) = range_bounds(right, ctx)?;
            Ok(join(
                BinaryOp::And,
                vec![
                    compare(a, BinaryOp::Less, d, ctx, expr)?,
                    compare(c, BinaryOp::Less, b, ctx, expr)?,
                ],
            ))
        }
        BinaryOp::In => membership(expr, left, right, ctx),
        BinaryOp::Contains => contains(expr, left, right, ctx),
        BinaryOp::Equal | BinaryOp::NotEqual => equality(expr, op, left, right, ctx),
        BinaryOp::Less | BinaryOp::LessEqual | BinaryOp::Greater | BinaryOp::GreaterEqual => {
            compare(operand(left, ctx)?, op, operand(right, ctx)?, ctx, expr)
        }
        BinaryOp::Add | BinaryOp::Subtract => {
            Err(EvalError::at(expr, "filter expression must produce bool"))
        }
    }
}

fn flatten(
    op: BinaryOp,
    left: &Expr,
    right: &Expr,
    ctx: &Ctx,
    out: &mut Vec<Pred>,
) -> Result<(), EvalError> {
    for side in [left, right] {
        match &side.kind {
            ExprKind::Binary {
                op: inner,
                left,
                right,
            } if *inner == op => flatten(op, left, right, ctx, out)?,
            _ => out.push(pred(side, ctx)?),
        }
    }
    Ok(())
}

/// Build an `&&`/`||` node, folding constants away and ordering the survivors
/// cheapest-first.
fn join(op: BinaryOp, parts: Vec<Pred>) -> Pred {
    let and = op == BinaryOp::And;
    let mut kept = Vec::with_capacity(parts.len());
    for part in parts {
        match part {
            // `false && x` is false, `true && x` is x, and the mirror for ||
            Pred::Const(v) if v != and => return Pred::Const(v),
            Pred::Const(_) => {}
            other => kept.push(other),
        }
    }
    kept.sort_by_key(Pred::cost);
    match kept.len() {
        0 => Pred::Const(and),
        1 => kept.pop().expect("length checked"),
        _ if and => Pred::And(kept.into_boxed_slice()),
        _ => Pred::Or(kept.into_boxed_slice()),
    }
}

fn presence(inner: &Expr, ctx: &Ctx, negated: bool) -> Result<Pred, EvalError> {
    if let Some(col) = num_col(inner)? {
        return Ok(Pred::Present { col, want: negated });
    }
    if let Some(col) = dict_col(inner, ctx)? {
        let mut bits = bitmap(col.len(ctx.store));
        for id in 0..col.len(ctx.store) {
            if !matches!(col.value(id, ctx.store, ctx.fields), Value::Missing) {
                set_bit(&mut bits, id);
            }
        }
        return Ok(Pred::DictPresent {
            col,
            bits,
            want: negated,
        });
    }
    match constant(inner, ctx)? {
        Some(value) => Ok(Pred::Const(matches!(value, Value::Missing) ^ negated)),
        None => Err(EvalError::at(inner, "`is missing` requires a field")),
    }
}

fn equality(
    expr: &Expr,
    op: BinaryOp,
    left: &Expr,
    right: &Expr,
    ctx: &Ctx,
) -> Result<Pred, EvalError> {
    let negated = op == BinaryOp::NotEqual;
    // `tags == {..}` is exact set equality, and it is answered word-wise
    for (a, b) in [(left, right), (right, left)] {
        if is_tags(a) {
            return Ok(maybe_not(tags_eq(tag_set(b, ctx)?), negated));
        }
    }
    compare(operand(left, ctx)?, op, operand(right, ctx)?, ctx, expr)
}

fn tags_eq(want: Option<Vec<u8>>) -> Pred {
    match want {
        // a label no allocation carries cannot be a member of any set
        None => Pred::Const(false),
        Some(want) if want.is_empty() => Pred::Not(Box::new(Pred::TagAny)),
        Some(want) => Pred::TagsEq(want.into_boxed_slice()),
    }
}

fn maybe_not(p: Pred, negated: bool) -> Pred {
    if negated {
        not(p)
    } else {
        p
    }
}

fn contains(expr: &Expr, left: &Expr, right: &Expr, ctx: &Ctx) -> Result<Pred, EvalError> {
    if is_tags(left) {
        let Some(Value::String(label)) = constant(right, ctx)? else {
            return Err(EvalError::at(expr, "`contains` requires a constant member"));
        };
        return Ok(match tag_id(&label, ctx) {
            Some(tag) => Pred::TagWord(tag),
            None => Pred::Const(false),
        });
    }
    match (constant(left, ctx)?, constant(right, ctx)?) {
        (Some(Value::Set(items)), Some(needle)) => {
            Ok(Pred::Const(items.iter().any(|v| value_eq(v, &needle))))
        }
        _ => Err(EvalError::at(expr, "`contains` requires a set on the left")),
    }
}

fn membership(expr: &Expr, left: &Expr, right: &Expr, ctx: &Ctx) -> Result<Pred, EvalError> {
    if let ExprKind::Range { start, end } = &right.kind {
        // half-open, so membership is exactly two comparisons
        return Ok(join(
            BinaryOp::And,
            vec![
                compare(
                    operand(left, ctx)?,
                    BinaryOp::GreaterEqual,
                    operand(start, ctx)?,
                    ctx,
                    expr,
                )?,
                compare(
                    operand(left, ctx)?,
                    BinaryOp::Less,
                    operand(end, ctx)?,
                    ctx,
                    expr,
                )?,
            ],
        ));
    }
    let Some(Value::Set(members)) = constant(right, ctx)? else {
        return Err(EvalError::at(expr, "`in` requires a constant set or range"));
    };
    if let Some(col) = dict_col(left, ctx)? {
        return Ok(dict_pred(col, ctx, |value| {
            members.iter().any(|m| value_eq(m, value))
        }));
    }
    if let Some(value) = constant(left, ctx)? {
        return Ok(Pred::Const(members.iter().any(|m| value_eq(m, &value))));
    }
    let mut set: Vec<Num> = members.iter().filter_map(Value::num).collect();
    if set.len() != members.len() {
        return Err(EvalError::at(expr, "`in` requires a compatible set"));
    }
    set.sort_by(|a, b| cmp_num(*a, *b).unwrap_or(core::cmp::Ordering::Equal));
    Ok(Pred::NumIn {
        left: as_scalar(operand(left, ctx)?, expr)?,
        set: set.into_boxed_slice(),
    })
}

/// A string method — `contains`, `starts_with`, `ends_with` — or a `named()`
/// call that turned out to be constant.
fn string_method(expr: &Expr, ctx: &Ctx) -> Result<Pred, EvalError> {
    let ExprKind::Call { callee, arguments } = &expr.kind else {
        return Err(EvalError::at(expr, "filter expression must produce bool"));
    };
    let ExprKind::Field { base, name } = &callee.kind else {
        return match constant(expr, ctx)? {
            Some(Value::Bool(v)) => Ok(Pred::Const(v)),
            _ => Err(EvalError::at(expr, "filter expression must produce bool")),
        };
    };
    let op = match name.as_str() {
        "contains" => StrOp::Contains,
        "starts_with" => StrOp::StartsWith,
        "ends_with" => StrOp::EndsWith,
        _ => return Err(EvalError::at(expr, format!("unknown string method `{name}`"))),
    };
    let [argument] = arguments.as_slice() else {
        return Err(EvalError::at(expr, format!("`{name}` requires one string")));
    };
    let receiver = operand(base, ctx)?;
    let needle = operand(argument, ctx)?;
    Ok(match (receiver, needle) {
        // the ordinary case: decided over the dictionary, so a substring test
        // runs once per distinct site or stack rather than once per event
        (Operand::Dict(col), Operand::Const(Value::String(needle))) => {
            dict_pred(col, ctx, |value| match value {
                Value::String(v) => op.test(v, &needle),
                _ => false,
            })
        }
        (Operand::Const(Value::String(a)), Operand::Const(Value::String(b))) => {
            Pred::Const(op.test(&a, &b))
        }
        (Operand::Const(Value::Missing), _) | (_, Operand::Const(Value::Missing)) => {
            Pred::Const(false)
        }
        (Operand::Dict(left), Operand::Dict(right)) => Pred::DictStrOp { left, right, op },
        _ => return Err(EvalError::at(expr, format!("`{name}` requires one string"))),
    })
}

// ----------------------------------------------------------------- operands

enum Operand {
    Const(Value),
    Num(Scalar),
    NumColumn(NumCol),
    Dict(DictCol),
}

fn operand(expr: &Expr, ctx: &Ctx) -> Result<Operand, EvalError> {
    if let Some(value) = constant(expr, ctx)? {
        return Ok(Operand::Const(value));
    }
    if let Some(col) = num_col(expr)? {
        return Ok(Operand::NumColumn(col));
    }
    if let Some(col) = dict_col(expr, ctx)? {
        return Ok(Operand::Dict(col));
    }
    Ok(Operand::Num(scalar(expr, ctx)?))
}

fn compare(
    left: Operand,
    op: BinaryOp,
    right: Operand,
    ctx: &Ctx,
    expr: &Expr,
) -> Result<Pred, EvalError> {
    Ok(match (left, right) {
        (Operand::Const(a), Operand::Const(b)) => Pred::Const(const_cmp(&a, op, &b)),
        // a dictionary against a constant: decided over the dictionary
        (Operand::Dict(col), Operand::Const(v)) => {
            dict_pred(col, ctx, |value| const_cmp(value, op, &v))
        }
        (Operand::Const(v), Operand::Dict(col)) => {
            dict_pred(col, ctx, |value| const_cmp(&v, op, value))
        }
        // the hot shape
        (Operand::NumColumn(col), Operand::Const(v)) => match v.num() {
            Some(rhs) => num_cmp(col, op, rhs),
            None => Pred::Const(false),
        },
        (Operand::Const(v), Operand::NumColumn(col)) => match v.num() {
            Some(rhs) => num_cmp(col, flip(op), rhs),
            None => Pred::Const(false),
        },
        (Operand::Dict(a), Operand::Dict(b)) if is_string_dict(a) && is_string_dict(b) => {
            Pred::DictStrCmp {
                left: a,
                right: b,
                op,
            }
        }
        (a, b) => Pred::Cmp {
            left: as_scalar(a, expr)?,
            op,
            right: as_scalar(b, expr)?,
        },
    })
}

/// One numeric column against one constant, taking the `u64` specialization
/// where the column allows it.
///
/// A `u64` column can never hold a negative value or one past `u64::MAX`, so a
/// constant outside that range makes the comparison constant — folded here
/// rather than left for the scan to rediscover a million times.
fn num_cmp(col: NumCol, op: BinaryOp, rhs: Num) -> Pred {
    let (Some(plain), Num::Int(v)) = (col.plain(), rhs) else {
        return Pred::NumCmp { col, op, rhs };
    };
    if let Ok(v) = u64::try_from(v) {
        return Pred::U64Cmp {
            col: plain,
            op,
            rhs: v,
        };
    }
    // below every possible value, or above every possible value
    let below = v < 0;
    Pred::Const(match op {
        BinaryOp::Equal => false,
        BinaryOp::NotEqual => true,
        BinaryOp::Less | BinaryOp::LessEqual => !below,
        BinaryOp::Greater | BinaryOp::GreaterEqual => below,
        _ => return Pred::NumCmp { col, op, rhs },
    })
}

const fn is_string_dict(col: DictCol) -> bool {
    matches!(col, DictCol::Site | DictCol::Stack | DictCol::Field { .. })
}

fn as_scalar(op: Operand, expr: &Expr) -> Result<Scalar, EvalError> {
    Ok(match op {
        Operand::Num(s) => s,
        Operand::NumColumn(col) => Scalar::Col(col),
        Operand::Dict(col) => Scalar::Dict(col),
        Operand::Const(v) => match v.num() {
            Some(n) => Scalar::Const(n),
            None => return Err(EvalError::at(expr, "operands have incompatible types")),
        },
    })
}

const fn flip(op: BinaryOp) -> BinaryOp {
    match op {
        BinaryOp::Less => BinaryOp::Greater,
        BinaryOp::LessEqual => BinaryOp::GreaterEqual,
        BinaryOp::Greater => BinaryOp::Less,
        BinaryOp::GreaterEqual => BinaryOp::LessEqual,
        other => other,
    }
}

/// Decide a predicate over every entry of a dictionary, once. A missing entry
/// is false without consulting `test`, which is the false-propagation rule.
fn dict_pred(col: DictCol, ctx: &Ctx, test: impl Fn(&Value) -> bool) -> Pred {
    let n = col.len(ctx.store);
    let mut bits = bitmap(n);
    for id in 0..n {
        let value = col.value(id, ctx.store, ctx.fields);
        if !matches!(value, Value::Missing) && test(&value) {
            set_bit(&mut bits, id);
        }
    }
    Pred::Dict { col, bits }
}

fn scalar(expr: &Expr, ctx: &Ctx) -> Result<Scalar, EvalError> {
    if let Some(value) = constant(expr, ctx)? {
        return match value.num() {
            Some(n) => Ok(Scalar::Const(n)),
            None => Err(EvalError::at(expr, "arithmetic requires numbers")),
        };
    }
    if let Some(col) = num_col(expr)? {
        return Ok(Scalar::Col(col));
    }
    if let Some(col) = dict_col(expr, ctx)? {
        return Ok(Scalar::Dict(col));
    }
    match &expr.kind {
        ExprKind::Binary {
            op: op @ (BinaryOp::Add | BinaryOp::Subtract),
            left,
            right,
        } => {
            let pair = Box::new((scalar(left, ctx)?, scalar(right, ctx)?));
            Ok(match op {
                BinaryOp::Add => Scalar::Add(pair),
                _ => Scalar::Sub(pair),
            })
        }
        ExprKind::Call { callee, arguments }
            if matches!(&callee.kind, ExprKind::Identifier(n) if n == "abs")
                && arguments.len() == 1 =>
        {
            Ok(Scalar::Abs(Box::new(scalar(&arguments[0], ctx)?)))
        }
        _ => Err(EvalError::at(expr, "arithmetic requires numbers")),
    }
}

/// The two bounds of a range operand, as operands themselves.
fn range_bounds(expr: &Expr, ctx: &Ctx) -> Result<(Operand, Operand), EvalError> {
    match &expr.kind {
        ExprKind::Range { start, end } => Ok((operand(start, ctx)?, operand(end, ctx)?)),
        // `span` is the allocation's half-open rendered range
        ExprKind::Identifier(name) if name == "span" => Ok((
            Operand::NumColumn(NumCol::Addr),
            Operand::NumColumn(NumCol::End),
        )),
        ExprKind::Field { base, name } if name == "span" && is_named_call(base) => {
            let e = named_target(base, ctx)?;
            Ok((
                Operand::Const(Value::Int(ctx.store.addr[e as usize] as i128)),
                Operand::Const(Value::Int(
                    (ctx.store.addr[e as usize] + ctx.store.span(e)) as i128,
                )),
            ))
        }
        _ => Err(EvalError::at(expr, "`overlaps` requires two ranges")),
    }
}

// ------------------------------------------------------- resolving the names

/// The numeric column an expression names, if it is one.
fn num_col(expr: &Expr) -> Result<Option<NumCol>, EvalError> {
    // a field of a named allocation is a constant, not a column
    if let ExprKind::Field { base, .. } = &expr.kind {
        if is_named_call(base) {
            return Ok(None);
        }
    }
    if custom_field(expr).is_some() {
        return Ok(None);
    }
    Ok(match &expr.kind {
        ExprKind::Identifier(name) => match name.as_str() {
            "id" => Some(NumCol::Id),
            "address" => Some(NumCol::Addr),
            "end" => Some(NumCol::End),
            "size" => Some(NumCol::Size),
            "seq" => Some(NumCol::Seq),
            "time" => Some(NumCol::Time),
            "usable" => Some(NumCol::Usable),
            "lifetime" => Some(NumCol::Lifetime),
            _ => None,
        },
        ExprKind::Field { base, name }
            if matches!(&base.kind, ExprKind::Identifier(r) if r == "death") =>
        {
            match name.as_str() {
                "seq" => Some(NumCol::DeathSeq),
                "time" => Some(NumCol::DeathTime),
                _ => None,
            }
        }
        _ => None,
    })
}

/// The dictionary column an expression names, if it is one.
fn dict_col(expr: &Expr, ctx: &Ctx) -> Result<Option<DictCol>, EvalError> {
    if let Some((root, key)) = custom_field(expr) {
        let Some(index) = ctx.fields.key_index(key) else {
            // the expression named a key, so `FieldValues::resolve` collected
            // it; not finding it means the two disagree
            return Err(EvalError::at(expr, format!("unresolved trace field `{key}`")));
        };
        return Ok(Some(DictCol::Field { root, key: index }));
    }
    if let ExprKind::Field { base, .. } = &expr.kind {
        if is_named_call(base) {
            return Ok(None);
        }
    }
    Ok(match &expr.kind {
        ExprKind::Identifier(name) => match name.as_str() {
            "site" => Some(DictCol::Site),
            "thread" => Some(DictCol::Thread),
            "stack" => Some(DictCol::Stack),
            _ => None,
        },
        _ => None,
    })
}

fn is_named_call(expr: &Expr) -> bool {
    matches!(&expr.kind, ExprKind::Call { callee, .. }
        if matches!(&callee.kind, ExprKind::Identifier(name) if name == "named"))
}

fn named_target(expr: &Expr, ctx: &Ctx) -> Result<u32, EvalError> {
    match &expr.kind {
        ExprKind::Call { arguments, .. } => named_event(arguments, expr, ctx),
        _ => Err(EvalError::at(expr, "expected a named allocation")),
    }
}

fn is_tags(expr: &Expr) -> bool {
    matches!(&expr.kind, ExprKind::Identifier(name) if name == "tags")
}

fn tag_id(label: &str, ctx: &Ctx) -> Option<u8> {
    ctx.labels
        .iter()
        .position(|l| l == label)
        .map(|i| i as u8 + 1)
}

/// The tag ids a constant set names. `None` when a member names no tag in use,
/// which makes exact set equality unsatisfiable.
fn tag_set(expr: &Expr, ctx: &Ctx) -> Result<Option<Vec<u8>>, EvalError> {
    let Some(Value::Set(members)) = constant(expr, ctx)? else {
        return Err(EvalError::at(expr, "`tags` compares to a constant set"));
    };
    let mut ids = Vec::with_capacity(members.len());
    for member in &members {
        let Value::String(label) = member else {
            return Err(EvalError::at(expr, "tag members are strings"));
        };
        match tag_id(label, ctx) {
            Some(id) if !ids.contains(&id) => ids.push(id),
            Some(_) => {}
            None => return Ok(None),
        }
    }
    ids.sort_unstable();
    Ok(Some(ids))
}

/// Fold an expression that does not depend on the event. Constants, sets of
/// constants, `abs` of one, and every field of a `named()` allocation — which
/// is resolved while checking, so its fields are fixed for the whole scan.
fn constant(expr: &Expr, ctx: &Ctx) -> Result<Option<Value>, EvalError> {
    let err = |m: String| EvalError::at(expr, m);
    Ok(Some(match &expr.kind {
        ExprKind::Bool(v) => Value::Bool(*v),
        ExprKind::String(v) => Value::String(v.clone()),
        ExprKind::Integer(v) => {
            Value::Int(integer(v.value, v.unit, &ctx.store.unit).map_err(err)?)
        }
        ExprKind::Float(v) => Value::Float(float(v.value, v.unit, &ctx.store.unit).map_err(err)?),
        ExprKind::Set(items) => {
            let mut members = Vec::with_capacity(items.len());
            for item in items {
                match constant(item, ctx)? {
                    Some(value) => members.push(value),
                    None => return Ok(None),
                }
            }
            Value::Set(members)
        }
        ExprKind::Field { base, name } if is_named_call(base) => {
            let target = named_target(base, ctx)?;
            field_value(name, ctx, target, expr)?
        }
        ExprKind::Index { .. } if custom_field(expr).is_some() => return Ok(None),
        ExprKind::Binary {
            op: op @ (BinaryOp::Add | BinaryOp::Subtract),
            left,
            right,
        } => {
            let (Some(a), Some(b)) = (constant(left, ctx)?, constant(right, ctx)?) else {
                return Ok(None);
            };
            let (Some(a), Some(b)) = (a.num(), b.num()) else {
                return Ok(None);
            };
            let sub = *op == BinaryOp::Subtract;
            match (a, b) {
                (Num::Int(a), Num::Int(b)) => {
                    match if sub { a.checked_sub(b) } else { a.checked_add(b) } {
                        Some(v) => Value::Int(v),
                        None => return Err(err("arithmetic overflows".into())),
                    }
                }
                (a, b) => Value::Float(if sub {
                    widen(a) - widen(b)
                } else {
                    widen(a) + widen(b)
                }),
            }
        }
        ExprKind::Call { callee, arguments }
            if matches!(&callee.kind, ExprKind::Identifier(n) if n == "abs")
                && arguments.len() == 1 =>
        {
            match constant(&arguments[0], ctx)? {
                Some(Value::Int(v)) => Value::Int(v.abs()),
                Some(Value::Float(v)) => Value::Float(v.abs()),
                _ => return Ok(None),
            }
        }
        _ => return Ok(None),
    }))
}

/// Constant comparison, matching `filter_eval`'s rules exactly: numbers
/// compare across representations, strings and bools compare to their own
/// kind, sets compare by exact membership, and anything involving a missing
/// value is false.
fn const_cmp(a: &Value, op: BinaryOp, b: &Value) -> bool {
    if matches!(a, Value::Missing) || matches!(b, Value::Missing) {
        return false;
    }
    match op {
        BinaryOp::Equal => value_eq(a, b),
        BinaryOp::NotEqual => !value_eq(a, b),
        _ => {
            if let (Some(a), Some(b)) = (a.num(), b.num()) {
                return cmp_num(a, b).is_some_and(|o| ordered(o, op));
            }
            match (a, b) {
                (Value::String(a), Value::String(b)) => ordered(a.as_str().cmp(b.as_str()), op),
                _ => false,
            }
        }
    }
}

fn value_eq(a: &Value, b: &Value) -> bool {
    if let (Some(a), Some(b)) = (a.num(), b.num()) {
        return cmp_num(a, b).is_some_and(|o| o.is_eq());
    }
    match (a, b) {
        (Value::Missing, _) | (_, Value::Missing) => false,
        (Value::Bool(a), Value::Bool(b)) => a == b,
        (Value::String(a), Value::String(b)) => a == b,
        (Value::Set(a), Value::Set(b)) => {
            a.iter().all(|x| b.iter().any(|y| value_eq(x, y)))
                && b.iter().all(|x| a.iter().any(|y| value_eq(x, y)))
        }
        _ => false,
    }
}

fn bitmap(n: usize) -> Box<[u64]> {
    vec![0u64; n.div_ceil(64).max(1)].into_boxed_slice()
}

fn set_bit(bits: &mut [u64], i: usize) {
    bits[i / 64] |= 1 << (i % 64);
}

#[inline]
fn get_bit(bits: &[u64], i: u32) -> bool {
    let i = i as usize;
    bits.get(i / 64).is_some_and(|w| w & (1 << (i % 64)) != 0)
}

// ----------------------------------------------------------------- execution

/// Run the plan over the whole trace, writing one match bit per event.
/// Returns the number of matches.
pub fn scan(plan: &Plan, ctx: &Ctx, out: &mut [u64]) -> u32 {
    let s = ctx.store;
    let fv = ctx.fields;
    let mut matches = 0;
    for (block, slot) in out.iter_mut().enumerate() {
        let active = plan.creators.get(block).copied().unwrap_or(0);
        if active == 0 {
            *slot = 0;
            continue;
        }
        let word = word_of(&plan.root, s, fv, block, active) & active;
        *slot = word;
        matches += word.count_ones();
    }
    matches
}

/// Answer one predicate for one 64-event block. `active` is the set of events
/// still worth asking about; a leaf never looks outside it.
fn word_of(p: &Pred, s: &Store, fv: &FieldValues, block: usize, active: u64) -> u64 {
    match p {
        Pred::Const(true) => active,
        Pred::Const(false) => 0,
        Pred::And(children) => {
            let mut mask = active;
            for child in children.iter() {
                if mask == 0 {
                    break;
                }
                mask &= word_of(child, s, fv, block, mask);
            }
            mask
        }
        Pred::Or(children) => {
            let mut found = 0;
            for child in children.iter() {
                let rest = active & !found;
                if rest == 0 {
                    break;
                }
                found |= word_of(child, s, fv, block, rest);
            }
            found
        }
        Pred::Not(inner) => active & !word_of(inner, s, fv, block, active),
        Pred::TagWord(tag) => active & tag_word(s, *tag, block),
        Pred::TagAny => active & s.tag_any.get(block).copied().unwrap_or(0),
        Pred::TagsEq(want) => {
            let mut mask = active;
            for &tag in want.iter() {
                mask &= tag_word(s, tag, block);
                if mask == 0 {
                    return 0;
                }
            }
            // and no tag outside the set: only the tags actually present in
            // this block can disqualify anything, which is what `tag_block` is
            for tag in block_tags(s, block) {
                if !want.contains(&tag) {
                    mask &= !tag_word(s, tag, block);
                    if mask == 0 {
                        return 0;
                    }
                }
            }
            mask
        }
        Pred::Dict { col, bits } => dict_word(*col, s, block, active, |id| {
            id != NONE_U32 && get_bit(bits, id)
        }),
        Pred::DictPresent { col, bits, want } => dict_word(*col, s, block, active, |id| {
            (id != NONE_U32 && get_bit(bits, id)) == *want
        }),
        Pred::U64Cmp { col, op, rhs } => u64_word(*col, *op, *rhs, s, block, active),
        Pred::NumCmp { col, op, rhs } => each(active, block, |e| match col.get(s, e) {
            Some(v) => cmp_num(Num::Int(v), *rhs).is_some_and(|o| matches_op(o, *op)),
            None => false,
        }),
        Pred::Cmp { left, op, right } => each(active, block, |e| {
            match (left.get(s, fv, e), right.get(s, fv, e)) {
                (Some(a), Some(b)) => cmp_num(a, b).is_some_and(|o| matches_op(o, *op)),
                _ => false,
            }
        }),
        Pred::NumIn { left, set } => each(active, block, |e| match left.get(s, fv, e) {
            Some(v) => set
                .binary_search_by(|m| cmp_num(*m, v).unwrap_or(core::cmp::Ordering::Greater))
                .is_ok(),
            None => false,
        }),
        // every optional column is a sentinel test, so it never needs the
        // general numeric read
        Pred::Present { col, want } => match col {
            NumCol::DeathSeq | NumCol::DeathTime | NumCol::Lifetime => {
                let death = &s.death;
                each(active, block, |e| {
                    (death[e as usize] != NONE_U32) == *want
                })
            }
            NumCol::Usable if !s.usable.is_empty() => {
                let usable = &s.usable;
                each(active, block, |e| (usable[e as usize] != 0) == *want)
            }
            NumCol::Usable => each(active, block, |_| !*want),
            _ => each(active, block, |e| col.get(s, e).is_some() == *want),
        },
        Pred::DictStrCmp { left, right, op } => each(active, block, |e| {
            match (left.str_at(s, fv, e), right.str_at(s, fv, e)) {
                (Some(a), Some(b)) => matches_op(a.cmp(b), *op),
                _ => false,
            }
        }),
        Pred::DictStrOp { left, right, op } => each(active, block, |e| {
            match (left.str_at(s, fv, e), right.str_at(s, fv, e)) {
                (Some(a), Some(b)) => op.test(a, b),
                _ => false,
            }
        }),
    }
}

/// A dictionary column for a whole block, with `hit` deciding what a given id
/// means.
///
/// Which column it is is matched once, here, rather than once per event: the
/// loop below closes over a plain slice. `hit` receives `NONE_U32` for an
/// event with no entry, so missingness is decided by the caller and this
/// function only reads ids.
#[inline]
fn dict_word(
    col: DictCol,
    s: &Store,
    block: usize,
    active: u64,
    hit: impl Fn(u32) -> bool,
) -> u64 {
    match col {
        DictCol::Site => {
            let ids = &s.site;
            each(active, block, |e| hit(ids[e as usize]))
        }
        DictCol::Thread => {
            let ids = &s.thr_idx;
            each(active, block, |e| match ids[e as usize] {
                NONE_U16 => hit(NONE_U32),
                t => hit(u32::from(t)),
            })
        }
        DictCol::Stack if !s.stack.is_empty() => {
            let ids = &s.stack;
            each(active, block, |e| hit(ids[e as usize]))
        }
        // a lazy column the trace never materialized: every event is missing
        DictCol::Stack => each(active, block, |_| hit(NONE_U32)),
        DictCol::Field {
            root: FieldRoot::Alloc,
            ..
        } if !s.extra.is_empty() => {
            let ids = &s.extra;
            each(active, block, |e| hit(ids[e as usize]))
        }
        DictCol::Field { root, .. } => each(active, block, |e| hit(custom_fragment(root, s, e))),
    }
}

/// One `u64` column against one constant, for a whole block.
///
/// The 64 values are taken as a slice and the operator is matched *outside*
/// the loop, so each branch compiles to a straight comparison over contiguous
/// memory — the same shape as E019-bench's control. A partial or narrowed
/// block falls back to the general path, which is correct but not the case
/// worth tuning.
#[inline]
fn u64_word(col: U64Col, op: BinaryOp, rhs: u64, s: &Store, block: usize, active: u64) -> u64 {
    let base = block * 64;
    if let (Some(column), true) = (col.slice(s), active == u64::MAX) {
        if let Some(vals) = column.get(base..base + 64) {
            macro_rules! word {
                ($test:expr) => {{
                    let mut out = 0u64;
                    for b in 0..64 {
                        out |= u64::from($test(vals[b])) << b;
                    }
                    out
                }};
            }
            return match op {
                BinaryOp::Equal => word!(|v| v == rhs),
                BinaryOp::NotEqual => word!(|v| v != rhs),
                BinaryOp::Less => word!(|v| v < rhs),
                BinaryOp::LessEqual => word!(|v| v <= rhs),
                BinaryOp::Greater => word!(|v| v > rhs),
                _ => word!(|v| v >= rhs),
            };
        }
    }
    each(active, block, |e| {
        let v = match col.slice(s) {
            Some(column) => column[e as usize],
            None => u64::from(e),
        };
        match op {
            BinaryOp::Equal => v == rhs,
            BinaryOp::NotEqual => v != rhs,
            BinaryOp::Less => v < rhs,
            BinaryOp::LessEqual => v <= rhs,
            BinaryOp::Greater => v > rhs,
            _ => v >= rhs,
        }
    })
}

/// Test the events in `active` and collect the answers into a word.
///
/// A full block runs as a straight loop over all 64 — no bit scanning, and it
/// vectorizes — while a narrowed one walks only the bits still set, which is
/// what makes ordering a cheap clause first worth doing.
#[inline]
fn each(active: u64, block: usize, mut test: impl FnMut(u32) -> bool) -> u64 {
    let base = (block as u32) * 64;
    if active == u64::MAX {
        let mut out = 0u64;
        for b in 0..64u32 {
            out |= u64::from(test(base + b)) << b;
        }
        return out;
    }
    let mut out = 0u64;
    let mut bits = active;
    while bits != 0 {
        let b = bits.trailing_zeros();
        bits &= bits - 1;
        if test(base + b) {
            out |= 1 << b;
        }
    }
    out
}

#[inline]
fn tag_word(s: &Store, tag: u8, block: usize) -> u64 {
    s.tag_members
        .get(tag as usize)
        .and_then(|bits| bits.get(block))
        .copied()
        .unwrap_or(0)
}

/// The tags holding any member in this block, from the derived block index.
fn block_tags(s: &Store, block: usize) -> impl Iterator<Item = u8> + '_ {
    let mask = s.tag_block.get(block).copied().unwrap_or([0; 4]);
    (0..4).flat_map(move |word| {
        let mut bits = mask[word];
        core::iter::from_fn(move || {
            if bits == 0 {
                return None;
            }
            let bit = bits.trailing_zeros();
            bits &= bits - 1;
            Some((word * 64 + bit as usize) as u8)
        })
    })
}

#[inline]
fn matches_op(ord: core::cmp::Ordering, op: BinaryOp) -> bool {
    match op {
        BinaryOp::Equal => ord.is_eq(),
        BinaryOp::NotEqual => !ord.is_eq(),
        _ => ordered(ord, op),
    }
}
