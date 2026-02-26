import "dotenv/config";
import { Command } from "commander";
import { createRepository, getDbProvider, pingDatabase } from "./db/factory.js";
import { recordMacro } from "./recorder/index.js";
import { runMacro } from "./runner/index.js";
import { type Locator } from "./db/repository.js";
import fs from "node:fs";
import path from "node:path";
import { renderHtmlReport } from "./reporting.js";

const program = new Command();

program
  .name("autotester")
  .description("UI macro recorder/runner for browser tests")
  .version("0.1.0");

async function getRepoOrExit(): Promise<Awaited<ReturnType<typeof createRepository>> | null> {
  try {
    return await createRepository();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`cannot connect to ${getDbProvider()}: ${message}`);
    process.exitCode = 1;
    return null;
  }
}

program
  .command("db:init")
  .description("initialize SQLite schema")
  .action(async () => {
    const repo = await getRepoOrExit();
    if (!repo) return;
    console.log("DB initialized.");
  });

program
  .command("db:ping")
  .description("check database connectivity")
  .action(async () => {
    const provider = getDbProvider();
    console.log(`DB provider: ${provider}`);
    try {
      await pingDatabase();
      console.log("OK");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`cannot connect to ${provider}: ${message}`);
      process.exitCode = 1;
    }
  });

program
  .command("record")
  .description("record a macro")
  .argument("[url]", "base URL")
  .argument("[name]", "macro name")
  .option("--url <url>", "base URL")
  .option("--name <name>", "macro name")
  .action(async (urlArg: string | undefined, nameArg: string | undefined, options: { url?: string; name?: string }) => {
    const urlFromOption = typeof options.url === "string" ? options.url : undefined;
    const urlFromEnv = process.env.npm_config_url;
    const urlFromDefault = process.env.AUTOTESTER_BASE_URL;
    const url = urlFromOption ?? urlArg ?? urlFromDefault ?? urlFromEnv;
    const nameFromOption = typeof options.name === "string" ? options.name : undefined;
    const name = nameFromOption ?? nameArg ?? "Untitled macro";

    await recordMacro({ url, name });
  });

program
  .command("run")
  .description("run a macro")
  .argument("[macroId]", "macro id")
  .argument("[baseUrl]", "base URL")
  .argument("[env]", "environment name")
  .argument("[timeoutMs]", "navigation timeout in ms")
  .argument("[waitUntil]", "commit|domcontentloaded|load|networkidle")
  .option("--macro-id <id>", "macro id")
  .option("--env <name>", "environment name")
  .option("--base-url <url>", "override base URL")
  .option("--stop-on-fail <bool>", "stop on first failure (default true)", "true")
  .option("--headless <bool>", "run headless (default true)")
  .option("--headed", "run headed (alias for --headless false)")
  .option("--timeout-ms <number>", "navigation timeout in ms")
  .option("--wait-until <state>", "commit|domcontentloaded|load|networkidle")
  .action(
    async (
      macroIdArg: string | undefined,
      baseUrlArg: string | undefined,
      envArg: string | undefined,
      timeoutMsArg: string | undefined,
      waitUntilArg: string | undefined,
      options
    ) => {
    const stopOnFail = String(options.stopOnFail).toLowerCase() !== "false";
    const headless =
      options.headed === true ? false : typeof options.headless === "string" ? String(options.headless).toLowerCase() !== "false" : undefined;
    const timeoutMsValue = options.timeoutMs ?? timeoutMsArg;
    const timeoutMs = Number(timeoutMsValue);
    const waitUntilRaw = typeof options.waitUntil === "string" ? options.waitUntil.toLowerCase() : typeof waitUntilArg === "string" ? waitUntilArg.toLowerCase() : undefined;
    const waitUntil =
      waitUntilRaw === "commit" || waitUntilRaw === "domcontentloaded" || waitUntilRaw === "load" || waitUntilRaw === "networkidle"
        ? waitUntilRaw
        : undefined;
    const baseUrlFromDefault = process.env.AUTOTESTER_BASE_URL;
    await runMacro({
      macroId: options.macroId ?? macroIdArg,
      env: options.env ?? envArg,
      baseUrl: options.baseUrl ?? baseUrlArg ?? baseUrlFromDefault,
      stopOnFail,
      headless,
      timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : undefined,
      waitUntil,
    });
  });

program
  .command("list")
  .description("list macros")
  .action(async () => {
    const repo = await getRepoOrExit();
    if (!repo) return;
    const rows = await repo.list();
    if (rows.length === 0) {
      console.log("No macros found.");
      return;
    }

    const idWidth = Math.max(2, ...rows.map((r) => String(r.id).length));
    const nameWidth = Math.max(4, ...rows.map((r) => r.name.length));

    const header = `${"ID".padEnd(idWidth)}  ${"NAME".padEnd(nameWidth)}`;
    console.log(header);
    console.log(`${"-".repeat(idWidth)}  ${"-".repeat(nameWidth)}`);
    for (const r of rows) {
      console.log(`${String(r.id).padEnd(idWidth)}  ${r.name.padEnd(nameWidth)}`);
    }
  });

function formatLocator(loc: Locator): string {
  if (loc.type === "role") {
    return `role:${loc.role}${loc.name ? `:${loc.name}` : ""}`;
  }
  return `${loc.type}:${"value" in loc ? loc.value : ""}`;
}

program
  .command("macro:show")
  .description("show macro steps")
  .argument("[macroId]", "macro id")
  .option("--macro-id <id>", "macro id")
  .action(async (macroIdArg: string | undefined, options) => {
    const macroId = Number(options.macroId ?? macroIdArg);
    if (!Number.isFinite(macroId)) {
      console.error("Missing or invalid --macro-id");
      process.exitCode = 1;
      return;
    }

    const repo = await getRepoOrExit();
    if (!repo) return;
    const steps = await repo.getAllSteps(macroId);
    if (steps.length === 0) {
      console.log("No steps found.");
      return;
    }

    const header = "ORDER  EN  ACTION       LOCATORS                                  VALUE";
    console.log(header);
    console.log("-----  --  ----------  ----------------------------------------  -----");

    for (const s of steps) {
      const locs = s.locators ?? [];
      const locA = locs[0] ? formatLocator(locs[0]) : "-";
      const locB = locs[1] ? formatLocator(locs[1]) : "-";
      const locatorSummary = `${locA} | ${locB}`;
      const value = s.value ?? "";
      const action = s.action_type.padEnd(10).slice(0, 10);
      const order = String(s.order_index).padEnd(5).slice(0, 5);
      const enabled = String(s.enabled ?? 0).padEnd(2).slice(0, 2);
      const locatorCell = locatorSummary.padEnd(40).slice(0, 40);
      console.log(`${order}  ${enabled}  ${action}  ${locatorCell}  ${value}`);
    }
  });

program
  .command("macro:disable-step")
  .description("disable a macro step")
  .option("--macro-id <id>", "macro id")
  .option("--order <n>", "order index")
  .option("--step-id <id>", "step id")
  .action(async (options) => {
    const macroId = Number(options.macroId);
    const orderIndex = options.order ? Number(options.order) : NaN;
    const stepId = options.stepId ? Number(options.stepId) : NaN;

    if (Number.isFinite(stepId)) {
      const repo = await getRepoOrExit();
      if (!repo) return;
      if (Number.isFinite(macroId)) {
        const ok = await repo.isStepInMacro(stepId, macroId);
        if (!ok) {
          console.error("step-id does not belong to the given macro-id");
          process.exitCode = 1;
          return;
        }
      }
      const changes = await repo.disableStepById(stepId);
      if (changes === 0) {
        console.error("No steps updated.");
        process.exitCode = 1;
        return;
      }
      console.log("Step disabled.");
      return;
    }

    if (!Number.isFinite(macroId)) {
      console.error("Missing or invalid --macro-id");
      process.exitCode = 1;
      return;
    }

    if (!Number.isFinite(orderIndex)) {
      console.error("Provide --order or --step-id");
      process.exitCode = 1;
      return;
    }

    const repo = await getRepoOrExit();
    if (!repo) return;
    const changes = await repo.disableStepByOrder(macroId, orderIndex);
    if (changes === 0) {
      console.error("No steps updated.");
      process.exitCode = 1;
      return;
    }

    console.log("Step disabled.");
  });

program
  .command("macro:rename")
  .description("rename a macro")
  .option("--macro-id <number>", "macro id")
  .option("--name <string>", "new macro name")
  .action(async (options) => {
    const macroId = Number(options.macroId);
    if (!Number.isInteger(macroId) || macroId <= 0) {
      console.error("Missing or invalid --macro-id (must be a positive integer)");
      process.exitCode = 1;
      return;
    }

    const name = String(options.name ?? "").trim();
    if (name.length === 0) {
      console.error("Missing or invalid --name (must be non-empty)");
      process.exitCode = 1;
      return;
    }

    const repo = await getRepoOrExit();
    if (!repo) return;
    const renamed = await repo.renameMacro({ macroId, name });
    if (!renamed) {
      console.error(`Macro ${macroId} not found.`);
      process.exitCode = 1;
      return;
    }

    console.log(`Renamed macro ${macroId} to ${name}`);
  });

program
  .command("macro:seed-ui")
  .description("create a UI smoke macro using data-testid selectors")
  .argument("[name]", "macro name")
  .argument("[url]", "base URL (profile page)")
  .option("--name <string>", "macro name", "ui_smoke")
  .option("--url <url>", "base URL (profile page)")
  .action(async (nameArg: string | undefined, urlArg: string | undefined, options) => {
    const name = String(options.name ?? nameArg ?? "").trim();
    const url = String(options.url ?? urlArg ?? "").trim();
    if (name.length === 0 || url.length === 0) {
      console.error("Missing --name or --url");
      process.exitCode = 1;
      return;
    }

    const repo = await getRepoOrExit();
    if (!repo) return;
    const macroId = await repo.createMacro({ name, baseUrl: url });

    const steps = [
      { orderIndex: 1, actionType: "hover", locators: [{ type: "data" as const, value: '[data-testid="profile-link"]' }] },
      { orderIndex: 2, actionType: "assertCursor", locators: [{ type: "data" as const, value: '[data-testid="profile-link"]' }], value: "pointer" },
      { orderIndex: 3, actionType: "click", locators: [{ type: "data" as const, value: '[data-testid="profile-link"]' }] },
      { orderIndex: 4, actionType: "hover", locators: [{ type: "data" as const, value: '[data-testid="theme-toggle"]' }] },
      { orderIndex: 5, actionType: "click", locators: [{ type: "data" as const, value: '[data-testid="theme-toggle"]' }] },
      { orderIndex: 6, actionType: "hover", locators: [{ type: "data" as const, value: '[data-testid="continue-btn"]' }] },
      { orderIndex: 7, actionType: "assertCursor", locators: [{ type: "data" as const, value: '[data-testid="continue-btn"]' }], value: "pointer" },
      { orderIndex: 8, actionType: "click", locators: [{ type: "data" as const, value: '[data-testid="continue-btn"]' }] },
    ];

    await repo.addSteps(macroId, steps);
    console.log(`Seeded UI macro ${macroId} (${name})`);
  });

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

program
  .command("show-report")
  .description("show report by run id")
  .argument("[runId]", "run id")
  .argument("[format]", "text|json|html|junit")
  .option("--run-id <id>", "run id")
  .option("--format <format>", "text|json|html|junit", "text")
  .action(async (runIdArg: string | undefined, formatArg: string | undefined, options) => {
    const runId = Number(options.runId ?? runIdArg);
    if (!Number.isFinite(runId)) {
      console.error("Missing or invalid --run-id");
      process.exitCode = 1;
      return;
    }

    const reportPath = path.resolve(process.cwd(), "reports", `run-${runId}.json`);
    if (!fs.existsSync(reportPath)) {
      console.error(`Report not found: ${reportPath}`);
      process.exitCode = 1;
      return;
    }

    const report = JSON.parse(fs.readFileSync(reportPath, "utf-8"));
    const formatOption = typeof options.format === "string" ? options.format : undefined;
    const format =
      String((formatArg ?? (formatOption === "text" ? undefined : formatOption)) ?? "text").toLowerCase();

    if (format === "json") {
      console.log(fs.readFileSync(reportPath, "utf-8"));
      return;
    }

    if (format === "html") {
      const htmlPath = renderHtmlReport(report, reportPath);
      console.log(`HTML report: ${htmlPath}`);
      return;
    }

    if (format === "junit") {
      const repo = await getRepoOrExit();
      if (!repo) return;
      const results = await repo.getRunStepResults(runId);
      const tests = report.summary?.total ?? results.length;
      const failures = report.summary?.failed ?? 0;
      const skipped = report.summary?.skipped ?? 0;
      const runMeta = await repo.getRunMeta(runId);
      const envName = report.envName ?? runMeta?.env_name ?? "unknown";
      const browser = report.browser ?? runMeta?.browser ?? "unknown";
      const headlessValue =
        typeof report.headless === "boolean" ? report.headless : runMeta ? runMeta.headless === 1 : undefined;
      const headlessLabel = headlessValue === undefined ? "unknown" : headlessValue ? "headless" : "headed";
      const macroLabel = report.macroName ? String(report.macroName) : `macro-${report.macroId}`;
      const suiteName = `${macroLabel}__${envName}__${browser}__${headlessLabel}`;

      let xml = `<?xml version="1.0" encoding="UTF-8"?>\n`;
      xml += `<testsuite name="${escapeXml(suiteName)}" tests="${tests}" failures="${failures}" skipped="${skipped}">\n`;

      for (const r of results) {
        const caseName = `step-${r.order_index}-${r.action_type}`;
        xml += `  <testcase name="${escapeXml(caseName)}">`;
        if (r.status === "FAIL") {
          const msg = r.error_message ?? "failure";
          xml += `<failure message="${escapeXml(msg)}"/>`;
        } else if (r.status === "SKIPPED") {
          xml += `<skipped/>`;
        }
        xml += `</testcase>\n`;
      }

      xml += `</testsuite>\n`;

      const junitPath = path.resolve(process.cwd(), "reports", `run-${runId}.xml`);
      fs.writeFileSync(junitPath, xml, "utf-8");
      console.log(`JUnit report: ${junitPath}`);
      return;
    }

    console.log(`Run ${report.runId} status: ${report.status}`);
    if (report.summary) {
      console.log(
        `Summary: total=${report.summary.total}, passed=${report.summary.passed}, failed=${report.summary.failed}, skipped=${report.summary.skipped ?? 0}`
      );
    }
    console.log(`Report file: ${reportPath}`);
  });

program.parseAsync(process.argv);

