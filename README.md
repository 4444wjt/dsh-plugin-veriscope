# VeriScope 离线门禁重放 · DSH 插件

把已有 VeriScope 评测 JSON 接入 DSH，调用原 Python Quality Gate，返回**通过／失败／待复核**、当前回执有效性与来源。v0.3.0 增加环境体检、回执清单、批量重放和报告导出。

[GitHub](https://github.com/4444wjt/dsh-plugin-veriscope) · [Gitee 手动镜像](https://gitee.com/kkbushishou/dsh-plugin-veriscope) · 完整 VeriScope：[主仓库](https://github.com/4444wjt/RAG_Evaluation_Demo)／[镜像](https://gitee.com/kkbushishou/rag-hallucination-evaluator)。Issue 和 PR 请提交到 GitHub。

Python 是唯一数值裁判；REVIEW 永不转为 PASS，已确认 FAIL 不被附加异常遮盖。PASS 只说明归档指标通过所绑定门禁，不证明回答事实正确。插件不重新评测、不修改归档、不执行发布或 Git 操作。

## 怎么用

**30 秒上手**：配置好下面的环境后，在 DSH 中依次输入：

1. “使用 `veriscope_doctor` 检查本机环境，告诉我需要修复什么。”
2. “使用 VeriScope 检查 `D:\数据\评测结果.json`，说明是否通过及原因。”
3. “使用 `veriscope_gate_list` 列出最近的门禁回执与当前有效性。”

体检的“环境就绪”仅表示环境可用，门禁通过需实际重放。聊天能否自动选中工具取决于 DSH 的模型配置；需要时直接写出工具名。

插件读取已有评测结果，执行门禁检查，展示三种状态：

- **通过（PASS）**：满足当前阈值。
- **未通过（FAIL）**：存在未达标项。
- **待复核（REVIEW）**：材料缺失或结果有效性无法确认。

之后还可以说：

> 检查上次的门禁结果现在是否仍然有效。

需要约束任务完成时，可以要求绑定本次检查；只有绑定的回执当前有效且为 PASS，才能登记完成。

**使用前需配置 VeriScope 与 Python 路径。插件复查已有结果，不会重新调用评测模型；聊天中能否自动选中工具，取决于 DSH 的模型配置。**

## 安装与配置

已验证：Windows、DSH NEXT 2.0.18-next，内部 DSH／tools／skill **0.2.1-alpha.2**。Node ≥22.19；其他宿主版本未验证。另需兼容上游及 Python／pandas，固定依赖见 [上游说明](docs/UPSTREAM.md)。插件不附送完整上游或业务归档。

**没有 settings UI，不自动读取 `.env`。**路径只读宿主进程环境变量；cordis patch 只接受 `completionMode`。宿主自己的环境加载策略由宿主决定。

| 配置 | 入口 | 默认值与要求 |
|---|---|---|
| `veriscopeRoot` | `VERISCOPE_ROOT` | `D:\RAG_Evaluation_Demo`；其他机器请显式设置 |
| `pythonPath` | `VERISCOPE_PYTHON` | 依次探测上游 `.venv`／`venv`，不回退 PATH |
| 状态根 | `VERISCOPE_STATE_DIR` | `<插件目录>/.local`；显式值优先，可用于只读安装目录 |
| 提醒模式 | cordis patch `completionMode` | `off`；只允许 `off` 或 `remind`，非法值报错 |

三个环境变量的显式值须为非空绝对路径，无效值不静默回退。在**启动 DSH 的同一终端**设置后启动或完全重启宿主：

```powershell
$env:VERISCOPE_ROOT = 'D:\your-workspace\VeriScope'
$env:VERISCOPE_PYTHON = 'D:\your-workspace\VeriScope\venv\Scripts\python.exe'
$env:VERISCOPE_STATE_DIR = 'D:\your-data\veriscope-state'
dsh plugin --profile veriscope-demo add github:4444wjt/dsh-plugin-veriscope
```

先准备独立 profile 和对应宿主 CLI；安装命令不创建完整宿主配置。插件 bundle 已插入默认条目；在 `<DSH_HOME>/profiles/<名称>/cordis.patch.yml` 按已有 `id` 覆盖配置，不要再次 `insert`：

```yaml
- id: dsh-plugin-veriscope
  config:
    completionMode: "remind"
```

`off` 关闭停止事件提醒，四个工具仍可使用。`remind` 只提醒未完成的绑定任务，不承诺普通聊天全局阻断。路径不能写入这个 config。

## 八个工具

| 工具 | 用途 |
|---|---|
| `veriscope_doctor({})` | 检查路径、脚本契约、Python／pandas、状态根写入和最近回执；返回环境就绪或待复核与修复建议 |
| `veriscope_gate_replay({result_path, baseline?, faith?, ctx?})` | 实际执行已有归档门禁，保存独立记录，符合条件时生成 ReceiptV1 |
| `veriscope_gate_status({run_id, faith?, ctx?, baseline_run_id?})` | 只读检查回执当前有效性，不重放、不评分、不生成回执 |
| `veriscope_gate_list({limit?})` | 默认列出最近 50 条，允许 1–200；逐条复用 status，损坏记录另列 |
| `veriscope_gate_batch({paths?, dir?, baseline?, faith?, ctx?})` | 路径数组与目录二选一；顺序重放，最多 200 份，可取消，逐份留痕 |
| `veriscope_gate_export({run_id?, run_ids?, format})` | 导出 1–50 条回执到状态根 `exports/`；支持 `md`／`json`，不覆盖旧文件 |
| `veriscope_gate_bind({task_id, run_id, faith?, ctx?, baseline_run_id?})` | 在宿主提供的本会话内绑定受管任务与当前回执 |
| `veriscope_gate_complete({task_id, run_id})` | 复验本会话绑定，只在当前有效 PASS 下登记完成 |

阈值默认0.8，须为0–1有限数值，不为获得 PASS 自动调低。归档相对路径以 `VERISCOPE_ROOT` 为基准。`baseline_run_id` 省略保持原基线，`null` 要求无基线，UUID 引用当前状态根中的有效回执。`task_id` 为1–80位字母、数字、下划线、点或连字符；会话标识不接受工具参数伪造。绑定只在内存中，重启需重新绑定，磁盘完成记录不会恢复授权。

“检查有效性”用 status；“重新执行门禁”用 replay。只有实际 replay 能生成回执。输入、基线、策略、上游、插件或环境变化时，旧回执进入待复核，历史失败仍保留。详见 [回执协议](docs/RECEIPTS.md)。

新工具的输入与输出示例：

```text
veriscope_doctor({})
→ {status:"READY", ready:true, summary:"环境就绪", items:[…]}
veriscope_gate_list({limit:10})
→ {items:[{run_id:…, historical_verdict:"PASS", current_verdict:"REVIEW", …}], damaged:[…]}
veriscope_gate_batch({paths:["a.json","b.json","broken.json"]})
→ {status:"FAIL", counts:{pass:1, fail:1, review:0, error:1}, …}
veriscope_gate_export({run_id:"实际运行 UUID", format:"md"})
→ {exported:true, path:"<状态根>/exports/<唯一文件名>.md", …}
```

以上为字段示例，不是实测业务结果。批量**有 FAIL 就汇总为 FAIL**；没有 FAIL 但存在待复核、错误、取消或未处理项时为 REVIEW。目录只读直接包含的 JSON，不递归。错误不掩盖已确认失败，失败不阻止下一份重放。

清单最多扫描 10,000 个目录项，超限明确待复核；`limit` 范围外的回执不做当前环境复验。坏回执时间不能可信读取时，排序使用目录修改时间并标明来源。导出单条 JSON 与原回执字节一致，多条为原回执对象数组；JSON 中历史 PASS 不代表当前有效，当前状态另见工具返回的 `current`。Markdown 同时列历史与当前状态、归档指标、阈值、证据条数和限制。体检只创建并清理自身临时写入探针，不改配置或安装依赖。

## 原生结果卡

支持 `tool.call.toolview` 的宿主显示一张深色金色中文结果卡：当前三态、下一步、“重新检查”和折叠依据。按钮只读查状态，不能重放或登记完成。没有卡片接口时保留中文工具文本。

折叠依据包含中文原因、回执阈值、Node／Python／pandas 版本，以及输入路径、字节数和 SHA-256 前 12 位；缺失值保持未知。这些是回执绑定的历史环境描述，当前有效性仍以本次检查为准。

卡片打开时重新检查，不直接显示历史 PASS；加载失败、缺少本会话关联或协议不完整均为待复核。显示仅代表所示检查时刻，不持续监视文件，使用前可再次检查。原生卡片不提供路径设置面板。

## 输出与数据边界

| 当前状态 | `gate_passed` | 含义 |
|---|---|---|
| PASS | `true` | Python 通过，回执完整且本次所查绑定项未变 |
| FAIL | `false` | Python 明确拦截，回执完整且当前绑定项未变 |
| REVIEW | `null` | 输入、依赖、回执或执行不完整，或绑定项变化、协议冲突 |

replay 确认 FAIL 后即使回执写入失败，核心 FAIL 仍保留；后续 status 因缺少完整回执为当前 REVIEW。原 report 的 FAIL 记录仍可阅读，无法校验的历史字段保持 unknown。Python 退出1但只有 traceback 仍为 REVIEW。

记录在 `<状态根>/runs/<run_id>/`，包含 `report.json`、stdout、stderr，以及符合生成条件的 `receipt.json`；完成登记另存 `completions/`。追加记录不覆盖失败。日志可能含归档片段与本地路径，分享前脱敏；插件不上传归档或打印完整环境。

输入限10MiB，stdout／stderr各2MiB，重放120秒，环境探测每次10秒。status 会读取并哈希文件、启动 Python 查版本及 pandas 元数据，不运行评测模型或门禁脚本。哈希不证明语义正确，不抵御能重写整个状态根的用户；检查后的变化需再次检查发现。

历史 Trace 仅核对逐字出处，标 `historical_ai`，不是新语义核查。内核零新增评测模型调用，宿主对话仍可能产生 token 费用；不宣称算法首创或端到端降本。

## 验证与维护

```powershell
node --test
node scripts/replay.mjs --result 'D:\your-data\evaluation.json' --json
dsh plugin --profile veriscope-demo remove dsh-plugin-veriscope
```

单元测试使用构造归档和协议桩，不需要模型或 Python。真实 Python 与宿主验收另见 [验证说明](docs/verification.md)。卸载移除注册，保留用户状态与历史证据。`private: true` 阻止误发 npm，不影响源码公开。

[贡献指南](CONTRIBUTING.md) · [治理规则](GOVERNANCE.md) · [更新记录](CHANGELOG.md) · [路线图](ROADMAP.md) · [安全报告](SECURITY.md) · [发布检查](docs/RELEASE_CHECKLIST.md)。市场 PR 未合并前不称已收录。

MIT，保留脚手架原版权；来源见 [第三方说明](THIRD_PARTY_NOTICES.md) 和 [来源哈希](docs/provenance.json)。上游单独分发，须遵守自身许可。
