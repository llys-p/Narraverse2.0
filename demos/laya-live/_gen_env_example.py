"""从 .env 生成脱敏的 .env.example。

★ 上一版有个真 bug，记在这里防止再犯：
  判据用的是「键名里含 TOKEN」，结果 `LLM_MAX_TOKENS` 命中了 `TOKEN`，
   数值 1600 被替换成密钥占位符 —— 脱敏把非密钥项也脱了。
   而自检写的是 re.findall(r"sk-[A-Za-z0-9]{8,}")，占位符后面跟的是中文，
   正则根本不匹配，于是**自检放行了这个错误**，一路进了仓库。

现在的判据：只认「最后一个下划线分段」，且必须是完整的敏感词。
  DEEPSEEK_API_KEY  → 末段 KEY    → 脱敏
  LLM_MAX_TOKENS    → 末段 TOKENS → 不脱敏   ← 这正是上一版搞错的那个

★★ 第二个坑（2026-09-23 又踩了一次，值得记）：
  这个脚本是 `.env` 的**透传 + 脱敏**，中段内容（注释和值）都来自 `.env`。
  所以直接手改 `.env.example` 是白改 —— 下次一跑生成器就被覆盖。
  同理，说明性文字必须写在下面的 HEADER / FOOTER 里，
  不要写进 `.env`：`.env` 不入库，写在那儿等于没写。
  这和 `启动Laya桥.bat` 的规矩一样：**改文案改生成器，不要改产物**。
"""
import re
import sys
import pathlib

HERE = pathlib.Path(__file__).resolve().parent
SRC = HERE / ".env"
DST = HERE / ".env.example"

# 只比对「最后一个下划线分段」，必须是完整词
SECRET_SEGMENTS = {"KEY", "KEYS", "TOKEN", "SECRET", "SECRETS", "PASSWORD",
                   "PASSWD", "PWD", "AUTH", "CREDENTIAL", "CREDENTIALS", "APIKEY"}

PLACEHOLDER = "sk-在此填入你自己的密钥"

HEADER = """\
# ===========================================================================
# Laya 实时对话桥 —— 配置样例
# ★ 本文件由 _gen_env_example.py 生成，**不要手改**：改文案请改生成器，否则会被覆盖。
# ===========================================================================
#
# 用法：cp .env.example .env，然后在 .env 里填你自己的值。
# .env 已被 .gitignore 忽略，不会入库；本文件只是样板，里面没有任何真实密钥。
#
# ── 键名与优先级（见 laya_bridge.py 的 load_env_file()，以下为准）──────────
#   · 密钥类（DEEPSEEK_API_KEY / LLM_API_KEY）—— **.env 优先**，覆盖系统环境变量。
#     为什么反过来：本机用户级环境变量里存着一个已失效的旧 key（尾号 d4f0）。
#     若让系统优先，.env 里有效的 key 会被静默屏蔽 —— 表现为 401，而报错里只显示
#     d4f0，极难定位。被覆盖的键会在启动横幅与 /health 的 env_overridden 里报出来。
#   · 其它项（LAYA_MODEL / LLM_EFFORT / LLM_MAX_TOKENS ...）—— **系统环境变量优先**，
#     方便临时试参数而不改文件，例如：
#         LAYA_MODEL=english python laya_bridge.py signaltest
#     （Windows cmd 下用 `set X=Y && ...` 的写法。）
#
# ── 下面到文件结尾的内容来自 .env（密钥已脱敏）──────────────────────────
"""

FOOTER = """\

# ===========================================================================
# 运行方式备注（同样由生成器维护）
# ===========================================================================
#
# 检查点对照（§11）：typed-decisions 与 english 必须在**两个进程**里各跑一次，
# 两个 800MB 级检查点同时驻留会 OOM（segfault 且无 traceback）：
#     python laya_bridge.py signaltest
#     LAYA_MODEL=english python laya_bridge.py signaltest
#     python laya_bridge.py ckptcompare
#
# GPU：默认 .venv 里 torch 是 +cpu 版，会自动落到 cpu。
# 要跑真 GPU，先 bash _build_cuda_env.sh 建出 .venv-cuda（用 _fetch_cuda_torch.sh
# 下好并校验过的 cu126 轮子），再用它的解释器：
#     LAYA_DEVICE=cuda .venv-cuda/Scripts/python.exe laya_bridge.py bench
# 本机 GPU：RTX 4060 Laptop / 8188 MiB / 驱动 595.71。
#
# 人格渲染写法：signed（extraversion -0.35）或 polarity（introversion 0.35）。
# 环境变量优先于配置，用于 personatest 的写法对照：
#     LAYA_PERSONA_STYLE=polarity python laya_bridge.py personatest
# LAYA_PERSONA_STYLE=signed
"""


def is_secret_key(key):
    return key.strip().upper().split("_")[-1] in SECRET_SEGMENTS


def main():
    if not SRC.exists():
        print("找不到 %s" % SRC, file=sys.stderr)
        return 1

    out, secrets = [], []
    for raw in SRC.read_text(encoding="utf-8", errors="replace").splitlines():
        m = re.match(r"^([A-Za-z_][A-Za-z0-9_]*)=(.*)$", raw)
        if not m:
            out.append(raw)
            continue
        key, val = m.group(1), m.group(2)
        if is_secret_key(key):
            out.append("%s=%s" % (key, PLACEHOLDER if val.strip() else ""))
            secrets.append(key)
        else:
            out.append("%s=%s" % (key, val))

    DST.write_text(HEADER + "\n" + "\n".join(out).strip() + "\n" + FOOTER, encoding="utf-8")
    text = DST.read_text(encoding="utf-8")

    # ---- 自检 ----
    fail = []

    # ① 真实密钥形态（长 ASCII）必须为 0 —— 这是漏脱敏的判据
    long_keys = re.findall(r"sk-[A-Za-z0-9_\-]{12,}", text)
    if long_keys:
        fail.append("疑似真实密钥残留 %d 处" % len(long_keys))

    # ② 占位符出现次数必须恰好等于密钥键数量 —— 这是「脱多了」的判据（上一版就栽在这）
    n_ph = text.count(PLACEHOLDER)
    if n_ph != len(secrets):
        fail.append("占位符 %d 个，但密钥键只有 %d 个（脱敏范围不对）" % (n_ph, len(secrets)))

    # ③ 逐行复核：占位符只能出现在密钥键上
    for line in text.splitlines():
        m = re.match(r"^([A-Za-z_][A-Za-z0-9_]*)=(.*)$", line)
        if not m:
            continue
        k, v = m.group(1), m.group(2)
        if PLACEHOLDER in v and not is_secret_key(k):
            fail.append("非密钥键 %s 被误脱敏" % k)
        if is_secret_key(k) and v.strip() and PLACEHOLDER not in v:
            fail.append("密钥键 %s 未被脱敏" % k)

    # ④ 关键的非密钥项要有合理默认值（防止再次被误伤）
    for must in ("LLM_MAX_TOKENS=", "LLM_EFFORT=", "LLM_MODEL=", "LAYA_MODEL="):
        line = next((l for l in text.splitlines() if l.startswith(must)), None)
        if line is None:
            fail.append("缺少键 %s" % must)
        elif not line.split("=", 1)[1].strip():
            fail.append("%s 的值为空" % must)
        elif PLACEHOLDER in line:
            fail.append("%s 被误脱敏" % must)

    print("写出 %s（%d B）" % (DST.name, DST.stat().st_size))
    print("识别为密钥的键：%s" % (", ".join(secrets) or "（无）"))
    print("占位符数量：%d" % n_ph)

    # ⑤ 说明文字必须与 load_env_file() 的实际行为一致。
    #    历史事故：HEADER 把优先级写反了（写成「环境变量优先」），
    #    结果文件里出现两段互相矛盾的说明，谁看谁懵。加个守卫钉死。
    if "真实进程环境变量优先" in text:
        fail.append("优先级说明与 load_env_file() 相反 —— 密钥类是「.env 优先」")
    if "**不要手改**" not in text:
        fail.append("缺少「本文件由生成器维护、不要手改」的警告")

    if fail:
        print("\n❌ 自检未通过：")
        for f in fail:
            print("   - %s" % f)
        return 1
    print("✅ 自检通过：真实密钥 0 处；占位符只落在密钥键上；非密钥项均已保留原值")
    return 0


if __name__ == "__main__":
    sys.exit(main())
