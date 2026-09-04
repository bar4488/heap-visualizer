use std::{
    fs::File,
    io::{self, Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use axum::{
    body::{Body, Bytes},
    extract::{DefaultBodyLimit, Path as AxumPath, State},
    http::{header, HeaderMap, HeaderName, HeaderValue, StatusCode, Uri},
    response::Response,
    routing::{get, post},
    Router,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio_util::io::ReaderStream;
use url::Url;

const REQUEST_PRIVATE_NETWORK: HeaderName =
    HeaderName::from_static("access-control-request-private-network");
const ALLOW_PRIVATE_NETWORK: HeaderName =
    HeaderName::from_static("access-control-allow-private-network");

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
        Self {
            token: token.into(),
            port,
            trace,
            engine: Arc::new(Mutex::new(engine)),
            metadata: Arc::new(metadata),
            fields: Arc::new(fields),
            warnings: Arc::new(warnings),
            analysis_path: None,
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
            engine.replace_analysis(document)
                .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "analysis does not match trace"))?;
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
    metadata: &'a serde_json::Value,
    analysis_revision: u64,
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
    error: &'a str,
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
struct AllocationResponse<'a> {
    trace_id: &'a str,
    allocation: serde_json::Value,
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
struct AnalysisChangeRequest {
    trace_id: String,
    expected_revision: u64,
    change: heap_visualizer_core::analysis::Change,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AnalysisResponse<'a> {
    trace_id: &'a str,
    document: &'a heap_visualizer_core::analysis::Document,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AnalysisChangeResponse<'a> {
    trace_id: &'a str,
    revision: u64,
    change: &'a heap_visualizer_core::analysis::Change,
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
        .route("/api/v1/analysis", get(analysis).options(preflight))
        .route(
            "/api/v1/analysis/changes",
            post(change_analysis).options(preflight),
        )
        .fallback(not_found)
        .layer(DefaultBodyLimit::max(32 << 10))
        .with_state(state)
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
    let analysis_revision = state.engine.lock().expect("engine lock poisoned").analysis().revision;
    json(
        StatusCode::OK,
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
            metadata: &state.metadata,
            analysis_revision,
        },
        origin,
    )
}

async fn metadata(State(state): State<ServerState>, headers: HeaderMap) -> Response {
    let origin = match authorize(&headers, &state) {
        Ok(origin) => origin,
        Err(error) => return error.response(),
    };
    json(
        StatusCode::OK,
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
    let total = state.warnings.len() as u32;
    let (from, count) = match page(uri.query(), total, origin.clone()) {
        Ok(page) => page,
        Err(error) => return error.response(),
    };
    let hi = from.saturating_add(count).min(total);
    let items = &state.warnings[from as usize..hi as usize];
    json(
        StatusCode::OK,
        &PageResponse {
            trace_id: &state.trace.id,
            from,
            count: items.len(),
            total,
            next: (hi < total).then_some(hi),
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
    json(
        StatusCode::OK,
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
    let encoded = state
        .engine
        .lock()
        .expect("engine lock poisoned")
        .allocation_json(creator);
    let Some(encoded) = encoded else {
        return request_error(StatusCode::NOT_FOUND, "allocation not found", origin).response();
    };
    let allocation =
        serde_json::from_str(&encoded).expect("the core produces valid allocation JSON");
    json(
        StatusCode::OK,
        &AllocationResponse {
            trace_id: &state.trace.id,
            allocation,
        },
        origin,
    )
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
    if request.source.len() > 16 << 10 || request.count == 0 || request.count > MAX_PAGE {
        return request_error(StatusCode::BAD_REQUEST, "query is outside its bounds", origin)
            .response();
    }
    let encoded = state
        .engine
        .lock()
        .expect("engine lock poisoned")
        .query_json(&request.source, request.from, request.count);
    let mut result: serde_json::Value =
        serde_json::from_str(&encoded).expect("the core produces valid query JSON");
    if result["valid"] == true
        && request.from > result["total"].as_u64().unwrap_or_default() as u32
    {
        return request_error(StatusCode::BAD_REQUEST, "query cursor is out of range", origin)
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
    json(StatusCode::OK, &result, origin)
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
        Err(_) => return request_error(StatusCode::BAD_REQUEST, "invalid analysis change", origin).response(),
    };
    if request.trace_id != state.trace.id.as_ref() {
        return request_error(StatusCode::CONFLICT, "trace identity changed", origin).response();
    }
    let mut engine = state.engine.lock().expect("engine lock poisoned");
    let before = engine.analysis().clone();
    let change = match engine.apply_analysis(request.expected_revision, request.change) {
        Ok(change) => change,
        Err(heap_visualizer_core::analysis::ApplyError::Conflict) => {
            return request_error(StatusCode::CONFLICT, "analysis revision changed", origin).response()
        }
        Err(heap_visualizer_core::analysis::ApplyError::Invalid(message)) => {
            return request_error(StatusCode::BAD_REQUEST, message, origin).response()
        }
    };
    if let Some(path) = &state.analysis_path {
        if persist_analysis(path, engine.analysis()).is_err() {
            engine.replace_analysis(before).expect("previous analysis was valid");
            return request_error(StatusCode::INTERNAL_SERVER_ERROR, "analysis could not be persisted", origin).response();
        }
    }
    json(
        StatusCode::OK,
        &AnalysisChangeResponse {
            trace_id: &state.trace.id,
            revision: engine.analysis().revision,
            change: &change,
        },
        origin,
    )
}

fn persist_analysis(path: &Path, document: &heap_visualizer_core::analysis::Document) -> io::Result<()> {
    let parent = path.parent().expect("analysis path has a parent");
    let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
    serde_json::to_writer(&mut temporary, document)?;
    temporary.as_file().sync_all()?;
    temporary.persist(path).map_err(|error| error.error)?;
    #[cfg(unix)]
    File::open(parent)?.sync_all()?;
    Ok(())
}

const MAX_PAGE: u32 = 200;

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
        "pagination requires from >= 0 and count from 1 through 200",
        origin,
    )
}

fn request_error(
    status: StatusCode,
    error: &'static str,
    origin: Option<HeaderValue>,
) -> RequestError {
    RequestError {
        status,
        error,
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
                    error: "active trace is no longer readable",
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
    error: &'static str,
    origin: Option<HeaderValue>,
}

impl RequestError {
    fn response(self) -> Response {
        json(
            self.status,
            &ErrorResponse { error: self.error },
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
            error: "invalid Host",
            origin: None,
        });
    }
    let origin = browser_origin(headers).map_err(|()| RequestError {
        status: StatusCode::FORBIDDEN,
        error: "origin is not allowed",
        origin: None,
    })?;
    let expected = format!("Bearer {}", state.token);
    if headers
        .get(header::AUTHORIZATION)
        .and_then(|h| h.to_str().ok())
        != Some(&expected)
    {
        return Err(RequestError {
            status: StatusCode::UNAUTHORIZED,
            error: "bad or missing capability",
            origin,
        });
    }
    Ok(origin)
}

async fn preflight(State(state): State<ServerState>, headers: HeaderMap) -> Response {
    if !host_allowed(&headers, state.port) {
        return json(
            StatusCode::BAD_REQUEST,
            &ErrorResponse {
                error: "invalid Host",
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
                    error: "preflight requires an Origin",
                },
                None,
            )
        }
        Err(()) => {
            return json(
                StatusCode::FORBIDDEN,
                &ErrorResponse {
                    error: "origin is not allowed",
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
                error: "preflight method is not allowed",
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
            error: "no such route",
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
            .body(Body::from(serde_json::json!({
                "traceId": id,
                "expectedRevision": expected,
                "change": change,
            }).to_string()))
            .unwrap()
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
    async fn analysis_changes_are_revisioned_and_persist_before_acknowledgement() {
        let directory = tempfile::tempdir().unwrap();
        let trace_path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../web/guide/traces/format.heapl");
        let trace = TraceFile::open(&trace_path).unwrap();
        let id = trace.id.to_string();
        let engine = trace.parse_engine().unwrap();
        let state = ServerState::persistent(TOKEN.into(), 8631, trace, engine, directory.path()).unwrap();
        let response = router(state)
            .oneshot(analysis_change(&id, 0, serde_json::json!({
                "type": "putTag", "id": "leak", "name": "Leak", "color": "#AABBCC"
            })))
            .await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = response.into_body().collect().await.unwrap().to_bytes();
        let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["revision"], 1);
        assert_eq!(body["change"]["color"], "#aabbcc");

        let trace = TraceFile::open(&trace_path).unwrap();
        let engine = trace.parse_engine().unwrap();
        let reloaded = ServerState::persistent(TOKEN.into(), 8631, trace, engine, directory.path()).unwrap();
        let stale = router(reloaded.clone())
            .oneshot(analysis_change(&id, 0, serde_json::json!({ "type": "deleteTag", "id": "leak" })))
            .await.unwrap();
        assert_eq!(stale.status(), StatusCode::CONFLICT);

        let named = router(reloaded.clone())
            .oneshot(analysis_change(&id, 1, serde_json::json!({
                "type": "setAllocationName", "creator": 1, "name": "owner"
            })))
            .await.unwrap();
        assert_eq!(named.status(), StatusCode::OK);
        let tagged = router(reloaded.clone())
            .oneshot(analysis_change(&id, 2, serde_json::json!({
                "type": "setAllocationTag", "creator": 1, "tagId": "leak", "present": true
            })))
            .await.unwrap();
        assert_eq!(tagged.status(), StatusCode::OK);

        let query_body = serde_json::json!({
            "traceId": id, "source": "named(\"owner\").malloc.seq == 1 and \"Leak\" in alloc.tags", "from": 0, "count": 10
        }).to_string();
        let query_response = router(reloaded.clone()).oneshot(Request::builder()
            .method(Method::POST).uri("/api/v1/query")
            .header(header::HOST, "127.0.0.1:8631")
            .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
            .body(Body::from(query_body)).unwrap()).await.unwrap();
        let query_body = query_response.into_body().collect().await.unwrap().to_bytes();
        let query_body: serde_json::Value = serde_json::from_slice(&query_body).unwrap();
        assert_eq!(query_body["items"][0]["creator"], 1);

        let snapshot = router(reloaded)
            .oneshot(Request::builder()
                .uri("/api/v1/analysis")
                .header(header::HOST, "127.0.0.1:8631")
                .header(header::AUTHORIZATION, format!("Bearer {TOKEN}"))
                .body(Body::empty()).unwrap())
            .await.unwrap();
        let body = snapshot.into_body().collect().await.unwrap().to_bytes();
        let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(body["document"]["revision"], 3);
        assert_eq!(body["document"]["tags"]["leak"]["name"], "Leak");
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
        assert_eq!(response.headers()[header::ACCESS_CONTROL_ALLOW_METHODS], "POST");
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
    fn tokens_are_random_and_not_short() {
        let first = fresh_token().unwrap();
        let second = fresh_token().unwrap();
        assert_eq!(first.len(), 64);
        assert_ne!(first, second);
    }
}
