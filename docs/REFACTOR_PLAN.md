# Opsark Core 重构计划

> 编制日期：2026-08-14  
> 目标：在不推倒现有可运行闭环的前提下，优先迁移和完善智能需求处理能力，并为后续终端、SFTP、主题、多语言和交互动效扩展留出清晰边界。

## 1. 重构结论

当前项目不适合推倒重写。现有代码已经具备 Vue + Tauri 桌面架构，服务器管理、SSH/SFTP、终端、实时指标、模型配置、智能任务、步骤审批、敏感变量、执行校验和日志闭环均已存在。

真正需要重构的是智能需求处理的业务边界。当前核心逻辑主要集中在 `src/stores/ops.ts`，该文件同时承担状态持久化、模型上下文组装、计划审批、执行调度、长任务监控、证据校验、敏感变量处理和日志写入。继续在该文件内堆功能会导致维护成本快速上升。

重构策略：

- 保留现有功能入口和数据结构，先保证行为不回退。
- 优先把智能需求处理从 Pinia store 中迁移成独立领域模块。
- 终端和 SFTP 维持最小可用，不在本阶段追求完整仿真。
- UI 风格、多语言、多主题、多色彩和交互动效放在核心逻辑稳定后实施。

## 2. 首要目标

### P0：智能需求处理内核迁移

目标是形成清晰的“需求输入 -> 上下文构建 -> 模型规划 -> 计划审批 -> 步骤执行 -> 证据校验 -> 调整/总结”的领域层。

完成后，Pinia store 只负责：

- 保存服务器、任务、日志、模型和界面状态。
- 调用智能处理服务。
- 将服务返回的状态变更同步到 UI。

业务规则不再散落在 store 内。

### P1：智能处理能力完善

- 补全工具协议，让模型明确知道可用工具、参数、限制和返回形式。
- 将敏感信息管理、用户输入工具、指令合并工具拆成独立服务。
- 增强任务日志，完整记录：
  - 用户需求。
  - 系统提示词上下文摘要。
  - 发送给模型的内容。
  - 模型原始返回。
  - 解析后的计划。
  - 实际发送到服务器的脱敏命令。
  - 服务器返回内容。
  - 每一步复查校验结果。
- 让计划调整只围绕失败步骤和未完成目标生成，避免重复执行已完成步骤。

### P2：界面与体验重构

- 智能控制台 1:1 参考 VSCode Codex 插件的信息层级。
- 增加多语言切换。
- 增加多主题和多色彩定义。
- 增加更灵活的交互动效。
- 统一终端风格，参考 Warp、Tabby、Termius、VSCode Terminal 等现代 shell 工具，但保持运维工具的高信息密度。

## 3. 目标目录结构

建议新增以下目录：

```text
src/
  features/
    agent/
      index.ts
      agentService.ts
      agentContext.ts
      taskMachine.ts
      approvalPolicy.ts
      executionRunner.ts
      evidenceReview.ts
      planNormalizer.ts
      secretTool.ts
      auditTrail.ts
      types.ts
      __tests__/
        approvalPolicy.test.ts
        planNormalizer.test.ts
        taskMachine.test.ts
        secretTool.test.ts
        evidenceReview.test.ts
    server/
      serverService.ts
      metricsService.ts
      serverInfoTools.ts
    terminal/
      terminalService.ts
    files/
      sftpService.ts
    model/
      modelService.ts
      modelPromptContracts.ts
    i18n/
      index.ts
      zh-CN.ts
      en-US.ts
    theme/
      tokens.ts
      palettes.ts
      themeStore.ts
```

Rust 端建议从单一 `lib.rs` 逐步拆成：

```text
src-tauri/src/
  lib.rs
  model.rs
  ssh.rs
  terminal.rs
  sftp.rs
  metrics.rs
  credential.rs
  json_contract.rs
  command_guard.rs
```

拆分原则：先移动代码，不改变行为；每次迁移后运行测试和构建。

## 4. 模块职责

### `agentContext.ts`

负责构建模型上下文：

- 系统固定提示词。
- 服务器物理基本信息。
- 已部署软件环境。
- 最新 CPU、内存、磁盘、网络指标。
- 当前任务历史上下文。
- 用户引用的终端内容。
- 工具清单和参数说明。
- 敏感变量元数据，不包含 value。

要求：

- 所有敏感值必须脱敏或不进入上下文。
- 上下文结构必须可测试。
- 每次模型请求需要生成审计摘要。

### `taskMachine.ts`

负责任务状态机：

```text
draft
  -> planning
  -> awaiting_plan_approval
  -> running
  -> awaiting_step_approval
  -> awaiting_input
  -> validating
  -> needs_adjustment
  -> completed | failed | cancelled
```

要求：

- 状态迁移必须集中定义。
- 不允许 UI 组件直接修改复杂任务状态。
- 每个迁移都要产生可审计事件。

### `approvalPolicy.ts`

负责授权和风险判断：

- `observe`：所有步骤确认。
- `safe`：低风险自动，中高风险确认。
- `autonomous`：低中风险自动，高风险按破坏性规则确认。
- `managed`：计划自动批准，低中风险自动，高风险确认。

要求：

- 高危破坏性命令永远需要单独确认。
- 风险判断规则必须有单元测试。

### `executionRunner.ts`

负责执行步骤：

- 合并敏感占位符。
- 调用 SSH 命令执行。
- 流式输出到终端和任务时间线。
- 支持终止当前执行。
- 支持长任务周期性复核。
- 返回标准执行结果。

要求：

- 实际命令执行和 UI 状态变更解耦。
- 任何日志和 UI 输出必须脱敏。
- 远端执行失败不能被模型改写为成功。

### `evidenceReview.ts`

负责证据链和复查：

- 主命令结果分类。
- validation 命令校验。
- 结构化事实提取。
- 判断是否需要模型异常复核。
- 决定继续、调整或完成。

要求：

- 执行状态和观察状态分离。
- `not_found`、`warning`、`unhealthy` 不能直接等同失败。
- 确定性事实优先于模型判断。

### `secretTool.ts`

负责服务器信息数据管理工具、用户输入工具和指令合并工具：

- 保存敏感变量元数据。
- 值存储到系统钥匙串或后续加密数据库。
- 向模型只暴露 key、description、scope 和 placeholder。
- 当命令包含 `${secret.KEY}` 时请求用户确认或输入。
- 执行时将占位符合并成真实命令。
- 输出、日志、模型上下文全部脱敏。

### `auditTrail.ts`

负责日志事件规范化：

- 任务事件。
- 模型请求和响应。
- 命令执行。
- 服务器连接。
- SFTP 操作。
- 敏感变量变更记录。

要求：

- 日志 detail 支持展开查看。
- 敏感值不得落盘。
- 后续可平滑迁移到 SQLite。

## 5. 迁移步骤

### 阶段一：建立智能处理领域模块

1. 新增 `src/features/agent/` 目录。
2. 先迁移纯函数：
   - 风险审批规则。
   - 上下文裁剪。
   - 敏感占位符解析。
   - 计划标准化。
   - 执行摘要构建。
3. 为纯函数补单元测试。
4. `ops.ts` 保持原行为，只改为调用新模块。

验收：

- `npm test -- --run` 通过。
- `npm run build` 通过。
- 现有智能任务流程 UI 不变。

### 阶段二：迁移模型上下文和需求处理

1. 抽出 `buildAgentContext()`。
2. 抽出 `submitRequirement()` 的上下文构建和任务轮次归档。
3. 抽出模型请求输入输出的审计数据结构。
4. 增强模型请求日志，保存脱敏后的 prompt 摘要和原始返回。

验收：

- 新任务和继续旧任务行为一致。
- 终端引用仍可进入用户提示词。
- 敏感变量值不会进入模型上下文。

### 阶段三：迁移任务状态机

1. 抽出状态迁移函数。
2. 将 `approvePlan`、`rejectTask`、`terminateTask`、`approveStep` 的核心规则迁移到 `taskMachine.ts`。
3. UI 和 store 只调用明确命令：
   - `submitRequirement`
   - `approvePlan`
   - `rejectPlan`
   - `approveStep`
   - `terminateTask`
   - `provideSecret`

验收：

- 状态迁移有测试覆盖。
- 非法状态迁移会被拒绝并记录日志。

### 阶段四：迁移执行和校验

1. 抽出 `executionRunner.ts`。
2. 抽出 `evidenceReview.ts`。
3. 将长任务监控逻辑从 store 中移出。
4. 将模型异常复核输入结构统一定义。
5. 将步骤执行结果和证据写入统一接口。

验收：

- 真实 SSH 命令执行仍有流式输出。
- validation 仍会执行。
- 执行失败、校验失败、用户终止、长任务复核都有稳定表现。

### 阶段五：拆分 Rust 后端

1. 将模型调用和 JSON 契约迁移到 `model.rs`、`json_contract.rs`。
2. 将 SSH 命令、PTY、SFTP、指标和凭据拆分到对应模块。
3. `lib.rs` 只保留 Tauri 插件注册和 command 导出。

验收：

- `cargo check` 通过。
- Tauri command 名称和前端调用参数不变。
- 无行为回退。

### 阶段六：UI、主题和多语言

1. 拆分 `AgentConsole.vue`：
   - `AgentHeader.vue`
   - `TaskList.vue`
   - `ConversationTimeline.vue`
   - `PlanReview.vue`
   - `StepCard.vue`
   - `PermissionSelector.vue`
   - `SecretInputDialog.vue`
2. 建立 `src/features/theme/`：
   - 设计 token。
   - 主题色板。
   - 多色彩定义。
   - CSS 变量注入。
3. 建立 `src/features/i18n/`：
   - 中文。
   - 英文。
   - 后续可扩展。
4. 调整工作台视觉：
   - 左侧 SFTP 简洁可用。
   - 中间终端主视觉更接近现代 shell。
   - 右侧智能控制台参考 VSCode Codex 插件。
   - 底部状态栏展示服务器实时指标。

验收：

- 桌面和窄屏不重叠。
- 主题切换即时生效。
- 语言切换不破坏布局。
- 智能需求处理主流程不受 UI 改造影响。

## 6. 智能需求处理目标流程

目标流程固定为：

1. 用户进入服务器操作页面。
2. 系统连接服务器并采集基础信息。
3. 定时采集 CPU、内存、磁盘、网络。
4. 用户点击开启智能运维。
5. 系统刷新服务器物理信息和软件环境。
6. 用户输入需求。
7. 系统构建模型上下文：
   - 固定系统提示词。
   - 服务器基础信息。
   - 已部署软件环境。
   - 实时指标。
   - 工具说明。
   - 敏感变量元数据。
   - 授权等级。
   - 终端引用内容。
8. 模型返回计划：
   - title。
   - 简要说明。
   - 风险等级。
   - command。
   - validation。
   - expected。
9. 用户确认计划。
10. 系统逐步执行。
11. 每一步根据风险和授权等级决定是否单独确认。
12. 执行输出实时显示到终端和任务时间线。
13. 每一步执行后进行复查校验。
14. 校验不满足时生成调整计划并等待用户确认。
15. 需要敏感输入时调用用户输入工具。
16. 执行完成后生成总结。
17. 所有过程进入日志。

## 7. 工具协议目标

模型可见工具只暴露元数据和调用规则，不暴露真实敏感值。

### 服务器基本信息获取工具

用途：获取 OS、kernel、CPU、核心数、内存、磁盘、uptime、软件环境。

### 服务器实时数据获取工具

用途：获取 CPU、内存、磁盘、网络实时数据。

### 服务器信息数据管理工具

用途：保存数据库账号、数据库密码、Git 账号、Git token 等敏感信息。

约束：

- 模型只能看到 key 和 description。
- 模型不能看到 value。
- value 只在执行期由程序注入。

### 指令合并工具

用途：将 `${secret.KEY}` 合并成服务器可执行指令。

约束：

- 合并后的真实命令不得写入日志。
- UI 和日志只展示脱敏命令。

### 用户输入工具

用途：模型提供 JSON schema，系统生成输入框弹窗。

要求：

- 用户输入后先暂存。
- 步骤复查通过后再正式保存。
- 密码类输入默认不回显。

### 文件数据结构获取工具

用途：获取指定目录的文件结构。

要求：

- 支持排除目录。
- 默认跳过 `.git`、`node_modules`、`vendor`、`dist`、`build`、日志和大文件目录。
- 返回结构需要限制深度和总节点数。

## 8. 数据持久化计划

短期保留现状：

- 服务器、任务、模型元数据、日志摘要保存在 localStorage。
- SSH 密码、模型 API Key、敏感变量值保存在系统钥匙串。

中期迁移：

- 使用 SQLite 存储服务器、任务、日志、模型元数据、工具调用记录。
- 敏感值继续走系统钥匙串或加密字段。
- 日志大文本分表存储，避免 localStorage 膨胀。

迁移要求：

- 先写数据访问接口，不直接在业务模块内调用 localStorage。
- 提供旧数据导入脚本。
- 不破坏现有用户数据。

## 9. 测试计划

### 单元测试

- 授权审批规则。
- 风险判断。
- 敏感占位符解析和脱敏。
- 上下文构建。
- 计划标准化。
- 状态机迁移。
- 证据分类。

### 集成测试

- 新任务完整流程。
- 同一任务多轮需求。
- 计划审批。
- 单步审批。
- 用户终止。
- 敏感变量输入。
- 校验失败后调整。
- 咨询类问题不执行服务器命令。

### 手动验收

- 浏览器演示模式完整可用。
- Tauri 真实 SSH 连接可用。
- SFTP 最小操作可用。
- 终端输入输出可用。
- 日志可追溯模型请求和命令执行。

## 10. 风险控制

- 每个阶段都必须保持 `npm test -- --run`、`npm run build`、`cargo check` 通过。
- 每次只迁移一个职责，不同时改 UI 和业务逻辑。
- 不改 Tauri command 名称，除非同步更新前端适配层。
- 不改变现有任务数据结构，除非提供兼容迁移。
- 不让模型直接决定高危执行权限。
- 不让真实敏感值进入模型上下文、日志和任务消息。

## 11. 推荐执行顺序

1. 抽出 `approvalPolicy.ts` 和测试。
2. 抽出 `secretTool.ts` 和测试。
3. 抽出 `agentContext.ts` 和测试。
4. 抽出 `planNormalizer.ts`。
5. 抽出 `taskMachine.ts`。
6. 抽出 `executionRunner.ts`。
7. 抽出 `evidenceReview.ts`。
8. 拆分 Rust 模块。
9. 拆分智能控制台组件。
10. 做主题、多语言和交互动效。

## 12. 完成标准

重构完成后应满足：

- `src/stores/ops.ts` 不再承载核心业务算法，只作为状态容器和协调入口。
- 智能需求处理核心逻辑可以在单元测试中脱离 UI 测试。
- 模型请求上下文、工具协议、敏感变量、审批、执行、校验和日志都有独立模块。
- 终端和 SFTP 至少保持当前最小可用能力。
- 右侧智能控制台可以独立迭代成 VSCode Codex 插件风格界面。
- 多语言和主题不影响核心业务逻辑。
