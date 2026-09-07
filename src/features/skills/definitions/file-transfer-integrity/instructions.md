这是证据驱动的文件传输与完整性验证参考流程，实际步骤仍由模型根据当前证据生成：
1. 先确认源服务器、源文件绝对路径、目标服务器和目标位置。用户只给出目标目录时，直接使用源文件 basename 补成最终目标文件绝对路径，不得重复询问文件名；仅当任务必需信息确实缺失时，才单独调用 opsark-tool user.request_input，每个字段必须说明参数及用途。
2. 传输前在源服务器执行单独的只读文件检查，确认源对象是存在、可读的普通文件，并获取真实绝对路径、字节数和 SHA-256。所有用户路径作为 Shell 参数时必须完整安全引用，并在命令支持时使用 -- 结束选项；普通文件判断使用 test -f 等不依赖语言环境的退出状态，不得比较 stat %F 的本地化文本。该步骤不得同时探测网络、认证或执行传输，也不得把目录、空匹配、同名文件或仅有路径文本当作已确认文件。
3. 源文件证据充分后，再单独检查源服务器到目标 SSH 端口的网络连通性；网络可达后，再单独使用 BatchMode 非交互 SSH 探测源服务器是否已有目标端认证。网络探测失败与认证失败必须如实保留非零退出码，交由复核阶段区分，不得用 || true、|| echo、末尾 true 或失败分支 exit 0 将失败改写成成功。
4. 认证分支必须严格按以下状态机执行，不能跨阶段猜测：
   - BatchMode 认证成功：使用该认证以前台 scp 直接传输，不请求密码。
   - BatchMode 认证失败：只查询目标 host/port 的 server.resolve_connection；源服务器和目标服务器身份不得互换。
   - resolve_connection 返回 managed-server 凭据引用：可以使用 files.transfer_between_servers 受管中转，不向模型暴露凭据。
   - 当前 serverCredentialGroups 或 resolve_connection 返回唯一匹配的 server-credential SSH 凭据组：必须直接复用，使用该组 usernamePlaceholder 构造 user@host，并在 description 中引用同组 secretPlaceholder。多个账号匹配时只请用户选择已有凭据组，不重新输入真实值。
   - 确实没有匹配凭据组：下一轮计划必须且只能调用 user.request_input，在同一表单请求类型为 password 的 TARGET_SSH_USERNAME 和 TARGET_SSH_PASSWORD，两个字段均标注目标 host 与 SSH/SCP 用途。提交后作为同一服务器凭据组长期保存。本轮禁止生成 scp、ssh、server.connect 或中转步骤，用户提交后再继续规划。
   - 用户输入完成：在当前源服务器可见 PTY 中以前台 scp 直接传输，命令仅使用 ${secret.TARGET_SSH_USERNAME}@host，description 引用同组 ${secret.TARGET_SSH_PASSWORD}。用户名只在执行边界展开，密码由 PTY 提示响应通道注入；两者都不得进入模型、日志或源服务器文件，不得使用 sshpass。
   文件传输工作流不得调用 server.connect 充当中转或凭据准备：server.connect 会改变当前终端所在服务器，不是 scp 的前置条件。尤其不得在目标为 192.168.1.237 时生成连接源服务器 192.168.1.236 的 server.connect。
5. 直接传输先写入目标同目录的唯一临时文件；目标同名文件未知时不得静默覆盖。scp 成功后在目标端读取临时文件字节数和 SHA-256，与源证据一致才原子提交为最终路径；失败、终止或校验不一致时清理临时文件且不得报告成功。
6. 仅当目标已经存在可用 managed-server credentialRef 且用户允许受管中转时，才调用 opsark-tool files.transfer_between_servers。server-credential 引用只用于当前可见 PTY 的前台 scp。目标未纳管或无受管凭据时不能调用中转工具，也不能通过 server.connect 临时伪造“已纳管”；应按第 4 条请求输入后走前台 scp。中转工具必须返回 transferredBytes、targetPath 和 sha256。
7. overwrite 默认为 false。只有用户明确允许覆盖，或真实证据确认目标文件可替换时，才能替换最终路径。不得把“用户要求传到某目录”自动解释为允许覆盖其中的未知同名文件。
8. 无论使用 scp 还是中转工具，最终成功都必须有目标文件字节数和 SHA-256 与源文件逐项一致的证据。中转工具已经在后端复读目标临时文件并校验哈希时，应复用其结构化证据，不再生成无凭据的目标端 Shell 校验。
每轮只规划当前证据允许的最少阶段；不得把源文件检查、网络探测、认证探测、传输和最终验收压进一个用条件分支吞掉退出码的 Shell 步骤。已获得的路径、字节数、哈希、网络状态、认证状态和目标资料必须复用，不得无证据重复发现或重复传输。