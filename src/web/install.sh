#!/usr/bin/env sh
set -eu

base="${HEAPVIZ_DOWNLOAD_BASE:-}"
if [ -z "$base" ]; then
  echo "HEAPVIZ_DOWNLOAD_BASE is required; use the install command shown by your hosted heap visualizer" >&2
  exit 1
fi
base=${base%/}

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64|Linux-amd64) asset=heapviz-linux-x86_64 ;;
  *) echo "heapviz currently provides an automatic installer for Linux x86-64 only" >&2; exit 1 ;;
esac

bin_dir="${HEAPVIZ_BIN_DIR:-$HOME/.local/bin}"
config_dir="${XDG_CONFIG_HOME:-$HOME/.config}/heapviz"
mkdir -p "$bin_dir" "$config_dir"
tmp="$bin_dir/.heapviz-download-$$"
sum="$tmp.sha256"
trap 'rm -f "$tmp" "$sum"' EXIT HUP INT TERM
curl -fL "$base/downloads/$asset" -o "$tmp"
curl -fL "$base/downloads/$asset.sha256" -o "$sum"
expected=$(tr -d '[:space:]' < "$sum")
actual=$(sha256sum "$tmp" | awk '{print $1}')
[ "$actual" = "$expected" ] || { echo "heapviz download checksum did not match" >&2; exit 1; }
chmod 755 "$tmp"
mv "$tmp" "$bin_dir/heapviz"
printf '%s\n' "$base/downloads/heapviz-channel.json" > "$config_dir/channel-url"
trap - EXIT HUP INT TERM
rm -f "$sum"

echo "Installed heapviz at $bin_dir/heapviz"
echo "Updates will come from $base"
case ":${PATH:-}:" in
  *":$bin_dir:"*) ;;
  *) echo "Add $bin_dir to PATH, then open a new terminal." ;;
esac
echo "Next: heapviz doctor"
