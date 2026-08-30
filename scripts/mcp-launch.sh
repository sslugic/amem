#!/bin/sh
# amem MCP launcher for GUI hosts (Claude Desktop / Cowork).
#
# GUI apps are not launched from a login shell, so they inherit a minimal PATH
# with no Homebrew and no nvm. A host configured with a bare `amem` or `node`
# command registers the connector but never completes tool discovery. This
# script resolves node at spawn time and execs the amem stdio MCP server.
#
# Set AMEM_NODE to pin a specific node binary. Extra args are passed through.
DIR=$(cd "$(dirname "$0")/.." && pwd)
NODE=""
for c in \
  "$AMEM_NODE" \
  "$(command -v node 2>/dev/null)" \
  /opt/homebrew/bin/node \
  /usr/local/bin/node \
  "$HOME/.homebrew/bin/node" \
  /usr/bin/node
do
  if [ -n "$c" ] && [ -x "$c" ]; then NODE="$c"; break; fi
done
if [ -z "$NODE" ]; then
  echo "amem-mcp: node 20+ not found. Set AMEM_NODE=/path/to/node in the host's MCP env." >&2
  exit 1
fi
exec "$NODE" "$DIR/dist/cli.js" mcp "$@"
