# V11 香蕉 Pro 生图 5 分钟无结果 —— 定位与 3.0 渠道对齐 交付验证报告

- 日期：2026-09-25
- 源码目录：`D:\源码开发\静音AI绘画（源码）`（V11）
- 只读参考：`D:\静音AI（3.0）`（未做任何修改）
- 涉及症状：香蕉 Pro 出图约 5 分钟无结果；3.0 用同一条 Pro 线路正常；V11 结果列表出现"红色底"缺图卡片
- 本轮不做：付费批量生图、UI 布局改动、裁剪/局部回贴像素算法、提示词与 SKILL、无限画布、素材库、GPT 对话

---

## 0. 结论摘要

| 问题 | 结论 | 性质 |
| --- | --- | --- |
| Pro 点生成约 5 分钟无结果 | **V11 本地请求形态问题**：Pro 走 multipart `/v1/images/edits`，中转站读不到线路字段，手动线路无法派发，连接挂到 302 s 被断开 | 已修复（改为 3.0 已验证的 JSON + `image_urls`） |
| 3.0 同样的 Pro 为什么不卡 | 3.0 带参考图且无蒙版时走 JSON `/v1/images/generations` + `image_urls`，中转站能按 JSON 体读到 `channelId` 完成派发 | 对齐后行为一致 |
| banana-2 / tt-image-2 偶发很慢（164 s / 295 s / 一次 302 s） | **上游/渠道拥塞**（对照组同样慢，且失败样本的 `channelWaitMs` 占满全程），与 Pro 的根因不同 | 未改动（按"不改已正常的 banana-2 链路"） |
| 结果列表"红色底"卡片 | **不是 CSS 问题**：那是本地 mock 测试返回的 1×1 红色 PNG（R=254 G=0 B=0 A=127），共 9 张，正好是"最近的 9 个图" | 已清除，并让测试产物不再落进用户 data 目录 |

本轮**没有产生任何真实出图费用**（唯一一次真实外发请求是 401 鉴权失败，详见第 12 节）。

---

## 1. 复现与证据链

用户实测那一次（第一条 Pro 线路 `silent-pro-line-10`，快捷生成，2 张参考图，2K/3:4）：

| 时刻（UTC） | 日志 | 关键字段 |
| --- | --- | --- |
| 16:00:53.959 | `client-generation-submit` | `fieldNames` 含 `channelId`、`dispatchMode`（浏览器端线路字段已发出） |
| 16:00:54 → 16:05:56 | 服务端转发 | `url=https://api.jingyin.online/v1/images/edits`，`protocol=multipart`，`requestFormat=jingyin-image-size-aspect-ratio`，`requestedModel=nano-banana-pro` |
| 16:05:56.087 | `api-images-channel-error` | `status=502`，`timing.totalMs=302078`，`failureReason=channel_error`，`upstreamError="fetch failed"` |
| 16:05:56.094 | `client-generation-error` | `status=504`，`durationMs=302135`，`payloadError=channel_timeout`，`message="生成超时，请重新生成。"` |

要点：

1. **请求确实发出去了**（`forward-api-images-request` 有记录），不是"点了没反应"。
2. 挂了 **302078 ms ≈ 5 分 2 秒**，正是用户说的"5 分钟没结果"。
3. 失败点在上游那一跳：连接被挂到超时后断开（`fetch failed`），不是在 V11 内部报错。
4. 用户观察"渠道那里也没收到生图信息"与此一致——手动线路没有被派发出去。

对照组（同一天的正常模型）证明"不是全局网络坏掉"：

| 时刻 | 模型 | 结果 |
| --- | --- | --- |
| 15:24 / 15:26 / 15:34 | banana-2、tt-image-2 | 成功出图（`generationMs` 103501 / 164684 / 185366） |
| 15:39:26 | banana-2 | 也挂了一次：`totalMs=302761`，`channel_error`，`fetch failed` → 504 |

也就是说：**同一条中转站，banana-2 能出图（虽然慢），Pro 出不来。**

---

## 2. 根因判定

### 2.1 主因：请求形态让"只有手动线路"的模型无法派发

- V11 路由目录里 `nano-banana-pro` 只有 `routes: { manual: "ACTIVE" }`，**没有** `price_first` 自动兜底；banana-2 / tt-image-2 两个都有 `price_first`，所以它们即使线路没读全也能自动兜底出图。
- 3.0 源码 `main.py:13429-13434` 记录了实测结论：中转站的计费表达式**只解析 JSON 体**，multipart 里的 `channelId` / `version` 读不到（同线路实测 JSON=0.1200、multipart=0.0978，说明 multipart 落到了默认档）。
- 所以 Pro 的 multipart 请求到了中转站，中转站无法确认手动线路 → 请求被吊住 → 直到连接断开（302 s）。
- 这解释了为什么"给 multipart 补上 `channelId`/`dispatchMode` 字段"（上一轮的修复）仍然不够：**字段在 multipart 里，中转站不读。**

### 2.2 次因：上游拥塞（只影响本来就正常的模型）

对照组里 banana-2 出现 164 s / 185 s / 295 s，以及一次 302 s 失败；失败样本 `channelWaitMs`（302754）几乎等于 `totalMs`（302761），说明时间全花在等上游，不是 V11 内部处理。

### 2.3 两件事必须分开

- Pro 5 分钟无结果 = **V11 请求形态**（本报告修复对象）。
- banana-2/tt-image-2 偶发慢 = **上游拥塞**（不修改链路，只在报告里说明）。

---

## 3. 改动文件清单

| 文件 | 改动 |
| --- | --- |
| `server/channel.js` | ① `normalizeImageRequest()` 提取 `referenceDataUrls`（只收 `data:image/`，最多 12 张）；② 新增 `appendRoutingFields()`，向 JSON 体写 `dispatchMode`/`channelId`/`manualModel`/`outputAspectRatio`/`outputSize`，multipart 表单写同名 5 个字段；③ `buildImageRequestVariants()` 新增前置分支：`nano-banana-pro` + 有参考图 + 无蒙版 + 有 data URL → **单个**变体 `jingyin-json-image-urls`，POST `/images/generations`（JSON），体内带 `image_urls` |
| `server/index.js` | ① `imageForwardUpload` 增加 `fieldSize: 8 * 1024 * 1024`（data URL 文本字段超过 multer 默认 1MB 会被截断）；② `IMAGE_UPLOAD_PARSE_CEILING = 16`；③ `IMAGE_REQUEST_TIMEOUT_MS=900000`、`IMAGE_CHANNEL_ATTEMPT_TIMEOUT_MS=max(60000, min(900000, 360000))` |
| `src/main.jsx` | ① 新增 `fileToCompactJpegDataUrl(file, 1536, 0.85)` 与 `JSON_IMAGE_URLS_MODELS = new Set(["nano-banana-pro"])`；② 快捷生成 `/api/images` 组装表单时，对 Pro + 有参考图 + 无局部蒙版追加 `referenceDataUrl` 字段；③ `normalizeGenerationErrorMessage()` 增加 `channel_timeout|fetch failed|ECONNRESET|socket hang up → "请求超时，可重新提交。"`，以及 `manual_channel_required` 等英文码的中文映射 |
| `src/outfit-workflow.jsx` | 错误码中文映射（`manual_channel_required` → 线路未生效），与快捷生成保持一致 |
| `scripts/verify/pro-wire-check.mjs` | 重写为本轮证据来源：本地 mock 上游 + 独立测试实例，10 个场景；并新增**产物隔离与自清理**（见第 13 节） |

未改动：`prompts/`、SKILL 规则、裁剪/局部回贴几何算法（`src/shared/local-edit-geometry.js` 本轮未动）、无限画布、素材库、GPT 对话、主界面布局。

---

## 4. V11 ↔ 3.0 请求字段对照表（带参考图、无蒙版）

| 字段 | 3.0 行为 | V11 改动前 | V11 改动后 | 说明 |
| --- | --- | --- | --- | --- |
| 路径 | `/v1/images/generations`（带图无蒙版） | `/v1/images/edits` | **`/v1/images/generations`** | 对齐 |
| 协议 | JSON | multipart | **JSON** | 对齐（中转站只读 JSON 体） |
| 参考图 | `image_urls: [data URL]`（`encode_reference_data_url(ref, max_size=1536)`） | `image` 文件字段 | **`image_urls: [data URL]`**（前端 `fileToCompactJpegDataUrl(1536, 0.85)`） | 对齐 |
| `dispatchMode` | 有（JSON + multipart 都写） | 仅 multipart | JSON + multipart 都写 | 对齐 |
| `channelId` | 有 | 仅 multipart | JSON + multipart 都写 | 对齐 |
| `manualModel` | 有 | 无 | 有 | 对齐 |
| `outputAspectRatio` | 有 | 无（只有 `aspectRatio`） | 有（= 原 `aspectRatio`） | 对齐，无新几何语义 |
| `outputSize` | 有 | 无（只有 `imageSize`） | 有（= 原 `imageSize`） | 对齐，无新几何语义 |
| `cropAspectRatio` | 有 | 无 | **刻意不发** | 见下 |

**刻意不发 `cropAspectRatio` 的原因**：3.0 用它表示"局部裁剪框的比例"，而 V11 的局部选框本轮已改成自由矩形。把生成比例塞进 `cropAspectRatio` 会让中转站按比例重新裁切我们刚裁好的局部图，破坏局部回贴结果。`outputAspectRatio`/`outputSize` 只是把我们本来就在发的 `aspectRatio`/`imageSize` 换个名字，不引入新几何语义。

**保守回退**：Pro 若拿不到 data URL（例如批量侧），仍然退回 multipart `/images/edits`，不会报错（场景 3 已验证）。

---

## 5. 请求是否真的发出去了

| 验证 | 结果 |
| --- | --- |
| 服务端转发日志 | 每个场景都有 1 条 `forward-api-images-request`（`upstreamRequestCount=1`） |
| 用户实测那一次 | 有 `forward-api-images-request`（16:00:54），失败点在 302 s 后的上游断连 |
| 真实中转站抽检 | 见第 12 节：请求确确实实到了 `https://api.jingyin.online/v1/images/generations` |

---

## 6. 每条 Pro 线路的实测数据（mock 上游，不联网不扣费）

| 场景 | HTTP | 耗时 | 图片 | 上游请求数 | 上游路径 | 协议 | image_urls |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Pro `silent-pro-line-10` | 200 | 83 ms | 1 | 1 | `/v1/images/generations` | json | 1 |
| Pro `silent-pro-line-09` | 200 | 74 ms | 1 | 1 | `/v1/images/generations` | json | 1 |
| Pro 无 data URL → 回退 | 200 | 60 ms | 1 | 1 | `/v1/images/edits` | multipart | 0 |
| mock 成功（Pro） | 200 | 56 ms | 1 | 1 | `/v1/images/generations` | json | 1 |
| mock 上游挂住 | 504 | 60033 ms | 0 | 1 | `/v1/images/generations` | json | 1 |
| mock HTTP 500 | 504 | 31 ms | 0 | 1 | `/v1/images/generations` | json | 1 |
| mock 图片 URL 不可达 | 200 | 796 ms | 1 | 1 | `/v1/images/generations` | json | 1 |
| mock 相对路径 URL | 200 | 48 ms | 1 | 1 | `/v1/images/generations` | json | 1 |

两条 Pro 线路都走了新的 JSON 路径，且都带 `channelId`/`dispatchMode`/`manualModel`。

**未完成**：由于本机没有可用的 API Key（`hasServerKey: false`），**没有做真实 Pro 出图验证**（第 14 节列为未验证项）。

---

## 7. 对照组数据

| 场景 | HTTP | 耗时 | 上游路径 | 协议 | 结论 |
| --- | --- | --- | --- | --- | --- |
| banana-2（`silent` 自动兜底线） | 200 | 57 ms | `/v1/images/edits` | multipart | 链路形态与改动前一致 |
| tt-image-2 | 200 | 57 ms | `/v1/images/edits` | multipart | 同上 |

对照组两个模型仍然是 multipart，没有被本次改动波及——满足"不改已正常的 banana-2 链路"。

同日真实环境对照组（用户自己的历史结果）：banana-2 / tt-image-2 成功出图，`generationMs` 分别为 103501 / 164684 / 185366 ms；banana-2 另有 1 次 302 s 失败。**结论：这两个模型的慢/偶发失败来自上游拥塞，不是本次改动的对象。**

---

## 8. 重复请求 / 隐藏重试排查

| 检查 | 结果 |
| --- | --- |
| 每个场景的上游请求数 | 全部 `upstreamRequestCount = 1` |
| `buildImageRequestVariants()` 变体数 | Pro 新分支返回**单个**变体，不存在多候选逐个试 |
| 日志里的 `channelAttempt` / `candidateCount` | 均为 1 |
| 是否新增隐藏重试 | 没有新增任何重试逻辑 |

---

## 9. 响应字段差异

| 项 | 改动前（multipart/edits） | 改动后（JSON/generations） |
| --- | --- | --- |
| 成功响应 | `{created, data:[...]}` | `{created, data:[...]}`（一致） |
| 响应字段解析 | 同一套解析（`imageCount`/`dataCount`） | 同一套解析 |
| 401 鉴权失败 | `failureReason=invalid_api_key`，`upstreamError="Invalid token (request id: ...)"` | 同左（抽检实测） |
| 上游 500 | 映射为 504 + `channel_timeout` | 同左（保持一致） |
| 图片 URL 不可达 / 相对路径 | 原样透传给前端 | 同左（未改动） |

---

## 10. 改动 ↔ 证据映射

| 改动 | 支撑证据 |
| --- | --- |
| Pro 带参考图改走 JSON + `image_urls` | 场景 1/2/5：`path=/v1/images/generations`、`proto=json`、`urls=1`；3.0 `main.py:13428-13454` 同路径同字段 |
| JSON/ multipart 都补 `dispatchMode`/`channelId`/`manualModel` | `routing-check.mjs` 90 项全过；wire 抓包 `effective.channelId` 等字段非空 |
| `outputAspectRatio`/`outputSize` | wire 抓包 JSON 体含该两字段；`routing-check` 校验 |
| 不发 `cropAspectRatio` | 代码注释 + 本轮局部选框为自由矩形的既有交付 |
| 前端 `referenceDataUrl`（≤1536、q0.85） | 浏览器实测提交字段名含 `referenceDataUrl`；日志 `fileBytes=24020`（压缩后） |
| multer `fieldSize` 提到 8MB | 未加时 data URL 文本字段会被截断（1MB 默认）；加后 24020 B 的 data URL 正常通过 |
| 超时提示改中文可重提交 | `quickgen-skill-check.mjs` 第 25 项；wire 场景 5/6 返回 504 且 message 为"生成超时/请求超时" |
| 测试产物不再污染用户 data 目录 | 收尾核对：跑完 wire check 前后用户目录文件数与历史条数不变 |

---

## 11. loading 状态与结果卡片

| 情形 | 行为 | 证据 |
| --- | --- | --- |
| 成功 | loading 卡片移除，结果卡片插入 | mock 200 → `imagesReturned=1`；浏览器实测 `loadingCards: 0` |
| 上游超时 | 504 → 前端提示"生成超时，请重新生成。"，loading 立刻解除 | `client-generation-error` 在 channel error 后 3 ms（302135 vs 302078）；wire 场景 5 在 60033 ms 后返回 504 |
| 上游 HTTP 500 | 504 + 可读提示，loading 解除 | wire 场景 6（31 ms） |
| 网络类失败（`fetch failed`/`ECONNRESET`） | 新增映射 → "请求超时，可重新提交。" | `normalizeGenerationErrorMessage()`；上一轮的真实 302 s 失败即此路径 |
| 鉴权失败 | "API Key 无效，请检查后重试。" | 浏览器实测事件条显示该文案，页面 0 报错 |

结论：**三种失败路径都能解除 loading，且都给出可读中文提示**，没有"永远转圈"的情况。

---

## 12. "红色底缺图卡片"定位（背景 + DOM 检查）

### 12.1 DOM / CSS 检查

- 结果卡片结构：`article.assetCard` → `CachedImage` → 裸 `<img>`。
- `src/styles.css:514` `.assetCard { background: var(--panel); border: 1px solid var(--border); }` —— **深色中性底**（默认主题 `--panel: #171724`）。
- 全仓 `styles.css` 中**没有任何一条给结果卡片/缺图卡片设红色背景的规则**（按 `#f00`/`red`/RGB 高红值检索 `background` 声明：0 命中）。`.missing` 只有一条，属于参考图缩略图条 `referenceMiniThumb`，与结果卡片无关。
- `CachedImage` 不渲染任何占位层；图片加载失败时卡片露出的是 `.assetCard` 自身的深色底。

**所以"红色"不可能来自 CSS。**

### 12.2 真正原因

那 9 张"红卡片"是**我上一轮 wire check 留下的 mock 测试图**：mock 上游固定返回 1×1 PNG，解码后为 `R=254 G=0 B=0 A=127`（半透明红）。

- 命中条目标签：9 条，`prompt = "wire check"`，与用户说的"最近的 9 个图"数量一致。
- 已删除这 9 条历史条目 + 对应归档图；`data/history.json` 现在只剩真实结果。

### 12.3 加固（防止再发生）

`scripts/verify/pro-wire-check.mjs`：

1. **产物隔离**：测试实例用 `JINGYIN_RELEASE_ROOT` 指向 `.codex-artifacts/pro-wire-check`，mock 图和 mock 历史条目**完全不进用户 `data/`**。
2. **按内容哈希清理**：凡内容等于那张 mock 测试像素的归档图一律清掉（含 V11 自己"历史图片"恢复出来的空 prompt 条目），不再只依赖文件名/提示词匹配。
3. **收尾自查**：跑完输出 `userDataResidue`（用户目录里的 mock 像素残留数），本次为 **0**。

本轮收尾实测：跑前后用户目录 `history-images` 均为 8 个真实文件、`history.json` 均为 6 条真实记录、mock 像素残留 0。

---

## 13. 验证命令与结果

| 项目 | 命令 | 结果 |
| --- | --- | --- |
| 语法检查（服务端/脚本） | `node --check server/index.js server/channel.js src/shared/local-edit-geometry.js scripts/verify/pro-wire-check.mjs` | 全部 exit 0 |
| 语法检查（JSX） | `scripts/verify/run-node-check.mjs` | 14 项 OK / 0 失败（`.jsx` 由该脚本负责，`node --check` 本身不认 `.jsx`） |
| 路由校验 | `scripts/verify/routing-check.mjs` | **失败 0 项 / 共 90 项** |
| UI 重复项校验 | `scripts/verify/ui-duplication-check.mjs` | **失败 0 项 / 共 53 项** |
| 快捷生成 SKILL 校验 | `scripts/verify/quickgen-skill-check.mjs` | **失败 0 项 / 共 25 项** |
| 启动器校验 | `scripts/verify/check-launcher.mjs` | **失败 0 项 / 共 35 项** |
| 渠道 wire 校验 | `scripts/verify/pro-wire-check.mjs` | `ok = true`，10 场景全通过，`userDataResidue = 0` |
| 前端构建 | `./runtime/node/node.exe node_modules/vite/bin/vite.js build` | **exit 0**，`✓ built in 3.01s` |

---

## 14. 是否产生真实费用

- **没有。** 本轮所有出图验证都打本地 mock 上游（`http://127.0.0.1:8891/v1`），不联网、不消耗额度。
- 唯一一次真实外发请求：用假 Key（`sk-mock-not-real`）向 `https://api.jingyin.online/v1/images/generations` 发 1 次 Pro 请求，**812 ms 返回 401 `invalid_api_key`**，未生成图片、未计费。
  - 该请求的意义：证明改动后的请求**确实是 JSON 协议、确实打到 `/images/generations`、确实带上了新字段**（`requestFormat=jingyin-generations-json-image-urls`）。
- 没有做任何批量付费生图；每条 Pro 线路最多只打过 1 次真实请求（即上面那 1 次）。

---

## 15. 未验证项与风险

| 项 | 状态 | 影响 / 说明 |
| --- | --- | --- |
| **真实 Pro 出图成功** | ❌ 未验证 | 本机无可用 API Key，无法端到端确认。这是本轮最大的未知项 |
| 中转站是否因此正确派发手动线路 | ❌ 未验证 | 401 只能证明请求形态正确到达，不能证明中转站按 `channelId` 完成派发与计费 |
| 计费档位 | ⚠️ 推断 | 3.0 实测 multipart 会落到默认档（0.0978 vs 0.1200）；改 JSON 后应恢复线路价，但未实测 |
| 上游 TTFB | ⚠️ 未记录 | 现有日志只有 `channelWaitMs` 总量，无法区分"排队"与"生成" |
| 批量侧 Pro 仍走 multipart | ⚠️ 未接线 | `/api/generate-outfit` 侧未传 `referenceDataUrl`，Pro 在批量里会退回 multipart（不报错，但可能仍无法派发手动线路） |
| 图片 URL 坏 / 相对路径 | ⚠️ 原样透传 | 前端会渲染深色破图卡片，但没有明确原因提示（本次未改） |
| mock 超时场景耗时 | ℹ️ 说明 | `IMAGE_CHANNEL_ATTEMPT_TIMEOUT_MS` 有 60 s 下限，所以场景 5 是 ~60 s 返回，不是 8 s |
| 上游拥塞 | ⚠️ 环境问题 | banana-2/tt-image-2 偶发 164–302 s，属于渠道问题，本报告未处理 |

**建议的下一步（需用户配合）**：在配好真实 Key 的环境里，用 Pro `silent-pro-line-10` 各打 1 次，确认能出图且 `generationMs` 正常；若仍挂，则把 `referenceDataUrl` 接到批量侧，并考虑给手动线路加"派发前预检"。

---

## 16. 附：本轮测试产物清理记录

| 项 | 处理 |
| --- | --- |
| mock 历史条目（`prompt="wire check"`） | 已全部删除（历史备份：`data/history.backup-before-mock-cleanup.json`） |
| mock 1×1 红色归档图 | 已全部删除；现目录仅剩 8 个真实归档文件 |
| 孤儿测试图（上一轮删条目后残留在磁盘上的） | 已按内容哈希清空，残留 0 |
| 测试实例数据目录 | 改到 `.codex-artifacts/pro-wire-check`（已加入默认忽略），不再写用户 `data/` |
| `data/history.json` 现状 | 6 条，全部是真实结果（4 条本轮用户实测 + 2 条更早的真实/恢复记录） |
