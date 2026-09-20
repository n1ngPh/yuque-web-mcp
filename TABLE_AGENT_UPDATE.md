# Table 功能更新：Agent 接入说明

本次将 Table 单条记录归档集成到主 HTTP `/mcp`，并增加整篇 Table 复制、跨知识库移动和 Excel 原生导出。主服务工具总数从 42 增至 47。代码更新后须由部署方升级并重启服务、让 Agent 重新连接和刷新工具列表，现有远端实例不会因 GitHub 更新而自动升级。

## 新增与扩展的工具

| 能力 | 工具与调用流程 |
| --- | --- |
| 单条记录移动归档 | `yuque_preview_archive_table_record` → `yuque_confirm_change`；创建目标行、写字段并回读成功后，删除源行并再次核对 |
| 归档状态与只读对账 | `yuque_get_table_archive_status`，指定原 `change_token` 与 `reconcile=true` |
| 整篇 Table 复制 | `yuque_preview_copy_table` → `yuque_confirm_change` |
| 整篇 Table 跨知识库移动 | `yuque_preview_move_table` → `yuque_confirm_change` |
| 文档复制/移动状态与只读对账 | `yuque_get_table_transfer_status`，指定原 `change_token` 与 `reconcile=true` |
| Table Excel 导出 | 复用 `yuque_get_export_options` 和 `yuque_create_export_link(format="excel")`，返回原生下载链接 |

归档 Preview 输入 `source_doc_url`、`target_doc_url`、确切的 `record_id`；多工作表时另传对应 sheet ID。Confirm 回传 `change_token`、`diff_digest` 和 `confirm_deletions=true`。复制/移动 Preview 输入 `source_doc_url`、`target_book_url`，可选 `target_parent_uuid`；Confirm 还需 `confirmation_text` 精确匹配 Preview 的 `display_path`，移动需删除确认。

## 让 Agent 按条件归档

先用 `yuque_get_table` 完整分页读取并确定筛选条件和记录 ID。默认每页 100 条，单页最多 5000 条，按 `next_offset` 继续；读取的是底层记录，不应用网页视图筛选、排序或分组。区分 `Table/laketable` 与 `Sheet/lakesheet`，不要把空 `views.data` 当作空表。

用户授权后，对筛选清单逐条执行“重新读取条件 → Preview → Confirm → 立即对账”。每次使用新 Preview，不并发操作同一对表，不预先生成整批令牌后直接确认。若返回 `partial`、`unknown` 或超时，暂停后续操作，用该条原令牌只读对账；不得盲目重试或创建重复归档。完成后整表回读验证数量、目标字段和其他记录。

## 部署与适用范围

1. 更新仓库 `main`，按现有部署流程安装依赖、运行 `npm run check` 并重新构建/重启服务。保留现有运行数据目录、用户会话、Bearer Token 和加密密钥；容器部署须重建或采用包含本次源码的镜像。
2. Agent 重新连接后检查 `tools/list` 是否为 47 个工具且包含上述五个新工具，再用 `yuque_get_capabilities` 核对实际可用性。仅升级提示词不会增加服务能力。
3. 写入由部署者明确启用：`WRITE_CONSISTENCY_MODE=best_effort`、`WRITE_KILL_SWITCH=false`、精确的 `YUQUE_WRITE_BOOK_ALLOWLIST`。复制要求目标知识库在白名单内，移动要求两本均在白名单内；归档要求两表所在知识库在白名单内。默认 `strict` 仅预览，Agent 不应自行更改部署配置。

记录归档限同一知识库的组织 Table，每次一行；支持文本、单选、多选、人员、日期和进度等已验证字段映射。拒绝非空行详情正文、无法映射的选项和不支持的非空字段。整篇复制/移动限同一组织 Host 的不同知识库、无子节点且只有一个工作表的 Table。每表最多 5000 条，归档目标新增前须少于 5000 条。

归档产生新的行 ID 和系统时间；评论与历史不迁移。没有原子跨表事务、整批回滚或自动恢复。完整参数与边界见 [记录归档](TABLE_ARCHIVE.md) 和 [文档复制、移动、导出](TABLE_OPERATIONS.md)。原独立 stdio 实验工具继续保留，新接入优先使用主 HTTP MCP。

## 验证结果

本地主 MCP 已在独立测试副本上完成整篇复制、跨知识库移出再移回、Excel 导出链接生成和单条归档验收；随后又顺序归档 12 条“已完成”记录，全部成功。源副本 46 → 34 条，目标副本 229 → 241 条，映射业务字段匹配，263 条其他副本记录及两张原表记录均未变。测试副本保留，原始 HAR、会话和业务内容不随公开仓库发布。离线测试覆盖字段映射、写入门禁、中断日志、异常不重试和只读对账。
