import { chromium, type Page } from "playwright";
import { createRepository, getDbProvider } from "../db/factory.js";
import { type Locator } from "../db/repository.js";
import fs from "node:fs";
import path from "node:path";
import { runMacro } from "../runner/index.js";
import { findLatestRunIdForMacro, openFileWithSystem, renderHtmlReport } from "../reporting.js";

type RecordedEvent = {
  type: "click" | "input" | "change" | "navigation" | "waitFor" | "assert";
  locators: Locator[];
  value?: string | null;
};

type MacroActionType =
  | "click"
  | "type"
  | "check"
  | "uncheck"
  | "select"
  | "navigation"
  | "waitFor"
  | "assert";

const RECORDED_EVENT_TYPES: ReadonlySet<RecordedEvent["type"]> = new Set([
  "click",
  "input",
  "change",
  "navigation",
  "waitFor",
  "assert",
]);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isLocator(value: unknown): value is Locator {
  if (!value || typeof value !== "object") return false;
  const maybe = value as Partial<Locator>;
  if (maybe.type === "data" || maybe.type === "css" || maybe.type === "xpath") {
    return typeof maybe.value === "string";
  }
  if (maybe.type === "role") {
    return typeof maybe.role === "string" && (maybe.name === undefined || typeof maybe.name === "string");
  }
  return false;
}

function isRecordedEventPayload(payload: unknown): payload is RecordedEvent {
  if (!payload || typeof payload !== "object") return false;
  const maybe = payload as Partial<RecordedEvent>;
  if (!maybe.type || !RECORDED_EVENT_TYPES.has(maybe.type as RecordedEvent["type"])) return false;
  if (!Array.isArray(maybe.locators) || !maybe.locators.every(isLocator)) return false;
  if (!(maybe.value === undefined || maybe.value === null || typeof maybe.value === "string")) return false;
  return true;
}

function parseMacroMeta(description: string | null): { name?: string; site?: string; tags?: string[] } {
  if (!description) return {};
  try {
    const parsed = JSON.parse(description);
    const root = parsed && typeof parsed === "object" ? (parsed as { meta?: unknown }).meta ?? parsed : null;
    if (!root || typeof root !== "object") return {};
    const meta = root as { name?: unknown; site?: unknown; tags?: unknown };
    const name = typeof meta.name === "string" ? meta.name : undefined;
    const site = typeof meta.site === "string" ? meta.site : undefined;
    const rawTags = Array.isArray(meta.tags)
      ? meta.tags
      : typeof meta.tags === "string"
        ? meta.tags.split(",")
        : [];
    const tags = rawTags
      .map((t) => (typeof t === "string" ? t.trim() : ""))
      .filter((t) => t.length > 0);
    const deduped = Array.from(new Set(tags));
    return { name, site, tags: deduped };
  } catch {
    return {};
  }
}

export async function recordMacro(options: { url?: string; name?: string }): Promise<void> {
  const url = options.url;
  const name = options.name ?? "Untitled macro";
  const debug = process.env.AUTOTESTER_DEBUG === "1";

  if (!isNonEmptyString(url)) {
    console.error("Missing --url");
    process.exitCode = 1;
    return;
  }

  let repo: Awaited<ReturnType<typeof createRepository>>;
  try {
    repo = await createRepository();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`cannot connect to ${getDbProvider()}: ${message}`);
    process.exitCode = 1;
    return;
  }

  const events: RecordedEvent[] = [];
  let stopRequested = false;
  let controlPageClosed = false;
  let controlPage: Page | null = null;

  function pushEvent(payload: RecordedEvent) {
    const last = events[events.length - 1];
    if (payload.type === "navigation") {
      if (last && last.type === "navigation" && last.value === payload.value) {
        return;
      }
    }
    if (payload.type === "click") {
      if (last && last.type === "click") {
        const a = JSON.stringify(last.locators[0] ?? null);
        const b = JSON.stringify(payload.locators[0] ?? null);
        if (a === b) return;
      }
    }
    events.push(payload);
  }

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();

  await context.exposeBinding("__autotesterEvent", (_source, payload: unknown) => {
    if (!isRecordedEventPayload(payload)) {
      if (debug) {
        const raw =
          payload === undefined
            ? "undefined"
            : payload === null
              ? "null"
              : typeof payload === "string"
                ? payload
                : JSON.stringify(payload);
        console.log(`[recorder] ignored invalid recorder payload ${raw.slice(0, 300)}`);
      }
      return;
    }
    if (debug) console.log(`[recorder] event=${payload.type} locators=${payload.locators.length}`);
    pushEvent(payload);
  });

  async function stopRecording(): Promise<void> {
    if (stopRequested) return;
    stopRequested = true;
    if (controlPage && !controlPage.isClosed()) {
      controlPageClosed = true;
      await controlPage.close().catch(() => undefined);
    }
    await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }

  await context.exposeBinding("__autotesterStop", async () => {
    await stopRecording();
  });

  await context.exposeBinding("__autotesterControl", (_source, cmd: unknown) => {
    const action = cmd && typeof cmd === "object" ? (cmd as { type?: string }).type : undefined;
    if (action === "undo") {
      events.pop();
      return;
    }
    if (action === "clear") {
      events.length = 0;
    }
  });

  function recorderInitScript() {

    const debug = "__AUTOTESTER_DEBUG__";
    if (debug) {
      console.log(`[autotester] recorder init: ${location.href}`);
    }

    type BrowserLocator =
      | { type: "data"; value: string }
      | { type: "role"; role: string; name?: string }
      | { type: "css"; value: string }
      | { type: "xpath"; value: string };
    type BrowserRecorderPayload = { type: string; locators: BrowserLocator[]; value?: string | null };

    function getDataSelector(el: Element): string | null {
      const dataTestId = el.getAttribute("data-testid");
      if (dataTestId) return `[data-testid="${dataTestId}"]`;
      const dataQa = el.getAttribute("data-qa");
      if (dataQa) return `[data-qa="${dataQa}"]`;
      return null;
    }

    function getRoleLocator(el: Element): { role: string; name?: string } | null {
      const role = el.getAttribute("role");
      if (!role) return null;
      const ariaLabel = el.getAttribute("aria-label");
      const text = (el.textContent || "").trim();
      let name = ariaLabel || text || undefined;
      if (name) {
        name = name.trim();
        if (name.length > 80) name = name.slice(0, 80);
      }
      return { role, name };
    }

    function cssPath(el: Element): string {
      if (el.id) return `#${el.id}`;
      const parts: string[] = [];
      let current: Element | null = el;
      while (current && current.nodeType === Node.ELEMENT_NODE) {
        let selector = current.nodeName.toLowerCase();
        if (current.id) {
          selector += `#${current.id}`;
          parts.unshift(selector);
          break;
        } else {
          const parent = current.parentElement;
          if (parent) {
            const siblings = Array.from(parent.children).filter((c) => c.nodeName === current!.nodeName);
            if (siblings.length > 1) {
              const index = siblings.indexOf(current) + 1;
              selector += `:nth-of-type(${index})`;
            }
          }
        }
        parts.unshift(selector);
        current = current.parentElement;
      }
      return parts.join(" > ");
    }

    function xpath(el: Element): string {
      if (el.id) return `//*[@id="${el.id}"]`;
      const parts: string[] = [];
      let current: Element | null = el;
      while (current && current.nodeType === Node.ELEMENT_NODE) {
        let index = 1;
        let sibling = current.previousElementSibling;
        while (sibling) {
          if (sibling.nodeName === current.nodeName) index += 1;
          sibling = sibling.previousElementSibling;
        }
        const tagName = current.nodeName.toLowerCase();
        parts.unshift(`${tagName}[${index}]`);
        current = current.parentElement;
      }
      return "/" + parts.join("/");
    }

    function buildLocators(el: Element): BrowserLocator[] {
      const locators: BrowserLocator[] = [];
      const dataSel = getDataSelector(el);
      if (dataSel) locators.push({ type: "data", value: dataSel });

      const role = getRoleLocator(el);
      if (role) locators.push({ type: "role", role: role.role, name: role.name });

      const css = cssPath(el);
      if (css) locators.push({ type: "css", value: css });

      const xp = xpath(el);
      if (xp) locators.push({ type: "xpath", value: xp });

      return locators;
    }

    function emit(payload: BrowserRecorderPayload) {
      const publish = (window as { __autotesterEvent?: (event: BrowserRecorderPayload) => void }).__autotesterEvent;
      if (typeof publish !== "function") {
        if (debug) {
          console.log("[autotester] publish missing", typeof publish);
        }
        return;
      }
      if (debug) {
        console.log("[autotester] emit", payload.type, payload.locators.length);
      }
      publish(payload);
    }

    function send(type: string, target: Element, value?: string | null) {
      if (!recordingEnabled) return;
      const locators = buildLocators(target);
      emit({ type, locators, value });
    }

    function resolveElement(target: EventTarget | null): Element | null {
      if (!target) return null;
      if (target instanceof Element) return target;
      if (target instanceof Node) return target.parentElement;
      return null;
    }

    function normalizeTarget(target: Element): Element {
      return (
        target.closest('button,a,input,select,textarea,[role="button"],[data-testid],[data-qa]') ?? target
      );
    }

    function isRecorderPanelElement(target: Element | null): boolean {
      return false;
    }

    let lastNormalizedClick: Element | null = null;
    let lastPointerElement: Element | null = null;
    let recordingEnabled = true;

    document.addEventListener("mousemove", (e) => {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (el && !isRecorderPanelElement(el)) lastPointerElement = el;
    });

    document.addEventListener(
      "click",
      (e) => {
        const target = resolveElement(e.target);
        if (!target) return;
        if (isRecorderPanelElement(target)) return;
        if (!recordingEnabled) return;
        const normalized = normalizeTarget(target);
        if (debug) {
          console.log("[autotester] click", normalized.tagName, normalized.id || "", normalized.className || "");
        }
        lastNormalizedClick = normalized;
        send("click", normalized);
      },
      true
    );

    const inputBuffer = new Map<string, { value: string; locators: BrowserLocator[]; timer: number | null }>();

    function keyFromLocators(locators: BrowserLocator[]): string {
      if (!locators || locators.length === 0) return "";
      const data = locators.find((l) => l.type === "data");
      if (data) return JSON.stringify(data);
      const css = locators.find((l) => l.type === "css");
      if (css) return JSON.stringify(css);
      return JSON.stringify(locators[0]);
    }

    function flushInput(key: string) {
      const entry = inputBuffer.get(key);
      if (!entry) return;
      if (entry.timer) window.clearTimeout(entry.timer);
      inputBuffer.delete(key);
      emit({ type: "input", locators: entry.locators, value: entry.value });
    }

    function flushAllInputs() {
      for (const key of inputBuffer.keys()) {
        flushInput(key);
      }
    }

    function scheduleInput(target: HTMLInputElement | HTMLTextAreaElement, value: string) {
      const locators = buildLocators(target);
      const key = keyFromLocators(locators);
      const existing = inputBuffer.get(key);
      if (existing && existing.timer) window.clearTimeout(existing.timer);
      const timer = window.setTimeout(() => flushInput(key), 250);
      inputBuffer.set(key, { value, locators, timer });
    }

    document.addEventListener(
      "input",
      (e) => {
        const target = resolveElement(e.target);
        if (!target) return;
        if (isRecorderPanelElement(target)) return;
        if (!recordingEnabled) return;
        if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
          const isSecret =
            target.type === "password" || target.getAttribute("autocomplete") === "current-password";
          const value = isSecret ? "__SECRET__" : target.value;
          if (debug) {
            console.log("[autotester] input", target.tagName, target.type || "", value?.length ?? 0);
          }
          scheduleInput(target, value);
        }
      },
      true
    );

    document.addEventListener(
      "blur",
      (e) => {
        const target = resolveElement(e.target);
        if (!target) return;
        if (isRecorderPanelElement(target)) return;
        if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) return;
        const locators = buildLocators(target);
        const key = keyFromLocators(locators);
        flushInput(key);
      },
      true
    );

    document.addEventListener(
      "change",
      (e) => {
        const target = resolveElement(e.target);
        if (!target) return;
        if (isRecorderPanelElement(target)) return;
        if (!recordingEnabled) return;
        if (target instanceof HTMLSelectElement) {
          if (debug) {
            console.log("[autotester] change", target.tagName, target.value);
          }
          send("change", target, target.value);
        } else if (target instanceof HTMLInputElement && (target.type === "checkbox" || target.type === "radio")) {
          const value = target.checked ? "checked" : "unchecked";
          if (debug) {
            console.log("[autotester] change", target.tagName, value);
          }
          send("change", target, value);
        }
      },
      true
    );

    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;

    function emitNavigation() {
      if (!recordingEnabled) return;
      flushAllInputs();
      emit({ type: "navigation", locators: [], value: location.href });
    }

    history.pushState = function (...args: Parameters<History["pushState"]>) {
      const result = originalPushState.apply(this, args);
      emitNavigation();
      return result;
    };
    history.replaceState = function (...args: Parameters<History["replaceState"]>) {
      const result = originalReplaceState.apply(this, args);
      emitNavigation();
      return result;
    };

    window.addEventListener("popstate", emitNavigation);
    window.addEventListener("hashchange", emitNavigation);

    document.addEventListener(
      "keydown",
      (e) => {
        const active = document.activeElement instanceof Element ? document.activeElement : null;
        if (isRecorderPanelElement(active)) return;
        if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "s") {
          e.preventDefault();
          if (debug) console.log("[autotester] hotkey", e.key);
          flushAllInputs();
          const stop = (window as { __autotesterStop?: () => void }).__autotesterStop;
          if (typeof stop === "function") stop();
        }

        if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "w") {
          e.preventDefault();
          if (debug) console.log("[autotester] hotkey", e.key);
          const target = lastNormalizedClick || lastPointerElement || (document.activeElement as Element | null);
          if (target && !isRecorderPanelElement(target)) send("waitFor", normalizeTarget(target));
        }

        if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "v") {
          e.preventDefault();
          if (debug) console.log("[autotester] hotkey", e.key);
          const target = lastNormalizedClick || lastPointerElement || (document.activeElement as Element | null);
          if (target && !isRecorderPanelElement(target)) send("assert", normalizeTarget(target));
        }

        if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "u") {
          e.preventDefault();
          if (debug) console.log("[autotester] hotkey", e.key);
          const pathname = location.pathname || "/";
          if (recordingEnabled) emit({ type: "assert", locators: [], value: `url:${pathname}` });
        }

        if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "t") {
          e.preventDefault();
          if (debug) console.log("[autotester] hotkey", e.key);
          const text = window.prompt("Text contains:");
          if (text && text.trim().length > 0) {
            const target = lastNormalizedClick || lastPointerElement || (document.activeElement as Element | null);
            if (target && !isRecorderPanelElement(target)) {
              const normalized = normalizeTarget(target);
              const locators = buildLocators(normalized);
              if (recordingEnabled) emit({ type: "assert", locators, value: `text:${text.trim()}` });
            }
          }
        }
      },
      true
    );

    (window as { __autotesterCommand?: (cmd: { type: string; text?: string }) => { ok: boolean; reason?: string; recordingEnabled?: boolean } }).__autotesterCommand = (cmd) => {
      if (!cmd || typeof cmd.type !== "string") return { ok: false, reason: "invalid" };
      const target = lastNormalizedClick || lastPointerElement || (document.activeElement as Element | null);
      if (cmd.type === "toggleRecording") {
        recordingEnabled = !recordingEnabled;
        return { ok: true, recordingEnabled };
      }
      if (cmd.type === "wait") {
        if (!target) return { ok: false, reason: "no-target" };
        send("waitFor", normalizeTarget(target));
        return { ok: true };
      }
      if (cmd.type === "assertVisible") {
        if (!target) return { ok: false, reason: "no-target" };
        send("assert", normalizeTarget(target));
        return { ok: true };
      }
      if (cmd.type === "assertUrl") {
        const pathname = location.pathname || "/";
        if (recordingEnabled) emit({ type: "assert", locators: [], value: `url:${pathname}` });
        return { ok: true };
      }
      if (cmd.type === "assertText") {
        const textValue = typeof cmd.text === "string" ? cmd.text.trim() : "";
        if (!textValue) return { ok: false, reason: "no-text" };
        if (!target) return { ok: false, reason: "no-target" };
        const normalized = normalizeTarget(target);
        const locators = buildLocators(normalized);
        if (recordingEnabled) emit({ type: "assert", locators, value: `text:${textValue}` });
        return { ok: true };
      }
      return { ok: false, reason: "unknown" };
    };


  }

  const debugLiteral = debug ? "true" : "false";
  const rawScript = recorderInitScript.toString();
  const scriptContent = `
(() => {
  if (typeof (globalThis).__name !== "function") { (globalThis).__name = (t, _v) => t; }
  ${rawScript.replace('const debug = "__AUTOTESTER_DEBUG__";', `const debug = ${debugLiteral};`)}
  recorderInitScript();
})();
`;

  await context.addInitScript(scriptContent);


  const page = await context.newPage();
  controlPage = await context.newPage();
  const controlHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>AutoTester Recorder Control</title>
  <style>
  :root { color-scheme: dark; }
  html, body {
    margin: 0;
    padding: 0;
    width: 100%;
    height: 100%;
    overflow: hidden;
  }
  body {
    font-family: system-ui, sans-serif;
    background: #0f1115;
    color: #e6e6e6;
  }
  * { box-sizing: border-box; max-width: 100%; }
  .wrap {
    padding: 12px;
    display: grid;
    gap: 8px;
    width: 100%;
    height: 100vh;
    overflow: hidden;
  }
  h1 { font-size: 15px; margin: 0 0 4px; }
  .row { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  input, button {
    width: 100%;
    border-radius: 6px;
    border: 1px solid #2d2f36;
    background: #151922;
    color: #e6e6e6;
    padding: 7px 10px;
    font-size: 13px;
  }
  button { cursor: pointer; }
  button:hover { background: #1b2130; border-color: #3a3f4b; }
  .full { grid-column: 1 / -1; }
  .label { font-size: 11px; color: #9aa3b2; margin-bottom: -6px; }
  .status { font-size: 11px; color: #7ee787; }
</style>
</head>
<body>
  <div class="wrap">
    <h1>AutoTester Recorder</h1>
    <div class="status" id="status">Recording</div>
    <div class="row">
      <button id="toggle">Pause</button>
      <button id="stop">Stop</button>
    </div>
    <div class="label full">Email</div>
    <input id="email" type="email" placeholder="Email" class="full" />
    <button id="fillEmail" class="full">Fill Email</button>
    <div class="label full">Text</div>
    <input id="text" type="text" placeholder="Text" class="full" />
    <button id="fillText" class="full">Fill Text</button>
    <div class="row">
      <button id="wait">Wait</button>
      <button id="assertVisible">Assert Visible</button>
    </div>
    <div class="row">
      <button id="assertUrl">Assert URL</button>
      <button id="undo">Undo last</button>
    </div>
    <div class="label full">Text contains</div>
    <input id="assertTextValue" type="text" placeholder="Text contains" class="full" />
    <button id="assertText" class="full">Assert Text</button>
    <!-- Saved macros -->
    <div class="label full">Saved macros</div>
    <div class="row">
      <input id="macroSearch" type="text" placeholder="Search by ID/Name/Tags/Base URL" />
      <button id="refreshMacros">Refresh</button>
    </div>
    <div id="macroList" class="full" style="border: 1px solid #2d2f36; border-radius: 6px; overflow: auto; max-height: 220px;"></div>
    <div id="runStatus" class="status full"></div>
  </div>

  <script>
    const send = (cmd) => window.autotesterControl(cmd);
    const status = document.getElementById("status");
    const toggle = document.getElementById("toggle");
    toggle.addEventListener("click", async () => {
      const res = await send({ type: "toggleRecording" });
      const enabled = res && typeof res.recordingEnabled === "boolean" ? res.recordingEnabled : true;
      toggle.textContent = enabled ? "Pause" : "Record";
      status.textContent = enabled ? "Recording" : "Paused";
      status.style.color = enabled ? "#7ee787" : "#f2cc60";
    });
    document.getElementById("stop").addEventListener("click", () => send({ type: "stop" }));
    document.getElementById("fillEmail").addEventListener("click", () => {
      send({ type: "fillEmail", value: document.getElementById("email").value });
    });
    document.getElementById("fillText").addEventListener("click", () => {
      send({ type: "fillText", value: document.getElementById("text").value });
    });
    document.getElementById("wait").addEventListener("click", () => send({ type: "wait" }));
    document.getElementById("assertVisible").addEventListener("click", () => send({ type: "assertVisible" }));
    document.getElementById("assertUrl").addEventListener("click", () => send({ type: "assertUrl" }));
    document.getElementById("assertText").addEventListener("click", () => {
      send({ type: "assertText", text: document.getElementById("assertTextValue").value });
    });
    document.getElementById("undo").addEventListener("click", () => send({ type: "undo" }));
  </script>
  <script>
    const macroSearch = document.getElementById("macroSearch");
    const refreshMacros = document.getElementById("refreshMacros");
    const macroList = document.getElementById("macroList");
    const runStatus = document.getElementById("runStatus");

    const setRunStatus = (text, color) => {
      if (!runStatus) return;
      runStatus.textContent = text;
      if (color) runStatus.style.color = color;
    };

    const renderMacros = (items) => {
      if (!macroList) return;
      macroList.innerHTML = "";
      const table = document.createElement("table");
      table.style.width = "100%";
      table.style.borderCollapse = "collapse";
      table.style.fontSize = "12px";

      const head = document.createElement("thead");
      head.innerHTML =
        "<tr><th style=\"text-align:left; padding:6px; border-bottom:1px solid #2d2f36;\">ID</th>" +
        "<th style=\"text-align:left; padding:6px; border-bottom:1px solid #2d2f36;\">Name</th>" +
        "<th style=\"text-align:left; padding:6px; border-bottom:1px solid #2d2f36;\">Base URL</th>" +
        "<th style=\"text-align:left; padding:6px; border-bottom:1px solid #2d2f36;\">Tags</th>" +
        "<th style=\"text-align:left; padding:6px; border-bottom:1px solid #2d2f36;\">Actions</th></tr>";
      table.appendChild(head);

      const body = document.createElement("tbody");
      for (const item of items) {
        const row = document.createElement("tr");
        const tags = Array.isArray(item.tags) ? item.tags.join(", ") : "";
        row.innerHTML =
          "<td style=\"padding:6px; border-bottom:1px solid #2d2f36;\">" +
          String(item.id) +
          "</td>" +
          "<td style=\"padding:6px; border-bottom:1px solid #2d2f36;\">" +
          (item.name || "") +
          "</td>" +
          "<td style=\"padding:6px; border-bottom:1px solid #2d2f36;\">" +
          (item.baseUrl || "") +
          "</td>" +
          "<td style=\"padding:6px; border-bottom:1px solid #2d2f36;\">" +
          tags +
          "</td>" +
          "<td style=\"padding:6px; border-bottom:1px solid #2d2f36;\"></td>";
        const actionsCell = row.lastChild;
        const runBtn = document.createElement("button");
        runBtn.textContent = "Run";
        runBtn.style.padding = "4px 6px";
        runBtn.style.marginRight = "6px";
        runBtn.addEventListener("click", async () => {
          setRunStatus("Running macro " + item.id + "...", "#f2cc60");
          const res = await send({ type: "runMacro", macroId: item.id });
          if (res && res.ok) {
            const statusText = res.status ? String(res.status) : "UNKNOWN";
            setRunStatus("Run " + res.runId + " " + statusText, statusText === "FAIL" ? "#f85149" : "#7ee787");
          } else {
            setRunStatus(res && res.reason ? String(res.reason) : "Run failed", "#f85149");
          }
        });
        const reportBtn = document.createElement("button");
        reportBtn.textContent = "Report";
        reportBtn.style.padding = "4px 6px";
        reportBtn.addEventListener("click", async () => {
          const res = await send({ type: "openReport", macroId: item.id });
          if (res && res.ok) {
            setRunStatus("Opened report for macro " + item.id, "#7ee787");
          } else {
            setRunStatus(res && res.reason ? String(res.reason) : "Report not found", "#f85149");
          }
        });
        if (actionsCell) {
          actionsCell.appendChild(runBtn);
          actionsCell.appendChild(reportBtn);
        }
        body.appendChild(row);
      }
      table.appendChild(body);
      macroList.appendChild(table);
    };

    const refreshList = async () => {
      const query = macroSearch && macroSearch.value ? macroSearch.value.trim() : "";
      const res = await send({ type: "listMacros", query });
      if (res && res.ok && Array.isArray(res.items)) {
        renderMacros(res.items);
      } else {
        renderMacros([]);
      }
    };

    if (refreshMacros) refreshMacros.addEventListener("click", refreshList);
    if (macroSearch) macroSearch.addEventListener("input", () => void refreshList());
    void refreshList();
  </script>
</body>
</html>`;

  await controlPage.exposeBinding("autotesterControl", async (_source, cmd: any) => {
    if (!cmd || typeof cmd.type !== "string") return { ok: false, reason: "invalid" };
    if (cmd.type === "stop") {
      await stopRecording();
      return { ok: true };
    }
    if (cmd.type === "undo") {
      events.pop();
      return { ok: true };
    }

    const showAlert = async (message: string) => {
      await controlPage?.evaluate((msg) => alert(msg), message);
    };

    if (cmd.type === "listMacros") {
      const query = typeof cmd.query === "string" ? cmd.query.trim().toLowerCase() : "";
      const rows = await repo.listRecent(30);
      let items = rows.map((row) => {
        const meta = parseMacroMeta(row.description ?? null);
        const tags = Array.isArray(meta.tags) ? meta.tags : [];
        const baseUrl = (isNonEmptyString(meta.site) ? meta.site : row.base_url) ?? "";
        return { id: row.id, name: row.name, baseUrl, tags, description: row.description ?? "" };
      });
      if (query) {
        items = items.filter((item) => {
          const haystack = `${item.id} ${item.name} ${item.baseUrl} ${item.tags.join(" ")} ${item.description}`.toLowerCase();
          return haystack.includes(query);
        });
      }
      return { ok: true, items };
    }

    if (cmd.type === "openReport") {
      const macroId = Number(cmd.macroId);
      if (!Number.isFinite(macroId)) {
        await showAlert("Invalid macro id");
        return { ok: false, reason: "invalid macroId" };
      }
      const runId = findLatestRunIdForMacro(macroId);
      if (!runId) {
        await showAlert("No runs found for macro " + macroId);
        return { ok: false, reason: "no runs" };
      }
      const reportPath = path.resolve(process.cwd(), "reports", `run-${runId}.json`);
      if (!fs.existsSync(reportPath)) {
        await showAlert("Report not found");
        return { ok: false, reason: "report not found" };
      }
      const report = JSON.parse(fs.readFileSync(reportPath, "utf-8"));
      const htmlPath = renderHtmlReport(report, reportPath);
      await openFileWithSystem(htmlPath);
      return { ok: true, runId };
    }

    if (cmd.type === "runMacro") {
      const macroId = Number(cmd.macroId);
      if (!Number.isFinite(macroId)) {
        await showAlert("Invalid macro id");
        return { ok: false, reason: "invalid macroId" };
      }
      const macro = await repo.getMacroWithDescription(macroId);
      if (!macro) {
        await showAlert("Macro not found");
        return { ok: false, reason: "not found" };
      }
      const meta = parseMacroMeta(macro.description ?? null);
      const cmdBaseUrl = typeof cmd.baseUrl === "string" ? cmd.baseUrl.trim() : "";
      const baseUrl = (isNonEmptyString(meta.site) ? meta.site : macro.base_url) ?? (cmdBaseUrl || undefined);
      if (!isNonEmptyString(baseUrl)) {
        await showAlert("Missing base URL");
        return { ok: false, reason: "missing baseUrl" };
      }
      await runMacro({ macroId: String(macroId), baseUrl, headless: false });
      const runId = findLatestRunIdForMacro(macroId);
      if (!runId) {
        return { ok: false, reason: "no run found" };
      }
      const reportPath = path.resolve(process.cwd(), "reports", `run-${runId}.json`);
      if (!fs.existsSync(reportPath)) {
        return { ok: false, reason: "report not found" };
      }
      const report = JSON.parse(fs.readFileSync(reportPath, "utf-8"));
      const status = typeof report.status === "string" ? report.status : "UNKNOWN";
      if (status === "FAIL") {
        const htmlPath = renderHtmlReport(report, reportPath);
        await openFileWithSystem(htmlPath);
      }
      return { ok: true, status, runId };
    }

    const runOnPage = async (command: { type: string; text?: string }) => {
      return page.evaluate((c) => (window as any).__autotesterCommand?.(c), command);
    };

    if (cmd.type === "toggleRecording") {
      return runOnPage({ type: "toggleRecording" });
    }
    if (cmd.type === "wait") {
      const result = await runOnPage({ type: "wait" });
      if (result?.reason === "no-target") {
        await controlPage?.evaluate(() => alert("No target selected"));
      }
      return result;
    }
    if (cmd.type === "assertVisible") {
      const result = await runOnPage({ type: "assertVisible" });
      if (result?.reason === "no-target") {
        await controlPage?.evaluate(() => alert("No target selected"));
      }
      return result;
    }
    if (cmd.type === "assertUrl") {
      return runOnPage({ type: "assertUrl" });
    }
    if (cmd.type === "assertText") {
      const text = typeof cmd.text === "string" ? cmd.text : "";
      const result = await runOnPage({ type: "assertText", text });
      if (result?.reason === "no-target") {
        await controlPage?.evaluate(() => alert("No target selected"));
      }
      return result;
    }
    if (cmd.type === "fillEmail" || cmd.type === "fillText") {
      const value = typeof cmd.value === "string" ? cmd.value : "";
      const filled = await page.evaluate((val) => {
        const active = document.activeElement;
        if (!active) return false;
        if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
          active.value = val;
          active.dispatchEvent(new Event("input", { bubbles: true }));
          return true;
        }
        if (active instanceof HTMLElement && active.isContentEditable) {
          active.textContent = val;
          active.dispatchEvent(new Event("input", { bubbles: true }));
          return true;
        }
        return false;
      }, value);
      if (!filled) {
        await controlPage?.evaluate(() => alert("No active input"));
      }
      return { ok: filled };
    }
    return { ok: false, reason: "unknown" };
  });

  controlPage.on("close", () => {
    if (controlPageClosed) return;
    void stopRecording();
  });

  await controlPage.setViewportSize({ width: 420, height: 680 });
  await controlPage.setContent(controlHtml);
  await controlPage.bringToFront();
  if (debug) {
    page.on("console", (msg) => {
      console.log(`[browser:${msg.type()}] ${msg.text()}`);
    });
  }

  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) {
      pushEvent({ type: "navigation", locators: [], value: frame.url() });
    }
  });

  await page.goto(url, { waitUntil: "domcontentloaded" });
  pushEvent({ type: "navigation", locators: [], value: page.url() });

  console.log("Recorder started. Interact with the page. Press Ctrl+Shift+S to stop.");

  await new Promise<void>((resolve) => {
    const interval = setInterval(() => {
      if (stopRequested) {
        clearInterval(interval);
        resolve();
      }
    }, 200);

    browser.on("disconnected", () => {
      clearInterval(interval);
      resolve();
    });
  });

  if (events.length === 0) {
    console.log("No events recorded.");
    return;
  }

  const macroId = await repo.createMacro({ name, baseUrl: url });
  const steps = events.map((e, idx) => {
    let actionType: MacroActionType = "click";
    let value = e.value ?? null;

    if (e.type === "click" || e.type === "navigation" || e.type === "waitFor" || e.type === "assert") {
      actionType = e.type;
    }
    if (e.type === "input") actionType = "type";
    if (e.type === "change") {
      if (value === "checked" || value === "unchecked") {
        actionType = value === "checked" ? "check" : "uncheck";
        value = null;
      } else {
        actionType = "select";
      }
    }

    return {
      orderIndex: idx + 1,
      actionType,
      locators: e.locators,
      value,
    };
  });

  await repo.addSteps(macroId, steps);

  console.log(`Recorded macro ${macroId} with ${steps.length} steps.`);
}
