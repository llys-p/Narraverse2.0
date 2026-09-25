# 作品设定库验收脚手架（L3/B5）

四模式（写作 / 游戏 / 叙界 / 沙盒）统一验收用的确定性工具集：假模型端点 + 回合驱动 +
落盘标记直扫。全部为 stdlib（Go / Python 标准库），不依赖付费模型额度；验收口径与
证据布局见 `docs/acceptance/LIBRARY_L3_B5_RUNBOOK.md`。

## 组成

| 文件 | 作用 |
| --- | --- |
| `fake-model/` | 确定性假模型端点（OpenAI 兼容 SSE）。`FAKE_MODEL_MODE=game`（默认）走互动回合脚本：`read_library_item` → 叙述 → `submit_interactive_turn`，并识别压缩请求、call>12 兜底 finalize 防跑飞；`FAKE_MODEL_MODE=writing` 只回纯文本。每次请求的 messages 追加写入 `FAKE_MODEL_LOG`（JSONL），作为“模型侧实际收到什么”的证据。 |
| `drive_writing.py` | 写作链：建/复用书籍 → 读取库 revision 与 manual 条目 → `POST /api/chat`（`background_source=library` + `library_context` Ref 三字段）→ SSE 落盘。 |
| `drive_game.py` | 游戏链：建书 → 建 `fixed_template` 故事 → 选中 → `POST /api/interactive/chat`（同上 Ref 三字段）→ SSE 落盘。 |
| `scan_markers.py` | 落盘标记直扫：`--root` 数据目录、`--allow` 允许含标记的库源文件 glob、`--marker` 标记串、`--require` 必备落盘目标 glob。遍历/读取错误、泄漏命中、允许文件缺标记、必备目标缺失都会失败退出（防假绿）。 |

## 快速开始（隔离实例）

```bash
# 1) 假模型（单独进程）
cd fake-model && go build -o fake-model.exe . && \
FAKE_MODEL_MODE=game FAKE_MODEL_PORT=18086 FAKE_MODEL_LOG=../fake-requests.jsonl ./fake-model.exe &

# 2) 隔离 exe（独立运行目录 + OPENAI_* 指向假模型；不要动用户 8080）
cd <隔离运行目录> && OPENAI_BASE_URL=http://127.0.0.1:18086/v1 OPENAI_API_KEY=fake-key \
OPENAI_MODEL=fake-model <exe> --port 18085 -no-open

# 3) 驱动（示例：游戏链；写作链把 drive_game.py 换成 drive_writing.py 且假模型用 writing 模式）
python drive_game.py --base http://127.0.0.1:18085 --library-id <库id> --out turn-game-sse.log

# 4) 扫描（零泄漏 + 目标存在 + 源文件完整）
python scan_markers.py --root <隔离运行目录>/.denova \
  --allow "libraries/library-*.json" --marker <标记1> --marker <标记2> \
  --require "**/runs/*.jsonl" --report scan-report.txt
```

## 注意事项

- 叙界（narraverse）/ 沙盒（Module4）走宿主受控入口（`/api/world-context/host/*`），需要
  一次性 bootstrap secret（仅正式启动入口签发）与 `/narraverse` 模块资产；本脚手架暂不
  自动驱动这两个消费者，页面级验证按 RUNBOOK 的对应章节执行。
- 动态结构故事（`adapt_template`）首回合要求完整的开局结构初始化协议（结构草案
  `finalize` 后按 `required_state_changes` 一次补齐），本假模型不实现；用
  `fixed_template` 故事即可直线通过（`drive_game.py` 默认）。
- 凭据卫生：只通过 `OPENAI_*` 环境变量注入假端点；不要把任何真实 key 写入脚本、日志或
  证据目录。证据（SSE 日志、假模型请求日志、扫描报告）只放 `artifacts/`，不入 Git。
