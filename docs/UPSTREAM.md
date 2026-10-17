# 上游依赖与复现边界

本插件是 DSH 到既有 VeriScope Python Quality Gate 的适配层，不包含完整核查平台或模型依赖。上游平台提供 [GitHub 主仓库](https://github.com/4444wjt/RAG_Evaluation_Demo) 和 [Gitee 镜像](https://gitee.com/kkbushishou/rag-hallucination-evaluator)；这些链接不代表当前分支字节与本插件契约完全一致。

`contracts/upstream.json` 固定列明 `scripts/gate_replay.py` 和相关 backend 文件的哈希及退出码契约。使用前由插件逐项核对；不一致时 REVIEW。上游版本调整须重新审阅，不得仅修改哈希让检查通过。

本地原验收使用 Python 3.11.9／pandas 3.0.6。此记录不等于推荐所有用户直接安装该组合，也不证明其他环境失效。部署者需自行准备满足上游依赖且可运行该脚本的环境，并显式设置 README 的两个环境变量。

单独运行 `node --test` 使用协议桩，不需要上游；它验证适配层故障处理和三态性质，不验证 Python 业务算法、真实回答准确率或安装兼容性。完整复现还需要与契约匹配的上游、可公开的输入及独立宿主验收，不能把未随包提供的本机归档作为公共测试前提。

上游完整源码、历史业务归档、本机 profile 和 SDK 安装目录均未随本候选包复制。上游及宿主有各自许可与数据行为；根 MIT 不覆盖它们。
