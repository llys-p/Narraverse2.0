# -*- coding: utf-8 -*-
"""
Pixiv 本地桥接服务（Pixiv App API via pixivpy3）
- 供文字冒险平台前端 (localhost:8099) 调用，跨域已放开
- 图片代理：给 i.pximg.net 加 Referer
- 下载：保存原图到 ai-images/pixiv/
- refresh_token 存 pixiv_config.json，不打印、不落日志
"""
import json
import os
import re
import sys
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from pixivpy3 import AppPixivAPI

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(BASE_DIR, "pixiv_config.json")

with open(CONFIG_PATH, "r", encoding="utf-8-sig") as f:
    CFG = json.load(f)

REFRESH_TOKEN = CFG["refresh_token"]
PROXY = CFG.get("proxy") or None
AI_IMAGES_DIR = CFG.get("ai_images_dir") or os.path.join(BASE_DIR, "..", "ai-images", "pixiv")
PORT = int(CFG.get("port", 8098))
MIN_INTERVAL = float(CFG.get("min_interval", 0.8))

API = AppPixivAPI(proxies={"http": PROXY, "https": PROXY} if PROXY else None)
_last_call = 0.0
_ok = False
_auth_error = ""
_USER = None

def _throttle():
    global _last_call
    wait = MIN_INTERVAL - (time.time() - _last_call)
    if wait > 0:
        time.sleep(wait)
    _last_call = time.time()

def _img_headers():
    return {
        "Referer": "https://www.pixiv.net/",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    }

def _safe_name(name):
    name = re.sub(r'[\\/:*?"<>|\r\n]', "_", str(name or "pixiv")).strip()
    return name[:80] or "pixiv"

def do_auth():
    global _ok, _auth_error
    global _USER
    try:
        _throttle()
        resp = API.auth(refresh_token=REFRESH_TOKEN)
        _USER = (resp or {}).get("user") if isinstance(resp, dict) else None
        _ok = True
        _auth_error = ""
        return True
    except Exception as e:
        _ok = False
        _auth_error = str(e)
        return False

class Handler(BaseHTTPRequestHandler):
    server_version = "PixivBridge/1.0"

    def log_message(self, fmt, *args):
        sys.stderr.write("[pixiv-bridge] %s\n" % (fmt % args))

    def _send_json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()
        self.wfile.write(body)

    def _send_error(self, msg, status=500):
        self._send_json({"error": msg}, status)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        try:
            parsed = urllib.parse.urlparse(self.path)
            qs = urllib.parse.parse_qs(parsed.query)
            path = parsed.path
            if path == "/api/pixiv/status":
                self._send_json({"ok": _ok, "auth_error": _auth_error, "user": _USER})
                return
            if not _ok and not do_auth():
                self._send_error("pixiv 登录失败: " + _auth_error, 401)
                return
            if path == "/api/pixiv/search":
                word = (qs.get("q") or [""])[0].strip()
                if not word:
                    self._send_error("缺少关键词 q", 400)
                    return
                _throttle()
                target = (qs.get("target") or ["partial_match_for_tags"])[0]
                sort = (qs.get("sort") or [None])[0]
                offset = int((qs.get("page") or ["1"])[0]) * 30 - 30
                try:
                    r = API.search_illust(word, search_target=target, sort=sort, offset=offset, req_auth=True)
                except Exception as e:
                    self._send_error("search 失败: " + str(e))
                    return
                self._send_json({"illusts": r.get("illusts", []), "next_url": r.get("next_url"), "page": offset // 30 + 1})
                return
            if path == "/api/pixiv/ranking":
                mode = (qs.get("mode") or ["day"])[0]
                offset = int((qs.get("page") or ["1"])[0]) * 30 - 30
                _throttle()
                try:
                    r = API.illust_ranking(mode=mode, offset=offset, req_auth=True)
                except Exception as e:
                    self._send_error("ranking 失败: " + str(e))
                    return
                self._send_json({"illusts": r.get("illusts", []), "next_url": r.get("next_url"), "page": offset // 30 + 1})
                return
            if path == "/api/pixiv/illust":
                iid = (qs.get("id") or [""])[0]
                if not iid.isdigit():
                    self._send_error("缺少作品 id", 400)
                    return
                _throttle()
                try:
                    r = API.illust_detail(int(iid))
                except Exception as e:
                    self._send_error("illust 失败: " + str(e))
                    return
                self._send_json({"illust": r.get("illust", {}), "is_bookmarked": bool(r.get("bookmark_user_public")) or bool(r.get("bookmark_user_private"))})
                return
            if path == "/api/pixiv/user":
                uid = (qs.get("id") or [""])[0]
                if not uid.isdigit():
                    self._send_error("缺少用户 id", 400)
                    return
                _throttle()
                try:
                    r = API.user_detail(int(uid))
                except Exception as e:
                    self._send_error("user 失败: " + str(e))
                    return
                self._send_json({"user": r.get("user", {}), "profile": r.get("profile", {})})
                return
            if path == "/api/pixiv/img":
                url = (qs.get("url") or [""])[0]
                if not url.startswith("http"):
                    self._send_error("缺少图片 url", 400)
                    return
                try:
                    resp = API.requests.get(url, headers=_img_headers(), stream=True, timeout=30)
                    if resp.status_code != 200:
                        self._send_error("图片拉取失败 HTTP " + str(resp.status_code), 502)
                        return
                    ctype = resp.headers.get("Content-Type", "image/jpeg")
                    self.send_response(200)
                    self.send_header("Content-Type", ctype)
                    self.send_header("Cache-Control", "public, max-age=86400")
                    self.send_header("Access-Control-Allow-Origin", "*")
                    self.send_header("Content-Length", str(int(resp.headers.get("Content-Length") or 0) or len(resp.content)))
                    self.end_headers()
                    self.wfile.write(resp.content)
                except Exception as e:
                    self._send_error("img 失败: " + str(e))
                return
            if path == "/api/pixiv/download":
                url = (qs.get("url") or [""])[0]
                name = _safe_name((qs.get("name") or ["pixiv"])[0])
                if not url.startswith("http"):
                    self._send_error("缺少图片 url", 400)
                    return
                try:
                    os.makedirs(AI_IMAGES_DIR, exist_ok=True)
                    ext = ".jpg"
                    m = re.search(r"\.(png|jpg|jpeg|gif|webp)(?:\?|$)", url, re.I)
                    if m:
                        ext = "." + m.group(1).lower()
                    fname = name + ext
                    fpath = os.path.join(AI_IMAGES_DIR, fname)
                    n = 1
                    while os.path.exists(fpath):
                        fpath = os.path.join(AI_IMAGES_DIR, "%s_%d%s" % (name, n, ext))
                        n += 1
                    resp = API.requests.get(url, headers=_img_headers(), stream=True, timeout=60)
                    if resp.status_code != 200:
                        self._send_error("下载失败 HTTP " + str(resp.status_code), 502)
                        return
                    with open(fpath, "wb") as f:
                        for chunk in resp.iter_content(65536):
                            if chunk:
                                f.write(chunk)
                    self._send_json({"ok": True, "path": fpath.replace("\\", "/")})
                except Exception as e:
                    self._send_error("download 失败: " + str(e))
                return
            if path == "/api/pixiv/ugoira":
                iid = (qs.get("id") or [""])[0]
                if not iid.isdigit():
                    self._send_error("缺少作品 id", 400)
                    return
                _throttle()
                try:
                    resp = API.ugoira_metadata(int(iid))
                except Exception as e:
                    self._send_error("ugoira 失败: " + str(e))
                    return
                meta = resp.get("ugoira_metadata") or {}
                zip_url = (meta.get("zip_urls") or {}).get("medium")
                frames = meta.get("frames") or []
                if not zip_url or not frames:
                    self._send_error("该作品不是动图或无帧数据", 400)
                    return
                cache_dir = os.path.join(BASE_DIR, ".ugoira_cache", iid)
                os.makedirs(cache_dir, exist_ok=True)
                if not os.listdir(cache_dir):
                    zresp = API.requests.get(zip_url, headers=_img_headers(), timeout=60)
                    if zresp.status_code != 200:
                        self._send_error("动图压缩包拉取失败 HTTP " + str(zresp.status_code), 502)
                        return
                    import io, zipfile
                    with zipfile.ZipFile(io.BytesIO(zresp.content)) as zf:
                        zf.extractall(cache_dir)
                out = []
                for i, fr in enumerate(frames):
                    out.append({"n": i, "file": fr.get("file"), "delay": fr.get("delay", 100)})
                self._send_json({"ok": True, "count": len(out), "frames": out, "base": "/api/pixiv/ugoiraframe?id=%s&n=" % iid})
                return
            if path == "/api/pixiv/ugoiraframe":
                iid = (qs.get("id") or [""])[0]
                n = (qs.get("n") or ["0"])[0]
                if not iid.isdigit() or not n.isdigit():
                    self._send_error("参数错误", 400)
                    return
                cache_dir = os.path.join(BASE_DIR, ".ugoira_cache", iid)
                files = sorted(f for f in os.listdir(cache_dir)) if os.path.isdir(cache_dir) else []
                if int(n) >= len(files):
                    self._send_error("帧不存在（请先调用 /ugoira）", 404)
                    return
                try:
                    with open(os.path.join(cache_dir, files[int(n)]), "rb") as f:
                        data = f.read()
                    self.send_response(200)
                    self.send_header("Content-Type", "image/png")
                    self.send_header("Cache-Control", "public, max-age=86400")
                    self.send_header("Access-Control-Allow-Origin", "*")
                    self.send_header("Content-Length", str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                except Exception as e:
                    self._send_error("帧读取失败: " + str(e))
                return
            if path == "/api/pixiv/bookmark":
                iid = (qs.get("id") or [""])[0]
                if not iid.isdigit():
                    self._send_error("缺少作品 id", 400)
                    return
                restrict = (qs.get("restrict") or ["public"])[0]
                _throttle()
                try:
                    API.illust_bookmark_add(int(iid), restrict=restrict)
                except Exception as e:
                    self._send_error("收藏失败: " + str(e))
                    return
                self._send_json({"ok": True})
                return
            if path == "/api/pixiv/unbookmark":
                iid = (qs.get("id") or [""])[0]
                if not iid.isdigit():
                    self._send_error("缺少作品 id", 400)
                    return
                _throttle()
                try:
                    API.illust_bookmark_delete(int(iid))
                except Exception as e:
                    self._send_error("取消收藏失败: " + str(e))
                    return
                self._send_json({"ok": True})
                return
            if path == "/api/pixiv/dataurl":
                url = (qs.get("url") or [""])[0]
                if not url.startswith("http"):
                    self._send_error("缺少图片 url", 400)
                    return
                try:
                    resp = API.requests.get(url, headers=_img_headers(), timeout=60)
                    if resp.status_code != 200:
                        self._send_error("图片拉取失败 HTTP " + str(resp.status_code), 502)
                        return
                    if len(resp.content) > 10 * 1024 * 1024:
                        self._send_error("图片过大（>10MB）", 413)
                        return
                    import base64
                    ctype = resp.headers.get("Content-Type", "image/jpeg")
                    self._send_json({"ok": True, "dataUrl": "data:%s;base64,%s" % (ctype, base64.b64encode(resp.content).decode("ascii")), "size": len(resp.content)})
                except Exception as e:
                    self._send_error("dataurl 失败: " + str(e))
                return
            self._send_error("未知接口: " + path, 404)
        except Exception as e:
            self._send_error("内部错误: " + str(e))

def main():
    do_auth()
    print("pixiv auth ok=", _ok, "| user=", (_USER.get("name") if _USER else None), "| error=", _auth_error)
    srv = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print("pixiv bridge listening on http://0.0.0.0:%d" % PORT)
    srv.serve_forever()

if __name__ == "__main__":
    main()
