# tests/assets —— 版本控制的测试基线资产

本目录存放**不可再生**的测试基线。这里的文件只许被显式替换，不许被"顺手重新生成"。

## translation_cache.json（2026-09-24 冻结，P3P2 选项 B 落地）

- **来源**：`_diag/translation_cache.json`（运行时翻译缓存，DeepSeek 中→英）。
- **冻结点**：264 条；sha256 `ac954c9494cde48427b80091daab20f1b5c74ddb1c7c5c9aa46940a20652abc7`
  （与 `tests/runs/eras.json` 的 `cache_frozen` 节互为印证；sha256 一致 = 同一缓存）。
- **为什么冻结**：`temperature=0` 重译同一句中文，逐字一致率仅 13%~24%（两次独立实测，
  `tests/replication/xlate_drift.py`）——**缓存不可再生**。重建即全体 signal 的 AUC 整体平移、
  等级翻转（实测 trust_shift 0.827→0.730、fondness_shift 0.790→0.702，双双 A→C）。
- **裁决**：2026-09-24 用户选 **B**——此后所有等级以本缓存为准；
  trust_shift/fondness_shift=C、可写信号仅 doubt_shift 为正式现状，不再追求回到 0.827。
  判分基准英文 = 本缓存查得的英文（spec §6：input / cache / expected 三件套共同组成测试基线）。

## 纪律（违反任何一条 = 基线作废）

1. **运行时缓存 `_diag/translation_cache.json` 只能追加，不得重译已有条目**；
   运行时仍读 `_diag/` 路径，本文件是它的冻结镜像。
2. 运行时缓存一旦**合法增长**：重新冻结 → 显式替换本文件 → 在 `eras.json` 声明**新 era** →
   重跑 signalmetrics / capability。旧 run 是上一阶段的证据，保留不删。
3. **禁止**为了让某个等级变好而重预热缓存——那会让档案变成"参数凑出来的绿"。
4. 任何跨纪元对比前先核对 sha256；不一致就是不同缓存，结论不可比。
5. 测试里**永远不要**给 `_cached_translate` 传字面量 `{}`（2026-09-24 曾把缓存毁到 1 条）。

（本文件不含任何密钥；内容为测试台词的中英对照，无用户数据。）
