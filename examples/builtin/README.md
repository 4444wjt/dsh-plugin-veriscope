# 独立阈值门禁样例

这些文件是按公开格式手工构造的协议样例，不是真实用户案例，也不是真实模型评分。

- `archive.json`：GateArchiveV1；两条构造评分。
- `policy.json`：全部输入记录的 Faithfulness 均值不低于 0.8，逐条数值须为 0–1。
- `ragas-records.json`：按 Ragas v0.4.3 `EvaluationResult.to_pandas()` 与 pandas `to_json(orient="records")` 的布局构造；没有运行 Ragas、没有调用模型。不据此宣称所有 Ragas 版本或导出方式兼容。

参考：[Ragas 官方接口](https://docs.ragas.io/en/v0.4.3/references/evaluation_schema/)、[pandas JSON 导出](https://pandas.pydata.org/docs/reference/api/pandas.DataFrame.to_json.html)。来源声明及原始评分真实性未经独立核验。

设置持久状态目录后，运行 `veriscope-check --archive examples/builtin/archive.json --policy examples/builtin/policy.json --json`。Ragas 布局需再加 `--format ragas-records-v1`。
