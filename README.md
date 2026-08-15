# Yuque Web MCP

一个面向自托管场景的语雀网页会话 MCP 服务。它让用户通过微信、钉钉或支付宝官方二维码建立自己的语雀登录会话，并向支持 Streamable HTTP 的智能体提供知识库定位、搜索、文档与表格读取等能力。

> 本项目是非官方实验项目，与语雀官方无隶属关系。网页内部接口可能随前端升级变化；项目对未完成验证的能力默认失败关闭，不会根据猜测发送写请求。

## 主要能力

| 能力 | 当前状态 |
| --- | --- |
| 微信、钉钉、支付宝扫码登录，登录状态检查和本地退出 | 可用 |
| 个人空间与组织空间发现 | 可用 |
| 自有/受邀知识库、目录和文档位置索引 | 可用；共享知识库支持仍在完善 |
| 文档搜索、完整路径与 URL 消歧 | 可用 |
| 普通文档正文、版本、指纹和富内容类型读取 | 可用 |
| LakeSheet 工作表、A1 范围、值、公式、基础格式和部分图表信息读取 | 可用 |
| 文档与表格的结构化 Diff、预览、快照和冲突检查 | 可用 |
| 文档/表格远程写入 | 默认`strict`只预览；部署者可显式启用受门禁的`best_effort` |
| 知识库、协作者和整对象删除 | 工具框架已提供，默认关闭且未验证能力不会执行 |

服务目前注册30个MCP工具。`yuque_get_capabilities`会返回每个工具的`available`、`preview_only`或`disabled`状态。工具是否“存在”和远程写入是否“已开放”是两件事：创建、修改、权限变更和删除必须同时通过真实捕获、关闭浏览器重放、契约校验、并发检查及写后回读，缺少任一条件都会返回结构化错误。

## 数据安全

- 推荐一名用户运行一个独立实例；不要共享数据目录、Bearer Token 或加密密钥。
- Cookie、CSRF 和账号绑定使用 AES-256-GCM 加密后写入本地数据目录。
- 内置 SQLite 只保存当前实例的待确认变更、加密快照和脱敏审计摘要，不需要 PostgreSQL、MySQL 等外部数据库。
- `MCP_BEARER_TOKEN` 和 `SESSION_ENCRYPTION_KEY` 只保存在本地私密环境文件中，不应提交到 Git、截图或通过聊天发送。
- 远程部署必须使用 HTTPS 或受保护的内网传输；Bearer Token 不能在不可信网络中通过明文 HTTP 发送。
- 权限变更和整对象删除默认关闭，并可用精确知识库白名单进一步限制写入范围。
- 写入一致性默认使用`strict`，缺少可靠并发保护时只生成Preview，不发送远程请求。
- 登录完成后临时 Chromium 会话会关闭，日常业务请求不依赖持续运行的可视化浏览器。

## 环境要求

- Node.js 20 或更高版本
- Chrome、Chromium 或 Microsoft Edge
- 支持 MCP Streamable HTTP 的客户端

## 本地启动

```bash
git clone https://github.com/n1ngPh/yuque-web-mcp.git
cd yuque-web-mcp
npm ci
npm run check
npm run local:start
```

首次启动会创建被 Git 忽略的 `runtime/local.env`，权限为 `0600`。其中会自动生成：

- `MCP_OWNER_ID`
- 至少 32 字节的 `MCP_BEARER_TOKEN`
- 32 字节 AES 密钥 `SESSION_ENCRYPTION_KEY`

这些值必须跨重启复用，否则已有加密会话和快照将无法读取。

默认运行数据位于项目内的 `runtime/`。需要把登录数据与公开源码物理分离时，可以在启动前设置绝对路径 `LOCAL_RUNTIME_DIR`；不同 `LOCAL_PROFILE` 仍会保存到该目录的 `profiles/<profile>/` 下。相对路径会被拒绝，避免从不同工作目录启动时写入错误位置。

默认服务地址：

- 健康检查：`http://127.0.0.1:18080/healthz`
- MCP：`http://127.0.0.1:18080/mcp`
- Transport：`Streamable HTTP`
- Header：`Authorization: Bearer <MCP_BEARER_TOKEN>`

在 MCP 客户端中配置上述 URL 与 Header。不同客户端的配置格式不同，核心参数示例如下：

```json
{
  "url": "http://127.0.0.1:18080/mcp",
  "headers": {
    "Authorization": "Bearer <替换为本地Token>"
  }
}
```

## 登录流程

1. 调用 `yuque_auth_status` 检查当前实例状态。
2. 未登录时调用 `yuque_login_begin`，并选择 `dingtalk`、`wechat` 或 `alipay`。
3. 当前用户本人打开一次性登录页并使用对应应用扫码。
4. 调用 `yuque_login_status` 等待成功。
5. 登录成功后使用读取和定位工具；业务请求由服务端 HTTP 客户端完成。

个人空间扫码登录目前只支持已经注册并绑定手机号的语雀账号。企业或组织空间能够通过钉钉登录，不代表个人空间账号已经完成手机号绑定；若扫码后出现绑定页面，请先在语雀官网完成个人账号注册与手机号绑定。项目不提供短信验证码、账号密码或绕过滑块的能力。

## 常用工具

- 认证：`yuque_auth_status`、`yuque_login_begin`、`yuque_login_status`、`yuque_logout`
- 能力：`yuque_get_capabilities`
- 空间与知识库：`yuque_list_scopes`、`yuque_list_books`、`yuque_get_book`
- 定位与搜索：`yuque_search`、`yuque_get_toc`、`yuque_list_docs`、`yuque_list_all_docs`
- 文档与表格：`yuque_get_doc`、`yuque_get_sheet`
- 变更流程：各类 `yuque_preview_*`、`yuque_confirm_change`、`yuque_cancel_change`
- 快照：`yuque_list_snapshots`、`yuque_preview_restore_snapshot`

回答文档、目录或表格问题时，调用方应先展示完整路径和 URL。同名结果必须列出所有候选，确认目标后再读取或修改。

## 写入一致性

默认配置为：

```text
WRITE_CONSISTENCY_MODE=strict
```

`strict`模式允许读取和Preview，但会在发包前阻止缺少可靠并发保护的远程Confirm。部署者只有在接受语雀网页接口不存在原子CAS的限制后，才可显式设置`best_effort`；该模式仍然受版本/指纹重读、一次性Change Token、契约`liveWriteEnabled`、精确知识库白名单、加密快照和写后回读约束，不会绕过未验证接口门禁。

## Docker

仓库提供 `Dockerfile`、`compose.yaml` 和 `deploy/service.env.example`。部署前复制环境变量示例到宿主机的私密路径，填写随机 Token、加密密钥、公开访问地址和允许的 Host，再启动 Compose。

```bash
docker compose build
docker compose up -d
```

不要把真实环境文件挂回仓库。生产部署应使用只读根文件系统、非 root 用户、独立数据卷和 HTTPS 入口。

## 开发与验证

```bash
npm run format:check
npm run typecheck
npm test
npm run build
# 或一次执行
npm run check
```

普通自动测试使用脱敏 fixture，不访问真实语雀。任何真实写入验证都应在专用测试知识库中人工启用，并在执行前确认目标完整路径、账号和 Host。

公开仓库不包含内部接口研究记录、真实环境验收材料、账号信息或部署文档。运行所需的契约清单只记录程序必须使用的结构化能力门禁，不包含 Cookie、Token、手机号、验证码、文档正文或原始响应。

## 当前限制

- 使用的是未公开网页接口，前端升级可能导致能力暂时关闭。
- 复杂 Lake 专有块、附件上传、画板、评论以及部分高级表格结构仍在规划中。
- 写入并发保护和超时对账尚未完成的能力不会开放 Confirm。
- 当前尚未附加开源许可证；代码公开用于审阅和试用，正式授权方式将在稳定版本确定。
