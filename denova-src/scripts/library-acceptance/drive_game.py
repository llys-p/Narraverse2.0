# -*- coding: utf-8 -*-
"""B5 验收脚手架：游戏链带库回合驱动（建书 → 建固定模板故事 → 选中 → 发起回合）。

用法：
    python drive_game.py --base http://127.0.0.1:18085 --library-id <id>
        [--book 书名] [--story 故事名] [--message 行动] [--out turn-game-sse.log]

注意：故事默认 state_schema_policy=fixed_template——动态结构（adapt_template）故事的
首回合需要完整的「开局结构初始化」协议（initialize_story_state_schema → finalize →
按 required_state_changes 一次补齐），假模型不实现该协议时会被显式拒绝并重试；固定
模板足以验证库背景注入与持久化隔离。回合请求携带 background_source=library +
library_context Ref 三字段（manual 条目自动取自库内，保持“已保存库”口径）。
"""
import argparse
import json
import urllib.error
import urllib.request


def post(base, path, payload, timeout=300):
    req = urllib.request.Request(
        base + path,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.status, resp.read().decode("utf-8", errors="replace")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://127.0.0.1:18085")
    ap.add_argument("--library-id", required=True)
    ap.add_argument("--book", default="Library B5 Acceptance")
    ap.add_argument("--story", default="B5 acceptance story")
    ap.add_argument("--origin", default="The protagonist finds a locked door at the end of the fog alley")
    ap.add_argument("--message", default="Push the door open")
    ap.add_argument("--branch", default="main")
    ap.add_argument("--schema-mode", default="fixed_template")
    ap.add_argument("--out", default="turn-game-sse.log")
    args = ap.parse_args()

    try:
        status, body = post(args.base, "/api/books/create", {"title": args.book})
        print("book create:", status, body[:160])
    except urllib.error.HTTPError as err:
        print("book create:", err.code, err.read().decode("utf-8", errors="replace")[:160])

    status, body = post(args.base, "/api/interactive/stories", {
        "title": args.story,
        "origin": args.origin,
        "story_teller_id": "classic",
        "reply_target_chars": 800,
        "director_run_policy": {"mode": "manual"},
        "state_schema_policy": {"mode": args.schema_mode},
    })
    story = json.loads(body)
    story_id = story["id"]
    print("story:", story_id, "| policy:", story.get("state_schema_policy"))

    post(args.base, "/api/interactive/stories/" + story_id + "/select", {})
    print("selected ok")

    with urllib.request.urlopen(args.base + "/api/work-libraries/" + args.library_id, timeout=60) as resp:
        lib = json.loads(resp.read().decode("utf-8"))
    manual_ids = [i["id"] for i in lib["library"]["items"] if i.get("loadMode") == "manual" and i.get("enabled")]
    print("library revision:", lib["revision"], "| manual ids:", json.dumps(manual_ids, ensure_ascii=False))

    payload = {
        "mode": "story",
        "story_id": story_id,
        "branch": args.branch,
        "message": args.message,
        "background_source": "library",
        "library_context": {
            "libraryId": args.library_id,
            "expectedRevision": lib["revision"],
            "manualItemIds": manual_ids,
        },
    }
    try:
        status, body = post(args.base, "/api/interactive/chat", payload)
    except urllib.error.HTTPError as err:
        body = err.read().decode("utf-8", errors="replace")
        print("chat FAILED:", err.code, body[:400])
        raise SystemExit(1)
    with open(args.out, "w", encoding="utf-8") as f:
        f.write(body)
    events = [line[7:] for line in body.splitlines() if line.startswith("event: ")]
    print("chat:", status, "| events:", events)


if __name__ == "__main__":
    main()
