use std::{env, net::SocketAddr};

use heap_visualizer_local_server::{fresh_token, launch_url, router, ServerState};
use tokio::net::TcpListener;
use url::Url;

const DEFAULT_PORT: u16 = 8631;
const DEFAULT_APP_URL: &str = "http://localhost:8630";

struct Config {
    port: u16,
    app_url: Url,
}

fn usage() -> &'static str {
    "usage: heap-visualizer-local-server [--port PORT] [--app-url URL]\n\
     defaults: --port 8631; --app-url $HEAP_APP_URL or http://localhost:8630"
}

fn parse_config() -> Result<Option<Config>, String> {
    let mut port = DEFAULT_PORT;
    let mut app_url = env::var("HEAP_APP_URL").unwrap_or_else(|_| DEFAULT_APP_URL.into());
    let mut args = env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--help" | "-h" => return Ok(None),
            "--port" => {
                let value = args.next().ok_or("--port requires a value")?;
                port = value
                    .parse()
                    .map_err(|_| format!("invalid port: {value}"))?;
                if port == 0 {
                    return Err("port must not be zero".into());
                }
            }
            "--app-url" => app_url = args.next().ok_or("--app-url requires a value")?,
            _ => return Err(format!("unknown argument: {arg}")),
        }
    }
    let app_url = Url::parse(&app_url).map_err(|e| format!("invalid app URL: {e}"))?;
    if !matches!(app_url.scheme(), "http" | "https")
        || app_url.host_str().is_none()
        || !app_url.username().is_empty()
        || app_url.password().is_some()
    {
        return Err("app URL must be an http(s) URL with a host".into());
    }
    Ok(Some(Config { port, app_url }))
}

#[tokio::main]
async fn main() {
    let config = match parse_config() {
        Ok(Some(config)) => config,
        Ok(None) => {
            println!("{}", usage());
            return;
        }
        Err(error) => {
            eprintln!("error: {error}\n{}", usage());
            std::process::exit(2);
        }
    };
    let token = fresh_token().unwrap_or_else(|error| {
        eprintln!("error: could not generate a connection capability: {error}");
        std::process::exit(1);
    });
    let address = SocketAddr::from(([127, 0, 0, 1], config.port));
    let api_url = format!("http://{address}");
    let state =
        ServerState::new(token.clone(), &config.app_url, config.port).unwrap_or_else(|error| {
            eprintln!("error: {error}");
            std::process::exit(2);
        });
    let listener = TcpListener::bind(address).await.unwrap_or_else(|error| {
        eprintln!("error: cannot listen on {address}: {error}");
        std::process::exit(1);
    });

    eprintln!("heap-visualizer local server listening on {api_url}");
    println!("Open: {}", launch_url(&config.app_url, &api_url, &token));
    println!("Agent capability: {token}");

    axum::serve(listener, router(state))
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await
        .unwrap_or_else(|error| {
            eprintln!("error: server failed: {error}");
            std::process::exit(1);
        });
}
