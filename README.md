# VeriScope 离线门禁重放 · DSH 插件

**中文** · [English](https://github.com/4444wjt/dsh-plugin-veriscope/blob/main/README.en.md) · [日本語](https://github.com/4444wjt/dsh-plugin-veriscope/blob/main/README.ja.md) · [한국어](https://github.com/4444wjt/dsh-plugin-veriscope/blob/main/README.ko.md)

> **0.4.0 升级提示**：旧回执的当前有效性将进入 REVIEW，历史 PASS／FAIL 不会改写。升级前请备份完整状态目录及原归档，并使用插件外的持久状态目录；包内 `.local` 可能随重装丢失，单独导出回执不是完整备份。重新 replay 后取得新版本回执。

把已有的 VeriScope 评测 JSON 接入 DSH，调用 VeriScope 原有的 Python Quality Gate，返回**通过／失败／待复核**、当前回执有效性与来源。

[GitHub](https://github.com/4444wjt/dsh-plugin-veriscope) · [Gitee 手动镜像](https://gitee.com/kkbushishou/dsh-plugin-veriscope) · 完整 VeriScope：[主仓库](https://github.com/4444wjt/RAG_Evaluation_Demo)／[镜像](https://gitee.com/kkbushishou/rag-hallucination-evaluator)。Issue 和 PR 请提交到 GitHub。

Python 是唯一数值裁判；REVIEW 永不转为 PASS，已确认 FAIL 不被附加异常遮盖。PASS 只说明归档指标通过所绑定门禁，不证明回答事实正确。插件不重新评测、不修改归档、不执行发布或 Git 操作。

---

本插件复查已有的 VeriScope 评测归档，不优化提示词，也不改写回答。它调用原有的 Python Quality Gate，记录判定所用的输入、阈值与执行环境，并检查回执当前是否有效。PASS 仅表示归档指标满足所绑定的门禁条件，不能代替完整发布验收。

当前接受的输入是 VeriScope 归档格式；通用归档格式与适配器尚未提供。不支持的格式会被拒绝，不会猜测或换算。

## 配置完成后，30 秒上手

配置好环境后（见下一节），在 DSH 中依次输入：

1. “使用 `veriscope_doctor` 检查本机环境，告诉我需要修复什么。”
2. “使用 VeriScope 检查 `D:\数据\评测结果.json`，说明是否通过及原因。”
3. “使用 `veriscope_gate_list` 列出最近的门禁回执与当前有效性。”

之后还可以说：

> 检查上次的门禁结果现在是否仍然有效。

体检的“环境就绪”仅表示环境可用，门禁通过需实际重放。聊天能否自动选中工具取决于 DSH 的模型配置；需要时直接写出工具名。

三个常见的小场景：

- **想发给维护者**：“把这次门禁失败整理成可分享的求助摘要。”使用 `format: "share"` 生成本地 Markdown，先预览、再自行分享；不是回执。
- **归档打不开**：重放会在能确认时给出异常行列或字段位置，帮助定位；不会自动改文件。
- **昨天通过、今天待复核**：状态检查会列出已确认的阈值、版本、输入摘要等变化；无法核实的范围明确保留。

需要约束任务完成时，可以要求绑定本次检查；只有绑定的回执当前有效且为 PASS，才能登记完成。

**使用前请配置 VeriScope 与 Python 路径；插件不会重新调用评测模型。**

## 安装与配置

本文对应 **0.4.0**，提供 DSH 插件和独立的 `veriscope-mcp` 入口。npm 可用版本以[包页面](https://www.npmjs.com/package/dsh-plugin-veriscope)为准；MCP 配置与待验范围见下文。在已验证的 DSH CLI 中，需显式指定 profile；以下使用独立的 `veriscope-demo`：

```powershell
# 安装
dsh plugin --profile veriscope-demo add dsh-plugin-veriscope
# 查看已安装版本
dsh plugin --profile veriscope-demo list dsh-plugin-veriscope --depth 0
# 卸载
dsh plugin --profile veriscope-demo remove dsh-plugin-veriscope
```

二次开发可走**本地目录安装**，与 npm 包名安装分开：

```powershell
dsh plugin --profile veriscope-demo add 'D:\your-workspace\dsh-plugin-veriscope'
```

以上目录路径须替换为源码实际位置；不要将目录／link 安装结果当成 registry 安装证明。**安装成功不等于门禁通过**，首次使用仍需配置 `VERISCOPE_ROOT` 与 `VERISCOPE_PYTHON` 并运行体检。npm 包不含测试与 `docs`；`npm test` 仅供源码开发；`node scripts/verify-replay.mjs` 也仅在完整源码仓库及其验证材料就绪时可用，不属于安装包能力。完整文档请查看仓库。

0.3.x 历史已验证：Windows、DSH NEXT 2.0.18-next，内部 DSH／tools／skill **0.2.1-alpha.2**。Node ≥22.19；其他宿主版本未验证。另需兼容上游及 Python／pandas，固定依赖见 [上游说明](https://github.com/4444wjt/dsh-plugin-veriscope/blob/main/docs/UPSTREAM.md)。插件不附送完整上游或业务归档。

DSH 入口要求 `@deepseek-ai/dsh-tools` 为 `0.2.1-alpha.2`，加载前核对版本，加载后检查 `defineTool`。缺失、不兼容、加载失败分别报 `SDK_MISSING`、`SDK_INCOMPATIBLE`、`SDK_LOAD_FAILED`，不会自动安装或切换版本；这些检查不代替宿主验收。MCP 不加载 DSH SDK。

### 配置项

**没有 settings UI，不自动读取 `.env`。** 路径只读宿主进程环境变量；cordis patch 只接受 `completionMode`。宿主自己的环境加载策略由宿主决定。

| 配置 | 入口 | 默认值与要求 |
|---|---|---|
| `veriscopeRoot` | `VERISCOPE_ROOT` | Windows 默认 `D:\RAG_Evaluation_Demo`；POSIX 必须显式设置 |
| `pythonPath` | `VERISCOPE_PYTHON` | 依次探测 `.venv`／`venv`：Windows 为 `Scripts/python.exe`，POSIX 为 `bin/python`；不回退 PATH |
| 状态根 | `VERISCOPE_STATE_DIR` | DSH 默认 `<插件目录>/.local`，建议显式持久目录；MCP 必须显式设置 |
| 提醒模式 | cordis patch `completionMode` | `off`；只允许 `off` 或 `remind`，非法值报错 |

三个环境变量的显式值须为非空绝对路径，无效值不静默回退。在**启动 DSH 的同一终端**设置后启动或完全重启宿主：

```powershell
$env:VERISCOPE_ROOT = 'D:\your-workspace\VeriScope'
$env:VERISCOPE_PYTHON = 'D:\your-workspace\VeriScope\venv\Scripts\python.exe'
$env:VERISCOPE_STATE_DIR = 'D:\your-data\veriscope-state'
# 若从 GitHub 安装，可用此命令替代前文的 npm 安装命令
dsh plugin --profile veriscope-demo add github:4444wjt/dsh-plugin-veriscope
```

先准备独立 profile 和对应宿主 CLI；安装命令不创建完整宿主配置。插件 bundle 已插入默认条目；在 `<DSH_HOME>/profiles/<名称>/cordis.patch.yml` 按已有 `id` 覆盖配置，不要再次 `insert`：

```yaml
- id: dsh-plugin-veriscope
  config:
    completionMode: "remind"
```

`off` 关闭停止事件提醒，全部工具仍可使用。`remind` 只提醒未完成的绑定任务，不承诺普通聊天全局阻断。路径不能写入这个 config。

## 跨宿主 MCP（0.4.0）

本版本提供 Claude Code／Codex 的 stdio MCP 配置：Claude 已完成隔离注册与连接，Codex 已完成隔离注册与配置回读；两者实际工具调用均待验。Windows 已验证，Linux 真实回放待验。使用绝对 Node 路径启动源码 `mcp.js`，配置及独立环境示例见 [MCP 接入说明](https://github.com/4444wjt/dsh-plugin-veriscope/blob/main/docs/MCP.md)。无需加载 DSH SDK。首版只有 `veriscope_doctor`、`veriscope_gate_replay`、`veriscope_gate_status`、`veriscope_gate_list` 四工具，无原生卡片。batch／export 及 bind／complete 仍只在 DSH；会话绑定不会移植，MCP 报告的 `execution.session_id` 为 `null`。

MCP 四工具都要求显式、合法的 `VERISCOPE_STATE_DIR`；未设置时返回待复核，不回退包目录。doctor 会写入并清理临时探针，replay 会写报告和回执，二者不是只读；status／list 为只读。业务 FAIL 不等于工具执行错误。宿主工具调用、Linux 真实回放及本版本验收状态以 [验收记录](https://github.com/4444wjt/dsh-plugin-veriscope/blob/main/docs/acceptance-mcp-v0.4.0.json) 为准；注册成功或自写客户端通过不能替代宿主验收。

## 八个工具

| 工具 | 用途 |
|---|---|
| `veriscope_doctor({})` | 检查路径、脚本契约、Python／pandas、状态根写入和最近回执；返回环境就绪或待复核与修复建议 |
| `veriscope_gate_replay({result_path, baseline?, faith?, ctx?})` | 实际执行已有归档门禁，保存独立记录，符合条件时生成 ReceiptV1 |
| `veriscope_gate_status({run_id, faith?, ctx?, baseline_run_id?})` | 只读检查回执当前有效性，不重放、不评分、不生成回执 |
| `veriscope_gate_list({limit?})` | 默认列出最近 50 条，允许 1–200；逐条复用 status，损坏记录另列 |
| `veriscope_gate_batch({paths?, dir?, baseline?, faith?, ctx?})` | 路径数组与目录二选一；顺序重放，最多 200 份，可取消，逐份留痕 |
| `veriscope_gate_export({run_id?, run_ids?, format})` | 导出 1–50 条记录到状态根 `exports/`；`share` 为白名单求助摘要，`md` 为完整报告，`json` 为原回执；不覆盖旧文件 |
| `veriscope_gate_bind({task_id, run_id, faith?, ctx?, baseline_run_id?})` | 在宿主提供的本会话内绑定受管任务与当前回执 |
| `veriscope_gate_complete({task_id, run_id})` | 复验本会话绑定，只在当前有效 PASS 下登记完成 |

### 参数与使用规则

- 阈值默认 0.8，须为 0–1 有限数值，不为获得 PASS 自动调低。
- 归档相对路径以 `VERISCOPE_ROOT` 为基准。
- `baseline_run_id` 省略保持原基线，`null` 要求无基线，UUID 引用当前状态根中的有效回执。
- `task_id` 为 1–80 位字母、数字、下划线、点或连字符；会话标识不接受工具参数伪造。绑定只在内存中，重启需重新绑定，磁盘完成记录不会恢复授权。

“检查有效性”用 status；“重新执行门禁”用 replay。只有实际 replay 能生成回执。输入、基线、策略、上游、插件或环境变化时，旧回执进入待复核，历史失败仍保留。详见 [回执协议](https://github.com/4444wjt/dsh-plugin-veriscope/blob/main/docs/RECEIPTS.md)。

0.4.0 接受原契约及固定公开提交 `1b89bcabb83e1b123039799516596fdcfd393d42` 审阅得到的 LF 契约，只接受其中一整套原字节匹配，不逐文件拼接，也不在运行时归一化。MCP 入口、共享工具目录及契约选择代码纳入回执哈希；升级后旧回执的当前有效性进入 REVIEW，历史记录不变。

### 输入与输出示例

```text
veriscope_doctor({})
→ {status:"READY", ready:true, summary:"环境就绪", items:[…]}
veriscope_gate_list({limit:10})
→ {items:[{run_id:…, historical_verdict:"PASS", current_verdict:"REVIEW", …}], damaged:[…]}
veriscope_gate_batch({paths:["a.json","b.json","broken.json"]})
→ {status:"FAIL", counts:{pass:1, fail:1, review:0, error:1}, …}
veriscope_gate_export({run_id:"实际运行 UUID", format:"md"})
→ {exported:true, path:"<状态根>/exports/<唯一文件名>.md", …}
veriscope_gate_export({run_id:"实际运行 UUID", format:"share"})
→ {exported:true, share_summary:{schema_version:"GateShareSummaryV1", is_receipt:false, …}, …}
```

以上为字段示例，不是实测业务结果。批量**有 FAIL 就汇总为 FAIL**；没有 FAIL 但存在待复核、错误、取消或未处理项时为 REVIEW。目录只读直接包含的 JSON，不递归。错误不掩盖已确认失败，失败不阻止下一份重放。

### 清单、批量与导出

清单最多扫描 10,000 个目录项，超限明确待复核；`limit` 范围外的回执不做当前环境复验。坏回执时间不能可信读取时，排序使用目录修改时间并标明来源。导出单条 JSON 与原回执字节一致，多条为原回执对象数组；JSON 中历史 PASS 不代表当前有效，当前状态另见工具返回的 `current`。Markdown 同时列历史与当前状态、归档指标、阈值、证据条数和限制。体检只创建并清理自身临时写入探针，不改配置或安装依赖。

`share` 另生成 Markdown，只取固定状态、已知原因、有限指标/阈值、计数和严格版本号；省略路径、原文、日志、模型标签、时间、哈希及未知字段，以“记录1”等别名代替运行编号。请分享**文件正文或 `share_summary`**，整个工具返回仍含本地文件位置。数值和版本也可能敏感，请先预览。摘要不能用于 status/bind/complete，不证明事实正确，也不保证识别全部秘密。

### 异常定位与变化说明

JSON 拒绝时，`execution.errors[].diagnostic` 提供可确认的发现点：行列从 1 开始，按解码后 UTF-16 计数；CRLF 视为一次换行。受限字段路径无法安全确定时为 `null`，不回显原文。位置不一定是唯一修改点；不自动修复或额外重试。

status 的 `changes` 只解释原回执与本次捕获的固定绑定字段，最多显示 20 项并标明截断。`COMPLETE` 仅指所列范围已核对，未变化也不代表事实正确；`UNVERIFIED` 表示部分或全部未核实，已确认变化仍可列出。契约校验失败沿用原拒绝路径，其余未核实，不绕过检查补造对照，也不据此归因分数变化。

## 原生结果卡（DSH）

支持 `tool.call.toolview` 的宿主显示一张深色金色中文结果卡：当前三态、下一步、“重新检查”和折叠依据。按钮只读查状态，不能重放或登记完成。没有卡片接口时保留中文工具文本。

折叠依据包含中文原因、回执阈值、Node／Python／pandas 版本，以及输入路径、字节数和 SHA-256 前 12 位；缺失值保持未知。这些是回执绑定的历史环境描述，当前有效性仍以本次检查为准。

折叠区还列出绑定项变化与未核实提示；原重放有可确认的归档异常位置时，一并显示并标为历史诊断。版本信息是门禁回放环境，不冒充原始模型评测环境。

卡片打开时按同一组显式阈值/基线策略重新检查，不直接显示历史 PASS；加载失败、策略无效、缺少本会话关联或协议不完整均为待复核。显示仅代表所示检查时刻，不持续监视文件，使用前可再次检查。原生卡片不提供路径设置面板。

## 三态与判定规则

插件读取已有评测结果，执行门禁检查，展示三种状态：通过（PASS）、未通过（FAIL）和待复核（REVIEW）。

| 当前状态 | `gate_passed` | 含义 |
|---|---|---|
| PASS | `true` | Python 通过，回执完整且本次所查绑定项未变 |
| FAIL | `false` | Python 明确拦截，回执完整且当前绑定项未变 |
| REVIEW | `null` | 输入、依赖、回执或执行不完整，或绑定项变化、协议冲突 |

replay 确认 FAIL 后即使回执写入失败，核心 FAIL 仍保留；后续 status 因缺少完整回执为当前 REVIEW。原 report 的 FAIL 记录仍可阅读，无法校验的历史字段保持 unknown。Python 退出 1 但只有 traceback 仍为 REVIEW。

## 输出与数据边界

记录在 `<状态根>/runs/<run_id>/`，包含 `report.json`、stdout、stderr，以及符合生成条件的 `receipt.json`；完成登记另存 `completions/`。追加记录不覆盖失败。日志可能含归档片段与本地路径，分享前脱敏；插件不上传归档或打印完整环境。

所有记录默认无限期保留，没有自动清理。设置显式 `VERISCOPE_STATE_DIR` 后，`node scripts/prune.mjs --dry-run --json` 仅只读预演文件清单、逻辑字节数和已记录的关联，不验证关联正确性，也不提供删除入口。卸载或重装前请将状态根放在插件目录之外。

输入限 10MiB，stdout／stderr 各 2MiB，重放 120 秒，环境探测每次 10 秒。status 会读取并哈希文件、启动 Python 查版本及 pandas 元数据，不运行评测模型或门禁脚本。哈希不证明语义正确，不抵御能重写整个状态根的用户；检查后的变化需再次检查发现。

历史 Trace 仅核对逐字出处，标 `historical_ai`，不是新语义核查。内核零新增评测模型调用，宿主对话仍可能产生 token 费用；不宣称算法首创或端到端降本。

## 验证与维护

```powershell
node --test
node scripts/replay.mjs --result 'D:\your-data\evaluation.json' --json
dsh plugin --profile veriscope-demo remove dsh-plugin-veriscope
```

单元测试使用构造归档和协议桩，不需要模型或 Python。真实 Python 与宿主验收另见 [验证说明](https://github.com/4444wjt/dsh-plugin-veriscope/blob/main/docs/verification.md)。卸载移除注册；插件不会主动删除外置状态根，但包目录内的默认状态可能随移除或重装丢失，请先备份。源码发布须显式设置 `VERISCOPE_RELEASE=1`，并通过版本／tag 守卫；详见贡献指南。

## 贡献与许可

[贡献指南](https://github.com/4444wjt/dsh-plugin-veriscope/blob/main/CONTRIBUTING.md) · [治理规则](https://github.com/4444wjt/dsh-plugin-veriscope/blob/main/GOVERNANCE.md) · [更新记录](https://github.com/4444wjt/dsh-plugin-veriscope/blob/main/CHANGELOG.md) · [路线图](https://github.com/4444wjt/dsh-plugin-veriscope/blob/main/ROADMAP.md) · [安全报告](https://github.com/4444wjt/dsh-plugin-veriscope/blob/main/SECURITY.md) · [发布检查](https://github.com/4444wjt/dsh-plugin-veriscope/blob/main/docs/RELEASE_CHECKLIST.md)。市场 PR 未合并前不称已收录。

MIT，保留脚手架原版权；来源见 [第三方说明](https://github.com/4444wjt/dsh-plugin-veriscope/blob/main/THIRD_PARTY_NOTICES.md) 和 [来源哈希](https://github.com/4444wjt/dsh-plugin-veriscope/blob/main/docs/provenance.json)。上游单独分发，须遵守自身许可。
