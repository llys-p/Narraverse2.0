# Narraverse2.0 Phase 3.2-C0 iframe Security Design

> 版本：v1.0
> 日期：2026-09-15
> 状态：**DESIGN FREEZE PASS**（2026-09-15，外部 Edge 隔离证明与 STRIDE 复审通过）
> 范围：只冻结 Narraverse / Module4 的宿主信任根、来源隔离、数据连续性和受控模型代理边界；C0 不注册生产 API、不改 `app/`、不改 Module3/Module4。

## 1. 裁定

Phase 3.2-C0 只采用一个方案：

1. Denova 顶层宿主固定使用 `http://127.0.0.1:<runtime-port>`。
2. Narraverse iframe 使用同一 HTTP 服务、同一端口的 `http://localhost:<runtime-port>`，以 hostname 差异形成浏览器可强制的跨源边界。
3. Denova 进程生成一次性 bootstrap secret，通过自动打开浏览器 URL 的 fragment 交给顶层宿主。
4. 顶层宿主用 secret 换取 `HttpOnly + SameSite=Strict` 的服务端宿主会话 Cookie；浏览器 JavaScript永远拿不到会话令牌。
5. iframe 只通过 `postMessage` 把严格白名单消息交给宿主；宿主重新构造受控请求。World Ref、runContext、capability、模型投影正文永不进入 iframe。
6. 改变 origin 前，由顶层宿主在浏览器本地完成一次性数据迁移；源 origin 数据不删除，目标已有数据时不自动覆盖。

不采用：

- 无 `allow-same-origin` 的 sandbox：会让现有 IndexedDB/localStorage 不可用，需要重写整个 Narraverse/Module4 存储层。
- 第二个端口：端口自动顺延会制造新的浏览器存储分裂，且增加服务、CORS 与部署复杂度。
- native bridge：当前 Denova 是 Go HTTP 服务 + 外部浏览器，不存在可复用的原生 WebView 桥。
- 仅依赖 `Origin`、`Sec-Fetch-*` 或自报字段：它们不能单独证明顶层宿主身份。

## 2. 当前代码事实

- `NarraverseWorkspace` 当前加载同源 `/narraverse/index.html?embedded=denova...`，iframe 无 sandbox。
- `app/bridge.js` 的 v1 协议只处理 ready、模式切换、主题、语言、可见性与 Module4 开关。
- `app/ai-client.js` 在 embedded 模式由 iframe 直接调用 `/api/model/chat`。
- Narraverse 主状态使用 IndexedDB `adventureAI_db/kv`，并以 `adventureAI_state*` 等 localStorage 键镜像；永久对话档案同在该 IndexedDB store。
- Module4 使用 localStorage `narraverse:module4:state` 与 recovery 副本。
- 写作和游戏的 WorldContext 已由服务端固定 consumer；iframe consumer 当前被 `worldcontext` 拒绝。
- `/api/model/chat` 是旧 iframe 的 bare 兼容入口，不能承载 WorldContext。

## 3. 威胁模型

### 3.1 受保护资产

- 已保存 World 的 Ref、selection、revision 与 ModelView。
- 服务端 runContext、scopeKey、runSalt、sourceRef 与内部映射。
- Denova 模型配置与 API 凭据。
- Narraverse / Module4 的本地浏览器存档。
- 宿主代理权限与安全审计信息。

### 3.2 不可信边界

- iframe 内全部 JavaScript、消息内容与模型输出均不可信。
- iframe 可以直接向 Denova 任意 HTTP 路径发请求，可以伪造普通 JSON 字段，可以重复、乱序或重放 postMessage。
- 跨源页面可尝试 CORS 请求、导航、弹窗、嵌套 frame 与消息欺骗。

### 3.3 信任假设

- Denova 进程、顶层 React 宿主源码与本机浏览器实现可信。
- 不防御已经取得同一 Windows 用户权限、可读取进程命令行或控制浏览器扩展的本机恶意软件。
- 顶层宿主发生 XSS 等同宿主权限失守；CSP 与输出编码仍需单独防护。
- 本阶段是本机 loopback 能力；LAN 页面只能 bare，不签发宿主会话。

## 4. 来源隔离

### 4.1 规范 origin

| 角色 | 正式模式 | Vite 开发模式 |
| --- | --- | --- |
| 顶层宿主 | `http://127.0.0.1:<backend-port>` | `http://127.0.0.1:<frontend-port>` |
| Narraverse iframe | `http://localhost:<backend-port>` | `http://localhost:<frontend-port>` |
| API | 顶层宿主同源 | 由 Vite `/api` proxy 转发，浏览器仍视为宿主同源 |

- 顶层入口继续把 `localhost` 规范跳转为 `127.0.0.1`。
- iframe `src` 必须由当前 `window.location.port` 构造，不写死 8080/5173/5174。
- 宿主接收消息时同时校验 `event.source === mountedIframe.contentWindow`、`event.origin === expectedIframeOrigin`、协议版本、消息类型与 payload 白名单。
- iframe 接收消息时校验 `event.source === window.parent` 与显式 `host_origin`；不得再用 `window.location.origin` 代替父 origin。

### 4.2 为什么服务端可区分

- 宿主请求来自 `127.0.0.1` site，并自动携带仅属于该 site 的 Strict Cookie。
- iframe 运行于 `localhost` site：无法读取父页面 URL/DOM/闭包，无法读取 HttpOnly Cookie；跨站请求不会携带 SameSite=Strict Cookie。
- 特权端点同时要求有效宿主会话、精确 Host/Origin 与 loopback 来源。仅伪造 JSON、Host 或 Origin 不能替代 Cookie。

## 5. Bootstrap 与宿主会话

### 5.1 secret

| 属性 | 冻结值 |
| --- | --- |
| 生成 | Denova 进程启动时 CSPRNG 32 bytes，base64url 无 padding |
| 数量 | 每次自动打开宿主页面生成一个；同一 secret 只能成功消费一次 |
| 交付 | OS 启动浏览器 URL fragment：`#denova-host-bootstrap=<secret>` |
| TTL | 5 分钟；不续期 |
| 存储 | 服务端仅内存；宿主读取后立即 `history.replaceState` 清除 fragment，只在 bootstrap 请求前短暂驻留闭包 |
| 禁止 | query、header 固定值、HTML、Cookie、localStorage、sessionStorage、IndexedDB、日志、错误响应 |

URL fragment 不进入 HTTP 请求和 Referer。`--no-open` 不生成可复制 secret URL；该模式下页面保持 bare。

### 5.2 bootstrap 请求

`POST /api/world-context/host/bootstrap`

请求：

```json
{"secret":"<43-char-base64url>"}
```

服务端必须按顺序校验：

1. TCP 来源为 loopback；
2. Host 与 Origin 精确等于当前正式/开发宿主 origin；
3. `Content-Type: application/json`、body ≤ 1 KiB、单一 JSON、精确键名、无尾随值；
4. secret 格式、存在、未用、未过期，常量时间比对；
5. 原子消费 secret 后创建宿主会话。

成功只返回：

```json
{"status":"ready","expiresAt":"RFC3339"}
```

不得返回 token、session id、内部原因。所有失败统一 403 `consumer_not_trusted`；格式类错误可返回 400 `invalid_request`，两者均脱敏。

### 5.3 Cookie 与服务端记录

Cookie：

```text
denova_host_session=<opaque-random-32B>; HttpOnly; SameSite=Strict; Path=/api/world-context/host
```

- loopback HTTP 下不声明无法生效的 `Secure`；若未来使用 HTTPS，必须加 `Secure`。
- 服务端只保存 token SHA-256，不保存明文。
- idle TTL 30 分钟，absolute TTL 6 小时；每次有效宿主调用刷新 idle，不延长 absolute。
- 一个宿主会话服务同一顶层页面管理的多个 iframe 实例与 narraverse/module4 两个 consumer，解决“一次 secret 对多个 frame”冲突。
- 页面刷新继续使用 HttpOnly Cookie；页面关闭不主动删除服务端记录，等待 idle TTL。
- 显式退出/安全失败可调用 revoke；revoke、absolute TTL、进程重启后 Cookie 统一视为未知会话。

## 6. Frame 绑定与 WorldContext

### 6.1 宿主内存状态

宿主为每个实际挂载的 iframe 生成 CSPRNG `frameInstance`，只存在 React 组件内存。它不是授权凭证，服务端仍强制要求宿主 Cookie。

宿主只在用户从 World Console 明确进入 Narraverse 或 Module4 后绑定：

```text
frameInstance + consumer(route-fixed) + saved WorldContextRef
```

分路由固定 consumer：

- `POST /api/world-context/host/narraverse/bind`
- `POST /api/world-context/host/module4/bind`

body 只允许 `{frameInstance, world_context}`。服务端重读 World、校验 revision/selection/预算，创建对应 runContext；响应只含 `context_state` 与脱敏摘要。

### 6.2 清理

- iframe 重新挂载：旧 `frameInstance` 立即 unbind，新实例显式重绑。
- 用户清除：对应 consumer/frame 解绑；不影响另一个 consumer。
- 切 World/selection：显式新 bind；不得热替换运行中的调用。
- World 归档：已物化的在途请求可以结束；新 bind 拒绝 `world_archived`。
- 宿主会话 revoke/过期/进程重启：该会话下所有 frame binding 与 runContext 清理所有权只释放一次。

runContext 仍只保存派生投影和运行索引，不保存 World 副本，不进入磁盘或剧情存档。

## 7. iframe 消息协议 v2

### 7.1 协商

v1 ready 继续兼容。新 iframe ready 增加 `capabilities: ['host-model-proxy-v2']`。宿主未建立安全会话时返回 `host-model-proxy-unavailable`，iframe 明确显示“本次未携带世界背景”，并可继续旧 bare 模型调用。

### 7.2 严格消息

iframe → 宿主：

```json
{
  "source":"narraverse",
  "version":2,
  "type":"model-call-request",
  "payload":{
    "requestId":"<base64url>",
    "messages":[{"role":"user","content":"..."}],
    "options":{"maxTokens":2048,"temperature":0.7}
  }
}
```

- `requestId` 16～128 base64url；同 frame 最多 1 个在途请求，完成后可复用新 id。
- messages 1～64，role 仅 `system|user|assistant`，单条 ≤ 32,000 Unicode code points，总正文 ≤ 96 KiB。
- `maxTokens` 1～8192；temperature 0～2；未知键、尾随结构、非有限数字拒绝。
- payload 出现 `worldId`、revision、selection、consumer、scope、scopeKey、runContextId、sourceRef、runSalt、capability、analysisHandle、modelView、snapshot 任一保留键：宿主不转发，返回 `consumer_not_trusted` 并脱敏审计。

宿主 → iframe：

```json
{
  "source":"denova",
  "version":2,
  "type":"model-call-result",
  "payload":{
    "requestId":"<same>",
    "ok":true,
    "content":"...",
    "contextSummary":{"state":"active","worldName":"...","selectedCount":3}
  }
}
```

失败只返回稳定 `code` 与脱敏 `message`。绝不返回 Cookie、Ref、ModelView、sourceRef、runContext 或内部映射。

### 7.3 宿主代理

- 宿主根据自己的 `openModule4` 状态选择 narraverse 或 module4 受控路由；不采信 iframe 自报 module/consumer。
- 宿主从白名单字段重新构造 HTTP body，不转发原始对象。
- 服务端路由固定 consumer，按 frame binding 取回 runContext，在模型输入最后边界注入只读 ModelView，然后复用现有 `App.GenerateModel`/模型网关/provider 链。
- 模型输出是普通文本；iframe 现有 UI 必须用 textContent/既有安全渲染，不新增 `innerHTML` 注入路径。
- iframe 的剧情、冒险、Module4 时钟/事件仍写各自存储；代理永不调用 World 写端点。

## 8. 浏览器数据连续性

### 8.1 迁移时序

首次新版本页面必须按以下顺序：

1. 顶层宿主读取并清除 fragment，把 secret 暂存在闭包；此时尚未 bootstrap、没有宿主 Cookie。
2. 加载 `localhost` migration receiver，只进行目标存储状态探测，不启动 Narraverse 应用与模型请求。
3. 顶层宿主从自身 `127.0.0.1` origin 读取旧数据。
4. 若源有数据且目标为空，使用 `MessageChannel` 分块发送，目标校验后写入并回传摘要。
5. 源/目标摘要一致后，目标写 migration manifest；源数据保持不变。
6. migration receiver 重载为正常 Narraverse iframe。
7. 最后才调用 bootstrap 建立宿主会话并开放受控代理。

这样迁移阶段不存在可被同源旧 iframe 携带的特权 Cookie。

### 8.2 迁移集合

localStorage 只迁移以下前缀：

- `adventureAI_`
- `narraverse:`
- `og_ai_`

IndexedDB 迁移 `adventureAI_db` 的 `kv` store 全部键值，包括 `state`、`state_bak` 与 `conversationArchive:v1:*`。

不读取 Cookie、Cache Storage、浏览器密码、其它 origin、Denova Settings 或 API 响应。迁移正文不进入服务器、日志、埋点或错误消息。

### 8.3 完整性与限制

- 迁移协议版本 `narraverse-origin-migration/v1`。
- 单块 ≤ 512 KiB，总量默认上限 128 MiB；超限停止并提示用户先导出，不静默截断。
- 每项携带类型与 SHA-256；目标写入后重读校验；最终 manifest 记录键数、总字节与聚合哈希，不记录正文。
- target 只要存在 Narraverse 主状态、Module4 主状态或 migration manifest，即视为非空，不自动覆盖。
- 目标非空时保留两边，展示源/目标数量与日期，让用户进入一侧并先导出；本阶段不做自动合并。
- 失败时不删除源；目标只标记 incomplete，正常应用不得加载 incomplete 数据。回滚需要用户显式选择并只清理由 manifest 列出的目标键。

## 9. 刷新、重启、LAN 与兼容

| 场景 | 行为 |
| --- | --- |
| 顶层刷新 | Strict HttpOnly Cookie 仍有效；重新生成 frameInstance 并显式重绑 |
| iframe 刷新 | 旧 frame unbind，新 frame 显式重绑；iframe 无法自行恢复权限 |
| 多 iframe | 同一宿主会话可管理多个 frameInstance；每个 binding 独立，消息按 source window 路由 |
| 用户清除 | 只解绑对应 consumer/frame；World 不变 |
| Denova 进程重启 | 内存 secret/session/frame/runContext 全清；旧 Cookie 返回统一 403；自动打开的新页面重新 bootstrap |
| `--no-open` / 手工 URL | 无 fragment；不 bootstrap；Narraverse/Module4 保持 bare，UI 明示 |
| AllowLANAccess | C/D WorldContext 代理禁用；LAN 页面保持 bare。后续若需要远程信任须另立 HTTPS/auth 设计 |
| 旧 iframe v1 | 继续直调 `/api/model/chat`，永远 bare；通用网关拒收世界控制字段 |

## 10. 错误与审计

- bootstrap/session/origin/cookie/frame 归属失败统一 403 `consumer_not_trusted`，不得降级成带背景或泄露哪项校验失败。
- revision、selection、archived、budget 等继续使用现有 WorldContext 稳定错误码。
- 只有允许降级集合可以返回 `degraded`；阻断错误不调用模型。
- 审计只记录时间、固定 consumer、动作、结果码、Host/Origin 分类、token/frame/request 的短哈希与计数；禁止正文、secret、Cookie、World 路径、Ref、ModelView、sourceRef、runContext 原值。
- 每宿主会话最多 8 个 frame binding；每 frame 1 个在途模型请求；body/model token 继续受既有网关上限。

## 11. C0 隔离证明门

C0 必须用当前 Windows 外部 Edge/Chrome 在同一端口证明：

1. `127.0.0.1` 与 `localhost` 的 `location.origin`、localStorage、IndexedDB 隔离。
2. 宿主页从 fragment 取得一次性 secret，可 bootstrap；secret 二次使用失败。
3. Cookie 为 HttpOnly、SameSite=Strict、限定 Path；宿主特权请求成功。
4. iframe 直接请求特权端点不携带 Cookie并得到 403；伪造 Origin/consumer/worldId 无法获得权限。
5. iframe 无法读 parent URL/DOM、Cookie、Ref 或 ModelView。
6. 多 frame 可独立绑定；撤销一个不影响另一个。
7. 刷新、revoke、进程重启语义符合第 9 节。
8. 迁移夹具覆盖 localStorage、IDB、Module4、对话 archive、空目标、目标冲突、失败回滚与哈希一致。

夹具与证据必须隔离在测试目录，不读取用户真实浏览器 Profile，不输出任何 API Key 或完整存档。

## 12. C / D 实施边界

### 3.2-C Narraverse

- 实现 bootstrap/session/frame registry 与 narraverse 固定 consumer 受控入口。
- 实现跨源 `NarraverseWorkspace`、migration receiver 与 v2 host proxy。
- embedded `NarraverseSharedAI.chat` 改走 postMessage；standalone 与 v1 bare 回退保留。
- World Console 新增显式“带入叙界”，只传已保存 Ref 给宿主。
- 完成一次真实 Narraverse 模型调用；运行前后 World revision/JSON 不变。

### 3.2-D Module4

- 不新增第二套信任根或模型链；复用同一宿主会话、frame registry、代理与消息协议。
- 宿主以自己持有的 `openModule4` 状态固定 consumer=module4。
- World Console 新增显式“带入开放沙盒”；Module4 World/clock/NPC/event/settlement 仍为独立 Runtime 数据。
- 完成一次真实 Module4 模型调用；World 与 Narraverse 数据互不回写。

## 13. 已冻结禁止事项

- iframe 持有 Cookie、secret、capability、Ref、runContext 或 ModelView。
- iframe/客户端选择 consumer、scopeKey、模型配置或 World 写权限。
- 把 `127.0.0.1` 与 `localhost` 当成同一浏览器存储。
- 自动覆盖或删除任一 origin 的旧存档。
- 把迁移包、世界背景或模型正文写入日志。
- 新建 Module4 专属 API Key/模型配置/模型网关。
- 将剧情、对话、事件、Timeline 或 Module4 状态自动写回 World。
- C0 证明未通过时创建生产特权路由。

## 14. Design Freeze 判定

本方案在以下证据齐全后由 Candidate 转为 PASS：

- 第 11 节浏览器隔离证明全部通过；
- STRIDE 复审没有未处理 P0/P1；
- bootstrap、Cookie、迁移和消息 schema 没有 TBD/多选项；
- C/D 文件范围和回滚点可拆成独立 commit；
- 不改变 World 单一真源，不把 runContext 变成第二存储层。

PASS 只授权按第 12 节实施 C、D；不授权 Knowledge Workspace、全局 Canon、世界模拟或 Agent 自治。

## 15. C0 证明结果与安全复审

### 15.1 外部浏览器证明

隔离测试包：`denova-src/internal/securityprobe`。测试只启动临时 HTTP fixture 与全新 Edge profile，不注册生产路由、不读取用户浏览器 Profile、不读取用户存档或模型凭据。

`TestC0LoopbackOriginIsolation` 已在 Windows Microsoft Edge 实际证明：

- 同一监听端口的 `127.0.0.1` 顶层页面与 `localhost` iframe 具有不同 origin、localStorage 与 IndexedDB；iframe 无法访问 parent DOM。
- fragment secret 只成功消费一次，二次 bootstrap 返回 403；宿主 Cookie 对 JavaScript 不可见，页面刷新后仍可使用。
- iframe 跨站直调特权端点时携带 `localhost` Origin、不携带宿主 Strict Cookie并被拒绝。
- 同一宿主会话可管理两个 frame binding；撤销一个不影响另一个；模拟进程重启后旧会话失效。
- bootstrap 之前，经 MessageChannel 将允许的 `adventureAI_*`、`narraverse:*`、`og_ai_*` localStorage，以及 `adventureAI_db/kv` 的状态、备份和 conversation archive 迁移到目标 origin；目标重读后的聚合 SHA-256 与源包一致，源数据仍在，非白名单键未迁移。

`migration_contract_test.go` 另锁定：仅迁移白名单 localStorage 与完整 `adventureAI_db/kv`、空目标可提交、目标非空不覆盖、注入失败只留下不可加载的 incomplete 状态且不暴露部分正文、任意 payload 变化都会改变摘要。

验证命令：

```powershell
go test ./internal/securityprobe -count=1 -v
go vet ./internal/securityprobe
```

### 15.2 STRIDE 复审

| 类别 | 主要威胁 | 冻结控制 | 结论 |
| --- | --- | --- | --- |
| Spoofing | iframe 伪装宿主或 consumer | 跨 site + HttpOnly Strict Cookie + Host/Origin + 路由固定 consumer | 无未处理 P0/P1 |
| Tampering | 篡改 Ref、selection、迁移包或消息 | 宿主重构白名单 body；服务端重读 World/CAS 校验；迁移逐项与聚合哈希 | 无未处理 P0/P1 |
| Repudiation | 重放 secret、request 或 frame 身份 | secret 原子单次消费；frame/request 限额与短哈希审计 | 无未处理 P0/P1 |
| Information disclosure | 泄露 Cookie、Ref、ModelView、正文或路径 | iframe 永不持有特权值；响应 DTO 脱敏；迁移不进服务端与日志 | 无未处理 P0/P1 |
| Denial of service | 大 body、过多 frame、并发模型调用 | body/token/数组预算；每会话 8 frame、每 frame 1 在途；TTL 清理 | 无未处理 P0/P1 |
| Elevation of privilege | bare iframe 获得带背景模型权限 | 无有效宿主会话与 frame binding 必须 403；LAN/手工打开维持 bare | 无未处理 P0/P1 |

### 15.3 最终裁定

第 11 节证明门全部闭合，当前无未处理 P0/P1。C0 从 Candidate 转为 **PASS**，允许按第 12 节依次实现 3.2-C 与 3.2-D；生产实现仍必须逐项复用这里的信任根和迁移不变量，不能把测试 fixture 当成生产实现。
