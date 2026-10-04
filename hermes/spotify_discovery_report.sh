#!/bin/sh
# For a Hermes no_agent cron job: prints lane reports that are ready (Hermes
# posts them), or nothing (a silent run). Set the paths for your install.
export SPOTIFY_DISCOVERY_DIR="${SPOTIFY_DISCOVERY_DIR:-/opt/data/sandbox/spotify_discovery}"
exec node "${SPOTIFY_DISCOVERY_CLI:-/opt/data/mcp/spotify-discovery-mcp/dist/cli.js}" report
