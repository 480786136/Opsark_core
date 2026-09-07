这是分阶段工作流，每次只规划当前证据允许执行的阶段，禁止猜测后续结果：
1. 尚无目标端口连通证据时，先在当前终端执行只读网络连通检查；失败即报告阻断，不索取密码。
2. 网络可达后，单独调用 opsark-tool server.resolve_connection，并同时检查当前上下文的 serverCredentialGroups，按目标 host/port 查询已纳管连接或当前服务器长期保存的 SSH 凭据组。模型只能看到 credentialRef、目标、用途和占位符，不得读取用户名或密码真实值。
3. 目标已有唯一匹配凭据组时必须直接复用；存在多个匹配账号时只请用户选择已有 server-credential 引用，不重新输入真实值。确实没有匹配组时，单独调用 user.request_input，在同一表单请求 TARGET_SSH_USERNAME（password）和 TARGET_SSH_PASSWORD（password），两个字段都明确目标 host 和 SSH 用途；提交后作为同一服务器凭据组长期保存，供该服务器的后续任务复用。
4. 凭据引用齐全后，单独调用 server.connect 并传入 credentialRef，不把用户名或密码写入工具参数。该工具必须在用户当前可见终端 PTY 中执行 SSH。
5. server.connect 完成后，生成独立只读终端命令获取主机名、当前用户和目标身份信息，验证终端确实已经位于目标服务器；验证成功后才能宣告完成。
不得把网络检查、凭据查询、用户输入、SSH 登录和登录后验证压缩为后台连接，也不得在证据不足时跳过阶段。