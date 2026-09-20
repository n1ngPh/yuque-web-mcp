# Table 文档复制、移动和 Excel 导出

这些能力属于主 HTTP `/mcp`（47 个工具），使用调用者自己的语雀会话。当前根据浏览器捕获开放组织 Host 的 `Table/laketable`；普通 Doc 与 LakeSheet 的导出继续使用既有格式清单。整篇 Table 的复制/移动与[单条记录移动归档](TABLE_ARCHIVE.md)是不同操作。

## 复制与跨知识库移动

先用 `yuque_list_docs` / `yuque_get_toc` 定位完整路径和 URL。复制预览：

```json
{
  "name": "yuque_preview_copy_table",
  "arguments": {
    "source_doc_url": "https://team.yuque.com/group/source-book/table",
    "target_book_url": "https://team.yuque.com/group/test-book"
  }
}
```

移动使用同样参数，工具名改为 `yuque_preview_move_table`。目标默认知识库根目录；可用 `target_parent_uuid` 指定 `yuque_get_toc` 返回的现有 `TITLE` 目录节点。只允许同一组织 Host 下两个不同知识库之间的单篇、无子目录节点、单工作表 Table，每表最多 5000 条记录。目标目录有同名对象时拒绝，避免产生无法辨别的副本。

预览返回源/目标完整路径、目标知识库可见性、记录数量和 Diff。向用户核对位置及目标知识库权限范围后，使用现有统一确认工具：

```json
{
  "name": "yuque_confirm_change",
  "arguments": {
    "change_token": "preview-returned-token",
    "diff_digest": "preview-returned-digest",
    "confirmation_text": "preview-returned-display_path",
    "confirm_deletions": true
  }
}
```

`confirmation_text` 必须等于预览返回的 `display_path`。复制不要求 `confirm_deletions`，移动要求它确认原位置将消失。复制产生新文档 ID、行 ID 和系统元数据，保留原文档；移动保留文档 ID，但 URL/知识库发生变化。不会调用整对象删除接口，也不会自动删除测试副本。

配置要求：`WRITE_CONSISTENCY_MODE=best_effort`、`WRITE_KILL_SWITCH=false`。复制只要求目标知识库在 `YUQUE_WRITE_BOOK_ALLOWLIST` 中，源知识库可以只读；移动要求源、目标知识库均精确列入白名单。`YUQUE_WRITE_ORGANIZATION_OPEN` 不会绕过这项检查。`strict` 仍只预览，调用方不应自行调整部署配置。

服务在确认前重新核对表格内容与两本目录，发出一个非幂等请求，然后根据 `meta.docIds` 定位新位置，并回读字段定义、每条业务记录及行详情。字段和选项按 ID 比较，忽略服务端枚举顺序；行记录按内容集合比较，不把复制后新的行 ID、创建人等系统元数据当作业务差异。评论、历史版本、视图展示布局不在完整性保证范围内。

## 异常状态

```json
{
  "name": "yuque_get_table_transfer_status",
  "arguments": {
    "change_token": "original-preview-token",
    "reconcile": true
  }
}
```

不传 `reconcile` 时只读当前用户本地加密日志；设为 `true` 时只读远端目录和已知目标表。若复制响应丢失，目标 ID 尚未知，状态工具会列出目标目录中新出现的候选文档，供人工核对，不自动认定某一篇就是此次副本。

`conflict` 表示首个写请求前校验失败；`unknown` 表示写请求或执行中断的结果不确定；`partial` 表示远端操作可能完成，但内容或位置校验尚未通过。原令牌不可重复执行，不自动重试、回滚或清理。先按状态工具给出的 ID、URL 核查。语雀接口没有已验证的原子跨知识库事务/CAS，本地锁也不能阻止其他账号或网页并发编辑。

## Table Excel 导出

使用 `yuque_get_export_options` 获取格式。组织 Table 当前只开放 `excel`：

```json
{
  "name": "yuque_create_export_link",
  "arguments": {
    "doc_url": "https://team.yuque.com/group/test-book/table",
    "format": "excel"
  }
}
```

服务沿用现有异步导出流程：`type=excel, force=0`，按网页规则轮询 `pending → success`，校验下载 Host、临时 xlsx 路径及参数后返回链接。不会下载或缓存文件，不修改表格内容；链接不写入数据库或普通日志。`browser_login_required=true` 时需在登录同一账号的浏览器中打开。导出能力不意味着能把 Excel 重新导入并完整恢复 Table 的视图、人员权限或历史。

## 测试和交接

真实验收仅对明确识别的测试副本执行移动、导出与记录归档。原文档只作为复制来源和只读核对对象。测试副本应保留，交接时列出最终知识库、完整 URL、文档 ID 和记录数量，由用户手动清理。原始 HAR、会话和业务快照保存在私有目录，公开测试只使用合成数据。


2026-09-20 本地主 MCP 真实验收通过：复制 47 行和 228 行的两张 Table；将 228 行副本跨知识库移出再移回，保持文档 ID 与内容；Excel 导出经过两次请求由 pending 到 success，未下载文件；随后在副本间归档一条含 14 个字段的记录。原表不变，测试副本保留。验收发现并修复了字段/选项枚举顺序变化，以及移动后源目录短暂返回旧状态的问题；后者复用有次数上限的只读目录轮询，不重发移动请求。首次遇到这两类问题的操作历史仍保留 partial，其远端结果经只读对账核实，不伪改历史状态。
