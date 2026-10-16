# dsh-tauri-monitor

DSH Desktop 通用监控插件：HTTP 轮询规则引擎，条件命中才唤醒 agent，未命中零 LLM 交互（不浪费 token）。架构仿内置 `dsh-tauri-scheduler`，唤醒的是**可在会话列表中看到的常规会话**，执行过程可直接回看与接管。

## 工作模型

```jsonc
{
  "name": "示例：接口错误数超过阈值告警",
  "enabled": true,
  "poll": {
    "intervalSec": 60,                            // 10..86400
    "steps": [                                    // 最多 10 步，串行，变量向后传递
      { "url": "https://api.example.com/metrics",
        "method": "GET", "headers": {}, "body": null,
        "extract": { "errors": "res.data.error_count" },   // JS 表达式，作用域 { res, vars }
        "timeoutMs": 15000 }
    ]
  },
  "events": "vars.errors > 10 ? [{ key: 'err:' + vars.errors, title: '错误数 ' + vars.errors }] : []",
  "action": {
    "prompt": "...",            // 可空 = 通用默认；占位符 {{ruleName}} {{eventsText}} {{events}} {{time}}
    "workspaceId": null,        // 绑定工作区（会话挂到该工作区、可见）
    "permission": "workspace-write",
    "provider": null, "model": null,   // 空 = 用 DSH 默认模型
    "timeoutSec": 3600, "notify": true
  }
}
```

- `events` 表达式作用域 `{ vars, prev, rule }`；`prev` = 上次**成功**轮询的 vars 快照（首次 `undefined` → 约定 `!prev ? [] : ...` 做基线不触发）
- 事件去重：`firedKeys`（key 唯一即可精确控制触发粒度；保留最近 200 个）；只有 run 真正启动才记录 key，基础设施失败下轮自动重试

## 存储

`~/.dsh/monitors/`：`rules.json` / `runs.json`（保留 200 条）/ `state.json`（每规则 vars 快照 + firedKeys + 错误计数）

## HTTP API（guard 保护，仅本机同源可变更）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET/POST/PUT/DELETE | `/api/tauri/monitor/rules` | 规则 CRUD |
| POST | `/api/tauri/monitor/toggle` | `{id}` 启停 |
| POST | `/api/tauri/monitor/test` | `{id}` 干跑一轮：报 vars/events/newEvents，不落状态 |
| POST | `/api/tauri/monitor/fire` | `{id}` 强制触发：轮询一次并立即唤醒（忽略去重） |
| GET | `/api/tauri/monitor/history` | `?limit&offset&ruleId` 运行历史 |
| GET | `/api/tauri/monitor/state` / `options` | 状态 / 可选工作区·权限·模型 |

## Agent 工具

`monitor_rule_create` / `monitor_rule_list` / `monitor_rule_update` / `monitor_rule_delete` / `monitor_rule_test` / `monitor_rule_fire`——对话里直接说"帮我监控某个接口/看看监控状态/手动触发一轮"即可。

## GUI

左侧导航「监控」面板：规则卡片（状态/上次轮询/错误/触发次数）、新建/编辑表单、测试/立即触发/启停/删除、执行记录列表；5 秒自动刷新。

## 行为要点

- 每 1s tick 检查到期规则；轮询与执行按规则互斥；插件重启后 `running` 的 run 标记 `interrupted`
- 轮询连续失败 ≥3 次发 macOS 通知（1h 节流）；轮询失败不覆盖 `prev`（状态不误清）
- 唤醒 = `agents.withoutInitiator` 无主会话 + 工作区 attachSession + 会话标题 `监控·<规则名>`，Desktop 会话列表可见
- 执行超时 `agent.cancel` 中断并收敛 15s；结束摘要取会话 assistant 输出

## 安装

插件市场搜索 **monitor**（category: workflow）一键安装；或：

```bash
dsh plugin --profile <profile> add github:tensor-x/dsh-tauri-monitor
```

（CLI 方式需自行在 profile `package.json` 的 `dsh.profile.bundles` 登记 `dsh-tauri-monitor`。）
