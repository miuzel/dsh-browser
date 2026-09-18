// src/browser-service.ts
import fs4 from "node:fs";
import path2 from "node:path";
import crypto3 from "node:crypto";

// src/deps.ts
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawn, execFileSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
var PLUGIN_ROOT = fileURLToPath(new URL("..", import.meta.url));
var cachedGlobalRoot;
function globalNpmRoot() {
  if (cachedGlobalRoot) return cachedGlobalRoot;
  try {
    cachedGlobalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8", windowsHide: true, timeout: 15e3 }).trim();
  } catch {
    cachedGlobalRoot = path.join(process.env.APPDATA ?? "", "npm", "node_modules");
  }
  return cachedGlobalRoot;
}
function findPackageRoot(fromFile) {
  let dir = path.dirname(fromFile);
  for (let i = 0; i < 20; i++) {
    const pj = path.join(dir, "package.json");
    if (fs.existsSync(pj)) return pj;
    const parent = path.dirname(dir);
    if (parent === dir) return void 0;
    dir = parent;
  }
  return void 0;
}
function pnpmStorePackageJson(name) {
  let dir = PLUGIN_ROOT;
  for (let i = 0; i < 12; i++) {
    const candidate = path.join(dir, "node_modules", ".pnpm", "node_modules", name, "package.json");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return void 0;
}
function resolvePkgJson(name) {
  const storePkg = pnpmStorePackageJson(name);
  if (storePkg) return storePkg;
  const anchors = [
    path.join(PLUGIN_ROOT, "package.json"),
    path.join(globalNpmRoot(), name, "package.json")
  ];
  for (const anchor of anchors) {
    const req = createRequire(anchor);
    try {
      return req.resolve(name + "/package.json");
    } catch {
    }
    try {
      const entry = req.resolve(name);
      const root = findPackageRoot(entry);
      if (root) return root;
    } catch {
    }
  }
  throw new Error("dsh-browser: " + name + " not found in pnpm store, plugin node_modules, or global npm. Run `npm install` in " + PLUGIN_ROOT + " (or install " + name + " globally).");
}
function pkgDir(name) {
  return path.dirname(resolvePkgJson(name));
}
var cachedBrowserRuntimes = /* @__PURE__ */ new Map();
function browserRuntimePackage(runtime) {
  if (runtime === "playwright" || runtime === "patchright") return runtime;
  throw new Error("browserRuntime must be one of: playwright, patchright");
}
function loadBrowserRuntime(runtime) {
  const packageName = browserRuntimePackage(runtime);
  const cached = cachedBrowserRuntimes.get(packageName);
  if (cached) return cached;
  const loaded = createRequire(resolvePkgJson(packageName))(packageName);
  cachedBrowserRuntimes.set(packageName, loaded);
  return loaded;
}
function browserRuntimeCliPath(runtime) {
  return path.join(pkgDir(browserRuntimePackage(runtime)), "cli.js");
}
function opencliEntryPath() {
  const dir = pkgDir("@jackwener/opencli");
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.opencli ?? pkg.main ?? "dist/src/main.js";
  return path.join(dir, bin);
}
function runNode(script, args, opts = { signal: void 0 }) {
  return new Promise((resolve) => {
    const maxOutput = opts.maxOutput ?? 4 * 1024 * 1024;
    let stdout = "";
    let stderr = "";
    let settled = false;
    let child;
    let timer;
    const finish = (code, timedOut) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      if (child.exitCode === null) child.kill();
      resolve({ code, stdout, stderr, timedOut });
    };
    const onAbort = () => {
      if (child.exitCode === null) child.kill();
      finish(-1, false);
    };
    timer = opts.timeoutMs ? setTimeout(() => finish(-1, true), opts.timeoutMs) : void 0;
    child = spawn(process.execPath, [script, ...args], {
      env: { ...process.env, ...opts.env },
      cwd: opts.cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    child.stdout?.on("data", (d) => {
      if (stdout.length < maxOutput) stdout += d.toString("utf8");
    });
    child.stderr?.on("data", (d) => {
      if (stderr.length < maxOutput) stderr += d.toString("utf8");
    });
    child.on("error", () => finish(-1, false));
    child.on("close", (code) => finish(code ?? -1, false));
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener("abort", onAbort);
  });
}
function runOpencli(args, opts = { signal: void 0 }) {
  return runNode(opencliEntryPath(), args, opts);
}

// src/auth-profiles.ts
import fs2 from "node:fs";
function hostAllowed(hostname, domains) {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return domains.some((value) => {
    const domain = value.toLowerCase().trim().replace(/^\*\./, "").replace(/\.$/, "");
    return domain.length > 0 && (host === domain || host.endsWith("." + domain));
  });
}
var AuthProfileStore = class {
  constructor(profiles = {}) {
    this.profiles = profiles;
  }
  profiles;
  resolve(id, targetUrl) {
    const profile = this.profiles[id];
    if (!profile) throw new Error("unknown auth profile: " + id);
    const url = new URL(targetUrl);
    if (!hostAllowed(url.hostname, profile.allowedDomains ?? [])) throw new Error("auth profile " + id + " is not allowed for " + url.hostname);
    if (!profile.storageStatePath?.trim()) throw new Error("auth profile " + id + " has no storageStatePath");
    const persistState = profile.persistState ?? false;
    if (!fs2.existsSync(profile.storageStatePath)) {
      if (!persistState) throw new Error("auth profile " + id + " storageState file does not exist: " + profile.storageStatePath);
    } else if (!fs2.statSync(profile.storageStatePath).isFile()) {
      throw new Error("auth profile " + id + " storageState path is not a file: " + profile.storageStatePath);
    }
    return { id, ...profile, persistState };
  }
  list() {
    return Object.entries(this.profiles).sort(([a], [b]) => a.localeCompare(b)).map(([id, profile]) => ({ id, allowedDomains: [...profile.allowedDomains ?? []], persistState: profile.persistState ?? false }));
  }
};

// src/rule-packs.ts
import crypto from "node:crypto";
import fs3 from "node:fs";
function matchHost(hostname, values) {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return values.some((value) => {
    const domain = value.toLowerCase().trim().replace(/^\*\./, "").replace(/\.$/, "");
    return domain.length > 0 && (host === domain || host.endsWith("." + domain));
  });
}
function validateStep(step) {
  if ((step.type === "waitFor" || step.type === "click") && (!step.selector || step.selector.length > 500)) throw new Error(step.type + " selector is invalid");
  if ((step.type === "waitFor" || step.type === "click") && (step.timeoutMs ?? 15e3) > 3e4) throw new Error(step.type + " timeoutMs exceeds 30000");
  if (step.type === "wait" && (step.waitMs < 0 || step.waitMs > 1e4)) throw new Error("waitMs must be between 0 and 10000");
  if (step.type === "scroll") {
    if ((step.repeat ?? 1) < 1 || (step.repeat ?? 1) > 10) throw new Error("scroll repeat must be between 1 and 10");
    if ((step.waitMs ?? 300) < 0 || (step.waitMs ?? 300) > 5e3) throw new Error("scroll waitMs must be between 0 and 5000");
    if (Math.abs(step.deltaY ?? 2e3) > 2e4) throw new Error("scroll deltaY exceeds 20000");
  }
}
function resolveRulePack(packs, id, targetUrl) {
  if (!id) return void 0;
  const pack = packs[id];
  if (!pack) throw new Error("unknown rule pack: " + id);
  const url = new URL(targetUrl);
  if (!matchHost(url.hostname, pack.matches ?? [])) throw new Error("rule pack " + id + " is not allowed for " + url.hostname);
  const steps = pack.steps ?? [];
  if (steps.length > 25) throw new Error("rule pack has more than 25 steps");
  steps.forEach(validateStep);
  if (pack.initScriptPath) {
    if (!pack.initScriptSha256 || !/^[a-f\d]{64}$/i.test(pack.initScriptSha256)) throw new Error("rule pack init script requires a SHA-256 hash");
    const stat = fs3.statSync(pack.initScriptPath);
    if (stat.size > 64 * 1024) throw new Error("rule pack init script exceeds 65536 bytes");
    const actual = crypto.createHash("sha256").update(fs3.readFileSync(pack.initScriptPath)).digest("hex");
    if (actual.toLowerCase() !== pack.initScriptSha256.toLowerCase()) throw new Error("rule pack init script hash mismatch");
  }
  return { id, ...pack, steps };
}
async function applyRuleSteps(page, pack) {
  if (!pack) return;
  for (const step of pack.steps) {
    try {
      if (step.type === "waitFor") await page.waitForSelector(step.selector, { timeout: step.timeoutMs ?? 15e3 });
      else if (step.type === "click") {
        await page.waitForSelector(step.selector, { timeout: step.timeoutMs ?? 15e3 });
        await page.click(step.selector);
      } else if (step.type === "wait") await page.waitForTimeout(step.waitMs);
      else for (let i = 0; i < (step.repeat ?? 1); i++) {
        await page.mouse?.wheel(0, step.deltaY ?? 2e3);
        await page.waitForTimeout(step.waitMs ?? 300);
      }
    } catch (error) {
      if ((step.type === "waitFor" || step.type === "click") && step.optional) continue;
      throw error;
    }
  }
}

// src/automation.ts
function finite(value, fallback, min, max, label) {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved < min || resolved > max) throw new Error(label + " must be between " + min + " and " + max);
  return resolved;
}
function selector(value) {
  if (!value || value.length > 500) throw new Error("selector must contain 1 to 500 characters");
  return value;
}
function shortText(value, label, max = 2e4) {
  if (value === void 0 || value.length === 0 || value.length > max) throw new Error(label + " must contain 1 to " + max + " characters");
  return value;
}
function validateRecipe(steps) {
  if (steps.length < 1 || steps.length > 25) throw new Error("recipe must contain between 1 and 25 steps");
  for (const step of steps) {
    switch (step.type) {
      case "wait": {
        finite(step.timeoutMs, 15e3, 0, 3e4, "wait timeoutMs");
        if (step.condition === "selector") selector(step.value);
        else if (step.condition === "text") shortText(step.value, "wait text", 2e3);
        else if (step.condition === "time") finite(step.waitMs ?? Number(step.value ?? 0), 0, 0, 1e4, "wait waitMs");
        break;
      }
      case "click":
        selector(step.selector);
        finite(step.timeoutMs, 15e3, 1, 3e4, "click timeoutMs");
        break;
      case "fill":
      case "type":
        selector(step.selector);
        shortText(step.value, step.type + " value");
        finite(step.timeoutMs, 15e3, 1, 3e4, step.type + " timeoutMs");
        break;
      case "press":
        shortText(step.key, "key", 100);
        if (step.selector !== void 0) selector(step.selector);
        break;
      case "select":
        selector(step.selector);
        shortText(step.value, "select value", 2e3);
        break;
      case "check":
      case "hover":
        selector(step.selector);
        break;
      case "scroll":
        finite(step.deltaY, 2e3, -2e4, 2e4, "scroll deltaY");
        finite(step.waitMs, 400, 0, 5e3, "scroll waitMs");
        break;
      case "extract":
        if (step.selector !== void 0) selector(step.selector);
        finite(step.limit, 100, 1, 500, "extract limit");
        if (step.mode === "attribute") shortText(step.attribute, "attribute", 100);
        break;
      case "assert":
        if (step.selector === void 0 && step.text === void 0) throw new Error("assert requires selector or text");
        if (step.selector !== void 0) selector(step.selector);
        if (step.text !== void 0) shortText(step.text, "assert text", 2e3);
        finite(step.timeoutMs, 15e3, 1, 3e4, "assert timeoutMs");
        break;
      case "screenshot":
        break;
      default:
        throw new Error("unsupported recipe step");
    }
  }
}
function cap(value, max = 5e4) {
  return value.length <= max ? value : value.slice(0, max) + "\n\u2026(truncated)";
}
async function runRecipe(page, steps, captureScreenshot, signal) {
  validateRecipe(steps);
  const results = [];
  for (let index = 0; index < steps.length; index += 1) {
    signal?.throwIfAborted();
    const step = steps[index];
    let value;
    switch (step.type) {
      case "wait": {
        const timeout = finite(step.timeoutMs, 15e3, 0, 3e4, "wait timeoutMs");
        if (step.condition === "selector") await page.locator(selector(step.value)).first().waitFor({ state: "visible", timeout });
        else if (step.condition === "text") await page.getByText(shortText(step.value, "wait text", 2e3), { exact: false }).first().waitFor({ state: "visible", timeout });
        else if (step.condition === "load") await page.waitForLoadState("networkidle", { timeout });
        else await page.waitForTimeout(finite(step.waitMs ?? Number(step.value ?? 0), 0, 0, 1e4, "wait waitMs"));
        break;
      }
      case "click":
        await page.locator(selector(step.selector)).first().click({ timeout: step.timeoutMs ?? 15e3 });
        break;
      case "fill":
        await page.locator(selector(step.selector)).first().fill(step.value, { timeout: step.timeoutMs ?? 15e3 });
        break;
      case "type":
        await page.locator(selector(step.selector)).first().pressSequentially(step.value, { timeout: step.timeoutMs ?? 15e3 });
        break;
      case "press":
        if (step.selector) await page.locator(selector(step.selector)).first().press(step.key);
        else await page.keyboard.press(step.key);
        break;
      case "select":
        await page.locator(selector(step.selector)).first().selectOption(step.value);
        break;
      case "check": {
        const target = page.locator(selector(step.selector)).first();
        if (step.checked === false) await target.uncheck();
        else await target.check();
        break;
      }
      case "hover":
        await page.locator(selector(step.selector)).first().hover();
        break;
      case "scroll":
        await page.mouse.wheel(0, step.deltaY ?? 2e3);
        await page.waitForTimeout(step.waitMs ?? 400);
        break;
      case "extract": {
        const target = page.locator(step.selector ?? "body").first();
        const mode = step.mode ?? "text";
        if (mode === "text") value = cap(await target.innerText());
        else if (mode === "html") value = cap(await target.innerHTML());
        else if (mode === "attribute") value = String(await target.getAttribute(shortText(step.attribute, "attribute", 100)) ?? "");
        else {
          const rows = await target.locator("a[href]").evaluateAll((anchors, limit) => anchors.slice(0, limit).map((anchor) => ({
            text: String(anchor.textContent ?? "").trim(),
            url: String(anchor.href ?? "")
          })), step.limit ?? 100);
          value = cap(JSON.stringify(rows));
        }
        break;
      }
      case "assert": {
        const timeout = step.timeoutMs ?? 15e3;
        if (step.selector) await page.locator(selector(step.selector)).first().waitFor({ state: "visible", timeout });
        if (step.text) await page.getByText(step.text, { exact: false }).first().waitFor({ state: "visible", timeout });
        break;
      }
      case "screenshot":
        value = await captureScreenshot();
        break;
    }
    results.push({ step: index + 1, action: step.type, ok: true, ...value !== void 0 ? { value } : {} });
  }
  return results;
}

// src/scripts.ts
import crypto2 from "node:crypto";
var header = (name, description) => `// ==UserScript==
// @name ${name}
// @description ${description}
// @match *://*/*
// @grant none
// ==/UserScript==`;
var BUILTIN_SCRIPTS = [
  {
    id: "article-clean",
    name: "Article Clean Reader",
    description: "Extract title, canonical URL, headings, and readable article text.",
    source: `${header("Article Clean Reader", "Extract readable article content without mutating the page.")}
const root = document.querySelector('article, main, [role="main"]') || document.body
return {
  title: document.title,
  canonicalUrl: document.querySelector('link[rel="canonical"]')?.href || location.href,
  headings: [...root.querySelectorAll('h1,h2,h3')].slice(0, 100).map(el => (el.textContent || '').trim()).filter(Boolean),
  text: (root.innerText || root.textContent || '').trim().slice(0, 50000),
}`
  },
  {
    id: "links",
    name: "Link Inventory",
    description: "Extract up to 200 visible links with absolute URLs.",
    source: `${header("Link Inventory", "Extract visible links without clicking them.")}
return [...document.querySelectorAll('a[href]')].slice(0, 200).map(a => ({
  text: (a.textContent || '').trim().slice(0, 500),
  url: a.href,
})).filter(item => item.url)`
  },
  {
    id: "jsonld",
    name: "JSON-LD Extractor",
    description: "Read structured JSON-LD blocks from the page.",
    source: `${header("JSON-LD Extractor", "Extract JSON-LD structured data.")}
return [...document.querySelectorAll('script[type="application/ld+json"]')].slice(0, 20).map(node => {
  try { return JSON.parse(node.textContent || 'null') } catch { return { invalid: true, text: (node.textContent || '').slice(0, 2000) } }
})`
  },
  {
    id: "forms",
    name: "Form Structure",
    description: "Describe forms and controls without returning current values.",
    source: `${header("Form Structure", "Describe form controls without exposing entered values.")}
return [...document.forms].slice(0, 30).map((form, formIndex) => ({
  form: formIndex,
  action: form.action,
  method: form.method,
  controls: [...form.elements].slice(0, 100).map(el => ({
    tag: el.tagName.toLowerCase(), type: el.type || '', name: el.name || '', id: el.id || '', required: !!el.required,
  })),
}))`
  }
];
function metadataOf(source) {
  const start = source.indexOf("// ==UserScript==");
  const end = source.indexOf("// ==/UserScript==");
  const rows = start >= 0 && end > start ? source.slice(start, end).split(/\r?\n/) : [];
  const values = /* @__PURE__ */ new Map();
  for (const row of rows) {
    const match = row.match(/^\s*\/\/\s*@([\w-]+)\s*(.*?)\s*$/);
    if (!match) continue;
    const key = match[1].toLowerCase();
    const list = values.get(key) ?? [];
    list.push(match[2]);
    values.set(key, list);
  }
  return {
    name: values.get("name")?.[0] || "External userscript",
    ...values.get("description")?.[0] ? { description: values.get("description")[0] } : {},
    matches: values.get("match") ?? [],
    excludes: values.get("exclude-match") ?? [],
    grants: values.get("grant") ?? [],
    requires: values.get("require") ?? []
  };
}
function globPath(pattern) {
  return new RegExp("^" + pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
}
function matchUserscriptPattern(pattern, targetUrl) {
  const parsed = pattern.match(/^(\*|https?|file|ftp):\/\/([^/]+)(\/.*)$/i);
  if (!parsed) return false;
  const url = new URL(targetUrl);
  if (parsed[1] === "*" ? !/^https?:$/.test(url.protocol) : url.protocol !== parsed[1].toLowerCase() + ":") return false;
  const wantedHost = parsed[2].toLowerCase();
  const host = url.hostname.toLowerCase();
  const hostMatches = wantedHost === "*" || (wantedHost.startsWith("*.") ? host === wantedHost.slice(2) || host.endsWith("." + wantedHost.slice(2)) : host === wantedHost);
  return hostMatches && globPath(parsed[3]).test(url.pathname + url.search + url.hash);
}
function capabilitiesOf(source) {
  const capabilities = /* @__PURE__ */ new Set(["dom-read"]);
  if (/\b(fetch|XMLHttpRequest|WebSocket|sendBeacon)\b/.test(source)) capabilities.add("network");
  if (/\b(localStorage|sessionStorage|indexedDB|document\.cookie)\b/.test(source)) capabilities.add("storage");
  if (/\.click\s*\(|dispatchEvent\s*\(|\.submit\s*\(|\blocation\s*=|history\.(pushState|replaceState)/.test(source)) capabilities.add("interaction");
  if (/\b(remove|append|prepend|replaceWith|insertAdjacentHTML)\s*\(|\.innerHTML\s*=|\.textContent\s*=/.test(source)) capabilities.add("dom-write");
  return [...capabilities];
}
function validateUserscript(source, targetUrl) {
  const bytes = Buffer.byteLength(source, "utf8");
  const sha256 = crypto2.createHash("sha256").update(source, "utf8").digest("hex");
  const parsed = metadataOf(source);
  const errors = [];
  const warnings = [];
  if (bytes < 1 || bytes > 64 * 1024) errors.push("source must contain between 1 and 65536 UTF-8 bytes");
  if (!source.includes("// ==UserScript==") || !source.includes("// ==/UserScript==")) errors.push("userscript metadata block is required");
  if (parsed.matches.length < 1) errors.push("at least one @match is required");
  if (parsed.matches.some((pattern) => !/^(\*|https?):\/\//i.test(pattern))) errors.push("only HTTP(S) @match patterns are supported");
  if (parsed.requires.length > 0) errors.push("@require is not supported; external code must be supplied inline for approval");
  const invalidGrants = parsed.grants.filter((grant) => grant !== "none");
  if (invalidGrants.length > 0) errors.push("unsupported @grant values: " + invalidGrants.join(", "));
  if (parsed.grants.length === 0) warnings.push("missing @grant; execution still provides no GM_* APIs");
  if (targetUrl !== void 0) {
    let matched = false;
    try {
      matched = parsed.matches.some((pattern) => matchUserscriptPattern(pattern, targetUrl)) && !parsed.excludes.some((pattern) => matchUserscriptPattern(pattern, targetUrl));
    } catch {
      errors.push("target URL is invalid");
    }
    if (!matched) errors.push("target URL is outside the userscript @match scope");
  }
  return {
    valid: errors.length === 0,
    sha256,
    bytes,
    metadata: {
      name: parsed.name,
      ...parsed.description ? { description: parsed.description } : {},
      matches: parsed.matches,
      excludes: parsed.excludes,
      grants: parsed.grants
    },
    capabilities: capabilitiesOf(source),
    errors,
    warnings
  };
}
function builtinScript(id) {
  const script = BUILTIN_SCRIPTS.find((candidate) => candidate.id === id);
  if (!script) throw new Error("unknown built-in script: " + id);
  return script;
}
async function executeUserscript(page, source, maxResultChars = 1e5, inputs = {}) {
  const serializedInputs = JSON.stringify(inputs);
  const result = await page.evaluate(`(async () => {
const __DSH_INPUTS__ = Object.freeze(${serializedInputs});
${source}
})()`);
  let resultJson;
  try {
    resultJson = JSON.stringify(result ?? null);
  } catch {
    resultJson = JSON.stringify({ unserializable: true, text: String(result) });
  }
  const truncated = resultJson.length > maxResultChars;
  if (truncated) resultJson = resultJson.slice(0, maxResultChars) + "\u2026";
  return { resultJson, truncated };
}

// src/freedom.ts
var ALL_BROWSER_TOOL_NAMES = [
  "browser_open",
  "browser_click",
  "browser_type",
  "browser_wait",
  "browser_press",
  "browser_select",
  "browser_check",
  "browser_hover",
  "browser_set_files",
  "browser_evaluate",
  "browser_console",
  "browser_requests",
  "browser_scroll",
  "browser_read",
  "browser_screenshot",
  "browser_close",
  "browser_status",
  "browser_install",
  "browser_script_catalog",
  "browser_script_validate",
  "browser_script_run_builtin",
  "browser_userscript_run",
  "browser_recipe_run",
  "browser_automation_search",
  "browser_automation_develop",
  "browser_automation_run",
  "browser_opencli_status",
  "browser_opencli_catalog",
  "browser_opencli_run",
  "browser_crawl"
];
var READ_ONLY_TOOL_NAMES = /* @__PURE__ */ new Set([
  "browser_open",
  "browser_wait",
  "browser_read",
  "browser_screenshot",
  "browser_console",
  "browser_requests",
  "browser_close",
  "browser_status",
  "browser_script_catalog",
  "browser_script_validate",
  "browser_script_run_builtin",
  "browser_recipe_run",
  "browser_automation_search",
  "browser_automation_develop",
  "browser_opencli_status",
  "browser_opencli_catalog",
  "browser_crawl"
]);
function isBrowserToolExposed(name, mode) {
  if (!ALL_BROWSER_TOOL_NAMES.includes(name)) return false;
  return mode !== "read-only" || READ_ONLY_TOOL_NAMES.has(name);
}
function browserToolsForMode(mode) {
  return ALL_BROWSER_TOOL_NAMES.filter((name) => isBrowserToolExposed(name, mode));
}
function configuredBrowserTools(mode, options, enabled = true) {
  if (!enabled) return [];
  return browserToolsForMode(mode).filter((name) => name !== "browser_automation_develop" || options.modelDevelopmentEnabled);
}

// src/opencli-catalog.ts
function stringField(value) {
  return typeof value === "string" ? value.slice(0, 2e3) : "";
}
function parseOpencliCatalog(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error("OpenCLI catalog did not return valid JSON");
  }
  if (!Array.isArray(parsed)) throw new Error("OpenCLI catalog JSON must be an array");
  return parsed.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const row = value;
    const command = stringField(row.command);
    if (!command) return [];
    return [{
      command,
      site: stringField(row.site),
      name: stringField(row.name),
      description: stringField(row.description),
      access: stringField(row.access),
      strategy: stringField(row.strategy),
      args: Array.isArray(row.args) ? row.args.slice(0, 30) : [],
      ...stringField(row.example) ? { example: stringField(row.example) } : {},
      ...stringField(row.domain) ? { domain: stringField(row.domain) } : {}
    }];
  }).slice(0, 1e4);
}
function filterOpencliCatalog(catalog, filter = {}) {
  const query = filter.query?.trim().toLowerCase();
  const site = filter.site?.trim().toLowerCase();
  const access = filter.access?.trim().toLowerCase();
  const strategy = filter.strategy?.trim().toLowerCase();
  const limit = Math.min(Math.max(filter.limit ?? 25, 1), 100);
  return catalog.filter((item) => !site || item.site.toLowerCase() === site).filter((item) => !access || item.access.toLowerCase() === access).filter((item) => !strategy || item.strategy.toLowerCase() === strategy).filter((item) => !query || [item.command, item.site, item.name, item.description].some((value) => value.toLowerCase().includes(query))).sort((a, b) => a.command.localeCompare(b.command)).slice(0, limit);
}

// src/usage-policy.ts
function abortedError() {
  return new Error("usage policy wait aborted");
}
function delay(ms, signal) {
  if (signal?.aborted) return Promise.reject(abortedError());
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(abortedError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
var UsageGovernor = class {
  constructor(policy) {
    this.policy = policy;
  }
  policy;
  active = 0;
  globalWaiters = [];
  hosts = /* @__PURE__ */ new Map();
  queued = 0;
  totalRuns = 0;
  totalWaitMs = 0;
  backoffEvents = 0;
  host(url) {
    let key;
    try {
      key = new URL(url).hostname.toLowerCase();
    } catch {
      throw new Error("usage policy requires an absolute HTTP(S) URL");
    }
    if (!key) throw new Error("usage policy requires a URL hostname");
    let state = this.hosts.get(key);
    if (!state) {
      state = { starts: [], blockedUntil: 0, consecutiveFailures: 0 };
      this.hosts.set(key, state);
    }
    return { key, state };
  }
  async acquireGlobal(signal) {
    if (signal?.aborted) throw abortedError();
    if (this.active < this.policy.maxConcurrency) {
      this.active++;
      return;
    }
    this.queued++;
    await new Promise((resolve, reject) => {
      const resume = () => {
        signal?.removeEventListener("abort", onAbort);
        this.queued--;
        resolve();
      };
      const onAbort = () => {
        const index = this.globalWaiters.indexOf(resume);
        if (index >= 0) this.globalWaiters.splice(index, 1);
        signal?.removeEventListener("abort", onAbort);
        this.queued--;
        reject(abortedError());
      };
      this.globalWaiters.push(resume);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
  releaseGlobal() {
    const next = this.globalWaiters.shift();
    if (next) next();
    else this.active--;
  }
  async acquireHost(state, signal) {
    while (true) {
      const now = Date.now();
      const windowStart = now - this.policy.minDelayMs;
      state.starts = state.starts.filter((start) => start > windowStart);
      const burstReady = state.starts.length < this.policy.burst;
      const readyAt = Math.max(
        state.blockedUntil,
        burstReady ? now : (state.starts[0] ?? now) + this.policy.minDelayMs
      );
      if (readyAt <= now) {
        state.starts.push(now);
        return;
      }
      const waitMs = readyAt - now;
      this.totalWaitMs += waitMs;
      await delay(waitMs, signal);
    }
  }
  async run(url, operation, signal) {
    const { state } = this.host(url);
    await this.acquireGlobal(signal);
    try {
      await this.acquireHost(state, signal);
      this.totalRuns++;
      return await operation();
    } finally {
      this.releaseGlobal();
    }
  }
  /** Record server pressure. Returns the applied host cooldown in milliseconds. */
  noteResponse(url, status, retryAfterMs) {
    const { state } = this.host(url);
    if (status >= 200 && status < 400) {
      state.consecutiveFailures = 0;
      return 0;
    }
    if (![429, 502, 503, 504].includes(status)) return 0;
    state.consecutiveFailures++;
    this.backoffEvents++;
    const exponential = this.policy.backoffBaseMs * 2 ** Math.max(0, state.consecutiveFailures - 1);
    const applied = Math.min(Math.max(retryAfterMs ?? exponential, 0), this.policy.cooldownMs);
    state.blockedUntil = Math.max(state.blockedUntil, Date.now() + applied);
    return applied;
  }
  snapshot() {
    const now = Date.now();
    return {
      active: this.active,
      queued: this.queued,
      trackedHosts: this.hosts.size,
      coolingHosts: [...this.hosts.values()].filter((state) => state.blockedUntil > now).length,
      totalRuns: this.totalRuns,
      totalWaitMs: this.totalWaitMs,
      backoffEvents: this.backoffEvents
    };
  }
};

// src/browser-service.ts
var EXTRACTOR_FN = `(ruleList) => {
  const doc = document
  const title = doc.title ? doc.title.trim() : ''
  let host = ''
  try { host = location.hostname } catch (e) {}
  const norm = (h) => { const x = h.toLowerCase(); return x.startsWith('www.') ? x.slice(4) : x }
  let rule = null
  for (const r of ruleList) {
    const rh = norm(r.hostname)
    if (host === rh || host.endsWith('.' + rh)) rule = r
  }
  const pick = (selectors) => {
    for (const sel of selectors) {
      try {
        const el = doc.querySelector(sel)
        if (el && (el.textContent || '').trim().length > 40) return el
      } catch (e) {}
    }
    return null
  }
  const content = rule ? pick(rule.contentSelectors) : (pick(['article', 'main', '[role="main"]']) || doc.body)
  if (content && rule && rule.removeSelectors) {
    for (const sel of rule.removeSelectors) {
      try { content.querySelectorAll(sel).forEach((el) => el.remove()) } catch (e) {}
    }
  }
  const text = content ? (content.innerText || content.textContent || '') : ''
  return { title, text, html: doc.documentElement.outerHTML.slice(0, 2000000), usedRule: rule ? rule.hostname : null }
}`;
var LIST_EXTRACTOR = `(spec) => {
  const items = []
  const nodes = document.querySelectorAll(spec.item)
  for (let i = 0; i < nodes.length && items.length < 20; i++) {
    const el = nodes[i]
    const titleEl = spec.title ? el.querySelector(spec.title) : null
    const linkEl = spec.link ? el.querySelector(spec.link) : null
    const textEl = spec.text ? el.querySelector(spec.text) : null
    const title = (titleEl ? titleEl.textContent : el.textContent || '').trim().replace(/\\s+/g, ' ')
    let url = linkEl ? (linkEl.href || linkEl.getAttribute('href') || '') : ''
    if (url && url.startsWith('/')) url = location.origin + url
    if (!url && linkEl === null && titleEl) { const a = titleEl.closest ? titleEl.closest('a') : null; if (a) url = a.href }
    const snippet = textEl ? (textEl.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 300) : ''
    if (!url || !title || title.length < 2) continue
    items.push({ url, title, snippet })
  }
  return items
}`;
var CRAWL_EXTRACTOR = `(maxChars) => {
  const root = document.querySelector('article, main, [role="main"]') || document.body
  const text = ((root && (root.innerText || root.textContent)) || '').replace(/\\n{3,}/g, '\\n\\n').trim().slice(0, maxChars)
  const links = []
  for (const anchor of document.querySelectorAll('a[href]')) {
    try {
      const url = new URL(anchor.href, location.href)
      if ((url.protocol === 'http:' || url.protocol === 'https:') && !links.includes(url.href)) links.push(url.href)
      if (links.length >= 500) break
    } catch (e) {}
  }
  return { title: document.title || '', text, links }
}`;
function uid() {
  return crypto3.randomUUID();
}
function capText(text, maxChars) {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + "\n\n(Content truncated at " + maxChars + " characters.)";
}
function specArg(spec) {
  return { item: spec.item, title: spec.title, link: spec.link, text: spec.text ?? "" };
}
function evaluateExtractor(page, rules) {
  return page.evaluate("(" + EXTRACTOR_FN + ")(" + JSON.stringify(rules) + ")");
}
function storageStateOptions(statePath, label, allowMissing = false) {
  if (!statePath) return {};
  if (!fs4.existsSync(statePath)) {
    if (allowMissing) return {};
    throw new Error(`dsh-browser: ${label} storageState file does not exist: ${statePath}`);
  }
  if (!fs4.statSync(statePath).isFile()) throw new Error(`dsh-browser: ${label} storageState path is not a file: ${statePath}`);
  return { storageState: statePath };
}
function boundedString(value, label, max) {
  if (!value || value.length > max) throw new Error(`${label} must contain 1 to ${max} characters`);
  return value;
}
function boundedTimeout(value, label) {
  const resolved = value ?? 15e3;
  if (!Number.isFinite(resolved) || resolved < 1 || resolved > 3e4) throw new Error(`${label} must be between 1 and 30,000 ms`);
  return resolved;
}
function redactCaptureText(value, max = 2e3) {
  return value.replace(/\b(authorization|cookie|set-cookie|password|passwd|secret|token|api[-_]?key|session[-_]?id)\b\s*[:=]\s*([^\s,;]+)/gi, "$1=[redacted]").slice(0, max);
}
function redactCaptureUrl(value) {
  try {
    const parsed = new URL(value);
    for (const key of [...parsed.searchParams.keys()]) {
      if (/token|key|auth|session|cookie|password|secret/i.test(key)) parsed.searchParams.set(key, "[redacted]");
    }
    return parsed.toString().slice(0, 2e3);
  } catch {
    return redactCaptureText(value);
  }
}
var BrowserService = class {
  constructor(config) {
    this.config = config;
    this.authProfiles = new AuthProfileStore(config.authProfiles);
    this.usageGovernor = new UsageGovernor(config.usagePolicy);
  }
  config;
  browser;
  launching;
  activeContext;
  activePage;
  activeProfile;
  activeRulePack;
  authProfiles;
  usageGovernor;
  opencliCatalogCache;
  captureConsoleEnabled = false;
  captureNetworkEnabled = false;
  capturedConsole = [];
  capturedRequests = [];
  available() {
    return this.config.enabled;
  }
  assertEnabled() {
    if (!this.config.enabled) throw new Error("dsh-browser: browser service is disabled");
  }
  browserConnected(browser = this.browser) {
    return !!browser && (typeof browser.isConnected !== "function" || browser.isConnected());
  }
  clearActiveState() {
    this.activeContext = void 0;
    this.activePage = void 0;
    this.activeProfile = void 0;
    this.activeRulePack = void 0;
    this.resetCapture();
  }
  handleBrowserDisconnected(browser) {
    if (this.browser !== browser) return;
    this.browser = void 0;
    this.launching = void 0;
    this.clearActiveState();
  }
  trackBrowser(browser) {
    this.browser = browser;
    browser.on?.("disconnected", () => this.handleBrowserDisconnected(browser));
    return browser;
  }
  async ensure() {
    this.assertEnabled();
    if (this.browserConnected()) return this.browser;
    if (this.browser) this.handleBrowserDisconnected(this.browser);
    if (!this.launching) {
      this.launching = (async () => {
        const pw = loadBrowserRuntime(this.config.browserRuntime);
        if (this.config.cdpEndpoint) {
          try {
            const browser = await pw.chromium.connectOverCDP(this.config.cdpEndpoint);
            return this.trackBrowser(browser);
          } catch (error) {
            throw new Error("dsh-browser: failed to connect to CDP endpoint " + this.config.cdpEndpoint + ": " + error.message);
          }
        }
        const launchOptions = { headless: this.config.headless };
        if (this.config.channel) launchOptions.channel = this.config.channel;
        if (this.config.executablePath) launchOptions.executablePath = this.config.executablePath;
        try {
          return this.trackBrowser(await pw.chromium.launch(launchOptions));
        } catch (error) {
          const msg = String(error);
          if (/Executable doesn't exist|playwright install|not found/i.test(msg)) {
            if (this.config.autoInstall) {
              await this.installChromium();
              return this.trackBrowser(await pw.chromium.launch(launchOptions));
            } else {
              throw new Error("dsh-browser: chromium is not installed for " + this.config.browserRuntime + '. Run the browser_install tool, or: node "' + browserRuntimeCliPath(this.config.browserRuntime) + '" install chromium');
            }
          } else {
            throw error;
          }
        }
      })();
    }
    const launching = this.launching;
    try {
      return await launching;
    } finally {
      if (this.launching === launching) this.launching = void 0;
    }
  }
  /** Run `playwright install chromium` from the bundled playwright CLI. */
  installChromium() {
    this.assertEnabled();
    return runNode(browserRuntimeCliPath(this.config.browserRuntime), ["install", "chromium"], { timeoutMs: 6e5, signal: void 0, maxOutput: 256 * 1024 });
  }
  async navigate(page, url, options, signal) {
    let response;
    for (let attempt = 0; attempt <= this.config.usagePolicy.retryLimit; attempt++) {
      response = await this.usageGovernor.run(url, () => page.goto(url, options), signal);
      const status = Number(response?.status?.() ?? 0);
      if (status >= 200 && status < 400) this.usageGovernor.noteResponse(url, status);
      if (![429, 502, 503, 504].includes(status)) return response;
      const rawRetryAfter = String(response?.headers?.()?.["retry-after"] ?? "");
      const retryAfterMs = /^\d+(?:\.\d+)?$/.test(rawRetryAfter) ? Number(rawRetryAfter) * 1e3 : Number.isFinite(Date.parse(rawRetryAfter)) ? Math.max(Date.parse(rawRetryAfter) - Date.now(), 0) : void 0;
      this.usageGovernor.noteResponse(url, status, retryAfterMs);
      if (attempt === this.config.usagePolicy.retryLimit) return response;
    }
    return response;
  }
  async transientContext(url, opts = {}) {
    const profileId = opts.anonymous ? void 0 : opts.authProfile ?? this.config.defaultAuthProfile;
    const profile = profileId ? this.authProfiles.resolve(profileId, url) : void 0;
    const rulePack = resolveRulePack(this.config.rulePacks, opts.rulePack, url);
    const stateOptions = profile ? storageStateOptions(profile.storageStatePath, `auth profile ${profile.id}`, profile.persistState) : !opts.anonymous ? storageStateOptions(this.config.storageStatePath, "global") : {};
    let context;
    for (let attempt = 0; attempt < 2; attempt++) {
      const browser = await this.ensure();
      try {
        context = await browser.newContext(stateOptions);
        break;
      } catch (error) {
        if (attempt > 0 || this.browserConnected(browser)) throw error;
        this.handleBrowserDisconnected(browser);
      }
    }
    if (!context) throw new Error("dsh-browser: browser context could not be created after reconnecting");
    try {
      if (rulePack?.initScriptPath) await context.addInitScript({ path: rulePack.initScriptPath });
    } catch (error) {
      await context.close().catch(() => {
      });
      throw error;
    }
    return { context, ...profile ? { profile } : {}, ...rulePack ? { rulePack } : {} };
  }
  async persistAndClose(session) {
    try {
      if (session.profile?.persistState) {
        let state;
        try {
          state = await session.context.storageState();
        } catch (error) {
          if (/target page, context or browser has been closed|browser has been closed|browser disconnected/i.test(String(error))) return;
          throw error;
        }
        fs4.mkdirSync(path2.dirname(session.profile.storageStatePath), { recursive: true });
        const temporary = session.profile.storageStatePath + ".tmp-" + uid().slice(0, 8);
        fs4.writeFileSync(temporary, JSON.stringify(state, null, 2), { encoding: "utf8", mode: 384 });
        fs4.renameSync(temporary, session.profile.storageStatePath);
      }
    } finally {
      await session.context.close().catch(() => {
      });
    }
  }
  // ── render / snapshot / searchResults (web-search-pro contract) ──────────
  async render(url, rules, opts = {}) {
    const session = await this.transientContext(url, opts);
    const { context } = session;
    const page = await context.newPage();
    const signal = opts.signal;
    const onAbort = () => void page.close().catch(() => {
    });
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort);
    try {
      page.setDefaultTimeout(2e4);
      await this.navigate(page, url, { waitUntil: "domcontentloaded", timeout: 25e3 }, signal);
      await page.waitForLoadState("networkidle", { timeout: 8e3 }).catch(() => {
      });
      await applyRuleSteps(page, session.rulePack);
      if (opts.waitMs) await page.waitForTimeout(opts.waitMs);
      const data = await evaluateExtractor(page, rules);
      return {
        title: String(data.title ?? ""),
        text: capText(String(data.text ?? "").replace(/\n{3,}/g, "\n\n").trim(), opts.maxChars ?? 2e5),
        html: String(data.html ?? ""),
        ...data.usedRule ? { usedRule: String(data.usedRule) } : {}
      };
    } catch (error) {
      throw new Error("browser render failed for " + url + ": " + String(error).slice(0, 300));
    } finally {
      signal?.removeEventListener("abort", onAbort);
      await this.persistAndClose(session);
    }
  }
  async snapshot(url, rules, opts) {
    const session = await this.transientContext(url, opts);
    const { context } = session;
    const page = await context.newPage();
    const signal = opts.signal;
    const onAbort = () => void page.close().catch(() => {
    });
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort);
    fs4.mkdirSync(opts.outDir, { recursive: true });
    const stamp = Date.now() + "-" + uid().slice(0, 8);
    const screenshotPath = opts.screenshot === false ? void 0 : path2.join(opts.outDir, stamp + ".png");
    const htmlPath = path2.join(opts.outDir, stamp + ".html");
    try {
      page.setDefaultTimeout(25e3);
      await this.navigate(page, url, { waitUntil: "domcontentloaded", timeout: 3e4 }, signal);
      await page.waitForLoadState("networkidle", { timeout: 1e4 }).catch(() => {
      });
      await applyRuleSteps(page, session.rulePack);
      if (screenshotPath) await page.screenshot({ path: screenshotPath, fullPage: true });
      const html = await page.content();
      fs4.writeFileSync(htmlPath, html, "utf8");
      const data = await evaluateExtractor(page, rules);
      return {
        title: String(data.title ?? ""),
        text: capText(String(data.text ?? "").replace(/\n{3,}/g, "\n\n").trim(), opts.maxChars ?? 2e5),
        ...screenshotPath ? { screenshotPath } : {},
        htmlPath,
        ...data.usedRule ? { usedRule: String(data.usedRule) } : {}
      };
    } catch (error) {
      throw new Error("browser snapshot failed for " + url + ": " + String(error).slice(0, 300));
    } finally {
      signal?.removeEventListener("abort", onAbort);
      await this.persistAndClose(session);
    }
  }
  async searchResults(url, spec, opts = {}) {
    const session = await this.transientContext(url, opts);
    const { context } = session;
    if (opts.cookies?.length) await context.addCookies(opts.cookies).catch(() => {
    });
    const page = await context.newPage();
    const signal = opts.signal;
    const onAbort = () => void page.close().catch(() => {
    });
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort);
    try {
      page.setDefaultTimeout(25e3);
      await this.navigate(page, url, { waitUntil: "domcontentloaded", timeout: 3e4 }, signal);
      await page.waitForLoadState("networkidle", { timeout: 8e3 }).catch(() => {
      });
      await applyRuleSteps(page, session.rulePack);
      if (opts.waitMs) await page.waitForTimeout(opts.waitMs);
      await page.mouse?.wheel(0, 2e3).catch(() => {
      });
      await page.waitForTimeout(800);
      const data = await page.evaluate("(" + LIST_EXTRACTOR + ")(" + JSON.stringify(specArg(spec)) + ")");
      const rows = Array.isArray(data) ? data : [];
      return rows.slice(0, Math.min(Math.max(opts.count ?? 8, 1), 20)).map((r) => ({
        url: String(r.url ?? ""),
        title: String(r.title ?? ""),
        ...r.snippet ? { snippet: String(r.snippet) } : {}
      }));
    } catch (error) {
      throw new Error("browser platform search failed for " + url + ": " + String(error).slice(0, 300));
    } finally {
      signal?.removeEventListener("abort", onAbort);
      await this.persistAndClose(session);
    }
  }
  // ── bundled opencli ───────────────────────────────────────────────────────
  opencliAvailable() {
    if (!this.config.enabled || !this.config.opencliEnabled) return false;
    try {
      return fs4.existsSync(opencliEntryPath());
    } catch {
      return false;
    }
  }
  opencli(args, opts = {}) {
    if (!this.config.enabled) return Promise.resolve({ code: -1, stdout: "", stderr: "dsh-browser: browser service is disabled", timedOut: false });
    if (!this.config.opencliEnabled) return Promise.resolve({ code: -1, stdout: "", stderr: "dsh-browser: OpenCLI is disabled", timedOut: false });
    if (!this.opencliAvailable()) return Promise.resolve({ code: -1, stdout: "", stderr: "dsh-browser: OpenCLI entry is not installed", timedOut: false });
    if (args.length < 1 || args.length > 40 || args.some((arg) => typeof arg !== "string" || arg.length > 2e3)) {
      return Promise.resolve({ code: -1, stdout: "", stderr: "dsh-browser: OpenCLI requires 1 to 40 arguments, each at most 2000 characters", timedOut: false });
    }
    return this.usageGovernor.run(
      "https://opencli.local/",
      () => runOpencli(args, { ...opts, signal: opts.signal }),
      opts.signal
    );
  }
  opencliDoctor(signal) {
    return this.opencli(["doctor"], { timeoutMs: 3e4, signal });
  }
  async opencliCatalog(filter = {}, signal) {
    if (!this.config.opencliEnabled) throw new Error("dsh-browser: OpenCLI is disabled");
    if (!this.opencliCatalogCache) {
      const result = await this.opencli(["list", "-f", "json"], { timeoutMs: 6e4, signal });
      if (result.code !== 0 || result.timedOut) throw new Error("OpenCLI catalog failed: " + (result.stderr || result.stdout).slice(0, 500));
      this.opencliCatalogCache = parseOpencliCatalog(result.stdout);
    }
    return filterOpencliCatalog(this.opencliCatalogCache, filter);
  }
  async crawl(startUrls, opts = {}) {
    if (startUrls.length < 1 || startUrls.length > 5) throw new Error("browser crawl requires 1 to 5 start URLs");
    const normalized = startUrls.map((value) => {
      const url = new URL(value);
      if (!["http:", "https:"].includes(url.protocol)) throw new Error("browser crawl only supports HTTP(S) URLs");
      url.hash = "";
      return url.href;
    });
    const maxPages = opts.maxPages ?? this.config.usagePolicy.maxPagesPerRun;
    const maxDepth = opts.maxDepth ?? this.config.usagePolicy.maxDepth;
    if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > this.config.usagePolicy.maxPagesPerRun) {
      throw new Error("browser crawl maxPages must be from 1 to configured usagePolicy.maxPagesPerRun (" + this.config.usagePolicy.maxPagesPerRun + ")");
    }
    if (!Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > this.config.usagePolicy.maxDepth) {
      throw new Error("browser crawl maxDepth must be from 0 to configured usagePolicy.maxDepth (" + this.config.usagePolicy.maxDepth + ")");
    }
    const maxCharsPerPage = Math.min(Math.max(opts.maxCharsPerPage ?? 2e4, 1e3), 5e4);
    const sameOrigin = opts.sameOrigin ?? true;
    const allowedOrigins = new Set(normalized.map((value) => new URL(value).origin));
    const queue = normalized.map((url) => ({ url, depth: 0 }));
    const seen = new Set(normalized);
    const pages = [];
    const errors = [];
    const before = this.usageGovernor.snapshot();
    const started = Date.now();
    const session = await this.transientContext(normalized[0], { anonymous: true });
    try {
      while (queue.length && pages.length + errors.length < maxPages) {
        if (opts.signal?.aborted) throw new Error("browser crawl aborted");
        const item = queue.shift();
        const page = await session.context.newPage();
        try {
          page.setDefaultTimeout(3e4);
          const response = await this.navigate(page, item.url, { waitUntil: "domcontentloaded", timeout: 3e4 }, opts.signal);
          const status = Number(response?.status?.() ?? 0);
          if (sameOrigin && !allowedOrigins.has(new URL(page.url()).origin)) {
            errors.push({ url: item.url, depth: item.depth, status, error: "cross-origin redirect blocked: " + page.url() });
            continue;
          }
          if (status >= 400) {
            errors.push({ url: item.url, depth: item.depth, status, error: "HTTP " + status });
            continue;
          }
          await page.waitForLoadState("networkidle", { timeout: 5e3 }).catch(() => {
          });
          const data = await page.evaluate("(" + CRAWL_EXTRACTOR + ")(" + maxCharsPerPage + ")");
          pages.push({ url: page.url(), title: String(data.title ?? ""), text: String(data.text ?? ""), depth: item.depth, status });
          if (item.depth >= maxDepth) continue;
          for (const rawLink of Array.isArray(data.links) ? data.links : []) {
            let link;
            try {
              link = new URL(rawLink);
              link.hash = "";
            } catch {
              continue;
            }
            if (sameOrigin && !allowedOrigins.has(link.origin)) continue;
            const href = link.href;
            if (seen.has(href) || seen.size >= maxPages * 25) continue;
            seen.add(href);
            queue.push({ url: href, depth: item.depth + 1 });
          }
        } catch (error) {
          errors.push({ url: item.url, depth: item.depth, error: String(error).slice(0, 500) });
        } finally {
          await page.close().catch(() => {
          });
        }
      }
    } finally {
      await this.persistAndClose(session);
    }
    const after = this.usageGovernor.snapshot();
    return {
      pages,
      errors,
      stats: {
        pagesVisited: pages.length + errors.length,
        queued: queue.length,
        elapsedMs: Date.now() - started,
        waitMs: after.totalWaitMs - before.totalWaitMs,
        backoffEvents: after.backoffEvents - before.backoffEvents
      },
      warnings: [
        "Bounded crawl: respect each site's terms, robots directives, copyright, privacy, and applicable law.",
        "No-approval mode skips human confirmation only; concurrency, burst, page/depth budgets, and server-pressure backoff remain active."
      ]
    };
  }
  scriptCatalog() {
    return BUILTIN_SCRIPTS.map((script) => ({
      id: script.id,
      name: script.name,
      description: script.description,
      sha256: validateUserscript(script.source).sha256
    }));
  }
  validateUserscript(source, targetUrl) {
    return validateUserscript(source, targetUrl);
  }
  async runScript(url, source, opts = {}) {
    const validation = validateUserscript(source, url);
    if (!validation.valid) throw new Error("userscript validation failed: " + validation.errors.join("; "));
    const session = await this.transientContext(url, opts);
    const page = await session.context.newPage();
    const signal = opts.signal;
    const onAbort = () => void page.close().catch(() => {
    });
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort);
    let timer;
    try {
      page.setDefaultTimeout(3e4);
      await this.navigate(page, url, { waitUntil: "domcontentloaded", timeout: 3e4 }, signal);
      await page.waitForLoadState("networkidle", { timeout: 8e3 }).catch(() => {
      });
      await applyRuleSteps(page, session.rulePack);
      const timeoutMs = Math.min(Math.max(opts.timeoutMs ?? 15e3, 1e3), 3e4);
      const timeout = new Promise((_resolve, reject) => {
        timer = setTimeout(() => {
          void page.close().catch(() => {
          });
          reject(new Error("userscript timed out after " + timeoutMs + "ms"));
        }, timeoutMs);
      });
      const executed = await Promise.race([executeUserscript(page, source, 1e5, opts.inputs), timeout]);
      return {
        url: page.url(),
        name: validation.metadata.name,
        sha256: validation.sha256,
        capabilities: validation.capabilities,
        resultJson: executed.resultJson,
        truncated: executed.truncated
      };
    } finally {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      await this.persistAndClose(session);
    }
  }
  runBuiltinScript(url, id, opts = {}) {
    return this.runScript(url, builtinScript(id).source, opts);
  }
  runUserscript(url, source, opts = {}) {
    return this.runScript(url, source, opts);
  }
  // ── interactive surface (one persistent context + page) ──────────────────
  async ensureActivePage(targetUrl, opts = {}) {
    if (this.activePage && (this.activePage.isClosed() || !this.browserConnected())) await this.closePage();
    if (this.activePage && !this.activePage.isClosed()) {
      if (!targetUrl) return this.activePage;
      if ((opts.authProfile ?? this.config.defaultAuthProfile) === this.activeProfile?.id && opts.rulePack === this.activeRulePack?.id) {
        if (this.activeProfile) this.authProfiles.resolve(this.activeProfile.id, targetUrl);
        if (this.activeRulePack) resolveRulePack(this.config.rulePacks, this.activeRulePack.id, targetUrl);
        return this.activePage;
      }
      await this.closePage();
    }
    if (targetUrl) {
      const session = await this.transientContext(targetUrl, opts);
      this.activeContext = session.context;
      this.activeProfile = session.profile;
      this.activeRulePack = session.rulePack;
    } else {
      const browser = await this.ensure();
      this.activeContext = await browser.newContext(storageStateOptions(this.config.storageStatePath, "global"));
    }
    this.activePage = await this.activeContext.newPage();
    this.attachCapture(this.activePage);
    return this.activePage;
  }
  attachCapture(page) {
    const release = () => {
      if (this.activePage !== page) return;
      const context = this.activeContext;
      const profile = this.activeProfile;
      this.clearActiveState();
      if (context) void this.persistAndClose({ context, ...profile ? { profile } : {} }).catch(() => {
      });
    };
    page.on("close", release);
    page.on("crash", release);
    page.on("console", (message) => {
      if (!this.captureConsoleEnabled) return;
      const location = message.location?.();
      this.capturedConsole.push({
        type: String(message.type?.() ?? "log").slice(0, 40),
        text: redactCaptureText(String(message.text?.() ?? "")),
        ...location?.url ? { url: redactCaptureUrl(location.url) } : {},
        timestamp: (/* @__PURE__ */ new Date()).toISOString()
      });
      if (this.capturedConsole.length > 200) this.capturedConsole.splice(0, this.capturedConsole.length - 200);
    });
    page.on("response", (response) => {
      if (!this.captureNetworkEnabled) return;
      const status = Number(response.status?.() ?? 0);
      if (status < 400) return;
      const request = response.request?.();
      this.capturedRequests.push({
        method: String(request?.method?.() ?? "GET").slice(0, 20),
        url: redactCaptureUrl(String(response.url?.() ?? "")),
        status,
        timestamp: (/* @__PURE__ */ new Date()).toISOString()
      });
      if (this.capturedRequests.length > 200) this.capturedRequests.splice(0, this.capturedRequests.length - 200);
    });
    page.on("requestfailed", (request) => {
      if (!this.captureNetworkEnabled) return;
      this.capturedRequests.push({
        method: String(request.method?.() ?? "GET").slice(0, 20),
        url: redactCaptureUrl(String(request.url?.() ?? "")),
        failure: redactCaptureText(String(request.failure?.()?.errorText ?? "request failed"), 500),
        timestamp: (/* @__PURE__ */ new Date()).toISOString()
      });
      if (this.capturedRequests.length > 200) this.capturedRequests.splice(0, this.capturedRequests.length - 200);
    });
  }
  resetCapture(capture = []) {
    this.captureConsoleEnabled = capture.includes("console");
    this.captureNetworkEnabled = capture.includes("network");
    this.capturedConsole = [];
    this.capturedRequests = [];
  }
  resolveTarget(page, target) {
    if (!target || typeof target !== "string" && typeof target !== "object") throw new Error("browser target must be a selector string or locator object");
    const spec = typeof target === "string" ? { selector: target } : target;
    const modes = [spec.selector, spec.role, spec.text, spec.label].filter((value) => value !== void 0);
    if (modes.length !== 1) throw new Error("browser target requires exactly one of selector, role, text, or label");
    if (spec.name !== void 0 && spec.role === void 0) throw new Error("browser target name is only valid with role");
    let root = page;
    if (spec.frame) {
      const frameModes = [spec.frame.selector, spec.frame.name, spec.frame.url].filter((value) => value !== void 0);
      if (frameModes.length !== 1) throw new Error("browser frame requires exactly one of selector, name, or url");
      if (spec.frame.selector) root = page.frameLocator(boundedString(spec.frame.selector, "frame selector", 500));
      else {
        const frame = page.frame(spec.frame.name ? { name: boundedString(spec.frame.name, "frame name", 500) } : { url: boundedString(spec.frame.url, "frame url", 2e3) });
        if (!frame) throw new Error("browser target frame was not found");
        root = frame;
      }
    }
    if (spec.selector) return root.locator(boundedString(spec.selector, "selector", 500));
    if (spec.role) return root.getByRole(boundedString(spec.role, "role", 100), {
      ...spec.name !== void 0 ? { name: boundedString(spec.name, "role name", 2e3) } : {},
      exact: spec.exact ?? false
    });
    if (spec.text) return root.getByText(boundedString(spec.text, "text locator", 2e3), { exact: spec.exact ?? false });
    return root.getByLabel(boundedString(spec.label, "label locator", 2e3), { exact: spec.exact ?? false });
  }
  screenshotFile(options) {
    const filename = options.filename ?? `shot-${Date.now()}-${uid().slice(0, 8)}.${options.format === "jpeg" ? "jpg" : "png"}`;
    if (filename !== path2.basename(filename) || !/^[\w.() -]{1,160}$/.test(filename)) {
      throw new Error("browser_screenshot filename must be a plain file name inside snapshotDir");
    }
    const extension = path2.extname(filename).toLowerCase();
    const inferred = extension === ".jpg" || extension === ".jpeg" ? "jpeg" : extension === ".png" ? "png" : void 0;
    const format = options.format ?? inferred ?? "png";
    if (inferred && inferred !== format) throw new Error("browser_screenshot filename extension does not match format");
    if (!inferred) throw new Error("browser_screenshot filename must end in .png, .jpg, or .jpeg");
    return { file: path2.join(this.config.snapshotDir, filename), format };
  }
  async captureScreenshot(page, options = {}) {
    fs4.mkdirSync(this.config.snapshotDir, { recursive: true });
    if (options.target && options.clip) throw new Error("browser_screenshot cannot combine target and clip");
    if (options.target && options.fullPage) throw new Error("browser_screenshot cannot combine target and fullPage");
    if (options.quality !== void 0 && (!Number.isInteger(options.quality) || options.quality < 0 || options.quality > 100)) {
      throw new Error("browser_screenshot quality must be an integer from 0 to 100");
    }
    const { file, format } = this.screenshotFile(options);
    if (format === "png" && options.quality !== void 0) throw new Error("browser_screenshot quality is only supported for jpeg");
    const screenshotOptions = {
      path: file,
      type: format,
      ...options.quality !== void 0 ? { quality: options.quality } : {}
    };
    if (options.clip) {
      const { x, y, width, height } = options.clip;
      if (![x, y, width, height].every(Number.isFinite) || x < 0 || y < 0 || width <= 0 || height <= 0 || width > 2e4 || height > 2e4) {
        throw new Error("browser_screenshot clip must use finite non-negative coordinates and dimensions from 1 to 20,000");
      }
      screenshotOptions.clip = options.clip;
    } else if (!options.target) {
      screenshotOptions.fullPage = options.fullPage ?? true;
    }
    if (options.target) await this.resolveTarget(page, options.target).screenshot(screenshotOptions);
    else await page.screenshot(screenshotOptions);
    return file;
  }
  async readState(page, includeScreenshot) {
    const data = await evaluateExtractor(page, []);
    const state = {
      url: page.url(),
      title: String(data.title ?? ""),
      text: capText(String(data.text ?? "").replace(/\n{3,}/g, "\n\n").trim(), 1e5)
    };
    if (includeScreenshot) state.screenshotPath = await this.captureScreenshot(page);
    return state;
  }
  async open(url, opts = {}) {
    const page = await this.ensureActivePage(url, opts);
    this.resetCapture(opts.capture);
    page.setDefaultTimeout(3e4);
    await this.navigate(page, url, { waitUntil: "domcontentloaded", timeout: 3e4 });
    await page.waitForLoadState("networkidle", { timeout: 8e3 }).catch(() => {
    });
    await applyRuleSteps(page, this.activeRulePack);
    if (opts.waitMs) await page.waitForTimeout(opts.waitMs);
    return this.readState(page, true);
  }
  async click(target, opts = {}) {
    const page = await this.ensureActivePage();
    await this.resolveTarget(page, target).click({ timeout: boundedTimeout(opts.timeoutMs, "browser_click timeoutMs") });
    if (opts.waitMs !== void 0) await page.waitForTimeout(opts.waitMs);
    else await page.waitForTimeout(500);
    return this.readState(page, true);
  }
  async type(target, text, opts = {}) {
    const page = await this.ensureActivePage();
    await this.resolveTarget(page, target).fill(text, { timeout: boundedTimeout(opts.timeoutMs, "browser_type timeoutMs") });
    return this.readState(page, false);
  }
  async wait(target, opts = {}) {
    const page = await this.ensureActivePage();
    const modes = [target !== void 0, opts.urlPattern !== void 0, opts.networkIdle === true, opts.timeMs !== void 0].filter(Boolean);
    if (modes.length !== 1) throw new Error("browser_wait requires exactly one target, urlPattern, networkIdle=true, or timeMs");
    const timeout = boundedTimeout(opts.timeoutMs, "browser_wait timeoutMs");
    if (target !== void 0) await this.resolveTarget(page, target).waitFor({ state: opts.state ?? "visible", timeout });
    else if (opts.urlPattern !== void 0) await page.waitForURL(boundedString(opts.urlPattern, "urlPattern", 2e3), { timeout });
    else if (opts.networkIdle) await page.waitForLoadState("networkidle", { timeout });
    else {
      const timeMs = opts.timeMs;
      if (!Number.isFinite(timeMs) || timeMs < 0 || timeMs > 1e4) throw new Error("browser_wait timeMs must be between 0 and 10,000");
      await page.waitForTimeout(timeMs);
    }
    return this.readState(page, false);
  }
  async press(target, key, opts = {}) {
    const page = await this.ensureActivePage();
    const value = boundedString(key, "browser_press key", 100);
    if (target !== void 0) await this.resolveTarget(page, target).press(value, { timeout: boundedTimeout(opts.timeoutMs, "browser_press timeoutMs") });
    else await page.keyboard.press(value);
    return this.readState(page, false);
  }
  async select(target, values, opts = {}) {
    if (values.length < 1 || values.length > 20) throw new Error("browser_select requires 1 to 20 values");
    values.forEach((value) => boundedString(value, "browser_select value", 2e3));
    const page = await this.ensureActivePage();
    await this.resolveTarget(page, target).selectOption([...values], { timeout: boundedTimeout(opts.timeoutMs, "browser_select timeoutMs") });
    return this.readState(page, false);
  }
  async check(target, checked = true, opts = {}) {
    const page = await this.ensureActivePage();
    const locator = this.resolveTarget(page, target);
    if (checked) await locator.check({ timeout: boundedTimeout(opts.timeoutMs, "browser_check timeoutMs") });
    else await locator.uncheck({ timeout: boundedTimeout(opts.timeoutMs, "browser_check timeoutMs") });
    return this.readState(page, false);
  }
  async hover(target, opts = {}) {
    const page = await this.ensureActivePage();
    const timeoutMs = boundedTimeout(opts.timeoutMs, "browser_hover timeoutMs");
    const waitMs = Math.min(Math.max(opts.waitMs ?? 300, 0), timeoutMs);
    await this.resolveTarget(page, target).hover({ timeout: timeoutMs });
    await page.waitForTimeout(waitMs);
    return this.readState(page, true);
  }
  async setFiles(target, files, opts = {}) {
    if (files.length === 0 || files.length > 20) throw new Error("browser_set_files requires 1 to 20 files");
    const resolved = files.map((file) => {
      if (!path2.isAbsolute(file)) throw new Error("browser_set_files requires absolute file paths: " + file);
      const real = fs4.realpathSync(file);
      if (!fs4.statSync(real).isFile()) throw new Error("browser_set_files path is not a file: " + file);
      return real;
    });
    const totalBytes = resolved.reduce((total, file) => total + fs4.statSync(file).size, 0);
    if (totalBytes > 512 * 1024 * 1024) throw new Error("browser_set_files total upload size exceeds 512 MiB");
    const page = await this.ensureActivePage();
    await this.resolveTarget(page, target).setInputFiles(resolved, { timeout: boundedTimeout(opts.timeoutMs, "browser_set_files timeoutMs") });
    return { ...await this.readState(page, true), files: resolved.map((file) => path2.basename(file)) };
  }
  async evaluate(expression, opts = {}) {
    const source = expression.trim();
    if (!source) throw new Error("browser_evaluate requires a JavaScript expression");
    if (source.length > 2e4) throw new Error("browser_evaluate expression exceeds 20,000 characters");
    const page = await this.ensureActivePage();
    const timeoutMs = Math.min(Math.max(opts.timeoutMs ?? 15e3, 1e3), 3e4);
    let timer;
    let timedOut = false;
    const timeout = new Promise((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        void (async () => {
          try {
            const session = await page.context().newCDPSession(page);
            try {
              await session.send("Runtime.terminateExecution");
            } finally {
              await session.detach().catch(() => {
              });
            }
            reject(new Error("browser_evaluate timed out after " + timeoutMs + "ms; page JavaScript was terminated and the active page remains open"));
          } catch (error) {
            reject(new Error("browser_evaluate timed out after " + timeoutMs + "ms; unable to terminate page JavaScript without closing the active page: " + String(error).slice(0, 200)));
          }
        })();
      }, timeoutMs);
    });
    try {
      const script = `(async () => {
const value = await (${source}
);
const json = JSON.stringify(value);
if (json === undefined) throw new Error('expression result is not JSON-serializable');
return { resultJson: json.slice(0, 100000), truncated: json.length > 100000 };
})()`;
      let result;
      try {
        result = await Promise.race([page.evaluate(script), timeout]);
      } catch (error) {
        if (timedOut) throw new Error("browser_evaluate timed out after " + timeoutMs + "ms; page JavaScript was terminated and the active page remains open");
        throw error;
      }
      return {
        url: page.url(),
        resultJson: result.resultJson,
        truncated: result.truncated,
        capabilities: ["dom", "page-javascript", "page-network", "page-storage"],
        warnings: [
          "The expression runs with the current page origin and login state. It can mutate the page, access non-HttpOnly cookies and browser storage, and issue requests allowed by the browser.",
          "Use this capability according to the target site rules and applicable requirements. The caller/operator is responsible for that decision; dsh-browser only executes approved browser operations.",
          "The expression has no Node.js or direct host-filesystem access. Downloads are not persisted or returned by this tool."
        ]
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  async scroll(deltaY, opts = {}) {
    const page = await this.ensureActivePage();
    await page.mouse?.wheel(0, deltaY || 2e3).catch(() => {
    });
    await page.waitForTimeout(opts.waitMs ?? 500);
    return this.readState(page, false);
  }
  async read() {
    const page = await this.ensureActivePage();
    return this.readState(page, false);
  }
  consoleMessages(opts = {}) {
    const severities = ["debug", "log", "info", "warning", "error"];
    const threshold = opts.level ? severities.indexOf(opts.level) : 0;
    if (opts.level && threshold < 0) throw new Error("browser_console level must be debug, log, info, warning, or error");
    const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 100), 1), 200);
    const records = this.capturedConsole.filter((record) => {
      const index = severities.indexOf(record.type === "warn" ? "warning" : record.type);
      return index < 0 || index >= threshold;
    }).slice(-limit);
    if (opts.clear) this.capturedConsole = [];
    return { enabled: this.captureConsoleEnabled, records };
  }
  networkRequests(opts = {}) {
    const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 100), 1), 200);
    const records = this.capturedRequests.slice(-limit);
    if (opts.clear) this.capturedRequests = [];
    return { enabled: this.captureNetworkEnabled, records };
  }
  async screenshot(options = {}) {
    const page = await this.ensureActivePage();
    return { path: await this.captureScreenshot(page, options) };
  }
  async recipe(steps, opts = {}) {
    if (!opts.url && (!this.activePage || this.activePage.isClosed())) throw new Error("browser recipe requires url or an active browser_open page");
    const page = await this.ensureActivePage(opts.url, opts);
    if (opts.url) {
      page.setDefaultTimeout(3e4);
      await this.navigate(page, opts.url, { waitUntil: "domcontentloaded", timeout: 3e4 }, opts.signal);
      await page.waitForLoadState("networkidle", { timeout: 8e3 }).catch(() => {
      });
      await applyRuleSteps(page, this.activeRulePack);
      if (opts.waitMs) await page.waitForTimeout(opts.waitMs);
    }
    const onAbort = () => void this.closePage();
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener("abort", onAbort);
    try {
      const results = await runRecipe(page, steps, () => this.captureScreenshot(page), opts.signal);
      return { ...await this.readState(page, false), steps: results };
    } finally {
      opts.signal?.removeEventListener("abort", onAbort);
    }
  }
  async closePage() {
    const page = this.activePage;
    const context = this.activeContext;
    const profile = this.activeProfile;
    this.clearActiveState();
    if (page) await page.close().catch(() => {
    });
    if (context) await this.persistAndClose({ context, ...profile ? { profile } : {} });
  }
  async status() {
    let chromiumInstalled = false;
    let chromiumExecutablePath;
    try {
      const pw = loadBrowserRuntime(this.config.browserRuntime);
      const expectedPath = this.config.executablePath || pw.chromium.executablePath();
      if (typeof expectedPath === "string" && expectedPath.trim()) {
        chromiumExecutablePath = path2.resolve(expectedPath);
        chromiumInstalled = fs4.existsSync(chromiumExecutablePath);
      }
    } catch {
      chromiumInstalled = false;
    }
    let opencliInstalled = false;
    let resolvedOpencliEntryPath;
    try {
      resolvedOpencliEntryPath = path2.resolve(opencliEntryPath());
      opencliInstalled = fs4.existsSync(resolvedOpencliEntryPath);
    } catch {
      opencliInstalled = false;
    }
    const runtimeWarnings = this.config.browserRuntime === "patchright" ? [
      "Patchright is Chromium-only and disables Playwright console APIs to avoid Runtime.enable detection.",
      ...this.config.channel !== "chrome" || this.config.headless ? ["Patchright stealth is strongest with channel=chrome and headless=false; current settings favor automation/test compatibility."] : []
    ] : [];
    if (!chromiumInstalled && chromiumExecutablePath && (this.config.channel === "chromium" || !!this.config.executablePath)) {
      runtimeWarnings.push(`Expected Chromium executable is missing: ${chromiumExecutablePath}. Run browser_install for ${this.config.browserRuntime}.`);
    }
    if (this.config.opencliEnabled && !opencliInstalled) runtimeWarnings.push("OpenCLI is enabled but its package entry is not installed.");
    const cdpConnected = !!this.config.cdpEndpoint && this.browserConnected();
    if (this.config.cdpEndpoint) {
      runtimeWarnings.push(`CDP endpoint configured: ${this.config.cdpEndpoint}`);
      if (!cdpConnected) {
        runtimeWarnings.push("CDP connection not established yet.");
      }
    }
    return {
      cdpEndpoint: this.config.cdpEndpoint,
      cdpConnected,
      enabled: this.config.enabled,
      channel: this.config.channel,
      browserRuntime: this.config.browserRuntime,
      runtimeWarnings,
      headless: this.config.headless,
      opencliEnabled: this.config.opencliEnabled,
      opencliInstalled,
      ...resolvedOpencliEntryPath ? { opencliEntryPath: resolvedOpencliEntryPath } : {},
      automationMode: this.config.automationMode,
      exposedTools: configuredBrowserTools(this.config.automationMode, this.config.automationAssets, this.config.enabled),
      directInteractionPolicy: !this.config.enabled || this.config.automationMode === "read-only" ? "deny" : this.config.automationMode === "standard" ? "ask" : "allow",
      mutatingRecipePolicy: !this.config.enabled || this.config.automationMode === "read-only" ? "deny" : this.config.automationMode === "standard" ? "ask" : "allow",
      externalUserscriptPolicy: !this.config.enabled || this.config.automationMode === "read-only" ? "deny" : this.config.automationMode === "unrestricted" ? "allow" : "ask",
      pageEvaluatePolicy: !this.config.enabled || this.config.automationMode === "read-only" ? "deny" : this.config.automationMode === "unrestricted" ? "allow" : "ask",
      fileUploadPolicy: !this.config.enabled || this.config.automationMode === "read-only" ? "deny" : this.config.automationMode === "unrestricted" ? "allow" : "ask",
      opencliRunPolicy: !this.config.enabled || this.config.automationMode === "read-only" ? "deny" : this.config.automationMode === "unrestricted" ? "allow" : "ask",
      chromiumInstalled,
      ...chromiumExecutablePath ? { chromiumExecutablePath } : {},
      usagePolicy: this.config.usagePolicy,
      usageGovernor: this.usageGovernor.snapshot(),
      authProfiles: this.authProfiles.list(),
      rulePacks: Object.keys(this.config.rulePacks).sort(),
      builtinScripts: BUILTIN_SCRIPTS.map((script) => script.id),
      externalUserscriptsRequireApproval: ["standard", "autonomous"].includes(this.config.automationMode),
      mutatingRecipesRequireApproval: this.config.automationMode === "standard",
      ...this.browserConnected() && this.activePage && !this.activePage.isClosed() ? { activeUrl: this.activePage.url() } : {},
      ...this.browserConnected() && this.activePage && !this.activePage.isClosed() && this.activeProfile ? { activeAuthProfile: this.activeProfile.id } : {}
    };
  }
  async close() {
    await this.closePage();
    const b = this.browser;
    this.browser = void 0;
    this.launching = void 0;
    if (b) {
      try {
        await b.close();
      } catch {
      }
    }
  }
};
export {
  BrowserService
};
