# 2026-09-06：缓存分层、Skill 文件化与任务日志拆分

本轮将三项改动接入实际业务调用链，保留已有用户 Skill 覆盖和旧日志。没有增加模型调用、输入/输出 Token 上限，也没有调用付费模型或执行远端部署。

## 缓存分层

所有实际模型请求在 Rust 发送入口经过统一组装：

1. 保留原 system 角色定义、通用规则与输出协议。
2. 将工具定义、已选 Skill 静态规则或分类阶段的 Skill 目录放入前置策略消息。
3. 将匹配证据、服务器状态、用户要求、执行结果与错误保留在动态消息中。

策略消息沿用原上下文的 user 角色，不把自定义 Skill 内容提升成 system 指令。工具的参数 Schema、原约束和验收正文继续保留；本轮没有把 JSON 工具协议改成原生 Function Calling。

Skill 阶段的 evidenceId、路径和观察事实从 instructions 中移到独立 skillEvidence 字段。同一阶段内，仅证据变化不会改变静态规则；切换工具集合、阶段或规则版本时，相关前缀正常变化。初次选择 Skill 后只保留所选 Skill 的阶段证据。

本轮采用供应商已有的隐式缓存，不向所有 OpenAI 兼容接口强行添加 cache_control，也没有启用显式缓存写入收费。每轮仍发送必要内容；公共前缀更稳定不等于保证命中、永久缓存或总输入 Token 减少。实际收益需要新版日志中的 cached_tokens、cache_creation_input_tokens 和供应商账单验证。

任务关联元数据仅用于本地日志，在请求发送前剥离。发送入口以程序传入的上下文为依据，不从用户文字或工具正文中猜测任务 ID。开发者模型日志和返回给前端的尝试记录保存组装后的请求；前端生成的请求草稿仍可用于对照。

## Skill 文件化

7 个内置 Skill 均位于 src/features/skills/definitions。以构建 Skill 为例：

```text
definitions/
  catalog.json
  project-build/
    skill.json
    instructions.md
    global.md
    acceptance.md
    stages/
      discover.md
      prepare.md
```

- skill.json：schemaVersion、ID、名称、版本、工具范围、阶段进入/退出条件及 Markdown 引用。
- instructions.md：完整规则，供正常完整加载、异常恢复和旧配置兼容使用。
- global.md、acceptance.md、stages/*.md：阶段投影的明确规则片段。
- 本地 npm/Maven 证据解析器继续保留为经过测试的代码，JSON 只引用受支持的适配器名称。

原来通过 TypeScript 字符串和段落编号拼装规则的代码已移除。加载器验证核心元数据与相对文件路径；核心正文缺失会明确报错，缺少可选阶段文件或阶段契约不兼容时恢复完整正文。

阶段契约保存 sourceFingerprint。完整正文变化而契约尚未同步时，停止阶段投影并使用新完整正文，避免新约束被旧阶段片段遗漏。该指纹用于发现内容不同，不是签名；LF/CRLF 换行不影响结果。

修改步骤：

1. 修改对应 Markdown 和 JSON；有阶段契约的 Skill 同步维护完整正文与阶段片段。
2. 规则有业务变化时更新 version 和 updatedAt，沿用原用户覆盖的版本兼容流程。
3. 检查阶段片段已包含必要约束，再执行 `node scripts/update-skill-fingerprint.mjs project-build` 更新契约对应的正文指纹。
4. 运行 Skill 测试及生产构建。

这些文件当前由 Vite 在构建时打包，修改发布后的安装目录不会热加载；现有界面中的自定义 Skill 和覆盖设置仍通过原持久化机制保存。

## 按任务保存日志

新日志写在 Tauri 应用数据目录下，Windows 通常为 `%APPDATA%\com.opsark.desktop\logs`：

```text
logs/
  index.jsonl
  tasks/task-<任务 ID 的 SHA-256>/
    model-calls.jsonl
    events.jsonl
    developer-events.jsonl
  system/
    model-calls.jsonl
    events.jsonl
    developer-events.jsonl
```

model-calls 保存实际请求、响应、传输错误和重试；events 保存已脱敏的操作事件；developer-events 保存现有开发者记录。索引仅保存关联字段、相对路径、状态与 API usage，不重复模型正文。前端草稿/尝试记录与后端网络记录有不同用途，可能保留同一调用的不同表示。

任务日志包含 taskId，轮次、步骤、目标和 phaseIndex 在可用时附带。phaseIndex 是当前轮执行阶段的序号；requestId 关联一次发送函数内的传输重试，每次网络尝试另有唯一 callId。尚无任务归属的调用进入 system，不根据时间猜测归属。

目录名由任务 ID 哈希生成，避免路径穿越、Windows 保留名和特殊字符冲突；原 taskId 保留在记录及索引里。写入使用进程内互斥锁，每条记录单行追加。单个日志达到 32 MiB 后续写入 -1、-2 等分卷；单条大记录不会被截断，因此一个分卷可能超过阈值。分卷不自动删除旧数据，未引入保留期限清理策略。

旧 developer-model-calls.jsonl 不搬移、不删除，新版不再向其追加网络日志。界面日志的原持久化仍保留，磁盘日志失败不会阻断业务执行，但会输出写入失败提示。以上文件需通过重新构建并运行新版桌面端后产生。

## 分析方式

聚合脚本兼容旧 JSONL，也接受新 logs 根目录或单个任务目录，自动读取 model-calls 分卷并忽略索引，避免重复统计：

```powershell
node scripts/analyze-model-calls.mjs "日志存储/developer-model-calls.jsonl" 2026-09-05
node scripts/analyze-model-calls.mjs "$env:APPDATA\com.opsark.desktop\logs" 2026-09-06
node scripts/analyze-model-calls.mjs "$env:APPDATA\com.opsark.desktop\logs" 2026-09-06 "实际 taskId"
```

日期按 UTC。输出包含输入、输出、缓存命中和缓存创建 Token；缓存字段不再次加到总 Token 上。具体费用仍以对应供应商和模型的实际计费为准。

## 验证

### 18:46 新只读任务分类修复

任务 `task-1788691560653-sop5et` 查询当前 Java 服务，模型两次都返回 `execute + side_question + read_only`。answer 与 constraints 实际合法，真正错误是 execute 不允许 side_question；原校验错误没有指出 relation，导致修复请求重复相同错误。

分类校验现在分别报告 answer、constraints、terminalContextLines 与 relation。仅在程序上下文明示无历史对话、无已完成步骤、无原目标/前次执行，且响应是合法的只读 execute 时，将 side_question 规范为 new_goal；保留原始响应，并在 developerTrace.normalizations 中记录本地处理。已有目标、上下文未知和变更请求不适用该兼容规则。分类提示补充了“查询真实状态也是 execute”的明确例子。

定向回归覆盖本次响应、已有目标和历史证据、上下文缺失、变更权限及字段级错误提示；无需真实服务器或付费模型重放。

### 分层与文件化验证记录

- 前端回归覆盖 87 个文件、626 项测试，另有 16 项既有跳过；独立日志脚本测试通过 `node --test scripts/analyze-model-calls.node-check.mjs` 运行。
- TypeScript 检查与 Vite 生产构建通过，保留既有大包提示。
- Rust 全量：94 项通过、2 项需要外部凭据的测试忽略，1 项既有 Bash 测试因 program not found 失败。过滤该环境依赖测试后再次运行：94 项通过、2 项忽略。
- 新测试覆盖稳定前缀、动态证据保留、本地元数据剥离、文件缺失/正文变化回退、任务目录隔离、安全路径、分卷保留与缓存用量统计。
