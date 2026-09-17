// Package library 实现「独立作品设定库」的领域模型、校验与最小 JSON 持久化。
//
// 边界（见 docs/plans/LIBRARY_L1_DATA_CONTRACT.md）：
//   - 设定库跨书、跨 World 存在，数据落在全局 cfg.DataDir()/libraries，不依赖任何 workspace；
//   - 每个库一个 library-<id>.json，不维护 index.json，列表通过扫描目录即时派生；
//   - 文件读写走 internal/revisionfile 的内容哈希 CAS（revision 是 sha256 信封值），409 表示并发冲突；
//   - 条目词表（类型/档位/重要度/ID 词干）复用 internal/book 的既有实现，不重建第二套原件或分类系统；
//   - 本包只负责“资料”本身；模型读取授权、运行加载与预算属 L2，不在本包实现。
package library
