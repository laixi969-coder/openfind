# 可选语义复核

## 配置与连接

「连接设置 → 大模型」填写兼容服务Base URL（含`/v1`等实际前缀）、Key和模型ID。支持HTTPS与本机HTTP，无凭证URL及重定向转发。模型可以在同步列表中选择，也可以手动填写；不硬编码“最新”模型名称，不自动升级所选模型。

- `GET /api/llm`：返回配置、hasApiKey、模型列表、上次同步和测试时间，永不返回Key。
- `PUT /api/llm`：完整保存enabled、baseUrl、model、maxComments及可选apiKey；Key使用现有AES-256-GCM本机加密。更换供应商时必须重新明确输入或清空Key，不把旧Key传给新地址。
- `POST /api/llm/models/sync`：请求服务的`GET /models`，去重并展示当前账号可见列表及同步时间。列表可含非聊天模型，因此仍应测试所选模型。同步成功并不证明模型能生成文字。
- `POST /api/llm/test`：向所选模型实际调用`POST /chat/completions`，仅使用固定合成文本，核对JSON输出`{"ok":true}`；不拿真实客户数据测试。403/401/不支持JSON/无效输出都不能显示连接成功。

协议依据：[List models](https://developers.openai.com/api/reference/resources/models/methods/list)、[Create chat completion](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)、[JSON mode](https://developers.openai.com/api/docs/guides/structured-outputs)。兼容供应商仍需支持相应接口，OpenFind不声称所有第三方服务均可用。

## 执行与验证

默认关闭，无Key也可运行本地采集判断。启用后每10条评论一批串行复核，单次上限1–200条（默认100），每请求20秒超时，首次错误停止后续模型请求，保留已完成部分和本地规则结果。平台采集次数不受模型复核影响。刷新页面不会触发模型调用。

只发送评论文字、作品标题与同串回复角色/文字；不发送结构化昵称、ID、属地、Cookie或Key（Key仅用于模型服务Authorization）。号码、邮箱与URL遮蔽；敏感语境和作者自评在本地跳过，不发送到模型。文本中的其他个人信息不保证能自动识别，启用前应确认该服务适用的数据使用范围。

模型必须返回规定编号、结论、理由、原文引用和未知项。未知/重复编号、缺失结果、格式错误、没有证据的购买结论或与脱敏输入不匹配的引用均拒收。不执行评论或模型里的指令。语义缓存按输入、模型和配置版本校验；换模型或改原文后失效。

模型只提供单独标注的补充建议；原文与规则结果始终可见，模型不自动把泛兴趣升成候选。待确认的模型建议可通过评论筛选查看，再由用户复核保存。

## 测试边界

测试套件使用独立临时数据库和本地真实HTTP兼容服务，验证模型列表同步、所选模型实际生成、加密凭证、401/重定向、原文引用、敏感排除、缓存、批次上限和故障回退。未获得供应商Key前，不把本地协议测试描述成某一商业模型已经连接成功。
