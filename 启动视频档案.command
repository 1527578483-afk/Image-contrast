#!/bin/bash
cd "$(dirname "$0")"
export PATH="$HOME/.local/node-v20.19.4-darwin-arm64/bin:$PATH"
unset ELECTRON_RUN_AS_NODE
npm start
