# Table 筛选、精简输出和聚合统计

主 HTTP MCP 当前有 49 个工具。新增 `yuque_get_table_stats`，并给 `yuque_get_table` 增加可选的 `filter`、`columns`、`raw`。不传新参数时，保留原始字段、原始值、默认每页 100 条和既有分页语义；归档内部也继续使用完整读取及指纹校验。

## 只读取需要的任务字段

```json
{
  "name": "yuque_get_table",
  "arguments": {
    "doc_url": "https://team.yuque.com/group/book/table",
    "filter": {"负责人": {"id": "12345"}, "状态": "已完成", "进度": 100},
    "columns": ["具体工作内容", "状态", "进度"],
    "raw": false,
    "limit": 20
  }
}
```

- 列可用精确 ID 或唯一名称指定；同名列请用 ID，未知/歧义列报错。
- `filter` 各字段为 AND。标量精确匹配显示值，多人员/多选匹配包含关系；`{"id":"12345"}` 匹配人员账号或选项 ID。人员优先使用账号 ID，姓名匹配可能包含同名账号。进度按数值比较，兼容 `100`、`"100.0"`、`"100%"`；`null` 匹配 null 或空数组。
- `columns` 只投影对外输出，不影响筛选和底层完整解析；优化模式仅返回选中列的 id/name/type，不重复输出选项字典和全部工作表结构。`raw=false` 去掉 cell.value，保留 column_id/display_value 及行 ID。
- 有 `filter` 时先完整扫描，再按匹配集合的 offset/limit 分页。返回 `total`（源表总行数）、`matched_total`、`scan_complete` 和 `pagination_basis=filtered_records`。没有 filter 的投影/精简读取仍按源记录分页。
- 始终使用实际返回的 `next_offset`，不要自行加请求的 limit。每次续读必须保持筛选和投影参数相同；最后一页 has_more=false、next_offset=null。complete 表示本次从零偏移返回完结果，scan_complete 表示筛选扫描已完成，两者含义不同。

## 聚合统计

```json
{
  "name": "yuque_get_table_stats",
  "arguments": {
    "doc_url": "https://team.yuque.com/group/book/table",
    "group_by": ["状态", "负责人", "项目大类"],
    "filter": {"进度": 100}
  }
}
```

`group_by` 为 1–10 个字段，分别统计独立分布，并非组合交叉分组。返回 total、matched_total 和 distributions 数组，不返回 records。每项含 column_id、column_name 和 buckets；每个 bucket 是 `{value, label, count}`。人员以账号 ID 区分，即使同名也不合并；单选/多选以选项 ID 区分。多人、多选按成员计数，同一行同一成员只计一次，故各分组 count 之和可能超过 matched_total；空值归入 null。

每字段最多返回频次最高的 100 个 bucket，另返回 distinct_count、truncated、omitted_memberships（省略 bucket 的成员计数之和）。不要把截断分布当作完整分布；高基数字段并不保证小输出。

## 大小、扫描和一致性边界

显式使用任一新参数的读取，以及统计工具，按序列化后的 MCP 文本内容封装限制为 40 KiB，计入格式化和转义开销。若多行输出过大，减少返回行数，设置 output_limited=true 并给出正确 next_offset；不截断单元格文本。单条记录、结构或统计分布仍超限时明确报错，应减少列/分组或缩小范围。该预算不包含客户端自身额外包装；不能保证任意终端展示方式绝不截断。旧全量读取需直接写入私有文件再做本地计算，不要把大 JSON 整段打印到终端。

筛选/统计每次重新扫描，不缓存业务数据。扫描每页最多 500 行，总计最多 5000 行、20 MiB 解析后行数据，并在每次请求前后检查 30 秒预算；单次网络请求仍使用实例请求超时，所以不是精确的端到端 30 秒截止时间。重复记录、分页无进展或超限会失败，不返回伪装成全量的局部统计。多工作表需先按 selection_required 选择 sheet_id。

网页筛选、排序和分组仍不应用。分页扫描不是原子快照，返回 snapshot_consistent=false；扫描期间或续读之间发生增删可能影响结果。用于写入的归档流程仍须重新读取、Preview/Confirm 和回读验证，不能把筛选统计当作删除授权。

当前验证使用合成 HTTP 上游与本地测试，覆盖跨页扫描、筛选后分页、投影、人员同名、数值进度、空匹配、分组截断、大小限制及 5000 行上限。未把历史真实表的行数和姓名写入公开测试。
