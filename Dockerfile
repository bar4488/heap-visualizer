# The feature-request service (spec 11), and nothing else.
#
# There is no toolchain in here on purpose: `./build.sh` against a local Rust +
# tsc is still the one build path (TOOL-002), and `dist/` is bind-mounted in by
# docker-compose.yml rather than compiled here. An image that could build the
# app is the thing T038 removed, and D010 is why this is allowed not to be one.
FROM python:3.12-slim

# stdlib only (D010), so there is nothing to install.
WORKDIR /app
COPY src/server/ /app/server/

ENV HEAP_DIST=/app/dist \
    HEAP_REQUESTS_PATH=/data/requests.jsonl \
    PORT=8630
EXPOSE 8630

# Unbuffered, so `docker compose logs` shows the access log as it happens.
CMD ["python3", "-u", "/app/server/app.py"]
