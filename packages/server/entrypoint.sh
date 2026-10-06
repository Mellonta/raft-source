#!/bin/sh
set -e

cd /app
exec node --import @oxc-node/core/register packages/server/src/server.ts
