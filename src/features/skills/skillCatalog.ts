<<<<<<< HEAD
import type { SkillDefinition } from "@/features/skills/types";
import { deploymentPlanningContract } from "@/features/skills/builtins/deploymentPlanning";
import { projectSourceAcquisitionSkill } from "@/features/skills/builtins/projectSourceAcquisition/definition";

const sshTerminalJump: SkillDefinition = {
  id: "ssh-terminal-jump",
  name: "终端 SSH 跳转",
  category: "connectivity",
  description: "从当前可见终端登录或跳转到另一台 SSH 服务器，并验证登录后的终端身份。",
  version: 4,
  enabled: true,
  builtIn: true,
  matchRules: [
    "regex:(?:ssh).*(?:连接|登录|跳转)|(?:连接|登录|跳转).*(?:ssh)",
    "regex:(?:终端|shell).*(?:跳转|登录).*(?:服务器|主机|IP)|(?:跳转|登录).*(?:服务器|主机|IP).*(?:终端|shell)",
  ],
  allowedToolIds: ["server.resolve_connection", "user.request_input", "server.connect"],
  instructions: `这是分阶段工作流，每次只规划当前证据允许执行的阶段，禁止猜测后续结果：
1. 尚无目标端口连通证据时，先在当前终端执行只读网络连通检查；失败即报告阻断，不索取密码。
2. 网络可达后，单独调用 opsark-tool server.resolve_connection，并同时检查当前上下文的 serverCredentialGroups，按目标 host/port 查询已纳管连接或当前服务器长期保存的 SSH 凭据组。模型只能看到 credentialRef、目标、用途和占位符，不得读取用户名或密码真实值。
3. 目标已有唯一匹配凭据组时必须直接复用；存在多个匹配账号时只请用户选择已有 server-credential 引用，不重新输入真实值。确实没有匹配组时，单独调用 user.request_input，在同一表单请求 TARGET_SSH_USERNAME（password）和 TARGET_SSH_PASSWORD（password），两个字段都明确目标 host 和 SSH 用途；提交后作为同一服务器凭据组长期保存，供该服务器的后续任务复用。
4. 凭据引用齐全后，单独调用 server.connect 并传入 credentialRef，不把用户名或密码写入工具参数。该工具必须在用户当前可见终端 PTY 中执行 SSH。
5. server.connect 完成后，生成独立只读终端命令获取主机名、当前用户和目标身份信息，验证终端确实已经位于目标服务器；验证成功后才能宣告完成。
不得把网络检查、凭据查询、用户输入、SSH 登录和登录后验证压缩为后台连接，也不得在证据不足时跳过阶段。`,
  updatedAt: "2026-08-24T00:00:00.000Z",
};

const softwareInstallation: SkillDefinition = {
  id: "software-installation",
  name: "通用软件安装",
  category: "environment",
  description: "在 Linux 服务器上安装或升级 Git、Node.js、Java/JDK、Docker 等通用软件；识别发行版、版本、权限、仓库、国内网络与镜像，并进行独立验收。",
  version: 1,
  enabled: true,
  builtIn: true,
  matchRules: [
    "安装软件",
    "安装 Git",
    "安装 Node",
    "安装 Node.js",
    "安装 Java",
    "安装 JDK",
    "安装 Docker",
    "安装 Python",
    "安装 Go",
    "安装 Rust",
    "安装 Nginx",
    "升级运行时",
    "配置软件源",
    "regex:(?:安装|部署|升级|配置).*(?:git|node(?:\\.js)?|npm|pnpm|yarn|java|jdk|maven|gradle|docker|docker compose|软件|运行时|工具链)",
    "regex:(?:安装|升级|卸载)\\s*(?:软件|程序|工具|软件包|[a-z][a-z0-9+._-]*)",
  ],
  allowedToolIds: ["software.check", "user.request_input"],
  instructions: `这是通用服务器软件安装流程，可单独使用，也可与 project-source-acquisition、project-build 等 Skill 联合使用。只安装用户目标或已由项目证据证明必需的软件，不预设具体业务：
1. 软件名称明确时优先调用 software.check 获取指定命令的真实路径和版本；只有工具返回缺失或版本不兼容时才进入安装。不得用全系统扫描替代精准检查，也不得因 server.basic_info 未列出某软件就直接判定缺失。缺少 OS、架构、权限证据时，本轮只能做只读环境发现；安装源可用性未知时，下一轮只做有界网络/仓库探测；证据充分后才能安装。安装主进程未真实退出前不得后置验收，30 秒模型复核不能替代真实退出状态。
2. 明确目标：确认软件名称、用途、期望版本/版本范围、CPU 架构、系统级或用户级安装、是否允许升级现有版本，以及是否需要服务启动/开机自启。用户未指定版本时，应依据操作系统受支持版本或项目声明选择兼容版本并说明依据；不能默认安装“最新版本”，也不能顺带升级无关包。
3. 只读发现必须先完成：读取 /etc/os-release、架构、当前用户及 sudo/root 能力、可用包管理器与软件源，检查现有命令、真实版本、包归属、安装路径、磁盘/内存，以及可能冲突的旧包、版本管理器或服务。已有版本满足要求时直接复用并验收，不重复安装。不要通过 uname 或命令名称猜发行版。
4. 选择安装渠道时优先级为：当前发行版受支持的软件包/模块流；软件官方签名仓库或官方发行包；用户已批准的受信镜像；最后才是经审查且可校验的安装脚本。不得直接执行 curl|sh/wget|bash，不得关闭 TLS、GPG/仓库签名或使用 --nogpgcheck。需要新增仓库、密钥、代理、环境变量、alternatives、用户组或 daemon 配置时必须作为独立步骤，先展示影响并保留可恢复证据。
5. 网络与镜像状态机：先用有界 DNS、TCP/HTTPS、仓库元数据或小文件探测判断故障属于超时/重置、代理、TLS/CA、系统时间、404、签名、限流还是包不存在。仅对瞬时故障有限重试；认证、404、签名失败不能靠重复等待解决。确认官方源在当前网络不可用或速度不可接受后，才选择与发行版、架构和版本匹配的受信国内镜像/企业镜像，并先探测可达性和元数据。镜像修改默认只作用于本次安装；若必须持久修改 repo、npm、Maven、Docker registry 等配置，先备份原配置并明确告知用户。镜像不可用时能恢复原配置。
6. 包管理器执行前处理锁和并发：先识别 apt/dpkg、dnf/yum/rpm、zypper、pacman 等真实状态；正常运行的其他包管理进程应等待或报告，不得强杀，不得盲删 lock。缓存损坏、元数据过期、依赖冲突、磁盘不足和事务中断必须分别诊断，禁止使用 --force、跳过依赖或大范围升级掩盖问题。安装命令前台运行到真实退出，保留完整实时进度，不得后台执行或通过 tail/head 丢失退出状态。
7. 常见软件的专属约束：
   - Git：安装 git 可执行程序并验证版本即可；git user.name/user.email 是提交作者信息，不是仓库登录账号，除非用户明确要提交代码，否则不要索取或全局配置。仓库认证由 project-source-acquisition 处理。
   - Node.js：先依据项目 engines、.nvmrc/.node-version 或用户要求选版本；区分系统包、nvm/fnm/volta 等用户级版本管理器，避免覆盖已有多版本环境。分别验证 node 与 npm；npm/pnpm/yarn registry 只影响包依赖下载，不等于 Node 二进制下载镜像。
   - Java：确认需要 JRE 还是 JDK、主版本和发行商兼容性；构建通常需要 JDK。验证 java 与 javac，只有任务需要时才调整 JAVA_HOME/alternatives，且不得静默替换其他应用正在使用的系统默认 Java。
   - Docker：区分 Docker Engine、CLI、Compose 插件与桌面版；检查内核、cgroup、存储驱动、旧版/冲突包和官方仓库签名。安装完成不等于允许启动、开机自启或把用户加入 docker 组；这些会改变服务或等同提升权限，只有用户目标需要且风险获准后分步执行。
8. 下载二进制或安装器时必须匹配 OS/架构，使用 HTTPS，并依据官方发布的 SHA-256/签名进行校验；校验值不得来自同一个不受信镜像的任意文本。下载完成且退出 0 后才能解压/安装，安装完成后才能运行验证，禁止“仍在下载就提前校验”的竞态。
9. 认证或授权：软件仓库确实需要账户、令牌或代理凭据时，下一轮必须且只能调用 user.request_input 收集缺失字段，敏感字段使用语义唯一的 password key，并说明作用域；不得把凭据写入 URL、命令、日志或明文配置。缺少 root/sudo 权限时不得猜密码或绕过权限，应说明所需授权；只有系统支持安全 PTY 提示且用户明确授权时才继续。
10. 最终验收必须使用新的独立只读命令，验证实际二进制路径、精确版本、CPU 架构和最小可用行为；有服务的再验证服务状态和启用状态是否符合用户要求。安装命令 exit 0、包记录存在或日志含 success 不能单独证明可用。若安装失败，保留原有可用版本和配置，清理仅由本轮创建的临时文件，并报告故障分类、已改动内容与安全恢复方式。
11. 已确认的 OS、架构、版本、源、网络与安装结果必须在后续阶段复用，禁止因重新规划而重复刷新仓库、重复下载安装或重复修改镜像。`,
  updatedAt: "2026-08-21T00:00:00.000Z",
};

const projectBuild: SkillDefinition = {
  id: "project-build",
  name: "项目依赖与构建",
  category: "build",
  description: "按项目证据分阶段完成工具链确认、依赖安装、构建和产物验收，并根据真实错误恢复。",
  version: 3,
  enabled: true,
  builtIn: true,
  matchRules: [
    "构建项目",
    "编译源码",
    "安装项目依赖",
    "生成构建产物或安装包",
    "regex:(?:构建|编译|build|compile|package).*(?:项目|源码|代码|产物)|(?:项目|源码|代码|产物).*(?:构建|编译|build|compile|package)",
  ],
  allowedToolIds: ["files.get_structure", "files.read_content", "software.check", "user.request_input"],
  instructions: `目标是从已确认的项目源码得到可验证的构建结果。按下面的业务阶段处理，不把多个失败边界塞进同一个 Shell 步骤：

1. 项目识别：复用已有工作目录、仓库和 HEAD 证据，不重复获取源码。读取项目自己的 README、依赖声明、锁文件、工具链版本文件、构建脚本和必要的 CI 配置，确定包管理器、所需运行时、安装入口、构建入口和预期产物。关键选择尚无证据时，本轮只完成发现；不要猜技术栈、命令或产物目录。
2. 工具链确认：独立检查项目要求的运行时和包管理器是否存在且版本兼容。只有证据证明缺失或不兼容时才联合 software-installation；不得为了构建顺带升级无关系统软件或替换现有全局环境。
3. 依赖安装：作为独立步骤执行并等待真实退出，再进行依赖状态校验。根据项目证据选择 npm、pnpm、Yarn、pip、Poetry、Maven、Gradle、Cargo 等及其锁定安装方式；例如有效 package-lock.json 对应 npm ci，没有锁文件时才使用 npm install。不得把依赖安装与构建写成 npm install && npm run build 之类的同一步骤。
4. 项目构建：依赖步骤成功后，使用项目声明的构建入口作为新的独立步骤。构建失败只处理构建错误，不重新安装已经验收成功的依赖；构建成功后再执行独立、只读的产物验收。
5. 执行可观察性：安装和构建都在前台受管终端运行，保留实时输出和主命令真实退出码。不得把全部 stdout/stderr 只重定向到文件；确需留存日志时使用能够同时输出到终端且保留管道退出状态的方式。不得用 tail/head、后台任务、无条件成功分支或“set -e 后再读取 $? ”遮蔽真实结果。
6. 错误恢复：命令非零退出时先读取本次完整错误和工具自身日志，按网络/DNS/TLS、认证、运行时版本、锁文件或依赖冲突、生命周期或原生编译、权限、磁盘/inode、内存/OOM 分类，只针对已证明的原因生成一个恢复步骤。没有证据时不得切换镜像、删除锁文件、使用 force/legacy-peer-deps、修改全局 registry 或设置内存参数。镜像确有必要时优先仅作用于本次命令。
7. 长任务中断：定期复核停止或终端中断只表示没有取得真实退出结果，不等于安装或构建失败。重试前先精确检查对应进程、日志更新时间、包管理器日志、依赖目录或缓存、磁盘和内存状态；确认旧进程已结束并取得新的阻断证据后，再决定继续等待、恢复或重试，禁止原样重复执行。
8. 完成条件：依赖安装、构建和最终产物分别保留工作目录、实际入口、退出状态与独立证据。产物验收依据项目定义检查真实路径、类型、非空内容以及必要的格式、版本或最小可运行行为；仅有 exit 0、success 文本或产物目录存在不能单独完成目标。本 Skill 不自行部署、启动或传输产物，除非用户目标同时选择了相应 Skill。`,
  updatedAt: "2026-08-25T00:00:00.000Z",
};

const databaseInspectionAndOperations: SkillDefinition = {
  id: "database-inspection-operations",
  name: "数据库检查与操作",
  category: "data",
  description: "对 MySQL、MariaDB、PostgreSQL 等数据库执行库表查询、连接诊断、初始化、迁移和受控变更，以真实查询结果验收。",
  version: 1,
  enabled: true,
  builtIn: true,
  matchRules: [
    "查看数据库",
    "列出所有数据库",
    "查询数据库或表",
    "检查数据库连接",
    "数据库初始化或迁移",
    "regex:(?:mysql|mariadb|postgres(?:ql)?|数据库|sql).*(?:查询|查看|列出|检查|连接|初始化|迁移|创建|修改|删除)|(?:查询|查看|列出|检查|连接|初始化|迁移|创建|修改|删除).*(?:mysql|mariadb|postgres(?:ql)?|数据库|sql)",
  ],
  allowedToolIds: ["user.request_input"],
  instructions: `这是数据库查询、连接诊断和受控变更的领域流程，必须以用户要求的真实数据库结果验收：
1. 先从用户需求和已有证据确认目标引擎、主机或 socket、端口、账户、数据库名与操作类型。不得把 mysql 客户端存在当作服务可用，也不得从项目示例配置猜测生产连接参数。
2. 认证方式必须通过真实连接结果确认。可先使用已证明可用的 socket/本地系统身份进行最小只读探测；认证失败后不得继续重试空密码或其他无证据账户。先查询当前服务器的敏感信息元数据；只有用途、目标实例和账户都一致才能复用。
3. 缺少账户或密码时，下一轮只调用 user.request_input 收集缺失字段。用户名标明数据库引擎和目标实例；密码使用语义唯一的 password key，例如 MYSQL_ROOT_PASSWORD、OFFICE_DATABASE_PASSWORD 或 POSTGRES_ADMIN_PASSWORD。禁止使用含义不明的 PASSWORD，禁止复用 SSH、Git、API 或其他实例的凭据。
4. 只读查询必须保留数据库客户端的真实退出码和完整必要输出。不得用 set +e、无条件 echo、接受非零退出码的 validation 或把主命令直接管道到 head/tail 将认证、SQL 或连接失败改写为成功。
5. 用户要求列出数据库、表或查询数据时，只有真实返回所需列表或结果才能完成。ERROR 1045、password authentication failed、权限不足、空输出或只证明服务存在都是阻断或中间证据，不是查询目标完成。
6. validation 必须在独立 Shell 中使用同一目标实例、账户和语义化敏感变量重新执行最小只读验收；不能读取 command 的临时变量或 stdout。发现查询可将“无匹配”作为有效观察，但仍必须先认证成功并真实执行查询。
7. CREATE、ALTER、DROP、TRUNCATE、写入、导入、迁移、账户/权限和认证配置修改必须按变更处理：先检查对象、数据量、依赖、备份或回滚条件，严格遵守用户授权和风险审批。不得为了恢复访问而开启 skip-grant-tables、清空密码、扩大权限或改写认证插件。`,
  updatedAt: "2026-08-22T00:00:00.000Z",
};

const applicationDeployment: SkillDefinition = {
  id: "application-deployment",
  name: "应用部署与上线验收",
  category: "deployment",
  description: "将已有项目部署、启动或上线，并完成端到端验收。",
  version: 4,
  enabled: true,
  builtIn: true,
  matchRules: [
    "部署项目",
    "继续部署",
    "上线应用",
    "启动并验证项目",
    "配置 Web 服务",
    "regex:(?:部署|上线|发布|运行|启动).*(?:项目|应用|网站|服务)|(?:项目|应用|网站|服务).*(?:部署|上线|发布)",
  ],
  allowedToolIds: ["files.get_structure", "files.read_content", "software.check", "user.request_input"],
  instructions: `这是面向整体目标的应用部署流程，必须与 project-source-acquisition、software-installation、project-build 等已选 Skill 联合复用证据，不能把某个中间阶段当作部署完成：
1. 发现阶段先用 files.get_structure 对项目目录做有界检查；随后按实际结构逐个用 files.read_content 读取 README、依赖声明、锁文件、示例配置、迁移/初始化脚本、容器编排文件、服务入口或 CI 配置。目录名、文件名或 server.basic_info 只能证明候选事实，不能证明项目一定需要 PHP、Node、Java、数据库、缓存、Nginx、Composer 或 Docker。每个 standalone 工具单独成轮，阶段证据必须在后续轮复用。
2. 将整体目标拆为有证据依赖关系的阶段：源码就位、运行环境、项目依赖/构建、运行配置与敏感变量、数据库/缓存等外部依赖、进程或容器托管、反向代理/防火墙（仅在项目与用户授权要求时）、启动、端到端验收。每轮只规划当前证据允许的步骤，但后续规划必须继续围绕 taskGoal.rootGoal，不得被“继续部署”“重试”替换。
3. 项目源码、工具版本、依赖安装和构建已由历史结构化证据确认时必须直接复用，不得重复 clone、重复安装或重复构建。调整计划被替换时，之前阶段仍属于同一整体任务，不能从上下文丢失。
4. 项目证据明确所需软件后，先用 software.check 精准检查这些命令的路径与版本，再决定是否联合 software-installation。不得先启用 EPEL、CRB 或第三方仓库；只有软件确实缺失、项目证据要求且当前系统仓库无法提供时，才规划仓库或镜像调整并独立验证。
5. 配置文件优先从项目示例最小化生成并保留无关内容；敏感值必须使用业务唯一的 key，例如 OFFICE_DATABASE_PASSWORD、PRODUCTION_REDIS_PASSWORD 或 TARGET_SSH_PASSWORD，禁止新建含义不明的 PASSWORD。现有变量元数据不能证明用途完全一致时，必须用 user.request_input 单独收集，并说明参数名称、用途、目标服务和提交后解锁的步骤；敏感值不得交给模型、写入日志或显示在命令中。
6. 任何数据库初始化、迁移、覆盖配置、开启服务、开放端口或替换线上版本都要遵守用户权限与风险审批；已有数据和配置先做只读识别，需要改动时建立可恢复备份。不得为了“能启动”关闭 TLS、认证、安全策略或清空数据。
7. 下载、依赖安装、构建、迁移与启动必须等待真实退出；安装 Composer/npm 包、镜像拉取或编译完成前不得提前验证。长驻应用使用项目证据支持的 systemd、容器编排或其他受管机制，不得用裸后台进程伪装部署成功。
8. 部署完成门禁必须同时具备：所需配置与依赖就绪、目标进程/容器真实健康、监听地址/端口符合预期、从正确入口进行的 HTTP/TCP/项目自带健康检查成功，以及必要数据库/缓存连接可用。仅源码存在、依赖安装成功、进程已启动、端口监听或命令 exit 0 都只是阶段成功，不得总结为整体部署完成。
9. 每个 Shell validation 都必须在独立 Shell 中重新读取同一目标的真实状态。command 若动态解析主机、端口、数据库名或用户，validation 也必须重新解析，不能硬编码未经证据确认的值；不得用 true、无条件 echo、忽略退出码的分支或依赖主命令 stdout 的裸 grep 验收。opsark-tool 步骤由严格 schema 与结构化结果承担证据，validation 固定为 true。
10. 若当前轮只完成中间阶段，结果必须明确“整体部署尚未完成”、列出已完成证据和剩余阶段，并自动进入可恢复的待继续状态；调整计划和托管审批不得清除已完成阶段证据。最终总结必须回到最初的部署目标，而不是总结最后一句“重试”。`,
  updatedAt: "2026-08-22T00:00:00.000Z",
};

const fileTransferIntegrity: SkillDefinition = {
  id: "file-transfer-integrity",
  name: "文件传输与完整性验证",
  category: "transfer",
  description: "在服务器之间安全传输文件；目标缺少受管凭据时向用户收集 SSH 登录信息，并使用字节数和 SHA-256 证据确认完整性。",
  version: 5,
  enabled: true,
  builtIn: true,
  matchRules: [
    "跨服务器文件传输",
    "发送文件到服务器",
    "复制构建产物或安装包",
    "SHA-256 文件完整性校验",
    "regex:(?:传输|发送|复制|拷贝|同步).*(?:文件|安装包|备份|产物)|(?:文件|安装包|备份|产物).*(?:传输|发送|复制|拷贝|同步)",
  ],
  allowedToolIds: ["server.resolve_connection", "user.request_input", "files.transfer_between_servers"],
  instructions: `这是证据驱动的文件传输与完整性验证参考流程，实际步骤仍由模型根据当前证据生成：
1. 先确认源服务器、源文件绝对路径、目标服务器和目标位置。用户只给出目标目录时，直接使用源文件 basename 补成最终目标文件绝对路径，不得重复询问文件名；仅当任务必需信息确实缺失时，才单独调用 opsark-tool user.request_input，每个字段必须说明参数及用途。
2. 传输前在源服务器执行单独的只读文件检查，确认源对象是存在、可读的普通文件，并获取真实绝对路径、字节数和 SHA-256。所有用户路径作为 Shell 参数时必须完整安全引用，并在命令支持时使用 -- 结束选项；普通文件判断使用 test -f 等不依赖语言环境的退出状态，不得比较 stat %F 的本地化文本。该步骤不得同时探测网络、认证或执行传输，也不得把目录、空匹配、同名文件或仅有路径文本当作已确认文件。
3. 源文件证据充分后，再单独检查源服务器到目标 SSH 端口的网络连通性；网络可达后，再单独使用 BatchMode 非交互 SSH 探测源服务器是否已有目标端认证。网络探测失败与认证失败必须如实保留非零退出码，交由复核阶段区分，不得用 || true、|| echo、末尾 true 或失败分支 exit 0 将失败改写成成功。
4. 认证分支必须严格按以下状态机执行，不能跨阶段猜测：
   - BatchMode 认证成功：使用该认证以前台 scp 直接传输，不请求密码。
   - BatchMode 认证失败：只查询目标 host/port 的 server.resolve_connection；源服务器和目标服务器身份不得互换。
   - resolve_connection 返回 managed-server 凭据引用：可以使用 files.transfer_between_servers 受管中转，不向模型暴露凭据。
   - 当前 serverCredentialGroups 或 resolve_connection 返回唯一匹配的 server-credential SSH 凭据组：必须直接复用，使用该组 usernamePlaceholder 构造 user@host，并在 description 中引用同组 secretPlaceholder。多个账号匹配时只请用户选择已有凭据组，不重新输入真实值。
   - 确实没有匹配凭据组：下一轮计划必须且只能调用 user.request_input，在同一表单请求类型为 password 的 TARGET_SSH_USERNAME 和 TARGET_SSH_PASSWORD，两个字段均标注目标 host 与 SSH/SCP 用途。提交后作为同一服务器凭据组长期保存。本轮禁止生成 scp、ssh、server.connect 或中转步骤，用户提交后再继续规划。
   - 用户输入完成：在当前源服务器可见 PTY 中以前台 scp 直接传输，命令仅使用 \${secret.TARGET_SSH_USERNAME}@host，description 引用同组 \${secret.TARGET_SSH_PASSWORD}。用户名只在执行边界展开，密码由 PTY 提示响应通道注入；两者都不得进入模型、日志或源服务器文件，不得使用 sshpass。
   文件传输工作流不得调用 server.connect 充当中转或凭据准备：server.connect 会改变当前终端所在服务器，不是 scp 的前置条件。尤其不得在目标为 192.168.1.237 时生成连接源服务器 192.168.1.236 的 server.connect。
5. 直接传输先写入目标同目录的唯一临时文件；目标同名文件未知时不得静默覆盖。scp 成功后在目标端读取临时文件字节数和 SHA-256，与源证据一致才原子提交为最终路径；失败、终止或校验不一致时清理临时文件且不得报告成功。
6. 仅当目标已经存在可用 managed-server credentialRef 且用户允许受管中转时，才调用 opsark-tool files.transfer_between_servers。server-credential 引用只用于当前可见 PTY 的前台 scp。目标未纳管或无受管凭据时不能调用中转工具，也不能通过 server.connect 临时伪造“已纳管”；应按第 4 条请求输入后走前台 scp。中转工具必须返回 transferredBytes、targetPath 和 sha256。
7. overwrite 默认为 false。只有用户明确允许覆盖，或真实证据确认目标文件可替换时，才能替换最终路径。不得把“用户要求传到某目录”自动解释为允许覆盖其中的未知同名文件。
8. 无论使用 scp 还是中转工具，最终成功都必须有目标文件字节数和 SHA-256 与源文件逐项一致的证据。中转工具已经在后端复读目标临时文件并校验哈希时，应复用其结构化证据，不再生成无凭据的目标端 Shell 校验。
每轮只规划当前证据允许的最少阶段；不得把源文件检查、网络探测、认证探测、传输和最终验收压进一个用条件分支吞掉退出码的 Shell 步骤。已获得的路径、字节数、哈希、网络状态、认证状态和目标资料必须复用，不得无证据重复发现或重复传输。`,
  updatedAt: "2026-08-24T00:00:00.000Z",
};

applicationDeployment.planningContract = deploymentPlanningContract(applicationDeployment.instructions);

export const builtInSkillCatalog: SkillDefinition[] = [
  sshTerminalJump,
  projectSourceAcquisitionSkill,
  softwareInstallation,
  projectBuild,
  databaseInspectionAndOperations,
  applicationDeployment,
  fileTransferIntegrity,
];
=======
﻿import { loadBuiltInSkills } from "./skillFileLoader";
export const builtInSkillCatalog = loadBuiltInSkills();
>>>>>>> origin/master
