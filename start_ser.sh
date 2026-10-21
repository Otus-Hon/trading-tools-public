#!/bin/bash
set -e

PROJECT="$(cd "$(dirname "$0")" && pwd)"
cd "$PROJECT"

# PATH for Node (Homebrew / common installs)
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

# Use the project-pinned Node runtime so native dependencies such as
# better-sqlite3 keep the same ABI between installs and app reopens.
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ -s "$NVM_DIR/nvm.sh" ]; then
  . "$NVM_DIR/nvm.sh"
  nvm use --silent
fi

# Prevent double-start (port 3000; change if yours differs)
if lsof -iTCP:3000 -sTCP:LISTEN -t >/dev/null 2>&1; then
  exit 0
fi

# `npm run dev` performs a SQLite ABI preflight and automatically rebuilds
# better-sqlite3 if it was installed by a different Node version.
nohup npm run dev > "$PROJECT/dev_server.log" 2>&1 &

# Save PID so we can stop it later
echo $! > "$PROJECT/dev_server.pid"
