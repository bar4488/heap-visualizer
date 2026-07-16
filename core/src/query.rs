//! Metadata query language for filtering allocations by their caller-defined
//! `extra` fields. Std-only (the core takes no external crates), so there is
//! deliberately **no regex** — string tests are substring / exact only.
//!
//! Grammar (case-insensitive keywords; `AND` is also implied by juxtaposition):
//!
//! ```text
//!   or    := and ( ("OR" | "|" | "||") and )*
//!   and   := not ( ("AND" | "&" | "&&")? not )*
//!   not   := ("NOT" | "!" | "-") not | primary
//!   prim  := "(" or ")" | clause
//!   clause:= key ( op value )?
//!   op    := ":" | "~" | "=" | ">" | ">=" | "<" | "<="
//!   value := quoted | bareword          (bareword `N..M` = numeric range)
//! ```
//!
//! Examples: `pool:gfx`, `pool=gfx refs>5`, `pool:gfx AND (refs>=3 OR -tmp)`,
//! `size:1024..4096`, `*:hot` (any key contains "hot"), `refs` (key present).

use crate::json::{unescape, Scan};

#[derive(Debug)]
pub enum Expr {
    And(Box<Expr>, Box<Expr>),
    Or(Box<Expr>, Box<Expr>),
    Not(Box<Expr>),
    Clause(Clause),
}

#[derive(Debug)]
pub struct Clause {
    /// Metadata key to test, ASCII-lowercased. Empty or `"*"` = any key.
    key: String,
    test: Test,
}

#[derive(Debug)]
pub enum Test {
    Present,
    Contains(String), // needle, pre-lowercased
    Equals(String),   // pre-lowercased
    Num(NumOp, f64),
    Range(f64, f64), // inclusive
}

#[derive(Debug, Clone, Copy)]
pub enum NumOp {
    Gt,
    Ge,
    Lt,
    Le,
}

/// A source of an allocation's queryable `(key, value)` fields. Kept as a trait
/// so a query can run against either a parsed `extra` fragment (a slice of
/// pairs) or an event's built-in columns (`size`, `site`, `thr`, …) without
/// materializing them — see `render::EventFields`.
pub trait Fields {
    /// Invoke `f` on each `(key, value)`; stop and return `true` as soon as `f`
    /// does. Values are the display strings; numeric tests re-parse them.
    fn any(&self, f: &mut dyn FnMut(&str, &str) -> bool) -> bool;
}

impl Fields for Vec<(String, String)> {
    fn any(&self, f: &mut dyn FnMut(&str, &str) -> bool) -> bool {
        self.iter().any(|(k, v)| f(k, v))
    }
}

impl Expr {
    /// Evaluate against an allocation's fields.
    pub fn eval(&self, fields: &dyn Fields) -> bool {
        match self {
            Expr::And(a, b) => a.eval(fields) && b.eval(fields),
            Expr::Or(a, b) => a.eval(fields) || b.eval(fields),
            Expr::Not(e) => !e.eval(fields),
            Expr::Clause(c) => c.matches(fields),
        }
    }
}

impl Clause {
    fn matches(&self, fields: &dyn Fields) -> bool {
        let any_key = self.key.is_empty() || self.key == "*";
        fields.any(&mut |k, v| {
            (any_key || k.eq_ignore_ascii_case(&self.key)) && self.test.matches(v)
        })
    }
}

impl Test {
    fn matches(&self, v: &str) -> bool {
        match self {
            Test::Present => true,
            Test::Contains(n) => v.to_ascii_lowercase().contains(n.as_str()),
            Test::Equals(n) => v.eq_ignore_ascii_case(n),
            Test::Num(op, n) => match v.trim().parse::<f64>() {
                Ok(x) => match op {
                    NumOp::Gt => x > *n,
                    NumOp::Ge => x >= *n,
                    NumOp::Lt => x < *n,
                    NumOp::Le => x <= *n,
                },
                Err(_) => false,
            },
            Test::Range(a, b) => matches!(v.trim().parse::<f64>(), Ok(x) if x >= *a && x <= *b),
        }
    }
}

/// Split a fragment (`"k":v,"k2":v2`, brace-less object body from
/// `Store::extras`) into `(key, display-value)` pairs. String values are
/// unquoted/unescaped; every other JSON value is kept as its raw source text.
pub fn fields(frag: &[u8]) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut sc = Scan::new(frag);
    loop {
        sc.ws();
        if sc.peek() != b'"' {
            break;
        }
        let (ks, ke) = match sc.string_span() {
            Some(x) => x,
            None => break,
        };
        if !sc.eat(b':') {
            break;
        }
        let (vs, ve) = match sc.skip_value() {
            Some(x) => x,
            None => break,
        };
        let key = unescape(&sc.b[ks..ke]);
        let vraw = &sc.b[vs..ve];
        let val = if vraw.len() >= 2 && vraw[0] == b'"' && vraw[vraw.len() - 1] == b'"' {
            unescape(&vraw[1..vraw.len() - 1])
        } else {
            String::from_utf8_lossy(vraw).into_owned()
        };
        out.push((key, val));
        sc.ws();
        if sc.peek() == b',' {
            sc.i += 1;
        } else {
            break;
        }
    }
    out
}

/// Parse a query string. Empty / all-whitespace input is `Ok(None)` (no
/// filter). A syntax error is `Err(message)`.
pub fn parse(src: &str) -> Result<Option<Expr>, String> {
    let mut p = QParser {
        c: src.chars().collect(),
        i: 0,
    };
    p.ws();
    if p.eof() {
        return Ok(None);
    }
    let e = p.parse_or()?;
    p.ws();
    if !p.eof() {
        return Err(format!("unexpected `{}`", p.rest()));
    }
    Ok(Some(e))
}

struct QParser {
    c: Vec<char>,
    i: usize,
}

impl QParser {
    fn eof(&self) -> bool {
        self.i >= self.c.len()
    }
    fn peek(&self) -> char {
        *self.c.get(self.i).unwrap_or(&'\0')
    }
    fn peek2(&self) -> char {
        *self.c.get(self.i + 1).unwrap_or(&'\0')
    }
    fn ws(&mut self) {
        while !self.eof() && self.peek().is_whitespace() {
            self.i += 1;
        }
    }
    fn rest(&self) -> String {
        self.c[self.i..].iter().collect::<String>().trim().to_string()
    }

    /// Case-insensitively check for a keyword as a standalone word at the
    /// cursor (followed by whitespace, `(`, or end), without consuming it.
    fn looking_at_kw(&self, kw: &str) -> bool {
        let n = kw.chars().count();
        for (j, kc) in kw.chars().enumerate() {
            match self.c.get(self.i + j) {
                Some(c) if c.eq_ignore_ascii_case(&kc) => {}
                _ => return false,
            }
        }
        match self.c.get(self.i + n) {
            None => true,
            Some(c) => c.is_whitespace() || *c == '(' || *c == '!',
        }
    }

    fn looking_at_or(&self) -> bool {
        self.peek() == '|' || self.looking_at_kw("or")
    }

    fn parse_or(&mut self) -> Result<Expr, String> {
        let mut left = self.parse_and()?;
        loop {
            self.ws();
            if !self.looking_at_or() {
                break;
            }
            // consume `|`, `||`, or `OR`
            if self.peek() == '|' {
                self.i += 1;
                if self.peek() == '|' {
                    self.i += 1;
                }
            } else {
                self.i += 2; // "or"
            }
            let right = self.parse_and()?;
            left = Expr::Or(Box::new(left), Box::new(right));
        }
        Ok(left)
    }

    fn parse_and(&mut self) -> Result<Expr, String> {
        let mut left = self.parse_not()?;
        loop {
            self.ws();
            if self.eof() || self.peek() == ')' || self.looking_at_or() {
                break;
            }
            // optional explicit AND (`&`, `&&`, `AND`); otherwise implicit
            if self.peek() == '&' {
                self.i += 1;
                if self.peek() == '&' {
                    self.i += 1;
                }
            } else if self.looking_at_kw("and") {
                self.i += 3;
            }
            let right = self.parse_not()?;
            left = Expr::And(Box::new(left), Box::new(right));
        }
        Ok(left)
    }

    fn parse_not(&mut self) -> Result<Expr, String> {
        self.ws();
        if self.peek() == '!' || self.peek() == '-' || self.looking_at_kw("not") {
            if self.peek() == '!' || self.peek() == '-' {
                self.i += 1;
            } else {
                self.i += 3; // "not"
            }
            let inner = self.parse_not()?;
            return Ok(Expr::Not(Box::new(inner)));
        }
        self.parse_primary()
    }

    fn parse_primary(&mut self) -> Result<Expr, String> {
        self.ws();
        if self.peek() == '(' {
            self.i += 1;
            let e = self.parse_or()?;
            self.ws();
            if self.peek() != ')' {
                return Err("missing `)`".to_string());
            }
            self.i += 1;
            return Ok(e);
        }
        self.parse_clause()
    }

    fn parse_clause(&mut self) -> Result<Expr, String> {
        self.ws();
        let key = self.read_key();
        self.ws();
        let op = self.read_op();
        let test = match op {
            None => {
                // a bare term must name a key (present-test); nothing to match on
                if key.is_empty() {
                    if self.eof() {
                        return Err("expected a term".to_string());
                    }
                    return Err(format!("unexpected `{}`", self.peek()));
                }
                Test::Present
            }
            Some(op) => {
                self.ws();
                let val = self.read_value();
                if val.is_empty() {
                    return Err(format!("expected a value after `{}`", op));
                }
                build_test(op, &val)?
            }
        };
        Ok(Expr::Clause(Clause {
            key: key.to_ascii_lowercase(),
            test,
        }))
    }

    fn read_key(&mut self) -> String {
        let mut s = String::new();
        while !self.eof() {
            let c = self.peek();
            if c.is_alphanumeric() || c == '_' || c == '.' || c == '*' {
                s.push(c);
                self.i += 1;
            } else {
                break;
            }
        }
        s
    }

    /// Read a comparison operator token, if one is at the cursor.
    fn read_op(&mut self) -> Option<&'static str> {
        let (c, d) = (self.peek(), self.peek2());
        let two = match (c, d) {
            ('>', '=') => Some(">="),
            ('<', '=') => Some("<="),
            _ => None,
        };
        if let Some(op) = two {
            self.i += 2;
            return Some(op);
        }
        let one = match c {
            ':' => Some(":"),
            '~' => Some("~"),
            '=' => Some("="),
            '>' => Some(">"),
            '<' => Some("<"),
            _ => None,
        };
        if one.is_some() {
            self.i += 1;
        }
        one
    }

    fn read_value(&mut self) -> String {
        if self.peek() == '"' {
            self.i += 1;
            let mut s = String::new();
            while !self.eof() && self.peek() != '"' {
                if self.peek() == '\\' && self.i + 1 < self.c.len() {
                    self.i += 1;
                }
                s.push(self.peek());
                self.i += 1;
            }
            if self.peek() == '"' {
                self.i += 1;
            }
            return s;
        }
        // bareword: up to whitespace or a closing paren
        let mut s = String::new();
        while !self.eof() {
            let c = self.peek();
            if c.is_whitespace() || c == ')' {
                break;
            }
            s.push(c);
            self.i += 1;
        }
        s
    }
}

fn build_test(op: &str, val: &str) -> Result<Test, String> {
    match op {
        ":" | "~" => {
            if let Some((a, b)) = val.split_once("..") {
                if let (Ok(a), Ok(b)) = (a.trim().parse::<f64>(), b.trim().parse::<f64>()) {
                    return Ok(Test::Range(a.min(b), a.max(b)));
                }
            }
            Ok(Test::Contains(val.to_ascii_lowercase()))
        }
        "=" => Ok(Test::Equals(val.to_ascii_lowercase())),
        ">" | ">=" | "<" | "<=" => {
            let n = val
                .trim()
                .parse::<f64>()
                .map_err(|_| format!("`{}` needs a number, got `{}`", op, val))?;
            let nop = match op {
                ">" => NumOp::Gt,
                ">=" => NumOp::Ge,
                "<" => NumOp::Lt,
                _ => NumOp::Le,
            };
            Ok(Test::Num(nop, n))
        }
        _ => Err(format!("unknown operator `{}`", op)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(q: &str, frag: &str) -> bool {
        let e = parse(q).unwrap().unwrap();
        e.eval(&fields(frag.as_bytes()))
    }

    #[test]
    fn contains_exact_present() {
        let f = r#""pool":"gfx","refs":3,"name":"texture_atlas""#;
        assert!(ev("pool:gfx", f));
        assert!(ev("pool:GF", f)); // case-insensitive substring
        assert!(!ev("pool:net", f));
        assert!(ev("pool=gfx", f));
        assert!(!ev("pool=gf", f)); // exact
        assert!(ev("refs", f)); // key present
        assert!(!ev("missing", f));
        assert!(ev("name:atlas", f));
    }

    #[test]
    fn numeric_and_ranges() {
        let f = r#""refs":7,"size":2048"#;
        assert!(ev("refs>5", f));
        assert!(!ev("refs>7", f));
        assert!(ev("refs>=7", f));
        assert!(ev("refs<10", f));
        assert!(ev("size:1024..4096", f));
        assert!(!ev("size:1..1000", f));
    }

    #[test]
    fn any_key_wildcard() {
        let f = r#""pool":"gfx","tag":"hotpath""#;
        assert!(ev("*:hot", f));
        assert!(ev(":gfx", f)); // empty key = any
        assert!(!ev("*:cold", f));
    }

    #[test]
    fn boolean_logic_and_grouping() {
        let f = r#""pool":"gfx","refs":7"#;
        assert!(ev("pool:gfx refs>5", f)); // implicit AND
        assert!(ev("pool:gfx AND refs>5", f));
        assert!(!ev("pool:gfx refs>9", f));
        assert!(ev("pool:net OR refs>5", f));
        assert!(ev("pool:gfx AND (refs>9 OR refs<9)", f));
        assert!(ev("-pool:net", f)); // NOT
        assert!(ev("NOT pool:net", f));
        assert!(!ev("!pool:gfx", f));
    }

    #[test]
    fn errors_reported() {
        assert!(parse("refs>").is_err());
        assert!(parse("refs>abc").is_err());
        assert!(parse("(pool:gfx").is_err());
        assert!(parse("pool:gfx )").is_err());
        assert_eq!(parse("   ").unwrap().is_none(), true);
    }
}
