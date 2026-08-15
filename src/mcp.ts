import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { randomUUID } from "node:crypto";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { AppDatabase } from "./db.js";
import type { SessionStore } from "./session-store.js";
import { parseLoginProvider, type LoginManager } from "./login-manager.js";
import type { YuqueWebClient } from "./yuque-client.js";
import type { ChangeStore } from "./change-store.js";
import { readSheetRange } from "./sheet-model.js";
import {
  VERIFIED_PERSONAL_SHEET_CHART_DISPLAY_CONFIG_PATHS,
  VERIFIED_PERSONAL_SHEET_CHART_DISPLAY_CONFIG_TYPES,
  VERIFIED_PERSONAL_SHEET_CHART_LAYOUT_INDEXES,
  VERIFIED_PERSONAL_SHEET_CHART_THEME_INDEXES,
  VERIFIED_PERSONAL_SHEET_CHART_TYPES,
  VERIFIED_PERSONAL_SHEET_CHART_PREVIEW_OPERATIONS,
} from "./sheet-chart.js";
import { VERIFIED_SHEET_FUNCTIONS } from "./sheet-formula.js";
import { proprietaryBlockTypes } from "./lake-document.js";
import {
  buildCapabilityReport,
  capabilityToolNames,
} from "./capability-registry.js";
import type { AppConfig } from "./config.js";
import type { ContractRegistry } from "./contracts.js";
import { toSafeToolError } from "./tool-error.js";

export interface McpDependencies {
  config: AppConfig;
  contracts: ContractRegistry;
  db: AppDatabase;
  sessions: SessionStore;
  login: LoginManager;
  client: YuqueWebClient;
  changes: ChangeStore;
}

type JsonSchema = {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties: false;
};

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

export const MCP_INSTRUCTIONS = `语雀网页会话 MCP（安全自托管版）。
能力发现规则：任何工作流开始前优先调用 yuque_get_capabilities。availability=disabled 的能力不得尝试；preview_only 只允许生成本地Diff，不代表可以远程Confirm。WRITE_CONSISTENCY_MODE默认strict，缺少可靠并发保护时远程Confirm会在发包前失败关闭；只有部署者显式启用best_effort且目标命中精确知识库白名单时才允许进入已验证写契约。
个人/空间作用域规则：先调用 yuque_list_scopes 发现当前员工可用作用域。读取个人空间时给列表或索引工具显式传 scope_id=personal；读取公司空间时传 scope_id=organization 或返回的 organization:<id>。给定完整知识库或文档URL的工具会自动识别Host和作用域。不得调用或猜测网页全局“切换空间”接口，因为并发会话之间不能共享可变上下文。
强制路径提示规则：用户询问任何文档或目录时，回答正文、摘要或目录内容之前，必须先输出“完整路径：<个人：姓名或空间：组织 / 知识库名 / 目录层级 / 文档名>”和对应URL。不得只报标题。若同名结果位于不同路径，必须列出每个候选的完整路径和URL并让用户确认，未确认前不得自行选择。
删除边界规则：Doc、Sheet和个人知识库整对象删除工具存在，但默认关闭；只有部署者显式开启、目标命中精确知识库白名单且专用个人Host契约完成真实捕获、关闭浏览器重放和删除后对账时才生成Preview。Preview必须展示完整路径和不可恢复影响；Confirm除diff_digest及confirm_deletions=true外还必须原样提交完整路径confirmation_text。非空知识库还必须在Preview显式allow_nonempty=true。DELETE方法本身不等于资源删除，例如DELETE /lock仅释放临时协作锁。
当前已真实验证并允许调用的能力：登录状态、绑定用户、个人/公司作用域发现、个人/公司知识库、目录、全局文档位置、Doc纯文本读取、企业/知识库全文搜索、Markdown转Lake、LakeSheet值/公式/已支持基础格式范围读取、多工作表与空工作簿读取，以及本地退出。个人空间的全局全文搜索尚未验证，必须提供个人 book_url 做知识库范围搜索。Sheet Preview中的公式缓存值由服务自行计算，当前只支持四则运算和SUM/AVERAGE/MIN/MAX/COUNT/COUNTA/IF/AND/OR/NOT/COUNTIF/SUMIF/COUNTIFS/SUMIFS/AVERAGEIF/AVERAGEIFS/COUNTBLANK/LARGE/SMALL/STDEVP/VARP/STDEVS/VARS/ISBLANK/ISNUMBER/ISTEXT/ISLOGICAL/ISEVEN/ISODD/ABS/ROUND/CEILING/FLOOR/SUMPRODUCT/CHOOSE/RANK/SIGN/PI/EXP/LN/LOG/LOG10/TRUNC/MROUND/QUOTIENT/SIN/COS/TAN/DEGREES/RADIANS/FACT/GCD/LCM/COMBIN/SUMSQ/CONCAT/CONCATENATE/LEFT/RIGHT/MID/LEN/LOWER/UPPER/TRIM/FIND/SEARCH/SUBSTITUTE/REPLACE/REPT/EXACT/ROUNDUP/ROUNDDOWN/INT/MOD/SQRT/POWER/PRODUCT/MEDIAN/VLOOKUP/HLOOKUP/MATCH/INDEX；其中STDEVP/VARP只接受至少1个数值的单一范围，STDEVS/VARS只接受至少2个数值的单一范围，非数值格忽略；VLOOKUP/HLOOKUP/MATCH只允许已验证的精确匹配模式，RANK只允许降序模式0，CEILING/FLOOR只允许非负值和正步长，SUMPRODUCT只允许两个等维纯数值范围，CHOOSE只允许标量候选，LOG和TRUNC只允许已验证的两参数形式，MROUND只允许非负数和正倍数，LN/LOG10拒绝非正数，QUOTIENT拒绝零除数，FACT与COMBIN只接受0至170的安全整数范围，GCD/LCM只接受非负安全整数且LCM拒绝超出安全整数的结果，SUMSQ只接受标量参数，FIND/SEARCH只允许带明确起始位置的三参数形式，SUBSTITUTE只允许三参数全量替换，SUBSTITUTE/REPLACE/REPT结果最多10,000字符，多条件函数要求范围维度一致且拒绝通配符。调用方提交的formula.value会被忽略，普通单元格变化会重算同表既有公式并进入Diff，未知函数和循环引用会拒绝。固定包不支持MAXIFS/MINIFS，NOW/TODAY/RAND等易变函数也保持关闭，不能猜测开放。个人测试表已验证column/stackColumn/bar/stackBar/line/smoothLine/pie/ring八类图表的类型字段写入、回读与完整恢复；其中column还验证了6套主题、6套布局以及边框、隐藏/空数据展示、网格线、Y轴格式化及前后缀、标题/轴标题、图例、数据标签、X轴标签与旋转、Y轴上下限等21个显示配置路径。个人Host现在允许通过yuque_preview_update_sheet生成严格白名单图表Diff：create_column_chart仅限无其他内容或vessel的单工作表A1:B3六个简单单元格结构，set_chart_type支持八类已验证类型，update_column_chart_display仅限column及已验证字段，delete_chart仅限完成网页捕获、关闭浏览器重放和精确恢复的同形态单柱状图；删除Preview必须展示图表类型、来源范围和工作表并要求confirm_deletions=true。所有图表Preview只本地编解码且可取消，不发送远程写请求。原始vessels/chartConfigs永不接受或输出，图表Confirm仍关闭。Lake转Markdown、通用Doc创建/更新和所有Sheet远程写入尚未完成完整契约验证，会安全失败；禁止猜测接口或绕过门禁。
推荐读取流程：先调用 yuque_auth_status；未登录时依次调用 yuque_login_begin 和 yuque_login_status。然后调用 yuque_list_scopes 并选择显式 scope_id。查找文档优先调用 yuque_list_all_docs，使用 query 按标题、知识库、完整目录路径或 URL 过滤，并用 offset/limit 分页；只在明确需要单个知识库目录时调用 yuque_get_toc 或 yuque_list_docs。定位目标后，把返回的完整 url 作为 doc_url 调用 yuque_get_doc。
yuque_list_all_docs 只返回位置索引，不返回正文；不要试图一次读取所有文档正文。其索引缓存五分钟，只有必须获取最新目录时才设置 force_refresh=true。yuque_get_doc 返回 plain_text 正文以及 version、updated_at、fingerprint 等元数据。
“全部文档”仅指当前员工语雀权限范围内的可见文档，服务不会也不能绕过语雀权限。当前实例只绑定一名员工；多名员工必须使用不同实例、Bearer Token、语雀登录态和数据卷，不得共享。
所有写入必须preview后使用统一yuque_confirm_change；confirm必须回传diff_digest。若工具返回登录过期或relogin_required，仅让当前员工重新执行自己的扫码登录；若返回契约不匹配、结果unknown或endpoint未验证，不要重试写入或改用猜测请求。`;

const emptySchema: JsonSchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
};
const stringProperty = (description: string) => ({
  type: "string",
  description,
});
const integerProperty = (
  description: string,
  defaultValue: number,
  maximum: number,
) => ({
  type: "integer",
  description,
  minimum: 1,
  maximum,
  default: defaultValue,
});
const nonNegativeIntegerProperty = (
  description: string,
  defaultValue: number,
) => ({
  type: "integer",
  description,
  minimum: 0,
  default: defaultValue,
});
const booleanProperty = (description: string, defaultValue: boolean) => ({
  type: "boolean",
  description,
  default: defaultValue,
});
const scopeIdProperty = () => ({
  type: "string",
  description:
    "Explicit scope returned by yuque_list_scopes: personal, organization or organization:<numeric-id>.",
  pattern: "^(personal|organization|organization:[1-9][0-9]*)$",
  default: "organization",
});

export const toolDefinitions: ToolDefinition[] = [
  {
    name: "yuque_get_capabilities",
    description:
      "返回当前服务版本、契约版本、strict/best_effort写入模式，以及每个MCP工具的available/preview_only/disabled状态。该工具不访问语雀，也不返回Host、Token或账号信息。",
    inputSchema: emptySchema,
  },
  {
    name: "yuque_auth_status",
    description:
      "检查当前员工独立的语雀登录态。任何文档操作前优先调用；connected=false 或 relogin_required=true 时启动扫码登录。",
    inputSchema: emptySchema,
  },
  {
    name: "yuque_login_begin",
    description:
      "为当前员工启动隔离的一次性扫码登录，返回 login_id、临时登录页和官方扫码页面截图。provider支持dingtalk、wechat、alipay，默认dingtalk；不提供密码、短信验证码或滑块绕过。之后用 yuque_login_status 轮询。",
    inputSchema: {
      type: "object",
      properties: {
        provider: {
          type: "string",
          enum: ["dingtalk", "wechat", "alipay"],
          default: "dingtalk",
          description: "Official QR provider: dingtalk, wechat or alipay.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "yuque_login_status",
    description:
      "查询当前员工的一次扫码登录流程。成功后浏览器会关闭，后续文档请求使用加密保存的独立网页会话。",
    inputSchema: {
      type: "object",
      properties: {
        login_id: stringProperty("Login ID returned by yuque_login_begin."),
      },
      required: ["login_id"],
      additionalProperties: false,
    },
  },
  {
    name: "yuque_logout",
    description:
      "安全清除且仅清除当前员工在本MCP中的加密Cookie Jar和文档索引缓存；不调用未验证的远端退出接口。",
    inputSchema: emptySchema,
  },
  {
    name: "yuque_get_user",
    description:
      "返回扫码登录时已验证并加密绑定的当前员工语雀账号摘要；不调用已知404的猜测接口。",
    inputSchema: emptySchema,
  },
  {
    name: "yuque_list_scopes",
    description:
      "发现当前员工可读取的个人与公司空间，返回稳定scope_id、完整路径前缀和Host。只读，不修改语雀网页的全局当前空间。之后把scope_id显式传给知识库、全部文档或搜索工具。",
    inputSchema: emptySchema,
  },
  {
    name: "yuque_list_books",
    description:
      "按显式scope_id列出当前员工可见的个人或公司知识库。向用户展示时必须先输出“完整路径：<个人/空间前缀 / 知识库名>”及URL。服务内部分页拉全后本地过滤 keyword；不是正文搜索。",
    inputSchema: {
      type: "object",
      properties: {
        scope_id: scopeIdProperty(),
        keyword: stringProperty("Optional knowledge-base filter."),
        limit: integerProperty("Maximum result count.", 20, 100),
      },
      additionalProperties: false,
    },
  },
  {
    name: "yuque_get_book",
    description:
      "读取一个已定位知识库的完整路径、URL、所有者、访问类型和已验证元数据。book_url必须是完整个人知识库URL；回答前先展示完整路径和URL。",
    inputSchema: {
      type: "object",
      properties: { book_url: stringProperty("Yuque knowledge-base URL.") },
      required: ["book_url"],
      additionalProperties: false,
    },
  },
  {
    name: "yuque_list_book_collaborators",
    description:
      "列出私有个人知识库中经验证的reader/editor协作者。接口未完成真实捕获和无浏览器重放时安全失败，不猜测手机号、邮箱或权限字段。",
    inputSchema: {
      type: "object",
      properties: { book_url: stringProperty("Personal knowledge-base URL.") },
      required: ["book_url"],
      additionalProperties: false,
    },
  },
  {
    name: "yuque_search",
    description:
      "使用已验证的语雀服务端全文搜索。scope_id=organization且无book_url时搜索公司空间；个人空间必须提供完整个人book_url，只搜索该知识库。结果中的同名项必须先展示完整路径和URL再继续读取；若只需按标题或路径定位，也可使用yuque_list_all_docs.query。",
    inputSchema: {
      type: "object",
      properties: {
        scope_id: scopeIdProperty(),
        query: stringProperty("Search text."),
        book_url: stringProperty("Optional Yuque knowledge-base URL."),
        limit: integerProperty("Maximum result count.", 20, 100),
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "yuque_get_toc",
    description:
      "读取一个可见知识库的完整目录节点。每个节点返回 fullPath/displayPath；向用户展示任何目录前，必须先输出知识库名起始的完整路径和URL，不能只报末级目录名。book_url 必须是完整知识库URL。",
    inputSchema: {
      type: "object",
      properties: { book_url: stringProperty("Yuque knowledge-base URL.") },
      required: ["book_url"],
      additionalProperties: false,
    },
  },
  {
    name: "yuque_list_docs",
    description:
      "通过已验证目录接口列出指定知识库中的文档；position.displayPath 是知识库名起始的完整路径。回答前必须先展示完整路径和URL；同名文档必须逐个列出路径并请用户确认。结果最多 limit 条。",
    inputSchema: {
      type: "object",
      properties: {
        book_url: stringProperty("Yuque knowledge-base URL."),
        limit: integerProperty("Maximum result count.", 50, 100),
      },
      required: ["book_url"],
      additionalProperties: false,
    },
  },
  {
    name: "yuque_list_all_docs",
    description:
      "在显式scope_id内跨所有可见知识库建立文档位置索引；position.displayPath 从“个人：姓名”或“空间：组织”开始。回答任何文档/目录问题前必须先展示完整路径和URL；同名候选须全部列出并等待确认。只返回位置不返回正文，使用offset+limit分页。",
    inputSchema: {
      type: "object",
      properties: {
        scope_id: scopeIdProperty(),
        query: stringProperty(
          "Optional case-insensitive filter over document title, path and URL.",
        ),
        offset: nonNegativeIntegerProperty("Zero-based result offset.", 0),
        limit: integerProperty("Maximum result count per page.", 50, 200),
        force_refresh: booleanProperty(
          "Refresh the five-minute document index cache.",
          false,
        ),
      },
      additionalProperties: false,
    },
  },
  {
    name: "yuque_get_doc",
    description:
      "读取一篇已定位文档的纯文本正文，并返回 display_path/full_path。向用户输出正文或摘要前，第一项必须先写完整路径和URL，不能只报标题。doc_url 必须是完整文档URL；禁止批量拉取全部正文。",
    inputSchema: {
      type: "object",
      properties: {
        doc_url: stringProperty("Full Yuque document URL."),
        cursor: nonNegativeIntegerProperty(
          "Character cursor for large documents.",
          0,
        ),
        max_chars: integerProperty(
          "Maximum characters returned per page.",
          20000,
          50000,
        ),
      },
      required: ["doc_url"],
      additionalProperties: false,
    },
  },
  {
    name: "yuque_get_sheet",
    description:
      "按工作表和A1范围读取独立Sheet/lakesheet的类型化值、公式、已验证基础格式和只读图表摘要；返回完整路径、URL、draft_version和语义指纹。单次最多10,000格。已支持数字格式、粗体/斜体、文字色、填充色和水平对齐；个人Host已验证column/stackColumn/bar/stackBar/line/smoothLine/pie/ring的类型识别，但图表只读、不支持编辑；未知格式进入unsupported_features，不猜测。",
    inputSchema: {
      type: "object",
      properties: {
        doc_url: stringProperty("Full Yuque Sheet URL."),
        worksheet_id: stringProperty("Optional verified worksheet identifier."),
        range: stringProperty("Optional A1 range; maximum 10,000 cells."),
        include_formulas: booleanProperty(
          "Include formulas when verified.",
          true,
        ),
        include_styles: booleanProperty(
          "Include supported basic styles.",
          true,
        ),
      },
      required: ["doc_url"],
      additionalProperties: false,
    },
  },
  {
    name: "yuque_preview_create_book",
    description:
      "预览创建私有个人知识库。只创建到当前扫码账号的个人空间，不创建组织知识库；Confirm前会再次检查同名对象。语雀在确认时生成最终slug，写后回读成功才返回最终URL。",
    inputSchema: {
      type: "object",
      properties: {
        name: stringProperty("Private personal knowledge-base name."),
        description: stringProperty("Optional knowledge-base description."),
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    name: "yuque_preview_update_book",
    description:
      "预览修改个人知识库名称或描述；不修改公开性、所有者或组织归属。目标必须命中精确写入白名单。",
    inputSchema: {
      type: "object",
      properties: {
        book_url: stringProperty("Personal knowledge-base URL."),
        name: stringProperty("Optional new name."),
        description: stringProperty("Optional new description."),
      },
      required: ["book_url"],
      additionalProperties: false,
    },
  },
  {
    name: "yuque_preview_change_book_collaborator",
    description:
      "预览邀请、切换reader/editor角色或移除一个私有知识库协作者。权限变更默认关闭；remove必须在Diff中展示登录名和当前角色。",
    inputSchema: {
      type: "object",
      properties: {
        book_url: stringProperty("Personal knowledge-base URL."),
        action: {
          type: "string",
          enum: ["invite", "change_role", "remove"],
          description: "Permission change action.",
        },
        collaborator_login: stringProperty("Exact Yuque collaborator login."),
        role: {
          type: "string",
          enum: ["reader", "editor"],
          description: "Required for invite/change_role; omitted for remove.",
        },
      },
      required: ["book_url", "action", "collaborator_login"],
      additionalProperties: false,
    },
  },
  {
    name: "yuque_preview_delete_doc",
    description:
      "预览删除整篇普通Doc。默认关闭；必须命中个人Host白名单并完成专用删除契约验证。Preview保存加密快照并返回完整路径确认文字。",
    inputSchema: {
      type: "object",
      properties: { doc_url: stringProperty("Full Yuque Doc URL.") },
      required: ["doc_url"],
      additionalProperties: false,
    },
  },
  {
    name: "yuque_preview_delete_sheet",
    description:
      "预览删除整份独立Sheet。默认关闭；必须命中个人Host白名单并完成Sheet类型校验和专用删除契约验证。",
    inputSchema: {
      type: "object",
      properties: { doc_url: stringProperty("Full Yuque Sheet URL.") },
      required: ["doc_url"],
      additionalProperties: false,
    },
  },
  {
    name: "yuque_preview_delete_book",
    description:
      "预览删除整个个人知识库。默认关闭且不可由本地快照完整恢复；非空知识库必须显式allow_nonempty=true。",
    inputSchema: {
      type: "object",
      properties: {
        book_url: stringProperty("Personal knowledge-base URL."),
        allow_nonempty: booleanProperty(
          "True only after reviewing the catalog of a non-empty book.",
          false,
        ),
      },
      required: ["book_url"],
      additionalProperties: false,
    },
  },
  {
    name: "yuque_preview_create_doc",
    description:
      "预览在指定知识库目录创建Doc；必须提供父目录UUID和预期完整路径。转换、创建和挂目录契约全部验证前安全失败。",
    inputSchema: {
      type: "object",
      properties: {
        book_url: stringProperty("Target Yuque knowledge-base URL."),
        parent_uuid: stringProperty(
          "Catalog parent UUID returned by yuque_get_toc.",
        ),
        parent_display_path: stringProperty(
          "Expected full parent directory path.",
        ),
        title: stringProperty("Document title."),
        markdown: stringProperty("Proposed Markdown body, maximum 1 MiB."),
      },
      required: [
        "book_url",
        "parent_uuid",
        "parent_display_path",
        "title",
        "markdown",
      ],
      additionalProperties: false,
    },
  },
  {
    name: "yuque_preview_update_doc",
    description:
      "生成Doc安全Diff，支持append、replace_section、delete_section和rename。delete_section删除完整命名章节并强制二次确认；含专有块时拒绝删除。首版不开放整篇替换。只预览不写入。",
    inputSchema: {
      type: "object",
      properties: {
        doc_url: stringProperty("Full Yuque document URL."),
        mode: {
          type: "string",
          enum: ["append", "replace_section", "delete_section", "rename"],
          default: "append",
          description: "Safe update mode.",
        },
        section_heading: stringProperty(
          "Exact unique heading for replace_section or delete_section.",
        ),
        markdown: stringProperty(
          "Markdown fragment required by append/replace_section; omit for delete_section/rename.",
        ),
        new_title: stringProperty("Optional new document title."),
      },
      required: ["doc_url", "mode"],
      additionalProperties: false,
    },
  },
  {
    name: "yuque_preview_create_sheet",
    description:
      "预览创建独立LakeSheet；真实创建、目录挂载、工作簿数据和版本契约全部验证前安全失败。禁止通过Doc接口猜测创建。",
    inputSchema: {
      type: "object",
      properties: {
        book_url: stringProperty("Target knowledge-base URL."),
        parent_uuid: stringProperty("Catalog parent UUID."),
        parent_display_path: stringProperty("Expected full parent path."),
        title: stringProperty("Sheet title."),
        worksheets: {
          type: "array",
          description:
            "Initial worksheets with values, formulas and supported styles. Formula cached values are ignored and recalculated for the verified arithmetic and verified_formula_functions subset returned by yuque_get_sheet.",
          items: { type: "object" },
        },
      },
      required: [
        "book_url",
        "parent_uuid",
        "parent_display_path",
        "title",
        "worksheets",
      ],
      additionalProperties: false,
    },
  },
  {
    name: "yuque_preview_update_sheet",
    description:
      "预览Sheet的set_range、append_rows、add_worksheet、已验证空且无引用工作表上的rename_worksheet，以及受限delete_rows/delete_columns/delete_worksheet操作；个人Host还支持严格白名单图表Preview：create_column_chart、set_chart_type、update_column_chart_display、delete_chart。重命名一次只能提交一个，名称须符合语雀规则；非空或被公式/图表引用的工作表失败关闭。图表操作一次只能提交一个，不能与单元格操作混合，不接受原始vessels或chartConfigs；delete_chart进入删除Diff并强制二次确认。所有图表操作只在本地编码、解码和生成Diff，图表Confirm保持关闭。单元格和结构删除均进入Diff并强制二次确认。结构删除当前只允许一次删除第11行(start_row=11,count=1)、第11列(start_column=11,count=1)，或无任何引用/结构的空工作表；含数据、公式、图表、合并、筛选、保护规则或未知字段时失败关闭。公式只允许已验证函数，缓存value由服务重算。真实写Confirm仍受原子并发门禁。",
    inputSchema: {
      type: "object",
      properties: {
        doc_url: stringProperty("Full Yuque Sheet URL."),
        operations: {
          type: "array",
          minItems: 1,
          description:
            "Validated Sheet operations; maximum 10,000 affected cells. Chart Preview accepts exactly one of create_column_chart/set_chart_type/update_column_chart_display/delete_chart and no raw config. Formula cells may omit value because caller-supplied cached results are ignored.",
          items: { type: "object" },
        },
      },
      required: ["doc_url", "operations"],
      additionalProperties: false,
    },
  },
  {
    name: "yuque_confirm_change",
    description:
      "执行同一员工10分钟内的一次性preview。必须原样回传diff_digest；包含删除时先向用户展示Diff并明确确认，再设置confirm_deletions=true。结果unknown时严禁重试。",
    inputSchema: {
      type: "object",
      properties: {
        change_token: stringProperty("One-time token returned by preview."),
        diff_digest: stringProperty("Exact digest returned by preview."),
        confirm_deletions: booleanProperty(
          "True only after explicit user confirmation of shown deletions.",
          false,
        ),
        confirmation_text: stringProperty(
          "Exact full path returned by an object-deletion preview.",
        ),
      },
      required: ["change_token", "diff_digest"],
      additionalProperties: false,
    },
  },
  {
    name: "yuque_cancel_change",
    description:
      "取消当前员工的待确认 change_token；只影响本服务的临时变更，不修改语雀文档。",
    inputSchema: changeTokenSchema(),
  },
  {
    name: "yuque_list_snapshots",
    description:
      "列出当前员工最近7天的加密写前快照元数据，不返回快照正文。可用target_url筛选，不能访问其他员工快照。",
    inputSchema: {
      type: "object",
      properties: {
        target_url: stringProperty("Optional exact document or Sheet URL."),
      },
      additionalProperties: false,
    },
  },
  {
    name: "yuque_preview_restore_snapshot",
    description:
      "将当前员工的快照与服务器当前版本生成恢复Diff，不直接写入；恢复仍使用yuque_confirm_change并遵守删除确认和版本冲突保护。",
    inputSchema: {
      type: "object",
      properties: {
        snapshot_id: stringProperty(
          "Snapshot ID returned by yuque_list_snapshots.",
        ),
      },
      required: ["snapshot_id"],
      additionalProperties: false,
    },
  },
];

export function createMcpServer(
  employeeId: string,
  deps: McpDependencies,
): Server {
  const server = new Server(
    { name: "yuque-web-mcp", version: "0.3.1" },
    { capabilities: { tools: {} }, instructions: MCP_INSTRUCTIONS },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: toolDefinitions,
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const requestId = randomUUID();
    try {
      const args = asObject(request.params.arguments);
      const result = await callTool(
        employeeId,
        request.params.name,
        args,
        deps,
      );
      if (result && typeof result === "object" && "image" in result) {
        const image = (result as { image: Buffer; data: unknown }).image;
        const data = (result as { image: Buffer; data: unknown }).data;
        return {
          content: [
            { type: "text", text: JSON.stringify(data, null, 2) },
            {
              type: "image",
              data: image.toString("base64"),
              mimeType: "image/png",
            },
          ],
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify(toSafeToolError(error, requestId)),
          },
        ],
      };
    }
  });

  return server;
}

async function callTool(
  employeeId: string,
  name: string,
  args: Record<string, unknown>,
  deps: McpDependencies,
): Promise<unknown> {
  switch (name) {
    case "yuque_auth_status": {
      const session = await deps.sessions.load(employeeId);
      return {
        connected: Boolean(session),
        owner_id: employeeId,
        ...(session?.account.login
          ? { yuque_login: session.account.login }
          : {}),
        ...(session?.account.name ? { yuque_name: session.account.name } : {}),
        relogin_required: !session,
      };
    }
    case "yuque_get_capabilities":
      return buildCapabilityReport(deps.config, deps.contracts);
    case "yuque_login_begin": {
      const providerValue = optionalString(args, "provider") ?? "dingtalk";
      const provider = parseLoginProvider(providerValue);
      if (!provider)
        throw new Error("provider must be dingtalk, wechat or alipay");
      const result = await deps.login.begin(employeeId, provider);
      return {
        data: {
          ...result.status,
          login_url: result.loginUrl,
          provider: result.provider,
        },
        ...(result.screenshot ? { image: result.screenshot } : {}),
      };
    }
    case "yuque_login_status":
      return deps.login.status(employeeId, requireString(args, "login_id"));
    case "yuque_logout":
      await deps.login.cancelEmployee(employeeId);
      await deps.client.logout(employeeId);
      return { status: "logged_out" };
    case "yuque_get_user":
      return localUser(employeeId, deps);
    case "yuque_list_scopes":
      return deps.client.listScopes(employeeId);
    case "yuque_list_books":
      return deps.client.listBooks(
        employeeId,
        optionalString(args, "keyword"),
        optionalInt(args, "limit", 20),
        optionalScopeId(args),
      );
    case "yuque_get_book":
      return deps.client.getBook(employeeId, requireString(args, "book_url"));
    case "yuque_list_book_collaborators":
      return deps.client.listBookCollaborators(
        employeeId,
        requireString(args, "book_url"),
      );
    case "yuque_search":
      return deps.client.search(
        employeeId,
        requireString(args, "query"),
        optionalString(args, "book_url"),
        optionalInt(args, "limit", 20),
        optionalScopeId(args),
      );
    case "yuque_get_toc":
      return deps.client.getToc(employeeId, requireString(args, "book_url"));
    case "yuque_list_docs":
      return deps.client.listDocs(
        employeeId,
        requireString(args, "book_url"),
        optionalInt(args, "limit", 50),
      );
    case "yuque_list_all_docs": {
      const documents = await deps.client.listAllDocs(
        employeeId,
        optionalBoolean(args, "force_refresh", false),
        optionalScopeId(args),
      );
      const query = optionalString(args, "query")?.trim().toLocaleLowerCase();
      const filtered = query
        ? documents.filter((document) =>
            [
              document.title,
              document.url,
              document.bookName,
              document.position.path.join(" / "),
            ].some((value) => value.toLocaleLowerCase().includes(query)),
          )
        : documents;
      const offset = optionalNonNegativeInt(args, "offset", 0);
      const limit = optionalInt(args, "limit", 50);
      return {
        response_rule:
          "在展示任何匹配结果前，先输出每项的 position.displayPath 和 url；同名不同路径时列出全部候选并等待用户确认。",
        total: filtered.length,
        offset,
        limit,
        items: filtered.slice(offset, offset + limit),
      };
    }
    case "yuque_get_doc": {
      const doc = await deps.client.getDoc(
        employeeId,
        requireString(args, "doc_url"),
      );
      const raw = doc.raw as Record<string, unknown>;
      if (raw.type === "Sheet" || doc.format === "lakesheet") {
        throw new Error(
          "Target is an independent Sheet/lakesheet resource; use yuque_get_sheet",
        );
      }
      const cursor = optionalNonNegativeInt(args, "cursor", 0);
      const maxChars = Math.min(optionalInt(args, "max_chars", 20_000), 50_000);
      if (cursor > doc.markdown.length) {
        throw new Error("cursor exceeds document length");
      }
      const end = Math.min(doc.markdown.length, cursor + maxChars);
      const proprietaryBlocks = proprietaryBlockTypes(doc.lakeContent);
      return {
        response_rule:
          "在正文或摘要之前，必须先向用户输出 display_path 和 url。",
        display_path: doc.location.displayPath,
        full_path: doc.location.fullPath,
        directory_path: doc.location.path.slice(0, -1),
        url: doc.url,
        id: doc.id,
        slug: doc.slug,
        title: doc.title,
        body: doc.markdown.slice(cursor, end),
        body_cursor: cursor,
        next_cursor: end < doc.markdown.length ? end : null,
        total_characters: doc.markdown.length,
        truncated: end < doc.markdown.length,
        book_id: doc.bookId,
        book_url: doc.bookUrl,
        source_format: doc.format,
        output_format: "plain_text",
        canonical_markdown: null,
        markdown_verified: false,
        proprietary_blocks: proprietaryBlocks,
        version: doc.version,
        updated_at: doc.updatedAt,
        fingerprint: doc.fingerprint,
      };
    }
    case "yuque_get_sheet": {
      const sheet = await deps.client.getSheet(
        employeeId,
        requireString(args, "doc_url"),
      );
      const worksheetId = optionalString(args, "worksheet_id");
      const worksheets = sheet.workbook.worksheets.map((worksheet) => ({
        id: worksheet.id,
        name: worksheet.name,
        non_empty_cells: Object.keys(worksheet.cells).length,
      }));
      if (worksheets.length === 0) {
        return {
          response_rule:
            "先向用户输出 display_path 和 url；这是尚未初始化任何工作表内容的空表格。",
          display_path: sheet.location.displayPath,
          url: sheet.url,
          full_path: sheet.location.fullPath,
          directory_path: sheet.location.path.slice(0, -1),
          title: sheet.title,
          source_format: sheet.format,
          version: sheet.version,
          updated_at: sheet.updatedAt,
          fingerprint: sheet.workbook.fingerprint,
          worksheets: [],
          empty_uninitialized_workbook: true,
          styles_verified: false,
          verified_formula_functions: [...VERIFIED_SHEET_FUNCTIONS],
          verified_formula_functions_host_scope: "personal",
          chart_summaries: sheet.chartSummaries,
          verified_chart_types: [...VERIFIED_PERSONAL_SHEET_CHART_TYPES],
          verified_chart_types_host_scope: "personal",
          verified_chart_display_config_paths: [
            ...VERIFIED_PERSONAL_SHEET_CHART_DISPLAY_CONFIG_PATHS,
          ],
          verified_chart_display_config_chart_types: [
            ...VERIFIED_PERSONAL_SHEET_CHART_DISPLAY_CONFIG_TYPES,
          ],
          verified_chart_theme_indexes: [
            ...VERIFIED_PERSONAL_SHEET_CHART_THEME_INDEXES,
          ],
          verified_chart_layout_indexes: [
            ...VERIFIED_PERSONAL_SHEET_CHART_LAYOUT_INDEXES,
          ],
          verified_chart_display_config_host_scope: "personal",
          verified_chart_preview_operations: [
            ...VERIFIED_PERSONAL_SHEET_CHART_PREVIEW_OPERATIONS,
          ],
          verified_chart_preview_host_scope: "personal",
          chart_preview_supported: isPersonalYuqueUrl(sheet.url),
          chart_confirm_supported: false,
          chart_editing_supported: false,
          unsupported_features: sheet.unsupportedFeatures,
        };
      }
      if (!worksheetId && sheet.workbook.worksheets.length > 1) {
        return {
          response_rule:
            "先向用户输出 display_path 和 url；该表格有多个工作表，列出全部候选并等待用户选择 worksheet_id。",
          display_path: sheet.location.displayPath,
          url: sheet.url,
          full_path: sheet.location.fullPath,
          selection_required: true,
          worksheets,
          version: sheet.version,
          fingerprint: sheet.workbook.fingerprint,
          verified_formula_functions: [...VERIFIED_SHEET_FUNCTIONS],
          verified_formula_functions_host_scope: "personal",
          chart_summaries: sheet.chartSummaries,
          verified_chart_types: [...VERIFIED_PERSONAL_SHEET_CHART_TYPES],
          verified_chart_types_host_scope: "personal",
          verified_chart_display_config_paths: [
            ...VERIFIED_PERSONAL_SHEET_CHART_DISPLAY_CONFIG_PATHS,
          ],
          verified_chart_display_config_chart_types: [
            ...VERIFIED_PERSONAL_SHEET_CHART_DISPLAY_CONFIG_TYPES,
          ],
          verified_chart_theme_indexes: [
            ...VERIFIED_PERSONAL_SHEET_CHART_THEME_INDEXES,
          ],
          verified_chart_layout_indexes: [
            ...VERIFIED_PERSONAL_SHEET_CHART_LAYOUT_INDEXES,
          ],
          verified_chart_display_config_host_scope: "personal",
          verified_chart_preview_operations: [
            ...VERIFIED_PERSONAL_SHEET_CHART_PREVIEW_OPERATIONS,
          ],
          verified_chart_preview_host_scope: "personal",
          chart_preview_supported: isPersonalYuqueUrl(sheet.url),
          chart_confirm_supported: false,
          chart_editing_supported: false,
        };
      }
      const worksheet = worksheetId
        ? sheet.workbook.worksheets.find(
            (candidate) => candidate.id === worksheetId,
          )
        : sheet.workbook.worksheets[0];
      if (!worksheet) {
        throw new Error(
          "worksheet_id was not found; inspect the returned worksheet candidates",
        );
      }
      const selected = readSheetRange(worksheet, optionalString(args, "range"));
      const includeFormulas = optionalBoolean(args, "include_formulas", true);
      const includeStyles = optionalBoolean(args, "include_styles", true);
      const cells = selected.cells.map((row) =>
        row.map((cell) => ({
          value: cell.value,
          ...(includeFormulas && cell.formula ? { formula: cell.formula } : {}),
          ...(includeStyles && cell.style ? { style: cell.style } : {}),
          ...(cell.kind ? { kind: cell.kind } : {}),
          ...(cell.unsupported ? { unsupported: true } : {}),
        })),
      );
      return {
        response_rule:
          "在展示任何单元格内容或摘要前，必须先向用户输出 display_path 和 url。",
        display_path: sheet.location.displayPath,
        url: sheet.url,
        full_path: sheet.location.fullPath,
        directory_path: sheet.location.path.slice(0, -1),
        title: sheet.title,
        source_format: sheet.format,
        version: sheet.version,
        updated_at: sheet.updatedAt,
        fingerprint: sheet.workbook.fingerprint,
        worksheets,
        worksheet: { id: worksheet.id, name: worksheet.name },
        range: selected.range,
        cells,
        formulas_included: includeFormulas,
        verified_formula_functions: [...VERIFIED_SHEET_FUNCTIONS],
        verified_formula_functions_host_scope: "personal",
        styles_requested: includeStyles,
        styles_verified: true,
        chart_summaries: sheet.chartSummaries,
        chart_summary_fields_verified: [
          "chart_id",
          "chart_type",
          "chart_type_verified_on_personal_host",
          "source_range",
          "worksheet_id",
          "data_worksheet_id",
          "display_config_projection_verified_on_personal_host",
          "display_config",
        ],
        verified_chart_types: [...VERIFIED_PERSONAL_SHEET_CHART_TYPES],
        verified_chart_types_host_scope: "personal",
        verified_chart_display_config_paths: [
          ...VERIFIED_PERSONAL_SHEET_CHART_DISPLAY_CONFIG_PATHS,
        ],
        verified_chart_display_config_chart_types: [
          ...VERIFIED_PERSONAL_SHEET_CHART_DISPLAY_CONFIG_TYPES,
        ],
        verified_chart_theme_indexes: [
          ...VERIFIED_PERSONAL_SHEET_CHART_THEME_INDEXES,
        ],
        verified_chart_layout_indexes: [
          ...VERIFIED_PERSONAL_SHEET_CHART_LAYOUT_INDEXES,
        ],
        verified_chart_display_config_host_scope: "personal",
        verified_chart_preview_operations: [
          ...VERIFIED_PERSONAL_SHEET_CHART_PREVIEW_OPERATIONS,
        ],
        verified_chart_preview_host_scope: "personal",
        chart_preview_supported: isPersonalYuqueUrl(sheet.url),
        chart_confirm_supported: false,
        chart_editing_supported: false,
        unsupported_features: sheet.unsupportedFeatures,
      };
    }
    case "yuque_preview_create_doc":
      return deps.changes.previewCreate(employeeId, {
        bookUrl: requireString(args, "book_url"),
        parentUuid: requireString(args, "parent_uuid"),
        expectedParentPath: requireString(args, "parent_display_path"),
        title: requireString(args, "title"),
        markdown: requireString(args, "markdown"),
      });
    case "yuque_preview_create_book":
      return deps.changes.previewCreateBook(employeeId, {
        name: requireString(args, "name"),
        description: optionalString(args, "description"),
      });
    case "yuque_preview_update_book":
      return v03CapabilityBlocked("update_book");
    case "yuque_preview_change_book_collaborator":
      return v03CapabilityBlocked("change_book_collaborator");
    case "yuque_preview_delete_doc":
      if (!deps.changes.objectDeletionEnabled())
        throw new Error("Object deletion is disabled by configuration");
      return v03CapabilityBlocked("delete_doc");
    case "yuque_preview_delete_sheet":
      if (!deps.changes.objectDeletionEnabled())
        throw new Error("Object deletion is disabled by configuration");
      return v03CapabilityBlocked("delete_sheet");
    case "yuque_preview_delete_book":
      if (!deps.changes.objectDeletionEnabled())
        throw new Error("Object deletion is disabled by configuration");
      return v03CapabilityBlocked("delete_book");
    case "yuque_preview_update_doc":
      return deps.changes.previewUpdate(employeeId, {
        docUrl: requireString(args, "doc_url"),
        newMarkdown: optionalString(args, "markdown"),
        mode: requireUpdateMode(args),
        sectionHeading: optionalString(args, "section_heading"),
        newTitle: optionalString(args, "new_title"),
      });
    case "yuque_preview_create_sheet":
      return deps.changes.previewCreateSheet(employeeId, {
        bookUrl: requireString(args, "book_url"),
        parentUuid: requireString(args, "parent_uuid"),
        expectedParentPath: requireString(args, "parent_display_path"),
        title: requireString(args, "title"),
        worksheets: requireArray(args, "worksheets"),
      });
    case "yuque_preview_update_sheet":
      return deps.changes.previewUpdateSheet(employeeId, {
        docUrl: requireString(args, "doc_url"),
        operations: requireArray(args, "operations"),
      });
    case "yuque_confirm_change":
      return deps.changes.confirmChange(
        employeeId,
        requireString(args, "change_token"),
        requireString(args, "diff_digest"),
        optionalBoolean(args, "confirm_deletions", false),
        optionalString(args, "confirmation_text"),
      );
    case "yuque_cancel_change":
      return {
        cancelled: deps.changes.cancel(
          employeeId,
          requireString(args, "change_token"),
        ),
      };
    case "yuque_list_snapshots":
      return deps.changes.listSnapshots(
        employeeId,
        optionalString(args, "target_url"),
      );
    case "yuque_preview_restore_snapshot":
      return deps.changes.previewRestoreSnapshot(
        employeeId,
        requireString(args, "snapshot_id"),
      );
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function v03CapabilityBlocked(capability: string): never {
  throw new Error(
    `Yuque web capability '${capability}' remains disabled until its static evidence, live UI capture, browser-closed replay, error contract and read-back verification are all recorded`,
  );
}

async function localUser(
  employeeId: string,
  deps: McpDependencies,
): Promise<unknown> {
  const session = await deps.sessions.load(employeeId);
  return {
    owner_id: employeeId,
    connected: Boolean(session),
    ...(session?.account.id ? { yuque_account_id: session.account.id } : {}),
    ...(session?.account.login ? { yuque_login: session.account.login } : {}),
    ...(session?.account.name ? { yuque_name: session.account.name } : {}),
    source: "verified_login_binding",
  };
}

function requireUpdateMode(
  args: Record<string, unknown>,
): "append" | "replace_section" | "delete_section" | "rename" {
  const value = requireString(args, "mode");
  if (
    !["append", "replace_section", "delete_section", "rename"].includes(value)
  ) {
    throw new Error(
      "mode must be append, replace_section, delete_section or rename",
    );
  }
  return value as "append" | "replace_section" | "delete_section" | "rename";
}

function changeTokenSchema(): JsonSchema {
  return {
    type: "object",
    properties: {
      change_token: stringProperty(
        "One-time token returned by a preview tool.",
      ),
    },
    required: ["change_token"],
    additionalProperties: false,
  };
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function requireString(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${name} is required`);
  return value;
}

function optionalString(
  args: Record<string, unknown>,
  name: string,
): string | undefined {
  const value = args[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  return value;
}

function optionalScopeId(args: Record<string, unknown>): string {
  const value = optionalString(args, "scope_id") ?? "organization";
  if (
    value !== "personal" &&
    value !== "organization" &&
    !/^organization:[1-9][0-9]*$/.test(value)
  ) {
    throw new Error(
      "scope_id must be personal, organization or organization:<numeric-id>",
    );
  }
  return value;
}

function optionalInt(
  args: Record<string, unknown>,
  name: string,
  fallback: number,
): number {
  const value = args[name];
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) <= 0)
    throw new Error(`${name} must be a positive integer`);
  return value as number;
}

function optionalNonNegativeInt(
  args: Record<string, unknown>,
  name: string,
  fallback: number,
): number {
  const value = args[name];
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new Error(`${name} must be a non-negative integer`);
  return value as number;
}

function optionalBoolean(
  args: Record<string, unknown>,
  name: string,
  fallback: boolean,
): boolean {
  const value = args[name];
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean`);
  return value;
}

function requireArray(args: Record<string, unknown>, name: string): unknown[] {
  const value = args[name];
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${name} must be a non-empty array`);
  }
  return value;
}

function isPersonalYuqueUrl(value: string): boolean {
  try {
    return new URL(value).origin === "https://www.yuque.com";
  } catch {
    return false;
  }
}

export function assertCapabilityRegistryMatchesTools(): void {
  const tools = toolDefinitions.map((tool) => tool.name);
  const capabilities = capabilityToolNames();
  if (JSON.stringify(tools) !== JSON.stringify(capabilities)) {
    throw new Error("Capability Registry and MCP tool definitions differ");
  }
}

assertCapabilityRegistryMatchesTools();
