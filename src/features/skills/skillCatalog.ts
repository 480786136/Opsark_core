import type { SkillDefinition } from "@/features/skills/types";

const sshTerminalJump: SkillDefinition = {
  id: "ssh-terminal-jump",
  name: "终端 SSH 跳转",
  description: "在当前可见终端中安全跳转到另一台 SSH 服务器，并验证终端身份。",
  version: 1,
  enabled: true,
  builtIn: true,
  matchRules: [
    "regex:(?:ssh).*(?:连接|登录|跳转)|(?:连接|登录|跳转).*(?:ssh)",
    "regex:(?:终端|shell).*(?:跳转|登录).*(?:服务器|主机|IP)|(?:跳转|登录).*(?:服务器|主机|IP).*(?:终端|shell)",
  ],
  instructions: `这是分阶段工作流，每次只规划当前证据允许执行的阶段，禁止猜测后续结果：
1. 尚无目标端口连通证据时，先在当前终端执行只读网络连通检查；失败即报告阻断，不索取密码。
2. 网络可达后，单独调用 opsark-tool server.resolve_connection，按目标 host/port 查询服务器管理与系统钥匙串中是否已有用户名和密码引用。模型不得读取密码。
3. 查询结果缺少用户名或密码引用时，单独调用 user.request_input，只收集缺失字段，并明确参数目标与用途。
4. 凭据引用齐全后，单独调用 server.connect；优先使用 server.resolve_connection 返回的 credentialRef，否则使用用户输入产生的 passwordSecretKey。该工具必须在用户当前可见终端 PTY 中执行 SSH。
5. server.connect 完成后，生成独立只读终端命令获取主机名、当前用户和目标身份信息，验证终端确实已经位于目标服务器；验证成功后才能宣告完成。
不得把网络检查、凭据查询、用户输入、SSH 登录和登录后验证压缩为后台连接，也不得在证据不足时跳过阶段。`,
  updatedAt: "2026-08-20T00:00:00.000Z",
};

const projectSourceAcquisition: SkillDefinition = {
  id: "project-source-acquisition",
  name: "项目源码获取",
  description: "从 Git 仓库或用户指定的源码位置安全获取项目，并验证协议、工作树、远端地址和提交完整性。",
  version: 1,
  enabled: true,
  builtIn: true,
  matchRules: [
    "git clone",
    "克隆代码仓库",
    "下载或获取项目源码",
    "检出指定分支或提交",
    "regex:(?:克隆|获取|下载|检出).*(?:仓库|代码|源码|项目)|(?:仓库|代码|源码|项目).*(?:克隆|获取|下载|检出)",
  ],
  instructions: `这是项目源码获取的领域参考，不负责安装依赖或构建产物：
1. 先确认源码来源、用户指定的协议与 URL、可选分支/标签/提交和目标目录。用户给出的协议和 URL 必须保持语义不变，git@ 地址不得自行改成 HTTPS。
2. 写入前只读检查目标父目录和目标路径。目标已存在时，必须区分完整工作树、不完整获取、普通目录和同名冲突；不得仅因目录或 .git 存在就宣告获取完成，也不得未经授权删除或覆盖已有内容。
3. 需要认证时只使用语义明确的受管敏感变量；必需资料缺失时才单独调用 user.request_input。不得把密码、令牌或私钥写入 URL、命令文本和普通日志。
4. 克隆、下载或检出必须由前台执行器跟踪到真实退出，保留实时输出，不得放入未受管后台、不得用 tail/head 管道掩盖主进程退出状态。
5. Git 获取完成必须独立验证工作树、remote URL、HEAD 和用户指定的 ref/对象；普通源码包必须根据用户给出的大小或校验和证据验证。命令退出 0 或目录非空不足以证明源码完整。
6. 源码完整后输出真实工作目录和版本标识，供后续 project-build 或其他 Skill 复用。本 Skill 不得在没有构建 Skill 参考和项目证据时自行安装依赖或开始构建。`,
  updatedAt: "2026-08-20T00:00:00.000Z",
};

const projectBuild: SkillDefinition = {
  id: "project-build",
  name: "项目依赖与构建",
  description: "依据项目自身文档、声明文件和锁定文件识别技术栈，准备必要依赖、执行构建并验证真实产物。",
  version: 1,
  enabled: true,
  builtIn: true,
  matchRules: [
    "构建项目",
    "编译源码",
    "安装项目依赖",
    "生成构建产物或安装包",
    "regex:(?:构建|编译|build|compile|package).*(?:项目|源码|代码|产物)|(?:项目|源码|代码|产物).*(?:构建|编译|build|compile|package)",
  ],
  instructions: `这是项目依赖准备与构建的领域参考，默认处理已存在且已确认的项目工作目录：
1. 先确认真实项目路径和源码完整性证据。上一阶段已获得的仓库 URL、工作目录和 HEAD 必须复用；不得因切换到新轮计划就重复克隆。未获得源码时，只有同时激活 project-source-acquisition 才参考其获取流程。
2. 只依据项目自带的 README、声明文件、锁定文件、工具链版本、构建脚本和 CI 配置判断技术栈、依赖和构建入口。可先使用 files.get_structure 获取有界目录结构，再读取相关文件；不得由核心预设 Node、Rust、Python、Java 或任何产物路径。
3. 在变更环境前检查项目要求的工具和版本是否已可用。仅安装完成当前构建必需的缺失项，遵循用户对宿主环境、版本和隔离方式的明确约束；不得自行升级无关系统包或全局运行时。
4. 依赖安装和构建必须使用前台受管执行，保留实时输出和真实退出码。不得在下载、安装或编译尚未退出时提前执行验证，也不得将主命令直接管道到非跟随 tail/head 而丢失真实状态。
5. 构建成功必须独立验证项目定义的产物或可运行结果，至少确认真实路径、类型、字节数和必要的格式/版本信息。构建命令退出 0、日志出现 success 或产物目录存在都不能单独证明目标产物可用。
6. 结果中保留工作目录、实际构建入口和产物路径，供 file-transfer-integrity 或后续部署 Skill 复用。本 Skill 不得在用户未要求时自行传输、安装或启动产物。`,
  updatedAt: "2026-08-20T00:00:00.000Z",
};

const fileTransferIntegrity: SkillDefinition = {
  id: "file-transfer-integrity",
  name: "文件传输与完整性验证",
  description: "在两台已纳管服务器之间安全传输文件，并使用字节数和 SHA-256 证据确认目标文件完整。",
  version: 1,
  enabled: true,
  builtIn: true,
  matchRules: [
    "跨服务器文件传输",
    "发送文件到服务器",
    "复制构建产物或安装包",
    "SHA-256 文件完整性校验",
    "regex:(?:传输|发送|复制|拷贝|同步).*(?:文件|安装包|备份|产物)|(?:文件|安装包|备份|产物).*(?:传输|发送|复制|拷贝|同步)",
  ],
  instructions: `这是证据驱动的文件传输参考流程，实际步骤仍由模型根据当前证据生成：
1. 先确认源服务器、源文件绝对路径、目标服务器和包含文件名的目标绝对路径。仅当任务必需信息确实缺失时，单独调用 opsark-tool user.request_input，每个字段说明参数是什么以及用途。
2. 传输前先在源服务器执行只读检查，确认源对象是存在、可读的普通文件，并获取真实绝对路径、字节数和 SHA-256。不得把目录、空匹配、同名文件或仅有路径文本当作已确认的源文件。
3. 目标为地址且尚无连接资料证据时，单独调用 opsark-tool server.resolve_connection 查询目标是否已纳管、用户名和凭据是否可用；模型不得读取或输出密码。目标未纳管或凭据不可用时，必须明确报告阻断和所缺信息，不得盲目调用传输工具或在命令中暴露凭据。
4. 源文件和目标资料齐全后，优先调用 opsark-tool files.transfer_between_servers，由 Opsark 桌面后端使用两台纳管服务器的受管凭据流式中转。不得改为从源服务器直接执行 scp/rsync，也不得将整个文件读入模型上下文。
5. overwrite 默认为 false。只有用户明确允许覆盖，或已用真实证据确认目标文件可被替换时，才能设为 true。不得静默覆盖未知同名文件。
6. 传输工具会使用临时文件、流式进度、可终止生命周期和目标端复读 SHA-256 校验；只有工具成功返回 transferredBytes、targetPath 和 sha256，且与源文件证据一致时，才能宣告传输完成。传输中断、用户终止或校验失败都不得报告成功。
每轮只规划当前证据允许的最少步骤；已获得的路径、字节数、哈希和目标资料必须复用，不得无证据重复发现或重复传输。`,
  updatedAt: "2026-08-20T00:00:00.000Z",
};

export const builtInSkillCatalog: SkillDefinition[] = [
  sshTerminalJump,
  projectSourceAcquisition,
  projectBuild,
  fileTransferIntegrity,
];
