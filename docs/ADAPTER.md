# OpenFind 真实数据适配器协议

OpenFind的前后端已经实现搜索、评论、草稿与发布的完整状态处理。平台网络请求通过本协议与数据源解耦，便于接入自己已经授权的数据服务。**项目未附带真实平台登录会话或小红书接口签名，也未验证真实账号端到端成功。**

## 1. 接入步骤

1. 准备自己的平台数据服务，提供下文4个HTTP端点。
2. 在工作台「连接设置」填写其根地址（例如 `http://127.0.0.1:9000`）和可选Bearer令牌。
3. 添加平台账号，填写与服务当前登录身份一致的账号ID；根据数据源需要配置账号Cookie。
4. 点击“保存并测试连接”，返回合法健康响应后切换“真实模式”。
5. 发起搜索，作品会标注“真实”；在这些作品上采集评论、克隆创作和发布。

所有接口均为 **POST JSON**。如配置了服务令牌，会附加 `Authorization: Bearer <token>`。如配置了Cookie，Cookie会作为JSON字段传到你配置的服务。不要把凭证配置到不信任的远程地址；本地服务也可以直接管理自己的登录会话，从而不需要传入Cookie。

真实接口采用30秒超时。采集可取消；翻页请求之间按界面选择等待，默认1000ms。服务必须返回非2xx表示失败，或返回与协议一致的JSON；禁止返回一段文字冒充成功。

## 2. 健康检查：POST /health

请求（测试连接时可能无accountId，发布前包含所选账号）：

```json
{ "accountId": "your-account-id", "cookie": "可选会话" }
```

响应：

```json
{ "ok": true, "accountId": "your-account-id", "accountName": "我的品牌账号" }
```

发布前会比对accountId；未返回或不匹配则拒绝继续。健康检查必须只读，不能上传或发布。

## 3. 关键词搜索：POST /search

```json
{
  "keyword": "家居",
  "limit": 100,
  "sort": "popular",
  "noteType": "all",
  "cursor": null,
  "cookie": "可选会话"
}
```

sort可选general/latest/popular；noteType可选all/image/video；cursor首屏null，后续传上一次响应的nextCursor；limit=0表示继续直到服务返回nextCursor=null。

```json
{
  "items": [
    {
      "id": "note-unique-id",
      "title": "作品标题",
      "body": "完整正文，而不是凭空补全的摘要",
      "author": "作者昵称",
      "authorId": "user-unique-id",
      "platform": "xiaohongshu",
      "type": "image",
      "images": ["https://your-media-host/image.jpg"],
      "cover": "https://your-media-host/cover.jpg",
      "likes": 12800,
      "comments": 136,
      "saves": 2500,
      "publishedAt": "2026-10-17T10:00:00.000Z",
      "tags": ["家居", "生活灵感"],
      "url": "https://www.xiaohongshu.com/explore/real-note-id"
    }
  ],
  "nextCursor": "opaque-page-2"
}
```

末页返回 `nextCursor:null`。同一个ID会去重；重复游标会导致任务显式失败。用户选择图文/视频时，服务应过滤后返回相应类型。真实作品缺少图片应返回空数组，不能把封面截图当成全套素材。需要时，服务应先获取作品详情后返回完整正文和图片。

`source`字段由OpenFind强制置为live，数据服务无需传入。数值应为非负数，不要返回“1.2万”等格式化文本。缩略图和素材URL需要允许浏览器显示；批量下载还需要允许相应跨域fetch。封面与素材在使用时由浏览器按URL获取。

## 4. 评论：POST /comments

```json
{ "noteId": "note-unique-id", "includeReplies": true, "cursor": null, "cookie": "可选会话" }
```

```json
{
  "items": [
    {
      "id": "root-comment-id",
      "noteId": "note-unique-id",
      "parentId": null,
      "author": "小满",
      "authorId": "commenter-1",
      "body": "有上海的推荐吗？想了解一下",
      "region": "上海",
      "createdAt": "2026-10-17T11:00:00.000Z",
      "likes": 5
    },
    {
      "id": "reply-comment-id",
      "noteId": "note-unique-id",
      "parentId": "root-comment-id",
      "author": "小鱼",
      "authorId": "commenter-2",
      "body": "我也想了解，有报价吗",
      "region": "浙江",
      "createdAt": "2026-10-17T11:01:00.000Z",
      "likes": 2
    }
  ],
  "nextCursor": null
}
```

适配器负责组合一级评论和每个根评论的楼中楼分页。parentId必须指向根评论或真实父评论，不能把所有回复扁平化成ROOT。region为平台公开显示的IP属地文字，不采集设备原始IP。

## 5. 发布：POST /publish

```json
{
  "id": "local-draft-id",
  "idempotencyKey": "local-draft-id",
  "noteId": "source-note-id",
  "title": "编辑后的标题",
  "body": "编辑后的正文",
  "tags": ["家居", "生活"],
  "images": ["https://your-media-host/image.jpg", "data:image/png;base64,..."],
  "visibility": "public",
  "accountId": "your-account-id",
  "cookie": "所选账号的可选会话"
}
```

服务必须负责：验证所选账号 → 下载或读取素材 → 按平台要求上传图片 → 获得素材上传ID → 提交图文与话题 → 获取真实内容ID及URL → 保存幂等结果。

images中的本地上传素材为PNG/JPEG/WebP data URL；真实外部素材为HTTP(S) URL。`/assets/`是演示素材专用，不会从真实来源草稿中自动构造出真实素材。适配器应明确拒绝不可处理的图片。

visibility的public映射为公开可见、private映射为仅自己可见。对应账号的身份必须和/health回传身份一致。

成功响应必须包含实际发布回执：

```json
{
  "id": "actual-platform-content-id",
  "url": "https://www.xiaohongshu.com/explore/actual-platform-content-id"
}
```

同一个idempotencyKey重复调用，服务应返回已有回执，不应再次发布。若平台只返回“操作完成”而无真实内容ID/URL，本协议不能把它直接判为发布成功；应进一步查证实际发布结果。超时不是确定失败，重试前须检查幂等回执和平台状态。

## 6. 错误契约

返回HTTP401/403用于登录或授权失败，429用于限流，5xx用于服务错误。OpenFind将保存错误日志、显示失败状态并保留已获取结果，不会在失败后偷偷回退到演示数据。不要在错误正文中输出明文凭证。

单次采集最多200个分页请求。遇到接口风控、重复游标或超时时应停止，修正数据服务或账号后重新发起。暂停按钮只停止采集，不对已开始的发布产生“撤回发布”的承诺。

## 7. 与已有平台工具的关系

协议刻意与具体采集实现分离。可将自己现有的签名服务或内部授权接口包装为上述4个端点，平台规则改变时只替换适配器。

公开项目 [xiaohongshu-mcp 的官方API文档](https://github.com/xpzouying/xiaohongshu-mcp/blob/main/docs/API.md)提供搜索、详情、评论和发布等接口，但它的路径、输入输出及会话模型与本协议不同，**不能直接把其18060端口填入OpenFind当作已兼容服务**。其公开搜索示例未提供本协议的分页游标，发布示例也不提供本协议所需的内容URL；需要额外转换和核验。这里未安装或启动该项目，也未把它作为已验证集成。

## 8. 本项目内部API

| 方法与地址                                  | 用途                                               |
| ------------------------------------------- | -------------------------------------------------- |
| GET /api/state                              | 作品、评论、线索、草稿、任务、账号与非敏感设置快照 |
| POST /api/intent                            | 规则解析自然语言任务                               |
| POST /api/jobs                              | 创建搜索任务                                       |
| POST /api/jobs/:id/stop                     | 停止采集，保留已有结果                             |
| POST /api/comments/collect                  | 创建评论采集任务                                   |
| POST /api/leads/collect                     | 保存所选评论为去重线索                             |
| PATCH /api/leads/:id                        | 更新状态、备注和沟通话术                           |
| POST /api/drafts                            | 保存草稿，已发布草稿另存新ID                       |
| POST /api/drafts/:id/publish                | 模拟发布或真实账号预检及发布                       |
| DELETE /api/drafts/:id                      | 删除本地草稿                                       |
| GET /api/drafts/:id/bundle                  | 下载图文草稿ZIP                                    |
| GET /api/accounts                           | 读取账号列表（无明文凭证）                         |
| POST /api/accounts                          | 添加独立账号及可选加密凭证                         |
| DELETE /api/accounts/:id                    | 删除账号，至少保留一个                             |
| GET/PUT /api/settings                       | 读取/保存连接设置（返回不含凭证）                  |
| POST /api/settings/test                     | 只读连接检查                                       |
| GET/POST /api/export/:kind?format=json或csv | 导出notes/comments/leads/drafts/jobs               |

大量结果导出使用POST请求体 `{"ids":["id1","id2"],"format":"json"}`，避免URL长度限制。ids为空数组时导出空结果；GET不传ids时导出该类型的全部数据。
