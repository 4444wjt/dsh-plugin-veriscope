# 第三方来源与分发边界

- 脚手架：[`ciceroyang/dsh-plugin-starter`](https://github.com/ciceroyang/dsh-plugin-starter/tree/a1a222e2c0b9882179e248e13a0d789a5af4cd2c)，MIT；保留根 LICENSE 原版权声明。入口、helper 与测试示例已由 VeriScope 适配实现替换，来源哈希见 `docs/provenance.json`。
- 宿主 SDK：`@deepseek-ai/dsh-tools`／`@deepseek-ai/dsh-skill` 0.2.1-alpha.2，作为 peer 使用，未复制宿主 SDK 或已安装应用。本次公共 registry 元数据可读不等于完成安装验收。
- 上游 Python：VeriScope，经配置路径只读调用，不随包复制完整平台、模型栈或业务数据。契约只记录已审阅文件的摘要，不覆盖上游许可。
- JSON fixtures 为构造协议案例；三组 stdout／stderr 是原插件已有的重放输出片段，仅用于协议回归。原归档没有纳入本包；详见验证说明和 provenance。
- 能力融合对标只作为后续设计参考；本候选包没有复制其他对标插件实现，也没有加入其新核查器。

本文件描述候选包范围，不声明已经公开、获得市场审核或拥有第三方背书。根 MIT 不替代第三方许可、商标及服务条款。
