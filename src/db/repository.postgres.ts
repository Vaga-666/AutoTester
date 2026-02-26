import pg from "pg";
import type { Locator, MacroStep, RunMeta, RunStepResult } from "./repository.js";

const { Pool } = pg;

type PgConfig = {
  connectionString?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
};

type MacroStepRow = {
  id: number;
  macro_id: number;
  order_index: number;
  action_type: string;
  locators: string | null;
  value: string | null;
  timeouts: string | null;
  enabled: number;
};

const schemaStatements = [
  `CREATE TABLE IF NOT EXISTS macros (
    id BIGSERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    base_url TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by TEXT
  );`,
  `CREATE TABLE IF NOT EXISTS macro_steps (
    id BIGSERIAL PRIMARY KEY,
    macro_id BIGINT NOT NULL REFERENCES macros(id) ON DELETE CASCADE,
    order_index INTEGER NOT NULL,
    action_type TEXT NOT NULL,
    locators TEXT,
    value TEXT,
    timeouts TEXT,
    enabled INTEGER NOT NULL DEFAULT 1
  );`,
  `CREATE TABLE IF NOT EXISTS runs (
    id BIGSERIAL PRIMARY KEY,
    macro_id BIGINT NOT NULL REFERENCES macros(id) ON DELETE CASCADE,
    env_name TEXT NOT NULL,
    browser TEXT NOT NULL,
    headless INTEGER NOT NULL,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at TIMESTAMPTZ,
    status TEXT,
    summary TEXT
  );`,
  `CREATE TABLE IF NOT EXISTS run_step_results (
    id BIGSERIAL PRIMARY KEY,
    run_id BIGINT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    step_id BIGINT NOT NULL REFERENCES macro_steps(id) ON DELETE CASCADE,
    status TEXT NOT NULL,
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    error_message TEXT,
    used_locator TEXT,
    screenshot_path TEXT,
    artifact_refs TEXT
  );`,
  `CREATE TABLE IF NOT EXISTS artifacts (
    id BIGSERIAL PRIMARY KEY,
    run_id BIGINT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    storage_url TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );`,
];

function buildPgConfig(): PgConfig {
  const connectionString = process.env.DATABASE_URL;
  if (connectionString && connectionString.trim().length > 0) {
    return { connectionString };
  }
  const port = process.env.PGPORT ? Number(process.env.PGPORT) : undefined;
  return {
    host: process.env.PGHOST,
    port: Number.isFinite(port) ? port : undefined,
    database: process.env.PGDATABASE,
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
  };
}

export class PostgresRepository {
  private readonly pool: pg.Pool;
  private initialized = false;

  constructor() {
    this.pool = new Pool(buildPgConfig());
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    for (const stmt of schemaStatements) {
      await this.pool.query(stmt);
    }
    this.initialized = true;
  }

  async ping(): Promise<void> {
    await this.pool.query("SELECT 1");
  }

  async list(): Promise<Array<{ id: number; name: string }>> {
    const res = await this.pool.query("SELECT id, name FROM macros ORDER BY id DESC");
    return res.rows as Array<{ id: number; name: string }>;
  }

  async listRecent(limit = 30): Promise<Array<{ id: number; name: string; base_url: string | null; description: string | null }>> {
    const res = await this.pool.query("SELECT id, name, base_url, description FROM macros ORDER BY id DESC LIMIT $1", [limit]);
    return res.rows as Array<{ id: number; name: string; base_url: string | null; description: string | null }>;
  }

  async getMacroWithDescription(
    macroId: number
  ): Promise<{ id: number; name: string; base_url: string | null; description: string | null } | null> {
    const res = await this.pool.query("SELECT id, name, base_url, description FROM macros WHERE id = $1", [macroId]);
    return (res.rows[0] as { id: number; name: string; base_url: string | null; description: string | null }) ?? null;
  }

  async createMacro(params: { name: string; description?: string | null; baseUrl?: string | null; createdBy?: string | null }): Promise<number> {
    const res = await this.pool.query(
      "INSERT INTO macros (name, description, base_url, created_by) VALUES ($1, $2, $3, $4) RETURNING id",
      [params.name, params.description ?? null, params.baseUrl ?? null, params.createdBy ?? null]
    );
    return Number(res.rows[0]?.id);
  }

  async addSteps(macroId: number, steps: Array<{ orderIndex: number; actionType: string; locators: Locator[]; value?: string | null }>): Promise<void> {
    for (const s of steps) {
      await this.pool.query(
        "INSERT INTO macro_steps (macro_id, order_index, action_type, locators, value) VALUES ($1, $2, $3, $4, $5)",
        [macroId, s.orderIndex, s.actionType, JSON.stringify(s.locators ?? []), s.value ?? null]
      );
    }
  }

  async getMacro(macroId: number): Promise<{ id: number; name: string; base_url: string | null } | null> {
    const res = await this.pool.query("SELECT id, name, base_url FROM macros WHERE id = $1", [macroId]);
    return (res.rows[0] as { id: number; name: string; base_url: string | null }) ?? null;
  }

  async renameMacro(params: { macroId: number; name: string }): Promise<boolean> {
    const res = await this.pool.query("UPDATE macros SET name = $1 WHERE id = $2", [params.name, params.macroId]);
    const rc = res.rowCount ?? 0;
    return rc > 0;
  }

  async getSteps(macroId: number): Promise<MacroStep[]> {
    const res = await this.pool.query<MacroStepRow>(
      "SELECT id, macro_id, order_index, action_type, locators, value, timeouts, enabled FROM macro_steps WHERE macro_id = $1 AND enabled = 1 ORDER BY order_index",
      [macroId]
    );
    return res.rows.map((r) => ({
      ...r,
      locators: r.locators ? (JSON.parse(r.locators) as Locator[]) : [],
    })) as MacroStep[];
  }

  async getAllSteps(macroId: number): Promise<MacroStep[]> {
    const res = await this.pool.query<MacroStepRow>(
      "SELECT id, macro_id, order_index, action_type, locators, value, timeouts, enabled FROM macro_steps WHERE macro_id = $1 ORDER BY order_index",
      [macroId]
    );
    return res.rows.map((r) => ({
      ...r,
      locators: r.locators ? (JSON.parse(r.locators) as Locator[]) : [],
    })) as MacroStep[];
  }

  async isStepInMacro(stepId: number, macroId: number): Promise<boolean> {
    const res = await this.pool.query("SELECT id FROM macro_steps WHERE id = $1 AND macro_id = $2", [stepId, macroId]);
    const rc = res.rowCount ?? 0;
    return rc > 0;
  }

  async disableStepByOrder(macroId: number, orderIndex: number): Promise<number> {
    const res = await this.pool.query("UPDATE macro_steps SET enabled = 0 WHERE macro_id = $1 AND order_index = $2", [
      macroId,
      orderIndex,
    ]);
    return res.rowCount ?? 0;
  }

  async disableStepById(stepId: number): Promise<number> {
    const res = await this.pool.query("UPDATE macro_steps SET enabled = 0 WHERE id = $1", [stepId]);
    return res.rowCount ?? 0;
  }

  async createRun(params: { macroId: number; envName: string; browser: string; headless: boolean }): Promise<number> {
    const res = await this.pool.query(
      "INSERT INTO runs (macro_id, env_name, browser, headless, status) VALUES ($1, $2, $3, $4, $5) RETURNING id",
      [params.macroId, params.envName, params.browser, params.headless ? 1 : 0, "RUNNING"]
    );
    return Number(res.rows[0]?.id);
  }

  async finishRun(runId: number, params: { status: string; summary?: object | null }): Promise<void> {
    await this.pool.query("UPDATE runs SET status = $1, finished_at = NOW(), summary = $2 WHERE id = $3", [
      params.status,
      params.summary ? JSON.stringify(params.summary) : null,
      runId,
    ]);
  }

  async addStepResult(params: {
    runId: number;
    stepId: number;
    status: string;
    errorMessage?: string | null;
    usedLocator?: object | null;
    screenshotPath?: string | null;
    startedAt?: string | null;
    finishedAt?: string | null;
  }): Promise<void> {
    await this.pool.query(
      "INSERT INTO run_step_results (run_id, step_id, status, started_at, finished_at, error_message, used_locator, screenshot_path) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
      [
        params.runId,
        params.stepId,
        params.status,
        params.startedAt ?? null,
        params.finishedAt ?? null,
        params.errorMessage ?? null,
        params.usedLocator ? JSON.stringify(params.usedLocator) : null,
        params.screenshotPath ?? null,
      ]
    );
  }

  async getRunStepResults(runId: number): Promise<RunStepResult[]> {
    const res = await this.pool.query(
      "SELECT r.step_id, s.order_index, s.action_type, r.status, r.error_message, r.screenshot_path FROM run_step_results r JOIN macro_steps s ON r.step_id = s.id WHERE r.run_id = $1 ORDER BY s.order_index",
      [runId]
    );
    return res.rows as RunStepResult[];
  }

  async getRunMeta(runId: number): Promise<RunMeta | null> {
    const res = await this.pool.query("SELECT env_name, browser, headless FROM runs WHERE id = $1", [runId]);
    return (res.rows[0] as RunMeta) ?? null;
  }

  async addArtifact(params: { runId: number; type: string; storageUrl: string }): Promise<void> {
    await this.pool.query("INSERT INTO artifacts (run_id, type, storage_url) VALUES ($1, $2, $3)", [
      params.runId,
      params.type,
      params.storageUrl,
    ]);
  }
}
