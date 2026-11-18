#!/bin/bash
set -e

# Always run from the project directory, no matter where the script is invoked
cd "$(dirname "$0")"

echo "=========================================="
echo "  Deploying GitHub Autopsy Update         "
echo "=========================================="

echo "1. Pulling latest code from GitHub..."
git pull

echo "2. Rebuilding and updating Docker containers..."
docker compose up --build -d

echo "3. Cleaning up old build images..."
docker image prune -f

echo "4. Checking container status..."
docker compose ps

echo "=========================================="
echo "  Deployment completed successfully! 🚀   "
echo "=========================================="
