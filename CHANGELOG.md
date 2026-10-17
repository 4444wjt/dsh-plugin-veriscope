# 更新记录

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
