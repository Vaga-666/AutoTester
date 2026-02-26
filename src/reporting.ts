import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { type Locator } from "./db/repository.js";

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function formatLocator(loc: Locator): string {
  if (loc.type === "role") {
    return `role:${loc.role}${loc.name ? `:${loc.name}` : ""}`;
  }
  return `${loc.type}:${"value" in loc ? loc.value : ""}`;
}

function formatLocatorList(locators: Locator[] | undefined): string {
  if (!locators || locators.length === 0) return "-";
  return locators.map((l) => formatLocator(l)).join(" | ");
}

export function renderHtmlReport(report: any, reportJsonPath: string): string {
  const steps = Array.isArray(report.steps)
    ? (report.steps as Array<{ order_index: number; action_type: string; status: string; error_message?: string | null; locators?: Locator[]; value?: string | null }>)
    : [];
  const rows = steps
    .map((s) => {
      const locators = formatLocatorList(s.locators);
      const value = s.value ?? "";
      const error = s.error_message ?? "";
      return `          <tr>
            <td>${escapeXml(String(s.order_index))}</td>
            <td>${escapeXml(s.action_type)}</td>
            <td>${escapeXml(locators)}</td>
            <td>${escapeXml(value)}</td>
            <td>${escapeXml(s.status)}</td>
            <td>${escapeXml(error)}</td>
          </tr>`;
    })
    .join("\n");

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>AutoTester Report ${escapeXml(String(report.runId))}</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 24px; color: #111; }
    h1 { margin: 0 0 8px; }
    .meta { margin: 0 0 16px; color: #555; }
    table { width: 100%; border-collapse: collapse; }
    th, td { border: 1px solid #ddd; padding: 8px; vertical-align: top; }
    th { background: #f3f3f3; text-align: left; }
    .status-pass { color: #0a7b34; font-weight: 600; }
    .status-fail { color: #b00020; font-weight: 600; }
    .status-skipped { color: #8a6d3b; font-weight: 600; }
  </style>
</head>
<body>
  <h1>Run ${escapeXml(String(report.runId))} — ${escapeXml(report.status)}</h1>
  <p class="meta">Macro: ${escapeXml(String(report.macroName ?? report.macroId))} | Env: ${escapeXml(String(report.envName ?? ""))} | Browser: ${escapeXml(String(report.browser ?? ""))}</p>
  <p class="meta">Summary: total=${escapeXml(String(report.summary?.total ?? steps.length))}, passed=${escapeXml(String(report.summary?.passed ?? 0))}, failed=${escapeXml(String(report.summary?.failed ?? 0))}, skipped=${escapeXml(String(report.summary?.skipped ?? 0))}</p>
  <table>
    <thead>
      <tr>
        <th>Order</th>
        <th>Action</th>
        <th>Locators</th>
        <th>Value</th>
        <th>Status</th>
        <th>Error</th>
      </tr>
    </thead>
    <tbody>
${rows}
    </tbody>
  </table>
</body>
</html>`;

  const runId = Number(report.runId);
  const dir = path.dirname(reportJsonPath);
  const htmlName = Number.isFinite(runId) ? `run-${runId}.html` : `${path.parse(reportJsonPath).name}.html`;
  const htmlPath = path.resolve(dir, htmlName);
  fs.writeFileSync(htmlPath, html, "utf-8");
  return htmlPath;
}

export function openFileWithSystem(filePath: string): Promise<void> {
  const platform = process.platform;
  let command = "xdg-open";
  let args = [filePath];
  if (platform === "win32") {
    command = "powershell";
    args = ["-Command", "Start-Process", "-FilePath", filePath];
  } else if (platform === "darwin") {
    command = "open";
    args = [filePath];
  }

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", reject);
    child.unref();
    resolve();
  });
}

export function findLatestRunIdForMacro(macroId: number): number | null {
  const reportsDir = path.resolve(process.cwd(), "reports");
  if (!fs.existsSync(reportsDir)) return null;
  const files = fs.readdirSync(reportsDir).filter((f) => f.startsWith("run-") && f.endsWith(".json"));
  let maxRunId: number | null = null;

  for (const file of files) {
    const reportPath = path.join(reportsDir, file);
    try {
      const raw = fs.readFileSync(reportPath, "utf-8");
      const report = JSON.parse(raw);
      const reportMacroId = Number(report.macroId);
      if (reportMacroId !== macroId) continue;
      const runId = Number(report.runId);
      if (!Number.isFinite(runId)) continue;
      if (maxRunId === null || runId > maxRunId) maxRunId = runId;
    } catch {
      continue;
    }
  }

  return maxRunId;
}
