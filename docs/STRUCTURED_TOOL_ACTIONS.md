# 结构化工具调用（2026-09-26）

本次为工具调用协议的破坏性升级，不保留旧命令字符串执行入口。

## 调用协议

模型步骤使用以下两种互斥 action。工具参数是 JSON 对象，不经过 Shell 分词、命令拼接或 CLI 参数解析。

```json
{"action":{"type":"tool","toolId":"files.read_content","arguments":{"path":"/app/package.json","maxBytes":65536}},"validation":""}
```

```json
{"action":{"type":"shell","command":"pwd"},"validation":""}
```

以上仅展示执行字段，其余步骤字段仍须满足计划契约。Shell 变更仍需独立只读 validation。工具步骤拒绝夹带 command、validation 命令、validator 或会话变更，结果直接形成结构化证据。

Rust 模型响应不接受顶层 command。内部 PlanStep.command 仅保存 Shell action 的执行投影，以及历史记录的展示文本；工具步骤该值为空。旧 opsark-tool 字符串不会转换成工具调用，也不会作为工具分发。恢复含旧格式的未完成计划时保留历史证据、清除旧审批并要求重新规划。

## Schema 与授权

- Core 目录是输入协议和副作用分类的来源；模型上下文及 Admin 基线从该目录产生。
- Core 使用 Ajv Draft-07，Admin 使用 jsonschema Draft7Validator。启动编译 Schema，校验 required、枚举、范围、pattern、additionalProperties 及 oneOf/anyOf/not 条件。
- 默认值在计划确认前补齐；执行时再次校验。验证器不转换类型、不删除未知参数。跨字段条件失败不授权任意单字段自动修复。
- server.connect 要求 credentialRef，或 username 与 passwordSecretKey 同时存在。路径、软件名、非空表单字段和 select 的 options 条件在分发前校验。
- read/change/interaction 分类由内置目录固定，不能通过本地覆盖修改；变更工具不能伪装成 observe。
- 审批快照包含完整 action；工具 ID、参数或规范化默认值改变后重新检查审批。执行入口核对传入调用与当前步骤，异步策略检查后再次核对。
- 严格输出模式用 null 表示省略的可选字段时，条件中的 required 同时排除 null，保证表单 oneOf/not 和凭据 anyOf 仍按“实际提供了字段”的含义工作；接收后还原省略字段再校验原始契约。

## 失败处理

工具生命周期统一记录尝试次数、错误码、category 和 dispatchState。适配器可以通过 ToolExecutionError 明确提供失败类别、发送状态和 retryAfterMs；无法确定发送状态的错误保守记为 unknown。

| 情况 | 自动处理 |
| --- | --- |
| 只读工具，network/timeout/rate_limit | 最多共 3 次尝试；默认等待 500 ms、1500 ms；适配器等待提示最多 30 秒 |
| 参数、认证、权限、不可用或业务错误 | 不自动重试 |
| 变更工具失败，包括发送状态未知 | 不自动重放，保留证据并进入待调整 |
| 等待重试期间取消 | 不再派发下一次调用 |
| 重试耗尽 | 当前步骤失败，任务 needs_adjustment，不自动跳过后继续 |

每次派发（包括等待后的重试）都核对目标服务器、连接代次、步骤身份、参数和当前审批。任何一项变化均停止本次调用，不能把旧调用转移到新连接或修改后的计划。

未知字符串错误不会因为模糊关键词而获得自动重试权限；现有 SSH 适配器仅保留明确建连失败前缀的分类。后续适配器应直接提供类型化错误。

## 验证入口

Core：`npm run build`、`npm test -- --run`、`cargo test --lib --manifest-path src-tauri/Cargo.toml`。

目录一致性：`node scripts/export-official-catalog.mjs --check`。

Admin：`.venv/bin/python -m pytest tests/test_official_content.py -q`。
