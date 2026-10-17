# MCP 接入与验收

此文对应 **0.5.0 本地候选**，0.4.0 实测记录仅为历史。安装包提供 `veriscope-mcp`，源码入口为 `mcp.js`。可用版本以 [npm 包页面](https://www.npmjs.com/package/dsh-plugin-veriscope)为准；以下宿主示例使用隔离配置，不修改默认宿主配置。Claude／Codex 实际工具调用与 Linux 真实回放的完成状态单独记录。

> **升级前备份**：0.4.0 改变插件绑定范围，旧回执的当前有效性进入 REVIEW，不改写历史 PASS／FAIL。请先备份完整状态目录及原归档，持久状态目录应放在插件外；单独导出回执不是完整备份。重新 replay 后取得新版本回执。

## 0.5.0 新增独立阈值门禁

`veriscope_gate_check({archive_path,policy_path,format?})` 只需要 Node 和显式 `VERISCOPE_STATE_DIR`，不依赖 VeriScope、Python、pandas 或 Ragas。`doctor({engine:"builtin"})` 不探测上游。现为五个 MCP 工具、九个 DSH 工具；B2 返回文本与 structuredContent，不提供卡片或受管完成能力。输入、策略及 ReceiptV2 详见 [B2 说明](B2.md)。

仅使用 B2 时，下面的宿主 `env` 示例可只保留 `VERISCOPE_STATE_DIR`；使用 Node 绝对路径和本包 mcp.js，清除继承的 VeriScope 配置。状态根仍须外置持久目录，不读取 .env。B2 的状态检查不探测 Python。0.5.0 实测与 pending 项见 `acceptance-b2-v0.5.0.json`；下文的 0.4.0 平台和宿主成绩不代表本候选版已通过。

## 能力与判定边界

使用绝对 Node 路径启动 `mcp.js`，传输为本地 stdio。MCP 入口只导入共享服务，不加载 DSH SDK；DSH 保留原八工具及原生卡片，并新增独立 check。

| MCP 工具 | 用途 | `readOnlyHint` |
|---|---|---|
| `veriscope_gate_check({archive_path, policy_path, format?})` | Node 独立阈值门禁，写报告和 ReceiptV2 | `false` |
| `veriscope_doctor({engine?})` | 默认检查原 replay 环境；`engine:"builtin"` 只检查 Node 和显式状态根。会写入并清理临时探针 | `false` |
| `veriscope_gate_replay({result_path, baseline?, faith?, ctx?})` | 调用原 Python Quality Gate，写报告，满足条件时生成回执 | `false` |
| `veriscope_gate_status({run_id, faith?, ctx?, baseline_run_id?})` | 读取回执并核对当前绑定项，不执行门禁或写回执 | `true` |
| `veriscope_gate_list({limit?})` | 读取近期回执并检查当前有效性 | `true` |

batch／export 及 bind／complete 仅在 DSH 提供。MCP 无原生结果卡，不接收 `session_id` 等会话参数，报告 `execution.session_id=null`；不伪造宿主身份或移植受管任务授权。

DSH 入口在 SDK 加载前核对 `@deepseek-ai/dsh-tools` 与声明的精确版本，加载后检查 `defineTool`；缺失报 `SDK_MISSING`，版本或接口不兼容报 `SDK_INCOMPATIBLE`，加载或传递依赖故障报 `SDK_LOAD_FAILED`。诊断不会反射 SDK 异常原文，不自动安装或换版本。这是启动兼容检查，不替代宿主验收。MCP 入口不导入该启动模块或 DSH SDK。

工具返回中文 `content` 和 `structuredContent`。业务 FAIL 不等于 `isError:true`：有效门禁拦截仍是有效结果；参数、配置或执行故障另以工具错误表示。FAIL 与附加异常可同时存在，不能只看 `isError` 或将错误当成 PASS。REVIEW 永不转为 PASS，已确认 FAIL 不被日志／回执写入异常遮盖。

PASS 仅说明已有归档指标满足绑定的门禁条件，不证明回答事实正确，不授权完整发布。本工具不重评测、不修改归档、不优化提示词；无新增评测模型调用，宿主对话仍可能产生 token 费用。

## 路径、平台与状态留存

**没有 settings UI，不自动读取 `.env`。** 配置来自启动进程的环境变量，均须为非空绝对路径；无效值不会静默回退。宿主通过 `env` 传值也遵循这些要求。

| 环境变量 | Windows | POSIX |
|---|---|---|
| `VERISCOPE_ROOT` | 沿用默认 `D:\RAG_Evaluation_Demo`，建议显式配置 | 必须显式配置，不使用 Windows 默认值 |
| `VERISCOPE_PYTHON` | 未设置时依次探测上游 `.venv/Scripts/python.exe`、`venv/Scripts/python.exe` | 未设置时依次探测 `.venv/bin/python`、`venv/bin/python` |
| `VERISCOPE_STATE_DIR` | MCP 必须显式配置持久目录 | MCP 必须显式配置持久目录 |

解释器不回退全局 PATH。五个 MCP 工具都先检查显式状态根；缺失或值无效时返回结构化待复核，不访问包目录的默认状态。初始化及工具发现仍可完成。DSH 原 replay 继续使用默认 `<插件目录>/.local`；DSH B2 仍强制显式状态根。建议使用插件外的持久目录，以免重装或临时缓存影响历史记录。

Windows 的专用终端示例：

```powershell
$env:VERISCOPE_ROOT = 'D:\your-workspace\VeriScope'
$env:VERISCOPE_PYTHON = 'D:\your-workspace\VeriScope\venv\Scripts\python.exe'
$env:VERISCOPE_STATE_DIR = 'D:\your-data\veriscope-mcp-state'
& 'D:\node.exe' 'D:\your-workspace\dsh-plugin-veriscope\mcp.js'
```

POSIX 的独立终端示例：

```sh
export VERISCOPE_ROOT='/home/you/work/VeriScope'
export VERISCOPE_PYTHON='/home/you/work/VeriScope/.venv/bin/python'
export VERISCOPE_STATE_DIR='/home/you/data/veriscope-mcp-state'
/usr/bin/node /home/you/work/dsh-plugin-veriscope/mcp.js
```

替换为真实、已存在的源码与解释器路径；Node 需 ≥22.19。stdio 进程等待宿主发来的 JSON-RPC，并非网页或自然语言终端。不要向 stdout 加启动横幅；诊断输出仅用 stderr。

所有运行、导出与完成记录默认**无限期保留**，没有自动清理。日志可能含归档片段及本地路径，分享前需审阅。设置显式状态根后可运行：

```sh
node scripts/prune.mjs --dry-run --json
```

此命令只读显示清单、逻辑字节数及记录中可读的关联；关联不是有效性证明，损坏或未知关系不推断。扫描截断、跳过链接及不可读项会明确列出。它没有删除入口，也不承诺计算实际磁盘占用。

## Claude Code 与 Codex 配置

两种示例都启动本地源码，不要求安装 DSH alpha peer。宿主本身的安装与登录不属于插件部署；**配置写入成功不等于工具调用验收通过**。

### Claude Code：独立配置目录

在专用终端将 `CLAUDE_CONFIG_DIR` 设置为新的隔离目录，例如 `D:\your-data\veriscope-claude-profile`。以下 user scope 仅用于该隔离环境；不要在默认配置目录执行：

```powershell
claude mcp add --scope user `
  --env 'VERISCOPE_ROOT=D:\your-workspace\VeriScope' `
        'VERISCOPE_PYTHON=D:\your-workspace\VeriScope\venv\Scripts\python.exe' `
        'VERISCOPE_STATE_DIR=D:\your-data\veriscope-claude-state' `
  --transport stdio veriscope -- `
  'D:\node.exe' 'D:\your-workspace\dsh-plugin-veriscope\mcp.js'
claude mcp get veriscope
```

`--` 后是服务命令及参数；`--env` 后的多个值在 `--transport stdio` 前结束，避免服务器名被解析为环境变量。管理命令与 stdio 配置依据 [Claude Code 官方 MCP 文档](https://code.claude.com/docs/en/mcp)。在同一隔离环境移除配置可用 `claude mcp remove veriscope --scope user`；它不删除插件状态根。

### Codex：独立配置目录

在专用进程环境将 `CODEX_HOME` 指向新的隔离目录，例如 `D:\your-data\veriscope-codex-profile`，只在该目录的 `config.toml` 写入下例，不修改默认 `~/.codex/config.toml`：

```toml
[mcp_servers.veriscope]
command = 'D:\node.exe'
args = ['D:\your-workspace\dsh-plugin-veriscope\mcp.js']
startup_timeout_sec = 30
tool_timeout_sec = 180

[mcp_servers.veriscope.env]
VERISCOPE_ROOT = 'D:\your-workspace\VeriScope'
VERISCOPE_PYTHON = 'D:\your-workspace\VeriScope\venv\Scripts\python.exe'
VERISCOPE_STATE_DIR = 'D:\your-data\veriscope-codex-state'
```

POSIX 使用同样的 TOML 字段，改为 `/usr/bin/node` 与相应绝对路径。配置中的 180 秒用于覆盖门禁 120 秒及额外环境检查；服务仍执行自身的超时限制。字段依据 [OpenAI 官方 MCP 配置说明](https://developers.openai.com/codex/mcp)。在隔离环境运行 `codex mcp list`／`codex mcp get veriscope` 仅核对注册，不会据此记为实际宿主工具调用通过。

配置完成后，可在宿主中明确要求依次使用 doctor、replay、status：先体检，再传归档绝对路径，最后用返回的 `run_id` 查询当前有效性。是否自动选择工具由宿主决定；本轮验收不发起模型对话。

## 协议、契约与回执兼容

stdio 使用 UTF-8 单行 JSON-RPC，明确支持 `2025-06-18` 与 `2025-11-25`，优先后者；不宣称支持所有新版协议。不支持客户端请求的版本时，返回服务所支持的优先版本，由客户端决定是否继续。生命周期依据 [MCP 2025-11-25 规范](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle)。

- 方法：initialize、initialized 通知、ping、tools/list、tools/call、取消通知；未知方法和非法参数不执行工具。
- 单条输入上限 1 MiB，最多八个在途调用；doctor／replay／check 串行，ping 与取消不会等待它们结束。stdout 仅协议消息。
- EOF、SIGINT 或 SIGTERM 取消在途任务，不自动重试写入。中断不是完成证明，仍须保留已有记录并再次检查。
- 工具名与参数定义来自共享的标准 JSON Schema 目录；DSH 在注册边界转换为其 DSL，并移除 DSL 不支持的 `minimum`／`maximum` 表示。两宿主都保留服务层范围校验，不声称转换后的 schema 字节相同。MCP 仅允许上述五工具，拒绝未知字段及伪造会话参数。

运行时只接受原审阅契约或新增 LF 契约中**一整套原字节完全匹配**。LF 契约来自固定公开提交 `1b89bcabb83e1b123039799516596fdcfd393d42`；仅接纳审阅确认的相关行尾差异。不逐文件拼接，不运行时归一化，不因更换宿主而放宽执行器校验。

本次将 MCP 入口、共享工具目录及契约选择模块纳入回执哈希。升级后旧回执保留原历史裁决，其当前可复用资格进入 REVIEW；不改旧报告、回执或历史 FAIL。只读 status 不能生成新回执，ReceiptV1 只有实际 replay 可以生成；ReceiptV2 由实际 B2 check 生成。

## 0.4.0 历史验收与仍未证明的范围

完整源码的复现入口：

```sh
node --test
node scripts/verify-mcp.mjs
```

第二条需要配置真实的 `VERISCOPE_ROOT`、`VERISCOPE_PYTHON` 及独立 `VERISCOPE_STATE_DIR`，并具备匹配契约的上游源码和 pandas。结果写入该状态根的 `verification/`。它是**自写 stdio 客户端＋真实 Python 回放**，不会伪装为 Claude Code／Codex 宿主验收。

Ubuntu 远端 CI 已使用固定上游提交、Python 3.11.9、pandas 3.0.6 与公开构造样例实跑 PASS／FAIL／REVIEW；Ubuntu／Windows × Node 22／24 测试矩阵通过。首次 venv 符号链接问题已修复，失败运行保留。构造样例不称为真实用户历史。

实际进度见 [版本验收记录](acceptance-mcp-v0.4.0.json)：DSH 真实 ToolRuntime、Claude Code、Codex 逐宿主分别记录。注册、握手、发现和实际工具调用分开；无法在零模型调用下完成真实调用时保留 pending，不用自写客户端补齐。

跨入口比较保留状态、`gate_passed`、退出码、阈值、指标、证据摘要及诊断代码，只允许运行编号、时间、会话与产物路径等已列明差异。未知字段或缺失依据不得补成一致。

本工具仍定位单人本地工具：没有 RBAC、多用户隔离或自动保留期管理。请按项目使用独立状态根。跨平台与协议适配不等于企业全面就绪，也不证明语义正确、算法首创或端到端降本。

## 0.4.0 历史部署复核

下表及其 266 项测试统计属于 0.4.0 历史记录。本轮 0.5.0：Windows 共 363 项测试，361 通过、2 个 POSIX 专项跳过；Ubuntu 未运行。B2 三宿主实调用与限制以 `acceptance-b2-v0.5.0.json` 为准。

| 项目 | 本轮结果 | 剩余范围 |
|---|---|---|
| 独立部署与依赖 | tarball 正常干净安装、实际 bin 与真实 Python 三态通过；未安装 DSH alpha 包 | 发布状态以 npm／GitHub Release 为准 |
| 状态根持久性 | MCP 强制显式目录；所有模式默认无限期保留 | DSH 兼容默认仍在包内，建议外置；没有备份恢复保证 |
| Windows／POSIX | Windows 原契约和 LF 契约均真实回放通过；POSIX 配置分支单测通过 | Ubuntu 真实回放及单测已通过；macOS 真实运行未验 |
| 宿主接入 | DSH ToolRuntime 29 次；正式 npm 包在 Claude／Codex 各 10 次真实控制接口调用，无模型对话 | Claude 错误路径只回文本；三家四例全部字段一致未通过 |
| 生命周期 | 只读 CLI 展示容量、记录及未核实的关联 | 无自动到期、删除、集中运维或多用户权限体系 |

当前共 266 项测试：Windows 264 通过、2 个 POSIX 专项跳过；Ubuntu 266 全通过。正式 npm 包已下载校验，正常干净安装未拉入 DSH alpha 包，bin 握手与实际宿主调用通过。

两家宿主的四工具分别经真实控制接口调用；没有发送用户对话或模型回合，不等于模型自动选工具或完整聊天体验已验证。四例的门禁裁决相同，其中三例可从三家宿主的结构化响应比较全部 11 个保留字段。非法 JSON 的 REVIEW 在 Claude Code 2.1.278 控制 API 中以错误文本返回；其落盘报告缺少稍后附加的 `RECEIPT_UNAVAILABLE`，该代码能在宿主错误文本中看到。没有补填或删除字段来凑齐一致；完整结构化错误交付保留为未通过。

0.4.0 的 npm 包与标签保留发布时内容；发布后的补验记录更新在仓库中，不移动已发布标签或覆盖包。详细记录与失败证据见版本验收 JSON。
