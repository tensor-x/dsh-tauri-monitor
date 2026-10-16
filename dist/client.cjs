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
      title: `监控系统`,
      subtitle: `定时轮询 HTTP 接口，条件命中才唤醒 agent 自动执行，未命中零模型开销。`,
      refresh: `刷新`,
      create: `新建监控规则`,
      searchPlaceholder: `搜索监控规则或说明...`,
      emptyRules: `暂无监控规则，点击「新建监控规则」开启自动监控。`,
      noMatch: `没有匹配的监控规则`,
      loading: `载入中…`,
      interval: `轮询间隔`,
      secondsUnit: `秒`,
      enabled: `已启用`,
      disabled: `已停用`,
      lastPoll: `上次轮询`,
      lastError: `上次异常`,
      fires: `累计触发`,
      never: `从未`,
      pollingNow: `轮询中…`,
      runningNow: `执行中`,
      test: `测试轮询`,
      fireNow: `立即唤醒`,
      pause: `暂停`,
      resume: `启用`,
      edit: `编辑规则`,
      delete: `删除`,
      confirmDelete: `确认删除该规则？`,
      historyTab: `运行历史`,
      ruleTab: `规则配置`,
      noRuns: `暂无任务执行记录`,
      ruleName: `规则名称`,
      ruleNamePlaceholder: `给监控规则起个易懂的名字`,
      pollInterval: `轮询周期（秒）`,
      model: `执行模型`,
      permission: `执行权限`,
      workspace: `执行工作区`,
      timeout: `最大运行超时（秒）`,
      prompt: `唤醒指令 (Prompt)`,
      promptPlaceholder: `触发后传递给 agent 的完整任务要求；支持 {{eventsText}} 等占位符`,
      stepsJson: `轮询步骤序列 (JSON)`,
      stepsPlaceholder: `[{"name": "fetch", "url": "https://api.example.com/v1/status", "method": "GET", "extract": {"count": "res.data.count"}}]`,
      eventsExpr: `事件判定表达式 (JS)`,
      eventsPlaceholder: `vars.count > 0 ? [{ key: "c:" + vars.count, title: "发现指标变动: " + vars.count }] : []`,
      optionsGroup: `高级执行与投递选项`,
      stepsGroup: `接口轮询与事件判定逻辑`,
      cancel: `取消`,
      save: `保存规则`,
      statusRunning: `执行中`,
      statusSucceeded: `执行成功`,
      statusFailed: `执行失败`,
      statusInterrupted: `已中断`,
      statusTimedOut: `超时中断`,
      testOk: `轮询成功`,
      noEvents: `未产生触发事件`,
      eventsHit: `命中 {count} 个新事件`,
      fired: `已创建独立会话唤醒 Agent 执行`,
      testFailed: `测试失败`,
      fireFailed: `唤醒失败`,
      toggleFailed: `状态切换失败`,
      deleteFailed: `删除失败`,
      jsonInvalid: `步骤 JSON 格式有误，请核对`,
      unsaved: `有未保存的修改`,
    },
    en: {
      title: `Monitors`,
      subtitle: `Poll HTTP endpoints on schedule; wake an agent session only when conditions match.`,
      refresh: `Refresh`,
      create: `New Monitor Rule`,
      searchPlaceholder: `Search monitor rules...`,
      emptyRules: `No monitor rules yet. Click "New Monitor Rule" to add one.`,
      noMatch: `No matching rules found`,
      loading: `Loading…`,
      interval: `Interval`,
      secondsUnit: `s`,
      enabled: `Active`,
      disabled: `Paused`,
      lastPoll: `Last poll`,
      lastError: `Last error`,
      fires: `Fires`,
      never: `never`,
      pollingNow: `polling…`,
      runningNow: `running`,
      test: `Test Poll`,
      fireNow: `Fire Now`,
      pause: `Pause`,
      resume: `Enable`,
      edit: `Edit`,
      delete: `Delete`,
      confirmDelete: `Delete this rule?`,
      historyTab: `Run History`,
      ruleTab: `Rule Config`,
      noRuns: `No run history yet`,
      ruleName: `Rule Name`,
      ruleNamePlaceholder: `Enter rule name...`,
      pollInterval: `Poll Interval (seconds)`,
      model: `Model`,
      permission: `Permission`,
      workspace: `Workspace`,
      timeout: `Timeout (seconds)`,
      prompt: `Wake Prompt`,
      promptPlaceholder: `Full instructions passed to the agent; supports {{eventsText}}`,
      stepsJson: `Poll Steps (JSON Array)`,
      stepsPlaceholder: `[{"name": "fetch", "url": "https://api.example.com", "method": "GET", "extract": {"count": "res.data.count"}}]`,
      eventsExpr: `Event Condition (JS Expr)`,
      eventsPlaceholder: `vars.count > 0 ? [{ key: "c:" + vars.count, title: "count changed: " + vars.count }] : []`,
      optionsGroup: `Execution & Delivery Options`,
      stepsGroup: `HTTP Polling & Condition Logic`,
      cancel: `Cancel`,
      save: `Save Rule`,
      statusRunning: `Running`,
      statusSucceeded: `Succeeded`,
      statusFailed: `Failed`,
      statusInterrupted: `Interrupted`,
      statusTimedOut: `Timed Out`,
      testOk: `Poll ok`,
      noEvents: `No events matched`,
      eventsHit: `{count} event(s) matched`,
      fired: `Agent session woke up successfully`,
      testFailed: `Test failed`,
      fireFailed: `Fire failed`,
      toggleFailed: `Toggle failed`,
      deleteFailed: `Delete failed`,
      jsonInvalid: `Invalid JSON format in steps`,
      unsaved: `Unsaved changes`,
    },
  });

  const api = dsh.ofetch;
  const t = (key, params) => T.text(key, params);

  const fmtTime = (value) => {
    if (!value) return t(`never`);
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return new Intl.DateTimeFormat(`zh-CN`, {
      month: `numeric`,
      day: `numeric`,
      hour: `2-digit`,
      minute: `2-digit`,
      second: `2-digit`,
      hourCycle: `h23`,
    }).format(date);
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

  const modelKey = (provider, model) => `${provider}::${model}`;
  const parseModelKey = (value) => {
    const index = String(value || ``).indexOf(`::`);
    if (index < 0) return { provider: undefined, model: undefined };
    return { provider: value.slice(0, index), model: value.slice(index + 2) };
  };

  function FormRow({ label, children }) {
    return j.jsxs(`div`, {
      className: `box-border flex w-full items-center justify-between gap-[16px] min-h-[48px] border-b-[0.5px] border-border-l3 last:border-b-0`,
      children: [
        j.jsx(`span`, { className: `shrink-0 text-primary text-[13px] leading-[1.6] font-medium`, children: label }),
        children,
      ],
    });
  }

  const STATUS_KEYS = {
    running: `statusRunning`,
    succeeded: `statusSucceeded`,
    failed: `statusFailed`,
    interrupted: `statusInterrupted`,
    timed_out: `statusTimedOut`,
  };

  function RunStatusTag({ status }) {
    const key = STATUS_KEYS[status] || `statusFailed`;
    const tone = status === `succeeded` ? `success` : status === `running` ? `info` : `error`;
    return j.jsx(ui.Tag, { variant: `status`, tone, children: t(key) });
  }

  // ---------------------------------------------------------------------------
  // 数据管理 Hook
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
          api(`/api/tauri/monitor/history?limit=50`),
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
      const timer = setInterval(load, 4000);
      return () => clearInterval(timer);
    }, [active, load]);

    return { rules, options, runs, error, reload: load };
  }

  // ---------------------------------------------------------------------------
  // 规则卡片（完全对齐 scheduler 任务卡片风格）
  // ---------------------------------------------------------------------------

  function RuleItemCard({ rule, onSelect, onAction, notify, isSelected }) {
    const [menuOpen, setMenuOpen] = useState(false);
    const [busy, setBusy] = useState(false);
    const anchorRef = useRef(null);
    const status = rule.status || {};
    const paused = !rule.enabled;

    const runAction = async (kind, e) => {
      if (e) e.stopPropagation();
      if (busy) return;
      setBusy(true);
      try {
        if (kind === `toggle`) {
          await api(`/api/tauri/monitor/toggle`, { method: `POST`, body: { id: rule.id } });
        } else if (kind === `test`) {
          const res = await api(`/api/tauri/monitor/test`, { method: `POST`, body: { id: rule.id } });
          if (!res?.ok) notify(`${t(`testFailed`)}: ${res?.error || ``}`, `error`);
          else notify(res.events?.length ? `${t(`testOk`)} — ${t(`eventsHit`, { count: res.events.length })}` : `${t(`testOk`)} — ${t(`noEvents`)}`, `ok`);
        } else if (kind === `fire`) {
          const res = await api(`/api/tauri/monitor/fire`, { method: `POST`, body: { id: rule.id } });
          if (!res?.ok) notify(`${t(`fireFailed`)}: ${res?.error || ``}`, `error`);
          else notify(t(`fired`), `ok`);
        } else if (kind === `delete`) {
          const res = await api(`/api/tauri/monitor/rules?id=${encodeURIComponent(rule.id)}`, { method: `DELETE` });
          if (!res?.ok) notify(`${t(`deleteFailed`)}: ${(res?.errors || []).join(`; `)}`, `error`);
        }
        await onAction();
      } catch (err) {
        notify(`${t(`toggleFailed`)}: ${String(err?.data?.error || err?.message || err)}`, `error`);
      } finally {
        setBusy(false);
        setMenuOpen(false);
      }
    };

    const menuItems = [
      { id: `edit`, label: t(`edit`), icon: j.jsx(ui.Icon, { as: ui.PersonPencil }) },
      { id: `test`, label: t(`test`), icon: j.jsx(ui.Icon, { as: ui.CirclePlay }) },
      { id: `fire`, label: t(`fireNow`), icon: j.jsx(ui.Icon, { as: ui.CirclePlay }) },
      { id: `toggle`, label: paused ? t(`resume`) : t(`pause`), icon: j.jsx(ui.Icon, { as: paused ? ui.CirclePlay : ui.CirclePause }) },
      { type: `separator`, id: `sep` },
      { id: `delete`, label: t(`delete`), icon: j.jsx(ui.Icon, { as: ui.TrashBin }), danger: true },
    ];

    const describeText = `${t(`interval`)} ${rule.poll?.intervalSec ?? 60} ${t(`secondsUnit`)} · ${t(`lastPoll`)}: ${fmtTime(status.lastPollAt)}`;

    return j.jsxs(ui.Card, {
      ref: anchorRef,
      variant: `link`,
      className: dsh.cn(
        `box-border mx-0 flex justify-between items-center gap-[12px] w-full min-w-0 h-[64px] px-[14px] py-[10px] rounded-[12px] text-inherit [font-family:inherit] text-[13px] leading-[20px] text-left cursor-pointer overflow-hidden transition-colors`,
        isSelected && `bg-[var(--dsw-alias-bg-hover)] border-border-l4`,
        paused && `opacity-60`,
      ),
      onClick: (e) => {
        if (e.currentTarget.contains(e.target)) onSelect(rule);
      },
      children: [
        j.jsx(`div`, {
          style: { height: 36 },
          children: j.jsx(ui.Action, {
            variant: `action`,
            disabled: busy,
            icon: paused ? j.jsx(ui.Icon, { as: ui.CirclePlay, size: 18 }) : j.jsx(ui.Icon, { as: ui.CirclePause, size: 18 }),
            "aria-label": paused ? t(`resume`) : t(`pause`),
            onClick: (e) => runAction(`toggle`, e),
          }),
        }),
        j.jsxs(`div`, {
          className: `flex-1 min-w-0 flex flex-col justify-center gap-[2px]`,
          children: [
            j.jsxs(`div`, {
              className: `flex items-center gap-[8px] min-w-0`,
              children: [
                j.jsx(ui.Card.Title, { className: `min-w-0 text-[14px] leading-[20px] font-medium truncate`, title: rule.name, children: rule.name }),
                status.running ? j.jsx(ui.Tag, { variant: `status`, tone: `info`, children: t(`runningNow`) }) : null,
                status.polling ? j.jsx(ui.Tag, { variant: `status`, tone: `info`, children: t(`pollingNow`) }) : null,
              ],
            }),
            j.jsxs(ui.Card.Description, {
              className: `flex items-center gap-[10px] min-w-0 text-[12px] text-tertiary truncate`,
              children: [
                describeText,
                status.consecutiveFailures > 0 ? j.jsx(`strong`, { className: `text-error`, children: `(${t(`lastError`)} ×${status.consecutiveFailures})` }) : null,
              ],
            }),
          ],
        }),
        j.jsx(ui.Menu, {
          open: menuOpen,
          onClose: () => setMenuOpen(false),
          onSelect: (key) => {
            if (key === `edit`) onSelect(rule);
            else if (key === `test`) runAction(`test`);
            else if (key === `fire`) runAction(`fire`);
            else if (key === `toggle`) runAction(`toggle`);
            else if (key === `delete`) runAction(`delete`);
          },
          items: menuItems,
          portal: true,
          align: `end`,
          anchor: j.jsx(ui.Action, {
            variant: `action`,
            icon: j.jsx(ui.Icon, { as: ui.EllipsisVertical, size: 16 }),
            "aria-label": rule.name,
            onClick: (e) => {
              e.stopPropagation();
              setMenuOpen((prev) => !prev);
            },
          }),
        }),
      ],
    });
  }

  // ---------------------------------------------------------------------------
  // 规则配置抽屉表单（与 scheduler 的 st / ot 详情面板严格对齐）
  // ---------------------------------------------------------------------------

  const blankDraft = (options, rule) => {
    const defaults = options?.defaultModel || {};
    const modelVal = rule?.action?.provider ? modelKey(rule.action.provider, rule.action.model) : options?.defaultModel ? modelKey(defaults.provider, defaults.model) : ``;
    return {
      id: rule?.id,
      name: rule?.name || ``,
      intervalSec: String(rule?.poll?.intervalSec ?? 180),
      prompt: rule?.action?.prompt || ``,
      model: modelVal,
      permission: rule?.action?.permission || options?.defaultPermission || `workspace-write`,
      workspaceId: rule?.action?.workspaceId || ``,
      timeoutSec: String(rule?.action?.timeoutSec ?? 7200),
      stepsJson: rule ? JSON.stringify(rule.poll?.steps || [], null, 2) : ``,
      eventsExpr: rule ? String(rule.events || ``) : ``,
      enabled: rule ? rule.enabled : true,
    };
  };

  function RuleDetailDrawer({ target, options, runs, rules, onClose, onSaved, notify }) {
    const [activeTab, setActiveTab] = useState(`rule`);
    const [draft, setDraft] = useState(() => blankDraft(options, target?.draft ? undefined : target));
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(``);

    useEffect(() => {
      setDraft(blankDraft(options, target?.draft ? undefined : target));
      setError(``);
    }, [target, options]);

    const update = (patch) => setDraft((prev) => ({ ...prev, ...patch }));

    const modelOptions = useMemo(() => [
      { value: ``, label: `跟随全局默认模型` },
      ...(options?.models || []).map((item) => ({
        value: modelKey(item.provider, item.model),
        label: `${item.provider} / ${item.label || item.model}`,
      })),
    ], [options]);

    const workspaceOptions = useMemo(() => [
      { value: ``, label: `默认/未指定工作区` },
      ...(options?.workspaces || []).map((ws) => ({ value: ws.id, label: ws.title || ws.path })),
    ], [options]);

    const permissionOptions = useMemo(() => (options?.permissions || []).map((item) => ({
      value: item.value, label: item.name || item.value,
    })), [options]);

    const handleSave = async (e) => {
      if (e) e.preventDefault();
      if (busy) return;
      setBusy(true);
      setError(``);
      try {
        let parsedSteps;
        try {
          parsedSteps = JSON.parse(draft.stepsJson || `[]`);
          if (!Array.isArray(parsedSteps) || parsedSteps.length === 0) {
            throw new Error(`至少需要定义一个轮询步骤`);
          }
        } catch (jsonErr) {
          setError(`${t(`jsonInvalid`)}: ${jsonErr.message}`);
          setBusy(false);
          return;
        }

        const { provider, model } = parseModelKey(draft.model);
        const action = {
          prompt: draft.prompt,
          permission: draft.permission,
          timeoutSec: Number(draft.timeoutSec) || 7200,
          notify: true,
          ...(provider ? { provider, model } : {}),
          ...(draft.workspaceId ? { workspaceId: draft.workspaceId } : {}),
        };

        let res;
        if (draft.id) {
          res = await api(`/api/tauri/monitor/rules`, {
            method: `PUT`,
            body: {
              id: draft.id,
              name: draft.name,
              enabled: draft.enabled,
              poll: { intervalSec: Number(draft.intervalSec) || 60, steps: parsedSteps },
              events: draft.eventsExpr,
              action,
            },
          });
        } else {
          res = await api(`/api/tauri/monitor/rules`, {
            method: `POST`,
            body: {
              name: draft.name,
              enabled: draft.enabled,
              poll: { intervalSec: Number(draft.intervalSec) || 180, steps: parsedSteps },
              events: draft.eventsExpr,
              action,
            },
          });
        }

        if (!res?.ok) {
          setError((res?.errors || []).join(`; `) || res?.error || `保存失败`);
          return;
        }
        notify(draft.id ? `规则已更新` : `规则已创建`, `ok`);
        onSaved(res.rule);
      } catch (err) {
        setError(String(err?.data?.error || err?.message || err));
      } finally {
        setBusy(false);
      }
    };

    const filteredRuns = useMemo(() => {
      if (!target?.id) return [];
      return (runs || []).filter((r) => r.ruleId === target.id);
    }, [runs, target]);

    return j.jsxs(`aside`, {
      className: `relative flex flex-1 flex-col h-full min-w-0 min-h-0 bg-[var(--dsw-alias-bg-base)] text-primary`,
      children: [
        // 抽屉头部 Tab
        j.jsxs(`div`, {
          className: `box-border flex shrink-0 items-center justify-between gap-[20px] px-[24px] border-b-[0.5px] border-border-l3 h-[44px] min-h-[44px]`,
          children: [
            j.jsx(ui.SegmentedControl, {
              variant: `underline`,
              value: activeTab,
              options: [
                { value: `rule`, label: t(`ruleTab`) },
                ...(target?.draft ? [] : [{ value: `history`, label: t(`historyTab`) }]),
              ],
              onChange: (v) => setActiveTab(v),
            }),
            j.jsx(ui.Action, {
              variant: `round`,
              icon: j.jsx(ui.Icon, { as: ui.Xmark, size: 16 }),
              "aria-label": `关闭`,
              onClick: onClose,
            }),
          ],
        }),

        // 表单区
        activeTab === `rule`
          ? j.jsxs(`form`, {
              className: `flex flex-1 flex-col min-w-0 min-h-0`,
              onSubmit: handleSave,
              children: [
                j.jsxs(`div`, {
                  className: `flex-1 min-h-0 overflow-auto px-[24px] pt-[24px] pb-[32px] [scrollbar-gutter:stable]`,
                  children: [
                    error ? j.jsx(ui.Text, { tone: `error`, role: `alert`, className: `mb-[16px] block`, children: error }) : null,

                    // 规则名称
                    j.jsx(`header`, {
                      className: `flex items-start gap-[10px] mb-[16px]`,
                      children: j.jsx(`input`, {
                        className: `flex-1 w-full min-w-0 min-h-[36px] p-0 border-none outline-none bg-transparent text-primary [font-family:inherit] text-[20px] leading-[28px] font-medium hover:shadow-[0_1px_var(--dsw-alias-border-l3)] focus:shadow-[0_1px_var(--dsw-alias-state-business-primary)] transition-all`,
                        type: `text`,
                        required: true,
                        value: draft.name,
                        placeholder: t(`ruleNamePlaceholder`),
                        onChange: (e) => update({ name: e.target.value }),
                      }),
                    }),

                    // 核心参数
                    j.jsxs(`div`, {
                      className: `flex flex-col px-[14px] border-[0.5px] border-border-l3 rounded-[16px] mb-[20px] bg-[var(--dsw-alias-bg-hover)]/30`,
                      children: [
                        j.jsx(FormRow, {
                          label: t(`pollInterval`),
                          children: j.jsx(`input`, {
                            className: `bg-transparent text-right outline-none text-[13px] border-none text-primary`,
                            type: `number`,
                            min: 10,
                            required: true,
                            value: draft.intervalSec,
                            onChange: (e) => update({ intervalSec: e.target.value }),
                          }),
                        }),
                        j.jsx(FormRow, {
                          label: t(`enabled`),
                          children: j.jsx(ui.Checkbox, {
                            checked: draft.enabled,
                            onChange: (e) => update({ enabled: e }),
                          }),
                        }),
                      ],
                    }),

                    // 步骤与表达式
                    j.jsxs(`details`, {
                      open: true,
                      className: `mb-[20px]`,
                      children: [
                        j.jsx(`summary`, {
                          className: `mb-[8px] text-tertiary text-[13px] leading-[20px] cursor-pointer font-medium select-none`,
                          children: t(`stepsGroup`),
                        }),
                        j.jsxs(`div`, {
                          className: `flex flex-col gap-[14px] p-[16px] border-[0.5px] border-border-l3 rounded-[16px] bg-[var(--dsw-alias-bg-hover)]/20`,
                          children: [
                            j.jsxs(`div`, {
                              className: `flex flex-col gap-[6px]`,
                              children: [
                                j.jsx(`span`, { className: `text-[12px] text-secondary font-medium`, children: t(`stepsJson`) }),
                                j.jsx(`textarea`, {
                                  className: `box-border w-full min-h-[140px] rounded-[10px] border border-border-l3 bg-[var(--dsw-alias-bg-base)] p-[10px] text-[12px] font-mono leading-[1.5] outline-none focus:border-[var(--dsw-alias-border-focus)] transition-colors`,
                                  placeholder: t(`stepsPlaceholder`),
                                  required: true,
                                  value: draft.stepsJson,
                                  onChange: (e) => update({ stepsJson: e.target.value }),
                                }),
                              ],
                            }),
                            j.jsxs(`div`, {
                              className: `flex flex-col gap-[6px]`,
                              children: [
                                j.jsx(`span`, { className: `text-[12px] text-secondary font-medium`, children: t(`eventsExpr`) }),
                                j.jsx(`textarea`, {
                                  className: `box-border w-full min-h-[80px] rounded-[10px] border border-border-l3 bg-[var(--dsw-alias-bg-base)] p-[10px] text-[12px] font-mono leading-[1.5] outline-none focus:border-[var(--dsw-alias-border-focus)] transition-colors`,
                                  placeholder: t(`eventsPlaceholder`),
                                  required: true,
                                  value: draft.eventsExpr,
                                  onChange: (e) => update({ eventsExpr: e.target.value }),
                                }),
                              ],
                            }),
                          ],
                        }),
                      ],
                    }),

                    // 唤醒指令
                    j.jsxs(`details`, {
                      open: true,
                      className: `mb-[20px]`,
                      children: [
                        j.jsx(`summary`, {
                          className: `mb-[8px] text-tertiary text-[13px] leading-[20px] cursor-pointer font-medium select-none`,
                          children: t(`prompt`),
                        }),
                        j.jsx(`textarea`, {
                          className: `box-border w-full min-h-[120px] rounded-[12px] border border-border-l3 bg-[var(--dsw-alias-bg-base)] p-[12px] text-[13px] font-mono leading-[1.6] outline-none focus:border-[var(--dsw-alias-border-focus)] transition-colors`,
                          placeholder: t(`promptPlaceholder`),
                          value: draft.prompt,
                          onChange: (e) => update({ prompt: e.target.value }),
                        }),
                      ],
                    }),

                    // 高级选项
                    j.jsxs(`details`, {
                      className: `mb-[20px]`,
                      children: [
                        j.jsx(`summary`, {
                          className: `mb-[8px] text-tertiary text-[13px] leading-[20px] cursor-pointer font-medium select-none`,
                          children: t(`optionsGroup`),
                        }),
                        j.jsxs(`div`, {
                          className: `flex flex-col px-[14px] border-[0.5px] border-border-l3 rounded-[16px] bg-[var(--dsw-alias-bg-hover)]/20`,
                          children: [
                            j.jsx(FormRow, {
                              label: t(`model`),
                              children: j.jsx(ui.Select, {
                                variant: `seat`,
                                value: draft.model,
                                options: modelOptions,
                                onChange: (v) => update({ model: v }),
                              }),
                            }),
                            j.jsx(FormRow, {
                              label: t(`permission`),
                              children: j.jsx(ui.Select, {
                                variant: `seat`,
                                value: draft.permission,
                                options: permissionOptions,
                                onChange: (v) => update({ permission: v }),
                              }),
                            }),
                            j.jsx(FormRow, {
                              label: t(`workspace`),
                              children: j.jsx(ui.Select, {
                                variant: `seat`,
                                value: draft.workspaceId,
                                options: workspaceOptions,
                                onChange: (v) => update({ workspaceId: v }),
                              }),
                            }),
                            j.jsx(FormRow, {
                              label: t(`timeout`),
                              children: j.jsx(`input`, {
                                className: `bg-transparent text-right outline-none text-[13px] border-none text-primary`,
                                type: `number`,
                                min: 60,
                                value: draft.timeoutSec,
                                onChange: (e) => update({ timeoutSec: e.target.value }),
                              }),
                            }),
                          ],
                        }),
                      ],
                    }),
                  ],
                }),

                // 底部保存条
                j.jsxs(`footer`, {
                  className: `flex shrink-0 items-center justify-end gap-[10px] px-[24px] py-[16px] border-t-[0.5px] border-border-l4 bg-[var(--dsw-alias-bg-base)]`,
                  children: [
                    j.jsx(ui.Button, { disabled: busy, onClick: onClose, children: t(`cancel`) }),
                    j.jsx(ui.Button, { variant: `primary`, type: `submit`, disabled: busy, children: t(`save`) }),
                  ],
                }),
              ],
            })
          : // 历史记录列表
            j.jsx(`div`, {
              className: `flex-1 min-h-0 overflow-auto p-[24px]`,
              children: filteredRuns.length === 0
                ? j.jsx(ui.Text, { tone: `tertiary`, size: `sm`, children: t(`noRuns`) })
                : j.jsx(`ul`, {
                    className: `m-0 p-0 list-none flex flex-col gap-[10px]`,
                    children: filteredRuns.map((run) =>
                      j.jsxs(`li`, {
                        className: `flex flex-col gap-[6px] rounded-[10px] border border-border-l3 p-[12px] bg-[var(--dsw-alias-bg-hover)]/30`,
                        children: [
                          j.jsxs(`div`, {
                            className: `flex items-center gap-[8px] text-[13px]`,
                            children: [
                              j.jsx(RunStatusTag, { status: run.status }),
                              j.jsx(`span`, { className: `text-tertiary text-[12px]`, children: fmtTime(run.startedAt) }),
                              j.jsx(`span`, { className: `ml-auto text-[12px] text-tertiary`, children: fmtDuration(run) }),
                            ],
                          }),
                          run.summary ? j.jsx(`div`, { className: `text-[12px] text-secondary font-mono leading-[1.6] whitespace-pre-wrap break-all`, children: run.summary }) : null,
                          run.error ? j.jsx(`div`, { className: `text-[12px] text-error font-mono leading-[1.6] break-all`, children: run.error }) : null,
                          run.sessionId ? j.jsx(`div`, { className: `text-[11px] text-tertiary font-mono truncate`, children: `Session: ${run.sessionId}` }) : null,
                        ],
                      }, run.id),
                    ),
                  }),
            }),
      ],
    });
  }

  // ---------------------------------------------------------------------------
  // 主面板（双栏响应式：左侧规则列表，右侧抽屉式编辑与历史记录）
  // ---------------------------------------------------------------------------

  function MainMonitorPanel() {
    const [selectedTarget, setSelectedTarget] = useState(null);
    const [searchKeyword, setSearchKeyword] = useState(``);
    const [toast, setToast] = useState(null);
    const { rules, options, runs, error, reload } = useMonitorData(true);

    const notify = useCallback((text, kind = `info`) => {
      setToast({ text, kind, seq: Date.now() });
    }, []);

    useEffect(() => {
      if (!toast) return undefined;
      const timer = setTimeout(() => setToast(null), 3500);
      return () => clearTimeout(timer);
    }, [toast]);

    const filteredRules = useMemo(() => {
      if (!rules) return [];
      if (!searchKeyword.trim()) return rules;
      const kw = searchKeyword.trim().toLowerCase();
      return rules.filter((r) => String(r.name || ``).toLowerCase().includes(kw));
    }, [rules, searchKeyword]);

    return j.jsxs(`section`, {
      className: `flex w-full h-full min-w-0 min-h-0 overflow-hidden bg-[var(--dsw-alias-bg-base)]`,
      children: [
        // 左栏：规则列表
        j.jsx(`div`, {
          className: selectedTarget ? `flex-1 min-w-0 min-h-0 max-[760px]:hidden` : `flex-1 min-w-0 min-h-0`,
          children: j.jsx(ui.Panel, {
            children: j.jsxs(`div`, {
              className: `box-border font-sans text-primary text-[13px] leading-[1.5] p-[20px] max-w-[840px] mx-auto`,
              children: [
                // 页面头
                j.jsxs(`header`, {
                  className: `flex justify-between items-start gap-[16px] mb-[16px]`,
                  children: [
                    j.jsxs(`div`, {
                      className: `min-w-0`,
                      children: [
                        j.jsx(`h1`, { className: `m-0 text-[20px] leading-[28px] font-medium`, children: t(`title`) }),
                        j.jsx(`p`, { className: `mt-[4px] mx-0 mb-0 text-secondary text-[13px] leading-[20px]`, children: t(`subtitle`) }),
                      ],
                    }),
                    j.jsxs(`div`, {
                      className: `flex justify-end items-center gap-[10px]`,
                      children: [
                        j.jsx(ui.Button, {
                          variant: `ghost`,
                          size: `sm`,
                          icon: j.jsx(ui.Icon, { as: ui.ArrowRotateRight, size: 14 }),
                          onClick: () => void reload(),
                          children: t(`refresh`),
                        }),
                        j.jsx(ui.Button, {
                          variant: `primary`,
                          size: `sm`,
                          icon: j.jsx(ui.Icon, { as: ui.Plus, size: 14 }),
                          onClick: () => setSelectedTarget({ draft: true }),
                          children: t(`create`),
                        }),
                      ],
                    }),
                  ],
                }),

                // 搜索框
                j.jsx(`div`, {
                  className: `flex justify-between items-center mb-[16px]`,
                  children: j.jsx(ui.Input, {
                    className: `flex-[0_1_320px] min-w-0 max-w-[320px]`,
                    type: `search`,
                    icon: j.jsx(ui.Icon, { as: ui.Magnifier, size: 14 }),
                    "aria-label": t(`searchPlaceholder`),
                    placeholder: t(`searchPlaceholder`),
                    value: searchKeyword,
                    onChange: (e) => setSearchKeyword(e.target.value),
                  }),
                }),

                error ? j.jsx(ui.Text, { tone: `error`, role: `alert`, className: `mb-[16px] block`, children: error }) : null,

                rules === null
                  ? j.jsx(ui.Text, { size: `sm`, tone: `tertiary`, className: `py-[48px] text-center block`, children: t(`loading`) })
                  : filteredRules.length === 0
                  ? j.jsx(ui.Text, {
                      size: `sm`,
                      tone: `tertiary`,
                      className: `py-[48px] text-center block`,
                      children: searchKeyword ? t(`noMatch`) : t(`emptyRules`),
                    })
                  : j.jsx(ui.Card.List, {
                      className: `gap-[10px]`,
                      children: filteredRules.map((rule) =>
                        j.jsx(RuleItemCard, {
                          rule,
                          options,
                          isSelected: selectedTarget?.id === rule.id,
                          onSelect: (item) => setSelectedTarget(item),
                          onAction: reload,
                          notify,
                        }, rule.id),
                      ),
                    }),
              ],
            }),
          }),
        }),

        // 右栏：抽屉详情编辑/历史
        selectedTarget
          ? j.jsx(`div`, {
              className: `flex flex-[0_0_48%] min-w-0 min-h-0 border-l-[0.5px] border-border-l4 max-[760px]:flex-1 max-[760px]:border-l-0`,
              children: j.jsx(RuleDetailDrawer, {
                target: selectedTarget,
                options,
                runs,
                rules,
                onClose: () => setSelectedTarget(null),
                onSaved: async () => {
                  setSelectedTarget(null);
                  await reload();
                },
                notify,
              }),
            })
          : null,

        // 全局 Toast 提示
        toast
          ? j.jsx(ui.Toast, {
              text: toast.text,
              icon: j.jsx(ui.Icon, { as: toast.kind === `error` ? ui.TriangleExclamation : ui.Check }),
              onDone: () => setToast(null),
            }, toast.seq)
          : null,
      ],
    });
  }

  function MonitorNavIcon({ size }) {
    return j.jsx(ui.Icon, { as: ui.Alarm, size, "aria-hidden": `true` });
  }

  // ---------------------------------------------------------------------------
  // 注册（与 scheduler 保持一致）
  // ---------------------------------------------------------------------------

  const registerPanel = dsh.defineRegister((ctl, ctx) => {
    const handle = dsh.definePanel(ctx, {
      id: NS,
      order: 31,
      locale: T.NS,
      label: () => T.text(`title`),
      icon: (props) => j.jsx(MonitorNavIcon, { size: props?.size ?? 16 }),
      render: MainMonitorPanel,
    });
    ctl.add(() => handle.dispose());
  });

  function apply(ctx) {
    ctx.effect(T.registerLocale, `${NS}: locale`);
    ctx.effect(registerPanel, `${NS}: panel`);
  }

  return { apply, inject: [`slots`, `layout`, `locale`, `sessions`, `workspaces`], name: NS };
} });
