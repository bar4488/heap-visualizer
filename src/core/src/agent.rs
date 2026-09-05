use std::cmp::Reverse;
use std::collections::{BTreeMap, BTreeSet};

use serde::Serialize;
use serde_json::{json, Value};

use crate::analysis::{ApplyError, Change};
use crate::filter_eval::{self, Ctx, FieldValues};
use crate::filter_plan;
use crate::store::{warn_code_name, Store, NONE_U16, NONE_U32, OP_E, OP_F, OP_M, OP_R};
use crate::{project_analysis, App};

#[derive(Clone, Debug, Serialize)]
pub struct Error {
    pub message: String,
    pub start: usize,
    pub end: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagQueryResult {
    pub revision: u64,
    pub matched: usize,
    pub changed: usize,
}

#[derive(Debug)]
pub enum TagQueryError {
    Conflict,
    Invalid(&'static str),
    Filter(Error),
}

fn matches(app: &App, source: &str) -> Result<Vec<u64>, Error> {
    let creators = || {
        let mut bits = vec![0_u64; (app.store.len() as usize).div_ceil(64)];
        for event in 0..app.store.len() {
            if matches!(app.store.op[event as usize], OP_M | OP_R) {
                bits[event as usize / 64] |= 1_u64 << (event % 64);
            }
        }
        bits
    };
    if source.trim().is_empty() {
        return Ok(creators());
    }
    let expr = heap_visualizer_filter_dsl::parse(source).map_err(|error| Error {
        message: error.message,
        start: error.span.start,
        end: error.span.end,
    })?;
    let base = Ctx::new(&app.store, &app.tag_labels, &app.names);
    filter_eval::check(&expr, &base).map_err(|error| Error {
        message: error.message,
        start: error.span.start,
        end: error.span.end,
    })?;
    let fields = FieldValues::resolve(&expr, &app.store);
    let context = base.with_fields(&fields);
    let plan = filter_plan::lower(&expr, &context).map_err(|error| Error {
        message: error.message,
        start: error.span.start,
        end: error.span.end,
    })?;
    let mut bits = vec![0_u64; (app.store.len() as usize).div_ceil(64)];
    filter_plan::scan(&plan, &context, &mut bits);
    Ok(bits)
}

fn bit(bits: &[u64], event: u32) -> bool {
    bits.get(event as usize / 64)
        .is_some_and(|word| word & (1_u64 << (event % 64)) != 0)
}

fn creators<'a>(store: &'a Store, bits: &'a [u64]) -> impl Iterator<Item = u32> + 'a {
    (0..store.len()).filter(|&event| bit(bits, event))
}

fn op_name(op: u8) -> &'static str {
    match op {
        OP_M => "malloc",
        OP_F => "free",
        OP_R => "realloc",
        OP_E => "event",
        _ => "unknown",
    }
}

fn tag_values(app: &App, creator: u32) -> Vec<Value> {
    app.analysis
        .allocations
        .get(&creator)
        .map(|allocation| {
            allocation
                .tags
                .iter()
                .filter_map(|id| {
                    app.analysis
                        .tags
                        .get(id)
                        .map(|tag| json!({ "id": id, "name": tag.name, "color": tag.color }))
                })
                .collect()
        })
        .unwrap_or_default()
}

fn compact(app: &App, creator: u32) -> Value {
    let store = &app.store;
    let i = creator as usize;
    let death = store.death[i];
    let analysis = app.analysis.allocations.get(&creator);
    json!({
        "creator": creator,
        "id": store.id[i].to_string(),
        "address": format!("0x{:x}", store.addr[i]),
        "size": store.size[i].to_string(),
        "usable": (store.usable_at(creator) != 0).then(|| store.usable_at(creator).to_string()),
        "birth": { "seq": creator, "time": store.t[i].to_string() },
        "death": (death != NONE_U32).then(|| json!({ "seq": death, "time": store.t[death as usize].to_string() })),
        "lifetime": (death != NONE_U32).then(|| (store.t[death as usize] - store.t[i]).to_string()),
        "site": (store.site[i] != NONE_U32).then(|| store.sites[store.site[i] as usize].clone()),
        "thread": (store.thr_idx[i] != NONE_U16).then(|| store.thrs[store.thr_idx[i] as usize].to_string()),
        "name": analysis.and_then(|value| value.name.clone()),
        "color": analysis.and_then(|value| value.color.clone()),
        "tags": tag_values(app, creator),
    })
}

pub(crate) fn allocation(app: &App, creator: u32) -> Option<Value> {
    if creator >= app.store.len() || !matches!(app.store.op[creator as usize], OP_M | OP_R) {
        return None;
    }
    let store = &app.store;
    let i = creator as usize;
    let death = store.death[i];
    let mut value = compact(app, creator);
    let object = value.as_object_mut().unwrap();
    object.insert("operation".into(), json!(op_name(store.op[i])));
    object.insert(
        "end".into(),
        json!(format!(
            "0x{:x}",
            store.addr[i].saturating_add(store.size[i])
        )),
    );
    object.insert(
        "stack".into(),
        if store.stack_at(creator) == NONE_U32 {
            Value::Null
        } else {
            json!(store.stacks[store.stack_at(creator) as usize])
        },
    );
    object.insert("fields".into(), extra(store, creator));
    object.insert(
        "deathFields".into(),
        if death == NONE_U32 {
            Value::Null
        } else {
            extra(store, death)
        },
    );
    let from = if store.op[i] == OP_R && store.target[i] != NONE_U32 {
        Some(store.target[i])
    } else {
        None
    };
    let to = (death != NONE_U32 && store.op[death as usize] == OP_R).then_some(death);
    object.insert(
        "relations".into(),
        json!({ "reallocatedFrom": from, "reallocatedTo": to }),
    );
    object.insert("creatorEvent".into(), json!({
        "seq": creator, "time": store.t[i].to_string(), "operation": op_name(store.op[i]),
        "site": (store.site[i] != NONE_U32).then(|| store.sites[store.site[i] as usize].clone()),
        "thread": (store.thr_idx[i] != NONE_U16).then(|| store.thrs[store.thr_idx[i] as usize].to_string()),
        "stack": (store.stack_at(creator) != NONE_U32).then(|| store.stacks[store.stack_at(creator) as usize].clone()),
        "fields": extra(store, creator),
    }));
    object.insert(
        "deathEvent".into(),
        if death == NONE_U32 {
            Value::Null
        } else {
            json!({
                "seq": death, "time": store.t[death as usize].to_string(),
                "operation": op_name(store.op[death as usize]), "fields": extra(store, death),
            })
        },
    );
    Some(value)
}

fn extra(store: &Store, event: u32) -> Value {
    if store.extra_at(event) == NONE_U32 {
        Value::Null
    } else {
        serde_json::from_str(&format!(
            "{{{}}}",
            store.extras[store.extra_at(event) as usize]
        ))
        .unwrap_or(Value::Null)
    }
}

pub(crate) fn check_filter(app: &App, source: &str) -> Result<(), Error> {
    if source.trim().is_empty() {
        return Ok(());
    }
    let expr = heap_visualizer_filter_dsl::parse(source).map_err(|error| Error {
        message: error.message,
        start: error.span.start,
        end: error.span.end,
    })?;
    let base = Ctx::new(&app.store, &app.tag_labels, &app.names);
    filter_eval::check(&expr, &base).map_err(|error| Error {
        message: error.message,
        start: error.span.start,
        end: error.span.end,
    })?;
    let fields = FieldValues::resolve(&expr, &app.store);
    filter_plan::lower(&expr, &base.with_fields(&fields)).map_err(|error| Error {
        message: error.message,
        start: error.span.start,
        end: error.span.end,
    })?;
    Ok(())
}

pub(crate) fn query(
    app: &App,
    source: &str,
    order: &str,
    from: usize,
    limit: usize,
) -> Result<Value, Error> {
    let bits = matches(app, source)?;
    let mut found: Vec<u32> = creators(&app.store, &bits).collect();
    match order {
        "creator-asc" => {}
        "birth-desc" => found.sort_unstable_by_key(|event| Reverse(*event)),
        "size-desc" => {
            found.sort_unstable_by_key(|event| (Reverse(app.store.size[*event as usize]), *event))
        }
        "lifetime-desc" => {
            found.sort_unstable_by_key(|event| (Reverse(lifetime(&app.store, *event)), *event))
        }
        "death-desc" => found.sort_unstable_by_key(|event| {
            let death = app.store.death[*event as usize];
            (
                death == NONE_U32,
                Reverse(if death == NONE_U32 { 0 } else { death }),
                *event,
            )
        }),
        _ => {
            return Err(Error {
                message: "unsupported allocation ordering".into(),
                start: 0,
                end: 0,
            })
        }
    }
    let total = found.len();
    let end = from.saturating_add(limit).min(total);
    let items = if from <= total {
        found[from..end]
            .iter()
            .map(|&event| compact(app, event))
            .collect()
    } else {
        Vec::new()
    };
    let requested: u128 = found
        .iter()
        .map(|&event| app.store.size[event as usize] as u128)
        .sum();
    let usable: u128 = found
        .iter()
        .map(|&event| app.store.usable_at(event) as u128)
        .sum();
    let usable_known = found
        .iter()
        .filter(|&&event| app.store.usable_at(event) != 0)
        .count();
    Ok(json!({
        "matched": { "allocations": total, "requestedBytes": requested.to_string(), "usableBytes": usable.to_string(), "usableKnownAllocations": usable_known },
        "from": from, "count": end.saturating_sub(from), "next": (end < total).then_some(end), "items": items
    }))
}

fn lifetime(store: &Store, creator: u32) -> u64 {
    let death = store.death[creator as usize];
    if death == NONE_U32 {
        u64::MAX
    } else {
        store.t[death as usize] - store.t[creator as usize]
    }
}

#[derive(Default)]
struct Aggregate {
    allocations: u64,
    requested: u128,
    usable: u128,
    usable_known: u64,
    freed: u64,
    live: u64,
}

fn bucket(value: u64) -> String {
    if value == 0 {
        return "0".into();
    }
    let low = 1_u64 << (63 - value.leading_zeros());
    let high = low.saturating_mul(2);
    format!("{}..{}", low, high)
}

pub(crate) fn summarize(
    app: &App,
    source: &str,
    group_by: &str,
    limit: usize,
) -> Result<Value, Error> {
    let bits = matches(app, source)?;
    let selected: Vec<u32> = creators(&app.store, &bits).collect();
    let mut groups: BTreeMap<String, Aggregate> = BTreeMap::new();
    for &event in &selected {
        let i = event as usize;
        let keys: Vec<String> = match group_by {
            "site" => vec![if app.store.site[i] != NONE_U32 {
                app.store.sites[app.store.site[i] as usize].clone()
            } else {
                "(none)".into()
            }],
            "thread" => vec![if app.store.thr_idx[i] != NONE_U16 {
                app.store.thrs[app.store.thr_idx[i] as usize].to_string()
            } else {
                "(none)".into()
            }],
            "freed" => vec![if app.store.death[i] != NONE_U32 {
                "freed".into()
            } else {
                "live-at-end".into()
            }],
            "size-bucket" => vec![bucket(app.store.size[i])],
            "lifetime-bucket" => vec![if app.store.death[i] == NONE_U32 {
                "live-at-end".into()
            } else {
                bucket(lifetime(&app.store, event))
            }],
            "tag" => {
                let tags: Vec<String> = app
                    .analysis
                    .allocations
                    .get(&event)
                    .map(|value| value.tags.iter().cloned().collect())
                    .unwrap_or_default();
                if tags.is_empty() {
                    vec!["(untagged)".into()]
                } else {
                    tags
                }
            }
            _ => {
                return Err(Error {
                    message: "unsupported summary grouping".into(),
                    start: 0,
                    end: 0,
                })
            }
        };
        for key in keys {
            let group = groups.entry(key).or_default();
            group.allocations += 1;
            group.requested += app.store.size[i] as u128;
            group.usable += app.store.usable_at(event) as u128;
            group.usable_known += u64::from(app.store.usable_at(event) != 0);
            if app.store.death[i] == NONE_U32 {
                group.live += 1;
            } else {
                group.freed += 1;
            }
        }
    }
    let mut groups: Vec<_> = groups.into_iter().collect();
    groups.sort_by(|(left_key, left), (right_key, right)| {
        right
            .requested
            .cmp(&left.requested)
            .then_with(|| right.allocations.cmp(&left.allocations))
            .then_with(|| left_key.cmp(right_key))
    });
    let omitted = groups.len().saturating_sub(limit);
    groups.truncate(limit);
    let rows: Vec<_> = groups.into_iter().map(|(key, group)| {
        let label = if group_by == "tag" {
            app.analysis.tags.get(&key).map(|tag| tag.name.clone()).unwrap_or_else(|| key.clone())
        } else { key.clone() };
        json!({
            "key": key, "label": label, "allocations": group.allocations,
            "requestedBytes": group.requested.to_string(), "usableBytes": group.usable.to_string(),
            "usableKnownAllocations": group.usable_known, "freed": group.freed, "liveAtEnd": group.live
        })
    }).collect();
    let requested: u128 = selected
        .iter()
        .map(|&event| app.store.size[event as usize] as u128)
        .sum();
    Ok(
        json!({ "matched": { "allocations": selected.len(), "requestedBytes": requested.to_string() }, "groups": rows, "groupsOmitted": omitted }),
    )
}

pub(crate) fn overview(app: &App, top: usize) -> Value {
    let store = &app.store;
    let mut live_bytes = 0_u128;
    let mut live_count = 0_u64;
    let mut current = 0_u128;
    let mut peak = (0_u128, 0_u32);
    for event in 0..store.len() {
        let i = event as usize;
        if matches!(store.op[i], OP_F | OP_R) && store.target[i] != NONE_U32 {
            current = current.saturating_sub(store.size[store.target[i] as usize] as u128);
        }
        if matches!(store.op[i], OP_M | OP_R) {
            current += store.size[i] as u128;
        }
        if current > peak.0 {
            peak = (current, event + 1);
        }
    }
    for event in 0..store.len() {
        if matches!(store.op[event as usize], OP_M | OP_R)
            && store.death[event as usize] == NONE_U32
        {
            live_count += 1;
            live_bytes += store.size[event as usize] as u128;
        }
    }
    let mut site_bytes = vec![0_u128; store.sites.len()];
    for event in 0..store.len() {
        if matches!(store.op[event as usize], OP_M | OP_R) && store.site[event as usize] != NONE_U32
        {
            site_bytes[store.site[event as usize] as usize] += store.size[event as usize] as u128;
        }
    }
    let mut sites: Vec<_> = store
        .sites
        .iter()
        .enumerate()
        .map(|(i, name)| (name, store.site_count[i], site_bytes[i]))
        .collect();
    sites.sort_by(
        |(left_name, left_count, left_bytes), (right_name, right_count, right_bytes)| {
            right_bytes
                .cmp(left_bytes)
                .then_with(|| right_count.cmp(left_count))
                .then_with(|| left_name.cmp(right_name))
        },
    );
    let omitted = sites.len().saturating_sub(top);
    sites.truncate(top);
    let top_sites: Vec<_> = sites.into_iter().map(|(site, allocations, bytes)| json!({ "site": site, "allocations": allocations, "requestedBytes": bytes.to_string() })).collect();
    let warnings: BTreeMap<_, _> = store
        .warn_counts
        .iter()
        .enumerate()
        .filter(|(_, count)| **count > 0)
        .map(|(code, count)| (warn_code_name(code as u8), *count))
        .collect();
    json!({
        "trace": {
            "title": store.title, "events": store.len(), "time": { "min": store.t_min.to_string(), "max": store.t_max.to_string(), "unit": store.unit },
            "allocations": store.creator_count(), "frees": store.n_free, "reallocations": store.n_realloc, "customEvents": store.n_custom,
            "liveAtEnd": { "count": live_count, "bytes": live_bytes.to_string() },
            "peakLive": { "bytes": peak.0.to_string(), "eventsApplied": peak.1, "time": store.t.get(peak.1.saturating_sub(1) as usize).copied().unwrap_or(0).to_string() },
            "totalAllocatedBytes": store.total_alloc_bytes.to_string()
        },
        "warnings": { "total": store.warn_counts.iter().sum::<u32>(), "byCode": warnings },
        "analysis": { "namedAllocations": app.analysis.allocations.values().filter(|v| v.name.is_some()).count(), "tags": app.analysis.tags.len(), "bookmarks": app.analysis.bookmarks.len(), "addressMarks": app.analysis.address_marks.len(), "savedFilters": app.analysis.saved_filters.len() },
        "topSites": top_sites, "topSitesOmitted": omitted
    })
}

pub(crate) fn timeline(
    app: &App,
    source: &str,
    domain: &str,
    from: u64,
    to: u64,
    bins: usize,
) -> Result<Value, Error> {
    let bits = matches(app, source)?;
    let width = to.saturating_sub(from).max(1);
    let mut rows = vec![(0_u64, 0_u64, 0_u64, 0_u64, 0_u128, 0_u128); bins];
    for event in 0..app.store.len() {
        let i = event as usize;
        let coordinate = if domain == "time" {
            app.store.t[i]
        } else {
            event as u64
        };
        if coordinate < from || coordinate >= to {
            continue;
        }
        let bin = ((coordinate - from) as u128 * bins as u128 / width as u128) as usize;
        let row = &mut rows[bin.min(bins - 1)];
        match app.store.op[i] {
            OP_M if bit(&bits, event) => {
                row.0 += 1;
                row.4 += app.store.size[i] as u128;
            }
            OP_F if app.store.target[i] != NONE_U32 && bit(&bits, app.store.target[i]) => {
                row.1 += 1;
                row.5 += app.store.size[app.store.target[i] as usize] as u128;
            }
            OP_R => {
                let old = app.store.target[i];
                let old_matches = old != NONE_U32 && bit(&bits, old);
                let new_matches = bit(&bits, event);
                if old_matches || new_matches {
                    row.2 += 1;
                }
                if new_matches {
                    row.4 += app.store.size[i] as u128;
                }
                if old_matches {
                    row.5 += app.store.size[old as usize] as u128;
                }
            }
            OP_E => row.3 += 1,
            _ => {}
        }
    }
    let rows: Vec<_> = rows.into_iter().enumerate().map(|(index, row)| {
        let lo = from + ((width as u128 * index as u128) / bins as u128) as u64;
        let hi = from + ((width as u128 * (index + 1) as u128) / bins as u128) as u64;
        let (lo, hi) = if domain == "time" { (json!(lo.to_string()), json!(hi.to_string())) } else { (json!(lo), json!(hi)) };
        json!({ "from": lo, "to": hi, "allocations": row.0, "frees": row.1, "reallocations": row.2, "customEvents": row.3, "allocatedBytes": row.4.to_string(), "freedBytes": row.5.to_string(), "netLiveBytes": (row.4 as i128 - row.5 as i128).to_string() })
    }).collect();
    let range = if domain == "time" {
        json!({ "from": from.to_string(), "to": to.to_string() })
    } else {
        json!({ "from": from, "to": to })
    };
    Ok(json!({ "domain": domain, "range": range, "bins": rows }))
}

fn event_value(app: &App, event: u32) -> Value {
    let store = &app.store;
    let i = event as usize;
    if store.op[i] == OP_E {
        return json!({ "seq": event, "time": store.t[i].to_string(), "operation": "event", "title": (store.label_at(event) != NONE_U32).then(|| store.ev_labels[store.label_at(event) as usize].clone()) });
    }
    let creator = if store.op[i] == OP_F {
        store.target[i]
    } else {
        event
    };
    json!({
        "seq": event, "time": store.t[i].to_string(), "operation": op_name(store.op[i]),
        "creator": (creator != NONE_U32).then_some(creator),
        "replaces": (store.op[i] == OP_R && store.target[i] != NONE_U32).then_some(store.target[i]),
        "id": store.id[i].to_string(),
        "size": (creator != NONE_U32).then(|| store.size[creator as usize].to_string()),
        "site": (creator != NONE_U32 && store.site[creator as usize] != NONE_U32).then(|| store.sites[store.site[creator as usize] as usize].clone())
    })
}

pub(crate) fn stream_context(
    app: &App,
    source: &str,
    center: u32,
    before: u32,
    after: u32,
    landmarks: bool,
) -> Result<Value, Error> {
    let bits = matches(app, source)?;
    let from = center.saturating_sub(before);
    let to = center
        .saturating_add(after)
        .saturating_add(1)
        .min(app.store.len());
    let events: Vec<_> = (from..to)
        .filter(|&event| {
            if app.store.op[event as usize] == OP_E {
                return landmarks;
            }
            let i = event as usize;
            let creator = if app.store.op[i] == OP_F {
                app.store.target[i]
            } else {
                event
            };
            (creator != NONE_U32 && bit(&bits, creator))
                || (app.store.op[i] == OP_R
                    && app.store.target[i] != NONE_U32
                    && bit(&bits, app.store.target[i]))
        })
        .map(|event| event_value(app, event))
        .collect();
    Ok(json!({ "range": { "from": from, "to": to }, "events": events }))
}

pub(crate) fn apply_tag_query(
    app: &mut App,
    expected: u64,
    tag_id: &str,
    source: &str,
    operation: &str,
) -> Result<TagQueryResult, TagQueryError> {
    if expected != app.analysis.revision {
        return Err(TagQueryError::Conflict);
    }
    if !app.analysis.tags.contains_key(tag_id) {
        return Err(TagQueryError::Invalid("unknown tag"));
    }
    let bits = matches(app, source).map_err(TagQueryError::Filter)?;
    let matched: BTreeSet<u32> = creators(&app.store, &bits).collect();
    let previous: BTreeSet<u32> = app
        .analysis
        .allocations
        .iter()
        .filter(|(_, value)| value.tags.contains(tag_id))
        .map(|(&event, _)| event)
        .collect();
    let next = match operation {
        "add" => previous.union(&matched).copied().collect(),
        "remove" => previous.difference(&matched).copied().collect(),
        "replace" => matched.clone(),
        _ => return Err(TagQueryError::Invalid("unsupported tag-query operation")),
    };
    let changed = previous.symmetric_difference(&next).count();
    app.analysis
        .apply(
            expected,
            app.store.len(),
            Change::ReplaceTagMembers {
                tag_id: tag_id.into(),
                creators: next,
            },
            |event| matches!(app.store.op.get(event as usize), Some(&OP_M) | Some(&OP_R)),
        )
        .map_err(|error| match error {
            ApplyError::Conflict => TagQueryError::Conflict,
            ApplyError::Invalid(message) => TagQueryError::Invalid(message),
        })?;
    project_analysis(app);
    Ok(TagQueryResult {
        revision: app.analysis.revision,
        matched: matched.len(),
        changed,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Engine;

    fn engine() -> Engine {
        let mut engine = Engine::new();
        engine.parse_begin();
        engine.parse_chunk(br#"{"op":"H","title":"agent fixture"}
{"op":"M","id":1,"addr":"0x1000","size":64,"t":10,"site":"small","thr":1}
{"op":"M","id":2,"addr":"0x2000","size":128,"usable":160,"t":20,"site":"large","thr":2,"pool":"requests"}
{"op":"F","id":1,"t":30,"reason":"done"}
{"op":"E","t":40,"title":"phase: sweep"}
"#);
        engine.parse_end();
        engine
    }

    #[test]
    fn overview_query_summary_timeline_and_context_are_compact_semantic_reads() {
        let engine = engine();
        let overview = engine.agent_overview(1);
        assert_eq!(overview["trace"]["events"], 4);
        assert_eq!(overview["trace"]["liveAtEnd"]["count"], 1);
        assert_eq!(overview["topSites"].as_array().unwrap().len(), 1);

        let query = engine
            .agent_query("alloc.size >= 64", "size-desc", 0, 1)
            .unwrap();
        assert_eq!(query["matched"]["allocations"], 2);
        assert_eq!(query["items"][0]["creator"], 1);
        assert!(query["items"][0].get("fields").is_none());
        assert_eq!(query["next"], 1);

        let detail = engine.agent_allocation(1).unwrap();
        assert_eq!(detail["fields"]["pool"], "requests");
        assert_eq!(detail["operation"], "malloc");

        let summary = engine.agent_summarize("", "site", 10).unwrap();
        assert_eq!(summary["groups"].as_array().unwrap().len(), 2);

        let timeline = engine.agent_timeline("", "sequence", 0, 4, 2).unwrap();
        assert_eq!(timeline["bins"].as_array().unwrap().len(), 2);
        assert_eq!(timeline["bins"][1]["customEvents"], 1);

        let context = engine
            .agent_stream_context("alloc.size >= 100", 1, 1, 2, true)
            .unwrap();
        assert_eq!(context["events"].as_array().unwrap().len(), 2);
        assert_eq!(context["events"][1]["operation"], "event");
    }

    #[test]
    fn tag_query_uses_the_filter_plan_and_one_canonical_revision() {
        let mut engine = engine();
        engine
            .apply_analysis(
                0,
                Change::PutTag {
                    id: "large".into(),
                    name: "Large".into(),
                    color: "#112233".into(),
                },
            )
            .unwrap();
        let result = engine
            .apply_tag_query(1, "large", "alloc.size >= 100", "replace")
            .unwrap();
        assert_eq!(result.revision, 2);
        assert_eq!(result.matched, 1);
        assert_eq!(
            engine.analysis().allocations[&1].tags,
            BTreeSet::from(["large".into()])
        );
    }

    #[test]
    fn a_filtered_realloc_accounts_for_old_and_new_allocations_independently() {
        let mut engine = Engine::new();
        engine.parse_begin();
        engine.parse_chunk(
            br#"{"op":"M","id":1,"addr":"0x1000","size":64,"t":0}
{"op":"R","id":2,"old_id":1,"addr":"0x2000","size":128,"t":1}
"#,
        );
        engine.parse_end();

        let old = engine
            .agent_timeline("alloc.size == 64", "sequence", 0, 2, 2)
            .unwrap();
        assert_eq!(old["bins"][1]["reallocations"], 1);
        assert_eq!(old["bins"][1]["allocatedBytes"], "0");
        assert_eq!(old["bins"][1]["freedBytes"], "64");

        let new = engine
            .agent_timeline("alloc.size == 128", "sequence", 0, 2, 2)
            .unwrap();
        assert_eq!(new["bins"][1]["reallocations"], 1);
        assert_eq!(new["bins"][1]["allocatedBytes"], "128");
        assert_eq!(new["bins"][1]["freedBytes"], "0");
    }
}
