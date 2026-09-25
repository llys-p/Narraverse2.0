# 作品设定库 L3/B5 四模式统一验收 Runbook

适用：L3 收口（B5）——写作 / 游戏 / 叙界 / 沙盒四模式在分支 `library-b2a` 上的统一验收与交付。
工具：`denova-src/scripts/library-acceptance/`（假模型端点 + 回合驱动 + 落盘标记直扫，全部 stdlib）。
口径：**不以 UI 徽章或 HTTP 200 当送模证据**；链路/注入/隔离可用假模型取证，最终放行以正式
executable + 真实模型的四模式实际读取为准。任何未跑项、环境失败、假模型替代项都要显式列出。

## 0. 前提与边界

- 叙界 / 沙盒需要 `/narraverse` 模块资产（不在本工作树）：`NARRAVERSE_SOURCE_DIR=<叙界 app 目录>` 后运行
  `node denova-src/scripts/sync-narraverse-assets.mjs` 同步到 `web/public/narraverse/`，再构建 exe/前端。
- 真实模型轮次使用既有共享网关与用户配置；**任何 key 只经进程环境/设置 UI 注入，不落盘、不打印、不入 Git**。
- 隔离实例：独立运行目录（自带 `.denova`）、独立端口（示例 exe=18085、假模型=18086）、`-no-open`；
  **不得替换或影响用户 8080 实例，不得读取/改写用户真实库**。验收证据只落 `artifacts/`，不入 Git。

## 1. 隔离实例搭建

```bash
# 1) 构建（分支 HEAD）
cd denova-src && go build -o <轮次目录>/denova-l3.exe ./cmd/denova

# 2A) 假模型口径（链路/注入/隔离证据，不消耗额度）
cd denova-src/scripts/library-acceptance/fake-model && go build -o fake-model.exe . && \
FAKE_MODEL_MODE=game FAKE_MODEL_PORT=18086 FAKE_MODEL_LOG=<轮次目录>/fake-requests.jsonl ./fake-model.exe &

# 2B) 真实模型口径（最终放行证据）：在隔离实例设置 UI 填入接口，或按既有约定注入进程环境

# 3) 启隔离 exe（独立运行目录）
cd <隔离运行目录> && OPENAI_BASE_URL=http://127.0.0.1:18086/v1 OPENAI_API_KEY=fake-key \
OPENAI_MODEL=fake-model <轮次目录>/denova-l3.exe --port 18085 -no-open
```

虚构资料：库（resident / auto / manual 各一，正文嵌**非空且唯一 ASCII 标记**）+ 每模式内新建的故事/书。
叙界/沙盒的宿主入口需要一次性 bootstrap secret（仅**正式启动入口**签发）：按 §5 用正式入口打开页面，
或在验收记录中明确标注该消费者未做页面级验证。

## 2. 写作模式（B2；真实模型证据已在 B2c，收口复跑）

1. `python drive_writing.py --base http://127.0.0.1:18085 --library-id <id> --out turn-writing-sse.log`
   （假模型用 `FAKE_MODEL_MODE=writing`）。
2. 断言：SSE 正常收尾；假模型请求日志中**首个**模型输入含冻结抬头 `[Library Setting Context · Read Only]`
   与 resident+已授权 manual 正文，未授权/禁用条目不在；库文件 sha256 不变；库 rev 不变。
3. 失败路径：改库后以旧 revision 重发 → 绑定期显式失败（`revision_conflict`，零模型调用）。

## 3. 游戏模式（B3；真实模型证据已在 B3c，收口复跑）

1. `python drive_game.py --base http://127.0.0.1:18085 --library-id <id> --out turn-game-sse.log`
2. 断言：SSE 事件序列 `library_context_state` 首帧 → 工具往返 → `interactive_turn_persisted` → `done`；
   假模型请求日志含库正文（模型侧取材）；run ledger 中 `read_library_item` 工具结果 **只含元数据**
   （itemId/name/type/loadMode/bytes，`content="[library-item-read] <名称>"`）。
3. regenerate / 切分支：对同一持久化回合再次发起（`regenerate_from_turn_id`，空库字段）→ 服务端复用原绑定；
   切分支后回合无库字段 → 不跨分支串库。
4. 扫描：§6。

## 4. 叙界（B4a）与沙盒（B4b）

1. 经正式启动入口打开页面取得宿主会话（bootstrap secret → HttpOnly cookie），或按 §0 标注缺资产口径。
2. 在库工作区加载预览执行「带入叙界」/「带入开放沙盒」：
   - 断言请求体只带 `library_context{libraryId,expectedRevision,manualItemIds}` Ref 三字段；
     `/call` 请求与 iframe 收到的摘要**不含**库 ID/revision/scopeKey/运行 ID；
   - 第一个模型请求在绑定完成后才发出（网络面板/抓包顺序）；
   - 先带库后打开消费者：绑定成功后才有内容帧；换绑（world↔library、叙界↔沙盒）后旧载体释放。
3. 沙盒附加：动作成败与背景读取状态相互独立（动作失败不改背景状态、背景失败不改动作结果）；
   不改 Adventure 规则与存档真源（Run 目录/存档文件逐字节比对）。
4. 页面级证据：请求抓包、事件序列、库文件 sha256、run 目录扫描。

## 5. 持久化扫描（每模式必做）

```bash
python denova-src/scripts/library-acceptance/scan_markers.py \
  --root <隔离运行目录>/.denova \
  --allow "libraries/library-*.json" \
  --marker <AUTO标记> --marker <RES标记> --marker <MAN标记> \
  --require "**/runs/*.jsonl" --require "**/story-*.jsonl" \
  --report scan-report.txt
```

判据：除库源文件外**零命中**；源文件必须命中全部标记；必备目标缺失即失败；遍历/读取错误即失败。

## 6. 证据布局（不入 Git）

`artifacts/<轮次>/`：exe/构建说明、`turn-*-sse.log`、`fake-requests.jsonl`（或真实模型调用记录）、
`scan-report.txt`、库 sha256 前后值、服务日志、页面抓包/截图；以及 `未跑项与缺口.md`（含环境失败单列）。

## 7. 放行判据

- 四模式（或按 §0 声明的子集）注入/隔离/失败路径全部有**可复核证据**；扫描零泄漏；
  原库文件与 revision 逐字节不变；错误路径显式且文案脱敏。未跑项、假模型替代项、环境失败逐条列出。
