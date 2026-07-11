# 创投社区数字分身对话调试器

一个用于验证“分层提示词 → 双 Agent 投融资初筛对话 → 结构化公共结果与私有记忆”完整链路的桌面端 Web MVP。

## 已实现

- 投资人、创业者两套可编辑资料与五层提示词；层级开关、字符/Token 粗估、恢复默认和最终组合预览。
- 固定运行快照，按一来一回计算轮次，支持暂停、继续、停止、重置和按原快照重新生成。
- OpenAI API 兼容的服务端模型代理；API Key 不会发送到浏览器。
- 对话 JSON 控制字段、提前结束规则、JSON 代码块提取与一次模型修复。
- 独立的公共评估器、投资人私有记忆、创业者私有记忆。
- 调试记录包含提示词、资料快照、历史、原始响应、解析结果、耗时、Token、成本和错误。
- 本地自动保存配置、命名版本和最近 20 条模拟记录；支持导入、导出、复制和编辑 JSON。
- 服务端登录校验、HttpOnly 签名会话、SameSite Cookie 与登录失败限流。
- 每个 Agent 独立的服务器私有文件库，支持 PDF、DOCX、TXT、Markdown、CSV 上传、解析、分块与持久化。
- 真实的 `search_private_files` 模型工具调用；服务端强制按 Agent 角色隔离文件作用域并记录完整工具调试轨迹。

## 本地运行

1. 复制环境变量：

   ```bash
   cp .env.example .env
   ```

2. 在 `.env` 中填写 `API_KEY`、`BASE_URL`、`MODEL`。项目也兼容 `OPENAI_API_KEY`、`OPENAI_BASE_URL`、`OPENAI_MODEL`。
3. 安装并启动：

   ```bash
   npm install
   npm run dev
   ```

4. 打开终端输出的本地地址。演示账号默认为 `user`，密码为 `test`。

生产或公网部署前，必须修改 `AUTH_PASSWORD`，并将 `AUTH_SESSION_SECRET` 设为至少 32 字节的高熵随机值。`user/test` 只用于本地演示，不应视为安全的生产凭据。限流为单实例内存级 MVP 实现；多实例部署应接入共享限流存储或网关策略。

## 环境变量

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `API_KEY` / `OPENAI_API_KEY` | 是 | OpenAI 兼容服务的 API Key，仅服务端使用；简写变量优先 |
| `BASE_URL` / `OPENAI_BASE_URL` | 是 | 例如 `https://api.openai.com/v1`，服务端会请求 `/chat/completions` |
| `MODEL` / `OPENAI_MODEL` | 是 | 两个 Agent、评估器和 JSON 修复共用的模型名 |
| `OPENAI_TIMEOUT_MS` | 否 | 单次请求超时，默认 90000ms |
| `AUTH_USERNAME` | 否 | 登录账号，默认 `user` |
| `AUTH_PASSWORD` | 否 | 登录密码，默认 `test`；部署前必须修改 |
| `AUTH_SESSION_SECRET` | 强烈建议 | 会话 HMAC 密钥；部署时必须设置随机值 |
| `DATA_DIR` | 否 | 文件、SQLite 元数据与索引目录，默认项目下的 `data/` |

成本单价因兼容服务不同而异，因此由页面“成本估算单价”本地配置，默认值为 0，并明确作为估算。

## 数据与安全边界

- 配置、版本、模拟记录与生成结果按需求保存在当前浏览器 `localStorage`；文件元数据和检索分块使用服务器本地 SQLite。
- 上传文件、解析片段和检索元数据保存在服务器 `DATA_DIR`；默认是项目下的 `data/`，该目录不会进入 Git。
- 页面刷新会恢复未清除的本地数据；清理浏览器站点数据会删除它们。
- 所有模型调用经过 `/api/model`，并要求有效的服务端会话。
- 本项目用于产品概念验证，不作真实投资、融资、签约或估值决策。

## 构建

```bash
npm run build
```

## 文件工具

投资人与创业者分别拥有独立文件库。工具层开启时，对话模型可以调用：

```text
search_private_files(query, top_k)
```

文件搜索在服务端执行。Agent 角色由当前对话节点绑定，模型不能通过工具参数改成另一角色。双方私有记忆后处理仍只能检索各自的文件库；中立评估器不能访问任何私有文件，只能使用公开资料及对话中已经表达的信息。

模拟开始时会冻结双方可用文件 ID、哈希和索引状态。模拟运行期间上传与删除功能会锁定；重新生成沿用原文件快照。

## Docker 部署

部署前至少修改 `.env` 中的登录密码和会话密钥，然后运行：

```bash
docker compose up -d --build
```

Compose 使用名为 `venture-agent-data` 的持久化卷保存 `/app/data`。更新镜像或重启容器不会删除文件。正式对外提供服务时还应在容器前配置 HTTPS 反向代理，并备份该数据卷。
