# libraryruntime — L3 边界占位

状态：仅骨架，没有生产实现，没有API，没有新Registry。

依据：`docs/plans/LIBRARY_L3_MODE_INTEGRATION_PLAN.md`（仓库根）。

若多个模式确实需要共用，只在本目录实现读取授权和临时输入适配。
依赖方向：libraryruntime → librarycontext → library。来源和运行身份由App受控注入。
禁止反向依赖App/HTTP、禁止第二模型链、禁止持久化Library副本。

先接写作完整闭环，再游戏，再现有受控叙界/Module4通道。
不得将Library转换为可写World，也不得照抄worldcontext建平行生命周期系统。
复用现有抽象若足够，可只在现有适配文件接线；不要为填满目录创造类或空函数。
