# heapviz & AI agents

`heapviz` is a small companion program that runs on your computer. It opens a
trace there and serves it to this page, and to an AI assistant, over an
authenticated connection to your own machine. Nothing is uploaded.

## Why use it

- Large traces stream in without the browser holding the whole file.
- Names, tags, filters, and marks are saved on your computer and come back
  when you reopen the trace.
- An AI assistant can analyze the same trace you are looking at.

For a quick look you do not need it: [File → Open trace…](#do:btn-open) reads a file directly.

## Install

- Open [File → Setup…](#do:btn-setup) and pick Linux or Windows.
- Copy the one-line **Install** command into a terminal. Setup always shows
  the commands for this site.

## Open a trace

```
heapviz open TRACE_FILE
```

- Keep that terminal open while you work.
- Copy the complete **Browser connection** it prints, including everything after `#`.
- Click the [connection pill](#show:conn-status) or [File → Connect…](#do:btn-connect) and paste it.

## Work with an AI agent

- Install the skill once:

```
heapviz setup claude
heapviz setup opencode
```

- Start a trace with `heapviz open TRACE_FILE`.
- Paste the complete **AI assistant** instruction it prints into Claude Code
  or OpenCode. The URL alone, without the part after `#`, cannot connect.
- Ask your question. For example: *"Which call sites leave memory unfreed at
  the end, and why? Tag the suspects."*

The assistant can read the overview and warnings, query and inspect
allocations, summarize by site, thread, or size, read the program's logs, and
create tags, names, colors, saved filters, and marks. Its changes appear in
this page as it makes them.

## Commands

- `heapviz open [--port PORT] [--data-dir PATH] TRACE_FILE` — serve a trace
  (default port 8631). `heapviz TRACE_FILE` is shorthand.
- `heapviz setup claude|opencode [--force]` — install the assistant skill;
  `--force` refreshes it.
- `heapviz doctor` — check the install, port, and skills.
- `heapviz update` — update heapviz, then rerun `heapviz setup … --force`.

## Privacy and security

- heapviz listens on `127.0.0.1` only; other machines cannot reach it.
- Each run prints a new secret capability (the part after `#`). Only a page or
  assistant holding it can connect, and it ends when heapviz stops.

Something not working? See [Fix a connection](#guide-troubleshooting).
