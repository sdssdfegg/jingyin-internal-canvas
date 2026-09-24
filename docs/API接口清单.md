# API接口清单

适用目录：`D:\RJ\静音AI绘画V5（源码）`

更新时间：2026-08-13

本文记录当前本地后端 `server/index.js` 暴露的接口、主要调用页面、请求形态和注意事项。后续抽 `src/api/*` 和 `server/routes/*` 时，以本文为对照。

## 1. 总原则

当前后端是本地代理服务，默认地址：

```text
http://127.0.0.1:8787
```

前端统一走相对路径 `/api/...`。

接口分为 7 类：

- 配置接口。
- 通用生图接口。
- 批量工作流接口。
- 提示词和 SKILL 辅助接口。
- 历史和本地资源接口。
- 保存目录和文件保存接口。
- 图片代理和缓存接口。

后续新增接口时，必须写清楚：

- 哪个功能调用。
- 是否需要 API Key。
- 是否上传图片。
- 是否影响 P0 功能。
- 是否会写入 `data` 或 `logs`。

## 2. 前端调用分布

当前前端直接调用接口的位置主要在：

| 文件 | 主要接口 |
| --- | --- |
| `src/main.jsx` | `/api/history`、`/api/config`、`/api/reference-prompt-rewrite`、`/api/canvas-assets`、`/api/images`、`/api/save-directory`、`/api/pick-directory`、`/api/open-save-directory`、`/api/save-processed-image`、`/api/save-image`、`/api/quick-prompt-rewrite`、`/api/detail-prompts` |
| `src/outfit-workflow.jsx` | `/api/config`、`/api/images`、`/api/generate-outfit`、`/api/outfit-master-fit-analysis`、`/api/outfit-quality-check`、`/api/save-directory`、`/api/pick-directory`、`/api/open-save-directory`、`/api/save-processed-image`、`/api/save-image`、`/api/image-proxy` |
| `src/image-editor.jsx` | 当前主要做本地 canvas 编辑，保存能力通过宿主页面传入 |

后续第一步建议抽：

```text
src/api/client.js
src/api/config.js
src/api/images.js
src/api/outfit.js
src/api/history.js
src/api/save.js
src/api/prompts.js
src/api/assets.js
```

## 3. 配置接口

### GET `/api/config`

职责：

- 返回当前可用模型列表。
- 返回默认渠道 baseUrl。
- 告诉前端服务端是否内置 KEY。

当前调用：

- `src/main.jsx`
- `src/outfit-workflow.jsx`

返回示例：

```js
{
  ok: true,
  defaultBaseUrl: "https://api.jingyin.online/v1",
  fallbackBaseUrl: "",
  hasServerKey: false,
  models: []
}
```

注意：

- 当前发布策略是不在服务端内置 KEY。
- 模型列表同时存在于 `src/models.js` 和 `server/channel.js`，后续新增模型要同步。

## 4. 通用生图接口

### POST `/api/images`

职责：

- 通用图片生成接口。
- 无参考图时走文生图。
- 有参考图时走图生图或编辑接口。
- 快捷生成、参考生图、一键详情主图、无限画布都可能使用。

当前调用：

- `src/main.jsx`
- `src/outfit-workflow.jsx`

请求类型：

- `multipart/form-data`
- 图片字段：`image`
- 普通字段：`apiKey`、`model`、`prompt`、`imageSize`、`aspectRatio`、`n`、`source` 等。

关键逻辑：

- `server/channel.js` 会构造多个请求变体。
- 优先尝试 `size=宽x高`。
- 再尝试 `image_size=宽x高 + aspect_ratio`。
- 最后尝试旧格式 `image_size=2K + aspect_ratio`。
- `gpt-image` 默认走静音中转站的 `gpt-image` 请求格式；OpenAI `gpt-image-1` 兼容变体默认关闭，仅在显式设置 `JINGYIN_ENABLE_OPENAI_IMAGE_VARIANT=1` 时启用。

返回内容：

```js
{
  ok: true,
  images: [],
  timingMs: 0,
  usedModel: ""
}
```

注意：

- 这是 P0 相关接口，改动必须验证快捷生成。
- 不要把批量换装专属 SKILL 默认塞进这个接口。
- 快捷生成只有在明确局部回贴或特定局部换装意图时，才追加相关保护逻辑。

## 5. 批量工作流接口

### POST `/api/generate-outfit`

职责：

- 批量生成核心接口。
- 支持批量换装、局部回贴、换背景、换脸、设计稿、姿态、自定义等工作流。

当前调用：

- `src/outfit-workflow.jsx`

请求类型：

- `multipart/form-data`
- 图片字段：`image`
- 业务参数放在 `payload` JSON 字段中。

关键输入：

```js
{
  apiKey: "",
  taskId: "",
  model: "",
  imageSize: "2K",
  aspectRatio: "3:4",
  prompt: "",
  productNote: "",
  workflowMode: "outfit | local-detail | background-change | face-swap | design-draft | pose-remix | custom",
  pageName: "",
  uploadLabels: {},
  localEdit: {},
  smartIntervention: true,
  masterFitLock: false
}
```

关键逻辑：

- 后端根据 `workflowMode`、页面名、上传标签和提示词判断工作流。
- 批量换装默认只需要图1和图2。
- 图3默认不参与，除非提示词明确提到图3、第三张、补充图、补充参考。
- 局部回贴工作流必须有 `localEdit.enabled`。
- 图1是主输入和坐标来源。
- 图2是固定需求通道，尤其是服装、人脸、背景、结构参考。
- 图3是临时补充通道。

返回内容：

```js
{
  ok: true,
  taskId: "",
  image: {},
  prompt: "",
  timingMs: 0,
  usedModel: "",
  autoSavePending: true,
  smartIntervention: true,
  poseAi: {}
}
```

注意：

- 这是 P0 核心接口。
- 任何修改都必须验证批量换装和局部回贴。
- 不要在这个接口里默认让图3参与。
- 不要把局部贴回、羽化、校色等本地后处理写进 SKILL。

### POST `/api/outfit-master-fit-analysis`

职责：

- 对图2服装母版做版型分析。
- 返回可用于锁定版型和细节一致性的结构化描述。

当前调用：

- `src/outfit-workflow.jsx`

请求类型：

- `multipart/form-data`
- 图片字段：单图 `image`
- 参数字段：`payload`

业务价值：

- 女装电商批量换装的最大痛点之一是版型和细节不一致。
- 例如袖克夫长短不一致、袖长一会到手腕一会到手掌、宽松款生成成正装感、裤长或衣长漂移。
- 该接口后续应成为“固定图2服装版型和细节”的重要辅助能力。

注意：

- 该接口不直接生图，只分析服装规格。
- 后续优化批量换装一致性时优先考虑它，而不是盲目加长通用 SKILL。

### POST `/api/outfit-quality-check`

职责：

- 对批量结果做 AI 质检。
- 返回是否通过、评分、问题和修复提示。

当前调用：

- `src/outfit-workflow.jsx`

请求类型：

- `multipart/form-data`
- 图片字段：`image1`、`image2`、`result`、`reference`
- 参数字段：`payload`

注意：

- 当前是 P1。
- 质检结果只做标记和建议，不应自动修改图片。
- 后续可以用于检测女装换装的一致性问题，例如版型、袖口、衣长、松量、材质、细节。

## 6. 提示词和 SKILL 辅助接口

### POST `/api/quick-prompt-rewrite`

职责：

- 快捷生成提示词优化。

当前调用：

- `src/main.jsx`

请求类型：

- `multipart/form-data`
- 图片字段：`image`
- 参数字段：`payload`

注意：

- 快捷生成是 P0，优化失败要有 fallback。
- 不要默认把批量换装强规则注入普通快捷生成。

### POST `/api/reference-prompt-rewrite`

职责：

- 参考生图提示词扩写。

当前调用：

- `src/main.jsx`

请求类型：

- `multipart/form-data`
- 图片字段：`productImage`、`referenceImage`
- 参数字段：`payload`

注意：

- 当前是 P1。
- 主要用于参考生图，不要污染批量换装规则。

### POST `/api/detail-prompts`

职责：

- 一键详情主图提示词计划生成。
- 可调用 AI 计划，也可回退本地规则。

当前调用：

- `src/main.jsx`

请求类型：

- `multipart/form-data`
- 图片字段：`productImage`、`referenceImage`
- 参数字段：`payload`

注意：

- 当前详情主图比较稳定，后续有需求再优化。
- 不作为第一轮重构核心。

## 7. 历史接口

### GET `/api/history`

职责：

- 读取历史结果。

当前调用：

- `src/main.jsx`

读取位置：

```text
data/history.json
data/history.backup.json
data/history-images
```

注意：

- 发布包不应携带历史数据。
- 后续可以按模块筛选：快捷生成、批量生成、参考生图、详情主图。

### POST `/api/history`

职责：

- 追加历史结果。

当前调用：

- `src/main.jsx`

注意：

- 历史写入前会尝试归档图片。
- 不要把临时 blob URL 当成长期可用地址保存。

### DELETE `/api/history`

职责：

- 删除指定历史或清空历史。

当前调用：

- `src/main.jsx`

请求示例：

```js
{ ids: ["id1", "id2"] }
{ clear: true }
```

注意：

- 清空历史属于危险操作，前端必须有确认。

## 8. 本地资源接口

### GET `/api/history-image/:filename`

职责：

- 读取历史图片。

对应目录：

```text
data/history-images
```

### GET `/api/reference-asset/:filename`

职责：

- 读取参考素材归档。

对应目录：

```text
data/reference-assets
```

### POST `/api/canvas-assets`

职责：

- 上传无限画布或素材相关图片。

当前调用：

- `src/main.jsx`

请求类型：

- `multipart/form-data`
- 图片字段：`image`

注意：

- 当前无限画布不是 P0。
- 后续如果素材库正式化，要重新整理该接口。

### GET `/api/canvas-asset/:filename`

职责：

- 读取画布素材。

对应目录：

```text
data/canvas-assets
```

### GET `/api/result/:filename`

职责：

- 读取批量生成结果缓存图。

对应目录：

```text
data/results
```

注意：

- 局部回贴和批量生成会依赖结果缓存展示。

## 9. 保存目录和保存接口

### GET `/api/save-directory`

职责：

- 获取当前保存目录。
- 如果目录不可用，则回退可用默认目录。

当前调用：

- `src/main.jsx`
- `src/outfit-workflow.jsx`

配置文件：

```text
data/app-settings.json
```

### POST `/api/save-directory`

职责：

- 设置保存目录。

请求示例：

```js
{ directory: "D:\\xxx\\生成图片" }
```

### POST `/api/pick-directory`

职责：

- 调用系统目录选择能力。

注意：

- Windows 下通过 PowerShell/系统能力选择目录。
- 如果用户取消，应返回 `cancelled: true`。

### POST `/api/open-save-directory`

职责：

- 打开保存目录。

注意：

- 这是本地桌面体验能力。

### POST `/api/save-image`

职责：

- 保存生成图片。
- 使用静音每日编号命名。

当前调用：

- `src/main.jsx`
- `src/outfit-workflow.jsx`

注意：

- P0 功能，改动后必须验证。
- 保存路径和文件命名必须稳定。

### POST `/api/save-processed-image`

职责：

- 保存裁剪、改尺寸、编辑后的图片文件。

当前调用：

- `src/main.jsx`
- `src/outfit-workflow.jsx`

请求类型：

- `multipart/form-data`
- 图片字段：`image`
- 普通字段：`directory`、`subfolder`

注意：

- 批量改尺寸和图片编辑依赖该接口。

## 10. 图片代理接口

### GET `/api/image-proxy?url=...`

职责：

- 代理远程图片。
- 支持分片下载远程结果图。
- 避免前端直接加载远程图失败。

当前调用：

- `src/main.jsx`
- `src/outfit-workflow.jsx`

注意：

- 远程图片缓存和显示依赖该接口。
- 不要把任意本地路径暴露给该接口。
- 后续抽服务时应放入 `server/routes/assets.routes.js` 或 `server/routes/proxy.routes.js`。

## 11. 视频接口

### POST `/api/videos/generations`

职责：

- 提交兰兰达 Seedance 视频生成任务。
- 第一版支持文生视频和 1 张图片 URL/Base64 参考。
- 服务端使用私密 `JINGYIN_LANLANDA_VIDEO_API_KEY` 请求上游，不把客户 KEY 直接发给兰兰达。

请求类型：

- `application/json`

请求字段：

- `apiKey`：画板客户 KEY，用于保持统一入口口径。
- `model`：`seedance-2.0`、`seedance-2.0-fast`、`seedance-2.5`、`seedance2-mini`。
- `prompt`：视频提示词。
- `duration` / `seconds`：视频时长。
- `resolution`：`480p`、`720p`、`1080p`、`4k`，按模型能力限制。
- `aspectRatio`：`9:16`、`16:9`、`1:1`。
- `image` / `imageUrl`：可选，图片参考 URL 或 Base64。
- `metadata`：可选扩展参数。

返回字段：

- `task.taskId`：上游视频任务 ID。
- `task.status`：`queued`、`in_progress`、`completed`、`failed` 等。
- `costEstimate`：内部上游成本估算，不用于客户展示。

注意：

- 该接口需要本机 `.env` 或服务器环境变量配置 `JINGYIN_LANLANDA_VIDEO_API_KEY`。
- 正式客户版建议开启 `JINGYIN_BILLING_GATEWAY_ENABLED=1` 和 `JINGYIN_REQUIRE_VIDEO_BILLING_GATEWAY=1`，由 `api.jingyin.online` 先做 KEY、余额、价格和消费记录校验。
- 如果 `api.jingyin.online` 的 prepare 返回 `route` / `upstream` 签发路由，源码会优先使用该路由请求 LANLANDA；否则才使用本机 `JINGYIN_LANLANDA_VIDEO_API_KEY`。
- 客户最终销售价、余额扣费和消费记录应放在 `api.jingyin.online` 统一计费后台，不放在画板客户界面。

### POST `/api/videos/status`

职责：

- 查询兰兰达 Seedance 视频任务状态。

请求类型：

- `application/json`

请求字段：

- `apiKey`：画板客户 KEY。
- `taskId`：视频任务 ID。

返回字段：

- `task.status`：当前任务状态。
- `task.progress`：上游返回的进度。
- `task.url`：完成后的视频地址。
- `task.error`：上游错误摘要。

## 12. 轻量计费网关适配

源码侧新增 `server/billing-gateway.js`，用于把客户 KEY 校验、余额扣费、消费记录和真实上游大文件处理拆开。

影响范围：

- `/api/images`：生成前可调用 prepare，结束后后台调用 finalize。
- `/api/generate-outfit`：批量工作流真实生图前可调用 prepare，结束后后台调用 finalize。
- `/api/videos/generations`：视频创建任务前可调用 prepare，上游任务创建成功或失败后调用 finalize。
- `/api/videos/status`：只查状态，不单独扣费。

环境变量：

- `JINGYIN_BILLING_GATEWAY_ENABLED`：默认 `0`，正式接口上线后再开启。
- `JINGYIN_BILLING_GATEWAY_BASE_URL`：默认 `https://api.jingyin.online`。
- `JINGYIN_BILLING_GATEWAY_PREPARE_PATH`：默认 `/api/gateway/tasks/prepare`。
- `JINGYIN_BILLING_GATEWAY_FINALIZE_PATH`：默认 `/api/gateway/tasks/finalize`。
- `JINGYIN_BILLING_GATEWAY_SERVICE_TOKEN`：可选服务端签名令牌，不写入源码和发布包。
- `JINGYIN_REQUIRE_VIDEO_BILLING_GATEWAY`：默认 `0`；设置为 `1` 后，视频生成必须先接入静音计费网关。
- `VIDEO_ROUTE_SESSION_TTL_MS`：视频签发路由本机内存保留时间，默认 4 小时，用于状态轮询。
- `JINGYIN_LAOYE_PRIMARY_API_KEY` / `JINGYIN_LAOYE_SECONDARY_API_KEY`：老夜真实上游私密 KEY，用于把客户 KEY 和老夜生图 KEY 分开。

视频可用状态：

- `/api/config.videoPolicy.enabled` 现在表示“本机兰兰达上游 KEY 可用，或静音计费网关已启用并可签发上游路由”。
- 当走静音计费网关签发时，`videoPolicy.routeSource` 返回 `billing-gateway`；客户电脑不需要保存兰兰达真实 KEY。
- 只有静音计费网关未启用且本机没有 `JINGYIN_LANLANDA_VIDEO_API_KEY` 时，前端才显示视频通道未配置。

轻量网关约束：

- prepare/finalize 只传 JSON 元数据，不传原图、不传结果图、不代理下载。
- 客户界面仍只显示统一 KEY、统一模型和统一价格。
- 余额不足、KEY 错误、权限错误应返回明确业务提示；渠道故障和上游异常默认在客户侧包装为“生成超时，请重新生成。”。如果上游快速返回 `404/openai_error` 这类模型路由或图片编辑接口不支持问题，应显示“中转站/上游模型路由返回 404”，避免误判成本地超时或电脑卡顿。

图片 prepare 可选返回：

```json
{
  "ok": true,
  "gatewayTaskId": "gw_img_xxx",
  "route": {
    "baseUrl": "https://api.lk888.ai/v1",
    "generationUrl": "/images/generations",
    "editUrl": "/images/edits",
    "model": "gpt-image-2",
    "headers": {
      "Authorization": "Bearer sk-***"
    },
    "channelId": "image2-primary",
    "channelRole": "image-primary"
  }
}
```

源码行为：

- `/api/images` 和 `/api/generate-outfit` 收到图片签发路由后，会优先直连该路由承接真实生图。
- 如果签发路由失败且属于渠道故障、超时、上游异常或限流，再回退本机原有候选。
- 结果图预览、自动下载、分片下载和局部回贴不经过 prepare/finalize，也不传大文件给 `api.jingyin.online`。

视频 prepare usage 新增字段：

- `billingSku`：建议格式 `video:{model}:{resolution}:{duration}s`，用于后台定价。
- `billableQuantity`：视频秒数。
- `billableUnit`：当前固定为 `second`。
- `resolution` / `duration` / `aspectRatio`：视频规格。
- `costEstimate`：内部上游成本估算，仅用于后台核算，不给客户展示。

视频 prepare 可选返回：

```json
{
  "ok": true,
  "gatewayTaskId": "gw_xxx",
  "route": {
    "baseUrl": "https://api.lanlanda.com/v1",
    "createUrl": "https://api.lanlanda.com/v1/video/generations",
    "statusUrlTemplate": "https://api.lanlanda.com/v1/video/generations/{task_id}",
    "headers": {
      "Authorization": "Bearer sk-***"
    },
    "channelId": "lanlanda-video-primary",
    "channelRole": "video-primary"
  }
}
```

注意：示例里的 `sk-***` 只表示运行时签发的授权占位，不允许把真实 KEY 写进源码、文档、日志或发布包。

## 13. 推荐拆分顺序

前端 API client 拆分顺序：

1. `/api/config`
2. `/api/save-directory`、`/api/pick-directory`、`/api/open-save-directory`
3. `/api/history`
4. `/api/save-image`、`/api/save-processed-image`
5. `/api/quick-prompt-rewrite`、`/api/reference-prompt-rewrite`、`/api/detail-prompts`
6. `/api/images`
7. `/api/generate-outfit`
8. `/api/outfit-master-fit-analysis`、`/api/outfit-quality-check`
9. `/api/videos/generations`、`/api/videos/status`

服务端 routes 拆分顺序：

1. `config.routes.js`
2. `save.routes.js`
3. `history.routes.js`
4. `assets.routes.js`
5. `prompts.routes.js`
6. `images.routes.js`
7. `outfit.routes.js`
8. `videos.routes.js`

核心原则：

- 低风险接口先拆。
- P0 出图接口最后拆。
- 每拆一个接口都要跑检查，并按验收清单测试相关功能。
