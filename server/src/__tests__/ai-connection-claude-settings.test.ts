import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDb, companies, agents, companyMemberships } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "@paperclipai/db/test-embedded-postgres";
import { aiConnectionService } from "../services/ai-connections.js";
import { prepareManagedAiRuntime } from "../services/ai-connection-runtime.js";

let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>;
let home: string;
const companyId = randomUUID();
const agentId = randomUUID();
const owner = "claude-settings-owner";

beforeAll(async () => {
  home = await realpath(await mkdtemp(path.join(os.tmpdir(), "paperclip-ai-claude-settings-")));
  vi.stubEnv("PAPERCLIP_HOME", home);
  vi.stubEnv("PAPERCLIP_INSTANCE_ID", "ai-claude-settings-fixture");
  vi.stubEnv("CLAUDE_CONFIG_DIR", path.join(home, "operator-claude"));
  database = await startEmbeddedPostgresTestDatabase("paperclip-ai-claude-settings-db-");
  db = createDb(database.connectionString);
  await db.insert(companies).values({ id: companyId, name: "Claude settings tests", issuePrefix: "ACS" });
  await db.insert(agents).values({ id: agentId, companyId, name: "Nova", adapterType: "claude_local" });
  await db.insert(companyMemberships).values({ companyId, principalId: owner, principalType: "user", status: "active", membershipRole: "member" });
  await aiConnectionService(db).save(companyId, owner, { provider: "anthropic", method: "api_key", ownership: "personal", name: owner, apiKey: "fixture", agentIds: [], allAgents: true }, `fixture-${owner}`);
}, 90000);
afterAll(async () => { await database?.cleanup(); vi.unstubAllEnvs(); if (home) await rm(home, { recursive: true, force: true }); });

describe("managed Claude homes", () => {
  it("inherit the operator's preferences but never their commands or credentials", async () => {
    const operatorDir = path.join(home, "operator-claude");
    await mkdir(operatorDir, { recursive: true });
    await writeFile(path.join(operatorDir, "settings.json"), JSON.stringify({
      attribution: { commit: "", pr: "" }, hooks: { Stop: [] }, env: { ANTHROPIC_API_KEY: "operator-key" },
    }));
    await writeFile(path.join(operatorDir, ".credentials.json"), JSON.stringify({ token: "operator-login" }));
    const runtime = await prepareManagedAiRuntime(db, {
      companyId, agentId, responsibleUserId: owner, adapterType: "claude_local",
      binding: { provider: "anthropic", method: "api_key", mode: "responsible_user" }, config: {},
    });
    try {
      const providerHome = path.join(runtime.home!, "provider");
      expect(runtime.config.env).toMatchObject({ CLAUDE_CONFIG_DIR: providerHome });
      expect(JSON.parse(await readFile(path.join(providerHome, "settings.json"), "utf8"))).toEqual({ attribution: { commit: "", pr: "" } });
      await expect(access(path.join(providerHome, ".credentials.json"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await runtime.cleanup();
    }
  });
});
