# -*- coding: utf-8 -*-
"""B5 验收脚手架：落盘标记直扫（漏扫即失败，防假绿）。

用法：
    python scan_markers.py --root <数据目录> --allow "libraries/library-*.json" \
        --marker <标记串> [--marker ...] [--require "**/runs/*.jsonl"] [--report <file>]

规则：
    - 目录遍历/文件读取错误一律失败（绝不静默跳过，避免漏扫假绿）；
    - --allow 的相对 glob 命中文件允许包含标记（库源文件）；其余任何命中即失败；
    - 至少一个 --allow 文件必须命中全部标记（证明扫描器有效、源文件未被清空/改写）；
    - 每个 --require glob 至少要命中一个存在的文件（目标文件缺失 → 失败，防"没生成=零命中"）。
退出码：0 = 干净；1 = 泄漏或目标缺失；2 = 用法/IO 错误。
"""
import argparse
import fnmatch
import pathlib
import sys


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", required=True)
    ap.add_argument("--allow", action="append", default=[])
    ap.add_argument("--marker", action="append", required=True)
    ap.add_argument("--require", action="append", default=[])
    ap.add_argument("--report", default="")
    args = ap.parse_args()

    root = pathlib.Path(args.root)
    if not root.is_dir():
        print(f"root not found: {root}", file=sys.stderr)
        return 2

    def rel_posix(p):
        return p.relative_to(root).as_posix()

    files = []
    walk_errors = []

    def on_error(_err):
        walk_errors.append(str(_err))

    for p in root.rglob("*"):
        if p.is_dir():
            continue
        files.append(p)
    if walk_errors:
        print("walk errors:", walk_errors, file=sys.stderr)
        return 1

    hits = {}
    unreadable = []
    for p in files:
        try:
            raw = p.read_bytes()
        except OSError as err:
            unreadable.append(f"{p}: {err}")
            continue
        text = raw.decode("utf-8", errors="replace")
        for marker in args.marker:
            if marker in text:
                hits.setdefault(rel_posix(p), []).append(marker)

    if unreadable:
        print("unreadable files:", unreadable, file=sys.stderr)
        return 1

    def is_allowed(rel):
        return any(fnmatch.fnmatch(rel, pattern) for pattern in args.allow)

    lines = []
    failed = False
    allowed_hits = {rel: ms for rel, ms in hits.items() if is_allowed(rel)}
    leak_hits = {rel: ms for rel, ms in hits.items() if not is_allowed(rel)}

    lines.append(f"root: {root}")
    lines.append(f"files scanned: {len(files)}")
    lines.append(f"markers: {args.marker}")
    lines.append(f"allowed hits: {len(allowed_hits)} | leak hits: {len(leak_hits)}")
    for rel, ms in sorted(leak_hits.items()):
        lines.append(f"  LEAK {rel} {ms}")
        failed = True
    for rel, ms in sorted(allowed_hits.items()):
        lines.append(f"  allowed {rel} {ms}")

    if args.allow:
        for pattern in args.allow:
            matched = [rel for rel in allowed_hits if fnmatch.fnmatch(rel, pattern)]
            if not matched:
                lines.append(f"  MISSING allowed source for pattern {pattern}")
                failed = True
                continue
            for rel in matched:
                if len(set(allowed_hits[rel])) != len(set(args.marker)):
                    lines.append(f"  INCOMPLETE markers in {rel}: {sorted(set(allowed_hits[rel]))}")
                    failed = True

    for pattern in args.require:
        if not any(fnmatch.fnmatch(rel_posix(p), pattern) for p in files):
            lines.append(f"  MISSING required target for pattern {pattern}")
            failed = True

    report = "\n".join(lines)
    print(report)
    if args.report:
        pathlib.Path(args.report).write_text(report + "\n", encoding="utf-8")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
