# 更新记录

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
