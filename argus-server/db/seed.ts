import type { Database } from "bun:sqlite";

export function seedIfEmpty(db: Database): void {
  const count = (db.query("SELECT COUNT(*) AS cnt FROM services").get() as { cnt: number }).cnt;
  if (count > 0) return;

  const services = [
    { name: "gateway", port: 8081, tier: "gateway", status: "healthy" },
    { name: "app-ui", port: 8082, tier: "frontend", status: "healthy" },
    { name: "app-api", port: 8083, tier: "backend", status: "healthy" },
    { name: "auth", port: 8084, tier: "auth", status: "healthy" },
    { name: "pgsql", port: 8085, tier: "database", status: "healthy" },
    { name: "redis", port: 8086, tier: "cache", status: "healthy" },
  ];

  const insertService = db.query(
    "INSERT INTO services (name, port, tier, status) VALUES (?, ?, ?, ?)"
  );

  for (const svc of services) {
    insertService.run(svc.name, svc.port, svc.tier, svc.status);
  }

  // Seed some example deployments so the agent can check recent changes
  const now = new Date().toISOString();
  const yesterday = new Date(Date.now() - 86400000).toISOString();
  const twoDaysAgo = new Date(Date.now() - 172800000).toISOString();

  const deployments = [
    { service: "gateway", version: "2.4.1", commit_sha: "a1b2c3d", deployed_by: "ci-pipeline", deployed_at: now },
    { service: "app-api", version: "3.8.0", commit_sha: "e4f5g6h", deployed_by: "ci-pipeline", deployed_at: yesterday },
    { service: "auth", version: "1.12.3", commit_sha: "i7j8k9l", deployed_by: "ci-pipeline", deployed_at: twoDaysAgo },
  ];

  const serviceByName: Record<string, number> = {};
  for (const svc of db.query("SELECT id, name FROM services").all() as { id: number; name: string }[]) {
    serviceByName[svc.name] = svc.id;
  }

  const insertDeployment = db.query(
    "INSERT INTO deployments (service_id, version, commit_sha, deployed_by, deployed_at) VALUES (?, ?, ?, ?, ?)"
  );

  for (const dep of deployments) {
    const serviceId = serviceByName[dep.service];
    if (serviceId) {
      insertDeployment.run(serviceId, dep.version, dep.commit_sha, dep.deployed_by, dep.deployed_at);
    }
  }

  console.log(`[seed] Seeded ${services.length} services and ${deployments.length} deployments`);
}