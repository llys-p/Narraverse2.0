# -*- coding: utf-8 -*-
"""B5 脚手架一键自检：构建隔离 exe + 假模型，跑通写作链与游戏链，做标记直扫。

用法（在任意目录）：
    python <repo>/denova-src/scripts/library-acceptance/run_smoke.py [--workdir DIR] [--exe-only]

行为：
    1) 用当前仓库源码构建隔离 exe 与假模型到工作目录（默认 <worktree>/artifacts/library-acceptance-smoke）；
    2) 起假模型（18086）与隔离 exe（18085，独立 .denova，不触碰 8080）；
    3) 经 API 自建虚构库（resident/auto/manual 三条，正文嵌唯一 ASCII 标记）；
    4) 依次跑 drive_writing.py（writing 模式假模型）与 drive_game.py（game 模式假模型）；
    5) scan_markers.py 全目录直扫（允许清单=库源文件；必备 runs 目标）；
    6) 校验模型侧取材与库文件哈希，打印结论与证据路径，最后停掉两个进程。
退出码：0 = 全绿；1 = 有失败项（细节见输出与工作目录内日志）。
"""
import argparse
import hashlib
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request

SCRIPT_DIR = pathlib.Path(__file__).resolve().parent


def default_workdir():
    worktree = SCRIPT_DIR.parents[2]  # .../denova-src/scripts/library-acceptance -> worktree root
    if (worktree / "artifacts").is_dir():
        return worktree / "artifacts" / "library-acceptance-smoke"
    return pathlib.Path.cwd() / "library-acceptance-smoke"


def post(base, path, payload, timeout=300):
    req = urllib.request.Request(
        base + path,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.status, json.loads(resp.read().decode("utf-8"))


def get_json(base, path, timeout=60):
    with urllib.request.urlopen(base + path, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def sha256_file(p):
    return hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()


MARKERS = {
    "resident": "SMOKE-MARK-RES-01",
    "auto": "SMOKE-MARK-AUTO-01",
    "manual": "SMOKE-MARK-MAN-01",
}


def wait_for_backend_url(log_path, proc, timeout=40):
    """等本进程自己在 stdout 报出的监听地址（端口归属证明），返回 URL。

    只有本进程打出 "后端服务: http://..." 才继续；端口被占/启动失败时主动退出。
    """
    conflict_markers = ("显式指定的端口", "explicitly specified HTTP port")
    deadline = time.time() + timeout
    while time.time() < deadline:
        if log_path.exists():
            text = log_path.read_text(encoding="utf-8", errors="replace")
            for marker in conflict_markers:
                if marker in text:
                    print("exe 报告显式端口不可用（可能被其他服务占用），拒绝继续：")
                    for line in text.splitlines():
                        if "端口" in line or "port" in line.lower():
                            print("  ", line.strip())
                    return ""
            match = re.search(r"后端服务:\s*(http://[^\s]+)", text)
            if match:
                url = match.group(1).rstrip("/")
                if proc.poll() is not None:
                    print("exe 进程已退出，监听到的地址不属于本次启动")
                    return ""
                return url
        if proc.poll() is not None:
            print("exe 进程提前退出（详见日志），未取得监听地址")
            return ""
        time.sleep(0.5)
    print("未在超时内取得本次进程的监听地址（详见日志）")
    return ""


def wait_status_ok(base, proc, timeout=30):
    """确认 /api/status 可访问且响应是 Denova 本应用（含 has_state 字段），期间进程须存活。"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        if proc.poll() is not None:
            print("exe 进程已退出，放弃探活")
            return False
        try:
            with urllib.request.urlopen(base + "/api/status", timeout=5) as resp:
                data = json.loads(resp.read().decode("utf-8", errors="replace"))
            if "has_state" in data and "context" in data:
                return True
            print("端口响应缺少本应用特征字段，拒绝继续：", data)
            return False
        except Exception:
            time.sleep(0.5)
    return False


def start_process(cmd, cwd, env, log_path):
    log = open(log_path, "w", encoding="utf-8")
    return subprocess.Popen(cmd, cwd=str(cwd), env=env, stdout=log, stderr=subprocess.STDOUT)


def stop_process(proc):
    if proc is None:
        return
    try:
        proc.terminate()
        proc.wait(timeout=10)
    except Exception:
        try:
            proc.kill()
        except Exception:
            pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--workdir", default="")
    ap.add_argument("--exe", default="")
    ap.add_argument("--exe-port", default="18085")
    ap.add_argument("--model-port", default="18086")
    args = ap.parse_args()

    repo = SCRIPT_DIR.parents[1]  # denova-src
    workdir = pathlib.Path(args.workdir) if args.workdir else default_workdir()
    stamp = time.strftime("%Y%m%dT%H%M%S")
    run_root = workdir / ("run-" + stamp)
    run_dir = run_root / "run"
    run_dir.mkdir(parents=True, exist_ok=True)
    base = ""  # 由 wait_for_backend_url 依据本进程 stdout 确定（端口归属校验）
    model_base = "http://127.0.0.1:" + args.model_port
    failures = []

    exe = pathlib.Path(args.exe) if args.exe else workdir / "denova-l3.exe"
    fake = workdir / "fake-model.exe"
    if not args.exe:
        print("[build] exe ->", exe)
        rc = subprocess.run(["go", "build", "-o", str(exe), "./cmd/denova"], cwd=str(repo)).returncode
        if rc != 0:
            print("exe 构建失败"); return 1
    print("[build] fake-model ->", fake)
    rc = subprocess.run(["go", "build", "-o", str(fake), "."], cwd=str(SCRIPT_DIR / "fake-model")).returncode
    if rc != 0:
        print("假模型构建失败"); return 1

    env_exe = dict(os.environ)
    env_exe.update({
        "OPENAI_BASE_URL": model_base + "/v1",
        "OPENAI_API_KEY": "fake-key",
        "OPENAI_MODEL": "fake-model",
    })
    exe_proc = None
    model_proc = None
    try:
        print("[start] 假模型（writing 模式）")
        env_model = dict(os.environ)
        env_model.update({"FAKE_MODEL_MODE": "writing", "FAKE_MODEL_PORT": args.model_port,
                          "FAKE_MODEL_LOG": str(run_root / "fake-requests-writing.jsonl")})
        model_proc = start_process([str(fake)], workdir, env_model, run_root / "fake-model-writing.log")
        time.sleep(1.0)
        print("[start] 隔离 exe（显式端口", args.exe_port, "）")
        exe_log = run_root / "exe.log"
        exe_proc = start_process([str(exe), "--port", args.exe_port, "-no-open"], run_dir, env_exe, exe_log)
        owned_base = wait_for_backend_url(exe_log, exe_proc)
        if not owned_base:
            print("未能确认隔离实例监听地址属于本次启动的进程，拒绝写入数据")
            return 1
        if not owned_base.endswith(":" + args.exe_port) and not owned_base.endswith(":" + args.exe_port + "/"):
            print("exe 实际监听地址与请求端口不一致，拒绝继续：", owned_base)
            return 1
        base = owned_base
        if not wait_status_ok(base, exe_proc):
            print("隔离实例未通过状态探活，拒绝继续")
            return 1
        print("[start] 已确认监听归属:", base)

        print("[setup] 自建虚构库")
        _, created = post(base, "/api/work-libraries", {"name": "B5 脚手架自检库"})
        library_id = created["library"]["id"]
        items = [
            {"id": "res-1", "name": "常驻一", "type": "character", "origin": "original", "loadMode": "resident",
             "content": MARKERS["resident"] + " 常驻正文：雾城的巡雾人。"},
            {"id": "auto-1", "name": "自动一", "type": "character", "origin": "original", "loadMode": "auto",
             "content": MARKERS["auto"] + " 自动正文：只在按需读取时出现。"},
            {"id": "manual-1", "name": "手动一", "type": "rule", "origin": "original", "loadMode": "manual",
             "content": MARKERS["manual"] + " 手动正文：禁巷的通行规矩。"},
        ]
        for item in items:
            post(base, "/api/work-libraries/" + library_id + "/items", item)
        lib = get_json(base, "/api/work-libraries/" + library_id)
        revision = lib["revision"]
        library_file = run_dir / ".denova" / "libraries" / ("library-" + library_id + ".json")
        lib_hash_before = sha256_file(library_file)
        print("[setup] library:", library_id, "revision:", revision)

        print("[chain] 写作链")
        rc = subprocess.run([sys.executable, str(SCRIPT_DIR / "drive_writing.py"), "--base", base,
                             "--library-id", library_id, "--book", "B5 Smoke Book",
                             "--out", str(run_root / "turn-writing-sse.log")], cwd=str(run_root)).returncode
        if rc != 0:
            failures.append("writing chain")

        print("[restart] 假模型（game 模式）")
        stop_process(model_proc)
        env_model.update({"FAKE_MODEL_MODE": "game",
                          "FAKE_READ_ITEM": "auto-1",
                          "FAKE_MODEL_LOG": str(run_root / "fake-requests-game.jsonl")})
        model_proc = start_process([str(fake)], workdir, env_model, run_root / "fake-model-game.log")
        time.sleep(1.0)

        print("[chain] 游戏链")
        rc = subprocess.run([sys.executable, str(SCRIPT_DIR / "drive_game.py"), "--base", base,
                             "--library-id", library_id, "--book", "B5 Smoke Book",
                             "--story", "B5 smoke story", "--out", str(run_root / "turn-game-sse.log")],
                            cwd=str(run_root)).returncode
        if rc != 0:
            failures.append("game chain")

        print("[scan] 标记直扫")
        rc = subprocess.run([sys.executable, str(SCRIPT_DIR / "scan_markers.py"),
                             "--root", str(run_dir / ".denova"),
                             "--allow", "libraries/library-*.json",
                             "--marker", MARKERS["resident"], "--marker", MARKERS["auto"], "--marker", MARKERS["manual"],
                             "--require", "**/runs/*.jsonl", "--require", "**/story-*.jsonl",
                             "--report", str(run_root / "scan-report.txt")]).returncode
        if rc != 0:
            failures.append("marker scan")

        print("[verify] 分链模型取材 + 游戏 ledger 元数据 + 库只读")
        grounded = {"writing": False, "game": False}
        for chain, log_name in (("writing", "fake-requests-writing.jsonl"), ("game", "fake-requests-game.jsonl")):
            log_path = run_root / log_name
            if not log_path.exists():
                continue
            for line in log_path.read_text(encoding="utf-8").splitlines():
                try:
                    record = json.loads(line)
                except json.JSONDecodeError:
                    continue
                for message in record.get("messages", []):
                    content = message.get("content", "")
                    if "Library Setting Context" in content and MARKERS["resident"] in content:
                        grounded[chain] = True
        for chain, ok in grounded.items():
            if not ok:
                failures.append(chain + " grounding")

        ledger_read_ok = False
        for ledger in (run_dir / ".denova").rglob("*.jsonl"):
            if ledger.parent.name != "runs":
                continue
            for line in ledger.read_text(encoding="utf-8", errors="replace").splitlines():
                if '"read_library_item"' not in line:
                    continue
                try:
                    record = json.loads(line)
                except json.JSONDecodeError:
                    continue
                event_data = record.get("data", {}).get("event_data") or {}
                if event_data.get("name") != "read_library_item" or "library_read" not in event_data:
                    continue
                meta = event_data["library_read"]
                content = event_data.get("content")
                preview = content.get("preview") if isinstance(content, dict) else content
                body_marker_hit = any(marker in str(preview) for marker in MARKERS.values())
                if meta.get("itemId") == "auto-1" and not body_marker_hit:
                    ledger_read_ok = True
        if not ledger_read_ok:
            failures.append("game ledger metadata-only read event")

        lib_hash_after = sha256_file(library_file)
        if lib_hash_before != lib_hash_after:
            failures.append("library mutated")

        print()
        print("== 结果 ==")
        print("model-side grounding per chain:", grounded)
        print("game ledger metadata-only read:", ledger_read_ok)
        print("library byte-identical:", lib_hash_before == lib_hash_after)
        print("failures:", failures if failures else "none")
        print("evidence:", run_root)
        return 1 if failures else 0
    finally:
        stop_process(exe_proc)
        stop_process(model_proc)


if __name__ == "__main__":
    sys.exit(main())
