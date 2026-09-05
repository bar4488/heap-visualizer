use std::{
    env, fs,
    net::{SocketAddr, TcpListener as StdTcpListener},
    path::PathBuf,
    time::Duration,
};

#[cfg(windows)]
use std::process::Command as ProcessCommand;

use heapviz::{connection_string, fresh_token, router, ServerState, TraceFile};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tokio::net::TcpListener;
use url::Url;

const DEFAULT_PORT: u16 = 8631;
const MAX_CHANNEL_BYTES: usize = 64 << 10;
const MAX_UPDATE_BYTES: usize = 64 << 20;
const SKILL: &str = include_str!("../../../.opencode/skills/heap-analysis-api/SKILL.md");

#[derive(Clone)]
struct OpenConfig {
    port: u16,
    trace: PathBuf,
    data_dir: PathBuf,
}

enum Command {
    Open(OpenConfig),
    SetupSkill { target: SkillTarget, force: bool },
    Doctor,
    Update,
    Help,
}

#[derive(Clone, Copy)]
enum SkillTarget {
    OpenCode,
    Claude,
}

impl SkillTarget {
    fn label(self) -> &'static str {
        match self {
            Self::OpenCode => "OpenCode",
            Self::Claude => "Claude Code",
        }
    }
}

#[derive(Debug, Deserialize)]
struct Channel {
    schema_version: u32,
    latest_version: String,
    downloads: Downloads,
}

#[derive(Debug, Default, Deserialize)]
struct Downloads {
    #[serde(default)]
    linux_x86_64: Option<Download>,
    #[serde(default)]
    windows_x86_64: Option<Download>,
}

#[derive(Debug, Deserialize)]
struct Download {
    url: String,
    sha256: String,
}

fn usage() -> &'static str {
    "heapviz — connect a local heap trace to the hosted visual workspace\n\n\
     usage:\n  \
       heapviz open [--port PORT] [--data-dir PATH] TRACE_FILE\n  \
       heapviz setup opencode [--force]\n  \
       heapviz setup claude [--force]\n  \
       heapviz doctor\n  \
       heapviz update\n\n\
     `heapviz TRACE_FILE` remains a shorthand for `heapviz open TRACE_FILE`."
}

fn user_home() -> Option<PathBuf> {
    env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

fn default_data_dir() -> PathBuf {
    if cfg!(windows) {
        env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .or_else(user_home)
            .unwrap_or_else(|| PathBuf::from("."))
            .join("heap-visualizer")
    } else {
        env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .or_else(|| user_home().map(|home| home.join(".local/share")))
            .unwrap_or_else(|| PathBuf::from("."))
            .join("heap-visualizer")
    }
}

fn opencode_skill_path() -> Result<PathBuf, String> {
    let config = env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .or_else(|| user_home().map(|home| home.join(".config")))
        .ok_or("cannot find your home directory")?;
    Ok(config.join("opencode/skills/heap-analysis-api/SKILL.md"))
}

fn claude_skill_path() -> Result<PathBuf, String> {
    Ok(user_home()
        .ok_or("cannot find your home directory")?
        .join(".claude/skills/heap-analysis-api/SKILL.md"))
}

fn skill_path(target: SkillTarget) -> Result<PathBuf, String> {
    match target {
        SkillTarget::OpenCode => opencode_skill_path(),
        SkillTarget::Claude => claude_skill_path(),
    }
}

fn parse_args<I>(args: I) -> Result<Command, String>
where
    I: IntoIterator<Item = String>,
{
    let mut args: Vec<String> = args.into_iter().collect();
    if args.is_empty() || matches!(args[0].as_str(), "--help" | "-h" | "help") {
        return Ok(Command::Help);
    }
    match args[0].as_str() {
        "setup" => {
            let target = match args.get(1).map(String::as_str) {
                Some("opencode") => SkillTarget::OpenCode,
                Some("claude") => SkillTarget::Claude,
                _ => return Err("usage: heapviz setup <opencode|claude> [--force]".into()),
            };
            let tail = &args[2..];
            if tail.iter().any(|arg| arg != "--force") {
                return Err("usage: heapviz setup <opencode|claude> [--force]".into());
            }
            return Ok(Command::SetupSkill {
                target,
                force: tail.iter().any(|arg| arg == "--force"),
            });
        }
        "doctor" if args.len() == 1 => return Ok(Command::Doctor),
        "update" if args.len() == 1 => return Ok(Command::Update),
        "open" => {
            args.remove(0);
        }
        value if value.starts_with('-') => {
            return Err(format!("unknown command or option: {value}"))
        }
        _ => {}
    }

    let mut port = DEFAULT_PORT;
    let mut trace = None;
    let mut data_dir = default_data_dir();
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--port" => {
                let value = args.next().ok_or("--port requires a value")?;
                port = value
                    .parse()
                    .map_err(|_| format!("invalid port: {value}"))?;
                if port == 0 {
                    return Err("port must not be zero".into());
                }
            }
            "--data-dir" => {
                data_dir = PathBuf::from(args.next().ok_or("--data-dir requires a value")?)
            }
            _ if arg.starts_with('-') => return Err(format!("unknown option: {arg}")),
            _ if trace.is_none() => trace = Some(PathBuf::from(arg)),
            _ => return Err("only one trace may be supplied".into()),
        }
    }
    let trace = trace.ok_or("a trace path is required")?;
    Ok(Command::Open(OpenConfig {
        port,
        trace,
        data_dir,
    }))
}
fn heapviz_config_dir() -> Result<PathBuf, String> {
    if cfg!(windows) {
        env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .or_else(user_home)
            .map(|path| path.join("heapviz"))
            .ok_or("cannot find your local application-data directory".into())
    } else {
        env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .or_else(|| user_home().map(|home| home.join(".config")))
            .map(|path| path.join("heapviz"))
            .ok_or("cannot find your configuration directory".into())
    }
}

fn channel_url() -> Result<Url, String> {
    let value = match env::var("HEAPVIZ_CHANNEL_URL") {
        Ok(value) => value,
        Err(_) => {
            let path = heapviz_config_dir()?.join("channel-url");
            fs::read_to_string(&path).map_err(|_| {
                format!(
                    "no update channel is configured; reinstall heapviz from your hosted site ({})",
                    path.display()
                )
            })?
        }
    };
    let url = Url::parse(value.trim()).map_err(|_| "configured update channel is not a URL")?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("configured update channel must be an HTTP(S) URL without credentials".into());
    }
    Ok(url)
}

async fn fetch_channel() -> Result<(Url, Channel), String> {
    let source = channel_url()?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(4))
        .build()
        .map_err(|error| error.to_string())?;
    let response = client
        .get(source.clone())
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() {
        return Err(format!("release channel returned {}", response.status()));
    }
    let bytes = response.bytes().await.map_err(|error| error.to_string())?;
    if bytes.len() > MAX_CHANNEL_BYTES {
        return Err("release-channel manifest is too large".into());
    }
    let channel: Channel = serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
    validate_channel(&source, &channel)?;
    Ok((source, channel))
}

fn resolve_download(source: &Url, download: &Download) -> Result<Url, String> {
    let url = source
        .join(&download.url)
        .map_err(|_| "release channel contains an invalid download URL")?;
    if !matches!(url.scheme(), "http" | "https") || url.origin() != source.origin() {
        return Err("release-channel downloads must use the channel's own origin".into());
    }
    Ok(url)
}

fn validate_channel(source: &Url, channel: &Channel) -> Result<(), String> {
    if channel.schema_version != 1 {
        return Err(format!(
            "unsupported release-channel schema {}",
            channel.schema_version
        ));
    }
    if version_parts(&channel.latest_version).is_none() {
        return Err("release channel contains an invalid version".into());
    }
    for download in [
        channel.downloads.linux_x86_64.as_ref(),
        channel.downloads.windows_x86_64.as_ref(),
    ]
    .into_iter()
    .flatten()
    {
        resolve_download(source, download)?;
        if download.sha256.len() != 64
            || !download.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return Err("release channel contains an invalid download".into());
        }
    }
    Ok(())
}

fn version_parts(value: &str) -> Option<Vec<u64>> {
    value
        .split('.')
        .map(|part| part.split(['-', '+']).next()?.parse().ok())
        .collect()
}

fn version_is_newer(candidate: &str, current: &str) -> bool {
    match (version_parts(candidate), version_parts(current)) {
        (Some(mut a), Some(mut b)) => {
            let n = a.len().max(b.len());
            a.resize(n, 0);
            b.resize(n, 0);
            a > b
        }
        _ => false,
    }
}

fn install_skill(target: SkillTarget, force: bool) -> Result<(), String> {
    let path = skill_path(target)?;
    if let Ok(existing) = fs::read_to_string(&path) {
        if existing == SKILL {
            println!(
                "✓ {} skill is already current\n  {}",
                target.label(),
                path.display()
            );
            return Ok(());
        }
        if !force {
            return Err(format!(
                "{} already exists with different content; preserve it or rerun with --force",
                path.display(),
            ));
        }
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(&path, SKILL).map_err(|error| error.to_string())?;
    println!(
        "✓ Installed the heap-analysis-api skill for {}\n  {}",
        target.label(),
        path.display()
    );
    Ok(())
}

fn command_available<'a>(names: &'a [&'a str]) -> Option<&'a str> {
    let paths = env::var_os("PATH")?;
    let paths: Vec<PathBuf> = env::split_paths(&paths).collect();
    names.iter().copied().find(|name| {
        paths.iter().any(|directory| {
            let candidate = directory.join(name);
            if executable_file(&candidate) {
                return true;
            }
            #[cfg(windows)]
            return ["exe", "cmd", "bat"]
                .iter()
                .any(|extension| executable_file(&candidate.with_extension(extension)));
            #[cfg(not(windows))]
            false
        })
    })
}

fn executable_file(path: &std::path::Path) -> bool {
    let Ok(metadata) = fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(windows)]
    {
        true
    }
}

fn doctor() -> Result<(), String> {
    println!("heapviz {}\n", env!("CARGO_PKG_VERSION"));
    let data = default_data_dir();
    fs::create_dir_all(&data)
        .map_err(|error| format!("✗ data directory {}: {error}", data.display()))?;
    let probe = data.join(format!(
        ".doctor-{}",
        fresh_token().map_err(|error| error.to_string())?
    ));
    fs::write(&probe, b"heapviz").map_err(|error| {
        format!(
            "✗ data directory {} is not writable: {error}",
            data.display()
        )
    })?;
    fs::remove_file(&probe)
        .map_err(|error| format!("✗ cannot clean up {}: {error}", probe.display()))?;
    println!("✓ Data directory is writable\n  {}", data.display());
    match StdTcpListener::bind(SocketAddr::from(([127, 0, 0, 1], DEFAULT_PORT))) {
        Ok(_) => println!("✓ Local connection port {DEFAULT_PORT} is available"),
        Err(error) => {
            println!("! Port {DEFAULT_PORT} is in use ({error}); `--port` can select another")
        }
    }
    for (target, command) in [
        (SkillTarget::OpenCode, "opencode"),
        (SkillTarget::Claude, "claude"),
    ] {
        match skill_path(target) {
            Ok(path) if fs::read_to_string(&path).ok().as_deref() == Some(SKILL) =>
                println!("✓ {} skill is installed and current", target.label()),
            Ok(path) if path.exists() => println!(
                "! {} skill differs from this heapviz release\n  Run: heapviz setup {command} --force",
                target.label()
            ),
            Ok(_) => println!(
                "! {} skill is not installed\n  Run: heapviz setup {command}",
                target.label()
            ),
            Err(error) => println!("! Cannot locate the {} skill directory: {error}", target.label()),
        }
    }
    if let Some(name) = command_available(&["opencode2", "opencode"]) {
        println!("✓ OpenCode command found ({name})");
    } else {
        println!("! OpenCode command not found; install it before using the skill");
    }
    if command_available(&["claude"]).is_some() {
        println!("✓ Claude Code command found (claude)");
    } else {
        println!("! Claude Code command not found; install it before using the skill");
    }
    match channel_url() {
        Ok(url) => println!("✓ Self-hosted update channel configured\n  {url}"),
        Err(error) => println!("! {error}"),
    }
    Ok(())
}

async fn run_server(config: OpenConfig) -> Result<(), String> {
    let trace = TraceFile::open(&config.trace)
        .map_err(|error| format!("cannot read {}: {error}", config.trace.display()))?;
    let engine = trace
        .parse_engine()
        .map_err(|error| format!("cannot parse {}: {error}", config.trace.display()))?;
    let token = fresh_token()
        .map_err(|error| format!("could not generate a connection capability: {error}"))?;
    let address = SocketAddr::from(([127, 0, 0, 1], config.port));
    let api_url = format!("http://{address}");
    let state =
        ServerState::persistent(token.clone(), config.port, trace, engine, &config.data_dir)
            .map_err(|error| {
                format!(
                    "cannot load analysis from {}: {error}",
                    config.data_dir.display()
                )
            })?;
    let listener = TcpListener::bind(address)
        .await
        .map_err(|error| format!("cannot listen on {address}: {error}"))?;

    let channel = fetch_channel().await.ok().map(|(_, channel)| channel);
    println!("✓ Loaded {}", config.trace.display());
    println!("✓ Local analysis is ready at {api_url}");
    if let Some(channel) = &channel {
        if version_is_newer(&channel.latest_version, env!("CARGO_PKG_VERSION")) {
            eprintln!(
                "! heapviz {} is available; run `heapviz update`",
                channel.latest_version
            );
        }
    }
    let connection = connection_string(&api_url, &token);
    println!(
        "\nBrowser connection — copy the ENTIRE line, including everything after #:\n{connection}"
    );
    println!(
        "\nAI assistant — copy the ENTIRE instruction below (the URL without #… will not work):\nUse the heap-analysis-api skill to inspect the active trace. Connect with this complete connection string, including its capability after #: {connection}"
    );
    println!("\nKeep this window open. Press Ctrl+C to stop.");

    axum::serve(listener, router(state))
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await
        .map_err(|error| format!("server failed: {error}"))
}

fn platform_download(channel: &Channel) -> Option<&Download> {
    #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
    {
        channel.downloads.linux_x86_64.as_ref()
    }
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    {
        channel.downloads.windows_x86_64.as_ref()
    }
    #[cfg(not(any(
        all(target_os = "linux", target_arch = "x86_64"),
        all(target_os = "windows", target_arch = "x86_64")
    )))]
    {
        None
    }
}

async fn update() -> Result<(), String> {
    let (source, channel) = fetch_channel().await?;
    if !version_is_newer(&channel.latest_version, env!("CARGO_PKG_VERSION")) {
        println!("✓ heapviz {} is current", env!("CARGO_PKG_VERSION"));
        return Ok(());
    }
    let download =
        platform_download(&channel).ok_or("this platform has no automatic update artifact")?;
    let download_url = resolve_download(&source, download)?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|error| error.to_string())?;
    let response = client
        .get(download_url)
        .send()
        .await
        .map_err(|error| error.to_string())?
        .error_for_status()
        .map_err(|error| error.to_string())?;
    if response
        .content_length()
        .is_some_and(|length| length > MAX_UPDATE_BYTES as u64)
    {
        return Err("update artifact is too large".into());
    }
    let bytes = response.bytes().await.map_err(|error| error.to_string())?;
    if bytes.len() > MAX_UPDATE_BYTES {
        return Err("update artifact is too large".into());
    }
    let digest = format!("{:x}", Sha256::digest(&bytes));
    if digest != download.sha256.to_ascii_lowercase() {
        return Err("download checksum did not match the release channel".into());
    }
    let current = env::current_exe().map_err(|error| error.to_string())?;
    let pending = current.with_extension("heapviz-update");
    fs::write(&pending, &bytes).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&pending, fs::Permissions::from_mode(0o755))
            .map_err(|error| error.to_string())?;
        fs::rename(&pending, &current)
            .map_err(|error| format!("cannot replace {}: {error}", current.display()))?;
        println!("✓ Updated heapviz to {}", channel.latest_version);
        println!("  Refresh installed skills with `heapviz setup <opencode|claude> --force`.");
    }
    #[cfg(windows)]
    {
        let script = current.with_extension("heapviz-update.cmd");
        let body = format!("@echo off\r\n:retry\r\nmove /Y \"{}\" \"{}\" >nul 2>nul || (timeout /t 1 /nobreak >nul & goto retry)\r\ndel \"%~f0\"\r\n", pending.display(), current.display());
        fs::write(&script, body).map_err(|error| error.to_string())?;
        ProcessCommand::new("cmd")
            .args(["/C", "start", "", "/MIN", script.to_string_lossy().as_ref()])
            .spawn()
            .map_err(|error| error.to_string())?;
        println!(
            "✓ Downloaded heapviz {}; replacement will finish after this command exits",
            channel.latest_version
        );
        println!("  Then refresh installed skills with `heapviz setup <opencode|claude> --force`.");
    }
    Ok(())
}

#[tokio::main]
async fn main() {
    let command = match parse_args(env::args().skip(1)) {
        Ok(command) => command,
        Err(error) => {
            eprintln!("error: {error}\n\n{}", usage());
            std::process::exit(2);
        }
    };
    let result = match command {
        Command::Help => {
            println!("{}", usage());
            Ok(())
        }
        Command::Open(config) => run_server(config).await,
        Command::SetupSkill { target, force } => install_skill(target, force),
        Command::Doctor => doctor(),
        Command::Update => update().await,
    };
    if let Err(error) = result {
        eprintln!("error: {error}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_trace_argument_is_open() {
        match parse_args(["trace.heapl".into()]).unwrap() {
            Command::Open(config) => assert_eq!(config.trace, PathBuf::from("trace.heapl")),
            _ => panic!("expected open"),
        }
    }

    #[test]
    fn claude_setup_is_a_first_class_command() {
        assert!(matches!(
            parse_args(["setup".into(), "claude".into()]).unwrap(),
            Command::SetupSkill {
                target: SkillTarget::Claude,
                force: false
            }
        ));
    }

    #[test]
    fn version_comparison_is_numeric() {
        assert!(version_is_newer("0.10.0", "0.2.0"));
        assert!(!version_is_newer("0.2.0", "0.2.0"));
    }

    #[test]
    fn release_channel_rejects_insecure_downloads() {
        let channel = Channel {
            schema_version: 1,
            latest_version: "0.2.0".into(),
            downloads: Downloads {
                linux_x86_64: Some(Download {
                    url: "http://downloads.example/heapviz".into(),
                    sha256: "a".repeat(64),
                }),
                windows_x86_64: None,
            },
        };
        let source =
            Url::parse("https://downloads.example/downloads/heapviz-channel.json").unwrap();
        assert!(validate_channel(&source, &channel).is_err());
    }
}
