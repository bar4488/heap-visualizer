use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

pub const VERSION: u8 = 1;
pub const MAX_TAGS: usize = 255;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Document {
    pub version: u8,
    pub revision: u64,
    #[serde(default)]
    pub allocations: BTreeMap<u32, Allocation>,
    #[serde(default)]
    pub tags: BTreeMap<String, Tag>,
    #[serde(default)]
    pub bookmarks: BTreeMap<String, Bookmark>,
    #[serde(default)]
    pub address_marks: BTreeMap<String, AddressMark>,
    #[serde(default)]
    pub saved_filters: BTreeMap<String, SavedFilter>,
}

impl Default for Document {
    fn default() -> Self {
        Self {
            version: VERSION,
            revision: 0,
            allocations: BTreeMap::new(),
            tags: BTreeMap::new(),
            bookmarks: BTreeMap::new(),
            address_marks: BTreeMap::new(),
            saved_filters: BTreeMap::new(),
        }
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Allocation {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(default, skip_serializing_if = "BTreeSet::is_empty")]
    pub tags: BTreeSet<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Tag { pub name: String, pub color: String }

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Bookmark { pub name: String, pub seq: u32, pub t: f64 }

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct AddressMark { pub name: String, pub addr: String }

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SavedFilter { pub name: String, pub source: String }

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum Change {
    SetAllocationName { creator: u32, name: Option<String> },
    SetAllocationColor { creator: u32, color: Option<String> },
    SetAllocationTag { creator: u32, tag_id: String, present: bool },
    ReplaceAllocationTags { creator: u32, tag_ids: BTreeSet<String> },
    ReplaceTagMembers { tag_id: String, creators: BTreeSet<u32> },
    PutTag { id: String, name: String, color: String },
    DeleteTag { id: String },
    PutBookmark { id: String, name: String, seq: u32, t: f64 },
    DeleteBookmark { id: String },
    PutAddressMark { id: String, name: String, addr: String },
    DeleteAddressMark { id: String },
    PutSavedFilter { id: String, name: String, source: String },
    DeleteSavedFilter { id: String },
}

#[derive(Clone, Debug, PartialEq)]
pub enum ApplyError { Conflict, Invalid(&'static str) }

impl Document {
    pub fn validate<F>(&self, event_count: u32, creator: F) -> Result<(), ApplyError>
    where F: Fn(u32) -> bool {
        if self.version != VERSION || self.tags.len() > MAX_TAGS { return Err(ApplyError::Invalid("unsupported analysis document")); }
        for (id, tag) in &self.tags { let mut c = Change::PutTag { id: id.clone(), name: tag.name.clone(), color: tag.color.clone() }; normalize(&mut c)?; }
        for (&event, value) in &self.allocations {
            require_creator(event, &creator)?;
            if let Some(name) = &value.name { let mut c = Change::SetAllocationName { creator: event, name: Some(name.clone()) }; normalize(&mut c)?; }
            if let Some(color) = &value.color { let mut c = Change::SetAllocationColor { creator: event, color: Some(color.clone()) }; normalize(&mut c)?; }
            if value.tags.iter().any(|id| !self.tags.contains_key(id)) { return Err(ApplyError::Invalid("unknown tag")); }
        }
        for (id, value) in &self.bookmarks { let mut c = Change::PutBookmark { id: id.clone(), name: value.name.clone(), seq: value.seq, t: value.t }; normalize(&mut c)?; if value.seq > event_count { return Err(ApplyError::Invalid("invalid bookmark")); } }
        for (id, value) in &self.address_marks { let mut c = Change::PutAddressMark { id: id.clone(), name: value.name.clone(), addr: value.addr.clone() }; normalize(&mut c)?; }
        for (id, value) in &self.saved_filters { let mut c = Change::PutSavedFilter { id: id.clone(), name: value.name.clone(), source: value.source.clone() }; normalize(&mut c)?; }
        Ok(())
    }

    pub fn apply<F>(&mut self, expected: u64, event_count: u32, mut change: Change, creator: F) -> Result<Change, ApplyError>
    where F: Fn(u32) -> bool {
        if expected != self.revision { return Err(ApplyError::Conflict); }
        normalize(&mut change)?;
        match &change {
            Change::SetAllocationName { creator: e, name } => {
                require_creator(*e, &creator)?;
                let entry = self.allocations.entry(*e).or_default(); entry.name = name.clone();
                self.prune(*e);
            }
            Change::SetAllocationColor { creator: e, color } => {
                require_creator(*e, &creator)?;
                let entry = self.allocations.entry(*e).or_default(); entry.color = color.clone();
                self.prune(*e);
            }
            Change::SetAllocationTag { creator: e, tag_id, present } => {
                require_creator(*e, &creator)?;
                if !self.tags.contains_key(tag_id) { return Err(ApplyError::Invalid("unknown tag")); }
                let entry = self.allocations.entry(*e).or_default();
                if *present { entry.tags.insert(tag_id.clone()); } else { entry.tags.remove(tag_id); }
                self.prune(*e);
            }
            Change::ReplaceAllocationTags { creator: e, tag_ids } => {
                require_creator(*e, &creator)?;
                if tag_ids.iter().any(|id| !self.tags.contains_key(id)) { return Err(ApplyError::Invalid("unknown tag")); }
                self.allocations.entry(*e).or_default().tags = tag_ids.clone();
                self.prune(*e);
            }
            Change::ReplaceTagMembers { tag_id, creators } => {
                if !self.tags.contains_key(tag_id) { return Err(ApplyError::Invalid("unknown tag")); }
                if creators.iter().any(|&event| !creator(event)) { return Err(ApplyError::Invalid("allocation not found")); }
                for value in self.allocations.values_mut() { value.tags.remove(tag_id); }
                for &event in creators { self.allocations.entry(event).or_default().tags.insert(tag_id.clone()); }
                self.allocations.retain(|_, value| value != &Allocation::default());
            }
            Change::PutTag { id, name, color } => {
                if !self.tags.contains_key(id) && self.tags.len() >= MAX_TAGS { return Err(ApplyError::Invalid("too many tags")); }
                self.tags.insert(id.clone(), Tag { name: name.clone(), color: color.clone() });
            }
            Change::DeleteTag { id } => {
                self.tags.remove(id); for value in self.allocations.values_mut() { value.tags.remove(id); }
                self.allocations.retain(|_, value| value != &Allocation::default());
            }
            Change::PutBookmark { id, name, seq, t } => {
                if *seq > event_count { return Err(ApplyError::Invalid("invalid bookmark")); }
                self.bookmarks.insert(id.clone(), Bookmark { name: name.clone(), seq: *seq, t: *t });
            }
            Change::DeleteBookmark { id } => { self.bookmarks.remove(id); }
            Change::PutAddressMark { id, name, addr } => {
                self.address_marks.insert(id.clone(), AddressMark { name: name.clone(), addr: addr.clone() });
            }
            Change::DeleteAddressMark { id } => { self.address_marks.remove(id); }
            Change::PutSavedFilter { id, name, source } => {
                self.saved_filters.insert(id.clone(), SavedFilter { name: name.clone(), source: source.clone() });
            }
            Change::DeleteSavedFilter { id } => { self.saved_filters.remove(id); }
        }
        self.revision += 1;
        Ok(change)
    }

    fn prune(&mut self, creator: u32) {
        if self.allocations.get(&creator) == Some(&Allocation::default()) { self.allocations.remove(&creator); }
    }
}

fn require_creator<F: Fn(u32) -> bool>(e: u32, creator: &F) -> Result<(), ApplyError> {
    if creator(e) { Ok(()) } else { Err(ApplyError::Invalid("allocation not found")) }
}

fn normalize(change: &mut Change) -> Result<(), ApplyError> {
    use Change::*;
    let clean_id = |id: &mut String| -> Result<(), ApplyError> {
        *id = id.trim().to_owned();
        if id.is_empty() || id.len() > 64 || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_') {
            return Err(ApplyError::Invalid("invalid persistent id"));
        }
        Ok(())
    };
    let clean_name = |name: &mut String| -> Result<(), ApplyError> {
        *name = name.trim().to_owned();
        if name.is_empty() || name.len() > 256 { Err(ApplyError::Invalid("invalid name")) } else { Ok(()) }
    };
    match change {
        SetAllocationName { name: Some(name), .. } => clean_name(name)?,
        SetAllocationColor { color: Some(color), .. } => clean_color(color)?,
        SetAllocationTag { tag_id, .. } => clean_id(tag_id)?,
        ReplaceAllocationTags { tag_ids, .. } => {
            let mut clean = BTreeSet::new();
            for mut id in std::mem::take(tag_ids) { clean_id(&mut id)?; clean.insert(id); }
            *tag_ids = clean;
        }
        ReplaceTagMembers { tag_id, .. } => clean_id(tag_id)?,
        PutTag { id, name, color } => { clean_id(id)?; clean_name(name)?; clean_color(color)?; }
        DeleteTag { id } | DeleteBookmark { id } | DeleteAddressMark { id } | DeleteSavedFilter { id } => clean_id(id)?,
        PutBookmark { id, name, t, .. } => { clean_id(id)?; clean_name(name)?; if !t.is_finite() { return Err(ApplyError::Invalid("invalid time")); } }
        PutAddressMark { id, name, addr } => { clean_id(id)?; clean_name(name)?; *addr = normalize_addr(addr)?; }
        PutSavedFilter { id, name, source } => { clean_id(id)?; clean_name(name)?; if source.len() > 16 << 10 { return Err(ApplyError::Invalid("filter is too large")); } }
        SetAllocationName { name: None, .. } | SetAllocationColor { color: None, .. } => {}
    }
    Ok(())
}

fn clean_color(color: &mut String) -> Result<(), ApplyError> {
    *color = color.to_ascii_lowercase();
    if color.len() == 7 && color.starts_with('#') && color[1..].bytes().all(|b| b.is_ascii_hexdigit()) { Ok(()) } else { Err(ApplyError::Invalid("invalid color")) }
}

fn normalize_addr(addr: &str) -> Result<String, ApplyError> {
    let text = addr.trim().strip_prefix("0x").or_else(|| addr.trim().strip_prefix("0X")).ok_or(ApplyError::Invalid("invalid address"))?;
    let value = u64::from_str_radix(text, 16).map_err(|_| ApplyError::Invalid("invalid address"))?;
    Ok(format!("0x{value:x}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn apply(document: &mut Document, change: Change) -> Result<Change, ApplyError> {
        document.apply(document.revision, 10, change, |creator| creator == 2)
    }

    #[test]
    fn every_analysis_kind_uses_one_revisioned_change_path() {
        let mut document = Document::default();
        apply(&mut document, Change::PutTag { id: " leak ".into(), name: " Leaking ".into(), color: "#AABBCC".into() }).unwrap();
        apply(&mut document, Change::SetAllocationTag { creator: 2, tag_id: "leak".into(), present: true }).unwrap();
        apply(&mut document, Change::SetAllocationName { creator: 2, name: Some(" owner ".into()) }).unwrap();
        apply(&mut document, Change::SetAllocationColor { creator: 2, color: Some("#ABCDEF".into()) }).unwrap();
        apply(&mut document, Change::PutBookmark { id: "b1".into(), name: " stop ".into(), seq: 10, t: 4.0 }).unwrap();
        apply(&mut document, Change::PutAddressMark { id: "a1".into(), name: " ptr ".into(), addr: "0X000A".into() }).unwrap();
        apply(&mut document, Change::PutSavedFilter { id: "f1".into(), name: " big ".into(), source: "alloc.size > 10".into() }).unwrap();
        assert_eq!(document.revision, 7);
        assert_eq!(document.tags["leak"].color, "#aabbcc");
        assert_eq!(document.allocations[&2].name.as_deref(), Some("owner"));
        assert_eq!(document.address_marks["a1"].addr, "0xa");
        assert_eq!(serde_json::from_str::<Document>(&serde_json::to_string(&document).unwrap()).unwrap(), document);
    }

    #[test]
    fn conflict_and_invalid_changes_leave_the_document_untouched() {
        let mut document = Document::default();
        let original = document.clone();
        assert_eq!(document.apply(1, 10, Change::DeleteTag { id: "x".into() }, |_| true), Err(ApplyError::Conflict));
        assert_eq!(document, original);
        assert!(apply(&mut document, Change::SetAllocationName { creator: 9, name: Some("x".into()) }).is_err());
        assert_eq!(document, original);
    }

    #[test]
    fn deleting_a_tag_removes_membership_atomically() {
        let mut document = Document::default();
        apply(&mut document, Change::PutTag { id: "x".into(), name: "X".into(), color: "#112233".into() }).unwrap();
        apply(&mut document, Change::SetAllocationTag { creator: 2, tag_id: "x".into(), present: true }).unwrap();
        apply(&mut document, Change::DeleteTag { id: "x".into() }).unwrap();
        assert!(document.tags.is_empty());
        assert!(document.allocations.is_empty());
    }
}
