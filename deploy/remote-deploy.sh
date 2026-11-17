#!/usr/bin/env bash
# Runs ON the EC2 instance (sent by GitHub Actions through SSM Run Command, as root).
# The workflow prepends two variables before sending it:
#   REGISTRY  e.g. 123456789012.dkr.ecr.eu-west-2.amazonaws.com
#   TAG       image tag to deploy, e.g. sha-1a2b3c4
#
# Replaces the `atlas` container with the new image, keeps the `atlas-data` volume,
# waits for the container health check and checks ports 80 and 8000.
# If the new image is not healthy, it rolls back to the image that was running before.
set -euo pipefail

: "${REGISTRY:?REGISTRY not set}" "${TAG:?TAG not set}"
IMAGE="$REGISTRY/atlas-chatbot:$TAG"
NAME=atlas

run_container() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker run -d --name "$NAME" --restart unless-stopped \
    -p 80:8000 -p 8000:8000 \
    -v atlas-data:/app/data \
    "$1" >/dev/null
}

wait_healthy() {
  local status=""
  for _ in $(seq 1 45); do
    status=$(docker inspect "$NAME" --format '{{.State.Health.Status}}' 2>/dev/null || echo missing)
    [ "$status" = healthy ] && return 0
    sleep 2
  done
  echo "container health: $status"
  return 1
}

echo "==> Logging in to ECR"
aws ecr get-login-password --region eu-west-2 | docker login --username AWS --password-stdin "$REGISTRY" >/dev/null 2>&1

echo "==> Pulling $IMAGE"
docker pull -q "$IMAGE"

PREVIOUS=$(docker inspect "$NAME" --format '{{.Config.Image}}' 2>/dev/null || true)
echo "==> Previous image: ${PREVIOUS:-none}"

echo "==> Starting new container"
run_container "$IMAGE"

if wait_healthy \
   && curl -fsS -m 5 http://127.0.0.1/api/health >/dev/null \
   && curl -fsS -m 5 http://127.0.0.1:8000/api/health >/dev/null; then
  echo "==> Healthy on ports 80 and 8000"
  docker ps --filter "name=^${NAME}$" --format '{{.Image}} | {{.Status}} | {{.Ports}}'
  # Free disk on the small instance: drop unused images older than 7 days (ECR still has them).
  docker image prune -af --filter "until=168h" >/dev/null || true
  echo "DEPLOYED $IMAGE"
  exit 0
fi

echo "!! New image is not healthy. Last log lines:"
docker logs --tail 40 "$NAME" 2>&1 || true

if [ -n "$PREVIOUS" ] && [ "$PREVIOUS" != "$IMAGE" ]; then
  echo "==> Rolling back to $PREVIOUS"
  run_container "$PREVIOUS"
  if wait_healthy; then echo "ROLLED BACK to $PREVIOUS"; else echo "!! Rollback is not healthy either"; fi
fi
exit 1
