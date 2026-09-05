# Fix a connection

- Run the built-in checks:

```
heapviz doctor
```

- Keep the terminal that runs `heapviz open` open.
- Allow local-device or loopback access if the browser asks.
- If port 8631 is busy, run `heapviz open --port 8632 trace-file`.
- If the connection expired, restart `heapviz open` and paste the new complete connection.
- For **update required**, run `heapviz update` and reconnect.
- If an assistant cannot see the skill, rerun its `heapviz setup` command.

[Setup](#do:btn-setup) always shows this site's current commands.
