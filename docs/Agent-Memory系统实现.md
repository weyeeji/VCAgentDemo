# Agent Memory 与连续对接系统

## 1. 目标

系统把 Agent 状态分为三层：

- Agent 全局记忆：对该 Agent 的所有工作场景生效。
- 对手方记忆：通过 `counterparty_id` 只对当前投资人/创业者关系生效。
- 连续对接上下文：同一对 Agent 的累计摘要、最近发言和 episode 链路。

用户与自己的 Agent 对话，以及 Agent 与 Agent 的模拟，都会维护同一套结构化 Memory。Agent 可以自主查询、新增、修改、归档和恢复记忆，不需要用户逐项审批；所有写入仍由平台校验并记录审计事件。

## 2. 连续对接

同一投资人 Agent 与创业者 Agent 对应一条稳定的 `relationshipId`。每次点击模拟仍创建新的 `conversationId`，因此运行快照、调试记录和结果互不覆盖，但新 episode 会读取：

- 双方最新的全局记忆；
- 双方针对当前对方的记忆；
- 上一次累计关系摘要；
- 最近 12 条双方公开发言。

界面在已有历史时默认显示“继续模拟”。“开启新话题”仍保留双方长期 Memory，但本次不注入上一次摘要和最近发言。“按原快照重新生成”使用原来的配置、文件、Memory 和连续对接快照，不写回 Memory，也不增加关系 episode。

关系存储包含两张表：

- `agent_relationships`：当前累计状态、episode 数量、最后一次会话和版本。
- `agent_relationship_episodes`：每次完成的会话 ID、序号、摘要、最近发言和完成时间。

完成写入以 `conversation_id` 幂等，同一会话重试不会重复增加 episode。

## 3. Memory 与任务数据

### `agent_memories`

关键字段：

- `scope_id + agent_id`：基本隔离边界。
- `kind`：`fact / preference / decision / constraint / note`。
- `verification`：`confirmed / unverified / conflicted`。
- `status`：`active / superseded / archived / deleted`。
- `counterparty_id`：为空表示全局记忆，否则只属于指定对接对象。
- `source_type + source_id`：来源和幂等键。
- `version`：更新、归档和恢复使用的乐观锁版本。

### `agent_tasks`

任务支持待办、进行中、阻塞、完成和取消，也可绑定对手方或来源 Memory。Working Context 只注入活动任务。

### 审计与批次

- `agent_state_events` 保存每次变更的前后值、来源和时间。
- `agent_action_batches` 保存成功提交的行动批次；相同来源重试直接返回第一次结果。
- 删除采用归档，Agent 和用户都可恢复，不做不可逆物理删除。

## 4. 用户与自己 Agent 的对话

每次发送消息前，系统重新读取该 Agent 最新 Working Context。模型还可以调用只读的 `search_agent_memory` 工具，按关键词查询当前 Agent 的活动或归档记忆，并获得操作所需的 ID 与版本。

回复 JSON 可以包含：

```json
{
  "message": "明白，我已经更新了投资偏好。",
  "control": {
    "suggest_end": false,
    "end_reason": null,
    "information_sufficient": true
  },
  "actions": [
    {
      "id": "update-stage-preference",
      "type": "memory.update",
      "reason": "用户明确调整投资阶段",
      "memoryId": "memory_xxx",
      "input": {
        "content": "重点关注 Pre-A 至 A 轮",
        "expectedVersion": 2
      }
    }
  ]
}
```

回复成功解析后，平台自动原子执行 `actions`。界面展示操作类型、理由、结果和失败信息，不再要求用户确认。失败批次可以幂等重试。

直聊产生的 Memory 规则：

- 用户明确表达的事实、偏好、约束和决策可写为 `confirmed`。
- 文件内容、引用文字、历史记忆或 Agent 自己的推断不能自动升级为用户确认指令。
- Agent 只能操作当前 Agent 作用域，不能通过参数切换到另一个 Agent。

## 5. 双 Agent 模拟后的记忆维护

模拟开始时冻结双方 Working Context，运行过程中不修改该快照。对话结束后，双方分别执行一次记忆维护，输出最多 12 个 `memory.create / memory.update / memory.archive / memory.restore` 操作。

模拟写入受到额外限制：

- 新记忆强制为 `unverified`，冲突可保留为 `conflicted`。
- 不能修改、归档或恢复 `confirmed` 记忆。
- 只能维护当前对接对象的关系记忆，不能影响其他对手方或全局记忆。
- 创建操作由服务端强制绑定当前 `counterparty_id`。
- 整批操作原子执行，版本冲突时不会静默覆盖。

旧版 `{"memories": [...]}` 提取结果仍可兼容，会被转换成 `memory.create` 行动。

## 6. Working Context

服务端把 Memory 和任务编译为 `WorkingContextSnapshot`：

- 已确认的 decision、preference、constraint 进入“已确认决策与偏好”。
- 活动任务进入“当前任务”。
- 未核实事实、冲突项和历史内容进入参考区。
- 双 Agent 模拟只选择全局项和当前对手方项。
- 内容带 ID、版本、优先级和核实状态，方便 Agent 自主维护。
- 提示词投影上限为 18,000 字符，超出时优先保留高优先级内容。

连续对接摘要属于双方已经看过的公开对话历史；双方各自的私有 Memory 不会进入对方提示词。

## 7. 持久化作用域

旧版本使用浏览器生成的 `scope_id`。现在服务端将旧作用域一次性迁移到稳定的工作区作用域 `workspace-default-v1`，因此清理浏览器存储或换浏览器后仍可读取同一工作区的 Agent Memory 和连续对接状态。

当前产品仍是单一共享工作区，不是多租户系统。若支持多个账号或租户，应把稳定作用域替换为服务端认证得到的 `tenant_id + workspace_id`，不能继续使用固定值。

## 8. 主要接口

| 方法 | 路由 | 用途 |
| --- | --- | --- |
| `GET/POST` | `/api/memories` | 查询或创建 Memory |
| `GET/PATCH/DELETE` | `/api/memories/:id` | 读取、修改、恢复或归档 Memory |
| `GET/POST` | `/api/tasks` | 查询或创建任务 |
| `PATCH/DELETE` | `/api/tasks/:id` | 修改或取消任务 |
| `POST` | `/api/agent-actions` | 自动原子执行 Agent 行动批次 |
| `GET` | `/api/agent-context` | 生成最新 Working Context |
| `GET/POST` | `/api/relationships` | 查询、创建或完成连续对接 episode |
| `POST` | `/api/model` | 模型调用及私有文件/记忆只读工具循环 |

## 9. 代码位置

- `lib/memory-store.ts`：Memory、任务、审计、幂等批次和旧作用域迁移。
- `lib/memory-context.ts`：Working Context 筛选与提示词投影。
- `lib/relationship-store.ts`：连续对接关系和 episode。
- `app/api/agent-actions/route.ts`：自主行动校验与执行边界。
- `app/api/relationships/route.ts`：关系读取和完成接口。
- `app/api/model/route.ts`：`search_agent_memory` 与私有文件工具。
- `lib/defaults.ts`：连续对接、直聊行动和模拟记忆维护提示词。
- `app/DemoApp.tsx`：运行编排、自动执行、关系续接和 UI。

## 10. 验证

```bash
npm run test:unit
npm run lint
npm run build
```

测试覆盖 Memory CRUD、恢复、幂等、批量回滚、模拟核实边界、连续 episode 和完成幂等。生产构建同时执行 TypeScript 校验。
