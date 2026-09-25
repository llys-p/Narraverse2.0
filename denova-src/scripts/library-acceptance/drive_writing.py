# -*- coding: utf-8 -*-
"""B5 验收脚手架：写作链带库回合驱动（POST /api/chat，background_source=library）。

用法：
    python drive_writing.py --base http://127.0.0.1:18085 --library-id <id> \
        --book "验收书" --message "写一段开头" [--out turn-sse.log]

行为：
    1. 创建（或复用已存在的）书籍工作区；
    2. 读取库 revision（手动条目从库内自动取）；
    3. POST /api/chat 携带 background_source=library + library_context Ref 三字段；
    4. 原始 SSE 落盘，并打印状态码与结尾片段（错误时打印响应体）。
"""
import argparse
import json
import urllib.error
import urllib.request


def post(base, path, payload):
    req = urllib.request.Request(
        base + path,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=300) as resp:
        return resp.status, resp.read().decode("utf-8", errors="replace")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://127.0.0.1:18085")
    ap.add_argument("--library-id", required=True)
    ap.add_argument("--book", default="Library B5 Acceptance")
    ap.add_argument("--message", default="写一段由设定库背景推动的开头。")
    ap.add_argument("--out", default="turn-writing-sse.log")
    args = ap.parse_args()

    try:
        status, body = post(args.base, "/api/books/create", {"title": args.book})
        print("book create:", status, body[:160])
    except urllib.error.HTTPError as err:
        print("book create:", err.code, err.read().decode("utf-8", errors="replace")[:160])

    with urllib.request.urlopen(args.base + "/api/work-libraries/" + args.library_id, timeout=60) as resp:
        lib = json.loads(resp.read().decode("utf-8"))
    manual_ids = [i["id"] for i in lib["library"]["items"] if i.get("loadMode") == "manual" and i.get("enabled")]
    print("library revision:", lib["revision"], "| manual ids:", json.dumps(manual_ids, ensure_ascii=False))

    payload = {
        "message": args.message,
        "background_source": "library",
        "library_context": {
            "libraryId": args.library_id,
            "expectedRevision": lib["revision"],
            "manualItemIds": manual_ids,
        },
    }
    try:
        status, body = post(args.base, "/api/chat", payload)
    except urllib.error.HTTPError as err:
        body = err.read().decode("utf-8", errors="replace")
        print("chat FAILED:", err.code, body[:400])
        raise SystemExit(1)
    with open(args.out, "w", encoding="utf-8") as f:
        f.write(body)
    print("chat:", status, "| bytes:", len(body), "| tail:", body[-200:].replace("\n", "\\n"))


if __name__ == "__main__":
    main()
