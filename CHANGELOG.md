# 更新记录

## 0.4.0 — 2026-10-17

> **0.4.0 升级提示**：旧回执的当前有效性将进入 REVIEW，历史 PASS／FAIL 不会改写。升级前请备份完整状态目录及原归档，并使用插件外的持久状态目录；包内 `.local` 可能随重装丢失，单独导出回执不是完整备份。重新 replay 后取得新版本回执。

- DSH 启动新增 SDK 缺失、版本／接口不兼容、加载失败的明确诊断；加载 SDK 代码前核对版本，MCP 不加载 SDK，不自动安装或切换。
- 新增零运行时依赖的 stdio MCP 入口；首版提供 doctor、replay、status、list，工具定义与 DSH 共享。DSH 八工具和原生卡保留，受管会话绑定不移植到 MCP。
- 配置解析增加 POSIX 分支；Windows 与 Ubuntu 真实回放均已验证，保留 POSIX venv 的符号链接启动路径。MCP 强制显式持久状态根，DSH 原默认保持。DSH tools 改为 optional peer，纯 MCP 安装无需宿主 alpha 依赖。
- 增加整套 LF 审阅契约，保留原契约；回执纳入新入口、共享目录和契约选择代码。升级后的旧回执保持历史裁决，当前复用需重新核验。
- 增加只读留存预演 CLI；默认无限保留，无自动清理与删除入口。补充四语 README、MCP 配置及验收口径。
- 增加协议／平台／依赖检查和 Ubuntu 真实回放 CI 定义；远端 CI 与实际宿主验收以独立记录为准，不以自写客户端或注册成功替代。
- 内核无新增评测模型调用；本轮验收未发起模型对话。正式 npm 包在 Claude／Codex 隔离控制接口各完成 10 次真实工具调用。Claude 的错误路径只返回文本，完整结构化交付未通过；不宣称三宿主四例全部字段一致。发布记录见 npm 和 GitHub Release。

## 0.3.2 — 2026-10-17

- README 修正 npm 发布状态，补齐按独立 profile 安装、卸载和查看已安装版本的命令。
- README 仓库文件链接改为 GitHub 绝对链接，避免 npm 页面引用未打包文档。
- 发布包加入 `THIRD_PARTY_NOTICES.md`，保留原 LICENSE。
- 移除只对源码有效的 `verify:replay` 脚本项；README 保留源码专用命令。
- 移除 `private` 字段，改用公开 `publishConfig` 与需显式授权、核对 tag 的 `prepublishOnly` 源码发布守卫。
- 新增 tag 触发的 OIDC 发布工作流；尚需配置 npm Trusted Publisher 并实际发布验证。
- 经单独授权，将回执版本测试的固定旧版本断言改为读取当前 package.json 版本。
- 本轮不改变任何运行时行为；0.3.1 历史验收记录保持原样。

## 0.3.1 — 2026-10-17

- 报告导出新增 `format: "share"` 白名单求助摘要：本地预览，不透传路径、原文、日志、模型标签或未知字段；摘要不是回执，不能用于任务放行。
- JSON 拒绝原因补充可确认的异常行列与受限字段位置；仅诊断，不自动修复，保留原接受/拒绝规则与三态。
- status 文本与原生卡折叠依据增加绑定项变化；沿用同一次捕获，契约校验失败保留待复核并标未核实，不推断分数变化的因果。
- 原生卡的只读刷新携带本次查询的显式阈值/基线策略，避免丢失条件后按原阈值显示；无效策略保持待复核。
- 零新增依赖和评测模型调用；原完整 JSON 导出与历史失败保留。此条记录本地版本，发布状态以公开仓库为准。

## 0.3.0 — 2026-10-17

- 新增 `veriscope_doctor`、`veriscope_gate_list`、`veriscope_gate_batch`、`veriscope_gate_export`，复用现有 Python 门禁和回执有效性判定。
- 状态文本与卡片使用中文原因说明；折叠详情补充阈值、绑定环境和输入摘要。未知原因码保留原码。
- 批量已确认 FAIL 优先；取消、坏文件和损坏回执留痕，不算通过。导出不覆盖，单条 JSON 保留原回执字节。
- README 增加三步上手与新工具示例。保持零新增依赖、零新增评测模型调用；不发布 npm。


## 0.2.0 — 2026-10-17

- 实际replay生成ReceiptV1，绑定输入、基线、策略、执行器、插件与所列环境；新增只读status复验，区分历史与当前裁决。
- 新增veriscope_gate_status、veriscope_gate_bind、veriscope_gate_complete。本会话当前PASS才能登记受管完成，重启后需重新绑定。
- completionMode仅允许off／remind，默认off；提醒不构成普通聊天全局阻断。
- 支持原生中文结果卡与只读重新检查，无接口保留文本。VERISCOPE_STATE_DIR显式优先，默认插件.local；不自动读.env。
- 扩展损坏、篡改、保留mtime字节变化、环境变化、会话隔离、取消和失败保留回归。原Python裁判和数值公式不变。

## 0.1.0 — 初始源码

- veriscope_gate_replay、runtime skill、三态、证据定位和历史Trace保留。
- 初始52项测试与本地独立profile验收；未创建0.1.0正式tag／Release。
