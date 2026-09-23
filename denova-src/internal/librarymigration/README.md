# librarymigration — L4 边界占位

状态：只有目录职责，没有执行迁移或注册API。

依据：`docs/plans/LIBRARY_L4_MIGRATION_PLAN.md`（仓库根）。

预期职责：纯映射、稳定ID映射、冲突/影响/遗漏报告和计划指纹。
文件读取、备份、用户确认、原子apply由受控App服务编排，不混入纯映射器。
不得扫描用户磁盘、复制密钥、删除来源、写回World或自动触发模型。

实施顺序：fixtures映射 → 只读dry-run → 幂等/恢复设计 → 用户授权后apply。
保持旧数据可恢复，不用占位函数返回假成功。
