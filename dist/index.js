/*
 * dsh-tauri-monitor — DSH Desktop 监控插件
 *
 * 通用 HTTP 轮询规则引擎：按规则定时轮询接口 → JS 表达式判定事件 → 命中才唤醒
 * 新的可视会话执行任务（仿 dsh-tauri-scheduler 的无主会话 executor，复用其代码模式）。
 * 未命中周期零 LLM 交互，不浪费 token。
 *
 * 存储：~/.dsh/monitors/{rules,runs,state}.json（writeAtomic 原子写）
 * 路由：/api/tauri/monitor/*（guard 保护）
 * 工具：monitor_rule_create / list / update / delete / test / fire
 */

import { defineWebServer } from "dsh-h3";
import { getServerContext } from "dsh-h3/utils";
import { DSH_HOME, guard, writeAtomic } from "dsh-tauri";
import { defineEventHandler, getQuery, readBody } from "h3";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { join } from "pathe";
import process from "node:process";

const PLUGIN_ID = "dsh-tauri-monitor";
const TICK_MS = 1000;
const MAX_FIRED_KEYS = 200;
const MAX_RUNS = 200;
const PERMISSIONS = ["read-only", "workspace-write", "danger-full-access"];

// ---------------------------------------------------------------------------
// 模块运行态
// ---------------------------------------------------------------------------

const runtime = {
  rules: [],
  states: {},
  runs: [],
  polling: new Set(),
  running: new Set(),
  timer: null,
  stopping: false,
  loadedAt: 0,
};

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function trim(value, cap = 4000) {
  let text;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    text = String(value);
  }
  if (text === undefined) return undefined;
  return text.length > cap ? `${text.slice(0, cap)}…` : text;
}

function capability(ctx, name) {
  try {
    if (typeof ctx?.get === "function") {
      const value = ctx.get(name);
      if (value !== undefined && value !== null) return value;
    }
  } catch {}
  return ctx?.[name];
}

function log(...args) {
  console.log(`[${PLUGIN_ID}]`, ...args);
}

function warn(...args) {
  console.warn(`[${PLUGIN_ID}]`, ...args);
}

/** macOS 通知（非阻断，失败只记日志） */
function notify(message) {
  return new Promise((resolve) => {
    const safe = String(message).replace(/["\\\n\r]/g, " ");
    execFile(
      "/usr/bin/osascript",
      ["-e", `display notification "${safe}" with title "DSH 监控"`],
      { timeout: 5000 },
      (error) => {
        if (error) warn(`notify failed: ${error.message}`);
        resolve();
      },
    );
  });
}

// ---------------------------------------------------------------------------
// 存储（原子写 + 串行队列）
// ---------------------------------------------------------------------------

const STORE_DIR = join(DSH_HOME, "monitors");
const FILES = {
  rules: join(STORE_DIR, "rules.json"),
  runs: join(STORE_DIR, "runs.json"),
  state: join(STORE_DIR, "state.json"),
};

async function readJson(file, fallback) {
  try {
    const value = JSON.parse(await readFile(file, "utf8"));
    return value === null || value === undefined ? fallback : value;
  } catch {
    return fallback;
  }
}

let writeChain = Promise.resolve();
function queuedWrite(file, value) {
  const task = writeChain.then(async () => {
    await mkdir(STORE_DIR, { recursive: true });
    await writeAtomic(file, JSON.stringify(value, null, "\t"));
  });
  writeChain = task.then(
    () => {},
    () => {},
  );
  return task;
}

const saveRules = () => queuedWrite(FILES.rules, runtime.rules);
const saveRuns = () => queuedWrite(FILES.runs, runtime.runs);
const saveState = () => queuedWrite(FILES.state, runtime.states);

function newState() {
  return {
    vars: undefined,
    firedKeys: [],
    lastEvents: [],
    lastPollAt: 0,
    lastError: null,
    consecutiveFailures: 0,
    lastErrNotifyAt: 0,
    lastFireAt: 0,
    fireCount: 0,
  };
}

function ensureState(ruleId) {
  if (!runtime.states[ruleId]) runtime.states[ruleId] = newState();
  return runtime.states[ruleId];
}

function pushKey(keys, key) {
  const index = keys.indexOf(key);
  if (index >= 0) keys.splice(index, 1);
  keys.push(key);
  if (keys.length > MAX_FIRED_KEYS) keys.splice(0, keys.length - MAX_FIRED_KEYS);
}

// ---------------------------------------------------------------------------
// 表达式引擎（new Function 非严格体，允许 with）
// ---------------------------------------------------------------------------

const exprCache = new Map();

function compileExpr(expr) {
  return new Function("ctx", `with (ctx) { return (${expr}); }`);
}

function evalExpr(expr, context) {
  let fn = exprCache.get(expr);
  if (!fn) {
    fn = compileExpr(expr);
    if (exprCache.size > 100) exprCache.clear();
    exprCache.set(expr, fn);
  }
  return fn(context);
}

function renderUrl(template, vars) {
  return template.replace(/\{([A-Za-z_$][\w$]*)\}/g, (match, name) =>
    name in vars ? encodeURIComponent(String(vars[name])) : match,
  );
}

// ---------------------------------------------------------------------------
// 规则校验与归一化
// ---------------------------------------------------------------------------

function validateRule(input) {
  const errors = [];
  if (!isPlainObject(input)) return { ok: false, errors: ["规则必须是对象"] };

  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) errors.push("name 必填");

  const poll = isPlainObject(input.poll) ? input.poll : {};
  const intervalSec = clampInt(poll.intervalSec, 10, 86400, 180);
  const stepsIn = Array.isArray(poll.steps) ? poll.steps : [];
  if (stepsIn.length === 0) errors.push("poll.steps 至少一步");
  if (stepsIn.length > 10) errors.push("poll.steps 最多 10 步");

  const steps = stepsIn.map((step, index) => {
    if (typeof step?.url !== "string" || !/^https?:\/\//i.test(step.url)) {
      errors.push(`poll.steps[${index}].url 必须是 http(s) 地址`);
    }
    const extract = isPlainObject(step.extract) ? step.extract : {};
    for (const [key, expr] of Object.entries(extract)) {
      if (typeof expr !== "string") {
        errors.push(`poll.steps[${index}].extract.${key} 必须是字符串表达式`);
        continue;
      }
      try {
        compileExpr(expr);
      } catch (error) {
        errors.push(`poll.steps[${index}].extract.${key} 语法错误: ${error.message}`);
      }
    }
    const method = String(step.method || "GET").toUpperCase();
    return {
      name: typeof step.name === "string" && step.name ? step.name : `step${index + 1}`,
      url: step.url,
      method,
      headers: isPlainObject(step.headers) ? step.headers : {},
      body: step.body,
      extract,
      timeoutMs: clampInt(step.timeoutMs, 1000, 60000, 15000),
    };
  });

  const eventsExpr = typeof input.events === "string" ? input.events.trim() : "";
  if (!eventsExpr) {
    errors.push("events 表达式必填");
  } else {
    try {
      compileExpr(eventsExpr);
    } catch (error) {
      errors.push(`events 表达式语法错误: ${error.message}`);
    }
  }

  const actionIn = isPlainObject(input.action) ? input.action : {};
  const prompt = typeof actionIn.prompt === "string" ? actionIn.prompt : "";

  const rule = {
    id: typeof input.id === "string" && input.id ? input.id : `rule-${randomUUID()}`,
    name,
    enabled: input.enabled === undefined ? true : Boolean(input.enabled),
    createdAt: typeof input.createdAt === "string" ? input.createdAt : new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    poll: { intervalSec, steps },
    events: eventsExpr,
    action: {
      prompt,
      workspaceId: typeof actionIn.workspaceId === "string" && actionIn.workspaceId ? actionIn.workspaceId : undefined,
      permission: PERMISSIONS.includes(actionIn.permission) ? actionIn.permission : "workspace-write",
      provider: typeof actionIn.provider === "string" && actionIn.provider ? actionIn.provider : undefined,
      model: typeof actionIn.model === "string" && actionIn.model ? actionIn.model : undefined,
      reasoningEffort:
        typeof actionIn.reasoningEffort === "string" && actionIn.reasoningEffort ? actionIn.reasoningEffort : undefined,
      timeoutSec: clampInt(actionIn.timeoutSec, 60, 86400, 1800),
      notify: actionIn.notify === undefined ? true : Boolean(actionIn.notify),
    },
  };

  return errors.length ? { ok: false, errors } : { ok: true, rule };
}

// ---------------------------------------------------------------------------
// 轮询引擎
// ---------------------------------------------------------------------------

async function runStep(step, vars) {
  const url = renderUrl(step.url, vars);
  const headers = { ...step.headers };
  const init = { method: step.method, headers, signal: AbortSignal.timeout(step.timeoutMs) };
  if (step.body !== undefined && step.method !== "GET" && step.method !== "HEAD") {
    init.body = typeof step.body === "string" ? step.body : JSON.stringify(step.body);
    const hasContentType = Object.keys(headers).some((key) => key.toLowerCase() === "content-type");
    if (!hasContentType) headers["Content-Type"] = "application/json";
  }
  let response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    throw new Error(`请求失败 ${step.name}: ${error?.message || error}`);
  }
  if (!response.ok) throw new Error(`HTTP ${response.status} ${step.name}`);
  const text = await response.text();
  let res;
  try {
    res = JSON.parse(text);
  } catch {
    throw new Error(`${step.name} 响应非 JSON: ${text.slice(0, 120)}`);
  }
  for (const [name, expr] of Object.entries(step.extract || {})) {
    vars[name] = evalExpr(expr, { res, vars });
  }
  return vars;
}

function normalizeEvents(raw) {
  if (raw === null || raw === undefined || raw === false) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  const events = [];
  for (const item of list) {
    if (item === null || item === undefined || item === false) continue;
    if (typeof item === "string" || typeof item === "number") {
      events.push({ key: String(item), title: String(item), detail: undefined });
      continue;
    }
    if (!isPlainObject(item)) continue;
    const key = String(item.key ?? item.id ?? "").trim();
    if (!key) throw new Error("事件对象缺少非空 key");
    events.push({ key, title: String(item.title ?? key), detail: item.detail });
  }
  return events;
}

/** 轮询一条规则；dry=true 只探测不落状态 */
async function pollRule(rule, { dry = false } = {}) {
  const state = runtime.states[rule.id] || newState();
  const vars = {};
  for (const step of rule.poll.steps) await runStep(step, vars);
  const events = normalizeEvents(evalExpr(rule.events, { vars, prev: state.vars, rule }));
  const firedKeys = state.firedKeys || [];
  const newEvents = events.filter((event) => !firedKeys.includes(event.key));
  if (!dry) {
    state.vars = vars;
    state.lastPollAt = Date.now();
    state.lastError = null;
    state.consecutiveFailures = 0;
    state.lastEvents = events.map((event) => event.key);
    runtime.states[rule.id] = state;
    await saveState();
  }
  return { vars, events, newEvents };
}

async function recordPollFailure(rule, error) {
  const state = ensureState(rule.id);
  state.lastError = { message: String(error?.message || error), at: new Date().toISOString() };
  state.consecutiveFailures = (state.consecutiveFailures || 0) + 1;
  const now = Date.now();
  const shouldNotify =
    state.consecutiveFailures >= 3 && now - (state.lastErrNotifyAt || 0) > 60 * 60 * 1000;
  if (shouldNotify) state.lastErrNotifyAt = now;
  warn(`poll failed [${rule.name}]: ${state.lastError.message}`);
  await saveState();
  if (shouldNotify) await notify(`监控「${rule.name}」连续失败 ${state.consecutiveFailures} 次: ${state.lastError.message}`);
}

async function pollAndFire(rule) {
  let result;
  try {
    result = await pollRule(rule);
  } catch (error) {
    await recordPollFailure(rule, error);
    return;
  }
  if (result.newEvents.length > 0) await fire(rule, result.newEvents, { source: "engine" });
}

function startEngine() {
  if (runtime.timer) clearInterval(runtime.timer);
  runtime.stopping = false;
  runtime.timer = setInterval(() => {
    tick().catch((error) => warn(`tick error: ${error?.message || error}`));
  }, TICK_MS);
  return () => {
    runtime.stopping = true;
    clearInterval(runtime.timer);
    runtime.timer = null;
  };
}

async function tick() {
  if (runtime.stopping) return;
  const now = Date.now();
  for (const rule of runtime.rules) {
    if (!rule.enabled || runtime.polling.has(rule.id)) continue;
    const state = runtime.states[rule.id] || {};
    const dueAt = Math.max(Number(state.lastPollAt) || 0, runtime.loadedAt) + rule.poll.intervalSec * 1000;
    if (now < dueAt) continue;
    runtime.polling.add(rule.id);
    Promise.resolve(pollAndFire(rule))
      .catch(() => {})
      .finally(() => runtime.polling.delete(rule.id));
  }
}

// ---------------------------------------------------------------------------
// 无主会话 executor（仿 dsh-tauri-scheduler）
// ---------------------------------------------------------------------------

function resolveRuntimeExport(mods, name) {
  for (const mod of mods) {
    if (mod && typeof mod[name] === "function") return mod[name];
    if (mod && mod.default && typeof mod.default[name] === "function") return mod.default[name];
    if (mod && typeof mod.unwrapExports === "function") {
      try {
        const unwrapped = mod.unwrapExports();
        if (unwrapped && typeof unwrapped[name] === "function") return unwrapped[name];
      } catch {}
    }
  }
  return undefined;
}

async function loadRuntimeModules(loader) {
  const ids = ["@deepseek-ai/dsh-agent", "@deepseek-ai/dsh-llm", "@deepseek-ai/dsh-user-approval"];
  const mods = await Promise.all(
    ids.map(async (id) => {
      try {
        return await loader.import(id);
      } catch {
        return undefined;
      }
    }),
  );
  const modules = {
    installModelSelection: resolveRuntimeExport(mods, "installModelSelection"),
    createUserMessage: resolveRuntimeExport(mods, "createUserMessage"),
    setApprovalPolicy: resolveRuntimeExport(mods, "setApprovalPolicy"),
  };
  if (!modules.createUserMessage) throw new Error("dsh-agent 运行时缺少 createUserMessage");
  return modules;
}

function applyUnattendedPermission(ctx, modules, session, permission) {
  const presets = capability(ctx, "permissionPresets");
  try {
    presets?.set?.(session, permission);
  } catch {}
  try {
    modules.setApprovalPolicy?.(session, "never");
  } catch {}
}

function createAgent(ctx, modules, options) {
  const { sessionId, cwd, agentPreset, selection, permission } = options;
  return ctx.agents.withoutInitiator(() =>
    ctx.agents.create({
      sessionId,
      meta: { cwd, agentPreset },
      ...(selection?.provider && selection?.model
        ? {
            agentOptions: {
              provider: selection.provider,
              model: selection.model,
              ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
            },
          }
        : {}),
      setup: (agentCtx, createdAgent) => {
        try {
          capability(ctx, "agentPresets")?.mount?.(agentCtx, agentPreset);
        } catch {}
        try {
          modules.installModelSelection?.(agentCtx, { current: selection });
        } catch {}
        applyUnattendedPermission(ctx, modules, createdAgent.agent.session, permission);
      },
    }),
  );
}

async function resolveWorkspace(ctx, action) {
  if (!action?.workspaceId) return { ok: true, cwd: join(DSH_HOME, "monitors"), workspace: undefined };
  const registry = capability(ctx, "workspaceRegistry");
  const workspace = registry?.get ? registry.get(action.workspaceId) : undefined;
  if (!workspace) return { ok: false, error: `工作区不存在: ${action.workspaceId}` };
  const path = typeof workspace.path === "function" ? await workspace.path() : workspace.path;
  if (!path) return { ok: false, error: "工作区路径不可用" };
  return { ok: true, cwd: path, workspace };
}

function defaultSelection(ctx) {
  try {
    const current = capability(ctx, "agentDefaultModel")?.currentSelection?.();
    if (!current?.provider || !current?.model) return undefined;
    return {
      provider: current.provider,
      model: current.model,
      ...(current.reasoningEffort ? { reasoningEffort: current.reasoningEffort } : {}),
    };
  } catch {
    return undefined;
  }
}

function pinTitle(ctx, session, name) {
  try {
    capability(ctx, "sessionTitle")?.rename?.(session, name);
  } catch {}
}

// --- 会话事件观察 -----------------------------------------------------------

function eventTurn(event) {
  return event?.turn ?? event?.event?.turn;
}

function eventType(event) {
  return String(event?.type ?? event?.event?.type ?? "");
}

function isTurnStart(event) {
  return eventTurn(event) === "start" || eventType(event).endsWith("turn/start");
}

function isTurnEnd(event) {
  return eventTurn(event) === "end" || eventType(event).endsWith("turn/end");
}

function messageText(event) {
  const message = event?.message ?? event?.event?.message;
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .map((part) => (typeof part === "string" ? part : part?.type === "text" ? part.text || "" : ""))
      .join("");
  }
  return "";
}

function reasonOf(event) {
  return event?.reason ?? event?.event?.reason ?? {};
}

function sessionSnapshotEvents(session, afterSeq = 0) {
  let events = [];
  try {
    events = session?.snapshotEvents?.() ?? session?.log?.events ?? session?.events ?? [];
  } catch {
    events = [];
  }
  if (!Array.isArray(events)) return [];
  if (!afterSeq) return events;
  return events.filter((event) => {
    const seq = event?.seq;
    return typeof seq !== "number" || seq > afterSeq;
  });
}

function watchSessionEvents(ctx, session, firstSeq) {
  const collected = [];
  let latestReason = { kind: undefined };
  const off = ctx?.on?.("session/event", (payload) => {
    try {
      const event = payload?.event ?? payload;
      const sessionId = payload?.sessionId ?? event?.sessionId ?? event?.session?.id;
      if (sessionId && session && sessionId !== session.sessionId) return;
      const seq = event?.seq;
      if (typeof seq === "number" && seq <= firstSeq) return;
      if (isTurnStart(event) || isTurnEnd(event) || eventType(event).includes("assistant/message")) {
        collected.push(event);
        if (isTurnEnd(event)) latestReason = reasonOf(event);
      }
    } catch {}
  });
  return {
    collected,
    get reason() {
      return latestReason;
    },
    stop() {
      try {
        off?.();
      } catch {}
    },
  };
}

async function waitForTurnStart(session, watcher, firstSeq, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (watcher.collected.some(isTurnStart)) return true;
    if (sessionSnapshotEvents(session, firstSeq).some(isTurnStart)) return true;
    await sleep(10);
  }
  return false;
}

function summarizeEvents(events) {
  const texts = [];
  for (const event of events) {
    if (eventType(event).includes("assistant/message")) {
      const text = messageText(event).trim();
      if (text) texts.push(text);
    }
  }
  const joined = texts.join("\n").replace(/\s+\n/g, "\n").trim();
  return joined ? (joined.length > 1600 ? `${joined.slice(0, 1600)}…` : joined) : "(无输出)";
}

function decideRunOutcome({ started, timedOut, reason }) {
  if (!started) return "failed";
  if (timedOut) return "timed_out";
  if (reason?.kind === "completed") return "succeeded";
  return "failed";
}

function describeFailure(timedOut, reason) {
  if (timedOut) return "执行超时，已中断会话";
  const kind = reason?.kind || "unknown";
  const detail = reason?.message || reason?.description || "";
  return detail ? `${kind}: ${detail}` : kind;
}

function isPluginUnloadError(error) {
  return error?.code === "INACTIVE_EFFECT" || String(error?.message || "").includes("INACTIVE_EFFECT");
}

// --- prompt 渲染 ------------------------------------------------------------

const DEFAULT_PROMPT = [
  "你是被监控插件唤醒的 agent（规则: {{ruleName}}，时间: {{time}}）。",
  "",
  "以下监控事件命中，需要处理：",
  "{{eventsText}}",
  "",
  "处理要求：",
  "1. 阅读事件明细，结合所在工作区的仓库规范分析问题；",
  "2. 采取必要的处理动作（查证、修改文件等），不越权（严禁任何提交/推送类操作）；",
  "3. 完成后输出汇总：每个事件的结论、改动文件清单、后续建议，停下等待用户 review。",
  "",
  "事件明细 JSON：",
  "{{events}}",
].join("\n");

function renderPrompt(rule, events) {
  const eventsText = events.map((event) => `- ${event.title} [${event.key}]`).join("\n");
  return (rule.action.prompt && rule.action.prompt.trim() ? rule.action.prompt : DEFAULT_PROMPT)
    .replaceAll("{{ruleName}}", rule.name)
    .replaceAll("{{eventsText}}", eventsText)
    .replaceAll("{{events}}", JSON.stringify(events, null, 2))
    .replaceAll("{{time}}", new Date().toISOString());
}

// --- run 记账 ---------------------------------------------------------------

async function saveRun(run) {
  const index = runtime.runs.findIndex((item) => item.id === run.id);
  if (index >= 0) runtime.runs[index] = run;
  else runtime.runs.unshift(run);
  runtime.runs.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  if (runtime.runs.length > MAX_RUNS) runtime.runs.length = MAX_RUNS;
  await saveRuns();
}

async function settle(run, status, outcome) {
  const finished = { ...run, status, finishedAt: new Date().toISOString() };
  await saveRun(finished);
  if (status === "failed" || status === "timed_out") {
    warn(`run ${run.id} [${run.ruleName}] ${status}: ${outcome?.error || ""}`);
  }
  return outcome;
}

// --- executor ---------------------------------------------------------------

const executor = {
  async run(ctx, rule, events, source) {
    const runId = `run-${randomUUID()}`;
    const sessionId = `monitor-${randomUUID()}`;
    const run = {
      id: runId,
      ruleId: rule.id,
      ruleName: rule.name,
      events,
      status: "running",
      startedAt: new Date().toISOString(),
      sessionId,
      source: source || "engine",
    };
    await saveRun(run);
    log(`run start [${rule.name}] events=${events.length} session=${sessionId}`);

    let watcher;
    try {
      const modules = await loadRuntimeModules(ctx.loader);
      const resolved = await resolveWorkspace(ctx, rule.action);
      if (!resolved.ok) {
        return await settle(run, "failed", { ok: false, started: false, sessionId, error: resolved.error });
      }
      const selection =
        rule.action.provider && rule.action.model
          ? {
              provider: rule.action.provider,
              model: rule.action.model,
              ...(rule.action.reasoningEffort ? { reasoningEffort: rule.action.reasoningEffort } : {}),
            }
          : defaultSelection(ctx);
      const handle = await createAgent(ctx, modules, {
        sessionId,
        cwd: resolved.cwd,
        agentPreset: "standard",
        selection,
        permission: rule.action.permission,
      });
      await handle.agent.whenIdle();
      try {
        await resolved.workspace?.attachSession?.(sessionId);
      } catch {}
      pinTitle(ctx, handle.agent.session, `监控·${rule.name}`);

      const firstSeq = Number(handle.agent.session?.seq) || 0;
      watcher = watchSessionEvents(ctx, handle.agent.session, firstSeq);

      let message;
      const text = renderPrompt(rule, events);
      try {
        message = modules.createUserMessage({
          content: [{ type: "text", text }],
          source: { kind: "monitor", ruleId: rule.id, runId },
        });
      } catch {
        message = modules.createUserMessage({ content: [{ type: "text", text }] });
      }
      handle.agent.followup(message);

      const started = await waitForTurnStart(handle.agent.session, watcher, firstSeq);
      if (!started) {
        watcher.stop();
        try {
          await handle.agent.cancel({ kind: "hook", reason: "monitor-turn-never-started" });
        } catch {}
        return await settle(run, "failed", {
          ok: false,
          started: false,
          sessionId,
          error: "会话轮次未能启动",
        });
      }

      let timedOut = false;
      let cancelTimer = null;
      try {
        await Promise.race([
          handle.agent.whenIdle(),
          new Promise((resolve) => {
            cancelTimer = setTimeout(() => {
              timedOut = true;
              try {
                handle.agent.cancel({ kind: "hook", reason: "monitor-run-timeout" });
              } catch {}
              resolve();
            }, rule.action.timeoutSec * 1000);
          }),
        ]);
      } finally {
        if (cancelTimer) clearTimeout(cancelTimer);
      }
      if (timedOut) {
        await Promise.race([handle.agent.whenIdle().catch(() => {}), sleep(15000)]);
      }

      try {
        await capability(ctx, "sessions")?.flush?.();
      } catch {}
      await sleep(200);

      const eventsView = [...watcher.collected, ...sessionSnapshotEvents(handle.agent.session, firstSeq)];
      const summary = summarizeEvents(eventsView);
      const status = decideRunOutcome({ started: true, timedOut, reason: watcher.reason });
      watcher.stop();
      const result = await settle(run, status, {
        ok: status === "succeeded",
        started: true,
        sessionId,
        summary,
        error: status === "succeeded" ? undefined : describeFailure(timedOut, watcher.reason),
      });
      log(`run end [${rule.name}] status=${status} session=${sessionId}`);
      if (status === "succeeded" && rule.action.notify !== false) {
        await notify(`监控「${rule.name}」任务完成，可到会话列表查看`);
      } else if (status !== "succeeded" && rule.action.notify !== false) {
        await notify(`监控「${rule.name}」任务${status === "timed_out" ? "超时" : "失败"}: ${result.error || ""}`);
      }
      return result;
    } catch (error) {
      watcher?.stop();
      if (isPluginUnloadError(error)) {
        warn(`run ${run.id} interrupted by plugin unload`);
        return { ok: false, started: true, sessionId, error: "host_interrupted" };
      }
      const message = String(error?.message || error);
      warn(`run ${run.id} error: ${message}`);
      return await settle(run, "failed", { ok: false, started: true, sessionId, error: message });
    }
  },
};

// ---------------------------------------------------------------------------
// 触发
// ---------------------------------------------------------------------------

async function fire(rule, events, { source = "engine" } = {}) {
  const ctx = getServerContext(server);
  if (runtime.running.has(rule.id)) {
    return { ok: false, started: false, error: "该规则已有任务在执行" };
  }
  runtime.running.add(rule.id);
  let outcome;
  try {
    if (rule.action.notify !== false) {
      await notify(`监控「${rule.name}」命中 ${events.length} 个事件，唤醒 agent…`);
    }
    outcome = await executor.run(ctx, rule, events, source);
  } finally {
    runtime.running.delete(rule.id);
  }
  if (outcome?.ok && outcome.started) {
    const state = ensureState(rule.id);
    for (const event of events) pushKey(state.firedKeys, event.key);
    state.fireCount = (state.fireCount || 0) + 1;
    state.lastFireAt = Date.now();
    await saveState();
  }
  return outcome;
}

// ---------------------------------------------------------------------------
// 规则服务
// ---------------------------------------------------------------------------

async function createRule(input) {
  const validated = validateRule(input);
  if (!validated.ok) return { ok: false, errors: validated.errors };
  runtime.rules.push(validated.rule);
  await saveRules();
  log(`rule created [${validated.rule.name}] id=${validated.rule.id}`);
  return { ok: true, rule: validated.rule };
}

async function updateRule(id, patch) {
  const index = runtime.rules.findIndex((rule) => rule.id === id);
  if (index < 0) return { ok: false, errors: [`规则不存在: ${id}`] };
  const merged = { ...runtime.rules[index], ...patch, id, createdAt: runtime.rules[index].createdAt };
  const validated = validateRule(merged);
  if (!validated.ok) return { ok: false, errors: validated.errors };
  runtime.rules[index] = validated.rule;
  await saveRules();
  log(`rule updated [${validated.rule.name}] id=${id}`);
  return { ok: true, rule: validated.rule };
}

async function deleteRule(id) {
  const index = runtime.rules.findIndex((rule) => rule.id === id);
  if (index < 0) return { ok: false, errors: [`规则不存在: ${id}`] };
  const [removed] = runtime.rules.splice(index, 1);
  delete runtime.states[id];
  await saveRules();
  await saveState();
  log(`rule deleted [${removed.name}] id=${id}`);
  return { ok: true, rule: removed };
}

function enrichRules() {
  return runtime.rules.map((rule) => {
    const state = runtime.states[rule.id] || {};
    return {
      ...rule,
      status: {
        running: runtime.running.has(rule.id),
        polling: runtime.polling.has(rule.id),
        lastPollAt: state.lastPollAt || undefined,
        lastError: state.lastError || undefined,
        consecutiveFailures: state.consecutiveFailures || 0,
        lastFireAt: state.lastFireAt || undefined,
        fireCount: state.fireCount || 0,
      },
    };
  });
}

async function listRuns({ limit = 20, offset = 0, ruleId } = {}) {
  let runs = runtime.runs;
  if (ruleId) runs = runs.filter((run) => run.ruleId === ruleId);
  const boundedLimit = clampInt(limit, 1, 100, 20);
  return {
    total: runs.length,
    runs: runs.slice(offset, offset + boundedLimit).map((run) => ({
      ...run,
      events: run.events?.map((event) => ({ key: event.key, title: event.title })),
      summary: run.status === "running" ? undefined : trim(run.summary, 600),
    })),
  };
}

// ---------------------------------------------------------------------------
// options 收集
// ---------------------------------------------------------------------------

async function collectOptions(ctx) {
  const workspaces = [];
  try {
    const registry = capability(ctx, "workspaceRegistry");
    const list = await registry?.list?.();
    for (const workspace of list || []) {
      const path = typeof workspace.path === "function" ? await workspace.path() : workspace.path;
      workspaces.push({ id: workspace.id, path, title: workspace.title });
    }
  } catch {}

  const permissions = PERMISSIONS.map((value) => ({ value, name: value }));
  let defaultPermission = "workspace-write";
  try {
    const presets = capability(ctx, "permissionPresets");
    defaultPermission = presets?.defaultPreset?.() ?? defaultPermission;
  } catch {}

  let models = [];
  let defaultModel;
  try {
    const llm = capability(ctx, "llm");
    const selection = capability(ctx, "agentDefaultModel")?.currentSelection?.();
    if (selection) defaultModel = { provider: selection.provider, model: selection.model };
    if (llm?.listProviders) {
      for (const provider of await llm.listProviders()) {
        const providerId = typeof provider === "string" ? provider : provider.id ?? provider.name;
        if (!providerId) continue;
        for (const model of (await llm.listModels(providerId)) || []) {
          const modelId = typeof model === "string" ? model : model.id ?? model.name;
          if (!modelId) continue;
          const label =
            typeof model === "string" ? model : model.label ?? model.displayName ?? String(modelId);
          const efforts =
            typeof model === "object" && Array.isArray(model.reasoning?.efforts)
              ? model.reasoning.efforts
              : undefined;
          models.push({ provider: providerId, model: modelId, label, ...(efforts ? { reasoning: { efforts } } : {}) });
        }
      }
      models = models.slice(0, 200);
    }
  } catch {}

  return { workspaces, permissions, defaultPermission, models, defaultModel };
}

// ---------------------------------------------------------------------------
// Web 路由
// ---------------------------------------------------------------------------

const server = defineWebServer((app) => {
  app.use(guard);

  app.get(
    "/api/tauri/monitor/rules",
    defineEventHandler(() => ({ rules: enrichRules() })),
  );

  app.post(
    "/api/tauri/monitor/rules",
    defineEventHandler(async (event) => {
      const body = await readBody(event);
      const result = await createRule(body || {});
      if (!result.ok) return { ok: false, errors: result.errors };
      return { ok: true, rule: result.rule };
    }),
  );

  app.put(
    "/api/tauri/monitor/rules",
    defineEventHandler(async (event) => {
      const body = await readBody(event);
      if (!body?.id) return { ok: false, errors: ["id 必填"] };
      const { id, ...patch } = body;
      const result = await updateRule(id, patch);
      if (!result.ok) return { ok: false, errors: result.errors };
      return { ok: true, rule: result.rule };
    }),
  );

  app.delete(
    "/api/tauri/monitor/rules",
    defineEventHandler(async (event) => {
      const query = getQuery(event);
      if (!query.id) return { ok: false, errors: ["id 必填"] };
      const result = await deleteRule(String(query.id));
      if (!result.ok) return { ok: false, errors: result.errors };
      return { ok: true, rule: result.rule };
    }),
  );

  app.post(
    "/api/tauri/monitor/toggle",
    defineEventHandler(async (event) => {
      const body = await readBody(event);
      if (!body?.id) return { ok: false, errors: ["id 必填"] };
      const result = await updateRule(body.id, { enabled: !runtime.rules.find((r) => r.id === body.id)?.enabled });
      if (!result.ok) return { ok: false, errors: result.errors };
      return { ok: true, rule: result.rule };
    }),
  );

  app.post(
    "/api/tauri/monitor/test",
    defineEventHandler(async (event) => {
      const body = await readBody(event);
      const rule = runtime.rules.find((item) => item.id === body?.id);
      if (!rule) return { ok: false, error: `规则不存在: ${body?.id}` };
      try {
        const result = await pollRule(rule, { dry: true });
        const state = runtime.states[rule.id] || {};
        const nextDueIn = Math.max(
          0,
          Math.ceil((Math.max(Number(state.lastPollAt) || 0, runtime.loadedAt) + rule.poll.intervalSec * 1000 - Date.now()) / 1000),
        );
        return {
          ok: true,
          vars: trim(result.vars, 2000),
          events: result.events,
          newEvents: result.newEvents,
          intervalSec: rule.poll.intervalSec,
          nextDueInSec: nextDueIn,
        };
      } catch (error) {
        return { ok: false, error: String(error?.message || error) };
      }
    }),
  );

  app.post(
    "/api/tauri/monitor/fire",
    defineEventHandler(async (event) => {
      const body = await readBody(event);
      const rule = runtime.rules.find((item) => item.id === body?.id);
      if (!rule) return { ok: false, error: `规则不存在: ${body?.id}` };
      let events;
      try {
        const result = await pollRule(rule, { dry: true });
        events = result.events;
      } catch (error) {
        return { ok: false, error: `轮询失败: ${error?.message || error}` };
      }
      if (!events.length) return { ok: false, error: "本轮轮询无事件（条件未命中）" };
      const outcome = await fire(rule, events, { source: "manual" });
      return outcome;
    }),
  );

  app.get(
    "/api/tauri/monitor/history",
    defineEventHandler(async (event) => {
      const query = getQuery(event);
      return await listRuns({
        limit: query.limit ? Number(query.limit) : 20,
        offset: query.offset ? Number(query.offset) : 0,
        ruleId: query.ruleId ? String(query.ruleId) : undefined,
      });
    }),
  );

  app.get(
    "/api/tauri/monitor/state",
    defineEventHandler(() => ({
      states: Object.entries(runtime.states).map(([ruleId, state]) => ({
        ruleId,
        lastPollAt: state.lastPollAt || undefined,
        lastError: state.lastError || undefined,
        consecutiveFailures: state.consecutiveFailures || 0,
        lastEvents: state.lastEvents || [],
        firedKeys: state.firedKeys || [],
        lastFireAt: state.lastFireAt || undefined,
        fireCount: state.fireCount || 0,
        vars: trim(state.vars, 2000),
      })),
    })),
  );

  app.get(
    "/api/tauri/monitor/options",
    defineEventHandler(async (event) => {
      const ctx = getServerContext(server);
      return await collectOptions(ctx);
    }),
  );
});

// ---------------------------------------------------------------------------
// 工具注册
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: "monitor_rule_create",
    description:
      "Create a monitor rule in the DSH monitor plugin. Polls HTTP endpoints on a schedule, " +
      "evaluates a JS expression over extracted variables, and only when new events match does it " +
      "wake a fresh visible agent session to act (zero LLM interaction otherwise). " +
      "Use when the user asks to set up / create monitoring of any HTTP endpoint.",
    parameters: {
      type: "object",
      properties: {
        rule: {
          type: "object",
          description: "规则对象：{name, poll:{intervalSec, steps:[{url, method, headers, body, extract:{变量:JS表达式(res)}}]}, events:'JS表达式({vars,prev,rule})→[{key,title,detail}]', action:{prompt(可空=通用默认，占位符{{ruleName}}/{{eventsText}}/{{events}}/{{time}}), workspaceId, permission, provider, model, timeoutSec, notify}}",
        },
      },
      required: ["rule"],
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: true,
        properties: { ok: { type: "boolean" }, rule: { type: "object" }, error: { type: "string" }, hint: { type: "string" } },
        required: ["ok"],
      },
      render: (_args, value) => textBlock(JSON.stringify(value)),
    },
    async execute(args) {
      const result = await createRule(args?.rule);
      if (!result.ok) return result;
      return {
        ok: true,
        rule: result.rule,
        hint: "规则已创建并启用；下一周期完成首次基线轮询（基线不触发唤醒）。用 monitor_rule_test 可立即试跑。",
      };
    },
  },
  {
    name: "monitor_rule_list",
    description: "List monitor rules with live status (last poll, errors, fire count). Use when the user asks about existing monitors.",
    parameters: { type: "object", properties: {} },
    output: {
      schema: {
        type: "object",
        additionalProperties: true,
        properties: { rules: { type: "array" } },
        required: ["rules"],
      },
      render: (_args, value) => textBlock(JSON.stringify(value)),
    },
    async execute() {
      return { rules: enrichRules() };
    },
  },
  {
    name: "monitor_rule_update",
    description: "Update an existing monitor rule by id with a partial patch (name/enabled/poll/events/action).",
    parameters: {
      type: "object",
      properties: { id: { type: "string" }, patch: { type: "object" } },
      required: ["id", "patch"],
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: true,
        properties: { ok: { type: "boolean" }, rule: { type: "object" }, error: { type: "string" } },
        required: ["ok"],
      },
      render: (_args, value) => textBlock(JSON.stringify(value)),
    },
    async execute(args) {
      const result = await updateRule(args.id, args.patch || {});
      return result;
    },
  },
  {
    name: "monitor_rule_delete",
    description: "Delete a monitor rule by id (also clears its state).",
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    output: {
      schema: {
        type: "object",
        additionalProperties: true,
        properties: { ok: { type: "boolean" }, error: { type: "string" } },
        required: ["ok"],
      },
      render: (_args, value) => textBlock(value.ok ? "✅ 已删除监控规则。" : `❌ 删除失败：${value.error}`),
    },
    async execute(args) {
      return await deleteRule(args.id);
    },
  },
  {
    name: "monitor_rule_test",
    description:
      "Dry-run one poll cycle of a monitor rule now: fetches all steps, evaluates events, " +
      "reports which events would fire — without touching state or waking any agent.",
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    output: {
      schema: {
        type: "object",
        additionalProperties: true,
        properties: { ok: { type: "boolean" }, vars: {}, events: { type: "array" }, newEvents: { type: "array" }, error: { type: "string" } },
        required: ["ok"],
      },
      render: (_args, value) => textBlock(JSON.stringify(value)),
    },
    async execute(args) {
      const rule = runtime.rules.find((item) => item.id === args.id);
      if (!rule) return { ok: false, error: `规则不存在: ${args.id}` };
      try {
        const result = await pollRule(rule, { dry: true });
        return { ok: true, vars: trim(result.vars, 2000), events: result.events, newEvents: result.newEvents };
      } catch (error) {
        return { ok: false, error: String(error?.message || error) };
      }
    },
  },
  {
    name: "monitor_rule_fire",
    description:
      "Force-fire a monitor rule now: polls once and (if any events match, ignoring dedup) wakes the agent session immediately. Use when the user wants to trigger a monitor manually.",
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    output: {
      schema: {
        type: "object",
        additionalProperties: true,
        properties: { ok: { type: "boolean" }, run: { type: "object" }, error: { type: "string" } },
        required: ["ok"],
      },
      render: (_args, value) => textBlock(JSON.stringify(value)),
    },
    async execute(args) {
      const rule = runtime.rules.find((item) => item.id === args.id);
      if (!rule) return { ok: false, error: `规则不存在: ${args.id}` };
      let events;
      try {
        const result = await pollRule(rule, { dry: true });
        events = result.events;
      } catch (error) {
        return { ok: false, error: `轮询失败: ${error?.message || error}` };
      }
      if (!events.length) return { ok: false, error: "本轮轮询无事件（条件未命中）" };
      return await fire(rule, events, { source: "manual" });
    },
  },
];

// ---------------------------------------------------------------------------
// 装载
// ---------------------------------------------------------------------------

function textBlock(text) {
  return [{ type: "text", text }];
}

async function loadAll() {
  await mkdir(STORE_DIR, { recursive: true });
  runtime.rules = await readJson(FILES.rules, []);
  runtime.states = await readJson(FILES.state, {});
  runtime.runs = await readJson(FILES.runs, []);
  if (!Array.isArray(runtime.rules)) runtime.rules = [];
  if (!isPlainObject(runtime.states)) runtime.states = {};
  if (!Array.isArray(runtime.runs)) runtime.runs = [];

  // 恢复：上次进程退出时仍 running 的 run 标记为 interrupted
  let dirty = false;
  for (const run of runtime.runs) {
    if (run?.status === "running") {
      run.status = "interrupted";
      run.error = "host_interrupted";
      run.finishedAt = new Date().toISOString();
      dirty = true;
    }
  }
  if (dirty) await saveRuns();
  runtime.loadedAt = Date.now();
  log(`loaded ${runtime.rules.length} rules, ${runtime.runs.length} runs`);
}

async function apply(ctx, config = {}) {
  await loadAll();
  for (const tool of TOOLS) ctx.tools.register(tool);
  ctx.effect(() => server(ctx), `${PLUGIN_ID}: web routes`);
  ctx.effect(() => startEngine(), `${PLUGIN_ID}: poll engine`);
  log("monitor plugin active");
}

export const name = PLUGIN_ID;
export const inject = [
  "tools",
  "webServer",
  "agents",
  "sessions",
  "sessionController",
  "workspaceRegistry",
  "agentDefaultModel",
  "agentPresets",
  "permissionPresets",
  "llm",
  "connection",
];
const _internals = { validateRule, normalizeEvents, evalExpr, renderUrl, pushKey, renderPrompt };
export { apply, _internals };
