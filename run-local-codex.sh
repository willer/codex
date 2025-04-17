#!/usr/bin/env bash
# A simple script to run the local development version of Codex CLI

# Build the project first (remove this if you want to skip building every time)
(cd /Users/willer/GitHub/codex/codex-cli && npm run build)

# Run the local CLI directly
node /Users/willer/GitHub/codex/codex-cli/dist/cli.js "$@"