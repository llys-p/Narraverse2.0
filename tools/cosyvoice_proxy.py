#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
CosyVoice 本地 WebSocket 中继代理
=================================
浏览器原生 WebSocket **无法设置自定义握手头**，而阿里云百炼 maas 的 CosyVoice
必须在握手头里带 `Authorization: Bearer <api_key>`，否则返回 401。
本代理在本地监听 ws://127.0.0.1:8787，连接上游 maas 时**代注鉴权头**，并对
浏览器 <-> 上游做**双向透明转发**（文本指令与二进制音频帧原样搬运）。

配置优先级：环境变量 > 同目录 cosyvoice_proxy.json；密钥不内置，必须由运行环境提供。
启动：  python cosyvoice_proxy.py
浏览器设置：本地中继地址填  ws://localhost:8787
"""
import asyncio
import json
import os
import sys

import websockets

HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(HERE, "cosyvoice_proxy.json")

DEFAULTS = {
    "endpoint": "wss://llm-23ju9mf3n4t0k5dx.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference",
    "api_key": "",
    "listen_host": "127.0.0.1",
    "listen_port": 8787,
}


def load_config():
    cfg = dict(DEFAULTS)
    if os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, "r", encoding="utf-8") as f:
                cfg.update(json.load(f))
        except Exception as e:
            print(f"[proxy] 读取 {CONFIG_PATH} 失败，用默认值：{e}", file=sys.stderr)
    cfg["endpoint"] = os.environ.get("COSYVOICE_ENDPOINT", cfg["endpoint"])
    cfg["api_key"] = os.environ.get("COSYVOICE_API_KEY", cfg["api_key"])
    try:
        cfg["listen_port"] = int(os.environ.get("COSYVOICE_PROXY_PORT", cfg.get("listen_port", 8787)))
    except ValueError:
        cfg["listen_port"] = 8787
    cfg["listen_host"] = os.environ.get("COSYVOICE_PROXY_HOST", cfg.get("listen_host", "127.0.0.1"))
    if not cfg["api_key"]:
        raise RuntimeError("未配置 COSYVOICE_API_KEY；请通过环境变量或本地未提交的 cosyvoice_proxy.json 提供。")
    return cfg


async def pipe(src, dst, label):
    """把 src 收到的消息原样转给 dst；任一侧断开即结束本方向。"""
    try:
        async for msg in src:
            await dst.send(msg)
    except websockets.ConnectionClosed:
        pass
    except Exception as e:
        print(f"[proxy] {label} 转发异常：{e}", file=sys.stderr)


async def handle_client(client_ws, cfg):
    headers = {
        "Authorization": "Bearer " + cfg["api_key"],
        "user-agent": "text-adventure-platform",
    }
    # 兼容不同版本 websockets：新版本用 additional_headers，旧版本用 extra_headers
    connect_kwargs = {"max_size": None}
    try:
        import inspect
        sig = inspect.signature(websockets.connect)
        if "additional_headers" in sig.parameters:
            connect_kwargs["additional_headers"] = headers
        else:
            connect_kwargs["extra_headers"] = headers
    except Exception:
        connect_kwargs["additional_headers"] = headers

    try:
        upstream = await websockets.connect(cfg["endpoint"], **connect_kwargs)
    except Exception as e:
        print(f"[proxy] 连接上游失败：{e}", file=sys.stderr)
        try:
            await client_ws.close()
        except Exception:
            pass
        return

    print(f"[proxy] 客户端已连接，上游已建立（->{cfg['endpoint']}）", flush=True)
    try:
        await asyncio.gather(
            pipe(client_ws, upstream, "client->upstream"),
            pipe(upstream, client_ws, "upstream->client"),
        )
    finally:
        try:
            await upstream.close()
        except Exception:
            pass
        print("[proxy] 客户端连接结束", flush=True)


async def main():
    cfg = load_config()
    masked = cfg["api_key"][:12] + "..." if cfg["api_key"] else "(空)"
    print(f"[proxy] CosyVoice 中继启动：ws://{cfg['listen_host']}:{cfg['listen_port']}  ->  {cfg['endpoint']}", flush=True)
    print(f"[proxy] 鉴权：Authorization: Bearer {masked}（代注到握手头）", flush=True)
    async with websockets.serve(
        lambda ws: handle_client(ws, cfg),
        cfg["listen_host"],
        cfg["listen_port"],
        max_size=None,
    ):
        await asyncio.Future()  # 永久运行


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n[proxy] 已停止")
