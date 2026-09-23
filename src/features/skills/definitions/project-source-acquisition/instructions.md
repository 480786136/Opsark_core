定位：本 Skill 是领域流程参考，不是工具权限或固定状态机。工具以当前目录和用户授权为准；可复用已有证据、合并独立检查，选择有依据的等价实现，不要求先启用其他 Skill。仅依赖未知结果的步骤留待下一轮。
恢复：依据原始错误修复当前步骤；路径改变时调整剩余计划，保留整体目标与已完成证据。流程不适配时说明原因并使用通用规划；重复无进展时按系统预算暂停，保留结果和可操作原因。不绕过授权、凭据保护或执行隔离，不虚报完成。

本流程覆盖获取 Git 源码到最终目录并验证可用。用户还要求构建或部署时，继续整体目标，不把源码验收当作任务终点。
根据已有真实证据生成最短的可执行计划；未知条件会改变后续操作时，先检查该条件，下一轮再继续。

建议阶段（按已有证据调整或跳过已满足的阶段）：
1. [prepare] 确认获取目标和环境
   进入条件：尚未确认仓库 URL、最终目录或目标现状
   执行契约：
   1. 从用户需求中确定原始仓库 URL、最终绝对目录和可选 ref；已经明确的 URL/路径直接写入步骤说明，不要为它单独生成 printf/echo 命令步骤
   2. 用 kind=observe 的只读步骤检查 Git 可用性、目标父目录可写性和最终目录是否已存在；主命令结果就是证据，不再生成重复 validation。目录不存在可以是有效观察；逐项保留退出码，区分不存在、权限拒绝与 I/O 错误。set -o pipefail 仅处理管道，不保证顺序命令状态，不让末尾 df/echo 成功覆盖前面错误
   3. 已有目录不得自动删除或覆盖；如果是同源仓库，仅在用户要求更新时进入更新流程
   退出证据：
   1. 仓库 URL 与最终目录
   2. Git 和写入条件
   3. 目标目录状态

2. [authenticate] 选择仓库认证方式
   进入条件：仓库需要认证或认证状态尚未明确
   执行契约：
   1. HTTPS 认证状态未知时，可用 kind=observe 的有界匿名探测：使用原始 URL、设置 GIT_TERMINAL_PROMPT=0，并执行 git ls-remote；根据结果决定 clone 或凭据收集；已有访问成功证据时直接复用，无需重复探测
   2. 只有匿名探测的真实结构化结果明确证明需要认证后，才优先复用当前服务器中 target 匹配的完整 Git HTTPS 凭据组；步骤用系统返回的 server-credential 引用或敏感变量占位符显式表达认证要求，GIT_TERMINAL_PROMPT=1 保留受控认证提示，不得靠 description/expected 中的自然语言暗示认证
   3. 有多个匹配账号时请用户选择；没有匹配组时才同表单收集用户名和密码或令牌
   4. 凭据只由执行器通过前台 PTY 回答 Git 的 Username/Password 提示；计划命令保留不含凭据的原始 URL
   退出证据：
   1. 无需凭据，或唯一已选 server-credential 引用
   状态分支：
   - [public] 原始 URL 可直接读取：不收集凭据，直接获取源码
   - [saved-credential] HTTPS 需要认证，且当前服务器已有 target 匹配的完整 Git HTTPS 凭据组：只有一组时直接复用；有多组时请用户选择一组，不交叉组合字段
   - [request-credential] HTTPS 需要认证，但当前服务器没有匹配凭据组：调用 opsark-tool user.request_input {"title":"Git HTTPS 凭据","description":"收集 REPOSITORY_HOST 的仓库读取凭据，并按当前服务器长期保存。","fields":[{"key":"GIT_USERNAME","label":"Git HTTPS 用户名","description":"用于 REPOSITORY_HOST 的 Git HTTPS 登录用户名。","type":"password","required":true,"credential":{"group":"git_https_repository","kind":"git-https","role":"username","target":"REPOSITORY_HOST"}},{"key":"GIT_HTTP_CREDENTIAL","label":"Git HTTPS 密码或访问令牌","description":"用于 REPOSITORY_HOST 仓库读取认证的密码或个人访问令牌。","type":"password","required":true,"credential":{"group":"git_https_repository","kind":"git-https","role":"secret","target":"REPOSITORY_HOST"}}]}；将 REPOSITORY_HOST 替换为仓库 URL 的精确主机，提交后使用工具返回的凭据引用
   - [rejected] 远端明确拒绝已选凭据：停止重试同一凭据，请用户更新该组或选择另一组
   - [ssh] 原始 URL 为 SSH：使用已有 SSH Agent 或受信公钥；缺少公钥认证时报告配置需求

3. [acquire] 获取源码到最终目录
   进入条件：目标路径可用，且仓库访问方式已确定
   执行契约：
   1. 用 kind=change 在可见 PTY 中前台执行 Git 获取命令并等待真实退出；使用用户要求的 ref、depth、submodule 或 LFS 选项
   2. 新仓库应在本步成功时位于用户指定的最终目录；可直接获取到最终目录，也可使用不泄漏中间状态的安全等价实现
   退出证据：
   1. Git 命令真实退出码
   2. 最终源码目录

4. [verify] 验收最终仓库
   进入条件：Git 获取命令已成功退出
   执行契约：
   1. 仅从最终绝对目录检查它是 Git 工作树、origin 与原始 URL 一致、HEAD 存在，并在用户指定 ref 时校验该 ref
   2. 获取变更步骤的 validation 直接使用上述最终目录检查；如果验收被单独规划为 kind=observe，则直接使用该主命令结果，不再生成第二条校验
   退出证据：
   1. 工作树、origin、HEAD 和请求 ref 的真实结果

5. [handle-error] 按真实错误恢复或停止
   进入条件：任一检查、认证、获取或验收步骤失败
   执行契约：
   1. 需要认证时进入凭据选择；远端明确拒绝凭据时停止并请用户更新或更换账号，不重复尝试同一凭据
   2. 目标路径已存在时保留原内容并报告冲突；网络、DNS 或 TLS 失败时报告原始错误，只对明确的短暂错误做有限重试
   3. Git 命令或最终验收失败时不宣告完成；仅清理本任务明确创建的临时内容，然后基于新证据生成一次针对性调整
   退出证据：
   1. 可操作的错误分类，或明确的完成验收结果

数据与认证保护：
   1. 保留用户的原始仓库 URL 和协议，不在 URL、命令、环境变量或文件中写入用户名、密码、令牌或敏感占位符。
   2. Git HTTPS 凭据从当前服务器的 serverCredentialGroups 选择或通过安全输入收集；server.resolve_connection 和 server.connect 面向 SSH，不是 Git HTTPS 认证接口。另有 SSH 目标时遵循对应工具协议。
   3. 不覆盖或删除用户已有目录，不把临时目录当作最终结果，不把真实失败改写为成功。
