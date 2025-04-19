#!/usr/bin/env bash
set -e

# Get the directory of this script
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
# Get the root directory of the project
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

# Create a runs directory if it doesn't exist
mkdir -p "$SCRIPT_DIR/runs"

# Determine a unique run ID based on timestamp
RUN_ID=$(date +%Y%m%d%H%M%S)
RUN_DIR="$SCRIPT_DIR/runs/$RUN_ID"
mkdir -p "$RUN_DIR"

# Read the command from task.yaml
COMMAND=$(grep -A 10 "command:" "$SCRIPT_DIR/task.yaml" | tail -n +2 | sed -e 's/^[ \t]*//' | grep -v "^$" | grep -v "^#")

# Display information about the run
echo "======================================================"
echo "🏗️ Running Multi-Agent Architecture Demo"
echo "Run ID: $RUN_ID"
echo "Run Directory: $RUN_DIR"
echo "Command: $COMMAND"
echo "======================================================"

# Run the command and capture the output
cd "$PROJECT_ROOT"
$COMMAND | tee "$RUN_DIR/output.log"

# Create a README with information about this run
cat > "$RUN_DIR/README.md" << EOF
# Multi-Agent Architecture Demo Run

**Run ID:** $RUN_ID
**Date:** $(date)
**Command:** \`$COMMAND\`

## Description

This example demonstrates the Architect/Coder multi-agent architecture in Codex.
The demo shows how the Architect plans a series of changes that are then executed by the Coder model.

## Key Components

1. The Architect creates a plan with multiple actions
2. The Coder implements each action one by one 
3. Tests are run to verify the implementation
4. Telemetry showing the cost savings compared to a single-agent approach

## Output

See the complete output in [output.log](./output.log).
EOF

echo "======================================================"
echo "✅ Demo completed!"
echo "Results saved to: $RUN_DIR"
echo "======================================================"