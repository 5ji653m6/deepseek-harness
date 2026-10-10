# Agent Note: 每用户 Web GUI

Status: implemented

[English](2026-09-15-per-user-web-gui.md) | 中文

## Problem

Web GUI 是单租户的：浏览器 cookie 不携带身份，任何持有 token 的人都能看到并恢复所有 Session，MCP 服务器在挂载时收到的是进程环境凭据。已部署的 HRMS sidecar（对照 Frappe 验证所出示的凭据、以该用户身份执行、审计）无法触达浏览器，因为 `/api` 与 `/` 下的一切请求都受 `BrowserAuth` 门禁约束，任何仅组合式的改动都无法识别浏览器调用者。

## Decision

经 Frappe token 登录验证的浏览器主体成为唯一的调用者身份。`POST /api/hrms/login` 接受 HRMS 邮箱加 `api_key:api_secret` 密钥对，先对照 `{hrmsBaseUrl}/api/method/frappe.auth.get_logged_user` 用 `Authorization: token <pair>` 验证，再要求返回的登录用户与所出示邮箱大小写不敏感地相等，之后才签发身份；所有失败类别都返回相同的纯文本 401。成功后，路由将该密钥对存入与主体绑定的进程生命周期服务端保险库，并签发携带主体的签名 cookie；密钥对绝不进入 cookie、响应体或日志。`POST /api/hrms/logout` 丢弃所持有的密钥对并清除 cookie。仅当所属插件配置了合法的 `hrmsBaseUrl` 时才挂载登录与登出路由；缺省配置保持 GUI 为单操作者模式，配置格式错误则在插件加载时失败。

cookie 载荷新增可选 `subject` 字段；进程 token 交换签发的无主体 cookie 解码不变，因此已部署的密钥与所有既有会话保持可用。`SessionHeader` 新增可选 `owner` 字段，在创建时由已验证的 dispatch 主体盖印，并宽松解码。该字段是 Session 格式 V4 唯一的结构新增，通过相邻的 [V3 到 V4 迁移](../../../../packages/session/session-format-v3-to-v4/README.zh.md)发布；已提交的 v3 世代从不改写，恢复的 v3 记录不携带 owner（[格式决策](../architecture/2026-08-31-released-session-format-migrations.zh.md)）。会话语料列表与搜索按 header owner 过滤：主体只能看到自己拥有的 Session，无主体的进程 token 路径只能看到无主体的 Session。恢复、采用（adoption）、历史分页/跟随、分叉与日志导出执行相同的归属检查，不匹配时返回与 Session 不存在相同的 not-found 静默，绝不返回 403 而暴露其他主体的 Session 存在。内部 Host 工作（当前异步链上没有浏览器 dispatch）保持完全访问，因此后台驱动（goal、定时任务、subagent 路由）不受影响。

调用者归属通过两个进程级 `Symbol.for` 槽位跨包传递：Connection 的 `apply` 在 cordis effect 中于 `dsh.session-controller.callerSubjectReader` 发布其 `AsyncLocalStorage` dispatch 标记的读取器，并在 `dsh.session-controller.callerSubjectRunner` 发布配套的 `runWithCallerSubject` runner；/api 路由与 Gateway WebSocket 升级将每个 dispatch 包裹在标记中运行。会话过滤读取该读取器，而无需值引用 `dsh-client-connection`——依赖策略将该包保留给 Connection 自己的 Host 入口；session-controller 使用 runner 将每条提示词准入置于该 Session 属主主体的 dispatch 之下，因此在准入内启动的 agent-loop 驱动链在每次工具调用时都出示属主的 header。标记用对象包裹主体，使消费者能够区分"没有浏览器 dispatch"（内部工作）与"无主体的浏览器 dispatch"。

streamable-http MCP 传输新增可选 `resolveRequestHeaders?: (subject: string | undefined) => Record<string, string>`，通过自定义 fetch 在每次发出请求时以当时活跃的调用者主体调用。当 `dsh-client-connection` 提供 HRMS header 来源时，`mcp-client` 将解析器接线到它：`X-HRMS-User` 携带所属 Session 的主体，`X-HRMS-User-Token` 携带服务端持有的密钥对，与已部署的 Track 1 header 契约一致。正是每请求解析使共享的应用级连接对并发属主安全：在建立连接时冻结的 header 会让之后的每次调用都使用建立者的凭据，而在某个属主的 dispatch 内建立连接又会把这些凭据泄露给所有其他属主的调用。解析器或主体缺失时不解析任何 header，保持单操作者行为字节级一致，并让每用户 sidecar 在操作者显式启用前继续拒绝空 header。

## Alternatives considered

**为 session-controller 增加对 `dsh-client-connection` 的 peer-required 值引用。** 依赖策略拒绝了未分类的值引用；将其分类会让任何 Host 包触及 Connection 的内部。进程级槽位把读取器契约限制为一个函数，同时策略清单保持不动。

**在 MCP 传输中用每用户连接池执行归属。** 一条共享连接加每请求 header 解析即匹配已部署的 Track 1"验证而非信任"契约；每用户池会成倍增加服务器进程与工具注册，而 sidecar 会验证每个所出示的凭据，安全上没有收益。被否定的中间方案是每次建立连接时解析：在建立时冻结的 header 若在某个属主的 dispatch 内确定，就会把该属主的凭据泄露给所有其他属主的调用。

**从平行的身份存储或客户端自供 header 盖印身份。** Session owner 与服务端持有的 token 保险库是唯一的身份来源；普通 API 调用上浏览器自供的 `X-HRMS-*` 值永远不会被信任，传输层从 dispatch 标记读取主体，而不是从请求 header。

**用 403 回答归属不匹配。** not-found 静默防止探测其他主体名下哪些 Session id 存在；语料过滤与每个受检表面都遵循相同的静默。

## Consequences

被拥有的 Session 对其他主体与无主体路径不可见，但实时 `api-session/added` 事件推送不做按主体过滤——在下次列表刷新重新过滤之前，外来 Session 行可能短暂出现。MCP header 反映发出每个请求时的主体，因此在任何属主 dispatch 之外发出的请求（启动、定时重连）不会出示 HRMS header，直到有属主的轮次运行；重启会清空 token 保险库，仍然有效的 cookie 只是不再出示 HRMS header，直到下次登录。每用户强制执行仍是操作者的 `HRMS_PER_USER=1` sidecar 选择：本改动从不硬切换，无主体 cookie 的行为与之前完全一致。
