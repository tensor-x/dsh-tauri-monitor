window.__ModuleLoader__.load({ id: `dsh-tauri-monitor`, factory: (require) => {
  const resolve = (spec) => require(spec.endsWith(`/client`) ? spec.slice(0, -7) : spec);
  const dsh = resolve(`dsh-tauri/client`);
  const ui = resolve(`dsh-tauri-ui/client`);
  const React = require(`react`);
  const j = require(`react/jsx-runtime`);
  const { useState, useEffect, useMemo, useRef, useCallback } = React;
  const NS = `dsh-tauri-monitor`;

  const T = dsh.defineLocale(NS, {
    zh: {
      title: `监控`,
      subtitle: `定时轮询 HTTP 接口，条件命中才唤醒 agent 执行；未命中零模型交互`,
      refresh: `刷新`,
      create: `新建规则`,
      empty: `还没有监控规则，点击「新建规则」创建。`,
      loading: `载入中…`,
      interval: `轮询间隔`,
      secondsUnit: `秒`,
      enabled: `已启用`,
      disabled: `已停用`,
      lastPoll: `上次轮询`,
      lastError: `上次错误`,
      fires: `累计触发`,
      never: `从未`,
      pollingNow: `轮询中…`,
      runningNow: `任务执行中`,
      test: `测试`,
      fireNow: `立即触发`,
      pause: `停用`,
      resume: `启用`,
      edit: `编辑`,
      delete: `删除`,
      confirmDelete: `确认删除`,
      history: `执行记录`,
      noRuns: `暂无执行记录`,
      ruleName: `规则名称`,
      pollInterval: `轮询间隔（秒）`,
      prompt: `唤醒指令（留空用通用默认）`,
      model: `模型`,
      permission: `权限`,
      workspace: `工作区`,
      timeout: `超时（秒）`,
      stepsJson: `轮询步骤 JSON`,
      eventsExpr: `事件判定表达式`,
      cancel: `取消`,
      save: `保存`,
      statusRunning: `执行中`,
      statusSucceeded: `成功`,
      statusFailed: `失败`,
      statusInterrupted: `已中断`,
      statusTimedOut: `超时`,
      createFailed: `创建失败`,
      saveFailed: `保存失败`,
      deleteFailed: `删除失败`,
      toggleFailed: `操作失败`,
      testOk: `轮询成功`,
      noEvents: `本轮无事件`,
      eventsHit: `命中 {count} 个事件`,
      fired: `已唤醒 agent`,
      testFailed: `测试失败`,
      fireFailed: `触发失败`,
      jsonInvalid: `JSON 格式错误`,
      promptPlaceholder: `描述命中后让 agent 做什么；支持 {{eventsText}} 等占位符`,
      stepsPlaceholder: `[{ "name": "fetch", "url": "https://…", "extract": { "count": "res.data.total" } }]`,
      eventsPlaceholder: `vars.count > 0 ? [{ key: "c:" + vars.count, title: "count=" + vars.count }] : []`,
      customHint: `步骤 URL 支持 {变量} 插值；extract 以 {res, vars} 求值；events 以 {vars, prev, rule} 求值`,
    },
    en: {
      title: `Monitors`,
      subtitle: `Poll HTTP endpoints on schedule; wake an agent only when conditions hit — zero model calls otherwise`,
      refresh: `Refresh`,
      create: `New rule`,
      empty: `No monitor rules yet. Click "New rule" to create one.`,
      loading: `Loading…`,
      interval: `Interval`,
      secondsUnit: `s`,
      enabled: `Enabled`,
      disabled: `Paused`,
      lastPoll: `Last poll`,
      lastError: `Last error`,
      fires: `Fires`,
      never: `never`,
      pollingNow: `polling…`,
      runningNow: `task running`,
      test: `Test`,
      fireNow: `Fire now`,
      pause: `Pause`,
      resume: `Enable`,
      edit: `Edit`,
      delete: `Delete`,
      confirmDelete: `Confirm delete`,
      history: `Run history`,
      noRuns: `No runs yet`,
      ruleName: `Name`,
      pollInterval: `Poll interval (seconds)`,
      prompt: `Wake prompt (empty = generic default)`,
      model: `Model`,
      permission: `Permission`,
      workspace: `Workspace`,
      timeout: `Timeout (seconds)`,
      stepsJson: `Poll steps JSON`,
      eventsExpr: `Events expression`,
      cancel: `Cancel`,
      save: `Save`,
      statusRunning: `Running`,
      statusSucceeded: `Succeeded`,
      statusFailed: `Failed`,
      statusInterrupted: `Interrupted`,
      statusTimedOut: `Timed out`,
      createFailed: `Create failed`,
      saveFailed: `Save failed`,
      deleteFailed: `Delete failed`,
      toggleFailed: `Action failed`,
      testOk: `Poll ok`,
      noEvents: `No events this round`,
      eventsHit: `{count} event(s) hit`,
      fired: `Agent woke up`,
      testFailed: `Test failed`,
      fireFailed: `Fire failed`,
      jsonInvalid: `Invalid JSON`,
      promptPlaceholder: `What the agent should do on hit; supports placeholders like {{eventsText}}`,
      stepsPlaceholder: `[{ "name": "fetch", "url": "https://…", "extract": { "count": "res.data.total" } }]`,
      eventsPlaceholder: `vars.count > 0 ? [{ key: "c:" + vars.count, title: "count=" + vars.count }] : []`,
      customHint: `Step URLs support {var} interpolation; extract evaluates with {res, vars}; events with {vars, prev, rule}`,
    },
  });

  const api = dsh.ofetch;
  const t = (key, params) => T.text(key, params);

  const fmtTime = (value) => {
    if (!value) return t(`never`);
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleString();
  };
  const fmtDuration = (run) => {
    const start = run.startedAt ? Date.parse(run.startedAt) : NaN;
    const end = run.finishedAt ? Date.parse(run.finishedAt) : Date.now();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return ``;
    const sec = Math.round((end - start) / 1000);
    if (sec < 60) return `${sec}s`;
    if (sec < 3600) return `${Math.floor(sec / 60)}m${sec % 60}s`;
    return `${Math.floor(sec / 3600)}h${Math.floor((sec % 3600) / 60)}m`;
  };
  const modelKey = (provider, model) => `${provider}/${model}`;
  const parseModelKey = (value) => {
    const index = String(value || ``).indexOf(`/`);
    if (index < 0) return { provider: undefined, model: undefined };
    return { provider: value.slice(0, index), model: value.slice(index + 1) };
  };

  const inputClass = `m-0 w-full rounded-[8px] border border-solid px-[10px] py-[6px] text-[13px] leading-[1.5] outline-none`;
  const labelClass = `flex flex-col gap-[6px]`;
  const labelTextClass = `text-[12px] font-medium`;

  function Field({ label, children }) {
    return j.jsx(`label`, { className: labelClass, children: j.jsxs(j.Fragment, { children: [
      j.jsx(`span`, { className: labelTextClass, children: label }),
      children,
    ] }) });
  }

  const STATUS_KEYS = {
    running: `statusRunning`,
    succeeded: `statusSucceeded`,
    failed: `statusFailed`,
    interrupted: `statusInterrupted`,
    timed_out: `statusTimedOut`,
  };
  function RunStatus({ status }) {
    const key = STATUS_KEYS[status] || `statusFailed`;
    return j.jsx(ui.Tag, { variant: `status`, tone: status === `succeeded` ? `success` : status === `running` ? `info` : status === `failed` || status === `timed_out` ? `error` : undefined, children: t(key) });
  }

  // ---------------------------------------------------------------------------
  // 数据载入
  // ---------------------------------------------------------------------------

  function useMonitorData(active) {
    const [rules, setRules] = useState(null);
    const [options, setOptions] = useState(null);
    const [runs, setRuns] = useState(null);
    const [error, setError] = useState(``);

    const load = useCallback(async () => {
      try {
        const [rulesRes, optionsRes, runsRes] = await Promise.all([
          api(`/api/tauri/monitor/rules`),
          api(`/api/tauri/monitor/options`).catch(() => null),
          api(`/api/tauri/monitor/history?limit=30`),
        ]);
        setRules(rulesRes?.rules || []);
        setOptions(optionsRes);
        setRuns(runsRes?.runs || []);
        setError(``);
      } catch (err) {
        setError(String(err?.data?.error || err?.message || err));
      }
    }, []);

    useEffect(() => {
      if (!active) return undefined;
      load();
      const timer = setInterval(load, 5000);
      return () => clearInterval(timer);
    }, [active, load]);

    return { rules, options, runs, error, reload: load };
  }

  // ---------------------------------------------------------------------------
  // 规则卡片
  // ---------------------------------------------------------------------------

  function RuleCard({ rule, options, onEdit, onAction, notify }) {
    const [confirming, setConfirming] = useState(false);
    const [busy, setBusy] = useState(false);
    const status = rule.status || {};

    const run = async (kind) => {
      if (busy) return;
      setBusy(true);
      try {
        if (kind === `toggle`) await api(`/api/tauri/monitor/toggle`, { method: `POST`, body: { id: rule.id } });
        if (kind === `test`) {
          const res = await api(`/api/tauri/monitor/test`, { method: `POST`, body: { id: rule.id } });
          if (!res?.ok) notify(`${t(`testFailed`)}: ${res?.error || ``}`, `error`);
          else notify(res.events?.length ? `${t(`testOk`)} — ${t(`eventsHit`, { count: res.events.length })}` : `${t(`testOk`)} — ${t(`noEvents`)}`, `ok`);
        }
        if (kind === `fire`) {
          const res = await api(`/api/tauri/monitor/fire`, { method: `POST`, body: { id: rule.id } });
          if (!res?.ok) notify(`${t(`fireFailed`)}: ${res?.error || ``}`, `error`);
          else notify(t(`fired`), `ok`);
        }
        if (kind === `delete`) {
          const res = await api(`/api/tauri/monitor/rules?id=${encodeURIComponent(rule.id)}`, { method: `DELETE` });
          if (!res?.ok) notify(`${t(`deleteFailed`)}: ${(res?.errors || []).join(`; `)}`, `error`);
        }
        await onAction();
      } catch (err) {
        notify(`${t(`toggleFailed`)}: ${String(err?.data?.error || err?.message || err)}`, `error`);
        await onAction();
      } finally {
        setBusy(false);
        setConfirming(false);
      }
    };

    return j.jsxs(ui.Card, { className: `flex flex-col gap-[10px]`, children: [
      j.jsxs(`div`, { className: `flex items-center gap-[10px] min-w-0`, children: [
        j.jsx(ui.Icon, { as: ui.Alarm, size: 16, "aria-hidden": `true` }),
        j.jsx(`span`, { className: `truncate text-[14px] font-semibold`, children: rule.name }),
        j.jsx(ui.Tag, { variant: `status`, tone: rule.enabled ? `success` : undefined, children: rule.enabled ? t(`enabled`) : t(`disabled`) }),
        j.jsx(`span`, { className: `ml-auto flex items-center gap-[8px] text-[12px] text-tertiary whitespace-nowrap`, children: [
          `${t(`interval`)} ${rule.poll?.intervalSec ?? `?`}${t(`secondsUnit`)}`,
          status.running ? j.jsx(ui.Tag, { variant: `status`, tone: `info`, children: t(`runningNow`) }) : null,
          status.polling ? j.jsx(ui.Tag, { variant: `status`, tone: `info`, children: t(`pollingNow`) }) : null,
        ] }),
      ] }),
      j.jsxs(`div`, { className: `flex flex-col gap-[2px] text-[12px] text-secondary`, children: [
        j.jsx(`span`, { children: `${t(`lastPoll`)}: ${fmtTime(status.lastPollAt)}${status.consecutiveFailures ? ` · ${t(`lastError`)}×${status.consecutiveFailures}` : ``}` }),
        status.lastError ? j.jsx(`span`, { className: `text-error break-all`, role: `alert`, children: `${t(`lastError`)}: ${status.lastError}` }) : null,
        j.jsx(`span`, { children: `${t(`fires`)}: ${status.fireCount || 0}${status.lastFireAt ? ` · ${fmtTime(status.lastFireAt)}` : ``}` }),
      ] }),
      j.jsxs(`div`, { className: `flex flex-wrap items-center gap-[8px]`, children: [
        j.jsx(ui.Button, { size: `sm`, variant: `outline`, disabled: busy, onClick: () => run(`test`), children: t(`test`) }),
        j.jsx(ui.Button, { size: `sm`, variant: `outline`, disabled: busy, onClick: () => run(`fire`), children: t(`fireNow`) }),
        j.jsx(ui.Button, { size: `sm`, variant: `outline`, disabled: busy, onClick: () => run(`toggle`), children: rule.enabled ? t(`pause`) : t(`resume`) }),
        j.jsx(ui.Button, { size: `sm`, variant: `outline`, disabled: busy, onClick: () => onEdit(rule), children: t(`edit`) }),
        confirming
          ? j.jsxs(j.Fragment, { children: [
              j.jsx(ui.Button, { size: `sm`, variant: `danger`, disabled: busy, onClick: () => run(`delete`), children: t(`confirmDelete`) }),
              j.jsx(ui.Button, { size: `sm`, disabled: busy, onClick: () => setConfirming(false), children: t(`cancel`) }),
            ] })
          : j.jsx(ui.Button, { size: `sm`, variant: `outline`, disabled: busy, onClick: () => setConfirming(true), children: j.jsx(ui.Icon, { as: ui.TrashBin, size: 14, "aria-hidden": `true` }) }),
      ] }),
    ] });
  }

  // ---------------------------------------------------------------------------
  // 新建 / 编辑
  // ---------------------------------------------------------------------------

  const blankDraft = (options, rule) => {
    const defaults = options?.defaultModel || {};
    const modelValue = rule?.action?.provider ? modelKey(rule.action.provider, rule.action.model) : options?.defaultModel ? modelKey(defaults.provider, defaults.model) : ``;
    return {
      id: rule?.id,
      name: rule?.name || ``,
      intervalSec: String(rule?.poll?.intervalSec ?? 180),
      prompt: rule?.action?.prompt || ``,
      model: modelValue,
      permission: rule?.action?.permission || options?.defaultPermission || `workspace-write`,
      workspaceId: rule?.action?.workspaceId || ``,
      timeoutSec: String(rule?.action?.timeoutSec ?? 7200),
      stepsJson: rule ? JSON.stringify(rule.poll?.steps || [], null, 2) : ``,
      eventsExpr: rule ? String(rule.events || ``) : ``,
    };
  };

  function Editor({ draft, setDraft, options, onCancel, onSave, notify }) {
    const [busy, setBusy] = useState(false);
    const update = (patch) => setDraft((prev) => ({ ...prev, ...patch }));

    const modelOptions = useMemo(() => (options?.models || []).map((item) => ({
      value: modelKey(item.provider, item.model),
      label: `${item.provider} / ${item.label || item.model}`,
    })), [options]);
    const workspaceOptions = useMemo(() => [
      { value: ``, label: t(`workspace`) },
      ...(options?.workspaces || []).map((ws) => ({ value: ws.id, label: ws.title || ws.path })),
    ], [options]);
    const permissionOptions = useMemo(() => (options?.permissions || []).map((item) => ({
      value: item.value, label: item.name || item.value,
    })), [options]);

    const save = async () => {
      if (busy) return;
      setBusy(true);
      try {
        const { provider, model } = parseModelKey(draft.model);
        const action = {
          prompt: draft.prompt,
          permission: draft.permission,
          timeoutSec: Number(draft.timeoutSec) || 7200,
          ...(provider ? { provider, model } : {}),
          ...(draft.workspaceId ? { workspaceId: draft.workspaceId } : {}),
        };
        let res;
        if (draft.id) {
          res = await api(`/api/tauri/monitor/rules`, { method: `PUT`, body: {
            id: draft.id,
            name: draft.name,
            poll: { intervalSec: Number(draft.intervalSec) || 60, steps: JSON.parse(draft.stepsJson || `[]`) },
            events: draft.eventsExpr,
            action,
          } });
        } else {
          res = await api(`/api/tauri/monitor/rules`, { method: `POST`, body: {
            name: draft.name,
            poll: { intervalSec: Number(draft.intervalSec) || 60, steps: JSON.parse(draft.stepsJson || `[]`) },
            events: draft.eventsExpr,
            action,
          } });
        }
        if (!res?.ok) {
          notify(`${draft.id ? t(`saveFailed`) : t(`createFailed`)}: ${(res?.errors || []).join(`; `) || res?.error || ``}`, `error`);
          return;
        }
        await onSave();
      } catch (err) {
        const message = String(err?.message || err);
        notify(`${draft.id ? t(`saveFailed`) : t(`createFailed`)}: ${/JSON/i.test(message) ? t(`jsonInvalid`) : message}`, `error`);
      } finally {
        setBusy(false);
      }
    };

    return j.jsxs(`div`, { className: `flex flex-col gap-[12px]`, children: [
      j.jsx(ui.Text, { weight: `semibold`, size: `md`, children: draft.id ? `${t(`edit`)} — ${draft.name}` : t(`create`) }),

      j.jsxs(`div`, { className: `grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-[12px]`, children: [
        j.jsx(Field, { label: t(`ruleName`), children: j.jsx(`input`, { className: inputClass, value: draft.name, onChange: (e) => update({ name: e.target.value }) }) }),
        j.jsx(Field, { label: t(`pollInterval`), children: j.jsx(`input`, { className: inputClass, type: `number`, min: 10, value: draft.intervalSec, onChange: (e) => update({ intervalSec: e.target.value }) }) }),
        j.jsx(Field, { label: t(`model`), children: j.jsx(ui.Select, { value: draft.model, options: modelOptions, onChange: (value) => update({ model: value }) }) }),
        j.jsx(Field, { label: t(`permission`), children: j.jsx(ui.Select, { value: draft.permission, options: permissionOptions, onChange: (value) => update({ permission: value }) }) }),
        j.jsx(Field, { label: t(`workspace`), children: j.jsx(ui.Select, { value: draft.workspaceId, options: workspaceOptions, onChange: (value) => update({ workspaceId: value }) }) }),
        j.jsx(Field, { label: t(`timeout`), children: j.jsx(`input`, { className: inputClass, type: `number`, min: 60, value: draft.timeoutSec, onChange: (e) => update({ timeoutSec: e.target.value }) }) }),
      ] }),

      j.jsx(Field, { label: t(`prompt`), children: j.jsx(`textarea`, { className: `${inputClass} min-h-[90px] resize-y font-mono`, placeholder: t(`promptPlaceholder`), value: draft.prompt, onChange: (e) => update({ prompt: e.target.value }) }) }),

      j.jsx(Field, { label: t(`stepsJson`), children: j.jsx(`textarea`, { className: `${inputClass} min-h-[140px] resize-y font-mono text-[12px]`, placeholder: t(`stepsPlaceholder`), value: draft.stepsJson, onChange: (e) => update({ stepsJson: e.target.value }) }) }),
      j.jsx(Field, { label: t(`eventsExpr`), children: j.jsx(`textarea`, { className: `${inputClass} min-h-[70px] resize-y font-mono text-[12px]`, placeholder: t(`eventsPlaceholder`), value: draft.eventsExpr, onChange: (e) => update({ eventsExpr: e.target.value }) }) }),
      j.jsx(ui.Text, { tone: `tertiary`, size: `xs`, children: t(`customHint`) }),

      j.jsxs(`div`, { className: `flex items-center gap-[8px]`, children: [
        j.jsx(ui.Button, { variant: `primary`, disabled: busy, onClick: () => void save(), children: t(`save`) }),
        j.jsx(ui.Button, { disabled: busy, onClick: onCancel, children: t(`cancel`) }),
      ] }),
    ] });
  }

  // ---------------------------------------------------------------------------
  // 执行记录
  // ---------------------------------------------------------------------------

  function HistoryList({ runs, rules }) {
    const nameOf = (run) => run.ruleName || (rules || []).find((rule) => rule.id === run.ruleId)?.name || run.ruleId || ``;
    if (!runs || runs.length === 0) return j.jsx(ui.Text, { tone: `tertiary`, size: `sm`, children: t(`noRuns`) });
    return j.jsx(`ul`, { className: `m-0 p-0 list-none flex flex-col gap-[8px]`, children: runs.map((run) => j.jsxs(`li`, { className: `flex flex-col gap-[2px] rounded-[10px] px-[12px] py-[8px]`, children: [
      j.jsxs(`div`, { className: `flex items-center gap-[8px] min-w-0 text-[13px]`, children: [
        j.jsx(RunStatus, { status: run.status }),
        j.jsx(`span`, { className: `truncate font-medium`, children: nameOf(run) }),
        run.events?.length ? j.jsx(ui.Tag, { variant: `status`, children: `${run.events.length}` }) : null,
        j.jsx(`span`, { className: `ml-auto whitespace-nowrap text-[12px] text-tertiary`, children: `${fmtTime(run.startedAt)}${run.status === `running` ? `` : ` · ${fmtDuration(run)}`}` }),
      ] }),
      run.summary ? j.jsx(`span`, { className: `text-[12px] text-secondary break-all`, children: run.summary }) : null,
      run.error ? j.jsx(`span`, { className: `text-[12px] text-error break-all`, children: run.error }) : null,
      run.sessionId ? j.jsx(`span`, { className: `text-[11px] text-tertiary font-mono truncate`, children: run.sessionId }) : null,
    ] }, run.id)) });
  }

  // ---------------------------------------------------------------------------
  // 面板
  // ---------------------------------------------------------------------------

  function PanelView() {
    const mounted = useRef(true);
    const [toast, setToast] = useState(null);
    const [draft, setDraft] = useState(null);
    const { rules, options, runs, error, reload } = useMonitorData(true);

    useEffect(() => () => { mounted.current = false; }, []);
    const notify = useCallback((text, kind) => {
      if (mounted.current) setToast({ text, kind, seq: Date.now() });
    }, []);
    useEffect(() => {
      if (!toast) return undefined;
      const timer = setTimeout(() => { if (mounted.current) setToast(null); }, 4000);
      return () => clearTimeout(timer);
    }, [toast]);

    return j.jsxs(`div`, { className: `h-full overflow-y-auto p-[16px] flex flex-col gap-[14px]`, children: [
      j.jsxs(`div`, { className: `flex items-center gap-[10px]`, children: [
        j.jsx(ui.Icon, { as: ui.Alarm, size: 18, "aria-hidden": `true` }),
        j.jsx(`span`, { className: `text-[16px] font-semibold`, children: t(`title`) }),
        j.jsx(`span`, { className: `flex-1 truncate text-[12px] text-tertiary`, children: t(`subtitle`) }),
        j.jsx(ui.Button, { size: `sm`, variant: `outline`, onClick: () => void reload(), children: t(`refresh`) }),
        j.jsx(ui.Button, { size: `sm`, variant: `primary`, onClick: () => setDraft(blankDraft(options, undefined)), children: t(`create`) }),
      ] }),

      error ? j.jsx(ui.Text, { tone: `error`, role: `alert`, children: error }) : null,

      draft ? j.jsx(Editor, {
        draft, setDraft, options,
        onCancel: () => setDraft(null),
        onSave: async () => { setDraft(null); await reload(); },
        notify,
      }) : null,

      !draft && rules === null ? j.jsx(ui.Text, { tone: `tertiary`, children: t(`loading`) }) : null,
      !draft && rules !== null && rules.length === 0 ? j.jsx(ui.Text, { tone: `tertiary`, children: t(`empty`) }) : null,
      !draft ? j.jsx(`div`, { className: `flex flex-col gap-[10px]`, children: (rules || []).map((rule) => j.jsx(RuleCard, {
        rule, options,
        onEdit: (item) => setDraft(blankDraft(options, item)),
        onAction: reload,
        notify,
      }, rule.id)) }) : null,

      !draft ? j.jsxs(`section`, { className: `flex flex-col gap-[8px]`, children: [
        j.jsx(`h3`, { className: `m-0 text-[13px] font-semibold`, children: t(`history`) }),
        j.jsx(HistoryList, { runs, rules }),
      ] }) : null,

      toast ? j.jsx(ui.Toast, {
        text: toast.text,
        icon: j.jsx(ui.Icon, { as: toast.kind === `error` ? ui.TriangleExclamation : ui.Check }),
        onDone: () => { if (mounted.current) setToast(null); },
      }, toast.seq) : null,
    ] });
  }

  function MonitorNavIcon({ size }) {
    return j.jsx(ui.Icon, { as: ui.Alarm, size, "aria-hidden": `true` });
  }

  // ---------------------------------------------------------------------------
  // 注册
  // ---------------------------------------------------------------------------

  const registerPanel = dsh.defineRegister((ctl, ctx) => {
    const handle = dsh.definePanel(ctx, {
      id: NS,
      order: 31,
      locale: T.NS,
      label: () => T.text(`title`),
      icon: (props) => j.jsx(MonitorNavIcon, { size: props?.size ?? 16 }),
      render: () => j.jsx(PanelView),
    });
    ctl.add(() => handle.dispose());
  });

  function apply(ctx) {
    ctx.effect(T.registerLocale, `${NS}: locale`);
    ctx.effect(registerPanel, `${NS}: panel`);
  }

  return { apply, inject: [`slots`, `layout`, `locale`], name: NS };
} });
