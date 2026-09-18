// src/index.ts
import fs6 from "node:fs";
import path5 from "node:path";

// src/config.ts
import path2 from "node:path";
import os2 from "node:os";
import z from "@deepseek-ai/schemastery";

// src/freedom.ts
var AUTOMATION_MODES = ["read-only", "standard", "autonomous", "unrestricted"];
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
function resolveAutomationMode(value) {
  const mode = value ?? "standard";
  if (typeof mode !== "string" || !AUTOMATION_MODES.includes(mode)) {
    throw new Error("automationMode must be one of: " + AUTOMATION_MODES.join(", "));
  }
  return mode;
}
function isBrowserToolExposed(name2, mode) {
  if (!ALL_BROWSER_TOOL_NAMES.includes(name2)) return false;
  return mode !== "read-only" || READ_ONLY_TOOL_NAMES.has(name2);
}
function browserToolsForMode(mode) {
  return ALL_BROWSER_TOOL_NAMES.filter((name2) => isBrowserToolExposed(name2, mode));
}
function configuredBrowserTools(mode, options, enabled = true) {
  if (!enabled) return [];
  return browserToolsForMode(mode).filter((name2) => name2 !== "browser_automation_develop" || options.modelDevelopmentEnabled);
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
function boundedInteger(name2, value, fallback, min, max) {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || Number(resolved) < min || Number(resolved) > max) {
    throw new Error(`usagePolicy.${name2} must be an integer from ${min} to ${max}`);
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

// src/automation-assets.ts
import crypto2 from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// src/scripts.ts
import crypto from "node:crypto";
var header = (name2, description) => `// ==UserScript==
// @name ${name2}
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
  const sha256 = crypto.createHash("sha256").update(source, "utf8").digest("hex");
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

// src/automation-assets.ts
var ASSET_PERSISTENCE_MODES = ["off", "manual", "suggest", "auto-draft"];
var ASSET_ACTIVATION_MODES = ["manual", "auto-tested"];
var DEFAULT_STATE = { version: 1, candidates: [], assets: [] };
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
function nowIso(now = Date.now()) {
  return new Date(now).toISOString();
}
function uid() {
  return crypto2.randomUUID();
}
function hash(value) {
  return crypto2.createHash("sha256").update(value).digest("hex");
}
function safeDomain(url) {
  const parsed = new URL(url);
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("automation assets only support HTTP(S) URLs");
  return parsed.hostname.toLowerCase();
}
function cap(value, max) {
  return value.trim().slice(0, max);
}
var SECRET_SELECTOR = /pass(word)?|token|secret|otp|one[-_ ]?time|credit|card|cvv|authorization/i;
function sanitizeSelector(selector2) {
  return selector2.replace(/\[\s*([-\w:]+)\s*[*^$|~]?=\s*(?:"[^"]*"|'[^']*'|[^\]]+)\]/g, "[$1]").slice(0, 500);
}
function inputPlaceholder(selector2, secret) {
  if (secret) return "secret";
  const hint = selector2.match(/\[\s*name\s*=\s*["']?([^\]"']+)/i)?.[1] ?? selector2.match(/#([\w-]+)/)?.[1] ?? selector2.match(/\[\s*aria-label\s*=\s*["']?([^\]"']+)/i)?.[1];
  const suffix = hint?.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 24);
  return suffix ? `input_${suffix}` : "input";
}
function recipeInputNames(steps) {
  return [...new Set(JSON.stringify(steps).match(/\{\{([a-zA-Z][\w-]*)\}\}/g)?.map((value) => value.slice(2, -2)) ?? [])];
}
function normalizeRecipeForCandidate(steps) {
  if (!Array.isArray(steps) || steps.length < 1 || steps.length > 25) throw new Error("candidate recipe requires 1 to 25 steps");
  const normalized = steps.map((step) => {
    const clean = structuredClone(step);
    delete clean.text;
    if ("value" in clean) {
      const selector2 = "selector" in clean ? String(clean.selector ?? "") : "";
      const secret = SECRET_SELECTOR.test(selector2);
      clean.value = `{{${inputPlaceholder(selector2, secret)}}}`;
    }
    if ("selector" in clean && typeof clean.selector === "string") clean.selector = sanitizeSelector(clean.selector);
    if ("timeoutMs" in clean && typeof clean.timeoutMs === "number") clean.timeoutMs = Math.min(Math.max(Math.round(clean.timeoutMs), 100), 6e4);
    if ("waitMs" in clean && typeof clean.waitMs === "number") clean.waitMs = Math.min(Math.max(Math.round(clean.waitMs), 0), 1e4);
    return clean;
  });
  if (recipeInputNames(normalized).length > 20) throw new Error("candidate recipe exceeds 20 reusable inputs");
  return normalized;
}
function candidateFingerprint(domain, steps) {
  return hash(JSON.stringify({ domain, steps }));
}
function summary(asset) {
  const { id, kind, status, name: name2, description, domains, tags, inputNames, revision, testStatus, successCount, failureCount, updatedAt, lastRunAt } = asset;
  return { id, kind, status, name: name2, description, domains: [...domains], tags: [...tags], inputNames: [...inputNames], revision, testStatus, successCount, failureCount, updatedAt, ...lastRunAt ? { lastRunAt } : {} };
}
function persistedState(value) {
  if (!value || typeof value !== "object") throw new Error("state root must be an object");
  const state = value;
  if (state.version !== 1 || !Array.isArray(state.candidates) || !Array.isArray(state.assets)) throw new Error("unsupported or malformed state");
  if (state.candidates.length > 200 || state.assets.length > 300) throw new Error("state exceeds hard item limits");
  const malformedCandidate = state.candidates.some((candidate) => !candidate || typeof candidate !== "object" || typeof candidate.id !== "string" || typeof candidate.fingerprint !== "string" || typeof candidate.domain !== "string" || !Array.isArray(candidate.steps) || candidate.steps.length < 1 || candidate.steps.length > 25 || !Array.isArray(candidate.sessionIds) || candidate.sessionIds.length > 30 || typeof candidate.successfulRuns !== "number" || typeof candidate.failedRuns !== "number" || !Number.isFinite(Date.parse(candidate.firstSeenAt)) || !Number.isFinite(Date.parse(candidate.lastSeenAt)));
  const malformedAsset = state.assets.some((asset) => !asset || typeof asset !== "object" || typeof asset.id !== "string" || !["recipe", "userscript"].includes(asset.kind) || !["draft", "active", "archived"].includes(asset.status) || typeof asset.name !== "string" || asset.name.length > 120 || !Array.isArray(asset.domains) || asset.domains.length > 20 || !Array.isArray(asset.tags) || asset.tags.length > 20 || !Array.isArray(asset.inputNames) || asset.inputNames.length > 20 || asset.kind === "recipe" && (!Array.isArray(asset.recipe) || asset.recipe.length < 1 || asset.recipe.length > 25) || asset.kind === "userscript" && (typeof asset.source !== "string" || Buffer.byteLength(asset.source, "utf8") > 64 * 1024) || !Number.isInteger(asset.revision) || !Number.isFinite(Date.parse(asset.createdAt)) || !Number.isFinite(Date.parse(asset.updatedAt)));
  if (malformedCandidate || malformedAsset) throw new Error("persisted asset entries are malformed");
  return { version: 1, candidates: state.candidates, assets: state.assets };
}
var AutomationAssetStore = class {
  constructor(policy) {
    this.policy = policy;
    this.statePath = path.join(policy.directory, "assets.json");
    this.state = this.read();
    this.prune();
  }
  policy;
  statePath;
  state;
  snapshot() {
    const { directory: _directory, ...publicPolicy } = this.policy;
    return {
      policy: publicPolicy,
      candidates: this.state.candidates.map(({ id, domain, title, successfulRuns, failedRuns, sessionIds, firstSeenAt, lastSeenAt, suggestedAt, dismissedAt }) => ({
        id,
        domain,
        title,
        successfulRuns,
        failedRuns,
        distinctSessions: sessionIds.length,
        firstSeenAt,
        lastSeenAt,
        ...suggestedAt ? { suggestedAt } : {},
        ...dismissedAt ? { dismissedAt } : {}
      })),
      assets: this.state.assets.map(summary)
    };
  }
  get(id) {
    const asset = this.state.assets.find((item) => item.id === id);
    return asset ? structuredClone(asset) : void 0;
  }
  recordRecipe(url, steps, sessionId2, ok, now = Date.now()) {
    if (!this.policy.enabled || !["suggest", "auto-draft"].includes(this.policy.persistenceMode)) return void 0;
    const domain = safeDomain(url);
    const normalized = normalizeRecipeForCandidate(steps);
    const fingerprint = candidateFingerprint(domain, normalized);
    const timestamp = nowIso(now);
    let candidate = this.state.candidates.find((item) => item.fingerprint === fingerprint);
    if (!candidate) {
      candidate = { id: uid(), fingerprint, domain, title: `Reusable automation for ${domain}`, steps: normalized, successfulRuns: 0, failedRuns: 0, sessionIds: [], firstSeenAt: timestamp, lastSeenAt: timestamp };
      this.state.candidates.push(candidate);
    }
    const windowStart = now - this.policy.successWindowDays * 864e5;
    if (Date.parse(candidate.firstSeenAt) < windowStart) {
      candidate.successfulRuns = 0;
      candidate.failedRuns = 0;
      candidate.sessionIds = [];
      candidate.firstSeenAt = timestamp;
      candidate.suggestedAt = void 0;
    }
    if (ok) candidate.successfulRuns += 1;
    else candidate.failedRuns += 1;
    candidate.lastSeenAt = timestamp;
    const sessionKey = sessionId2 ? hash(sessionId2).slice(0, 16) : "";
    if (sessionKey && !candidate.sessionIds.includes(sessionKey)) candidate.sessionIds.push(sessionKey);
    candidate.sessionIds = candidate.sessionIds.slice(-this.policy.minDistinctSessions * 3);
    const total = candidate.successfulRuns + candidate.failedRuns;
    const eligible = candidate.successfulRuns >= this.policy.minSuccessfulRuns && candidate.sessionIds.length >= this.policy.minDistinctSessions && candidate.successfulRuns / total >= this.policy.minSuccessRate;
    const day = timestamp.slice(0, 10);
    const suggestionsToday = this.state.candidates.filter((item) => item.suggestedAt?.startsWith(day)).length;
    if (eligible && !candidate.suggestedAt && !candidate.dismissedAt && suggestionsToday < this.policy.maxSuggestionsPerDay) candidate.suggestedAt = timestamp;
    this.prune(now);
    this.write();
    if (this.policy.persistenceMode === "auto-draft" && candidate.suggestedAt && !this.state.assets.some((item) => item.tags.includes(`candidate:${candidate.id}`))) {
      this.summarizeCandidate(candidate.id);
    }
    return structuredClone(candidate);
  }
  summarizeCandidate(id) {
    const candidate = this.state.candidates.find((item) => item.id === id);
    if (!candidate) throw new Error("automation candidate not found");
    if (this.state.assets.filter((item) => item.status === "draft").length >= this.policy.maxDrafts) throw new Error("automation draft limit reached");
    const timestamp = nowIso();
    const asset = {
      id: uid(),
      kind: "recipe",
      status: "draft",
      name: candidate.title,
      description: `Captured from ${candidate.successfulRuns} successful runs across ${candidate.sessionIds.length} sessions.`,
      domains: [candidate.domain],
      tags: [`candidate:${candidate.id}`],
      inputNames: recipeInputNames(candidate.steps),
      recipe: structuredClone(candidate.steps),
      revision: 1,
      testStatus: "untested",
      successCount: 0,
      failureCount: 0,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    this.state.assets.push(asset);
    candidate.dismissedAt = timestamp;
    this.write();
    return structuredClone(asset);
  }
  dismissCandidate(id) {
    const candidate = this.state.candidates.find((item) => item.id === id);
    if (!candidate) throw new Error("automation candidate not found");
    candidate.dismissedAt = nowIso();
    this.write();
  }
  saveDraft(input) {
    if (!this.policy.enabled || this.policy.persistenceMode === "off") throw new Error("automation asset persistence is disabled");
    const existing = input.id ? this.state.assets.find((item) => item.id === input.id) : void 0;
    if (existing?.status === "active") throw new Error("active assets must be copied to a draft before editing");
    if (!existing && this.state.assets.filter((item) => item.status === "draft").length >= this.policy.maxDrafts) throw new Error("automation draft limit reached");
    const timestamp = nowIso();
    const name2 = cap(input.name, 120);
    if (!name2) throw new Error("automation asset name is required");
    const kind = input.kind;
    const domains = [...new Set((input.domains ?? []).map((value) => cap(String(value).toLowerCase(), 255)).filter(Boolean))].slice(0, 20);
    const tags = [...new Set((input.tags ?? []).map((value) => cap(String(value), 40)).filter(Boolean))].slice(0, 20);
    const declaredInputNames = [...new Set((input.inputNames ?? []).map((value) => cap(String(value), 40)).filter((value) => /^[a-zA-Z][\w-]*$/.test(value)))].slice(0, 20);
    if (kind === "recipe" && (!Array.isArray(input.recipe) || input.recipe.length < 1 || input.recipe.length > 25)) throw new Error("recipe asset requires 1 to 25 steps");
    if (kind === "userscript") {
      const validation = validateUserscript(String(input.source ?? ""));
      if (!validation.valid) throw new Error("userscript is invalid: " + validation.errors.join("; "));
    }
    const inputNames = kind === "recipe" ? recipeInputNames(input.recipe) : declaredInputNames;
    const asset = {
      id: existing?.id ?? uid(),
      kind,
      status: "draft",
      name: name2,
      description: cap(String(input.description ?? ""), 500),
      domains,
      tags,
      inputNames,
      ...kind === "recipe" ? { recipe: structuredClone(input.recipe) } : { source: String(input.source) },
      revision: (existing?.revision ?? 0) + 1,
      testStatus: "untested",
      successCount: existing?.successCount ?? 0,
      failureCount: existing?.failureCount ?? 0,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
      ...existing?.lastRunAt ? { lastRunAt: existing.lastRunAt } : {}
    };
    if (existing) this.state.assets[this.state.assets.indexOf(existing)] = asset;
    else this.state.assets.push(asset);
    this.write();
    return structuredClone(asset);
  }
  validate(id) {
    const asset = this.requireAsset(id);
    let message = "Recipe structure is valid; runtime replay is still required.";
    if (asset.kind === "recipe") normalizeRecipeForCandidate(asset.recipe ?? []);
    else {
      const validation = validateUserscript(asset.source ?? "");
      if (!validation.valid) throw new Error(validation.errors.join("; "));
      message = `Userscript validated (${validation.sha256.slice(0, 12)}); runtime replay is still required.`;
    }
    return { ...structuredClone(asset), testMessage: message };
  }
  setStatus(id, status) {
    const asset = this.requireAsset(id);
    if (!["draft", "active", "archived"].includes(status)) throw new Error("invalid automation asset status");
    if (status === "active") {
      if (asset.testStatus !== "passed") throw new Error("automation asset must pass testing before activation");
      if (asset.domains.length < 1) throw new Error("automation asset must declare at least one domain before activation");
      if (this.state.assets.filter((item) => item.status === "active" && item.id !== id).length >= this.policy.maxActiveAssets) throw new Error("active automation asset limit reached");
    }
    asset.status = status;
    asset.updatedAt = nowIso();
    this.write();
    return structuredClone(asset);
  }
  search(query, domain, status = "active", kind) {
    if (!query.trim()) throw new Error("automation search requires explicit keywords");
    if (!["draft", "active", "archived", "all"].includes(status)) throw new Error("invalid automation search status");
    const terms = `${query} ${domain ?? ""}`.slice(0, 2e3).toLowerCase().split(/[^\p{L}\p{N}_.-]+/u).filter(Boolean).slice(0, 20);
    const normalizedDomain = domain?.toLowerCase();
    const scored = this.state.assets.filter((item) => (status === "all" || item.status === status) && (!kind || item.kind === kind)).map((asset) => {
      const haystack = [asset.name, asset.description, ...asset.domains, ...asset.tags, ...asset.inputNames].join(" ").toLowerCase();
      let score = terms.reduce((sum, term) => sum + (haystack.includes(term) ? 4 : 0), 0);
      score += terms.reduce((sum, term) => sum + (asset.tags.some((tag) => tag.toLowerCase() === term) ? 6 : 0), 0);
      if (normalizedDomain && asset.domains.some((value) => normalizedDomain === value || normalizedDomain.endsWith("." + value))) score += 12;
      score += Math.min(asset.successCount, 10) - Math.min(asset.failureCount, 5);
      return { asset, score };
    }).filter((item) => item.score > 0 || terms.length === 0).sort((a, b) => b.score - a.score || b.asset.updatedAt.localeCompare(a.asset.updatedAt));
    const results = [];
    let chars = 0;
    const charBudget = this.policy.catalogTokenBudget * 4;
    for (const item of scored) {
      const value = summary(item.asset);
      const size = JSON.stringify(value).length;
      if (results.length >= this.policy.retrievalTopK || results.length > 0 && chars + size > charBudget) break;
      results.push(value);
      chars += size;
    }
    return results;
  }
  noteRun(id, ok) {
    const asset = this.requireAsset(id);
    if (ok) asset.successCount += 1;
    else asset.failureCount += 1;
    asset.lastRunAt = nowIso();
    asset.updatedAt = asset.lastRunAt;
    this.write();
  }
  noteTestResult(id, ok, url) {
    const asset = this.requireAsset(id);
    if (asset.status !== "draft") throw new Error("only draft automation assets can record test results");
    const domain = safeDomain(url);
    asset.testStatus = ok ? "passed" : "failed";
    asset.testMessage = ok ? `Runtime replay passed on ${domain}.` : `Runtime replay failed on ${domain}.`;
    asset.updatedAt = nowIso();
    this.write();
  }
  assertTarget(asset, url) {
    const domain = safeDomain(url);
    if (!asset.domains.some((allowed) => domain === allowed || domain.endsWith("." + allowed))) throw new Error(`automation asset ${asset.id} is not allowed on ${domain}`);
  }
  requireAsset(id) {
    const asset = this.state.assets.find((item) => item.id === id);
    if (!asset) throw new Error("automation asset not found");
    return asset;
  }
  prune(now = Date.now()) {
    const cutoff = now - this.policy.candidateTtlDays * 864e5;
    this.state.candidates = this.state.candidates.filter((item) => Date.parse(item.lastSeenAt) >= cutoff).sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt)).slice(0, this.policy.maxCandidates);
  }
  read() {
    if (!fs.existsSync(this.statePath)) return structuredClone(DEFAULT_STATE);
    try {
      return persistedState(JSON.parse(fs.readFileSync(this.statePath, "utf8")));
    } catch (error) {
      throw new Error(`automation asset store is unreadable; refusing to overwrite ${this.statePath}: ${String(error)}`);
    }
  }
  write() {
    fs.mkdirSync(this.policy.directory, { recursive: true });
    const temporary = this.statePath + ".tmp-" + uid().slice(0, 8);
    fs.writeFileSync(temporary, JSON.stringify(this.state, null, 2), { encoding: "utf8", mode: 384 });
    fs.renameSync(temporary, this.statePath);
  }
};

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

// src/browser-service.ts
import fs5 from "node:fs";
import path4 from "node:path";
import crypto4 from "node:crypto";

// src/deps.ts
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawn, execFileSync } from "node:child_process";
import path3 from "node:path";
import fs2 from "node:fs";
var PLUGIN_ROOT = fileURLToPath(new URL("..", import.meta.url));
var cachedGlobalRoot;
function globalNpmRoot() {
  if (cachedGlobalRoot) return cachedGlobalRoot;
  try {
    cachedGlobalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8", windowsHide: true, timeout: 15e3 }).trim();
  } catch {
    cachedGlobalRoot = path3.join(process.env.APPDATA ?? "", "npm", "node_modules");
  }
  return cachedGlobalRoot;
}
function findPackageRoot(fromFile) {
  let dir = path3.dirname(fromFile);
  for (let i = 0; i < 20; i++) {
    const pj = path3.join(dir, "package.json");
    if (fs2.existsSync(pj)) return pj;
    const parent = path3.dirname(dir);
    if (parent === dir) return void 0;
    dir = parent;
  }
  return void 0;
}
function pnpmStorePackageJson(name2) {
  let dir = PLUGIN_ROOT;
  for (let i = 0; i < 12; i++) {
    const candidate = path3.join(dir, "node_modules", ".pnpm", "node_modules", name2, "package.json");
    if (fs2.existsSync(candidate)) return candidate;
    const parent = path3.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return void 0;
}
function resolvePkgJson(name2) {
  const storePkg = pnpmStorePackageJson(name2);
  if (storePkg) return storePkg;
  const anchors = [
    path3.join(PLUGIN_ROOT, "package.json"),
    path3.join(globalNpmRoot(), name2, "package.json")
  ];
  for (const anchor of anchors) {
    const req = createRequire(anchor);
    try {
      return req.resolve(name2 + "/package.json");
    } catch {
    }
    try {
      const entry = req.resolve(name2);
      const root = findPackageRoot(entry);
      if (root) return root;
    } catch {
    }
  }
  throw new Error("dsh-browser: " + name2 + " not found in pnpm store, plugin node_modules, or global npm. Run `npm install` in " + PLUGIN_ROOT + " (or install " + name2 + " globally).");
}
function pkgDir(name2) {
  return path3.dirname(resolvePkgJson(name2));
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
  return path3.join(pkgDir(browserRuntimePackage(runtime)), "cli.js");
}
function opencliEntryPath() {
  const dir = pkgDir("@jackwener/opencli");
  const pkg = JSON.parse(fs2.readFileSync(path3.join(dir, "package.json"), "utf8"));
  const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.opencli ?? pkg.main ?? "dist/src/main.js";
  return path3.join(dir, bin);
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
import fs3 from "node:fs";
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
    if (!fs3.existsSync(profile.storageStatePath)) {
      if (!persistState) throw new Error("auth profile " + id + " storageState file does not exist: " + profile.storageStatePath);
    } else if (!fs3.statSync(profile.storageStatePath).isFile()) {
      throw new Error("auth profile " + id + " storageState path is not a file: " + profile.storageStatePath);
    }
    return { id, ...profile, persistState };
  }
  list() {
    return Object.entries(this.profiles).sort(([a], [b]) => a.localeCompare(b)).map(([id, profile]) => ({ id, allowedDomains: [...profile.allowedDomains ?? []], persistState: profile.persistState ?? false }));
  }
};

// src/rule-packs.ts
import crypto3 from "node:crypto";
import fs4 from "node:fs";
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
    const stat = fs4.statSync(pack.initScriptPath);
    if (stat.size > 64 * 1024) throw new Error("rule pack init script exceeds 65536 bytes");
    const actual = crypto3.createHash("sha256").update(fs4.readFileSync(pack.initScriptPath)).digest("hex");
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
var READ_ONLY_ACTIONS = /* @__PURE__ */ new Set(["wait", "extract", "assert", "screenshot"]);
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
function recipeNeedsApproval(steps) {
  return steps.some((step) => !READ_ONLY_ACTIONS.has(step.type));
}
function cap2(value, max = 5e4) {
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
        if (mode === "text") value = cap2(await target.innerText());
        else if (mode === "html") value = cap2(await target.innerHTML());
        else if (mode === "attribute") value = String(await target.getAttribute(shortText(step.attribute, "attribute", 100)) ?? "");
        else {
          const rows = await target.locator("a[href]").evaluateAll((anchors, limit) => anchors.slice(0, limit).map((anchor) => ({
            text: String(anchor.textContent ?? "").trim(),
            url: String(anchor.href ?? "")
          })), step.limit ?? 100);
          value = cap2(JSON.stringify(rows));
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
function uid2() {
  return crypto4.randomUUID();
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
  if (!fs5.existsSync(statePath)) {
    if (allowMissing) return {};
    throw new Error(`dsh-browser: ${label} storageState file does not exist: ${statePath}`);
  }
  if (!fs5.statSync(statePath).isFile()) throw new Error(`dsh-browser: ${label} storageState path is not a file: ${statePath}`);
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
        fs5.mkdirSync(path4.dirname(session.profile.storageStatePath), { recursive: true });
        const temporary = session.profile.storageStatePath + ".tmp-" + uid2().slice(0, 8);
        fs5.writeFileSync(temporary, JSON.stringify(state, null, 2), { encoding: "utf8", mode: 384 });
        fs5.renameSync(temporary, session.profile.storageStatePath);
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
    fs5.mkdirSync(opts.outDir, { recursive: true });
    const stamp = Date.now() + "-" + uid2().slice(0, 8);
    const screenshotPath = opts.screenshot === false ? void 0 : path4.join(opts.outDir, stamp + ".png");
    const htmlPath = path4.join(opts.outDir, stamp + ".html");
    try {
      page.setDefaultTimeout(25e3);
      await this.navigate(page, url, { waitUntil: "domcontentloaded", timeout: 3e4 }, signal);
      await page.waitForLoadState("networkidle", { timeout: 1e4 }).catch(() => {
      });
      await applyRuleSteps(page, session.rulePack);
      if (screenshotPath) await page.screenshot({ path: screenshotPath, fullPage: true });
      const html = await page.content();
      fs5.writeFileSync(htmlPath, html, "utf8");
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
      return fs5.existsSync(opencliEntryPath());
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
    const filename = options.filename ?? `shot-${Date.now()}-${uid2().slice(0, 8)}.${options.format === "jpeg" ? "jpg" : "png"}`;
    if (filename !== path4.basename(filename) || !/^[\w.() -]{1,160}$/.test(filename)) {
      throw new Error("browser_screenshot filename must be a plain file name inside snapshotDir");
    }
    const extension = path4.extname(filename).toLowerCase();
    const inferred = extension === ".jpg" || extension === ".jpeg" ? "jpeg" : extension === ".png" ? "png" : void 0;
    const format = options.format ?? inferred ?? "png";
    if (inferred && inferred !== format) throw new Error("browser_screenshot filename extension does not match format");
    if (!inferred) throw new Error("browser_screenshot filename must end in .png, .jpg, or .jpeg");
    return { file: path4.join(this.config.snapshotDir, filename), format };
  }
  async captureScreenshot(page, options = {}) {
    fs5.mkdirSync(this.config.snapshotDir, { recursive: true });
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
      if (!path4.isAbsolute(file)) throw new Error("browser_set_files requires absolute file paths: " + file);
      const real = fs5.realpathSync(file);
      if (!fs5.statSync(real).isFile()) throw new Error("browser_set_files path is not a file: " + file);
      return real;
    });
    const totalBytes = resolved.reduce((total, file) => total + fs5.statSync(file).size, 0);
    if (totalBytes > 512 * 1024 * 1024) throw new Error("browser_set_files total upload size exceeds 512 MiB");
    const page = await this.ensureActivePage();
    await this.resolveTarget(page, target).setInputFiles(resolved, { timeout: boundedTimeout(opts.timeoutMs, "browser_set_files timeoutMs") });
    return { ...await this.readState(page, true), files: resolved.map((file) => path4.basename(file)) };
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
    const records = this.capturedConsole.filter((record2) => {
      const index = severities.indexOf(record2.type === "warn" ? "warning" : record2.type);
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
        chromiumExecutablePath = path4.resolve(expectedPath);
        chromiumInstalled = fs5.existsSync(chromiumExecutablePath);
      }
    } catch {
      chromiumInstalled = false;
    }
    let opencliInstalled = false;
    let resolvedOpencliEntryPath;
    try {
      resolvedOpencliEntryPath = path4.resolve(opencliEntryPath());
      opencliInstalled = fs5.existsSync(resolvedOpencliEntryPath);
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

// src/tools.ts
import { defineTool } from "@deepseek-ai/dsh-tools";

// src/automation-development.ts
var AutomationDevelopmentService = class {
  constructor(store, policy) {
    this.store = store;
    this.policy = policy;
  }
  store;
  policy;
  writesBySession = /* @__PURE__ */ new Map();
  get(id) {
    this.assertEnabled();
    const asset = this.store.get(id);
    if (!asset) throw new Error("automation asset not found");
    return asset;
  }
  validate(id) {
    this.assertEnabled();
    return this.store.validate(id);
  }
  save(input, sessionId2) {
    this.assertEnabled();
    const writes = this.writesBySession.get(sessionId2) ?? 0;
    if (writes >= this.policy.maxModelDraftWritesPerSession) throw new Error("model draft write limit reached for this session");
    const asset = this.store.saveDraft(input);
    this.writesBySession.set(sessionId2, writes + 1);
    if (this.writesBySession.size > 200) this.writesBySession.delete(this.writesBySession.keys().next().value ?? "");
    return asset;
  }
  assertEnabled() {
    if (!this.policy.modelDevelopmentEnabled) throw new Error("model automation development is disabled");
  }
};

// src/automation-execution.ts
function materialize(value, inputs) {
  return value.replace(/\{\{([a-zA-Z][\w-]*)\}\}/g, (_match, name2) => {
    if (!(name2 in inputs)) throw new Error(`missing automation input: ${name2}`);
    return inputs[name2];
  });
}
function materializeRecipe(steps, inputs) {
  return steps.map((step) => {
    const copy = structuredClone(step);
    for (const key of ["value", "text"]) if (typeof copy[key] === "string") copy[key] = materialize(copy[key], inputs);
    return copy;
  });
}
function automationInputs(asset, raw) {
  const inputs = raw && typeof raw === "object" && !Array.isArray(raw) ? Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, String(value)])) : {};
  if (Object.keys(inputs).length > 20 || Object.entries(inputs).some(([key, value]) => !/^[a-zA-Z][\w-]{0,39}$/.test(key) || value.length > 1e4)) throw new Error("automation inputs exceed key, count, or value limits");
  const missing = asset.inputNames.filter((name2) => !(name2 in inputs));
  const extra = Object.keys(inputs).filter((name2) => !asset.inputNames.includes(name2));
  if (missing.length) throw new Error("missing declared automation inputs: " + missing.join(", "));
  if (extra.length) throw new Error("undeclared automation inputs: " + extra.join(", "));
  return inputs;
}
async function executeAutomationAsset(service, store, id, url, rawInputs, requiredStatus, options = {}) {
  const asset = store.get(id);
  if (!asset || asset.status !== requiredStatus) throw new Error(`${requiredStatus} automation asset not found`);
  const inputs = automationInputs(asset, rawInputs);
  store.assertTarget(asset, url);
  try {
    const value = asset.kind === "recipe" ? await service.recipe(materializeRecipe(asset.recipe ?? [], inputs), { url, signal: options.signal, ...options.authProfile ? { authProfile: options.authProfile } : {}, ...options.rulePack ? { rulePack: options.rulePack } : {} }) : await service.runUserscript(url, asset.source ?? "", { signal: options.signal, inputs, ...options.authProfile ? { authProfile: options.authProfile } : {}, ...options.rulePack ? { rulePack: options.rulePack } : {} });
    if (requiredStatus === "active") store.noteRun(asset.id, true);
    else store.noteTestResult(asset.id, true, url);
    return { asset: store.get(asset.id), value };
  } catch (error) {
    if (requiredStatus === "active") store.noteRun(asset.id, false);
    else store.noteTestResult(asset.id, false, url);
    throw error;
  }
}

// src/tools.ts
function sessionId(exec) {
  const value = exec?.agent?.session?.id;
  return typeof value === "string" && value ? value : "unknown-session";
}
function developmentResult(action, value, asset) {
  const raw = JSON.stringify(value);
  return { action, ...asset ? { assetId: asset.id, status: asset.status } : {}, resultJson: raw.slice(0, 1e5), truncated: raw.length > 1e5 };
}
function renderState(v) {
  const parts = [];
  if (v.title) parts.push("Title: " + v.title);
  parts.push(v.url);
  parts.push(v.text);
  if (v.screenshotPath) parts.push("Screenshot: " + v.screenshotPath);
  return [{ type: "text", text: parts.join("\n\n") }];
}
function renderScriptResult(value) {
  const v = value;
  return [{ type: "text", text: [
    `Script: ${v.name} (${v.sha256.slice(0, 12)})`,
    `URL: ${v.url}`,
    `Capabilities: ${v.capabilities.join(", ")}`,
    v.resultJson + (v.truncated ? "\n(result truncated)" : "")
  ].join("\n") }];
}
var SCRIPT_RESULT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    url: { type: "string", required: true },
    name: { type: "string", required: true },
    sha256: { type: "string", required: true },
    capabilities: { type: "array", required: true, items: { type: "string" } },
    resultJson: { type: "string", required: true },
    truncated: { type: "boolean", required: true }
  }
};
var RECIPE_STEP_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    type: { type: "string", required: true, enum: ["wait", "click", "fill", "type", "press", "select", "check", "hover", "scroll", "extract", "assert", "screenshot"] },
    condition: { type: "string", enum: ["selector", "text", "load", "time"] },
    selector: { type: "string" },
    value: { type: "string" },
    text: { type: "string" },
    key: { type: "string" },
    timeoutMs: { type: "number" },
    waitMs: { type: "number" },
    deltaY: { type: "number" },
    checked: { type: "boolean" },
    mode: { type: "string", enum: ["text", "html", "links", "attribute"] },
    attribute: { type: "string" },
    limit: { type: "number" }
  }
};
var COMPLIANCE_NOTICE = "The caller/operator must use this capability according to the target site rules and applicable requirements; dsh-browser only executes the requested browser operation and does not determine whether a particular use is permitted.";
var CDP_NOTICE = " Tip: For complex automation, consider using Playwright directly via node -e with connectOverCDP() to the configured CDP endpoint for full control.";
var FRAME_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    selector: { type: "string", description: "CSS selector for an iframe. Use exactly one frame field." },
    name: { type: "string", description: "Frame name. Use exactly one frame field." },
    url: { type: "string", description: "Playwright frame URL/glob. Use exactly one frame field." }
  }
};
var LOCATOR_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    selector: { type: "string", description: "CSS selector. Use exactly one of selector, role, text, or label." },
    role: { type: "string", description: "Accessible role used by Playwright getByRole." },
    name: { type: "string", description: "Optional accessible name; valid only with role." },
    text: { type: "string", description: "Visible text used by Playwright getByText." },
    label: { type: "string", description: "Form label used by Playwright getByLabel." },
    exact: { type: "boolean", description: "Require an exact semantic match. Defaults to false." },
    frame: FRAME_SCHEMA
  }
};
var INTERACTIVE_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    url: { type: "string", required: true },
    title: { type: "string" },
    text: { type: "string", required: true },
    screenshotPath: { type: "string" }
  }
};
function toolTarget(args, required = true) {
  if (typeof args.selector === "string" && args.locator === void 0) return args.selector;
  if (args.selector === void 0 && args.locator && typeof args.locator === "object") return args.locator;
  if (!required && args.selector === void 0 && args.locator === void 0) return void 0;
  throw new Error("provide exactly one of selector or locator");
}
function registerTools(ctx, config, service, assets) {
  const exposedTools = new Set(configuredBrowserTools(config.automationMode, config.automationAssets, config.enabled));
  const development = assets ? new AutomationDevelopmentService(assets, config.automationAssets) : void 0;
  const register = (tool) => {
    if (exposedTools.has(String(tool.name))) ctx.tools.register(tool);
  };
  register(defineTool({
    name: "browser_automation_search",
    description: "[Experimental] Search reusable browser automations by explicit task keywords and optional domain. Returns only compact metadata, never recipe steps or userscript source.",
    parameters: {
      query: { type: "string", required: true, description: "Short task description." },
      domain: { type: "string", description: "Optional target hostname." },
      status: { type: "string", enum: ["active", "draft", "archived", "all"], description: "Asset lifecycle scope. Defaults to active." },
      kind: { type: "string", enum: ["recipe", "userscript"], description: "Optional asset kind." }
    },
    output: {
      schema: {
        type: "array",
        items: { type: "object", additionalProperties: false, properties: {
          id: { type: "string", required: true },
          kind: { type: "string", required: true },
          status: { type: "string", required: true },
          name: { type: "string", required: true },
          description: { type: "string", required: true },
          domains: { type: "array", required: true, items: { type: "string" } },
          tags: { type: "array", required: true, items: { type: "string" } },
          inputNames: { type: "array", required: true, items: { type: "string" } },
          revision: { type: "number", required: true },
          testStatus: { type: "string", required: true },
          successCount: { type: "number", required: true },
          failureCount: { type: "number", required: true },
          updatedAt: { type: "string", required: true },
          lastRunAt: { type: "string" }
        } }
      },
      render: (_args, value) => [{ type: "text", text: value.length ? value.map((item) => `${item.id} \u2014 ${item.name} [${item.kind}] domains=${item.domains.join(",") || "*"} inputs=${item.inputNames.join(",") || "-"}`).join("\n") : "No active reusable automation matched." }]
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      return assets?.search(args.query, args.domain, args.status, args.kind) ?? [];
    }
  }));
  register(defineTool({
    name: "browser_automation_develop",
    description: "[Experimental] Explicitly inspect, save, validate, or replay one reusable automation draft. Use search first. Full recipe/source is returned only for action=get with an exact id. This tool never activates assets. " + COMPLIANCE_NOTICE + CDP_NOTICE,
    parameters: {
      action: { type: "string", required: true, enum: ["get", "save", "validate", "test"] },
      id: { type: "string", description: "Exact asset id for get, update, or validate." },
      kind: { type: "string", enum: ["recipe", "userscript"], description: "Required for save." },
      name: { type: "string", description: "Required for save." },
      description: { type: "string" },
      domains: { type: "array", items: { type: "string" } },
      tags: { type: "array", items: { type: "string" }, description: "Explicit retrieval keywords, capped at 20." },
      inputNames: { type: "array", items: { type: "string" }, description: "Declared UserScript __DSH_INPUTS__ keys. Recipe placeholders are inferred." },
      recipe: { type: "array", items: RECIPE_STEP_SCHEMA, description: "One to 25 declarative Playwright steps." },
      source: { type: "string", description: "Complete UserScript with @match and @grant none; capped by validator." },
      url: { type: "string", description: "Required for test; must match the draft domain and UserScript @match." },
      inputs: { type: "object", additionalProperties: true, description: "Declared runtime inputs for test." },
      authProfile: { type: "string" },
      rulePack: { type: "string" }
    },
    output: {
      schema: { type: "object", additionalProperties: false, properties: {
        action: { type: "string", required: true },
        assetId: { type: "string" },
        status: { type: "string" },
        resultJson: { type: "string", required: true },
        truncated: { type: "boolean", required: true }
      } },
      render: (_args, value) => [{ type: "text", text: `Automation development ${value.action}${value.assetId ? ` ${value.assetId} [${value.status}]` : ""}
${value.resultJson}${value.truncated ? "\n(result truncated)" : ""}` }]
    },
    timeoutMs: 3e4,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      if (!assets || !development) throw new Error("model automation development is disabled");
      if (args.action === "get") {
        if (!args.id) throw new Error("automation development get requires id");
        const asset2 = development.get(args.id);
        return developmentResult("get", asset2, asset2);
      }
      if (args.action === "validate") {
        if (!args.id) throw new Error("automation development validate requires id");
        const asset2 = development.validate(args.id);
        return developmentResult("validate", { id: asset2.id, kind: asset2.kind, status: asset2.status, testStatus: asset2.testStatus, testMessage: asset2.testMessage }, asset2);
      }
      if (args.action === "test") {
        if (!args.id || !args.url) throw new Error("automation development test requires id and url");
        const result = await executeAutomationAsset(service, assets, args.id, args.url, args.inputs, "draft", { signal: exec.signal, ...args.authProfile ? { authProfile: args.authProfile } : {}, ...args.rulePack ? { rulePack: args.rulePack } : {} });
        const raw = JSON.stringify(result.value);
        return developmentResult("test", { id: result.asset.id, testStatus: result.asset.testStatus, testMessage: result.asset.testMessage, resultJson: raw.slice(0, 5e4), truncated: raw.length > 5e4 }, result.asset);
      }
      if (args.action !== "save" || !args.kind || !args.name) throw new Error("automation development save requires kind and name");
      const asset = development.save({
        ...args.id ? { id: args.id } : {},
        kind: args.kind,
        name: args.name,
        ...args.description !== void 0 ? { description: args.description } : {},
        ...args.domains ? { domains: args.domains } : {},
        ...args.tags ? { tags: args.tags } : {},
        ...args.inputNames ? { inputNames: args.inputNames } : {},
        ...args.recipe ? { recipe: args.recipe } : {},
        ...args.source !== void 0 ? { source: args.source } : {}
      }, sessionId(exec));
      const compact = { id: asset.id, kind: asset.kind, status: asset.status, name: asset.name, domains: asset.domains, tags: asset.tags, inputNames: asset.inputNames, revision: asset.revision, testStatus: asset.testStatus };
      return developmentResult("save", compact, asset);
    }
  }));
  register(defineTool({
    name: "browser_automation_run",
    description: "[Experimental] Run one manually activated reusable automation by id. Search first. Source and recipe internals remain Host-side; provide declared inputs and a target HTTP(S) URL. " + COMPLIANCE_NOTICE + CDP_NOTICE,
    parameters: {
      id: { type: "string", required: true },
      url: { type: "string", required: true },
      inputs: { type: "object", additionalProperties: true, description: "Declared string inputs used by named recipe placeholders." },
      authProfile: { type: "string" },
      rulePack: { type: "string" }
    },
    output: {
      schema: { type: "object", additionalProperties: false, properties: {
        assetId: { type: "string", required: true },
        kind: { type: "string", required: true },
        resultJson: { type: "string", required: true },
        truncated: { type: "boolean", required: true }
      } },
      render: (_args, value) => [{ type: "text", text: `Automation ${value.assetId} [${value.kind}]
${value.resultJson}${value.truncated ? "\n(result truncated)" : ""}` }]
    },
    timeoutMs: 12e4,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      if (!assets) throw new Error("automation assets are unavailable");
      const result = await executeAutomationAsset(service, assets, args.id, args.url, args.inputs, "active", { signal: exec.signal, ...args.authProfile ? { authProfile: args.authProfile } : {}, ...args.rulePack ? { rulePack: args.rulePack } : {} });
      const raw = JSON.stringify(result.value);
      return { assetId: result.asset.id, kind: result.asset.kind, resultJson: raw.slice(0, 1e5), truncated: raw.length > 1e5 };
    }
  }));
  register(defineTool({
    name: "browser_open",
    description: "Open a URL in the persistent browser page and return the rendered title, readable text, and a full-page screenshot path. Optional bounded capture stores console messages and failed/4xx/5xx requests in memory without bodies or headers. " + COMPLIANCE_NOTICE + CDP_NOTICE,
    parameters: {
      url: { type: "string", required: true, description: "The HTTP(S) URL to open." },
      waitMs: { type: "number", description: "Extra settle time in ms after load." },
      authProfile: { type: "string", description: "Named, domain-scoped auth profile from dsh-browser config." },
      rulePack: { type: "string", description: "Named, domain-scoped enhancement rule pack." },
      capture: { type: "array", items: { type: "string", enum: ["console", "network"] }, description: "Optional in-memory capture channels for this navigation. Records are capped and reset on the next open." }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          url: { type: "string", required: true },
          title: { type: "string" },
          text: { type: "string", required: true },
          screenshotPath: { type: "string" }
        }
      },
      render: (_args, value) => renderState(value)
    },
    timeoutMs: 6e4,
    isConcurrencySafe: () => false,
    async execute(args) {
      return service.open(args.url, { ...args.waitMs !== void 0 ? { waitMs: args.waitMs } : {}, ...args.authProfile ? { authProfile: args.authProfile } : {}, ...args.rulePack ? { rulePack: args.rulePack } : {}, ...args.capture ? { capture: args.capture } : {} });
    }
  }));
  register(defineTool({
    name: "browser_click",
    description: "Click a CSS selector or structured Playwright locator on the current browser page, then return the updated page state. " + COMPLIANCE_NOTICE + CDP_NOTICE,
    parameters: {
      selector: { type: "string", description: "CSS selector of the element to click. Omit when locator is provided." },
      locator: LOCATOR_SCHEMA
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          url: { type: "string", required: true },
          title: { type: "string" },
          text: { type: "string", required: true },
          screenshotPath: { type: "string" }
        }
      },
      render: (_args, value) => renderState(value)
    },
    timeoutMs: 3e4,
    isConcurrencySafe: () => false,
    async execute(args) {
      return service.click(toolTarget(args));
    }
  }));
  register(defineTool({
    name: "browser_type",
    description: "Type text into an input/textarea selected by CSS or a structured Playwright locator, then return the page state. " + COMPLIANCE_NOTICE + CDP_NOTICE,
    parameters: {
      selector: { type: "string", description: "CSS selector of the input/textarea. Omit when locator is provided." },
      locator: LOCATOR_SCHEMA,
      text: { type: "string", required: true, description: "Text to type." }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          url: { type: "string", required: true },
          title: { type: "string" },
          text: { type: "string", required: true },
          screenshotPath: { type: "string" }
        }
      },
      render: (_args, value) => renderState(value)
    },
    timeoutMs: 3e4,
    isConcurrencySafe: () => false,
    async execute(args) {
      return service.type(toolTarget(args), args.text);
    }
  }));
  register(defineTool({
    name: "browser_wait",
    description: "Wait for one locator state, URL pattern, network idle, or a bounded amount of time on the active page. " + COMPLIANCE_NOTICE + CDP_NOTICE,
    parameters: {
      selector: { type: "string", description: "CSS selector to wait for. Omit when locator or another wait mode is provided." },
      locator: LOCATOR_SCHEMA,
      state: { type: "string", enum: ["visible", "hidden", "attached", "detached"], description: "Locator state. Defaults to visible." },
      urlPattern: { type: "string", description: "Playwright URL glob to wait for." },
      networkIdle: { type: "boolean", description: "Set true to wait for networkidle." },
      timeMs: { type: "number", description: "Fixed delay from 0 to 10,000 ms." },
      timeoutMs: { type: "number", description: "Condition timeout from 0 to 30,000 ms. Default 15,000." }
    },
    output: { schema: INTERACTIVE_OUTPUT_SCHEMA, render: (_args, value) => renderState(value) },
    timeoutMs: 35e3,
    isConcurrencySafe: () => false,
    async execute(args) {
      const target = toolTarget(args, false);
      return service.wait(target, {
        ...args.state ? { state: args.state } : {},
        ...args.urlPattern ? { urlPattern: args.urlPattern } : {},
        ...args.networkIdle !== void 0 ? { networkIdle: args.networkIdle } : {},
        ...args.timeMs !== void 0 ? { timeMs: args.timeMs } : {},
        ...args.timeoutMs !== void 0 ? { timeoutMs: args.timeoutMs } : {}
      });
    }
  }));
  register(defineTool({
    name: "browser_press",
    description: "Press a key globally or on a CSS/semantic locator in the active page. " + COMPLIANCE_NOTICE + CDP_NOTICE,
    parameters: {
      selector: { type: "string", description: "Optional CSS target. Omit for a global keyboard press or when locator is provided." },
      locator: LOCATOR_SCHEMA,
      key: { type: "string", required: true, description: "Playwright key such as Enter, ArrowDown, or Control+Enter." },
      timeoutMs: { type: "number", description: "Target timeout from 1 to 30,000 ms." }
    },
    output: { schema: INTERACTIVE_OUTPUT_SCHEMA, render: (_args, value) => renderState(value) },
    timeoutMs: 3e4,
    isConcurrencySafe: () => false,
    async execute(args) {
      return service.press(toolTarget(args, false), args.key, { ...args.timeoutMs !== void 0 ? { timeoutMs: args.timeoutMs } : {} });
    }
  }));
  register(defineTool({
    name: "browser_select",
    description: "Select one or more values in a dropdown selected by CSS or a semantic locator. " + COMPLIANCE_NOTICE + CDP_NOTICE,
    parameters: {
      selector: { type: "string", description: "CSS selector. Omit when locator is provided." },
      locator: LOCATOR_SCHEMA,
      values: { type: "array", required: true, items: { type: "string" }, description: "One to 20 option values." },
      timeoutMs: { type: "number", description: "Target timeout from 1 to 30,000 ms." }
    },
    output: { schema: INTERACTIVE_OUTPUT_SCHEMA, render: (_args, value) => renderState(value) },
    timeoutMs: 3e4,
    isConcurrencySafe: () => false,
    async execute(args) {
      return service.select(toolTarget(args), args.values, { ...args.timeoutMs !== void 0 ? { timeoutMs: args.timeoutMs } : {} });
    }
  }));
  register(defineTool({
    name: "browser_check",
    description: "Check or uncheck a checkbox or radio control selected by CSS or a semantic locator. " + COMPLIANCE_NOTICE + CDP_NOTICE,
    parameters: {
      selector: { type: "string", description: "CSS selector. Omit when locator is provided." },
      locator: LOCATOR_SCHEMA,
      checked: { type: "boolean", description: "True to check, false to uncheck. Defaults to true." },
      timeoutMs: { type: "number", description: "Target timeout from 1 to 30,000 ms." }
    },
    output: { schema: INTERACTIVE_OUTPUT_SCHEMA, render: (_args, value) => renderState(value) },
    timeoutMs: 3e4,
    isConcurrencySafe: () => false,
    async execute(args) {
      return service.check(toolTarget(args), args.checked ?? true, { ...args.timeoutMs !== void 0 ? { timeoutMs: args.timeoutMs } : {} });
    }
  }));
  register(defineTool({
    name: "browser_hover",
    description: "Hover a CSS selector or semantic locator on the current browser page and return the updated state. " + COMPLIANCE_NOTICE + CDP_NOTICE,
    parameters: {
      selector: { type: "string", description: "CSS selector of the element to hover. Omit when locator is provided." },
      locator: LOCATOR_SCHEMA,
      waitMs: { type: "number", description: "Settle time after hovering, from 0 to the tool timeout. Default 300 ms." }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          url: { type: "string", required: true },
          title: { type: "string" },
          text: { type: "string", required: true },
          screenshotPath: { type: "string" }
        }
      },
      render: (_args, value) => renderState(value)
    },
    timeoutMs: 3e4,
    isConcurrencySafe: () => false,
    async execute(args) {
      return service.hover(toolTarget(args), { ...args.waitMs !== void 0 ? { waitMs: args.waitMs } : {} });
    }
  }));
  register(defineTool({
    name: "browser_set_files",
    description: "Set one or more existing local files on a file-input CSS selector in the current page. Paths must be absolute regular files; the tool reads them for upload but does not modify them. Approval discloses the requested paths unless automationMode=unrestricted. " + COMPLIANCE_NOTICE + CDP_NOTICE,
    parameters: {
      selector: { type: "string", description: "CSS selector of an input[type=file] element. Omit when locator is provided." },
      locator: LOCATOR_SCHEMA,
      files: { type: "array", required: true, items: { type: "string" }, description: "One to 20 absolute local file paths, with at most 512 MiB total size." }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          url: { type: "string", required: true },
          title: { type: "string" },
          text: { type: "string", required: true },
          screenshotPath: { type: "string" },
          files: { type: "array", required: true, items: { type: "string" } }
        }
      },
      render: (_args, value) => {
        const result = value;
        return [{ type: "text", text: renderState(result)[0].text + "\n\nSelected files: " + result.files.join(", ") }];
      }
    },
    timeoutMs: 3e4,
    isConcurrencySafe: () => false,
    async execute(args) {
      return service.setFiles(toolTarget(args), args.files);
    }
  }));
  register(defineTool({
    name: "browser_evaluate",
    description: "Evaluate one bounded JavaScript expression in the current page and return capped JSON. It runs with the page origin and login state, so it can read or mutate the DOM, access non-HttpOnly cookies/storage, and issue requests allowed by the browser. It has no Node.js or direct host-filesystem access, and downloads are not persisted by this tool. " + COMPLIANCE_NOTICE + CDP_NOTICE,
    parameters: {
      expression: { type: "string", required: true, description: "A JavaScript expression up to 20,000 characters. The resolved value must be JSON-serializable." },
      timeoutMs: { type: "number", description: "Execution timeout from 1,000 to 30,000 ms. Default 15,000; Chromium page execution is terminated while the page remains open." }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          url: { type: "string", required: true },
          resultJson: { type: "string", required: true },
          truncated: { type: "boolean", required: true },
          capabilities: { type: "array", required: true, items: { type: "string" } },
          warnings: { type: "array", required: true, items: { type: "string" } }
        }
      },
      render: (_args, value) => {
        const result = value;
        return [{ type: "text", text: [`URL: ${result.url}`, `Capabilities: ${result.capabilities.join(", ")}`, result.resultJson + (result.truncated ? "\n(result truncated)" : ""), ...result.warnings.map((warning) => "Warning: " + warning)].join("\n") }];
      }
    },
    timeoutMs: 35e3,
    isConcurrencySafe: () => false,
    async execute(args) {
      return service.evaluate(args.expression, { ...args.timeoutMs !== void 0 ? { timeoutMs: args.timeoutMs } : {} });
    }
  }));
  register(defineTool({
    name: "browser_console",
    description: "Return bounded, redacted console records captured since the latest browser_open with capture=[console]. Records stay in memory and omit console argument objects. " + COMPLIANCE_NOTICE + CDP_NOTICE,
    parameters: {
      level: { type: "string", enum: ["debug", "log", "info", "warning", "error"], description: "Minimum severity. Defaults to debug." },
      limit: { type: "number", description: "Return the newest 1 to 200 records. Default 100." },
      clear: { type: "boolean", description: "Clear captured records after reading." }
    },
    output: { schema: { type: "object", additionalProperties: false, properties: {
      enabled: { type: "boolean", required: true },
      records: { type: "array", required: true, items: { type: "object", additionalProperties: false, properties: {
        type: { type: "string", required: true },
        text: { type: "string", required: true },
        url: { type: "string" },
        timestamp: { type: "string", required: true }
      } } }
    } }, render: (_args, value) => [{ type: "text", text: value.enabled ? value.records.map((record2) => `[${record2.type}] ${record2.text}${record2.url ? ` (${record2.url})` : ""}`).join("\n") || "No captured console messages." : "Console capture is disabled; reopen with capture=[console]." }] },
    timeoutMs: 1e4,
    isConcurrencySafe: () => true,
    async execute(args) {
      return service.consoleMessages(args);
    }
  }));
  register(defineTool({
    name: "browser_requests",
    description: "Return bounded, redacted failed and HTTP 4xx/5xx requests captured since the latest browser_open with capture=[network]. Request/response bodies and headers are never recorded. " + COMPLIANCE_NOTICE + CDP_NOTICE,
    parameters: {
      limit: { type: "number", description: "Return the newest 1 to 200 records. Default 100." },
      clear: { type: "boolean", description: "Clear captured records after reading." }
    },
    output: { schema: { type: "object", additionalProperties: false, properties: {
      enabled: { type: "boolean", required: true },
      records: { type: "array", required: true, items: { type: "object", additionalProperties: false, properties: {
        method: { type: "string", required: true },
        url: { type: "string", required: true },
        status: { type: "number" },
        failure: { type: "string" },
        timestamp: { type: "string", required: true }
      } } }
    } }, render: (_args, value) => [{ type: "text", text: value.enabled ? value.records.map((record2) => `${record2.method} ${record2.status ?? "FAILED"} ${record2.url}${record2.failure ? ` \u2014 ${record2.failure}` : ""}`).join("\n") || "No failed or HTTP 4xx/5xx requests captured." : "Network capture is disabled; reopen with capture=[network]." }] },
    timeoutMs: 1e4,
    isConcurrencySafe: () => true,
    async execute(args) {
      return service.networkRequests(args);
    }
  }));
  register(defineTool({
    name: "browser_scroll",
    description: "Scroll the current browser page vertically by deltaY pixels (positive = down) to trigger lazy loading, then return the page state. " + COMPLIANCE_NOTICE + CDP_NOTICE,
    parameters: {
      deltaY: { type: "number", description: "Pixels to scroll; positive scrolls down. Default 2000." }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          url: { type: "string", required: true },
          title: { type: "string" },
          text: { type: "string", required: true },
          screenshotPath: { type: "string" }
        }
      },
      render: (_args, value) => renderState(value)
    },
    timeoutMs: 2e4,
    isConcurrencySafe: () => false,
    async execute(args) {
      return service.scroll(args.deltaY ?? 2e3);
    }
  }));
  register(defineTool({
    name: "browser_read",
    description: "Read the current browser page state (URL, title, readable text) without taking a screenshot.",
    parameters: {},
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          url: { type: "string", required: true },
          title: { type: "string" },
          text: { type: "string", required: true },
          screenshotPath: { type: "string" }
        }
      },
      render: (_args, value) => renderState(value)
    },
    timeoutMs: 2e4,
    isConcurrencySafe: () => false,
    async execute() {
      return service.read();
    }
  }));
  register(defineTool({
    name: "browser_screenshot",
    description: "Capture the page, a bounded region, or a CSS/semantic locator. Files always land inside the configured snapshotDir under a plain caller-supplied filename or an autogenerated name. " + COMPLIANCE_NOTICE + CDP_NOTICE,
    parameters: {
      selector: { type: "string", description: "Optional CSS selector. Omit when locator is provided." },
      locator: LOCATOR_SCHEMA,
      clip: { type: "object", additionalProperties: false, properties: {
        x: { type: "number", required: true },
        y: { type: "number", required: true },
        width: { type: "number", required: true },
        height: { type: "number", required: true }
      } },
      fullPage: { type: "boolean", description: "Capture the full scrollable page. Defaults to true for page screenshots; incompatible with selector/locator." },
      format: { type: "string", enum: ["png", "jpeg"], description: "Image format. Defaults from filename or png." },
      quality: { type: "number", description: "JPEG quality from 0 to 100." },
      filename: { type: "string", description: "Plain filename only, ending in .png, .jpg, or .jpeg. Directory traversal and absolute paths are rejected." }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string", required: true }
        }
      },
      render: (_args, value) => [{ type: "text", text: "Screenshot: " + value.path }]
    },
    timeoutMs: 3e4,
    isConcurrencySafe: () => false,
    async execute(args) {
      const target = toolTarget(args, false);
      return service.screenshot({
        ...target ? { target } : {},
        ...args.clip ? { clip: args.clip } : {},
        ...args.fullPage !== void 0 ? { fullPage: args.fullPage } : {},
        ...args.format ? { format: args.format } : {},
        ...args.quality !== void 0 ? { quality: args.quality } : {},
        ...args.filename ? { filename: args.filename } : {}
      });
    }
  }));
  register(defineTool({
    name: "browser_close",
    description: "Close the current browser page (and its context). The next browser_open starts a fresh page.",
    parameters: {},
    output: {
      schema: { type: "object", additionalProperties: false, properties: { closed: { type: "boolean", required: true } } },
      render: () => [{ type: "text", text: "Browser page closed." }]
    },
    timeoutMs: 15e3,
    async execute() {
      await service.closePage();
      return { closed: true };
    }
  }));
  register(defineTool({
    name: "browser_status",
    description: "Report the browser runtime status: enabled, channel, headless, whether chromium is installed, whether the bundled OpenCLI is enabled, and the active page URL.",
    parameters: {},
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          enabled: { type: "boolean", required: true },
          channel: { type: "string", required: true },
          browserRuntime: { type: "string", required: true, enum: ["playwright", "patchright"] },
          runtimeWarnings: { type: "array", required: true, items: { type: "string" } },
          headless: { type: "boolean", required: true },
          cdpEndpoint: { type: "string" },
          cdpConnected: { type: "boolean", required: true },
          opencliEnabled: { type: "boolean", required: true },
          opencliInstalled: { type: "boolean", required: true },
          opencliEntryPath: { type: "string" },
          automationMode: { type: "string", required: true, enum: ["read-only", "standard", "autonomous", "unrestricted"] },
          exposedTools: { type: "array", required: true, items: { type: "string" } },
          directInteractionPolicy: { type: "string", required: true, enum: ["deny", "ask", "allow"] },
          mutatingRecipePolicy: { type: "string", required: true, enum: ["deny", "ask", "allow"] },
          externalUserscriptPolicy: { type: "string", required: true, enum: ["deny", "ask", "allow"] },
          pageEvaluatePolicy: { type: "string", required: true, enum: ["deny", "ask", "allow"] },
          fileUploadPolicy: { type: "string", required: true, enum: ["deny", "ask", "allow"] },
          opencliRunPolicy: { type: "string", required: true, enum: ["deny", "ask", "allow"] },
          chromiumInstalled: { type: "boolean", required: true },
          chromiumExecutablePath: { type: "string" },
          usagePolicy: { type: "object", required: true, additionalProperties: true, properties: {} },
          usageGovernor: { type: "object", required: true, additionalProperties: true, properties: {} },
          activeUrl: { type: "string" },
          activeAuthProfile: { type: "string" },
          authProfiles: { type: "array", required: true, items: { type: "object", additionalProperties: false, properties: { id: { type: "string", required: true }, allowedDomains: { type: "array", required: true, items: { type: "string" } }, persistState: { type: "boolean", required: true } } } },
          rulePacks: { type: "array", required: true, items: { type: "string" } },
          builtinScripts: { type: "array", required: true, items: { type: "string" } },
          externalUserscriptsRequireApproval: { type: "boolean", required: true },
          mutatingRecipesRequireApproval: { type: "boolean", required: true }
        }
      },
      render: (_args, value) => {
        const v = value;
        return [{ type: "text", text: [
          "browser: " + (v.enabled ? "enabled" : "disabled"),
          "runtime: " + v.browserRuntime + " / " + v.channel + (v.headless ? " (headless)" : " (headed)"),
          ...v.cdpEndpoint ? ["cdp: " + v.cdpEndpoint + (v.cdpConnected ? " (connected)" : " (disconnected)")] : [],
          "automation mode: " + v.automationMode + " (" + v.exposedTools.length + " tools exposed)",
          "direct interactions: " + v.directInteractionPolicy,
          "mutating recipes: " + v.mutatingRecipePolicy,
          "external userscripts: " + v.externalUserscriptPolicy,
          "page evaluate: " + v.pageEvaluatePolicy,
          "local file upload: " + v.fileUploadPolicy,
          "general opencli: " + v.opencliRunPolicy,
          "runtime chromium installed: " + v.chromiumInstalled,
          ...v.chromiumExecutablePath ? ["chromium executable: " + v.chromiumExecutablePath] : [],
          `usage buffer: concurrency=${v.usagePolicy.maxConcurrency}, burst=${v.usagePolicy.burst}/${v.usagePolicy.minDelayMs}ms, crawl=${v.usagePolicy.maxPagesPerRun} pages depth ${v.usagePolicy.maxDepth}`,
          `usage activity: runs=${v.usageGovernor.totalRuns}, queued=${v.usageGovernor.queued}, waited=${v.usageGovernor.totalWaitMs}ms, backoffs=${v.usageGovernor.backoffEvents}`,
          "opencli: " + (v.opencliEnabled ? "enabled" : "disabled") + " / " + (v.opencliInstalled ? "installed" : "missing"),
          ...v.opencliEntryPath ? ["opencli entry: " + v.opencliEntryPath] : [],
          "auth profiles: " + (v.authProfiles.map((p) => p.id + "[" + p.allowedDomains.join(",") + "]" + (p.persistState ? "(writeback)" : "")).join("; ") || "-"),
          "rule packs: " + (v.rulePacks.join(", ") || "-"),
          "built-in scripts: " + v.builtinScripts.join(", "),
          ...v.runtimeWarnings.map((warning) => "warning: " + warning),
          ...v.activeAuthProfile ? ["active auth profile: " + v.activeAuthProfile] : [],
          ...v.activeUrl ? ["active page: " + v.activeUrl] : []
        ].join("\n") }];
      }
    },
    timeoutMs: 15e3,
    isConcurrencySafe: () => true,
    async execute() {
      return service.status();
    }
  }));
  register(defineTool({
    name: "browser_install",
    description: "Install the bundled Playwright chromium browser (downloads to the Playwright cache). Run this once if browser_status reports chromium not installed.",
    parameters: {},
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          code: { type: "number", required: true },
          stdout: { type: "string" },
          stderr: { type: "string" },
          timedOut: { type: "boolean", required: true }
        }
      },
      render: (_args, value) => {
        const v = value;
        return [{ type: "text", text: "install exit=" + v.code + (v.timedOut ? " (timeout)" : "") + "\n" + ((v.stderr || v.stdout) ?? "").slice(0, 2e3) }];
      }
    },
    timeoutMs: 6e5,
    isConcurrencySafe: () => false,
    async execute() {
      const r = await service.installChromium();
      return { code: r.code, stdout: r.stdout, stderr: r.stderr, timedOut: r.timedOut };
    }
  }));
  register(defineTool({
    name: "browser_script_catalog",
    description: "List trusted built-in read-only browser scripts. Prefer these over external JavaScript for article extraction, links, JSON-LD, and form structure.",
    parameters: {},
    output: {
      schema: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            id: { type: "string", required: true },
            name: { type: "string", required: true },
            description: { type: "string", required: true },
            sha256: { type: "string", required: true }
          }
        }
      },
      render: (_args, value) => [{ type: "text", text: value.map((item) => `${item.id} \u2014 ${item.description} (${item.sha256.slice(0, 12)})`).join("\n") }]
    },
    isConcurrencySafe: () => true,
    async execute() {
      return service.scriptCatalog();
    }
  }));
  register(defineTool({
    name: "browser_script_validate",
    description: "Validate externally supplied Tampermonkey/UserScript-style JavaScript without executing it. Parses @match/@grant, reports SHA-256 and capabilities. Only @grant none is supported.",
    parameters: {
      source: { type: "string", required: true, description: "Complete userscript source including the metadata block. Never embed credentials." },
      url: { type: "string", description: "Optional target URL to verify against @match and @exclude-match." }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          valid: { type: "boolean", required: true },
          sha256: { type: "string", required: true },
          bytes: { type: "number", required: true },
          name: { type: "string", required: true },
          matches: { type: "array", required: true, items: { type: "string" } },
          grants: { type: "array", required: true, items: { type: "string" } },
          capabilities: { type: "array", required: true, items: { type: "string" } },
          errors: { type: "array", required: true, items: { type: "string" } },
          warnings: { type: "array", required: true, items: { type: "string" } }
        }
      },
      render: (_args, value) => [{ type: "text", text: [
        `${value.valid ? "VALID" : "INVALID"} ${value.name} (${value.sha256})`,
        `matches: ${value.matches.join(", ") || "-"}`,
        `grants: ${value.grants.join(", ") || "none (implicit)"}`,
        `capabilities: ${value.capabilities.join(", ")}`,
        ...value.errors.map((error) => "error: " + error),
        ...value.warnings.map((warning) => "warning: " + warning)
      ].join("\n") }]
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const result = service.validateUserscript(args.source, args.url);
      return {
        valid: result.valid,
        sha256: result.sha256,
        bytes: result.bytes,
        name: result.metadata.name,
        matches: result.metadata.matches,
        grants: result.metadata.grants,
        capabilities: result.capabilities,
        errors: result.errors,
        warnings: result.warnings
      };
    }
  }));
  register(defineTool({
    name: "browser_script_run_builtin",
    description: "Run one trusted built-in read-only script in a fresh Playwright context and return bounded JSON. Supports named AuthProfile and RulePack selection. " + COMPLIANCE_NOTICE + CDP_NOTICE,
    parameters: {
      url: { type: "string", required: true },
      scriptId: { type: "string", required: true, enum: ["article-clean", "links", "jsonld", "forms"] },
      authProfile: { type: "string" },
      rulePack: { type: "string" },
      timeoutMs: { type: "number" }
    },
    output: { schema: SCRIPT_RESULT_SCHEMA, render: (_args, value) => renderScriptResult(value) },
    timeoutMs: 6e4,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      return service.runBuiltinScript(args.url, args.scriptId, {
        signal: exec.signal,
        ...args.timeoutMs !== void 0 ? { timeoutMs: args.timeoutMs } : {},
        ...args.authProfile ? { authProfile: args.authProfile } : {},
        ...args.rulePack ? { rulePack: args.rulePack } : {}
      });
    }
  }));
  register(defineTool({
    name: "browser_userscript_run",
    description: "Run an externally supplied Tampermonkey/UserScript-style script in a fresh Playwright context. Approval follows automationMode (skipped only in unrestricted); target @match, source/result caps, and no-GM_* validation always apply. " + COMPLIANCE_NOTICE + CDP_NOTICE,
    parameters: {
      url: { type: "string", required: true },
      source: { type: "string", required: true, description: "Complete userscript source. Validate first. Never embed credentials or tokens." },
      authProfile: { type: "string" },
      rulePack: { type: "string" },
      timeoutMs: { type: "number" }
    },
    output: { schema: SCRIPT_RESULT_SCHEMA, render: (_args, value) => renderScriptResult(value) },
    timeoutMs: 6e4,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      return service.runUserscript(args.url, args.source, {
        signal: exec.signal,
        ...args.timeoutMs !== void 0 ? { timeoutMs: args.timeoutMs } : {},
        ...args.authProfile ? { authProfile: args.authProfile } : {},
        ...args.rulePack ? { rulePack: args.rulePack } : {}
      });
    }
  }));
  register(defineTool({
    name: "browser_recipe_run",
    description: "Run a bounded Playwright recipe (max 25 named steps). Read-only steps run directly; mutating steps are denied in read-only, approved once in standard, and direct in autonomous/unrestricted. " + COMPLIANCE_NOTICE + CDP_NOTICE,
    parameters: {
      url: { type: "string", description: "Open this URL first; omit only when browser_open already established an active page." },
      authProfile: { type: "string" },
      rulePack: { type: "string" },
      waitMs: { type: "number" },
      steps: { type: "array", required: true, items: RECIPE_STEP_SCHEMA }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          url: { type: "string", required: true },
          title: { type: "string", required: true },
          text: { type: "string", required: true },
          screenshotPath: { type: "string" },
          steps: {
            type: "array",
            required: true,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                step: { type: "number", required: true },
                action: { type: "string", required: true },
                ok: { type: "boolean", required: true },
                value: { type: "string" }
              }
            }
          }
        }
      },
      render: (_args, value) => [{ type: "text", text: [
        `${value.title}
${value.url}`,
        ...value.steps.map((step) => `${step.step}. ${step.action}: ${step.ok ? "ok" : "failed"}${step.value ? "\n" + step.value : ""}`),
        value.text
      ].join("\n\n") }]
    },
    timeoutMs: 12e4,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const steps = args.steps;
      try {
        const result = await service.recipe(steps, {
          signal: exec.signal,
          ...args.url ? { url: args.url } : {},
          ...args.waitMs !== void 0 ? { waitMs: args.waitMs } : {},
          ...args.authProfile ? { authProfile: args.authProfile } : {},
          ...args.rulePack ? { rulePack: args.rulePack } : {}
        });
        assets?.recordRecipe(result.url, steps, sessionId(exec), true);
        return result;
      } catch (error) {
        if (args.url) assets?.recordRecipe(args.url, steps, sessionId(exec), false);
        throw error;
      }
    }
  }));
  register(defineTool({
    name: "browser_crawl",
    description: "Crawl a bounded set of HTTP(S) pages with the configured concurrency, burst, page/depth, retry, and cooldown budgets. This is read-only and remains buffered even in unrestricted/no-approval mode. " + COMPLIANCE_NOTICE + CDP_NOTICE,
    parameters: {
      startUrls: { type: "array", required: true, items: { type: "string" }, description: "One to five starting URLs." },
      maxPages: { type: "number", description: "Page budget, capped by usagePolicy.maxPagesPerRun." },
      maxDepth: { type: "number", description: "Link depth, capped by usagePolicy.maxDepth." },
      sameOrigin: { type: "boolean", description: "Only follow links on starting origins. Default true." },
      maxCharsPerPage: { type: "number", description: "Readable text cap per page, 1000-50000." }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          pages: { type: "array", required: true, items: { type: "object", additionalProperties: false, properties: {
            url: { type: "string", required: true },
            title: { type: "string", required: true },
            text: { type: "string", required: true },
            depth: { type: "number", required: true },
            status: { type: "number", required: true }
          } } },
          errors: { type: "array", required: true, items: { type: "object", additionalProperties: false, properties: {
            url: { type: "string", required: true },
            depth: { type: "number", required: true },
            error: { type: "string", required: true },
            status: { type: "number" }
          } } },
          stats: { type: "object", required: true, additionalProperties: false, properties: {
            pagesVisited: { type: "number", required: true },
            queued: { type: "number", required: true },
            elapsedMs: { type: "number", required: true },
            waitMs: { type: "number", required: true },
            backoffEvents: { type: "number", required: true }
          } },
          warnings: { type: "array", required: true, items: { type: "string" } }
        }
      },
      render: (_args, value) => [{ type: "text", text: [
        `crawl: ${value.stats.pagesVisited} visited, ${value.pages.length} pages, ${value.errors.length} errors, ${value.stats.waitMs}ms buffered`,
        ...value.warnings.map((warning) => "warning: " + warning),
        ...value.pages.map((page) => `
[depth ${page.depth}, HTTP ${page.status}] ${page.title}
${page.url}
${page.text}`),
        ...value.errors.map((error) => `
ERROR depth ${error.depth} ${error.url}: ${error.error}`)
      ].join("\n") }]
    },
    timeoutMs: 3e5,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      return service.crawl(args.startUrls, {
        signal: exec.signal,
        ...args.maxPages !== void 0 ? { maxPages: args.maxPages } : {},
        ...args.maxDepth !== void 0 ? { maxDepth: args.maxDepth } : {},
        ...args.sameOrigin !== void 0 ? { sameOrigin: args.sameOrigin } : {},
        ...args.maxCharsPerPage !== void 0 ? { maxCharsPerPage: args.maxCharsPerPage } : {}
      });
    }
  }));
  register(defineTool({
    name: "browser_opencli_status",
    description: "Run bundled OpenCLI doctor and return the real daemon, extension, profile, and Browser Bridge connectivity status.",
    parameters: {},
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          code: { type: "number", required: true },
          stdout: { type: "string", required: true },
          stderr: { type: "string", required: true },
          timedOut: { type: "boolean", required: true }
        }
      },
      render: (_args, value) => [{ type: "text", text: (value.stdout || value.stderr).slice(0, 2e4) }]
    },
    timeoutMs: 45e3,
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      return service.opencliDoctor(exec.signal);
    }
  }));
  register(defineTool({
    name: "browser_opencli_catalog",
    description: "Discover bundled OpenCLI adapters through a filtered, capped catalog. Use before browser_opencli_run to find exact command names, access class, strategy, and arguments without exposing the full catalog.",
    parameters: {
      query: { type: "string" },
      site: { type: "string" },
      access: { type: "string", enum: ["read", "write"] },
      strategy: { type: "string" },
      limit: { type: "number" }
    },
    output: {
      schema: { type: "array", items: { type: "object", additionalProperties: false, properties: {
        command: { type: "string", required: true },
        site: { type: "string", required: true },
        name: { type: "string", required: true },
        description: { type: "string", required: true },
        access: { type: "string", required: true },
        strategy: { type: "string", required: true },
        argsJson: { type: "string", required: true },
        example: { type: "string" },
        domain: { type: "string" }
      } } },
      render: (_args, value) => [{ type: "text", text: value.map((item) => `${item.command} [${item.access}/${item.strategy}]
${item.description}
args=${item.argsJson}${item.example ? "\nexample: " + item.example : ""}`).join("\n\n") }]
    },
    timeoutMs: 75e3,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const items = await service.opencliCatalog(args, exec.signal);
      return items.map(({ args: itemArgs, ...item }) => ({ ...item, argsJson: JSON.stringify(itemArgs) }));
    }
  }));
  register(defineTool({
    name: "browser_opencli_run",
    description: "Run any bundled OpenCLI adapter or browser-session command with verbatim argv. Approval is skipped only in unrestricted because commands may reuse logged-in Chrome state or perform writes. Prefer existing read-only search tools when available. " + COMPLIANCE_NOTICE + CDP_NOTICE,
    parameters: {
      args: { type: "array", required: true, items: { type: "string" }, description: 'Arguments after opencli, e.g. ["browser","work","state"] or ["reddit","search","dsh","-f","json"].' },
      profile: { type: "string", description: "Optional OpenCLI profile alias, passed as --profile." },
      timeoutMs: { type: "number" }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          code: { type: "number", required: true },
          stdout: { type: "string", required: true },
          stderr: { type: "string", required: true },
          timedOut: { type: "boolean", required: true }
        }
      },
      render: (_args, value) => [{ type: "text", text: `opencli exit=${value.code}${value.timedOut ? " (timeout)" : ""}
${(value.stdout || value.stderr).slice(0, 1e5)}` }]
    },
    timeoutMs: 18e4,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const argv = [...args.profile ? ["--profile", args.profile] : [], ...args.args];
      return service.opencli(argv, { timeoutMs: Math.min(Math.max(args.timeoutMs ?? 6e4, 1e3), 12e4), signal: exec.signal });
    }
  }));
}

// src/approval-policy.ts
var DIRECT_INTERACTIONS = /* @__PURE__ */ new Set(["browser_click", "browser_type", "browser_press", "browser_select", "browser_check", "browser_hover", "browser_scroll"]);
var WEB_LOCAL_MUTATIONS = /* @__PURE__ */ new Set(["web_cache_clear"]);
function browserPolicyDecision(name2, args, mode = "standard") {
  if (!isBrowserToolExposed(name2, mode) && name2.startsWith("browser_")) {
    return { kind: "deny", reason: `Browser tool ${name2} is disabled by automationMode=${mode}` };
  }
  if (DIRECT_INTERACTIONS.has(name2)) {
    if (mode === "read-only") return { kind: "deny", reason: `Page interaction is disabled by automationMode=${mode}` };
    if (mode === "standard") return { kind: "ask", reason: "Run a direct Playwright page interaction: " + name2 };
  }
  if (name2 === "browser_install") {
    if (mode === "read-only") return { kind: "deny", reason: `Browser installation is disabled by automationMode=${mode}` };
    if (mode === "unrestricted") return { kind: "allow" };
    return { kind: "ask", reason: "Install Playwright Chromium into the shared browser cache" };
  }
  if (name2 === "browser_set_files") {
    const files = Array.isArray(args?.files) ? args.files.filter((value) => typeof value === "string") : [];
    if (files.length === 0) return { kind: "deny", reason: "browser_set_files requires one or more absolute file paths" };
    if (mode === "read-only") return { kind: "deny", reason: `Local file upload is disabled by automationMode=${mode}` };
    if (mode === "unrestricted") return { kind: "allow" };
    return { kind: "ask", reason: "Read local files and expose them to the current website upload control: " + files.slice(0, 5).join(", ") };
  }
  if (name2 === "browser_evaluate") {
    const expression = args?.expression;
    if (typeof expression !== "string" || !expression.trim()) return { kind: "deny", reason: "browser_evaluate requires a JavaScript expression" };
    if (expression.length > 2e4) return { kind: "deny", reason: "browser_evaluate expression exceeds 20,000 characters" };
    if (mode === "read-only") return { kind: "deny", reason: `Page JavaScript execution is disabled by automationMode=${mode}` };
    if (mode === "unrestricted") return { kind: "allow" };
    return { kind: "ask", reason: "Run JavaScript with the current page origin and login state; it may access page storage, non-HttpOnly cookies, and browser-permitted network APIs" };
  }
  if (name2 === "browser_userscript_run") {
    const input = args;
    if (typeof input.source !== "string" || typeof input.url !== "string") return { kind: "deny", reason: "external userscript requires source and URL" };
    const validation = validateUserscript(input.source, input.url);
    if (!validation.valid) return { kind: "deny", reason: "invalid external userscript: " + validation.errors.join("; ") };
    if (mode === "read-only") return { kind: "deny", reason: `External userscripts are disabled by automationMode=${mode}` };
    if (mode === "unrestricted") return { kind: "allow" };
    const host = new URL(input.url).hostname;
    return {
      kind: "ask",
      reason: `Run external userscript "${validation.metadata.name}" (${validation.sha256.slice(0, 12)}) on ${host}; capabilities: ${validation.capabilities.join(", ")}`
    };
  }
  if (name2 === "browser_opencli_run") {
    const input = args;
    const argv = Array.isArray(input.args) ? input.args.filter((value) => typeof value === "string") : [];
    if (mode === "read-only") return { kind: "deny", reason: `General OpenCLI commands are disabled by automationMode=${mode}` };
    if (mode === "unrestricted") return { kind: "allow" };
    return { kind: "ask", reason: "Run a general OpenCLI command with the logged-in Chrome profile: " + (argv.slice(0, 3).join(" ") || "(empty)") };
  }
  if (name2 === "browser_recipe_run") {
    const input = args;
    const steps = Array.isArray(input.steps) ? input.steps : [];
    if (recipeNeedsApproval(steps)) {
      const actions = [...new Set(steps.map((step) => step.type).filter((type) => !["wait", "extract", "assert", "screenshot"].includes(type)))];
      if (mode === "read-only") return { kind: "deny", reason: `Mutating recipes are disabled by automationMode=${mode}: ` + actions.join(", ") };
      if (mode === "autonomous" || mode === "unrestricted") return { kind: "allow" };
      return { kind: "ask", reason: "Run a multi-step Playwright recipe with page mutations: " + actions.join(", ") };
    }
  }
  if (name2 === "browser_automation_run") {
    if (mode === "read-only") return { kind: "deny", reason: `Reusable automation execution is disabled by automationMode=${mode}` };
    if (mode === "autonomous" || mode === "unrestricted") return { kind: "allow" };
    return { kind: "ask", reason: "Run an active reusable browser automation asset" };
  }
  if (name2 === "browser_automation_develop") {
    const action = String(args?.action ?? "");
    if (["get", "validate"].includes(action)) return { kind: "allow" };
    if (mode === "read-only") return { kind: "deny", reason: `Automation draft writes are disabled by automationMode=${mode}` };
    if (action === "test" && mode !== "unrestricted") return { kind: "ask", reason: "Replay a reusable automation draft in a real browser context" };
    if (mode === "standard") return { kind: "ask", reason: "Save a bounded local reusable automation draft" };
    return { kind: "allow" };
  }
  if (name2 === "web_deps" && args?.action === "install") {
    if (mode === "read-only") return { kind: "deny", reason: `Dependency installation is disabled by automationMode=${mode}` };
    if (mode === "unrestricted") return { kind: "allow" };
    return { kind: "ask", reason: "Install an external Web Search Pro backend dependency" };
  }
  const webRuleAction = name2 === "web_rule" ? args?.action : void 0;
  if (WEB_LOCAL_MUTATIONS.has(name2) || name2 === "web_rule" && ["upsert", "remove", "import"].includes(String(webRuleAction))) {
    if (mode === "read-only") return { kind: "deny", reason: `Web Search Pro mutations are disabled by automationMode=${mode}` };
    if (mode === "standard") return { kind: "ask", reason: "Modify Web Search Pro local state: " + name2 };
  }
  return { kind: "allow" };
}

// src/automation-assets-rpc.ts
var CHANNEL = "/api";
var PREFIX = "dsh-browser-assets";
var ENDPOINTS = ["snapshot", "get", "save", "summarize", "dismiss", "validate", "test", "status"];
function failure(rpcId, message) {
  return Response.json({
    type: "server-response",
    rpcId,
    result: { ok: false, error: { code: "gateway/bad-request", message, details: {} } }
  });
}
function record(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("request payload must be an object");
  if (JSON.stringify(payload).length > 1e5) throw new Error("request payload exceeds 100000 characters");
  return payload;
}
function stringField2(payload, name2) {
  const value = payload[name2];
  if (typeof value !== "string" || value.length < 1 || value.length > 200) throw new Error(`${name2} must be a non-empty string`);
  return value;
}
function registerAutomationAssetRpc(ctx, store, service) {
  ctx.inject(["connection"], (connectionCtx) => {
    const connection = connectionCtx.connection;
    const handler = async (endpoint, rawPayload) => {
      try {
        const payload = record(rawPayload);
        let value;
        switch (endpoint) {
          case "snapshot":
            value = store.snapshot();
            break;
          case "get":
            value = store.get(stringField2(payload, "id")) ?? null;
            break;
          case "save":
            value = store.saveDraft(payload.asset);
            break;
          case "summarize":
            value = store.summarizeCandidate(stringField2(payload, "id"));
            break;
          case "dismiss":
            store.dismissCandidate(stringField2(payload, "id"));
            value = store.snapshot();
            break;
          case "validate":
            value = store.validate(stringField2(payload, "id"));
            break;
          case "test": {
            const result = await executeAutomationAsset(service, store, stringField2(payload, "id"), stringField2(payload, "url"), payload.inputs, "draft");
            value = result.asset;
            break;
          }
          case "status":
            value = store.setStatus(stringField2(payload, "id"), stringField2(payload, "status"));
            break;
          default:
            return { ok: false, error: { code: "not-found", message: `unknown automation asset endpoint: ${endpoint}`, details: {} } };
        }
        return { ok: true, value };
      } catch (error) {
        return { ok: false, error: { code: "bad-request", message: String(error instanceof Error ? error.message : error).slice(0, 500), details: {} } };
      }
    };
    for (const endpoint of ENDPOINTS) {
      const method = `${PREFIX}/${endpoint}`;
      connectionCtx.effect(() => connection.fetch.register({
        path: `${CHANNEL}/${method}`,
        methods: ["POST"],
        requestBody: "buffered",
        fetch: async (request) => {
          let body;
          try {
            body = await request.json();
          } catch {
            return new Response("body is not JSON", { status: 400 });
          }
          const rpcId = typeof body === "object" && body !== null && typeof body.rpcId === "string" ? body.rpcId : "invalid-request";
          if (typeof body !== "object" || body === null || body.type !== "client-request" || body.method !== method) {
            return failure(rpcId, "invalid RPC request");
          }
          try {
            const result = await handler(endpoint, body.payload, request.signal);
            return Response.json({ type: "server-response", rpcId, result });
          } catch (error) {
            return failure(rpcId, String(error instanceof Error ? error.message : error).slice(0, 500));
          }
        }
      }), `dsh-browser: ${method} RPC route`);
    }
  });
}

// src/index.ts
var name = "dsh-browser";
var inject = ["tools", "settings"];
function apply(ctx, config) {
  const deployed = resolveConfig(config);
  const settings = ctx.settings;
  const scope = settings.register("browser", Config, {
    base: deployed,
    // Browser processes, tool exposure, and approval hooks are deliberately
    // startup-scoped. The next full profile start reads the persisted layer.
    applies: "restart"
  });
  const resolved = resolveConfig(scope.get());
  fs6.mkdirSync(resolved.snapshotDir, { recursive: true });
  const service = new BrowserService(resolved);
  const assets = new AutomationAssetStore(resolved.automationAssets);
  ctx.on("tools/pre-execute", async (exec, next) => {
    const downstream = await next();
    if (downstream.kind !== "allow") return downstream;
    return browserPolicyDecision(exec.name, exec.arguments, resolved.automationMode);
  });
  ctx.provide("browser", service);
  ctx.effect(() => () => void service.close());
  registerTools(ctx, resolved, service, assets);
  registerAutomationAssetRpc(ctx, assets, service);
  if (resolved.verbose) {
    try {
      const markerPath = path5.join(resolved.snapshotDir, "apply.log");
      fs6.appendFileSync(markerPath, JSON.stringify({
        ts: (/* @__PURE__ */ new Date()).toISOString(),
        plugin: name,
        channel: resolved.channel,
        headless: resolved.headless,
        opencliEnabled: resolved.opencliEnabled,
        automationMode: resolved.automationMode,
        snapshotDir: resolved.snapshotDir
      }) + "\n", "utf8");
    } catch {
    }
  }
  ctx.logger?.(name).info("dsh-browser loaded: channel=" + resolved.channel + " headless=" + resolved.headless + " cdp=" + (resolved.cdpEndpoint || "none") + " opencli=" + resolved.opencliEnabled + " automation=" + resolved.automationMode);
}
export {
  ALL_BROWSER_TOOL_NAMES,
  ASSET_ACTIVATION_MODES,
  ASSET_PERSISTENCE_MODES,
  AUTOMATION_MODES,
  AutomationAssetStore,
  BUILTIN_SCRIPTS,
  Config,
  apply,
  browserToolsForMode,
  configuredBrowserTools,
  inject,
  name,
  resolveAutomationAssetPolicy,
  validateUserscript
};
