use std::{env, net::SocketAddr};

use heap_visualizer_local_server::{connection_string, fresh_token, router, ServerState};
use tokio::net::TcpListener;

const DEFAULT_PORT: u16 = 8631;

struct Config {
    port: u16,
}

fn usage() -> &'static str {
    "usage: heap-visualizer-local-server [--port PORT]\n\
     default: --port 8631"
}

fn parse_config() -> Result<Option<Config>, String> {
    let mut port = DEFAULT_PORT;
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
            _ => return Err(format!("unknown argument: {arg}")),
        }
    }
    Ok(Some(Config { port }))
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
    let state = ServerState::new(token.clone(), config.port);
    let listener = TcpListener::bind(address).await.unwrap_or_else(|error| {
        eprintln!("error: cannot listen on {address}: {error}");
        std::process::exit(1);
    });

    eprintln!("heap-visualizer local server listening on {api_url}");
    println!("Connection: {}", connection_string(&api_url, &token));

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
