import asyncio, websockets, json

async def main():
    got_audio = 0
    try:
        async with websockets.connect("ws://localhost:8787", max_size=None) as c:
            task_id = "t-full-1"
            async def send_run():
                await c.send(json.dumps({
                    "header": {"action": "run-task", "task_id": task_id, "streaming": "duplex"},
                    "payload": {"task_group": "audio", "task": "tts", "function": "SpeechSynthesizer",
                                "model": "cosyvoice-v3-flash",
                                "parameters": {"text_type": "PlainText", "voice": "longanyang", "format": "mp3", "sample_rate": 22050},
                                "input": {}},
                }))
            async def send_text():
                await c.send(json.dumps({"header": {"action": "continue-task", "task_id": task_id, "streaming": "duplex"}, "payload": {"input": {"text": "你好，这是一段语音合成测试。"}}}))
                await c.send(json.dumps({"header": {"action": "finish-task", "task_id": task_id, "streaming": "duplex"}, "payload": {"input": {}}}))

            await send_run()
            while True:
                try:
                    msg = await asyncio.wait_for(c.recv(), timeout=8)
                except asyncio.TimeoutError:
                    break
                if isinstance(msg, str):
                    print("[client] 文本：", msg[:160])
                    try:
                        obj = json.loads(msg)
                        if obj.get("header", {}).get("event") == "task-started":
                            await send_text()
                    except Exception:
                        pass
                else:
                    got_audio += len(msg)
            print(f"[client] 收到音频字节数：{got_audio}", "✅ 有音频帧" if got_audio > 0 else "⚠️ 未收到音频帧")
    except Exception as e:
        print("[client] 异常：", repr(e))

asyncio.run(main())
