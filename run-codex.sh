#!/bin/bash

# Load NVM and use Node.js 20
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh"
nvm use 20 &>/dev/null

# Run codex with the provided arguments
./codex "$@"