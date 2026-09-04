use std::sync::Arc;

use axum::{
    body::Body,
    extract::State,
    http::{header, HeaderMap, HeaderName, HeaderValue, Method, StatusCode},
    response::Response,
    routing::get,
    Router,
};
use serde::Serialize;
use url::Url;

const REQUEST_PRIVATE_NETWORK: HeaderName =
    HeaderName::from_static("access-control-request-private-network");
const ALLOW_PRIVATE_NETWORK: HeaderName =
    HeaderName::from_static("access-control-allow-private-network");

#[derive(Clone)]
pub struct ServerState {
    token: Arc<str>,
    allowed_origin: HeaderValue,
    port: u16,
}

impl ServerState {
    pub fn new(token: String, app_url: &Url, port: u16) -> Result<Self, String> {
        let origin = app_url.origin().ascii_serialization();
        let allowed_origin = HeaderValue::from_str(&origin)
            .map_err(|_| format!("app URL has an invalid origin: {origin}"))?;
        Ok(Self {
            token: token.into(),
            allowed_origin,
            port,
        })
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionResponse<'a> {
    api_version: u8,
    mode: &'a str,
    server_version: &'a str,
}

#[derive(Serialize)]
struct ErrorResponse<'a> {
    error: &'a str,
}

pub fn router(state: ServerState) -> Router {
    Router::new()
        .route("/api/v1/session", get(session).options(preflight))
        .fallback(not_found)
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

pub fn launch_url(app_url: &Url, api_url: &str, token: &str) -> Url {
    let mut launch = app_url.clone();
    let fragment = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("heap-server", api_url)
        .append_pair("heap-token", token)
        .finish();
    launch.set_fragment(Some(&fragment));
    launch
}

async fn session(State(state): State<ServerState>, headers: HeaderMap) -> Response {
    if !host_allowed(&headers, state.port) {
        return json(
            StatusCode::BAD_REQUEST,
            &ErrorResponse {
                error: "invalid Host",
            },
            None,
        );
    }
    let origin = match browser_origin(&headers, &state) {
        Ok(origin) => origin,
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
    let expected = format!("Bearer {}", state.token);
    if headers
        .get(header::AUTHORIZATION)
        .and_then(|h| h.to_str().ok())
        != Some(&expected)
    {
        return json(
            StatusCode::UNAUTHORIZED,
            &ErrorResponse {
                error: "bad or missing capability",
            },
            origin,
        );
    }
    json(
        StatusCode::OK,
        &SessionResponse {
            api_version: 1,
            mode: "local",
            server_version: env!("CARGO_PKG_VERSION"),
        },
        origin,
    )
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
    let origin = match browser_origin(&headers, &state) {
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
    if headers
        .get(header::ACCESS_CONTROL_REQUEST_METHOD)
        .and_then(|h| h.to_str().ok())
        != Some(Method::GET.as_str())
    {
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
        .header(header::ACCESS_CONTROL_ALLOW_METHODS, Method::GET.as_str())
        .header(
            header::ACCESS_CONTROL_ALLOW_HEADERS,
            header::AUTHORIZATION.as_str(),
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

fn browser_origin(headers: &HeaderMap, state: &ServerState) -> Result<Option<HeaderValue>, ()> {
    let Some(origin) = headers.get(header::ORIGIN) else {
        return Ok(None);
    };
    if origin != state.allowed_origin {
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
    if let Some(origin) = origin {
        response
            .headers_mut()
            .insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin);
        response
            .headers_mut()
            .insert(header::VARY, HeaderValue::from_static("Origin"));
    }
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::Request;
    use http_body_util::BodyExt;
    use tower::ServiceExt;

    const TOKEN: &str = "0123456789abcdef";
    const ORIGIN: &str = "https://viewer.example";

    fn app() -> Router {
        let app_url = Url::parse("https://viewer.example/app").unwrap();
        router(ServerState::new(TOKEN.into(), &app_url, 8631).unwrap())
    }

    fn request(method: Method) -> axum::http::request::Builder {
        Request::builder()
            .method(method)
            .uri("/api/v1/session")
            .header(header::HOST, "127.0.0.1:8631")
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
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&body).unwrap()["apiVersion"],
            1
        );
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
    async fn browser_get_rejects_every_other_origin_without_cors() {
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
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
        assert!(response
            .headers()
            .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
            .is_none());
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
            "authorization"
        );
    }

    #[test]
    fn launch_parameters_are_in_the_fragment_only() {
        let app_url = Url::parse("https://viewer.example/app?x=1").unwrap();
        let launch = launch_url(&app_url, "http://127.0.0.1:8631", TOKEN);
        assert_eq!(launch.query(), Some("x=1"));
        assert_eq!(
            launch.fragment(),
            Some("heap-server=http%3A%2F%2F127.0.0.1%3A8631&heap-token=0123456789abcdef")
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
