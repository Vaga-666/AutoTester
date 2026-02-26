import { initDb } from "./index.js";
import { MacroRepository } from "./repository.js";
import { PostgresRepository } from "./repository.postgres.js";

let cachedPostgres: PostgresRepository | null = null;

type SqliteRepository = {
  list(): Promise<Array<{ id: number; name: string }>>;
  listRecent(limit?: number): Promise<Array<{ id: number; name: string; base_url: string | null; description: string | null }>>;
  createMacro(params: { name: string; description?: string | null; baseUrl?: string | null; createdBy?: string | null }): Promise<number>;
  addSteps(macroId: number, steps: Array<{ orderIndex: number; actionType: string; locators: import("./repository.js").Locator[]; value?: string | null }>): Promise<void>;
  getMacro(macroId: number): Promise<{ id: number; name: string; base_url: string | null } | null>;
  getMacroWithDescription(macroId: number): Promise<{ id: number; name: string; base_url: string | null; description: string | null } | null>;
  renameMacro(params: { macroId: number; name: string }): Promise<boolean>;
  getSteps(macroId: number): Promise<import("./repository.js").MacroStep[]>;
  getAllSteps(macroId: number): Promise<import("./repository.js").MacroStep[]>;
  isStepInMacro(stepId: number, macroId: number): Promise<boolean>;
  disableStepByOrder(macroId: number, orderIndex: number): Promise<number>;
  disableStepById(stepId: number): Promise<number>;
  createRun(params: { macroId: number; envName: string; browser: string; headless: boolean }): Promise<number>;
  finishRun(runId: number, params: { status: string; summary?: object | null }): Promise<void>;
  addStepResult(params: {
    runId: number;
    stepId: number;
    status: string;
    errorMessage?: string | null;
    usedLocator?: object | null;
    screenshotPath?: string | null;
    startedAt?: string | null;
    finishedAt?: string | null;
  }): Promise<void>;
  getRunStepResults(runId: number): Promise<import("./repository.js").RunStepResult[]>;
  getRunMeta(runId: number): Promise<import("./repository.js").RunMeta | null>;
  addArtifact(params: { runId: number; type: string; storageUrl: string }): Promise<void>;
};

export type Repository = SqliteRepository | PostgresRepository;

class SqliteRepositoryWrapper implements SqliteRepository {
  constructor(private readonly inner: MacroRepository) {}

  async list(): Promise<Array<{ id: number; name: string }>> {
    return this.inner.list();
  }
  async listRecent(limit?: number): Promise<Array<{ id: number; name: string; base_url: string | null; description: string | null }>> {
    return this.inner.listRecent(limit);
  }
  async createMacro(params: { name: string; description?: string | null; baseUrl?: string | null; createdBy?: string | null }): Promise<number> {
    return this.inner.createMacro(params);
  }
  async addSteps(macroId: number, steps: Array<{ orderIndex: number; actionType: string; locators: import("./repository.js").Locator[]; value?: string | null }>): Promise<void> {
    return this.inner.addSteps(macroId, steps);
  }
  async getMacro(macroId: number): Promise<{ id: number; name: string; base_url: string | null } | null> {
    return this.inner.getMacro(macroId);
  }
  async getMacroWithDescription(macroId: number): Promise<{ id: number; name: string; base_url: string | null; description: string | null } | null> {
    return this.inner.getMacroWithDescription(macroId);
  }
  async renameMacro(params: { macroId: number; name: string }): Promise<boolean> {
    return this.inner.renameMacro(params);
  }
  async getSteps(macroId: number): Promise<import("./repository.js").MacroStep[]> {
    return this.inner.getSteps(macroId);
  }
  async getAllSteps(macroId: number): Promise<import("./repository.js").MacroStep[]> {
    return this.inner.getAllSteps(macroId);
  }
  async isStepInMacro(stepId: number, macroId: number): Promise<boolean> {
    return this.inner.isStepInMacro(stepId, macroId);
  }
  async disableStepByOrder(macroId: number, orderIndex: number): Promise<number> {
    return this.inner.disableStepByOrder(macroId, orderIndex);
  }
  async disableStepById(stepId: number): Promise<number> {
    return this.inner.disableStepById(stepId);
  }
  async createRun(params: { macroId: number; envName: string; browser: string; headless: boolean }): Promise<number> {
    return this.inner.createRun(params);
  }
  async finishRun(runId: number, params: { status: string; summary?: object | null }): Promise<void> {
    return this.inner.finishRun(runId, params);
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
    return this.inner.addStepResult(params);
  }
  async getRunStepResults(runId: number): Promise<import("./repository.js").RunStepResult[]> {
    return this.inner.getRunStepResults(runId);
  }
  async getRunMeta(runId: number): Promise<import("./repository.js").RunMeta | null> {
    return this.inner.getRunMeta(runId);
  }
  async addArtifact(params: { runId: number; type: string; storageUrl: string }): Promise<void> {
    return this.inner.addArtifact(params);
  }
}

export function getDbProvider(): "sqlite" | "postgres" {
  const provider = process.env.DB_PROVIDER?.toLowerCase();
  return provider === "postgres" ? "postgres" : "sqlite";
}

export async function createRepository(): Promise<Repository> {
  const provider = getDbProvider();
  if (provider === "postgres") {
    if (!cachedPostgres) {
      cachedPostgres = new PostgresRepository();
      await cachedPostgres.init();
    }
    return cachedPostgres;
  }
  const db = initDb();
  return new SqliteRepositoryWrapper(new MacroRepository(db));
}

export async function pingDatabase(): Promise<void> {
  const provider = getDbProvider();
  if (provider === "postgres") {
    const repo = (await createRepository()) as PostgresRepository;
    await repo.ping();
    return;
  }
  const db = initDb();
  db.prepare("SELECT 1").get();
}
