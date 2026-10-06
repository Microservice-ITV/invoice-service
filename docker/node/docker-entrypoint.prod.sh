#!/bin/sh

set -e

echo "========================================="
echo "Starting Invoice Service"
echo "========================================="

echo "Running Prisma migrations..."

if ! npx prisma migrate deploy; then
    echo "❌ Prisma migration failed"
    exit 1
fi

echo "✅ Prisma migrations completed"

echo "Starting production server..."

exec "$@"
