# Table 单条归档实验 MCP

这是可以从本仓库直接运行的独立 **stdio MCP 服务**，用于将自己的一条简单记录归档到同一知识库的另一张 Table。无需 `development/` 目录或作者的本机会话。代码仍属实验性质，不会自动加入主 HTTP `/mcp` 的 42 个工具，也未打包进默认 Docker 镜像。

提供四个工具：

| 工具                     | 行为                                                                   |
| ------------------------ | ---------------------------------------------------------------------- |
| `table_archive_preview`  | 读取两表、校验账号/字段/正文，保存预览，返回 `diff_digest`；无远程写入 |
| `table_archive_stage`    | 按预览复制一条记录到目标表并回读，保留源记录                           |
| `table_archive_finalize` | 再次验证两表，移除原记录，核对其他记录不变                             |
| `table_archive_status`   | 读取本地日志状态；不发网络请求，也不重试写入                           |

归档为“复制后移除”，目标得到新的记录 ID 和创建/修改时间。业务文本、负责人保留，系统时间、原记录 ID、评论和历史不迁移。

## 1. 安装并准备自己的登录会话

在本仓库根目录运行：

```sh
npm ci
npm run build
```

按根目录 README 创建独立本地 profile、启动主服务，并使用主 MCP 的 `yuque_login_begin` / `yuque_login_status` 完成自己的登录。此实验只支持 `HOST=127.0.0.1` 的单用户配置、HTTPS 组织 Host；个人空间、多用户配置、代理和自定义 CA 暂不支持。主服务应使用同一个 env 文件中的 owner 和 bearer token。

先通过主服务的 `yuque_get_table` 查看源表、目标表，选择自己的一个记录 ID，核对内容和负责人。`Table/laketable` 与 `Sheet/lakesheet` 是不同类型。

## 2. 生成私有计划

主服务运行期间，使用只读初始化命令。将路径、URL、记录 ID 和内容换成自己的值：

```sh
npm run archive:init -- \
  --env-file /absolute/profile/local.env \
  --source-url https://team.yuque.com/group/book/source \
  --target-url https://team.yuque.com/group/book/archive \
  --record-id SOURCE_RECORD_ID \
  --expected-text '这条记录的精确文本' \
  --out /absolute/profile/archive-operation-1/plan.json
```

`/absolute/profile` 必须对应 env 的 `DATA_DIR`。每次归档使用独立子目录；计划文件已存在时不会覆盖。该命令调用本地 `/api/call` 获取表和账号信息，不创建、修改或删除语雀记录。目标记录 ID 只生成一次，后续复用。

默认文本列为“具体工作内容”，人员列为“负责人”；其他名称可用 `--text-field` 和 `--owner-field` 指定。多 sheet 表还需指定 `--source-sheet-id` / `--target-sheet-id`。参数帮助：`npm run archive:init -- --help`。

[plan.example.json](plan.example.json) 仅展示结构，全部是虚构数据，不可直接用于真实操作。计划包括真实内容和本地 env 路径，只能保存在私有运行目录，不要提交到 Git。目录权限 0700、计划权限 0600；操作日志和响应以配置的会话密钥加密保存，不输出 Cookie 或 Token。

## 3. 配置 MCP 客户端

将下面独立服务加入支持 stdio 的 MCP 客户端。`command` 使用可用的 Node 22+ 绝对路径，脚本及计划也使用绝对路径，因此不依赖客户端工作目录：

```json
{
  "mcpServers": {
    "yuque-table-archive-experiment": {
      "command": "/absolute/path/to/node",
      "args": [
        "/absolute/yuque-web-mcp/experiments/table-archive/table-archive-mcp.mjs",
        "/absolute/profile/archive-operation-1/plan.json"
      ]
    }
  }
}
```

上述配置默认只允许预览/查看状态。通过 `tools/list` 应看到四个 `table_archive_*` 工具；它们属于这个独立服务，不能直接向原 HTTP `/mcp` 调用同名工具。无需在客户端 JSON 中填写会话密钥或 Token。

## 4. 执行归档

1. 调用 `table_archive_preview`，向用户展示源/目标完整 URL、文本、负责人、记录 ID 和新增系统时间的说明。预览十分钟内有效。
2. 用户授权这一条具体记录的归档后，由配置管理者在专用 profile 中设置 `WRITE_KILL_SWITCH=false`、`WRITE_CONSISTENCY_MODE=best_effort`，并将精确知识库 URL 放入 `YUQUE_WRITE_BOOK_ALLOWLIST`。例如白名单值为 `https://team.yuque.com/group/book`。这些配置也影响共用该 profile 的主服务，修改后按主服务文档重启；不要改动无关部署。
3. 在上面客户端 `args` 最后加入 `--enable-writes` 并重启此 stdio 服务。它仍要求预览和白名单；没有此参数、strict 模式或启用 kill switch 时均禁止写入。服务会在每次写请求前重新读取 env，关闭开关立即生效。
4. 调用 `table_archive_stage`，参数为 `{"diff_digest":"预览返回的摘要"}`。成功后源记录仍保留；通过主 MCP 和网页核对归档副本。
5. 再调用 `table_archive_finalize`，传入同一 `diff_digest`。返回 `succeeded` 后，再用主 `yuque_get_table` 检查源记录消失、目标只新增一条。它不会改变“状态”等其他业务字段来表示归档。

也可直接启动调试：

```sh
node experiments/table-archive/table-archive-mcp.mjs /absolute/profile/archive-operation-1/plan.json --enable-writes
```

启动后等待 MCP 协议输入是正常行为。不要将普通终端文字当成 MCP 请求；需要 MCP 客户端发起 `initialize`、`tools/list`、`tools/call`。

## 限制与中断处理

- 只支持同一知识库的两个不同 Table、每表最多 5000 条记录、有 GRID 视图；字段 ID、名称、类型必须一致。
- 源记录必须由当前账号创建且最后修改；只能有两个非空业务字段：一个文本/input 字段和一个仅包含当前账号的 mention 字段。其他非空字段、选项迁移、附件、非空行详情正文都会拒绝。不要把它当作通用整表或批量迁移工具。
- 每次写入前保存操作阶段，网络超时不自动重试，重复 stage/finalize 被拒绝。进程锁防止同一操作目录的并行执行；不要对同一源记录建立多个计划并行归档。
- `table_archive_status` 可读取中断状态，即使存在遗留锁文件。若停在 `creating_target`、`populating_target`、`removing_source`，或阶段已过期，先用主 MCP 按两个固定记录 ID 对账。不要删除日志/锁、生成新目标 ID 或重复执行以“解决”失败。当前没有自动恢复/回滚工具，应由操作人员完成核对和恢复。
- 原子重命名用于日志保存；上游没有已验证的 CAS 或跨表事务。读取基线与实际写入之间仍有并发窗口。一次成功验证不代表通用并发安全；实际权限由语雀账号控制。
- 该实验有独立的有限写入适配器，没有注册到主服务的写协议清单，也不使用主服务的 `yuque_confirm_change` 或快照恢复工具。正式整合这些能力仍是后续工作。

## 验证

```sh
npm run build
npm run test:archive
```

`npm run check` 也包含实验测试，CI 将在 Node 22/24 上执行。自动测试全部使用虚构数据和模拟请求，不访问语雀。

原研究版于 2026-09-18 在授权单条记录上完成真实 MCP 归档和 HTTP MCP 回读，核对其他 275 条记录不变。此公开版在该实现基础上改为标准依赖、提供初始化命令，并增加配置与写入开关校验；公开打包改动使用离线测试验证，没有为发布再操作真实用户数据。
