# Agent 上下文与 Token 优化记录

> 创建日期：2026-09-02  
> 记录规则：每次优化单独编号，同时记录“用户真实需求”和“代码真正落地的方案”。后续修改只追加新记录，不用新设计覆盖旧记录。

## 第 1 次：单步骤复核与整体目标复核减量

### 用户需求

- 优化单步骤复核和整体目标复核。
- 不再在复核时反复发送完整终端输出、完整计划和重复的用户需求。
- 保留足够的失败证据，不能因减量造成误判。

### 真正修改的方案

1. 新增 `src/features/agent/reviewPayload.ts`，统一处理复核字段的长度、结构化结果、证据数量、输出指纹和关键异常行。
2. 单步骤复核不再在 JSON 内重复携带外层已传入的用户目标，不再同时发送 `fullPlan`、`remainingSteps` 和重复的步骤全量。
3. 单步骤历史最多发送最近 6 步，待执行步骤最多发送前 6 步，并额外发送计划状态计数，让模型知道有多少内容被省略。
4. 成功历史步骤不再携带大段原始输出；失败、证据冲突和后置校验失败保留有界的头尾内容、关键错误行、长度和指纹。
5. 整体目标复核不再发送无界的当前轮完整 ledger，Skill 验收说明也有独立长度上限。
6. Rust 端复核 system prompt 删除与 JSON 上下文重复的大段规则，保留决策硬边界和严格 JSON 结构。

### 实际边界

- 单步骤失败的当前命令、结果、输出窗口和证据仍会发给模型。
- 本地任务审计记录仍保留原始步骤；“模型上下文减量”不等于“删除本地执行记录”。

## 第 2 次：整体复核和调整计划共用基础上下文

### 用户需求

- 整体目标复核和调整计划使用同一套基础上下文。
- 最近历史希望按“最近两个执行阶段”组织，而不是把步骤从不同轮次中随意截取。
- 更旧的计划步骤和总结应当压缩成一条可持续更新的历史记录，避免调整次数越多、每次输入越大。
- “已验证事实”只能来自真实 `result/evidence`，不能把计划描述或模型阶段总结当作成功证据。
- 在共用上下文之外继续完善 Token 上限、输出截断、Skill/Tool 说明减量和省略历史可追溯性。

### 真正修改的方案

1. 新增 `src/features/agent/taskDecisionSnapshot.ts`，定义整体复核和普通调整计划共用的 `baseSnapshot`。
2. 整体复核只生成一次 `baseSnapshot`。当结论是 `adjust` 时，快照和复核结论写入任务的 `latestGoalReview`；下一次调整计划直接复用，不再从全部历史重新拼一套。
3. `baseSnapshot` 仅保留：
   - 任务状态、权限和执行约束。
   - 结构化进度计数。
   - 当前失败或阻断事件的有界详情。
   - 当前计划的有界步骤。
   - 当前需求轮内最近 2 个已归档执行阶段。
   - 更旧历史的滚动检查点。
   - 被压缩历史的轮次数、阶段数、步骤数和指纹。
4. 当前计划超过 20 步时，优先保留前 3 步、异常步骤（最多 8 步）、即将执行的步骤（最多 6 步）和最近步骤，总数不超过 20。当前事件单独展开，不在步骤列表里重复。
5. 每个最近执行阶段最多发送 12 个步骤。成功步骤只发送结构化结果、证据事实、输出长度和指纹，不发送原始输出；异常步骤才发送有界输出和关键错误行。
6. 新增 `src/features/agent/taskHistoryCheckpoint.ts`，将离开“最近 2 个阶段”窗口的旧阶段增量合并到任务内的结构化检查点：
   - 最多 12 条有 `result/evidence` 支持的已验证事实。
   - 最多 8 条异常/未解决问题及同命令尝试次数。
   - 最多 4 条旧阶段状态摘要。阶段的自然语言总结仅作导航，不变成已验证事实。
   - 累计轮次、阶段、步骤和状态计数，以及对已压缩来源的指纹。
7. 滚动检查点采用本地确定性结构化合并，而不是每次再调一次大模型生成“摘要的摘要”。它达到递归二次压缩的体积效果，同时不新增摘要 Token，不会因多次自然语言转述累积事实漂移。
8. 调整计划仅在共用快照之外增加 `adjustmentTrigger`、当前有界的 Tool 目录和已激活 Skill 说明：Tool 的名称、描述、用法和输出说明分别限长，Skill 说明最多 2,200 字符。
9. 调整原因和整体复核的 `decision/reason/summary` 都有独立长度上限，不再夹带整份复核对话。
10. 安全门禁拒绝是特例：它只发送命中字段、结构化规则和相邻步骤标题，不附加通用快照，避免把不相关命令和原始输出发给局部修复请求。
11. 快照中的命令会脱敏常见的 token/password/API key 命令行参数、URL 查询参数和 URL userinfo；省略的命令保留指纹供重复尝试判断。

### 共用后两次模型调用的实际区别

| 内容 | 整体目标复核 | 普通调整计划 |
|---|---|---|
| `baseSnapshot` | 生成并发送 | 原样复用 |
| 整体目标 | 作为调用外层 requirement 发送 | 作为调用外层 requirement 发送 |
| Skill | 只发送有界的最终验收说明 | 发送有界的已激活 Skill 计划说明 |
| Tool | 不发送 | 发送有界的已启用 Tool 目录 |
| 复核结论 | 由模型返回 | 只追加有界的 `decision/reason/summary` |
| 调整触发原因 | 不需要 | 追加有界的当前阻断说明 |

### 不发给模型但仍保留的内容

- 完整 `planHistory`、`phaseHistory` 和原始步骤仍留在本地任务审计 ledger，供开发者日志、界面展开和确定性重复命令判断使用。
- 已被检查点吸收的旧输出不再进入整体复核和调整计划的模型请求。
- 保留“被压缩数量 + 指纹”，用于判断历史是真的被省略，而不是记录丢失。

### 验证记录

- 定向 Vitest：`taskGoal` / `agentContext` / `agentService` / `ops` 共 141 项通过，16 项按原配置跳过。
- 专门回归覆盖：快照复用、当前计划 60 步时的有界选取、大输出头尾保留、中间噪声省略、命令敏感参数脱敏、最近 2 阶段与历史检查点分层、安全门禁局部上下文。
- 前端全量 Vitest：80 个测试文件，509 项通过，16 项既有用例按设计跳过。
- TypeScript `vue-tsc --noEmit`、Vite 生产构建、`git diff --check` 和 Rust 格式检查通过。
- Rust 库测试：77 项通过，2 项需显式外部凭据的真实环境用例按设计忽略。

## 第 3 次：修复 EACCES 等子串误匹配导致的错误诊断和额外调用

### 用户需求

- 修复 `EACCES` 误匹配导致的错误诊断和大量额外模型调用。
- 同时排查和修复类似的“日志或资源名中包含某个子串，就被当成真实错误”问题。

### 真正修改的方案

1. 确认真实根因为 Maven 依赖名 `com.google.guava:failureaccess`：`failureaccess` 中的跨单词子串被旧规则 `/EACCES/i` 命中，因此实际的 `NoSuchFieldError`/JDK 兼容性失败被写成 `permission_denied`。
2. `analyzeSkillCommandFailure()` 不再用一组正则扫描整段输出并仅返回分类名，而是：
   - 将输出按行处理，超长日志仅扫描前 200 行和后 2,200 行。
   - 只在 `EACCES/EPERM` 作为独立错误码并出现在 npm errno/code、`Error: EACCES: permission denied`、Python `Errno 13` 或 `AccessDeniedException` 等错误形态中时判定权限错误。
   - 每个确定性分类携带最多 360 字符的真实命中行和 `high/fallback` 置信级别，让后续复核不再只看一个无证据的 category。
3. 新增确定性 JDK 兼容性分类：
   - `NoSuchFieldError` / `NoSuchMethodError` / `IllegalAccessError` 指向 `com.sun.tools.javac` 或 `jdk.compiler` 时，分类为 `jdk_tooling_incompatible`。
   - `UnsupportedClassVersionError`、`class file has wrong version`、`invalid target release` 等分类为 `jdk_version_incompatible`。
4. 同样收紧 `ENOSPC`、command-not-found、网络错误码和 HTTP 404 的匹配，并保留真实证据行；无高置信信号时回退为 `command_failed`，不猜测具体原因。
5. 长任务关键行中的 `error/failure/failed` 改为单词边界匹配，`failureaccess` 不再被当成 critical failure；同时显式保留 `NoSuchFieldError`、`TypeError`、`AccessDeniedException` 等命名异常。
6. SFTP 目录错误码中的 `eacces/enoent` 增加单词边界，不再把文件名或依赖名当成错误码。
7. 调整 incident 不再通过失败步骤的业务原始输出猜测 transport 故障。只有执行器已写入 `terminal_transport/terminal_recovery/validation_protocol_exception`、终端实际 busy，或无失败步骤时的编排层错误才进入 transport 恢复。远程应用日志中的 `connection closed` 仍是 business failure。

### 调用数影响

- 真实命令失败仍会进行一次必要的失败复核，不会为了减少 Token 而把失败当成成功。
- 修复的是“错误 category 成为模型硬事实后，连续生成权限、SELinux、挂载、重试等无关计划”的级联。新分类会直接提供真实 JDK 错误行，让第一次复核和下一次调整面向真实原因。

### 验证记录

- 增加 `failureaccess` 真实 Maven 路径、真实 npm `EACCES`、普通文本 `EACCES`、JDK `NoSuchFieldError`、command-not-found、DNS 失败、HTTP 404、`ENOSPC`、长任务关键行、SFTP 错误码和 business/transport 分类回归。
- 前端全量 Vitest：80 个测试文件，515 项通过，16 项既有用例按设计跳过。
- TypeScript 检查、Vite 生产构建和 `git diff --check` 通过。

## 后续记录模板

```text
## 第 N 次：标题

### 用户需求
- 用户原始目标和关键约束。

### 真正修改的方案
1. 实际改动的模块、数据结构和调用链。
2. 真正生效的上限、例外和兼容策略。

### 验证记录
- 执行的自动化检查和结果。
```
