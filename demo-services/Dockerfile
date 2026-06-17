# Mock microservices — six trivial, dependency-free Bun processes.
# One image serves all six; docker-compose.yml overrides `command:` per service
# (e.g. `bun demo-services/gateway.ts`).
FROM oven/bun:1.3.6
WORKDIR /app
COPY . ./demo-services
# 8081 gateway · 8082 app-ui · 8083 app-api · 8084 auth · 8085 pgsql · 8086 redis
EXPOSE 8081 8082 8083 8084 8085 8086
CMD ["bun", "demo-services/gateway.ts"]
