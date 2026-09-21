#!/bin/sh
set -e

echo "=== [invoice-service] Starting Container Setup ==="

DB_HOST="${DATABASE_HOST:-}"
DB_PORT="${DATABASE_PORT:-3306}"

if [ -z "$DB_HOST" ] && [ -n "$DATABASE_URL" ]; then
  DB_HOST=$(printf '%s' "$DATABASE_URL" | sed -E 's#.*://([^:/]+).*#\1#')
  DB_PORT=$(printf '%s' "$DATABASE_URL" | sed -nE 's#.*://[^:]+:([0-9]+).*#\1#p')
  if [ -z "$DB_PORT" ]; then
    DB_PORT="3306"
  fi
fi

if [ -n "$DB_HOST" ]; then
  echo "Waiting for MySQL database at $DB_HOST:$DB_PORT..."
  while ! node -e "const net = require('net'); const socket = net.createConnection({ host: process.argv[1], port: Number(process.argv[2]) }); socket.once('connect', () => { socket.destroy(); process.exit(0); }); socket.once('error', () => { socket.destroy(); process.exit(1); });" "$DB_HOST" "$DB_PORT"; do
    sleep 1
  done
  echo "MySQL is up and reachable!"
fi

# Run database migrations in production/staging environments
if [ "$NODE_ENV" = "production" ] || [ "$AUTO_MIGRATE" = "true" ]; then
  echo "Running Prisma database migrations..."
  npx prisma migrate deploy
fi

echo "=== [invoice-service] Container Initialization Complete ==="

# Execute CMD passed from Dockerfile
exec "$@"