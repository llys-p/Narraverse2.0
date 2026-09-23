# librarycontext — L2 只读读取核心

当前：已有独立纯读取核心与测试；尚未接正式Master resolver、HTTP/UI或四模式。
契约：仓库根 `docs/plans/LIBRARY_L2_READ_CONTRACT.md`。

- Build：已保存Library + 版本 + 明确选择 → 目录/正文/闭包/来源问题/预算。
- Resolver：由受控App注入；只读已登记来源，不读取任意locator路径。
- 所有派生值仅存于调用内存，不写Library/World，不创建运行身份，不调模型。
- Request不是transport DTO；HTTP要额外做精确字段、重复键、空值、类型与大小检查。
- manualItemIds必须源自用户选择；模型工具未来只能使用L3服务端授权集，不得直接构造任意Request。

后续接线和验收见 LIBRARY_RUNTIME_IMPLEMENTATION_PLAN.md，不能将本包通过测试称作L2已完成。
