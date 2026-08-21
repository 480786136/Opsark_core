# Opsark Core

基于 Tauri 2、Vue 3 与 Rust 的智能运维需求处理桌面控制台。

首版重点实现了“需求 → 计划 → 审批 → 分步执行 → 校验 → 总结”的业务闭环；SFTP、终端、日志和模型设置作为辅助模块提供最小可用界面与适配器。

## 当前能力

- 服务器卡片管理、连接测试、基础信息与实时指标。
- 左侧远程文件区、中间 SSH 风格终端、右侧智能需求处理控制台。
- 多任务创建与切换、模型选择、四档授权等级。
- 结构化执行计划、风险标记、命令与校验详情。
- 计划整体审批，以及按风险/授权规则触发的单步审批。
- 命令输出同步到终端与任务时间线，执行后自动校验与总结。
- 任务、模型、工具、命令与系统事件审计日志。
- 模型配置、工具定义和敏感变量元数据管理界面。
- 可编辑模型可见的工具名称、说明、使用规则和返回说明，并可启用、停用或恢复默认。
- 远端文件数据结构获取工具，支持默认/自定义目录排除、隐藏文件、深度和节点数量限制。
- localStorage 演示持久化，Rust command 业务适配层。
- Rust `ssh2` 真实 SSH 探测与命令执行适配器，密码使用系统钥匙串持久化。
- 持久 SSH PTY、交互输入、Ctrl+C 与终端输出引用。
- 真实 SFTP 目录浏览、20 MB 内小文件上传/下载、建目录、重命名、安全删除。
- 远程 CPU、内存、磁盘、网络指标采集。
- OpenAI-compatible Chat Completions 结构化计划适配器，API Key 使用系统钥匙串持久化。
- 独立只读校验、执行/观察双状态、结构化证据和异常时模型复核。
- 敏感变量元数据、`${secret.KEY}` 指令合并、执行前输入和全链路脱敏。

## 快速启动

环境要求：Node.js 20+、Rust stable，以及对应平台的 Tauri 2 系统依赖。

```bash
npm install
npm run tauri dev
```

仅启动浏览器展示层：

```bash
npm run dev
```

自动验证：

```bash
npm test -- --run
npm run build
cargo test --manifest-path src-tauri/Cargo.toml --lib
cargo check --manifest-path src-tauri/Cargo.toml
npm run tauri build -- --debug --no-bundle
```

真实集成测试默认忽略，避免误连服务器或消耗模型额度。运行前通过临时环境变量或 CI Secret 提供 `OPSARK_TEST_MODEL_KEY`、`OPSARK_TEST_SSH_HOST`、`OPSARK_TEST_SSH_USER` 和 `OPSARK_TEST_SSH_PASSWORD`，不要把真实值写入仓库、文档或命令输出。SSH 端口可通过 `OPSARK_TEST_SSH_PORT` 覆盖，默认使用 `22`；兼容模型服务可通过 `OPSARK_TEST_MODEL_ENDPOINT` 和 `OPSARK_TEST_MODEL_NAME` 覆盖默认端点与模型。然后分别执行：

```bash
cargo test --manifest-path src-tauri/Cargo.toml --lib live_tests::generate_live_deepseek_plan -- --ignored --exact
cargo test --manifest-path src-tauri/Cargo.toml --lib live_tests::probe_live_ssh_adapter -- --ignored --exact
```
## 打包构建

npm install
npm run build:windows

npm run build:macos
## 演示流程

1. 在“服务器”页面打开预置的 `生产环境 · Web-01`。
2. 点击右侧“开启智能运维”。
3. 输入“检查 Nginx 配置并安全重新加载服务”。
4. 检查模型生成的步骤、风险、命令与校验说明，然后批准计划。
5. 默认“安全模式”会自动执行低风险步骤；Nginx 重载属于中风险，需要单独确认。
6. 执行完成后可在终端查看回显，在“操作日志”查看完整审计记录。

如需连接真实环境，在服务器工作台右上角点击“连接服务器”并输入密码；如需真实模型规划，在“模型与安全”中填写模型 API Key。两类凭据均保存到系统钥匙串，不会写入 localStorage、仓库或审计日志。

## 安全说明

当前版本是业务验证版。未配置会话凭据时使用安全演示输出；配置 SSH 密码后会真实执行已批准的命令。Rust 执行器始终拦截明确的高危命令。进入生产环境前还需要完成：

- SFTP 大文件分片、远程文件编辑和传输冲突恢复；
- SSH PTY 自动重连、会话恢复和多终端标签；
- 其他敏感字段加密和密钥轮换；
- 更细粒度的命令策略和审批留痕；
- 模型 tool calling、结构化输出校验与失败重试；
- SQLite 持久化、任务断点恢复与回滚能力。

详细范围和路线见 [实施计划](docs/IMPLEMENTATION_PLAN.md) 与 [重构计划](docs/REFACTOR_PLAN.md)。

当前代码模块、调用关系和迁移状态见 [代码模块说明](docs/代码模块说明文档.md)。

步骤校验、证据链和模型复核的分阶段优化方案见
[步骤校验优化方案](docs/STEP_VALIDATION_OPTIMIZATION.md)。
