# Tally 人工控制台（Dashboard）

和 MCP 跑在同一个进程里：`node dist/src/http-server.js`

| 路径 | 用途 | 认证 |
|---|---|---|
| `/mcp` | Claude 等 AI 客户端 | Bearer：只认个人令牌 `aimcp_…`（共享令牌不能连 MCP） |
| `/dashboard/` | 人用的控制台 | @feedmob.com 邮箱 + 共享访问令牌（仅用于登录），会话 12 小时（之后改 Google 登录） |
| `/api/*` | 控制台的 JSON 接口 | 登录会话 |

控制台和 Claude 调用的是同一套工具定义（`src/tools/*`），经过同一个 `invokeTool`（参数校验 + 使用记录）。

## 页面
总览 · 客户（阶段 1）· Spend 与 Rate（阶段 2，写入需确认）· Report 统计（阶段 3）· 使用记录（阶段 4）· 我的 MCP 令牌 · 工具调试台

## 启动
    set -a; . ./.env; set +a
    MCP_HTTP_TOKEN=<共享访问令牌> PORT=8899 USAGE_DB=data/usage.sqlite node dist/src/http-server.js
    # 开启写入：再加 ENABLE_WRITE=true
