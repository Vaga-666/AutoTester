import type Database from "better-sqlite3";

export type Locator =
  | { type: "data"; value: string }
  | { type: "role"; role: string; name?: string }
  | { type: "css"; value: string }
  | { type: "xpath"; value: string };

export type MacroStep = {
  id: number;
  macro_id: number;
  order_index: number;
  action_type: string;
  locators: Locator[];
  value: string | null;
  timeouts: string | null;
  enabled: number;
};

export type RunStepResult = {
  step_id: number;
  order_index: number;
  action_type: string;
  status: string;
  error_message: string | null;
  screenshot_path: string | null;
};

export type RunMeta = {
  env_name: string;
  browser: string;
  headless: number;
};

export class MacroRepository {
  constructor(private readonly db: Database.Database) {}

  list(): Array<{ id: number; name: string }> {
    const rows = this.db.prepare("SELECT id, name FROM macros ORDER BY id DESC").all();
    return rows as Array<{ id: number; name: string }>;
  }

  listRecent(limit = 30): Array<{ id: number; name: string; base_url: string | null; description: string | null }> {
    const rows = this.db
      .prepare("SELECT id, name, base_url, description FROM macros ORDER BY id DESC LIMIT ?")
      .all(limit);
    return rows as Array<{ id: number; name: string; base_url: string | null; description: string | null }>;
  }

  getMacroWithDescription(macroId: number): { id: number; name: string; base_url: string | null; description: string | null } | null {
    const row = this.db.prepare("SELECT id, name, base_url, description FROM macros WHERE id = ?").get(macroId);
    return (row as { id: number; name: string; base_url: string | null; description: string | null }) ?? null;
  }

  createMacro(params: { name: string; description?: string | null; baseUrl?: string | null; createdBy?: string | null }): number {
    const stmt = this.db.prepare(
      "INSERT INTO macros (name, description, base_url, created_by) VALUES (@name, @description, @baseUrl, @createdBy)"
    );
    const info = stmt.run({
      name: params.name,
      description: params.description ?? null,
      baseUrl: params.baseUrl ?? null,
      createdBy: params.createdBy ?? null,
    });
    return Number(info.lastInsertRowid);
  }

  addSteps(macroId: number, steps: Array<{ orderIndex: number; actionType: string; locators: Locator[]; value?: string | null }>): void {
    const stmt = this.db.prepare(
      "INSERT INTO macro_steps (macro_id, order_index, action_type, locators, value) VALUES (@macroId, @orderIndex, @actionType, @locators, @value)"
    );
    const tx = this.db.transaction(() => {
      for (const s of steps) {
        stmt.run({
          macroId,
          orderIndex: s.orderIndex,
          actionType: s.actionType,
          locators: JSON.stringify(s.locators ?? []),
          value: s.value ?? null,
        });
      }
    });
    tx();
  }

  getMacro(macroId: number): { id: number; name: string; base_url: string | null } | null {
    const row = this.db.prepare("SELECT id, name, base_url FROM macros WHERE id = ?").get(macroId);
    return (row as { id: number; name: string; base_url: string | null }) ?? null;
  }

  renameMacro(params: { macroId: number; name: string }): boolean {
    const stmt = this.db.prepare("UPDATE macros SET name = ? WHERE id = ?");
    const info = stmt.run(params.name, params.macroId);
    return info.changes > 0;
  }

  getSteps(macroId: number): MacroStep[] {
    const rows = this.db
      .prepare("SELECT id, macro_id, order_index, action_type, locators, value, timeouts, enabled FROM macro_steps WHERE macro_id = ? AND enabled = 1 ORDER BY order_index")
      .all(macroId);
    return (rows as Array<Omit<MacroStep, "locators"> & { locators: string | null }>).map((r) => ({
      ...r,
      locators: r.locators ? (JSON.parse(r.locators) as Locator[]) : [],
    }));
  }

  getAllSteps(macroId: number): MacroStep[] {
    const rows = this.db
      .prepare("SELECT id, macro_id, order_index, action_type, locators, value, timeouts, enabled FROM macro_steps WHERE macro_id = ? ORDER BY order_index")
      .all(macroId);
    return (rows as Array<Omit<MacroStep, "locators"> & { locators: string | null }>).map((r) => ({
      ...r,
      locators: r.locators ? (JSON.parse(r.locators) as Locator[]) : [],
    }));
  }

  isStepInMacro(stepId: number, macroId: number): boolean {
    const row = this.db.prepare("SELECT id FROM macro_steps WHERE id = ? AND macro_id = ?").get(stepId, macroId);
    return !!row;
  }

  disableStepByOrder(macroId: number, orderIndex: number): number {
    const stmt = this.db.prepare("UPDATE macro_steps SET enabled = 0 WHERE macro_id = ? AND order_index = ?");
    const info = stmt.run(macroId, orderIndex);
    return info.changes;
  }

  disableStepById(stepId: number): number {
    const stmt = this.db.prepare("UPDATE macro_steps SET enabled = 0 WHERE id = ?");
    const info = stmt.run(stepId);
    return info.changes;
  }

  createRun(params: { macroId: number; envName: string; browser: string; headless: boolean }): number {
    const stmt = this.db.prepare(
      "INSERT INTO runs (macro_id, env_name, browser, headless, status) VALUES (@macroId, @envName, @browser, @headless, @status)"
    );
    const info = stmt.run({
      macroId: params.macroId,
      envName: params.envName,
      browser: params.browser,
      headless: params.headless ? 1 : 0,
      status: "RUNNING",
    });
    return Number(info.lastInsertRowid);
  }

  finishRun(runId: number, params: { status: string; summary?: object | null }): void {
    const stmt = this.db.prepare("UPDATE runs SET status = @status, finished_at = datetime('now'), summary = @summary WHERE id = @runId");
    stmt.run({ runId, status: params.status, summary: params.summary ? JSON.stringify(params.summary) : null });
  }

  addStepResult(params: {
    runId: number;
    stepId: number;
    status: string;
    errorMessage?: string | null;
    usedLocator?: object | null;
    screenshotPath?: string | null;
    startedAt?: string | null;
    finishedAt?: string | null;
  }): void {
    const stmt = this.db.prepare(
      "INSERT INTO run_step_results (run_id, step_id, status, started_at, finished_at, error_message, used_locator, screenshot_path) VALUES (@runId, @stepId, @status, @startedAt, @finishedAt, @errorMessage, @usedLocator, @screenshotPath)"
    );
    stmt.run({
      runId: params.runId,
      stepId: params.stepId,
      status: params.status,
      startedAt: params.startedAt ?? null,
      finishedAt: params.finishedAt ?? null,
      errorMessage: params.errorMessage ?? null,
      usedLocator: params.usedLocator ? JSON.stringify(params.usedLocator) : null,
      screenshotPath: params.screenshotPath ?? null,
    });
  }

  getRunStepResults(runId: number): RunStepResult[] {
    const rows = this.db
      .prepare(
        "SELECT r.step_id, s.order_index, s.action_type, r.status, r.error_message, r.screenshot_path FROM run_step_results r JOIN macro_steps s ON r.step_id = s.id WHERE r.run_id = ? ORDER BY s.order_index"
      )
      .all(runId);
    return rows as RunStepResult[];
  }

  getRunMeta(runId: number): RunMeta | null {
    const row = this.db.prepare("SELECT env_name, browser, headless FROM runs WHERE id = ?").get(runId);
    return (row as RunMeta) ?? null;
  }

  addArtifact(params: { runId: number; type: string; storageUrl: string }): void {
    const stmt = this.db.prepare(
      "INSERT INTO artifacts (run_id, type, storage_url) VALUES (@runId, @type, @storageUrl)"
    );
    stmt.run({ runId: params.runId, type: params.type, storageUrl: params.storageUrl });
  }
}
