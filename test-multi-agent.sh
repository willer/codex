#!/usr/bin/env bash
set -e

# Build the CLI
cd codex-cli
npm run build

# Create test config with multi-agent mode enabled
mkdir -p ~/.codex
cat > ~/.codex/config.json << EOF
{
  "model": "gpt-4o-mini",
  "multiAgent": true,
  "architectModel": "gpt-4o-mini",
  "coderModel": "gpt-3.5-turbo-0125",
  "coderTemp": 0.2
}
EOF

# Check if OPENAI_API_KEY is set
if [ -z "$OPENAI_API_KEY" ]; then
  echo "Error: OPENAI_API_KEY environment variable is not set"
  echo "Please set your OpenAI API key with: export OPENAI_API_KEY=your-key-here"
  exit 1
fi

# Run the CLI in quiet mode with a simple prompt
cd ..
./codex-cli/dist/cli.js -q --multi-agent "What is the current date?"

echo ""
echo "Test completed! To use multi-agent mode, run codex with the --multi-agent flag:"
echo "  codex --multi-agent \"your prompt here\""