# argus-executor — the only component that touches /var/run/docker.sock.
# It exposes POST /execute and runs only pre-approved actions against an allowlist.
#
# Build context is the argus-executor/ directory:
#   docker build -f argus-executor/Dockerfile ./argus-executor

# Copy a static Docker CLI binary so the Bun image does not need Docker-in-Docker.
FROM docker:27-cli AS docker

FROM oven/bun:1.3.6

COPY --from=docker /usr/local/bin/docker /usr/local/bin/docker

WORKDIR /app/argus-executor
COPY package.json ./
RUN bun install

COPY . ./

EXPOSE 3001
ENV EXECUTOR_PORT=3001
CMD ["bun", "run", "main.ts"]
