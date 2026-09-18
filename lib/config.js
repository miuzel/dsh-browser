// src/config.ts
import path2 from "node:path";
import os2 from "node:os";
import z from "@deepseek-ai/schemastery";

// src/freedom.ts
var AUTOMATION_MODES = ["read-only", "standard", "autonomous", "unrestricted"];
function resolveAutomationMode(value) {
  const mode = value ?? "standard";
  if (typeof mode !== "string" || !AUTOMATION_MODES.includes(mode)) {
    throw new Error("automationMode must be one of: " + AUTOMATION_MODES.join(", "));
  }
  return mode;
}

// src/usage-policy.ts
var DEFAULT_POLICY = {
  minDelayMs: 750,
  maxConcurrency: 2,
  burst: 3,
  maxPagesPerRun: 20,
  maxDepth: 2,
  retryLimit: 2,
  backoffBaseMs: 1e3,
  cooldownMs: 3e4
};
function boundedInteger(name, value, fallback, min, max) {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || Number(resolved) < min || Number(resolved) > max) {
    throw new Error(`usagePolicy.${name} must be an integer from ${min} to ${max}`);
  }
  return Number(resolved);
}
function resolveUsagePolicy(input) {
  return {
    minDelayMs: boundedInteger("minDelayMs", input?.minDelayMs, DEFAULT_POLICY.minDelayMs, 0, 6e4),
    maxConcurrency: boundedInteger("maxConcurrency", input?.maxConcurrency, DEFAULT_POLICY.maxConcurrency, 1, 8),
    burst: boundedInteger("burst", input?.burst, DEFAULT_POLICY.burst, 1, 20),
    maxPagesPerRun: boundedInteger("maxPagesPerRun", input?.maxPagesPerRun, DEFAULT_POLICY.maxPagesPerRun, 1, 100),
    maxDepth: boundedInteger("maxDepth", input?.maxDepth, DEFAULT_POLICY.maxDepth, 0, 5),
    retryLimit: boundedInteger("retryLimit", input?.retryLimit, DEFAULT_POLICY.retryLimit, 0, 5),
    backoffBaseMs: boundedInteger("backoffBaseMs", input?.backoffBaseMs, DEFAULT_POLICY.backoffBaseMs, 1, 6e4),
    cooldownMs: boundedInteger("cooldownMs", input?.cooldownMs, DEFAULT_POLICY.cooldownMs, 100, 3e5)
  };
}

// src/automation-assets.ts
import os from "node:os";
import path from "node:path";

// src/scripts.ts
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

// src/automation-assets.ts
var ASSET_PERSISTENCE_MODES = ["off", "manual", "suggest", "auto-draft"];
var ASSET_ACTIVATION_MODES = ["manual", "auto-tested"];
function boundedInteger2(value, fallback, min, max) {
  return typeof value === "number" && Number.isInteger(value) ? Math.min(Math.max(value, min), max) : fallback;
}
function boundedNumber(value, fallback, min, max) {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(Math.max(value, min), max) : fallback;
}
function defaultAutomationAssetDirectory() {
  const home = process.env.DSH_HOME ?? path.join(os.homedir(), ".dsh");
  return path.join(home, "data", "browser", "automations");
}
function resolveAutomationAssetPolicy(input = {}) {
  const persistenceMode = input.persistenceMode ?? "suggest";
  const activationMode = input.activationMode ?? "manual";
  if (!ASSET_PERSISTENCE_MODES.includes(persistenceMode)) throw new Error("automationAssets.persistenceMode is invalid");
  if (!ASSET_ACTIVATION_MODES.includes(activationMode)) throw new Error("automationAssets.activationMode is invalid");
  return {
    enabled: input.enabled ?? true,
    directory: input.directory?.trim() || defaultAutomationAssetDirectory(),
    persistenceMode,
    activationMode,
    minSuccessfulRuns: boundedInteger2(input.minSuccessfulRuns, 3, 2, 20),
    minDistinctSessions: boundedInteger2(input.minDistinctSessions, 2, 1, 10),
    successWindowDays: boundedInteger2(input.successWindowDays, 14, 1, 90),
    minSuccessRate: boundedNumber(input.minSuccessRate, 0.8, 0.5, 1),
    maxCandidates: boundedInteger2(input.maxCandidates, 20, 1, 100),
    candidateTtlDays: boundedInteger2(input.candidateTtlDays, 14, 1, 90),
    maxSuggestionsPerDay: boundedInteger2(input.maxSuggestionsPerDay, 2, 0, 20),
    maxDrafts: boundedInteger2(input.maxDrafts, 10, 1, 100),
    maxActiveAssets: boundedInteger2(input.maxActiveAssets, 50, 1, 200),
    retrievalTopK: boundedInteger2(input.retrievalTopK, 5, 1, 20),
    catalogTokenBudget: boundedInteger2(input.catalogTokenBudget, 800, 100, 4e3),
    modelDevelopmentEnabled: input.modelDevelopmentEnabled ?? true,
    maxModelDraftWritesPerSession: boundedInteger2(input.maxModelDraftWritesPerSession, 3, 1, 20)
  };
}

// src/config.ts
var BROWSER_RUNTIMES = ["playwright", "patchright"];
function resolveBrowserRuntime(value) {
  const runtime = value ?? "playwright";
  if (typeof runtime !== "string" || !BROWSER_RUNTIMES.includes(runtime)) {
    throw new Error("browserRuntime must be one of: " + BROWSER_RUNTIMES.join(", "));
  }
  return runtime;
}
var Config = z.object({
  enabled: z.boolean().default(true),
  channel: z.string().default("chromium"),
  browserRuntime: z.string().default("playwright"),
  headless: z.boolean().default(true),
  storageStatePath: z.string(),
  authProfiles: z.dict(z.object({
    storageStatePath: z.string(),
    allowedDomains: z.array(z.string()).default([]),
    persistState: z.boolean().default(false)
  })),
  defaultAuthProfile: z.string(),
  rulePacks: z.dict(z.object({
    matches: z.array(z.string()).default([]),
    initScriptPath: z.string(),
    initScriptSha256: z.string(),
    steps: z.array(z.object({
      type: z.string(),
      selector: z.string(),
      timeoutMs: z.number(),
      optional: z.boolean(),
      deltaY: z.number(),
      repeat: z.number(),
      waitMs: z.number()
    })).default([])
  })),
  executablePath: z.string(),
  cdpEndpoint: z.string(),
  opencliEnabled: z.boolean().default(true),
  automationMode: z.string().default("standard"),
  usagePolicy: z.object({
    minDelayMs: z.number().default(750),
    maxConcurrency: z.number().default(2),
    burst: z.number().default(3),
    maxPagesPerRun: z.number().default(20),
    maxDepth: z.number().default(2),
    retryLimit: z.number().default(2),
    backoffBaseMs: z.number().default(1e3),
    cooldownMs: z.number().default(3e4)
  }),
  automationAssets: z.object({
    enabled: z.boolean().default(true),
    directory: z.string(),
    persistenceMode: z.string().default("suggest"),
    activationMode: z.string().default("manual"),
    minSuccessfulRuns: z.number().default(3),
    minDistinctSessions: z.number().default(2),
    successWindowDays: z.number().default(14),
    minSuccessRate: z.number().default(0.8),
    maxCandidates: z.number().default(20),
    candidateTtlDays: z.number().default(14),
    maxSuggestionsPerDay: z.number().default(2),
    maxDrafts: z.number().default(10),
    maxActiveAssets: z.number().default(50),
    retrievalTopK: z.number().default(5),
    catalogTokenBudget: z.number().default(800),
    modelDevelopmentEnabled: z.boolean().default(true),
    maxModelDraftWritesPerSession: z.number().default(3)
  }),
  autoInstall: z.boolean().default(false),
  snapshotDir: z.string(),
  verbose: z.boolean().default(false)
});
function defaultSnapshotDir() {
  const home = process.env.DSH_HOME ?? path2.join(os2.homedir(), ".dsh");
  return path2.join(home, "data", "browser", "snapshots");
}
function resolveConfig(config) {
  const snapshotDir = config.snapshotDir ?? defaultSnapshotDir();
  return {
    enabled: config.enabled ?? true,
    channel: config.channel ?? "chromium",
    browserRuntime: resolveBrowserRuntime(config.browserRuntime),
    headless: config.headless ?? true,
    opencliEnabled: config.opencliEnabled ?? true,
    automationMode: resolveAutomationMode(config.automationMode),
    usagePolicy: resolveUsagePolicy(config.usagePolicy),
    automationAssets: resolveAutomationAssetPolicy(config.automationAssets),
    autoInstall: config.autoInstall ?? false,
    snapshotDir,
    verbose: config.verbose ?? false,
    authProfiles: config.authProfiles ?? {},
    rulePacks: config.rulePacks ?? {},
    ...config.defaultAuthProfile ? { defaultAuthProfile: config.defaultAuthProfile } : {},
    ...config.storageStatePath !== void 0 && config.storageStatePath !== "" ? { storageStatePath: config.storageStatePath } : {},
    ...config.executablePath !== void 0 && config.executablePath !== "" ? { executablePath: config.executablePath } : {},
    ...config.cdpEndpoint !== void 0 && config.cdpEndpoint !== "" ? { cdpEndpoint: config.cdpEndpoint } : {}
  };
}
export {
  BROWSER_RUNTIMES,
  Config,
  defaultSnapshotDir,
  resolveBrowserRuntime,
  resolveConfig
};
