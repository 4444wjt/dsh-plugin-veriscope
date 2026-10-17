# VeriScope 离线门禁重放 · DSH 插件

把已有 VeriScope 评测 JSON 接入 DSH，调用原 Python Quality Gate，返回 **通过／失败／待复核**及可追溯来源。

完整 VeriScope 平台：[GitHub 主仓库](https://github.com/4444wjt/RAG_Evaluation_Demo) · [Gitee 镜像](https://gitee.com/kkbushishou/rag-hallucination-evaluator)。本仓库独立维护 DSH 适配层及其版本。

本目录是 **0.1.0 治理候选版，尚未发布、打 tag 或获得市场收录**。host 工具＋runtime skill，无独立网页或 settings UI。`private: true` 用于阻止误发 npm，不决定 GitHub 仓库是否公开；本阶段不需要发布 npm。

## 适用范围

- 离线重放已归档指标，支持两个阈值和可选基线对比。
- 保留原文位置、归档 SHA-256、本次 stdout／stderr 与裁判身份来源；缺失值保持 unknown 或 null。
- Python 是唯一数值裁判；已确认 FAIL 不被附加异常掩盖，REVIEW 永不转为 PASS。

PASS 只说明归档指标通过当前门禁，不证明每句回答真实。历史 Trace 的字面位置核对不等于语义支持；没有新增逐句核查、自动改写或独立裁判。

## 前置条件与配置

已验证的开发环境：Windows、DSH NEXT 2.0.18-next，内部 DSH／tools／skill 0.2.1-alpha.2。Node 要求 ≥22.19；本地开发验收使用过 Node 24。其他宿主版本和系统尚未验证，不扩大 peer 范围猜兼容。

另需一份兼容的 VeriScope 上游及 Python／pandas 环境。插件不附送完整上游、Python 或业务归档；依赖关系和固定脚本哈希见 [上游说明](docs/UPSTREAM.md) 与 [契约](contracts/upstream.json)。

**路径只通过 DSH 宿主进程环境变量配置。**不从 cordis patch 读取路径，不自动加载 `.env`，没有设置面板。

| 变量 | 含义 | 未设置时 |
|---|---|---|
| `VERISCOPE_ROOT` | 上游项目绝对路径 | 当前实现使用 `D:\RAG_Evaluation_Demo`；其他机器应显式配置 |
| `VERISCOPE_PYTHON` | 可运行上游的 Python 绝对路径 | 在上游根的 `.venv`／`venv` 下探测；不回退到 PATH |

显式空值、相对路径或不可用解释器进入 REVIEW，不静默换环境。以下路径只是使用示例，请替换为自己的安装路径：

```powershell
$env:VERISCOPE_ROOT = 'D:\your-workspace\VeriScope'
$env:VERISCOPE_PYTHON = 'D:\your-workspace\VeriScope\venv\Scripts\python.exe'
```

在同一 PowerShell 设置后再启动宿主。已经运行的宿主须完全退出并从该终端重启；切换 profile 不保证继承新变量。

## 先在本地检查

从本仓库根运行：

```powershell
node --test
node scripts/replay.mjs --result 'D:\your-data\evaluation.json' --json
```

测试使用协议桩和构造情境，不需要模型、宿主 SDK 或 Python；测试通过不代表完成真实宿主安装验证。replay 需要兼容上游和真实归档，不会重新评分或调用新评测模型。宿主对话本身仍可能产生 token 费用。

CLI 可选 `--baseline`、`--faith`、`--ctx`，两个阈值默认0.8，只接受0–1有限数值。归档相对路径以 `VERISCOPE_ROOT` 为基准，不是插件目录。

## DSH 使用

工具：`veriscope_gate_replay({ result_path, baseline?, faith?, ctx? })`。runtime skill 仅在用户要求复查已有 JSON 时使用它，不为得到 PASS 自动调整阈值。

当前真实验收来自开发机的独立 profile 与 ToolRuntime，不经过模型。**公开源码安装路径、其他 DSH 版本及模型自动选工具尚待验收。**候选包不是已验证的一键安装发布。发布前按 [发布检查](docs/RELEASE_CHECKLIST.md) 补齐，并使用独立 profile 验证安装、重启和卸载；不对默认 profile 试装。

## 输出和数据边界

| 状态 | `gate_passed` | 含义 |
|---|---|---|
| PASS | true | Python退出0、通过标记明确且输入和协议检查完整 |
| FAIL | false | Python退出1且有可信的门禁或基线拦截依据 |
| REVIEW | null | 配置、输入、执行、证据不完整或协议冲突 |

退出1但只有 traceback 时仍为 REVIEW。归档旧结论另存 `archived_gate`；不会将旧字段当成新裁决。

每次调用写入 `.local/runs/<run_id>/`，包含 report、stdout 和 stderr；日志可能带有归档片段与本地路径，应当作用户数据，分享前脱敏。插件自身不上传归档，不打印整个进程环境；上游及宿主的数据行为须分别核实。

输入上限10MiB，stdout／stderr各2MiB，重放限120秒，环境探测另限10秒。脚本哈希不匹配进入 REVIEW，不自动更新白名单。当前候选版不实现 `VERISCOPE_STATE_DIR`、回执复验、自动完成门禁或原生卡片。

## 参与和维护

- [贡献指南](CONTRIBUTING.md)：本地测试、提案与 PR 要求。
- [治理规则](GOVERNANCE.md)：维护角色、版本和镜像原则。
- [更新记录](CHANGELOG.md)、[路线图](ROADMAP.md)、[安全报告](SECURITY.md)。
- [验证说明](docs/verification.md)：区分历史记录、本次检查和未测项。

缺陷和建议使用本仓库 Issue 模板。AI 辅助贡献请声明实际使用范围；不得把 AI 分析写成独立真人标注或捏造社区贡献。

## 许可与来源

MIT；保留脚手架原版权声明。来源和依赖范围见 [第三方说明](THIRD_PARTY_NOTICES.md) 与 [来源哈希](docs/provenance.json)。上游不随本插件分发，使用时须遵守其自身许可。本候选包未添加“已收录”、下载量或 CI 通过徽章。
