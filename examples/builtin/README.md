# 独立阈值门禁样例

这些文件是按公开格式手工构造的协议样例，不是真实用户案例，也不是真实模型评分。

- `archive.json`：GateArchiveV1；两条构造评分。
- `policy.json`：全部输入记录的 Faithfulness 均值不低于 0.8，逐条数值须为 0–1。
- `ragas-records.json`：按 Ragas v0.4.3 `EvaluationResult.to_pandas()` 与 pandas `to_json(orient="records")` 的布局构造；没有运行 Ragas、没有调用模型。不据此宣称所有 Ragas 版本或导出方式兼容。

参考：[Ragas 官方接口](https://docs.ragas.io/en/v0.4.3/references/evaluation_schema/)、[pandas JSON 导出](https://pandas.pydata.org/docs/reference/api/pandas.DataFrame.to_json.html)。来源声明及原始评分真实性未经独立核验。

设置持久状态目录后，运行 `veriscope-check --archive examples/builtin/archive.json --policy examples/builtin/policy.json --json`。Ragas 布局需再加 `--format ragas-records-v1`。

## 均值与逐条规则

`archive-row-risk.json` 的五个分数为 0.92、0.41、0.95、0.87、0.90；十进制均值为 0.81。以下均为文档构造示例，不代表评分或回答经独立核验。

| 策略 | 预期裁决 | 原因 |
|---|---|---|
| `policy-v1-mean-080.json` | PASS | 沿用 V1 浮点均值，达到 0.8；最差行诊断提示 case-2 为 0.41，不改变裁决 |
| `policy-v2-mean-081.json` | PASS | V2 精确十进制比较，均值恰好等于 0.81；没有逐条约束 |
| `policy-v2-row-050.json` | FAIL | 相同均值达标，但 case-2 低于显式逐条阈值 0.5 |

```powershell
node scripts/check.mjs --archive examples/builtin/archive-row-risk.json --policy examples/builtin/policy-v2-row-050.json --json
```

V1 不改变原有临界判定：若把其阈值设为 0.81，该组数的 JavaScript 均值为 0.8099999999999999，仍为 FAIL。需要十进制边界语义时，显式选择 GatePolicyV2，不自动迁移旧策略。
