use std::{
    borrow::Cow,
    collections::VecDeque,
    fs::File,
    io::{self, Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use axum::{
    body::{Body, Bytes},
    extract::{DefaultBodyLimit, Path as AxumPath, Request, State},
    http::{header, HeaderMap, HeaderName, HeaderValue, StatusCode, Uri},
    middleware::{self, Next},
    response::Response,
    routing::{get, post},
    Router,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use heap_visualizer_core::{agent, domain};
use tokio::sync::watch;
use tokio_util::io::ReaderStream;
use url::Url;

const REQUEST_PRIVATE_NETWORK: HeaderName =
    HeaderName::from_static("access-control-request-private-network");
const ALLOW_PRIVATE_NETWORK: HeaderName =
    HeaderName::from_static("access-control-allow-private-network");

// Transport limits. Handlers enforce these constants and `/api/v1/session`
// advertises the same constants, so the two cannot drift apart.
/// Request-body limit for every route except analysis changes.
const MAX_REQUEST_BYTES: usize = 32 << 10;
/// A connected browser commits full `replaceTagMembers` creator lists through
/// `/api/v1/analysis/changes`; about 11 bytes per creator admits ~3M members.
const MAX_ANALYSIS_CHANGE_BYTES: usize = 32 << 20;
const MAX_FILTER_BYTES: usize = 16 << 10;
const DEFAULT_AGENT_PAGE: u32 = 20;
/// Compact allocation queries and the filter-schema custom-field catalog.
const MAX_AGENT_PAGE: u32 = 100;
/// `/events`, `/warnings` and `/query`.
const MAX_PAGE: u32 = 200;
const DEFAULT_GROUPS: u32 = 20;
const MAX_GROUPS: u32 = 50;
const DEFAULT_TIMELINE_BINS: u32 = 50;
const MAX_TIMELINE_BINS: u32 = 200;
const MAX_CONTEXT_EVENTS: u32 = 100;
const DEFAULT_OVERVIEW_TOP: u32 = 10;
const MAX_OVERVIEW_TOP: u32 = 50;
const MAX_REQUEST_ID_BYTES: usize = 64;
const MAX_CHANGE_HISTORY: usize = 512;
const MAX_CHANGE_PAGE: usize = 200;
/// A `replaceTagMembers` with more creators than this is journaled (and kept
/// for idempotent replay) as a snapshot reset, like a tag query, instead of
/// verbatim. At ~11 JSON bytes per creator one entry stays under ~11 KiB, so
/// the whole journal stays near 5 MiB and a full `/changes` page near 2 MiB,
/// rather than 512 x 32 MiB bodies. Larger replacements are bulk edits where
/// re-reading the document is no worse than replaying the delta.
const MAX_JOURNALED_TAG_MEMBERS: usize = 1024;
const MAX_CHANGE_WAIT_SECS: u64 = 30;
const MAX_AGENT_RESPONSE_BYTES: usize = 256 << 10;

#[derive(Clone)]
pub struct ServerState {
    token: Arc<str>,
    port: u16,
    trace: TraceFile,
    engine: Arc<Mutex<heap_visualizer_core::Engine>>,
    metadata: Arc<serde_json::Value>,
    fields: Arc<serde_json::Value>,
    warnings: Arc<Vec<serde_json::Value>>,
    analysis_path: Option<Arc<PathBuf>>,
    changes: Arc<Mutex<VecDeque<ChangeLogEntry>>>,
    revision_tx: watch::Sender<u64>,
    idempotency: Arc<Mutex<VecDeque<IdempotentResult>>>,
}

impl ServerState {
    pub fn new(
        token: String,
        port: u16,
        trace: TraceFile,
        mut engine: heap_visualizer_core::Engine,
    ) -> Self {
        let metadata = serde_json::from_str(&engine.metadata_json())
            .expect("the core produces valid metadata JSON");
        let fields = serde_json::from_str(&engine.fields_json())
            .expect("the core produces valid field JSON");
        let warnings = serde_json::from_str(&engine.warnings_json())
            .expect("the core produces valid warning JSON");
        let revision = engine.analysis().revision;
        let (revision_tx, _) = watch::channel(revision);
        Self {
            token: token.into(),
            port,
            trace,
            engine: Arc::new(Mutex::new(engine)),
            metadata: Arc::new(metadata),
            fields: Arc::new(fields),
            warnings: Arc::new(warnings),
            analysis_path: None,
            changes: Arc::new(Mutex::new(VecDeque::new())),
            revision_tx,
            idempotency: Arc::new(Mutex::new(VecDeque::new())),
        }
    }

    pub fn persistent(
        token: String,
        port: u16,
        trace: TraceFile,
        mut engine: heap_visualizer_core::Engine,
        data_dir: impl AsRef<Path>,
    ) -> io::Result<Self> {
        let directory = data_dir.as_ref().join("analysis");
        std::fs::create_dir_all(&directory)?;
        let digest = trace.id.strip_prefix("sha256:").unwrap_or(&trace.id);
        let path = directory.join(format!("{digest}.json"));
        if path.exists() {
            let bytes = std::fs::read(&path)?;
            let document = serde_json::from_slice(&bytes)
                .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
            engine.replace_analysis(document).map_err(|_| {
                io::Error::new(io::ErrorKind::InvalidData, "analysis does not match trace")
            })?;
        }
        let mut state = Self::new(token, port, trace, engine);
        state.analysis_path = Some(Arc::new(path));
        Ok(state)
    }
}

#[derive(Clone)]
pub struct TraceFile {
    snapshot: Arc<tempfile::NamedTempFile>,
    id: Arc<str>,
    name: Arc<str>,
    len: u64,
}

impl TraceFile {
    pub fn open(path: impl AsRef<Path>) -> io::Result<Self> {
        let path = path.as_ref().canonicalize()?;
        let mut file = File::open(&path)?;
        let mut snapshot = tempfile::NamedTempFile::new()?;
        let mut hash = Sha256::new();
        let mut chunk = vec![0_u8; 8 << 20];
        let mut len = 0_u64;
        loop {
            let read = file.read(&mut chunk)?;
            if read == 0 {
                break;
            }
            hash.update(&chunk[..read]);
            snapshot.write_all(&chunk[..read])?;
            len += read as u64;
        }
        snapshot.as_file().sync_all()?;
        let id = format!("sha256:{:x}", hash.finalize());
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("trace.heapl")
            .to_owned();
        Ok(Self {
            snapshot: Arc::new(snapshot),
            id: id.into(),
            name: name.into(),
            len,
        })
    }

    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn parse_engine(&self) -> io::Result<heap_visualizer_core::Engine> {
        let mut file = self.snapshot.reopen()?;
        let mut engine = heap_visualizer_core::Engine::new();
        let mut chunk = vec![0_u8; 8 << 20];
        engine.parse_begin();
        loop {
            let read = file.read(&mut chunk)?;
            if read == 0 {
                break;
            }
            engine.parse_chunk(&chunk[..read]);
        }
        engine.parse_end();
        Ok(engine)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionResponse<'a> {
    api_version: u8,
    mode: &'a str,
    server_version: &'a str,
    trace: TraceResponse<'a>,
    metadata: serde_json::Value,
    analysis_revision: u64,
    capabilities: serde_json::Value,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TraceResponse<'a> {
    id: &'a str,
    name: &'a str,
    bytes: u64,
    url: &'a str,
}

#[derive(Serialize)]
struct ErrorResponse<'a> {
    error: ErrorDetail<'a>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ErrorDetail<'a> {
    code: &'a str,
    message: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    current_revision: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MetadataResponse<'a> {
    trace_id: &'a str,
    metadata: &'a serde_json::Value,
    fields: &'a serde_json::Value,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PageResponse<'a> {
    trace_id: &'a str,
    from: u32,
    count: usize,
    total: u32,
    next: Option<u32>,
    items: &'a [serde_json::Value],
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WarningPageResponse<'a> {
    trace_id: &'a str,
    from: u32,
    count: usize,
    retained: u32,
    observed: u32,
    omitted: u32,
    next: Option<u32>,
    items: &'a [serde_json::Value],
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct QueryRequest {
    trace_id: String,
    source: String,
    from: u32,
    count: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FilterInput {
    source: Option<String>,
    saved_filter_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FilterCheckRequest {
    trace_id: String,
    source: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AgentQueryRequest {
    trace_id: String,
    filter: Option<FilterInput>,
    #[serde(default = "default_order")]
    order_by: String,
    #[serde(default = "default_agent_limit")]
    limit: u32,
    cursor: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SummarizeRequest {
    trace_id: String,
    filter: Option<FilterInput>,
    group_by: String,
    #[serde(default = "default_group_limit")]
    limit: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TimelineRequest {
    trace_id: String,
    filter: Option<FilterInput>,
    domain: String,
    range: NumericRange,
    #[serde(default = "default_timeline_bins")]
    bins: u32,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct NumericRange {
    from: NumericBound,
    to: NumericBound,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum NumericBound {
    Number(u64),
    Decimal(String),
}

impl NumericBound {
    fn value(&self) -> Option<u64> {
        match self {
            Self::Number(value) => Some(*value),
            Self::Decimal(value) => value.parse().ok(),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StreamContextRequest {
    trace_id: String,
    filter: Option<FilterInput>,
    center: u32,
    #[serde(default = "default_context_side")]
    before: u32,
    #[serde(default = "default_context_side")]
    after: u32,
    #[serde(default = "default_true")]
    include_landmarks: bool,
    #[serde(default)]
    include_logs: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TagQueryRequest {
    trace_id: String,
    expected_revision: u64,
    tag_id: String,
    filter: FilterInput,
    operation: String,
    request_id: Option<String>,
}

fn default_order() -> String {
    "creator-asc".into()
}
fn default_agent_limit() -> u32 {
    DEFAULT_AGENT_PAGE
}
fn default_group_limit() -> u32 {
    DEFAULT_GROUPS
}
fn default_timeline_bins() -> u32 {
    DEFAULT_TIMELINE_BINS
}
fn default_context_side() -> u32 {
    10
}
fn default_true() -> bool {
    true
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AnalysisChangeRequest {
    trace_id: String,
    expected_revision: u64,
    request_id: Option<String>,
    change: heap_visualizer_core::analysis::Change,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AnalysisResponse<'a> {
    trace_id: &'a str,
    document: &'a heap_visualizer_core::analysis::Document,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CommittedChange {
    revision: u64,
    change: heap_visualizer_core::analysis::Change,
}

#[derive(Clone)]
struct ChangeLogEntry {
    revision: u64,
    change: Option<heap_visualizer_core::analysis::Change>,
}

#[derive(Clone)]
struct IdempotentResult {
    request_id: String,
    digest: [u8; 32],
    response: serde_json::Value,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ChangesResponse<'a> {
    trace_id: &'a str,
    revision: u64,
    reset: bool,
    changes: Vec<CommittedChange>,
}

pub fn router(state: ServerState) -> Router {
    Router::new()
        .route("/api/v1/session", get(session).options(preflight))
        .route("/api/v1/trace", get(trace).options(preflight))
        .route("/api/v1/metadata", get(metadata).options(preflight))
        .route("/api/v1/warnings", get(warnings).options(preflight))
        .route("/api/v1/events", get(events).options(preflight))
        .route(
            "/api/v1/allocations/{creator}",
            get(allocation).options(preflight),
        )
        .route("/api/v1/query", post(query).options(preflight))
        .route(
            "/api/v1/filter/schema",
            get(filter_schema).options(preflight),
        )
        .route(
            "/api/v1/filter/check",
            post(filter_check).options(preflight),
        )
        .route("/api/v1/overview", get(overview).options(preflight))
        .route("/api/v1/logs", get(logs).options(preflight))
        .route("/api/v1/domains", get(domains).options(preflight))
        .route(
            "/api/v1/domains/{domain}/records",
            get(domain_records).options(preflight),
        )
        .route(
            "/api/v1/allocations/query",
            post(agent_query).options(preflight),
        )
        .route(
            "/api/v1/allocations/summarize",
            post(summarize).options(preflight),
        )
        .route("/api/v1/timeline", post(agent_timeline).options(preflight))
        .route(
            "/api/v1/stream/context",
            post(stream_context).options(preflight),
        )
        .route(
            "/api/v1/analysis/tag-query",
            post(tag_query).options(preflight),
        )
        .route("/api/v1/analysis", get(analysis).options(preflight))
        .route(
            "/api/v1/analysis/summary",
            get(analysis_summary).options(preflight),
        )
        .route(
            "/api/v1/analysis/changes",
            post(change_analysis)
                .layer(DefaultBodyLimit::max(MAX_ANALYSIS_CHANGE_BYTES))
                .options(preflight),
        )
        .route("/api/v1/changes", get(changes).options(preflight))
        .fallback(not_found)
        .layer(DefaultBodyLimit::max(MAX_REQUEST_BYTES))
        .layer(middleware::from_fn_with_state(state.clone(), error_cors))
        .with_state(state)
}

/// Gives responses generated outside the handlers (body-limit rejections,
/// method mismatches, the fallback) the same JSON error shape and CORS
/// treatment as handler errors: an allowed Host plus a syntactically valid
/// Origin is reflected. Handler responses already carry it and pass through.
async fn error_cors(State(state): State<ServerState>, request: Request, next: Next) -> Response {
    let origin = if host_allowed(request.headers(), state.port) {
        browser_origin(request.headers()).ok().flatten()
    } else {
        None
    };
    let response = next.run(request).await;
    let framework_error = match response.status() {
        StatusCode::PAYLOAD_TOO_LARGE
            if response.headers().get(header::CONTENT_TYPE)
                != Some(&HeaderValue::from_static("application/json; charset=utf-8")) =>
        {
            Some(("request_too_large", "request body exceeds this route's limit"))
        }
        StatusCode::METHOD_NOT_ALLOWED => Some(("method_not_allowed", "method not allowed")),
        _ => None,
    };
    let mut response = match framework_error {
        Some((code, message)) => {
            let allow = response.headers().get(header::ALLOW).cloned();
            let mut replaced = json(
                response.status(),
                &ErrorResponse {
                    error: ErrorDetail {
                        code,
                        message,
                        current_revision: None,
                    },
                },
                None,
            );
            if let Some(allow) = allow {
                replaced.headers_mut().insert(header::ALLOW, allow);
            }
            replaced
        }
        None => response,
    };
    if !response
        .headers()
        .contains_key(header::ACCESS_CONTROL_ALLOW_ORIGIN)
    {
        add_cors(response.headers_mut(), origin);
    }
    response
}

pub fn fresh_token() -> Result<String, getrandom::Error> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes)?;
    let mut token = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write;
        write!(&mut token, "{byte:02x}").expect("writing to a String cannot fail");
    }
    Ok(token)
}

pub fn connection_string(api_url: &str, token: &str) -> String {
    format!("{api_url}#{token}")
}

async fn session(State(state): State<ServerState>, headers: HeaderMap) -> Response {
    let origin = match authorize(&headers, &state) {
        Ok(origin) => origin,
        Err(error) => return error.response(),
    };
    let analysis_revision = state
        .engine
        .lock()
        .expect("engine lock poisoned")
        .analysis()
        .revision;
    bounded_json(
        &SessionResponse {
            api_version: 1,
            mode: "local",
            server_version: env!("CARGO_PKG_VERSION"),
            trace: TraceResponse {
                id: &state.trace.id,
                name: &state.trace.name,
                bytes: state.trace.len,
                url: "/api/v1/trace",
            },
            metadata: compact_session_metadata(&state.metadata),
            analysis_revision,
            capabilities: serde_json::json!({
                "endpoints": {
                    "overview": "/api/v1/overview",
                    "logs": "/api/v1/logs",
                    "domains": "/api/v1/domains",
                    "domainRecords": "/api/v1/domains/{domain}/records",
                    "allocation": "/api/v1/allocations/{creator}",
                    "allocationQuery": "/api/v1/allocations/query",
                    "allocationSummary": "/api/v1/allocations/summarize",
                    "timeline": "/api/v1/timeline",
                    "streamContext": "/api/v1/stream/context",
                    "filterSchema": "/api/v1/filter/schema",
                    "filterCheck": "/api/v1/filter/check",
                    "analysis": "/api/v1/analysis",
                    "analysisSummary": "/api/v1/analysis/summary",
                    "analysisChanges": "/api/v1/analysis/changes",
                    "bulkTagging": "/api/v1/analysis/tag-query",
                    "changeFeed": "/api/v1/changes"
                },
                "limits": limits(),
                "timelineDomains": ["sequence", "time"],
                "allocationOrderings": ["creator-asc", "birth-desc", "size-desc", "lifetime-desc", "death-desc"],
                "summaryGroups": ["site", "thread", "freed", "size-bucket", "lifetime-bucket", "tag"],
                "tagQueryOperations": ["add", "remove", "replace"]
            }),
        }, origin,
    )
}

/// Every transport limit, read from the constants the handlers enforce.
fn limits() -> serde_json::Value {
    serde_json::json!({
        "defaultPage": DEFAULT_AGENT_PAGE,
        "maximumPage": MAX_AGENT_PAGE,
        "maximumListPage": MAX_PAGE,
        "defaultGroups": DEFAULT_GROUPS,
        "maximumGroups": MAX_GROUPS,
        "defaultTimelineBins": DEFAULT_TIMELINE_BINS,
        "maximumTimelineBins": MAX_TIMELINE_BINS,
        "maximumContextEvents": MAX_CONTEXT_EVENTS,
        "defaultOverviewTop": DEFAULT_OVERVIEW_TOP,
        "maximumOverviewTop": MAX_OVERVIEW_TOP,
        "defaultLogPage": agent::LOGS_COUNT_DEFAULT,
        "maximumLogPage": agent::LOGS_COUNT_MAX,
        "maximumLogTextBytes": agent::LOGS_TEXT_MAX,
        "defaultRecordPage": domain::RECORDS_COUNT_DEFAULT,
        "maximumRecordPage": domain::RECORDS_COUNT_MAX,
        "maximumFilterBytes": MAX_FILTER_BYTES,
        "maximumRequestIdBytes": MAX_REQUEST_ID_BYTES,
        "maximumRequestBytes": MAX_REQUEST_BYTES,
        "maximumAnalysisChangeBytes": MAX_ANALYSIS_CHANGE_BYTES,
        "maximumChangePage": MAX_CHANGE_PAGE,
        "maximumChangeWaitSeconds": MAX_CHANGE_WAIT_SECS,
        "changeHistory": MAX_CHANGE_HISTORY,
        "maximumJournaledTagMembers": MAX_JOURNALED_TAG_MEMBERS,
        "maximumAgentResponseBytes": MAX_AGENT_RESPONSE_BYTES
    })
}

async fn metadata(State(state): State<ServerState>, headers: HeaderMap) -> Response {
    let origin = match authorize(&headers, &state) {
        Ok(origin) => origin,
        Err(error) => return error.response(),
    };
    bounded_json(
        &MetadataResponse {
            trace_id: &state.trace.id,
            metadata: &state.metadata,
            fields: &state.fields,
        },
        origin,
    )
}

async fn warnings(State(state): State<ServerState>, headers: HeaderMap, uri: Uri) -> Response {
    let origin = match authorize(&headers, &state) {
        Ok(origin) => origin,
        Err(error) => return error.response(),
    };
    let retained = state.warnings.len() as u32;
    let observed = state.metadata["warnTotal"]
        .as_u64()
        .unwrap_or(retained as u64) as u32;
    let (from, count) = match page(uri.query(), retained, origin.clone()) {
        Ok(page) => page,
        Err(error) => return error.response(),
    };
    let hi = from.saturating_add(count).min(retained);
    let items = &state.warnings[from as usize..hi as usize];
    bounded_json(
        &WarningPageResponse {
            trace_id: &state.trace.id,
            from,
            count: items.len(),
            retained,
            observed,
            omitted: observed.saturating_sub(retained),
            next: (hi < retained).then_some(hi),
            items,
        },
        origin,
    )
}

async fn events(State(state): State<ServerState>, headers: HeaderMap, uri: Uri) -> Response {
    let origin = match authorize(&headers, &state) {
        Ok(origin) => origin,
        Err(error) => return error.response(),
    };
    let total = state.engine.lock().expect("engine lock poisoned").len();
    let (from, count) = match page(uri.query(), total, origin.clone()) {
        Ok(page) => page,
        Err(error) => return error.response(),
    };
    let encoded = state
        .engine
        .lock()
        .expect("engine lock poisoned")
        .events_json(from, count);
    let items: Vec<serde_json::Value> =
        serde_json::from_str(&encoded).expect("the core produces valid event JSON");
    let hi = from + items.len() as u32;
    bounded_json(
        &PageResponse {
            trace_id: &state.trace.id,
            from,
            count: items.len(),
            total,
            next: (hi < total).then_some(hi),
            items: &items,
        },
        origin,
    )
}

async fn allocation(
    State(state): State<ServerState>,
    headers: HeaderMap,
    AxumPath(creator): AxumPath<String>,
) -> Response {
    let origin = match authorize(&headers, &state) {
        Ok(origin) => origin,
        Err(error) => return error.response(),
    };
    let Ok(creator) = creator.parse::<u32>() else {
        return request_error(StatusCode::BAD_REQUEST, "creator must be a u32", origin).response();
    };
    let engine = state.engine.lock().expect("engine lock poisoned");
    let Some(allocation) = engine.agent_allocation(creator) else {
        return request_error(StatusCode::NOT_FOUND, "allocation not found", origin).response();
    };
    bounded_json(
        &serde_json::json!({
            "traceId": state.trace.id.as_ref(),
            "analysisRevision": engine.analysis().revision,
            "allocation": allocation,
        }),
        origin,
    )
}

async fn overview(State(state): State<ServerState>, headers: HeaderMap, uri: Uri) -> Response {
    let origin = match authorize(&headers, &state) {
        Ok(origin) => origin,
        Err(error) => return error.response(),
    };
    let top = match single_u32_query(
        uri.query(),
        "top",
        DEFAULT_OVERVIEW_TOP,
        MAX_OVERVIEW_TOP,
        origin.clone(),
    ) {
        Ok(value) => value,
        Err(error) => return error.response(),
    };
    let engine = state.engine.lock().expect("engine lock poisoned");
    let mut value = engine.agent_overview(top as usize);
    envelope(&mut value, &state, engine.analysis().revision);
    bounded_json(&value, origin)
}

/// `GET /api/v1/domains` (DOM-004): every evidence domain's descriptor, as
/// the core's registry reports it.
async fn domains(State(state): State<ServerState>, headers: HeaderMap) -> Response {
    let origin = match authorize(&headers, &state) {
        Ok(origin) => origin,
        Err(error) => return error.response(),
    };
    let encoded = state
        .engine
        .lock()
        .expect("engine lock poisoned")
        .domains_json();
    let domains: serde_json::Value =
        serde_json::from_str(&encoded).expect("the core produces valid domain JSON");
    bounded_json(
        &serde_json::json!({ "traceId": state.trace.id.as_ref(), "domains": domains }),
        origin,
    )
}

/// `GET /api/v1/domains/{domain}/records` (LOG-008, DOM-004): one bounded
/// page of a domain's records.
async fn domain_records(
    State(state): State<ServerState>,
    headers: HeaderMap,
    AxumPath(name): AxumPath<String>,
    uri: Uri,
) -> Response {
    records(&state, &headers, &name, uri.query(), true)
}

/// `GET /api/v1/logs` (LOG-008): the log domain's records page, without the
/// generic page's `domain` key.
async fn logs(State(state): State<ServerState>, headers: HeaderMap, uri: Uri) -> Response {
    records(&state, &headers, "logs", uri.query(), false)
}

/// One records page. The transport parses the shared paging keys strictly
/// (repeated keys and non-numbers are rejected) and passes every other key
/// to the core, which owns the domain's parameters (D011). Record reads do
/// not depend on the analysis, so the envelope carries `traceId` only.
fn records(
    state: &ServerState,
    headers: &HeaderMap,
    name: &str,
    query: Option<&str>,
    with_domain: bool,
) -> Response {
    let origin = match authorize(headers, state) {
        Ok(origin) => origin,
        Err(error) => return error.response(),
    };
    if domain::by_name(name).is_none() {
        return RequestError {
            status: StatusCode::NOT_FOUND,
            error: format!("unknown domain {name}").into(),
            code: "unknown_domain",
            origin,
        }
        .response();
    }
    let params = match records_query(query, origin.clone()) {
        Ok(params) => params,
        Err(error) => return error.response(),
    };
    let result = state
        .engine
        .lock()
        .expect("engine lock poisoned")
        .agent_domain_records(name, &params);
    let mut value = match result {
        Ok(value) => value,
        Err(error) => {
            return request_error(StatusCode::BAD_REQUEST, error.message, origin).response()
        }
    };
    let object = value
        .as_object_mut()
        .expect("agent core response is an object");
    if !with_domain {
        object.remove("domain");
    }
    object.insert("traceId".into(), state.trace.id.to_string().into());
    bounded_json(&value, origin)
}

fn records_query(
    query: Option<&str>,
    origin: Option<HeaderValue>,
) -> Result<domain::RecordParams, RequestError> {
    let invalid = || {
        request_error(
            StatusCode::BAD_REQUEST,
            "invalid query parameters",
            origin.clone(),
        )
    };
    let mut params = domain::RecordParams::default();
    let mut seen = Vec::new();
    for (key, value) in url::form_urlencoded::parse(query.unwrap_or_default().as_bytes()) {
        if seen.contains(&key) {
            return Err(invalid());
        }
        match key.as_ref() {
            "seqLo" => params.seq_lo = Some(value.parse().map_err(|_| invalid())?),
            "seqHi" => params.seq_hi = Some(value.parse().map_err(|_| invalid())?),
            "from" => params.from = value.parse().map_err(|_| invalid())?,
            "count" => params.count = Some(value.parse().map_err(|_| invalid())?),
            _ => {
                params
                    .params
                    .insert(key.clone().into_owned(), value.into_owned());
            }
        }
        seen.push(key);
    }
    Ok(params)
}

async fn filter_schema(State(state): State<ServerState>, headers: HeaderMap, uri: Uri) -> Response {
    let origin = match authorize(&headers, &state) {
        Ok(origin) => origin,
        Err(error) => return error.response(),
    };
    let (from, count) = match optional_page(uri.query(), origin.clone()) {
        Ok(page) => page,
        Err(error) => return error.response(),
    };
    let engine = state.engine.lock().expect("engine lock poisoned");
    let total = state.fields.as_array().map_or(0, Vec::len);
    if from as usize > total {
        return request_error(
            StatusCode::BAD_REQUEST,
            "filter schema cursor is out of range",
            origin,
        )
        .response();
    }
    let mut value = engine.agent_filter_schema(from as usize, count as usize);
    envelope(&mut value, &state, engine.analysis().revision);
    bounded_json(&value, origin)
}

async fn filter_check(
    State(state): State<ServerState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let origin = match authorize(&headers, &state) {
        Ok(origin) => origin,
        Err(error) => return error.response(),
    };
    let request: FilterCheckRequest = match decode(&body, origin.clone(), "invalid filter check") {
        Ok(value) => value,
        Err(error) => return error.response(),
    };
    if let Err(error) = active_trace(&request.trace_id, &state, origin.clone()) {
        return error.response();
    }
    if request.source.len() > MAX_FILTER_BYTES {
        return request_error(StatusCode::BAD_REQUEST, "filter is too large", origin).response();
    }
    let engine = state.engine.lock().expect("engine lock poisoned");
    if let Err(error) = engine.agent_filter_check(&request.source) {
        return filter_error(error, origin);
    }
    bounded_json(
        &serde_json::json!({
            "traceId": state.trace.id.as_ref(), "analysisRevision": engine.analysis().revision, "valid": true
        }),
        origin,
    )
}

async fn agent_query(
    State(state): State<ServerState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let origin = match authorize(&headers, &state) {
        Ok(origin) => origin,
        Err(error) => return error.response(),
    };
    let request: AgentQueryRequest = match decode(&body, origin.clone(), "invalid allocation query")
    {
        Ok(value) => value,
        Err(error) => return error.response(),
    };
    if let Err(error) = active_trace(&request.trace_id, &state, origin.clone()) {
        return error.response();
    }
    if request.limit == 0 || request.limit > MAX_AGENT_PAGE {
        return request_error(
            StatusCode::BAD_REQUEST,
            format!("limit must be from 1 through {MAX_AGENT_PAGE}"),
            origin,
        )
        .response();
    }
    if !matches!(request.order_by.as_str(), "creator-asc" | "birth-desc" | "size-desc" | "lifetime-desc" | "death-desc") {
        return request_error(StatusCode::BAD_REQUEST, "unsupported allocation ordering", origin).response();
    }
    let engine = state.engine.lock().expect("engine lock poisoned");
    let source = match resolve_filter(&engine, request.filter, origin.clone()) {
        Ok(source) => source,
        Err(error) => return error.response(),
    };
    let revision = engine.analysis().revision;
    let from = match decode_cursor(
        request.cursor.as_deref(),
        &state.trace.id,
        revision,
        &source,
        &request.order_by,
        origin.clone(),
    ) {
        Ok(from) => from,
        Err(error) => return error.response(),
    };
    let mut value =
        match engine.agent_query(&source, &request.order_by, from, request.limit as usize) {
            Ok(value) => value,
            Err(error) => return filter_error(error, origin),
        };
    if from > value["matched"]["allocations"].as_u64().unwrap_or_default() as usize {
        return request_error(
            StatusCode::CONFLICT,
            "query cursor is stale or invalid",
            origin,
        )
        .response();
    }
    let next = value
        .as_object_mut()
        .unwrap()
        .remove("next")
        .and_then(|v| v.as_u64())
        .map(|next| {
            encode_cursor(
                &state.trace.id,
                revision,
                next as usize,
                &source,
                &request.order_by,
            )
        });
    value
        .as_object_mut()
        .unwrap()
        .insert("nextCursor".into(), serde_json::to_value(next).unwrap());
    envelope(&mut value, &state, revision);
    bounded_json(&value, origin)
}

async fn summarize(State(state): State<ServerState>, headers: HeaderMap, body: Bytes) -> Response {
    let origin = match authorize(&headers, &state) {
        Ok(origin) => origin,
        Err(error) => return error.response(),
    };
    let request: SummarizeRequest = match decode(&body, origin.clone(), "invalid summary request") {
        Ok(value) => value,
        Err(error) => return error.response(),
    };
    if let Err(error) = active_trace(&request.trace_id, &state, origin.clone()) {
        return error.response();
    }
    if request.limit == 0 || request.limit > MAX_GROUPS {
        return request_error(
            StatusCode::BAD_REQUEST,
            format!("limit must be from 1 through {MAX_GROUPS}"),
            origin,
        )
        .response();
    }
    if !matches!(request.group_by.as_str(), "site" | "thread" | "freed" | "size-bucket" | "lifetime-bucket" | "tag") {
        return request_error(StatusCode::BAD_REQUEST, "unsupported summary grouping", origin).response();
    }
    let engine = state.engine.lock().expect("engine lock poisoned");
    let source = match resolve_filter(&engine, request.filter, origin.clone()) {
        Ok(source) => source,
        Err(error) => return error.response(),
    };
    let mut value = match engine.agent_summarize(&source, &request.group_by, request.limit as usize)
    {
        Ok(value) => value,
        Err(error) => return filter_error(error, origin),
    };
    envelope(&mut value, &state, engine.analysis().revision);
    bounded_json(&value, origin)
}

async fn agent_timeline(
    State(state): State<ServerState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let origin = match authorize(&headers, &state) {
        Ok(origin) => origin,
        Err(error) => return error.response(),
    };
    let request: TimelineRequest = match decode(&body, origin.clone(), "invalid timeline request") {
        Ok(value) => value,
        Err(error) => return error.response(),
    };
    if let Err(error) = active_trace(&request.trace_id, &state, origin.clone()) {
        return error.response();
    }
    let Some(from) = request.range.from.value() else {
        return request_error(
            StatusCode::BAD_REQUEST,
            "timeline bounds are invalid",
            origin,
        )
        .response();
    };
    let Some(to) = request.range.to.value() else {
        return request_error(
            StatusCode::BAD_REQUEST,
            "timeline bounds are invalid",
            origin,
        )
        .response();
    };
    if request.bins == 0
        || request.bins > MAX_TIMELINE_BINS
        || to <= from
        || !matches!(request.domain.as_str(), "sequence" | "time")
    {
        return request_error(
            StatusCode::BAD_REQUEST,
            "timeline bounds are invalid",
            origin,
        )
        .response();
    }
    let engine = state.engine.lock().expect("engine lock poisoned");
    let source = match resolve_filter(&engine, request.filter, origin.clone()) {
        Ok(source) => source,
        Err(error) => return error.response(),
    };
    let mut value =
        match engine.agent_timeline(&source, &request.domain, from, to, request.bins as usize) {
            Ok(value) => value,
            Err(error) => return filter_error(error, origin),
        };
    envelope(&mut value, &state, engine.analysis().revision);
    bounded_json(&value, origin)
}

async fn stream_context(
    State(state): State<ServerState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let origin = match authorize(&headers, &state) {
        Ok(origin) => origin,
        Err(error) => return error.response(),
    };
    let request: StreamContextRequest =
        match decode(&body, origin.clone(), "invalid stream context request") {
            Ok(value) => value,
            Err(error) => return error.response(),
        };
    if let Err(error) = active_trace(&request.trace_id, &state, origin.clone()) {
        return error.response();
    }
    if request
        .before
        .saturating_add(request.after)
        .saturating_add(1)
        > MAX_CONTEXT_EVENTS
    {
        return request_error(
            StatusCode::BAD_REQUEST,
            format!("stream context is limited to {MAX_CONTEXT_EVENTS} events"),
            origin,
        )
        .response();
    }
    let engine = state.engine.lock().expect("engine lock poisoned");
    if request.center >= engine.len() {
        return request_error(
            StatusCode::BAD_REQUEST,
            "stream center is out of range",
            origin,
        )
        .response();
    }
    let source = match resolve_filter(&engine, request.filter, origin.clone()) {
        Ok(source) => source,
        Err(error) => return error.response(),
    };
    let options = agent::ContextOptions {
        landmarks: request.include_landmarks,
        logs: request.include_logs,
    };
    let mut value = match engine.agent_stream_context_with(
        &source,
        request.center,
        request.before,
        request.after,
        options,
    ) {
        Ok(value) => value,
        Err(error) => return filter_error(error, origin),
    };
    envelope(&mut value, &state, engine.analysis().revision);
    bounded_json(&value, origin)
}

async fn query(State(state): State<ServerState>, headers: HeaderMap, body: Bytes) -> Response {
    let origin = match authorize(&headers, &state) {
        Ok(origin) => origin,
        Err(error) => return error.response(),
    };
    let request: QueryRequest = match serde_json::from_slice(&body) {
        Ok(request) => request,
        Err(_) => {
            return request_error(StatusCode::BAD_REQUEST, "invalid query request", origin)
                .response()
        }
    };
    if request.trace_id != state.trace.id.as_ref() {
        return request_error(StatusCode::CONFLICT, "trace identity changed", origin).response();
    }
    if request.source.len() > MAX_FILTER_BYTES || request.count == 0 || request.count > MAX_PAGE {
        return request_error(
            StatusCode::BAD_REQUEST,
            "query is outside its bounds",
            origin,
        )
        .response();
    }
    let encoded = state
        .engine
        .lock()
        .expect("engine lock poisoned")
        .query_json(&request.source, request.from, request.count);
    let mut result: serde_json::Value =
        serde_json::from_str(&encoded).expect("the core produces valid query JSON");
    if result["valid"] == true && request.from > result["total"].as_u64().unwrap_or_default() as u32
    {
        return request_error(
            StatusCode::BAD_REQUEST,
            "query cursor is out of range",
            origin,
        )
        .response();
    }
    let result_object = result.as_object_mut().expect("query result is an object");
    result_object.insert(
        "traceId".into(),
        serde_json::Value::String(state.trace.id.to_string()),
    );
    if result_object.get("valid") == Some(&serde_json::Value::Bool(true)) {
        let actual = result_object["items"].as_array().unwrap().len() as u64;
        result_object.insert("from".into(), serde_json::Value::from(request.from));
        result_object.insert("count".into(), serde_json::Value::from(actual));
    }
    bounded_json(&result, origin)
}

fn decode<T: serde::de::DeserializeOwned>(
    body: &[u8],
    origin: Option<HeaderValue>,
    message: &'static str,
) -> Result<T, RequestError> {
    serde_json::from_slice(body)
        .map_err(|_| request_error(StatusCode::BAD_REQUEST, message, origin))
}

fn active_trace(
    trace_id: &str,
    state: &ServerState,
    origin: Option<HeaderValue>,
) -> Result<(), RequestError> {
    if trace_id == state.trace.id.as_ref() {
        Ok(())
    } else {
        Err(request_error(
            StatusCode::CONFLICT,
            "trace identity changed",
            origin,
        ))
    }
}

fn resolve_filter(
    engine: &heap_visualizer_core::Engine,
    filter: Option<FilterInput>,
    origin: Option<HeaderValue>,
) -> Result<String, RequestError> {
    let source = match filter {
        None => String::new(),
        Some(FilterInput {
            source: Some(source),
            saved_filter_id: None,
        }) => source,
        Some(FilterInput {
            source: None,
            saved_filter_id: Some(id),
        }) => engine
            .analysis()
            .saved_filters
            .get(&id)
            .map(|filter| filter.source.clone())
            .ok_or_else(|| {
                request_error(
                    StatusCode::BAD_REQUEST,
                    "saved filter not found",
                    origin.clone(),
                )
            })?,
        _ => {
            return Err(request_error(
                StatusCode::BAD_REQUEST,
                "filter requires exactly one of source or savedFilterId",
                origin,
            ))
        }
    };
    if source.len() > MAX_FILTER_BYTES {
        return Err(request_error(
            StatusCode::BAD_REQUEST,
            "filter is too large",
            origin,
        ));
    }
    Ok(source)
}

fn filter_error(
    error: heap_visualizer_core::agent::Error,
    origin: Option<HeaderValue>,
) -> Response {
    json(
        StatusCode::BAD_REQUEST,
        &serde_json::json!({
            "error": { "code": "invalid_filter", "message": error.message, "diagnostic": { "start": error.start, "end": error.end } }
        }),
        origin,
    )
}

fn conflict_response(
    code: &'static str,
    message: &'static str,
    revision: u64,
    origin: Option<HeaderValue>,
) -> Response {
    json(
        StatusCode::CONFLICT,
        &ErrorResponse {
            error: ErrorDetail {
                code,
                message,
                current_revision: Some(revision),
            },
        },
        origin,
    )
}

fn envelope(value: &mut serde_json::Value, state: &ServerState, revision: u64) {
    let object = value
        .as_object_mut()
        .expect("agent core response is an object");
    object.insert(
        "traceId".into(),
        serde_json::Value::String(state.trace.id.to_string()),
    );
    object.insert("analysisRevision".into(), serde_json::Value::from(revision));
}

fn compact_session_metadata(metadata: &serde_json::Value) -> serde_json::Value {
    let keys = [
        "n",
        "tMin",
        "tMax",
        "nMalloc",
        "nFree",
        "nRealloc",
        "nCustom",
        "addrMin",
        "addrMax",
        "peakLive",
        "totalAlloc",
        "unit",
        "title",
        "hasHeader",
        "warnTotal",
    ];
    serde_json::Value::Object(
        keys.into_iter()
            .filter_map(|key| {
                metadata
                    .get(key)
                    .cloned()
                    .map(|value| (key.to_owned(), value))
            })
            .collect(),
    )
}

fn cursor_digest(trace_id: &str, revision: u64, source: &str, order: &str) -> [u8; 16] {
    let mut hash = Sha256::new();
    hash.update(trace_id.as_bytes());
    hash.update([0]);
    hash.update(revision.to_le_bytes());
    hash.update(source.as_bytes());
    hash.update([0]);
    hash.update(order.as_bytes());
    hash.finalize()[..16]
        .try_into()
        .expect("digest slice has fixed length")
}

fn body_digest(body: &[u8]) -> [u8; 32] {
    Sha256::digest(body).into()
}

fn valid_request_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_REQUEST_ID_BYTES
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn idempotent_lookup(
    state: &ServerState,
    request_id: &str,
    body: &[u8],
    origin: Option<HeaderValue>,
) -> Result<Option<serde_json::Value>, RequestError> {
    if !valid_request_id(request_id) {
        return Err(request_error(
            StatusCode::BAD_REQUEST,
            "invalid requestId",
            origin,
        ));
    }
    let digest = body_digest(body);
    let entries = state.idempotency.lock().expect("idempotency lock poisoned");
    match entries.iter().find(|entry| entry.request_id == request_id) {
        Some(entry) if entry.digest == digest => Ok(Some(entry.response.clone())),
        Some(_) => Err(request_error(
            StatusCode::CONFLICT,
            "requestId was already used for another request",
            origin,
        )),
        None => Ok(None),
    }
}

fn remember_idempotent(
    state: &ServerState,
    request_id: String,
    body: &[u8],
    response: serde_json::Value,
) {
    let mut entries = state.idempotency.lock().expect("idempotency lock poisoned");
    entries.push_back(IdempotentResult {
        request_id,
        digest: body_digest(body),
        response,
    });
    while entries.len() > 512 {
        entries.pop_front();
    }
}

fn encode_hex(bytes: &[u8]) -> String {
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write;
        write!(&mut encoded, "{byte:02x}").expect("writing to a String cannot fail");
    }
    encoded
}

fn decode_hex(value: &str) -> Option<Vec<u8>> {
    let (pairs, remainder) = value.as_bytes().as_chunks::<2>();
    if !remainder.is_empty() {
        return None;
    }
    pairs
        .iter()
        .map(|pair| {
            let text = std::str::from_utf8(pair).ok()?;
            u8::from_str_radix(text, 16).ok()
        })
        .collect()
}

fn encode_cursor(
    trace_id: &str,
    revision: u64,
    offset: usize,
    source: &str,
    order: &str,
) -> String {
    let mut bytes = Vec::with_capacity(32);
    bytes.extend_from_slice(&revision.to_le_bytes());
    bytes.extend_from_slice(&(offset as u64).to_le_bytes());
    bytes.extend_from_slice(&cursor_digest(trace_id, revision, source, order));
    encode_hex(&bytes)
}

fn decode_cursor(
    cursor: Option<&str>,
    trace_id: &str,
    revision: u64,
    source: &str,
    order: &str,
    origin: Option<HeaderValue>,
) -> Result<usize, RequestError> {
    let Some(cursor) = cursor else {
        return Ok(0);
    };
    let Some(bytes) = decode_hex(cursor) else {
        return Err(request_error(
            StatusCode::CONFLICT,
            "query cursor is stale or invalid",
            origin,
        ));
    };
    if bytes.len() != 32
        || u64::from_le_bytes(bytes[0..8].try_into().unwrap()) != revision
        || bytes[16..] != cursor_digest(trace_id, revision, source, order)
    {
        return Err(request_error(
            StatusCode::CONFLICT,
            "query cursor is stale or invalid",
            origin,
        ));
    }
    usize::try_from(u64::from_le_bytes(bytes[8..16].try_into().unwrap())).map_err(|_| {
        request_error(
            StatusCode::CONFLICT,
            "query cursor is stale or invalid",
            origin,
        )
    })
}

fn single_u32_query(
    query: Option<&str>,
    key: &str,
    default: u32,
    maximum: u32,
    origin: Option<HeaderValue>,
) -> Result<u32, RequestError> {
    let mut result = None;
    for (name, value) in url::form_urlencoded::parse(query.unwrap_or_default().as_bytes()) {
        if name != key || result.is_some() {
            return Err(request_error(
                StatusCode::BAD_REQUEST,
                "invalid query parameters",
                origin,
            ));
        }
        result = Some(value.parse().map_err(|_| {
            request_error(
                StatusCode::BAD_REQUEST,
                "invalid query parameters",
                origin.clone(),
            )
        })?);
    }
    let result = result.unwrap_or(default);
    if result == 0 || result > maximum {
        return Err(request_error(
            StatusCode::BAD_REQUEST,
            "query parameter is outside its bounds",
            origin,
        ));
    }
    Ok(result)
}

fn optional_page(
    query: Option<&str>,
    origin: Option<HeaderValue>,
) -> Result<(u32, u32), RequestError> {
    let mut from = None;
    let mut count = None;
    for (key, value) in url::form_urlencoded::parse(query.unwrap_or_default().as_bytes()) {
        match key.as_ref() {
            "from" if from.is_none() => {
                from = Some(value.parse().map_err(|_| {
                    request_error(
                        StatusCode::BAD_REQUEST,
                        "invalid query parameters",
                        origin.clone(),
                    )
                })?)
            }
            "count" if count.is_none() => {
                count = Some(value.parse().map_err(|_| {
                    request_error(
                        StatusCode::BAD_REQUEST,
                        "invalid query parameters",
                        origin.clone(),
                    )
                })?)
            }
            _ => {
                return Err(request_error(
                    StatusCode::BAD_REQUEST,
                    "invalid query parameters",
                    origin,
                ))
            }
        }
    }
    let count = count.unwrap_or(DEFAULT_AGENT_PAGE);
    if count == 0 || count > MAX_AGENT_PAGE {
        return Err(request_error(
            StatusCode::BAD_REQUEST,
            format!("count must be from 1 through {MAX_AGENT_PAGE}"),
            origin,
        ));
    }
    Ok((from.unwrap_or(0), count))
}

async fn analysis(State(state): State<ServerState>, headers: HeaderMap) -> Response {
    let origin = match authorize(&headers, &state) {
        Ok(origin) => origin,
        Err(error) => return error.response(),
    };
    let engine = state.engine.lock().expect("engine lock poisoned");
    json(
        StatusCode::OK,
        &AnalysisResponse {
            trace_id: &state.trace.id,
            document: engine.analysis(),
        },
        origin,
    )
}

/// The bounded agent view of the canonical analysis: the revision to write
/// against, every tag definition (capped by the core at 255), and object
/// counts. The complete document stays at `GET /api/v1/analysis`, the
/// connected browser's synchronization snapshot.
async fn analysis_summary(State(state): State<ServerState>, headers: HeaderMap) -> Response {
    let origin = match authorize(&headers, &state) {
        Ok(origin) => origin,
        Err(error) => return error.response(),
    };
    let engine = state.engine.lock().expect("engine lock poisoned");
    let document = engine.analysis();
    let tags: Vec<_> = document
        .tags
        .iter()
        .map(|(id, tag)| serde_json::json!({ "id": id, "name": tag.name, "color": tag.color }))
        .collect();
    bounded_json(
        &serde_json::json!({
            "traceId": state.trace.id.as_ref(),
            "analysisRevision": document.revision,
            "counts": {
                "annotatedAllocations": document.allocations.len(),
                "namedAllocations": document.allocations.values().filter(|a| a.name.is_some()).count(),
                "coloredAllocations": document.allocations.values().filter(|a| a.color.is_some()).count(),
                "tags": document.tags.len(),
                "bookmarks": document.bookmarks.len(),
                "addressMarks": document.address_marks.len(),
                "savedFilters": document.saved_filters.len(),
            },
            "tags": tags,
        }),
        origin,
    )
}

async fn change_analysis(
    State(state): State<ServerState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let origin = match authorize(&headers, &state) {
        Ok(origin) => origin,
        Err(error) => return error.response(),
    };
    let request: AnalysisChangeRequest = match serde_json::from_slice(&body) {
        Ok(request) => request,
        Err(_) => {
            return request_error(StatusCode::BAD_REQUEST, "invalid analysis change", origin)
                .response()
        }
    };
    if request.trace_id != state.trace.id.as_ref() {
        return request_error(StatusCode::CONFLICT, "trace identity changed", origin).response();
    }
    let mut engine = state.engine.lock().expect("engine lock poisoned");
    if let Some(request_id) = &request.request_id {
        match idempotent_lookup(&state, request_id, &body, origin.clone()) {
            Ok(Some(value)) => return json(StatusCode::OK, &value, origin),
            Ok(None) => {}
            Err(error) => return error.response(),
        }
    }
    let before = engine.analysis().clone();
    let change = match engine.apply_analysis(request.expected_revision, request.change) {
        Ok(change) => change,
        Err(heap_visualizer_core::analysis::ApplyError::Conflict) => {
            return conflict_response(
                "revision_conflict",
                "analysis revision changed",
                engine.analysis().revision,
                origin,
            )
        }
        Err(heap_visualizer_core::analysis::ApplyError::Invalid(message)) => {
            return request_error(StatusCode::BAD_REQUEST, message, origin).response()
        }
    };
    if let Some(path) = &state.analysis_path {
        if persist_analysis(path, engine.analysis(), &before).is_err() {
            engine
                .replace_analysis(before)
                .expect("previous analysis was valid");
            return request_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "analysis could not be persisted",
                origin,
            )
            .response();
        }
    }
    let revision = engine.analysis().revision;
    let large = matches!(
        &change,
        heap_visualizer_core::analysis::Change::ReplaceTagMembers { creators, .. }
            if creators.len() > MAX_JOURNALED_TAG_MEMBERS
    );
    journal(&state, revision, (!large).then(|| change.clone()));
    state.revision_tx.send_replace(revision);
    // The committing client still receives the canonical change to apply.
    let response = serde_json::json!({ "traceId": state.trace.id.as_ref(), "revision": revision, "change": change });
    if let Some(request_id) = request.request_id {
        // A replay of a large replacement asks for a snapshot instead of
        // retaining the creator list.
        let retained = if large {
            serde_json::json!({ "traceId": state.trace.id.as_ref(), "revision": revision, "snapshotRequired": true })
        } else {
            response.clone()
        };
        remember_idempotent(&state, request_id, &body, retained);
    }
    json(StatusCode::OK, &response, origin)
}

async fn tag_query(State(state): State<ServerState>, headers: HeaderMap, body: Bytes) -> Response {
    let origin = match authorize(&headers, &state) {
        Ok(origin) => origin,
        Err(error) => return error.response(),
    };
    let request: TagQueryRequest = match decode(&body, origin.clone(), "invalid tag query") {
        Ok(value) => value,
        Err(error) => return error.response(),
    };
    if let Err(error) = active_trace(&request.trace_id, &state, origin.clone()) {
        return error.response();
    }
    let mut engine = state.engine.lock().expect("engine lock poisoned");
    if let Some(request_id) = &request.request_id {
        match idempotent_lookup(&state, request_id, &body, origin.clone()) {
            Ok(Some(value)) => return json(StatusCode::OK, &value, origin),
            Ok(None) => {}
            Err(error) => return error.response(),
        }
    }
    let source = match resolve_filter(&engine, Some(request.filter), origin.clone()) {
        Ok(source) => source,
        Err(error) => return error.response(),
    };
    let before = engine.analysis().clone();
    let result = match engine.apply_tag_query(
        request.expected_revision,
        &request.tag_id,
        &source,
        &request.operation,
    ) {
        Ok(result) => result,
        Err(heap_visualizer_core::agent::TagQueryError::Conflict) => {
            return conflict_response(
                "revision_conflict",
                "analysis revision changed",
                engine.analysis().revision,
                origin,
            )
        }
        Err(heap_visualizer_core::agent::TagQueryError::Invalid(message)) => {
            return request_error(StatusCode::BAD_REQUEST, message, origin).response()
        }
        Err(heap_visualizer_core::agent::TagQueryError::Filter(error)) => {
            return filter_error(error, origin)
        }
    };
    if let Some(path) = &state.analysis_path {
        if persist_analysis(path, engine.analysis(), &before).is_err() {
            engine
                .replace_analysis(before)
                .expect("previous analysis was valid");
            return request_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "analysis could not be persisted",
                origin,
            )
            .response();
        }
    }
    journal(&state, result.revision, None);
    state.revision_tx.send_replace(result.revision);
    let response = serde_json::json!({
        "traceId": state.trace.id.as_ref(), "revision": result.revision,
        "matched": result.matched, "changed": result.changed, "snapshotRequired": true
    });
    if let Some(request_id) = request.request_id {
        remember_idempotent(&state, request_id, &body, response.clone());
    }
    json(StatusCode::OK, &response, origin)
}

/// Appends one committed revision to the bounded change journal. `None` is a
/// reset entry: clients behind `revision` must re-read the full document.
fn journal(
    state: &ServerState,
    revision: u64,
    change: Option<heap_visualizer_core::analysis::Change>,
) {
    let mut changes = state.changes.lock().expect("change log lock poisoned");
    changes.push_back(ChangeLogEntry { revision, change });
    while changes.len() > MAX_CHANGE_HISTORY {
        changes.pop_front();
    }
}

async fn changes(State(state): State<ServerState>, headers: HeaderMap, uri: Uri) -> Response {
    let origin = match authorize(&headers, &state) {
        Ok(origin) => origin,
        Err(error) => return error.response(),
    };
    let (after, wait) = match changes_query(uri.query(), origin.clone()) {
        Ok(query) => query,
        Err(error) => return error.response(),
    };
    let mut revisions = state.revision_tx.subscribe();
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(wait);
    loop {
        let response = changes_since(&state, after);
        if response.reset || !response.changes.is_empty() || wait == 0 {
            return json(StatusCode::OK, &response, origin);
        }
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return json(StatusCode::OK, &response, origin);
        }
        if tokio::time::timeout(remaining, revisions.changed())
            .await
            .is_err()
        {
            return json(StatusCode::OK, &changes_since(&state, after), origin);
        }
    }
}

fn changes_since(state: &ServerState, after: u64) -> ChangesResponse<'_> {
    // Keep the engine guard until the journal snapshot is copied. Writers use
    // the same lock order, so revision and deltas describe one atomic point.
    let engine = state.engine.lock().expect("engine lock poisoned");
    let revision = engine.analysis().revision;
    let log = state.changes.lock().expect("change log lock poisoned");
    let first_available = log
        .iter()
        .find(|entry| entry.revision > after)
        .map(|entry| entry.revision);
    let reset = after > revision
        || (after < revision && first_available != Some(after + 1))
        || log
            .iter()
            .any(|entry| entry.revision > after && entry.change.is_none());
    let changes = if reset {
        Vec::new()
    } else {
        log.iter()
            .filter(|entry| entry.revision > after)
            .take(MAX_CHANGE_PAGE)
            .filter_map(|entry| {
                entry.change.clone().map(|change| CommittedChange {
                    revision: entry.revision,
                    change,
                })
            })
            .collect()
    };
    ChangesResponse {
        trace_id: &state.trace.id,
        revision,
        reset,
        changes,
    }
}

fn changes_query(
    query: Option<&str>,
    origin: Option<HeaderValue>,
) -> Result<(u64, u64), RequestError> {
    let mut after = None;
    let mut wait = None;
    for (key, value) in url::form_urlencoded::parse(query.unwrap_or_default().as_bytes()) {
        match key.as_ref() {
            "after" if after.is_none() => {
                after = Some(value.parse().map_err(|_| bad_changes(origin.clone()))?)
            }
            "wait" if wait.is_none() => {
                wait = Some(value.parse().map_err(|_| bad_changes(origin.clone()))?)
            }
            _ => return Err(bad_changes(origin)),
        }
    }
    let after = after.ok_or_else(|| bad_changes(origin.clone()))?;
    let wait = wait.unwrap_or(0);
    if wait > MAX_CHANGE_WAIT_SECS {
        return Err(bad_changes(origin));
    }
    Ok((after, wait))
}

fn bad_changes(origin: Option<HeaderValue>) -> RequestError {
    request_error(
        StatusCode::BAD_REQUEST,
        format!("changes require after and wait from 0 through {MAX_CHANGE_WAIT_SECS}"),
        origin,
    )
}

fn persist_analysis(
    path: &Path,
    document: &heap_visualizer_core::analysis::Document,
    previous: &heap_visualizer_core::analysis::Document,
) -> io::Result<()> {
    let parent = path.parent().expect("analysis path has a parent");
    #[cfg(unix)]
    let directory = File::open(parent)?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
    serde_json::to_writer(&mut temporary, document)?;
    temporary.as_file().sync_all()?;
    temporary.persist(path).map_err(|error| error.error)?;
    #[cfg(unix)]
    if let Err(error) = directory.sync_all() {
        // The rename happened, but durability was not established. Restore the
        // prior canonical document before reporting failure so disk and engine
        // can be rolled back together by the caller.
        let mut rollback = tempfile::NamedTempFile::new_in(parent)?;
        serde_json::to_writer(&mut rollback, previous)?;
        rollback.as_file().sync_all()?;
        rollback.persist(path).map_err(|persist| persist.error)?;
        directory.sync_all()?;
        return Err(error);
    }
    Ok(())
}

fn page(
    query: Option<&str>,
    total: u32,
    origin: Option<HeaderValue>,
) -> Result<(u32, u32), RequestError> {
    let mut from = None;
    let mut count = None;
    for (key, value) in url::form_urlencoded::parse(query.unwrap_or_default().as_bytes()) {
        match key.as_ref() {
            "from" if from.is_none() => {
                from = Some(value.parse().map_err(|_| bad_page(origin.clone()))?);
            }
            "count" if count.is_none() => {
                count = Some(value.parse().map_err(|_| bad_page(origin.clone()))?);
            }
            _ => return Err(bad_page(origin)),
        }
    }
    let from = from.unwrap_or(0);
    let count = count.ok_or_else(|| bad_page(origin.clone()))?;
    if count == 0 || count > MAX_PAGE || from > total {
        return Err(bad_page(origin));
    }
    Ok((from, count))
}

fn bad_page(origin: Option<HeaderValue>) -> RequestError {
    request_error(
        StatusCode::BAD_REQUEST,
        format!("pagination requires from >= 0 and count from 1 through {MAX_PAGE}"),
        origin,
    )
}

fn request_error(
    status: StatusCode,
    error: impl Into<Cow<'static, str>>,
    origin: Option<HeaderValue>,
) -> RequestError {
    let code = match status {
        StatusCode::BAD_REQUEST => "invalid_request",
        StatusCode::UNAUTHORIZED => "authentication_failed",
        StatusCode::FORBIDDEN => "forbidden",
        StatusCode::NOT_FOUND => "not_found",
        StatusCode::CONFLICT => "conflict",
        StatusCode::INTERNAL_SERVER_ERROR => "internal_error",
        _ => "request_failed",
    };
    RequestError {
        status,
        error: error.into(),
        code,
        origin,
    }
}

async fn trace(State(state): State<ServerState>, headers: HeaderMap) -> Response {
    let origin = match authorize(&headers, &state) {
        Ok(origin) => origin,
        Err(error) => return error.response(),
    };
    let file = match tokio::fs::File::open(state.trace.snapshot.path()).await {
        Ok(file) => file,
        Err(_) => {
            return json(
                StatusCode::INTERNAL_SERVER_ERROR,
                &ErrorResponse {
                    error: ErrorDetail {
                        code: "trace_unreadable",
                        message: "active trace is no longer readable",
                        current_revision: None,
                    },
                },
                origin,
            )
        }
    };
    let mut response = Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/x-ndjson")
        .header(header::CONTENT_LENGTH, state.trace.len)
        .header(header::CACHE_CONTROL, "private, immutable")
        .header(header::ETAG, format!("\"{}\"", state.trace.id))
        .body(Body::from_stream(ReaderStream::new(file)))
        .expect("trace response headers are valid");
    add_cors(response.headers_mut(), origin);
    response
}

struct RequestError {
    status: StatusCode,
    error: Cow<'static, str>,
    code: &'static str,
    origin: Option<HeaderValue>,
}

impl RequestError {
    fn response(self) -> Response {
        json(
            self.status,
            &ErrorResponse {
                error: ErrorDetail {
                    code: self.code,
                    message: &self.error,
                    current_revision: None,
                },
            },
            self.origin,
        )
    }
}

fn authorize(
    headers: &HeaderMap,
    state: &ServerState,
) -> Result<Option<HeaderValue>, RequestError> {
    if !host_allowed(headers, state.port) {
        return Err(RequestError {
            status: StatusCode::BAD_REQUEST,
            error: "invalid Host".into(),
            code: "invalid_host",
            origin: None,
        });
    }
    let origin = browser_origin(headers).map_err(|()| RequestError {
        status: StatusCode::FORBIDDEN,
        error: "origin is not allowed".into(),
        code: "origin_forbidden",
        origin: None,
    })?;
    let presented = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.as_bytes().strip_prefix(b"Bearer "));
    if !presented.is_some_and(|presented| constant_time_eq(presented, state.token.as_bytes())) {
        return Err(RequestError {
            status: StatusCode::UNAUTHORIZED,
            error: "bad or missing capability".into(),
            code: "authentication_failed",
            origin,
        });
    }
    Ok(origin)
}

/// Compares secrets without an early exit on the first differing byte. The
/// length is not secret: every capability is 64 hex digits.
fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    left.len() == right.len()
        && left
            .iter()
            .zip(right)
            .fold(0_u8, |difference, (a, b)| difference | (a ^ b))
            == 0
}

async fn preflight(State(state): State<ServerState>, headers: HeaderMap) -> Response {
    if !host_allowed(&headers, state.port) {
        return json(
            StatusCode::BAD_REQUEST,
            &ErrorResponse {
                error: ErrorDetail {
                    code: "invalid_host",
                    message: "invalid Host",
                    current_revision: None,
                },
            },
            None,
        );
    }
    let origin = match browser_origin(&headers) {
        Ok(Some(origin)) => origin,
        Ok(None) => {
            return json(
                StatusCode::FORBIDDEN,
                &ErrorResponse {
                    error: ErrorDetail {
                        code: "origin_required",
                        message: "preflight requires an Origin",
                        current_revision: None,
                    },
                },
                None,
            )
        }
        Err(()) => {
            return json(
                StatusCode::FORBIDDEN,
                &ErrorResponse {
                    error: ErrorDetail {
                        code: "origin_forbidden",
                        message: "origin is not allowed",
                        current_revision: None,
                    },
                },
                None,
            )
        }
    };
    let requested_method = headers
        .get(header::ACCESS_CONTROL_REQUEST_METHOD)
        .and_then(|h| h.to_str().ok());
    if !matches!(requested_method, Some("GET" | "POST")) {
        return json(
            StatusCode::FORBIDDEN,
            &ErrorResponse {
                error: ErrorDetail {
                    code: "method_forbidden",
                    message: "preflight method is not allowed",
                    current_revision: None,
                },
            },
            None,
        );
    }

    let mut response = Response::builder()
        .status(StatusCode::NO_CONTENT)
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin)
        .header(
            header::ACCESS_CONTROL_ALLOW_METHODS,
            requested_method.expect("validated above"),
        )
        .header(
            header::ACCESS_CONTROL_ALLOW_HEADERS,
            "authorization,content-type",
        )
        .header(header::ACCESS_CONTROL_MAX_AGE, "600")
        .header(header::VARY, "Origin")
        .body(Body::empty())
        .expect("static response headers are valid");
    if headers
        .get(&REQUEST_PRIVATE_NETWORK)
        .and_then(|h| h.to_str().ok())
        == Some("true")
    {
        response
            .headers_mut()
            .insert(ALLOW_PRIVATE_NETWORK, HeaderValue::from_static("true"));
    }
    response
}

async fn not_found() -> Response {
    json(
        StatusCode::NOT_FOUND,
        &ErrorResponse {
            error: ErrorDetail {
                code: "not_found",
                message: "no such route",
                current_revision: None,
            },
        },
        None,
    )
}

fn host_allowed(headers: &HeaderMap, port: u16) -> bool {
    let Some(host) = headers.get(header::HOST).and_then(|h| h.to_str().ok()) else {
        return false;
    };
    host == format!("127.0.0.1:{port}") || host == format!("localhost:{port}")
}

fn browser_origin(headers: &HeaderMap) -> Result<Option<HeaderValue>, ()> {
    let Some(origin) = headers.get(header::ORIGIN) else {
        return Ok(None);
    };
    let Ok(text) = origin.to_str() else {
        return Err(());
    };
    let Ok(url) = Url::parse(text) else {
        return Err(());
    };
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || url.origin().ascii_serialization() != text
    {
        return Err(());
    }
    Ok(Some(origin.clone()))
}

fn json<T: Serialize>(status: StatusCode, value: &T, origin: Option<HeaderValue>) -> Response {
    let body = serde_json::to_vec(value).expect("response values are serializable");
    let mut response = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/json; charset=utf-8")
        .header(header::CACHE_CONTROL, "no-store")
        .body(Body::from(body))
        .expect("static response headers are valid");
    add_cors(response.headers_mut(), origin);
    response
}

fn bounded_json<T: Serialize>(value: &T, origin: Option<HeaderValue>) -> Response {
    let body = serde_json::to_vec(value).expect("response values are serializable");
    if body.len() > MAX_AGENT_RESPONSE_BYTES {
        return json(
            StatusCode::PAYLOAD_TOO_LARGE,
            &ErrorResponse {
                error: ErrorDetail {
                    code: "response_too_large",
                    message: "response exceeds the 256 KiB agent response limit; request a smaller page or range",
                    current_revision: None,
                },
            },
            origin,
        );
    }
    let mut response = Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/json; charset=utf-8")
        .header(header::CACHE_CONTROL, "no-store")
        .body(Body::from(body))
        .expect("static response headers are valid");
    add_cors(response.headers_mut(), origin);
    response
}

fn add_cors(headers: &mut HeaderMap, origin: Option<HeaderValue>) {
    if let Some(origin) = origin {
        headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin);
        headers.insert(header::VARY, HeaderValue::from_static("Origin"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::{Method, Request};
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    const TOKEN: &str = "0123456789abcdef";
    const ORIGIN: &str = "https://viewer.example";

    fn app() -> Router {
        let trace = TraceFile::open(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../web/guide/traces/format.heapl"),
        )
        .unwrap();
        let engine = trace.parse_engine().unwrap();
        router(ServerState::new(TOKEN.into(), 8631, trace, engine))
    }

    fn trace_id() -> String {
        TraceFile::open(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../web/guide/traces/format.heapl"),
        )
        .unwrap()
        .id
        .to_string()
    }

    fn analysis_change(id: &str, expected: u64, change: serde_json::Value) -> Request<Body> {
        Request::builder()
            .method(Method::POST)
            .uri("/api/v1/analysis/changes")
            .header(header::HOST, "127.0.0.1:8631")
            .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(
                serde_json::json!({
                    "traceId": id,
                    "expectedRevision": expected,
                    "change": change,
                })
                .to_string(),
            ))
            .unwrap()
    }

    /// A router over an in-test trace, and that trace's id.
    fn app_with(trace: &str) -> (Router, String) {
        let source = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(source.path(), trace).unwrap();
        let trace = TraceFile::open(source.path()).unwrap();
        let id = trace.id.to_string();
        let engine = trace.parse_engine().unwrap();
        (router(ServerState::new(TOKEN.into(), 8631, trace, engine)), id)
    }

    async fn get_json(app: &Router, uri: &str) -> (StatusCode, serde_json::Value) {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(uri)
                    .header(header::HOST, "127.0.0.1:8631")
                    .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let body = response.into_body().collect().await.unwrap().to_bytes();
        (status, serde_json::from_slice(&body).unwrap())
    }

    #[tokio::test]
    async fn logs_page_through_level_filtered_records() {
        let mut trace = String::from("{\"op\":\"H\",\"v\":1}\n");
        trace.push_str("{\"op\":\"M\",\"t\":1,\"id\":1,\"addr\":\"0x1000\",\"size\":8}\n");
        for (i, level) in ["info", "warn", "error", "debug", "warning"].iter().enumerate() {
            trace.push_str(&format!(
                "{{\"op\":\"L\",\"t\":{},\"thr\":2,\"level\":\"{level}\",\"logger\":\"net\",\"msg\":\"line {i}\",\"attempt\":{i}}}\n",
                i + 2
            ));
        }
        let (app, id) = app_with(&trace);

        let (status, page) = get_json(&app, "/api/v1/logs?minLevel=warn&count=2").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(page["traceId"], id);
        assert_eq!(page["total"], 3);
        assert_eq!(page["from"], 0);
        assert_eq!(page["next"], 2);
        let items = page["items"].as_array().unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0]["level"], "warn");
        assert_eq!(items[0]["msg"], "line 1");
        assert_eq!(items[0]["logger"], "net");
        assert_eq!(items[0]["thr"], 2);
        assert!(items[0]["t"].is_string());
        assert_eq!(items[1]["level"], "error");

        let (status, last) = get_json(&app, "/api/v1/logs?minLevel=warn&count=2&from=2").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(last["items"].as_array().unwrap().len(), 1);
        assert_eq!(last["items"][0]["msg"], "line 4");
        assert_eq!(last["next"], serde_json::Value::Null);

        let (_, all) = get_json(&app, "/api/v1/logs?text=LINE%203").await;
        assert_eq!(all["total"], 1);
        assert_eq!(all["items"][0]["level"], "debug");

        // the overview carries the core's log counts
        let (_, overview) = get_json(&app, "/api/v1/overview").await;
        assert_eq!(overview["logs"]["records"], 5);
        assert_eq!(overview["logs"]["byLevel"]["warn"], 2);

        for bad in [
            "/api/v1/logs?minLevel=loud",
            "/api/v1/logs?minLevel=6",
            "/api/v1/logs?count=0",
            "/api/v1/logs?count=201",
            "/api/v1/logs?from=-1",
            "/api/v1/logs?count=1&count=2",
            "/api/v1/logs?level=warn",
        ] {
            let (status, body) = get_json(&app, bad).await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{bad}");
            assert_eq!(body["error"]["code"], "invalid_request", "{bad}");
        }
        let long = format!("/api/v1/logs?text={}", "x".repeat(agent::LOGS_TEXT_MAX + 1));
        assert_eq!(get_json(&app, &long).await.0, StatusCode::BAD_REQUEST);

        let (_, session) = get_json(&app, "/api/v1/session").await;
        let capabilities = &session["capabilities"];
        assert_eq!(capabilities["endpoints"]["logs"], "/api/v1/logs");
        assert_eq!(capabilities["limits"]["defaultLogPage"], agent::LOGS_COUNT_DEFAULT);
        assert_eq!(capabilities["limits"]["maximumLogPage"], agent::LOGS_COUNT_MAX);
        assert_eq!(capabilities["limits"]["maximumLogTextBytes"], agent::LOGS_TEXT_MAX);
    }

    /// A heap, a mark, and two log records.
    const MIXED_TRACE: &str = concat!(
        "{\"op\":\"H\",\"v\":1}\n",
        "{\"op\":\"M\",\"t\":1,\"id\":1,\"addr\":\"0x1000\",\"size\":8}\n",
        "{\"op\":\"L\",\"t\":2,\"level\":\"warn\",\"logger\":\"net\",\"msg\":\"slow\"}\n",
        "{\"op\":\"E\",\"t\":3,\"title\":\"phase: sweep\"}\n",
        "{\"op\":\"L\",\"t\":4,\"level\":\"info\",\"msg\":\"done\"}\n",
    );

    #[tokio::test]
    async fn domains_are_discoverable_and_their_records_paged() {
        let (app, id) = app_with(MIXED_TRACE);

        let (status, body) = get_json(&app, "/api/v1/domains").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["traceId"], id);
        let names: Vec<_> = body["domains"]
            .as_array()
            .unwrap()
            .iter()
            .map(|d| d["id"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(names, ["heap", "marks", "logs", "intervals"]);

        let (status, ivl) = get_json(&app, "/api/v1/domains/intervals/records").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(ivl["domain"], "intervals");

        let (status, logs) =
            get_json(&app, "/api/v1/domains/logs/records?minLevel=warn&count=5").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(logs["traceId"], id);
        assert_eq!(logs["domain"], "logs");
        assert_eq!(logs["total"], 1);
        assert_eq!(logs["items"][0]["msg"], "slow");

        // `/logs` is the same page without the generic `domain` key
        let (_, mut generic) = get_json(&app, "/api/v1/domains/logs/records?text=o&count=1").await;
        let (_, alias) = get_json(&app, "/api/v1/logs?text=o&count=1").await;
        generic.as_object_mut().unwrap().remove("domain");
        assert_eq!(generic, alias);

        let (status, marks) = get_json(&app, "/api/v1/domains/marks/records?text=sweep").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(marks["domain"], "marks");
        assert_eq!(marks["total"], 1);
        assert_eq!(marks["items"][0]["seq"], 2);

        let (status, body) = get_json(&app, "/api/v1/domains/gpu/records").await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body["error"]["code"], "unknown_domain");

        for bad in [
            "/api/v1/domains/marks/records?minLevel=warn",
            "/api/v1/domains/logs/records?colour=red",
            "/api/v1/domains/logs/records?count=201",
            "/api/v1/domains/logs/records?seqLo=x",
            "/api/v1/domains/logs/records?text=a&text=b",
        ] {
            let (status, body) = get_json(&app, bad).await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{bad}");
            assert_eq!(body["error"]["code"], "invalid_request", "{bad}");
        }

        let (_, session) = get_json(&app, "/api/v1/session").await;
        let capabilities = &session["capabilities"];
        assert_eq!(capabilities["endpoints"]["domains"], "/api/v1/domains");
        assert_eq!(
            capabilities["endpoints"]["domainRecords"],
            "/api/v1/domains/{domain}/records"
        );
        assert_eq!(capabilities["limits"]["defaultRecordPage"], domain::RECORDS_COUNT_DEFAULT);
        assert_eq!(capabilities["limits"]["maximumRecordPage"], domain::RECORDS_COUNT_MAX);
    }

    #[tokio::test]
    async fn stream_context_includes_logs_only_on_request() {
        let (app, id) = app_with(MIXED_TRACE);
        let context = |include: Option<bool>| {
            let mut payload =
                serde_json::json!({ "traceId": id, "center": 0, "before": 0, "after": 4 });
            if let Some(include) = include {
                payload["includeLogs"] = include.into();
            }
            let app = app.clone();
            async move {
                let response = app
                    .oneshot(json_post("/api/v1/stream/context", payload.to_string()))
                    .await
                    .unwrap();
                assert_eq!(response.status(), StatusCode::OK);
                let body = response.into_body().collect().await.unwrap().to_bytes();
                serde_json::from_slice::<serde_json::Value>(&body).unwrap()
            }
        };
        let operations = |body: &serde_json::Value| -> Vec<String> {
            body["events"]
                .as_array()
                .unwrap()
                .iter()
                .map(|e| e["operation"].as_str().unwrap().to_string())
                .collect()
        };

        let default = context(None).await;
        assert!(!operations(&default).contains(&"log".to_string()));
        assert_eq!(default["omitted"]["logs"], 2);

        let with_logs = context(Some(true)).await;
        let logs: Vec<_> = with_logs["events"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|e| e["operation"] == "log")
            .collect();
        assert_eq!(logs.len(), 2);
        assert_eq!(logs[0]["level"], "warn");
        assert_eq!(logs[0]["msg"], "slow");
        assert!(with_logs.get("omitted").is_none());
    }

    #[tokio::test]
    async fn a_large_member_replacement_is_journaled_as_a_reset() {
        let mut trace = String::from("{\"op\":\"H\",\"v\":1}\n");
        let n = MAX_JOURNALED_TAG_MEMBERS + 1;
        for i in 0..n {
            trace.push_str(&format!(
                "{{\"op\":\"M\",\"t\":{i},\"id\":{},\"addr\":\"0x{:x}\",\"size\":8}}\n",
                i + 1,
                0x1000 + 16 * i
            ));
        }
        let (app, id) = app_with(&trace);
        let tag = serde_json::json!({ "type": "putTag", "id": "t", "name": "T", "color": "#112233" });
        let response = app.clone().oneshot(analysis_change(&id, 0, tag)).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let (_, first) = get_json(&app, "/api/v1/events?from=0&count=1").await;
        let base = first["items"][0]["seq"].as_u64().unwrap();
        let replace = |count: usize| {
            serde_json::json!({
                "type": "replaceTagMembers", "tagId": "t",
                "creators": (0..count as u64).map(|k| base + k).collect::<Vec<_>>()
            })
        };

        // at the threshold the delta is still journaled verbatim
        let response = app
            .clone()
            .oneshot(analysis_change(&id, 1, replace(MAX_JOURNALED_TAG_MEMBERS)))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let (_, feed) = get_json(&app, "/api/v1/changes?after=1").await;
        assert_eq!(feed["reset"], false);
        assert_eq!(
            feed["changes"][0]["change"]["creators"].as_array().unwrap().len(),
            MAX_JOURNALED_TAG_MEMBERS
        );

        // above it the committer still gets the change, others get a reset
        let response = app.clone().oneshot(analysis_change(&id, 2, replace(n))).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["revision"], 3);
        assert_eq!(body["change"]["creators"].as_array().unwrap().len(), n);
        let (_, feed) = get_json(&app, "/api/v1/changes?after=2").await;
        assert_eq!(feed["reset"], true);
        assert_eq!(feed["changes"].as_array().unwrap().len(), 0);
        let (_, feed) = get_json(&app, "/api/v1/changes?after=3").await;
        assert_eq!(feed["reset"], false);
    }

    fn request(method: Method) -> axum::http::request::Builder {
        Request::builder()
            .method(method)
            .uri("/api/v1/session")
            .header(header::HOST, "127.0.0.1:8631")
    }

    #[test]
    fn active_trace_is_an_immutable_snapshot_of_the_supplied_file() {
        let source = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(source.path(), b"original trace\n").unwrap();
        let trace = TraceFile::open(source.path()).unwrap();
        std::fs::write(source.path(), b"changed trace\n").unwrap();
        assert_eq!(
            std::fs::read(trace.snapshot.path()).unwrap(),
            b"original trace\n"
        );
    }

    #[tokio::test]
    async fn authenticated_agent_request_needs_no_browser_origin() {
        let response = app()
            .oneshot(
                request(Method::GET)
                    .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert!(response
            .headers()
            .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
            .is_none());
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let body = serde_json::from_slice::<serde_json::Value>(&body).unwrap();
        assert_eq!(body["apiVersion"], 1);
        assert_eq!(body["trace"]["name"], "format.heapl");
        assert_eq!(body["trace"]["url"], "/api/v1/trace");
        assert!(body["trace"]["id"].as_str().unwrap().starts_with("sha256:"));
        assert!(body["metadata"].get("sites").is_none());
        let limits = &body["capabilities"]["limits"];
        assert_eq!(limits["maximumPage"], MAX_AGENT_PAGE);
        assert_eq!(limits["maximumListPage"], MAX_PAGE);
        assert_eq!(limits["maximumChangePage"], MAX_CHANGE_PAGE);
        assert_eq!(limits["maximumChangeWaitSeconds"], MAX_CHANGE_WAIT_SECS);
        assert_eq!(limits["maximumRequestBytes"], MAX_REQUEST_BYTES);
        assert_eq!(limits["maximumAnalysisChangeBytes"], MAX_ANALYSIS_CHANGE_BYTES);
        assert_eq!(body["capabilities"]["endpoints"]["overview"], "/api/v1/overview");
    }

    #[tokio::test]
    async fn advertised_list_page_is_the_enforced_one() {
        for (uri, status) in [
            (format!("/api/v1/events?count={MAX_PAGE}"), StatusCode::OK),
            (format!("/api/v1/events?count={}", MAX_PAGE + 1), StatusCode::BAD_REQUEST),
        ] {
            let response = app()
                .oneshot(
                    Request::builder()
                        .uri(&uri)
                        .header(header::HOST, "127.0.0.1:8631")
                        .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), status, "{uri}");
        }
    }

    fn json_post(uri: &str, body: impl Into<Body>) -> Request<Body> {
        Request::builder()
            .method(Method::POST)
            .uri(uri)
            .header(header::HOST, "127.0.0.1:8631")
            .header(header::ORIGIN, ORIGIN)
            .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
            .header(header::CONTENT_TYPE, "application/json")
            .body(body.into())
            .unwrap()
    }

    async fn error_code(response: Response) -> String {
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
        body["error"]["code"].as_str().unwrap().to_owned()
    }

    #[tokio::test]
    async fn analysis_changes_accept_large_member_lists_other_routes_stay_small() {
        let app = app();
        let id = trace_id();
        let created = app
            .clone()
            .oneshot(analysis_change(
                &id,
                0,
                serde_json::json!({ "type": "putTag", "id": "big", "name": "Big", "color": "#112233" }),
            ))
            .await
            .unwrap();
        assert_eq!(created.status(), StatusCode::OK);
        // A browser range tag sends every member; padding stands in for the
        // tens of thousands of creator ids a real large tag carries.
        let padding = " ".repeat(4 * MAX_REQUEST_BYTES);
        let body = format!(
            r#"{{"traceId":"{id}","expectedRevision":1,"change":{{"type":"replaceTagMembers","tagId":"big","creators":[1{padding}]}}}}"#
        );
        assert!(body.len() > MAX_REQUEST_BYTES);
        let response = app
            .clone()
            .oneshot(json_post("/api/v1/analysis/changes", body.clone()))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let response = app
            .clone()
            .oneshot(json_post("/api/v1/analysis/tag-query", body))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
        assert_eq!(response.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN], ORIGIN);
        assert_eq!(error_code(response).await, "request_too_large");

        let oversized = vec![b' '; MAX_ANALYSIS_CHANGE_BYTES + 1];
        let response = app
            .oneshot(json_post("/api/v1/analysis/changes", oversized))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
        assert_eq!(response.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN], ORIGIN);
        assert_eq!(error_code(response).await, "request_too_large");
    }

    #[tokio::test]
    async fn framework_errors_carry_cors_and_the_json_error_shape() {
        let wrong_method = app()
            .oneshot(json_post("/api/v1/session", "{}"))
            .await
            .unwrap();
        assert_eq!(wrong_method.status(), StatusCode::METHOD_NOT_ALLOWED);
        assert_eq!(wrong_method.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN], ORIGIN);
        assert!(wrong_method.headers().contains_key(header::ALLOW));
        assert_eq!(error_code(wrong_method).await, "method_not_allowed");

        let missing = app()
            .oneshot(
                Request::builder()
                    .uri("/api/v1/nothing-here")
                    .header(header::HOST, "127.0.0.1:8631")
                    .header(header::ORIGIN, ORIGIN)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(missing.status(), StatusCode::NOT_FOUND);
        assert_eq!(missing.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN], ORIGIN);
        assert_eq!(error_code(missing).await, "not_found");

        // The same rules as handler errors: no reflection for a rebound Host
        // or a malformed Origin.
        for (host, origin) in [
            ("attacker.example", ORIGIN),
            ("127.0.0.1:8631", "https://viewer.example/path"),
        ] {
            let response = app()
                .oneshot(
                    Request::builder()
                        .uri("/api/v1/nothing-here")
                        .header(header::HOST, host)
                        .header(header::ORIGIN, origin)
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::NOT_FOUND);
            assert!(response
                .headers()
                .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
                .is_none());
        }
    }

    #[tokio::test]
    async fn analysis_summary_is_a_bounded_revision_and_tag_read() {
        let app = app();
        let id = trace_id();
        app.clone()
            .oneshot(analysis_change(
                &id,
                0,
                serde_json::json!({ "type": "putTag", "id": "suspect", "name": "Suspect", "color": "#d9485f" }),
            ))
            .await
            .unwrap();
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/api/v1/analysis/summary")
                    .header(header::HOST, "127.0.0.1:8631")
                    .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["traceId"], id);
        assert_eq!(body["analysisRevision"], 1);
        assert_eq!(body["counts"]["tags"], 1);
        assert_eq!(body["tags"][0]["id"], "suspect");
        assert!(body.get("document").is_none());
    }

    #[tokio::test]
    async fn a_capability_with_the_right_prefix_but_wrong_length_is_rejected() {
        for value in [
            format!("Bearer {TOKEN}0"),
            format!("Bearer {}", &TOKEN[..TOKEN.len() - 1]),
            TOKEN.to_owned(),
            format!("bearer {TOKEN}"),
        ] {
            let response = app()
                .oneshot(
                    request(Method::GET)
                        .header(header::AUTHORIZATION, value.as_str())
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED, "{value}");
        }
    }

    #[tokio::test]
    async fn trace_bytes_are_authenticated_and_immutable() {
        let response = app()
            .oneshot(
                Request::builder()
                    .method(Method::GET)
                    .uri("/api/v1/trace")
                    .header(header::HOST, "127.0.0.1:8631")
                    .header(header::ORIGIN, ORIGIN)
                    .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert!(response.headers()[header::ETAG]
            .to_str()
            .unwrap()
            .starts_with("\"sha256:"));
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let expected = std::fs::read(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../web/guide/traces/format.heapl"),
        )
        .unwrap();
        assert_eq!(body.as_ref(), expected);
    }

    #[tokio::test]
    async fn metadata_and_events_are_native_semantic_reads() {
        let metadata = app()
            .oneshot(
                Request::builder()
                    .uri("/api/v1/metadata")
                    .header(header::HOST, "127.0.0.1:8631")
                    .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(metadata.status(), StatusCode::OK);
        let body = metadata.into_body().collect().await.unwrap().to_bytes();
        let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert!(body["traceId"].as_str().unwrap().starts_with("sha256:"));
        assert!(body["metadata"]["n"].as_u64().unwrap() > 0);

        let events = app()
            .oneshot(
                Request::builder()
                    .uri("/api/v1/events?from=1&count=2")
                    .header(header::HOST, "127.0.0.1:8631")
                    .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(events.status(), StatusCode::OK);
        let body = events.into_body().collect().await.unwrap().to_bytes();
        let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["from"], 1);
        assert_eq!(body["count"], 2);
        assert_eq!(body["items"][0]["seq"], 1);
    }

    #[tokio::test]
    async fn agent_reads_progress_from_overview_to_evidence_without_raw_dumps() {
        let app = app();
        let id = trace_id();
        let overview = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/v1/overview?top=2")
                    .header(header::HOST, "127.0.0.1:8631")
                    .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(overview.status(), StatusCode::OK);
        let body = overview.into_body().collect().await.unwrap().to_bytes();
        let overview: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(overview["traceId"], id);
        assert!(overview["trace"]["events"].as_u64().unwrap() > 0);
        assert!(overview["topSites"].as_array().unwrap().len() <= 2);

        let query_body = serde_json::json!({
            "traceId": id, "filter": { "source": "alloc.size >= 1" },
            "orderBy": "size-desc", "limit": 1
        })
        .to_string();
        let query = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/api/v1/allocations/query")
                    .header(header::HOST, "127.0.0.1:8631")
                    .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(query_body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(query.status(), StatusCode::OK);
        let body = query.into_body().collect().await.unwrap().to_bytes();
        let query: serde_json::Value = serde_json::from_slice(&body).unwrap();
        let creator = query["items"][0]["creator"].as_u64().unwrap();
        assert!(query["items"][0].get("fields").is_none());
        let cursor = query["nextCursor"].as_str().expect("fixture has another allocation");
        assert_eq!(cursor.len(), 64);
        let next = app.clone().oneshot(Request::builder().method(Method::POST)
            .uri("/api/v1/allocations/query")
            .header(header::HOST, "127.0.0.1:8631")
            .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(serde_json::json!({
                "traceId": id, "filter": { "source": "alloc.size >= 1" },
                "orderBy": "size-desc", "limit": 1, "cursor": cursor
            }).to_string())).unwrap()).await.unwrap();
        assert_eq!(next.status(), StatusCode::OK);
        let bytes = next.into_body().collect().await.unwrap().to_bytes();
        let next: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_ne!(next["items"][0]["creator"], creator);

        let detail = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri(format!("/api/v1/allocations/{creator}"))
                    .header(header::HOST, "127.0.0.1:8631")
                    .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let body = detail.into_body().collect().await.unwrap().to_bytes();
        let detail: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(detail["allocation"]["creator"], creator);
        assert!(detail["allocation"].get("relations").is_some());

        for (uri, payload, key) in [
            (
                "/api/v1/allocations/summarize",
                serde_json::json!({ "traceId": id, "groupBy": "site", "limit": 5 }),
                "groups",
            ),
            (
                "/api/v1/timeline",
                serde_json::json!({ "traceId": id, "domain": "sequence", "range": { "from": 0, "to": overview["trace"]["events"] }, "bins": 4 }),
                "bins",
            ),
            (
                "/api/v1/stream/context",
                serde_json::json!({ "traceId": id, "center": creator, "before": 1, "after": 1 }),
                "events",
            ),
        ] {
            let response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .method(Method::POST)
                        .uri(uri)
                        .header(header::HOST, "127.0.0.1:8631")
                        .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                        .header(header::CONTENT_TYPE, "application/json")
                        .body(Body::from(payload.to_string()))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK, "{uri}");
            let body = response.into_body().collect().await.unwrap().to_bytes();
            let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
            assert!(body[key].is_array(), "{uri}");
        }
    }

    #[tokio::test]
    async fn bulk_tagging_is_atomic_idempotent_and_forces_change_feed_resync() {
        let app = app();
        let id = trace_id();
        let created = app
            .clone()
            .oneshot(analysis_change(
                &id,
                0,
                serde_json::json!({
                    "type": "putTag", "id": "all", "name": "All", "color": "#112233"
                }),
            ))
            .await
            .unwrap();
        assert_eq!(created.status(), StatusCode::OK);
        let body = serde_json::json!({
            "traceId": id, "expectedRevision": 1, "requestId": "tag-everything-1",
            "tagId": "all", "filter": { "source": "alloc.size >= 1" }, "operation": "replace"
        })
        .to_string();
        for _ in 0..2 {
            let response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .method(Method::POST)
                        .uri("/api/v1/analysis/tag-query")
                        .header(header::HOST, "127.0.0.1:8631")
                        .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                        .header(header::CONTENT_TYPE, "application/json")
                        .body(Body::from(body.clone()))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            let bytes = response.into_body().collect().await.unwrap().to_bytes();
            let response: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(response["revision"], 2);
            assert_eq!(response["snapshotRequired"], true);
        }
        let changes = app
            .oneshot(
                Request::builder()
                    .uri("/api/v1/changes?after=1")
                    .header(header::HOST, "127.0.0.1:8631")
                    .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let bytes = changes.into_body().collect().await.unwrap().to_bytes();
        let changes: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(changes["reset"], true);
    }

    #[tokio::test]
    async fn allocation_detail_has_no_render_geometry() {
        let response = app()
            .oneshot(
                Request::builder()
                    .uri("/api/v1/allocations/1")
                    .header(header::HOST, "127.0.0.1:8631")
                    .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["allocation"]["creator"], 1);
        assert!(body["allocation"].get("rects").is_none());
        assert!(body.get("traceId").is_some());

        let missing = app()
            .oneshot(
                Request::builder()
                    .uri("/api/v1/allocations/999999")
                    .header(header::HOST, "127.0.0.1:8631")
                    .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(missing.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn filter_queries_are_bounded_diagnostic_and_authenticated() {
        let request_body = serde_json::json!({
            "traceId": trace_id(),
            "source": "alloc.size >= 1",
            "from": 0,
            "count": 2
        })
        .to_string();
        let response = app()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/api/v1/query")
                    .header(header::HOST, "127.0.0.1:8631")
                    .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(request_body.clone()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["valid"], true);
        assert_eq!(body["from"], 0);
        assert_eq!(body["count"], 2);
        assert_eq!(body["items"].as_array().unwrap().len(), 2);
        assert!(body["next"].is_number());

        let denied = app()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/api/v1/query")
                    .header(header::HOST, "127.0.0.1:8631")
                    .body(Body::from(request_body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(denied.status(), StatusCode::UNAUTHORIZED);

        let diagnostic = serde_json::json!({
            "traceId": trace_id(),
            "source": "alloc.size >",
            "from": 0,
            "count": 2
        })
        .to_string();
        let response = app()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/api/v1/query")
                    .header(header::HOST, "127.0.0.1:8631")
                    .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                    .body(Body::from(diagnostic))
                    .unwrap(),
            )
            .await
            .unwrap();
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["valid"], false);
        assert!(body["diagnostic"]["start"].is_number());
    }

    #[tokio::test]
    async fn agent_filter_discovery_and_check_use_the_core_catalog() {
        let app = app();
        let schema = app.clone().oneshot(Request::builder()
            .uri("/api/v1/filter/schema?count=20")
            .header(header::HOST, "127.0.0.1:8631")
            .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
            .body(Body::empty()).unwrap()).await.unwrap();
        assert_eq!(schema.status(), StatusCode::OK);
        let bytes = schema.into_body().collect().await.unwrap().to_bytes();
        let schema: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(schema["namespaces"][0]["name"], "alloc");
        assert!(schema["namespaces"][0]["fields"].as_array().unwrap().iter()
            .any(|field| field["name"] == "size"));
        assert!(schema["customFieldPage"]["count"].is_number());

        let checked = app.clone().oneshot(Request::builder().method(Method::POST)
            .uri("/api/v1/filter/check")
            .header(header::HOST, "127.0.0.1:8631")
            .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(serde_json::json!({
                "traceId": trace_id(), "source": "alloc.size >= 4096"
            }).to_string())).unwrap()).await.unwrap();
        assert_eq!(checked.status(), StatusCode::OK);

        let invalid = app.oneshot(Request::builder().method(Method::POST)
            .uri("/api/v1/filter/check")
            .header(header::HOST, "127.0.0.1:8631")
            .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(serde_json::json!({
                "traceId": trace_id(), "source": "alloc.size >"
            }).to_string())).unwrap()).await.unwrap();
        assert_eq!(invalid.status(), StatusCode::BAD_REQUEST);
        let bytes = invalid.into_body().collect().await.unwrap().to_bytes();
        let invalid: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(invalid["error"]["code"], "invalid_filter");
        assert!(invalid["error"]["diagnostic"]["start"].is_number());
    }

    #[tokio::test]
    async fn analysis_changes_are_revisioned_and_persist_before_acknowledgement() {
        let directory = tempfile::tempdir().unwrap();
        let trace_path =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../web/guide/traces/format.heapl");
        let trace = TraceFile::open(&trace_path).unwrap();
        let id = trace.id.to_string();
        let engine = trace.parse_engine().unwrap();
        let state =
            ServerState::persistent(TOKEN.into(), 8631, trace, engine, directory.path()).unwrap();
        let response = router(state)
            .oneshot(analysis_change(
                &id,
                0,
                serde_json::json!({
                    "type": "putTag", "id": "leak", "name": "Leak", "color": "#AABBCC"
                }),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["revision"], 1);
        assert_eq!(body["change"]["color"], "#aabbcc");

        let trace = TraceFile::open(&trace_path).unwrap();
        let engine = trace.parse_engine().unwrap();
        let reloaded =
            ServerState::persistent(TOKEN.into(), 8631, trace, engine, directory.path()).unwrap();
        let stale = router(reloaded.clone())
            .oneshot(analysis_change(
                &id,
                0,
                serde_json::json!({ "type": "deleteTag", "id": "leak" }),
            ))
            .await
            .unwrap();
        assert_eq!(stale.status(), StatusCode::CONFLICT);

        let named = router(reloaded.clone())
            .oneshot(analysis_change(
                &id,
                1,
                serde_json::json!({
                    "type": "setAllocationName", "creator": 1, "name": "owner"
                }),
            ))
            .await
            .unwrap();
        assert_eq!(named.status(), StatusCode::OK);
        let tagged = router(reloaded.clone())
            .oneshot(analysis_change(
                &id,
                2,
                serde_json::json!({
                    "type": "setAllocationTag", "creator": 1, "tagId": "leak", "present": true
                }),
            ))
            .await
            .unwrap();
        assert_eq!(tagged.status(), StatusCode::OK);

        let query_body = serde_json::json!({
            "traceId": id, "source": "named(\"owner\").malloc.seq == 1 and \"Leak\" in alloc.tags", "from": 0, "count": 10
        }).to_string();
        let query_response = router(reloaded.clone())
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/api/v1/query")
                    .header(header::HOST, "127.0.0.1:8631")
                    .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                    .body(Body::from(query_body))
                    .unwrap(),
            )
            .await
            .unwrap();
        let query_body = query_response
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes();
        let query_body: serde_json::Value = serde_json::from_slice(&query_body).unwrap();
        assert_eq!(query_body["items"][0]["creator"], 1);

        let snapshot = router(reloaded)
            .oneshot(
                Request::builder()
                    .uri("/api/v1/analysis")
                    .header(header::HOST, "127.0.0.1:8631")
                    .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let body = snapshot.into_body().collect().await.unwrap().to_bytes();
        let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["document"]["revision"], 3);
        assert_eq!(body["document"]["tags"]["leak"]["name"], "Leak");
    }

    #[tokio::test]
    async fn committed_analysis_changes_are_available_as_ordered_deltas() {
        let trace = TraceFile::open(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../web/guide/traces/format.heapl"),
        )
        .unwrap();
        let id = trace.id.to_string();
        let engine = trace.parse_engine().unwrap();
        let state = ServerState::new(TOKEN.into(), 8631, trace, engine);
        let app = router(state);

        let committed = app
            .clone()
            .oneshot(analysis_change(
                &id,
                0,
                serde_json::json!({
                    "type": "putTag", "id": "leak", "name": "Leak", "color": "#AABBCC"
                }),
            ))
            .await
            .unwrap();
        assert_eq!(committed.status(), StatusCode::OK);

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/api/v1/changes?after=0&wait=0")
                    .header(header::HOST, "127.0.0.1:8631")
                    .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["traceId"], id);
        assert_eq!(body["revision"], 1);
        assert_eq!(body["reset"], false);
        assert_eq!(body["changes"][0]["revision"], 1);
        assert_eq!(body["changes"][0]["change"]["color"], "#aabbcc");

        let committed = app
            .clone()
            .oneshot(analysis_change(
                &id,
                1,
                serde_json::json!({
                    "type": "putBookmark", "id": "stop", "name": "Stop", "seq": 1, "t": 0.0
                }),
            ))
            .await
            .unwrap();
        assert_eq!(committed.status(), StatusCode::OK);
        let response = app
            .oneshot(
                Request::builder()
                    .uri("/api/v1/changes?after=1")
                    .header(header::HOST, "127.0.0.1:8631")
                    .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["reset"], false);
        assert_eq!(body["changes"].as_array().unwrap().len(), 1);
        assert_eq!(body["changes"][0]["revision"], 2);
    }

    #[tokio::test]
    async fn a_held_change_read_wakes_after_a_commit() {
        let trace = TraceFile::open(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../web/guide/traces/format.heapl"),
        )
        .unwrap();
        let id = trace.id.to_string();
        let engine = trace.parse_engine().unwrap();
        let app = router(ServerState::new(TOKEN.into(), 8631, trace, engine));
        let waiting = tokio::spawn(
            app.clone().oneshot(
                Request::builder()
                    .uri("/api/v1/changes?after=0&wait=5")
                    .header(header::HOST, "127.0.0.1:8631")
                    .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                    .body(Body::empty())
                    .unwrap(),
            ),
        );
        tokio::task::yield_now().await;
        let committed = app
            .oneshot(analysis_change(
                &id,
                0,
                serde_json::json!({
                    "type": "putTag", "id": "wake", "name": "Wake", "color": "#112233"
                }),
            ))
            .await
            .unwrap();
        assert_eq!(committed.status(), StatusCode::OK);
        let response = waiting.await.unwrap().unwrap();
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["changes"][0]["revision"], 1);
    }

    #[tokio::test]
    async fn a_revision_outside_change_history_requests_a_snapshot_reset() {
        let trace = TraceFile::open(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../web/guide/traces/format.heapl"),
        )
        .unwrap();
        let engine = trace.parse_engine().unwrap();
        let state = ServerState::new(TOKEN.into(), 8631, trace, engine);
        state
            .engine
            .lock()
            .unwrap()
            .apply_analysis(
                0,
                heap_visualizer_core::analysis::Change::PutTag {
                    id: "existing".into(),
                    name: "Existing".into(),
                    color: "#112233".into(),
                },
            )
            .unwrap();
        let response = router(state)
            .oneshot(
                Request::builder()
                    .uri("/api/v1/changes?after=0")
                    .header(header::HOST, "127.0.0.1:8631")
                    .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["reset"], true);
        assert!(body["changes"].as_array().unwrap().is_empty());
    }

    #[tokio::test]
    async fn list_reads_require_explicit_bounded_pagination() {
        for uri in [
            "/api/v1/events",
            "/api/v1/events?count=0",
            "/api/v1/events?count=201",
            "/api/v1/events?from=999999&count=1",
            "/api/v1/warnings?count=1&count=1",
        ] {
            let response = app()
                .oneshot(
                    Request::builder()
                        .uri(uri)
                        .header(header::HOST, "127.0.0.1:8631")
                        .header(header::ORIGIN, ORIGIN)
                        .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::BAD_REQUEST, "{uri}");
            assert_eq!(
                response.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN],
                ORIGIN
            );
        }
    }

    #[tokio::test]
    async fn browser_get_requires_capability_but_exposes_the_error_to_allowed_origin() {
        let response = app()
            .oneshot(
                request(Method::GET)
                    .header(header::ORIGIN, ORIGIN)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(
            response.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN],
            ORIGIN
        );
    }

    #[tokio::test]
    async fn the_capability_not_the_browser_deployment_is_the_authority() {
        let response = app()
            .oneshot(
                request(Method::GET)
                    .header(header::ORIGIN, "https://attacker.example")
                    .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN],
            "https://attacker.example"
        );
    }

    #[tokio::test]
    async fn session_route_rejects_a_rebound_host() {
        let response = app()
            .oneshot(
                Request::builder()
                    .method(Method::GET)
                    .uri("/api/v1/session")
                    .header(header::HOST, "attacker.example")
                    .header(header::ORIGIN, ORIGIN)
                    .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert!(response
            .headers()
            .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
            .is_none());
    }

    #[tokio::test]
    async fn precise_preflight_includes_legacy_private_network_opt_in() {
        let response = app()
            .oneshot(
                request(Method::OPTIONS)
                    .header(header::ORIGIN, ORIGIN)
                    .header(header::ACCESS_CONTROL_REQUEST_METHOD, "GET")
                    .header(header::ACCESS_CONTROL_REQUEST_HEADERS, "authorization")
                    .header(REQUEST_PRIVATE_NETWORK, "true")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        assert_eq!(
            response.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN],
            ORIGIN
        );
        assert_eq!(response.headers()[ALLOW_PRIVATE_NETWORK], "true");
        assert_eq!(
            response.headers()[header::ACCESS_CONTROL_ALLOW_HEADERS],
            "authorization,content-type"
        );
    }

    #[tokio::test]
    async fn query_preflight_admits_json_post() {
        let response = app()
            .oneshot(
                request(Method::OPTIONS)
                    .header(header::ORIGIN, ORIGIN)
                    .header(header::ACCESS_CONTROL_REQUEST_METHOD, "POST")
                    .header(
                        header::ACCESS_CONTROL_REQUEST_HEADERS,
                        "authorization,content-type",
                    )
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        assert_eq!(
            response.headers()[header::ACCESS_CONTROL_ALLOW_METHODS],
            "POST"
        );
        assert_eq!(
            response.headers()[header::ACCESS_CONTROL_ALLOW_HEADERS],
            "authorization,content-type"
        );
    }

    #[test]
    fn the_connection_string_is_deployment_agnostic() {
        assert_eq!(
            connection_string("http://127.0.0.1:8631", TOKEN),
            "http://127.0.0.1:8631#0123456789abcdef"
        );
    }

    #[test]
    fn allocation_cursors_are_opaque_and_bound_to_the_complete_query() {
        let cursor = encode_cursor("trace-a", 7, 42, "alloc.size > 1", "size-desc");
        assert_eq!(cursor.len(), 64);
        assert!(matches!(
            decode_cursor(Some(&cursor), "trace-a", 7, "alloc.size > 1", "size-desc", None),
            Ok(42)
        ));
        assert!(decode_cursor(Some(&cursor), "trace-b", 7, "alloc.size > 1", "size-desc", None).is_err());
        assert!(decode_cursor(Some(&cursor), "trace-a", 8, "alloc.size > 1", "size-desc", None).is_err());
        assert!(decode_cursor(Some(&cursor), "trace-a", 7, "alloc.size > 2", "size-desc", None).is_err());
    }

    #[test]
    fn agent_json_has_a_hard_response_limit() {
        let response = bounded_json(&serde_json::json!({
            "payload": "x".repeat(MAX_AGENT_RESPONSE_BYTES)
        }), None);
        assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    }

    #[test]
    fn tokens_are_random_and_not_short() {
        let first = fresh_token().unwrap();
        let second = fresh_token().unwrap();
        assert_eq!(first.len(), 64);
        assert_ne!(first, second);
    }
}
