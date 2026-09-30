# Image for `"sandbox": { "image": "braid-claude", "agent": true, "env": ["CLAUDE_CODE_OAUTH_TOKEN"] }`.
# Build:  docker build -t braid-claude examples/sandbox
# Auth:   run `claude setup-token` once, then export CLAUDE_CODE_OAUTH_TOKEN (or ANTHROPIC_API_KEY) in the
#         shell that runs braid. braid passes the variable by name; it never reads or stores the value.
# Add whatever your repo's `setup` and `verify` commands need (python, go, build tools, ...).
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
RUN npm install -g @anthropic-ai/claude-code
