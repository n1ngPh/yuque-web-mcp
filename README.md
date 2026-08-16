# Yuque Web MCP

一个面向自托管场景的语雀网页会话 MCP 服务。它让用户通过微信、钉钉或支付宝官方二维码建立自己的语雀登录会话，并向支持 Streamable HTTP 的智能体提供知识库定位、搜索、文档与表格安全读写等能力。

> 本项目是非官方实验项目，与语雀官方无隶属关系。网页内部接口可能随前端升级变化；项目对未完成验证的能力默认失败关闭，不会根据猜测发送写请求。

## 主要能力

| 能力                                                            | 当前状态                                                     |
| --------------------------------------------------------------- | ------------------------------------------------------------ |
| 微信、钉钉、支付宝扫码登录，登录状态检查和本地退出              | 可用                                                         |
| 个人空间与组织空间发现                                          | 可用                                                         |
| 自有/受邀知识库、角色、目录和文档位置索引                       | 已验证；共享路径使用`共享：<所有者>`消歧                     |
| 文档搜索、完整路径与 URL 消歧                                   | 可用                                                         |
| 普通文档正文、版本、指纹和富内容类型读取                        | 可用                                                         |
| LakeSheet 工作表、A1 范围、值、公式、基础格式和部分图表信息读取 | 可用                                                         |
| 文档与表格的结构化 Diff、预览、快照和冲突检查                   | 可用                                                         |
| 私有个人知识库创建                                              | 已验证；默认`strict`只预览，`best_effort`可确认并回读最终URL |
| 私有个人知识库名称与描述修改                                    | 已验证；只发送变更字段，默认`strict`只预览                   |
| 个人知识库根目录创建 Doc 与基础 Sheet                           | 已验证；单次写入、一次性确认、完整路径与内容回读             |
| 个人知识库目录分组创建、重命名、移动和空分组删除                | 已验证；默认`strict`只预览，不能通过目录工具删除文档         |
| 个人 Doc 评论列表、创建、修改和删除                             | 已验证；仅修改/删除本人评论，删除需二次确认                  |
| Doc历史版本列表、正文读取与恢复Preview                          | 已验证；恢复复用Doc安全写链路，不调用猜测的专用恢复接口      |
| 既有文档/表格远程修改                                           | 默认`strict`只预览；部署者可显式启用受门禁的`best_effort`    |
| 私有知识库 reader/editor 协作者管理                             | 已验证；默认关闭，需精确白名单及`best_effort`确认            |
| Doc、Sheet 和知识库整对象删除                                   | 个人Host已验证；默认关闭，需显式开关、精确白名单和二次确认   |

服务目前注册36个MCP工具。`yuque_get_capabilities`会返回每个工具的`available`、`preview_only`或`disabled`状态。工具是否“存在”和远程写入是否“已开放”是两件事：创建、修改、权限变更和删除必须同时通过真实捕获、关闭浏览器重放、契约校验、并发检查及写后回读，缺少任一条件都会返回结构化错误。

## 数据安全

- 推荐一名用户运行一个独立实例；不要共享数据目录、Bearer Token 或加密密钥。
- Cookie、CSRF 和账号绑定使用 AES-256-GCM 加密后写入本地数据目录。
- 内置 SQLite 只保存当前实例的待确认变更、加密快照和脱敏审计摘要，不需要 PostgreSQL、MySQL 等外部数据库。
- `MCP_BEARER_TOKEN` 和 `SESSION_ENCRYPTION_KEY` 只保存在本地私密环境文件中，不应提交到 Git、截图或通过聊天发送。
- 远程部署必须使用 HTTPS 或受保护的内网传输；Bearer Token 不能在不可信网络中通过明文 HTTP 发送。
- 非回环`PUBLIC_BASE_URL`默认强制HTTPS；确需私网HTTP时必须由部署者显式接受风险。
- 权限变更和整对象删除默认关闭，并可用精确知识库白名单进一步限制写入范围。
- 写入一致性默认使用`strict`，缺少可靠并发保护时只生成Preview，不发送远程请求。
- `WRITE_KILL_SWITCH=true`可在事故或契约变化时关闭全部远程Confirm。
- 登录完成后临时 Chromium 会话会关闭，日常业务请求不依赖持续运行的可视化浏览器。

## 环境要求

- Node.js 22 或更高版本（推荐当前 LTS）
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
- 就绪检查：`http://127.0.0.1:18080/readyz`
- 指标：`http://127.0.0.1:18080/metrics`（要求同一Bearer Token）
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
- 空间与知识库：`yuque_list_scopes`、`yuque_list_books`、`yuque_get_book`、`yuque_preview_create_book`、`yuque_preview_update_book`
- 协作者：`yuque_list_book_collaborators`、`yuque_preview_change_book_collaborator`；邀请后接收方仍需在语雀确认加入
- 定位与搜索：`yuque_search`、`yuque_get_toc`、`yuque_list_docs`、`yuque_list_all_docs`
- 目录变更：`yuque_preview_change_catalog`；`TITLE`分组支持创建/重命名/移动/空分组删除，Doc/Sheet目录项支持移动
- 文档与表格：`yuque_get_doc`、`yuque_get_sheet`
- 评论：`yuque_list_comments`、`yuque_preview_change_comment`；修改/删除首版仅限当前员工自己的评论
- 变更流程：各类 `yuque_preview_*`、`yuque_confirm_change`、`yuque_cancel_change`
- 快照：`yuque_list_snapshots`、`yuque_preview_restore_snapshot`

回答文档、目录或表格问题时，调用方应先展示完整路径和 URL。同名结果必须列出所有候选，确认目标后再读取或修改。

## 写入一致性

默认配置为：

```text
WRITE_CONSISTENCY_MODE=strict
```

`strict`模式允许读取和Preview，但会在发包前阻止缺少可靠并发保护的远程Confirm。部署者只有在接受语雀网页接口不存在原子CAS的限制后，才可显式设置`best_effort`；该模式仍然受同目标本地串行、语雀临时锁持有者核验、获取锁后二次版本/指纹重读、一次性Change Token、契约`liveWriteEnabled`、加密快照、单次写请求、超时只读对账和写后回读约束，不会绕过未验证接口门禁。已有知识库内的写入还必须命中精确知识库白名单；创建新的私有个人知识库没有预先存在的URL，因此改为绑定当前扫码账号、Confirm前同名检查、单次发包、超时对账和最终URL回读。Doc与Sheet快照都能生成恢复Preview并走相同锁与回读流程。

## Docker

仓库提供 `Dockerfile`、`compose.yaml` 和 `deploy/service.env.example`。部署前复制环境变量示例到宿主机的私密路径，填写随机 Token、加密密钥、公开访问地址和允许的 Host，再启动 Compose。

```bash
docker compose build
docker compose up -d
```

不要把真实环境文件挂回仓库。生产部署应使用只读根文件系统、非 root 用户、独立数据卷和 HTTPS 入口。仓库内的`deploy/chromium-seccomp.json`是登录浏览器的必要安全配置：Compose在`cap_drop=ALL`和`no-new-privileges`基础上仅放行Chromium用户命名空间沙箱所需的`chroot/clone/setns/unshare`系统调用。登录代码不会传入`--no-sandbox`或`--disable-setuid-sandbox`；部署时不得删除该profile、改为`seccomp=unconfined`或自行增加无沙箱参数。

该profile衍生自Playwright `v1.62.1`仓库提交`26a9e470a7b3c7822084b09fb7f13902c5f37b51`的Docker seccomp配置；上游原文件SHA-256为`cc3e61cabda6bbc1e53e54d27ba4d55a9d3be829b6dd1a596f4a7b31b1cc7849`，本项目为适配`cap_drop=ALL`加入无条件`chroot`规则后的文件SHA-256为`b3995c4964bc2e3e7e87f38df281e5ad8cd8bfb76c6b31b65dea159d46cf1fdb`。CI会在完整容器限制下真实启动Chromium；仅做静态配置检查不算通过。

服务支持`YUQUE_MCP_ENV_FILE`、`MCP_BEARER_TOKEN_FILE`与`SESSION_ENCRYPTION_KEY_FILE`，便于使用宿主机私密文件或Docker secrets。外网需要代理时配置`YUQUE_HTTPS_PROXY`；私有CA使用`YUQUE_CA_FILE`。服务明确拒绝`NODE_TLS_REJECT_UNAUTHORIZED=0`，并要求语雀Host为无凭据、无路径的HTTPS Origin；精确写入白名单不得越出已配置的个人或团队语雀Host。

## 一名员工一个实例

`v0.6`提供单机多实例管理命令。员工别名只用于本机查找，索引中仅保存不可逆摘要；实际目录名、Compose项目名、Owner ID、Bearer Token、AES密钥、端口和数据目录彼此独立。

```bash
npm run build

# 根目录必须是绝对路径，镜像必须使用固定版本或digest，禁止latest
export YUQUE_MCP_INSTANCES_ROOT=/srv/yuque-web-mcp
npm run create-instance -- employee-a --port 18101 \
  --public-base-url https://employee-a-mcp.example.com \
  --image registry.example.com/yuque-web-mcp:1.0.0 \
  --bind-address 127.0.0.1

npm run start-instance -- employee-a
npm run status-instance -- employee-a
npm run backup-instance -- employee-a
npm run upgrade-instance -- employee-a \
  --image registry.example.com/yuque-web-mcp:1.0.0
```

`create-instance`返回私密`service.env`的位置。它还会生成仅含非敏感运行UID/GID的私有`.env`，让非root容器与宿主机`data/`保持一致的写权限，并把已校验的Chromium seccomp profile复制到实例目录；缺失、默认放行或未明确允许沙箱所需调用的profile会让创建失败关闭。可用`YUQUE_MCP_CHROMIUM_SECCOMP_PROFILE`指定另一份经过等效审计的绝对路径。不要手工修改或跨实例复制实例文件。通过安全的密钥渠道把`service.env`中的MCP Bearer Token交给对应员工，不要复制整个文件。`backup-instance`包含登录会话和密钥，备份目录必须按机密数据管理。升级会先备份；拉取或启动新镜像失败时会恢复旧Compose并尝试启动旧版本。

每个实例建议只绑定`127.0.0.1`，再由Caddy、Nginx或公司现有网关提供HTTPS。最小Nginx片段如下；公网域名、证书和访问控制由部署方提供：

```nginx
location / {
    proxy_pass http://127.0.0.1:18101;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_buffering off;
    proxy_read_timeout 3600s;
}
```

Hermes Agent、虾塘或其他MCP客户端均使用同一组标准参数：Transport=`Streamable HTTP`，URL=`https://<员工实例域名>/mcp`，Header=`Authorization: Bearer <该员工Token>`。如果智能体平台不能为不同员工配置不同URL或Header，就不能安全共享这些实例。

## 运维命令

```bash
npm run build
export YUQUE_MCP_ENV_FILE=/absolute/private/service.env
npm run admin -- doctor
npm run admin -- backup --output /absolute/private/backups/backup-001
# restore、rotate-token、rotate-key要求先停止服务
```

恢复、密钥轮换、升级和事故处理步骤见[OPERATIONS.md](OPERATIONS.md)。`/healthz`只表示进程存活；反向代理和Compose健康检查应使用`/readyz`。JSON日志仅记录请求ID、路由模板、状态码和耗时，不记录Header、请求体或文档正文。

## Skill 与 Prompt

通用Skill位于[`skills/yuque-workspace`](skills/yuque-workspace/SKILL.md)，负责完整路径消歧、能力检查、Preview/Confirm、删除确认和冲突恢复，不保存任何凭据。可将整个Skill目录安装到支持Skills的智能体中；它仍需要配置本项目的MCP服务。

`prompts/`提供定位读取、安全修改、冲突恢复和工作区维护四个可复用模板。Skill与Prompt都不包含特定公司、账号、Host或Token。

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

部署者可以选择使用只读Soak工具做耐久诊断。它默认每分钟检查健康、就绪、受保护指标、36个工具、能力清单和认证状态；只有显式给出精确知识库URL时才允许增加单篇Doc/Sheet读取。状态文件只保存计数、连续性指标和时间，不保存Token、正文或单元格数据。Soak不是v1.0的强制发布门禁；语雀网页会话失效时，服务会返回`relogin_required`，对应员工重新扫码即可恢复。

```bash
MCP_ENV_FILE=/absolute/private/service.env \
SOAK_STATE_FILE=/absolute/private/soak-state.json \
npm run soak:http
```

可通过`SOAK_DURATION_SECONDS`设置诊断时长；中断的记录只代表实际已运行区间，不得描述为完整耐久测试。

公开仓库不包含内部接口研究记录、真实环境验收材料、账号信息或部署文档。运行所需的契约清单只记录程序必须使用的结构化能力门禁，不包含 Cookie、Token、手机号、验证码、文档正文或原始响应。

## 当前限制

- 使用的是未公开网页接口，前端升级可能导致能力暂时关闭。
- 复杂 Lake 专有块、附件上传、画板、评论中的划词定位/审核语义以及部分高级表格结构仍在规划中。
- 临时锁已验证能阻止另一个账号抢占，但同一语雀账号的第二个锁UUID仍可覆盖第一个，因此它不是原子CAS；这也是`strict`继续作为默认值的原因。

## 许可证与安全

项目使用[Apache-2.0](LICENSE)许可证。部署前请阅读[安全策略](SECURITY.md)与[威胁模型](THREAT_MODEL.md)；贡献接口契约或写能力时遵守[CONTRIBUTING.md](CONTRIBUTING.md)的证据门禁。
