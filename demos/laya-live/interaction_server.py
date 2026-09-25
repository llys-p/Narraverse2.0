"""Candidate A entry point; separate port, same bridge engine/store/protocol in this process."""
import argparse
import traceback
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import laya_bridge as B
from interaction_core.bridge_adapter import BridgeEvidence, BridgeStore, NoEvidence
from interaction_core.contracts import CoreError
from interaction_core.interpreter import SemanticInterpreter
from interaction_core.narration import StoryAgent
from interaction_core.scene import make_scene
from interaction_core.service import InteractionCore


def make_handler(core):
    class InteractionHandler(B.Handler):
        def dispatch(self, operation):
            try:
                return self._json(operation())
            except CoreError as exc:
                return self._json({"error": {"code": exc.code, "message": str(exc)}}, exc.status)
            except B._ProtoError as exc:
                return self._json(exc.body(), exc.http)
            except B.TranslationFailure:
                return self._json({"error": {"code": "TRANSLATION_FAILED", "message": "翻译失败，未提交"}}, 502)
            except Exception:
                # Avoid leaking provider response bodies/keys in public error output.
                traceback.print_exc()
                return self._json({"error": {"code": "INTERNAL_ERROR", "message": "交互处理异常，查看服务端日志"}}, 500)

        def do_GET(self):
            url = urlparse(self.path)
            if url.path in {"/interaction", "/interaction/"}:
                content = (Path(__file__).parent / "interaction_core" / "demo.html").read_bytes()
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(content)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(content)
                return
            params = parse_qs(url.query)
            if url.path == "/interaction/state":
                return self.dispatch(lambda: core.state(params.get("session_id", [""])[0]))
            if url.path == "/interaction/receipt":
                return self.dispatch(lambda: core.get_receipt(params.get("session_id", [""])[0],
                                                              params.get("event_id", [""])[0]))
            return super().do_GET()

        def do_POST(self):
            operations = {"/interaction/prepare": core.prepare, "/interaction/commit": core.commit,
                          "/interaction/narrate": core.narrate}
            op = operations.get(urlparse(self.path).path)
            if op:
                return self.dispatch(lambda: op(self._read_protocol()))
            return super().do_POST()
    return InteractionHandler


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8132)
    parser.add_argument("--env-file", type=Path, help="Read existing environment file; never copy its contents")
    parser.add_argument("--rules-only", action="store_true", help="Explicitly omit Laya evidence; semantic LLM is still required")
    args = parser.parse_args()
    if args.env_file:
        B.load_env_file(args.env_file)
    if not args.rules_only:
        B.ENGINE.init()
        if not B.ENGINE.ready:
            raise SystemExit("Laya 未就绪；请检查 LAYA_MODELS_DIR/LAYA_DEVICE。规则试玩可显式使用 --rules-only。")
        print("Laya:", B.ENGINE.device_label(), "load_ms=", B.ENGINE.load_ms)
    evidence = NoEvidence() if args.rules_only else BridgeEvidence(B)
    core = InteractionCore(BridgeStore(B, make_scene(B)), SemanticInterpreter(), evidence, StoryAgent())
    print("Candidate A:", "rules-only (no Laya signals)" if args.rules_only else "Laya + rules")
    print("Open http://127.0.0.1:%d/interaction" % args.port)
    ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(core)).serve_forever()


if __name__ == "__main__":
    main()
