# AI画板规范化实现方案

适用目录：`D:\RJ\静音AI绘画V5（源码）`

编写日期：2026-08-13

目标：在不破坏现有可出图链路的前提下，把当前“想到哪里做到哪里”的源码画板，逐步规范成方便继续开发、方便排查问题、方便打包发布、方便以后交接的工程。

## 1. 总体判断

当前项目已经不是一个简单 demo，而是一个可运行的 AI 生图工作台。它包含快捷生成、批量换装、局部回贴、换背景、批量换脸、设计稿、批量改尺寸、图片编辑、参考生图、一键详情主图、历史记录、保存目录、结果缓存、发布打包等能力。

主要问题不是“功能少”，而是功能增长太快，很多代码集中在少数大文件里，导致后续每加一个功能都会有三个风险：

- 不知道该改哪个文件。
- 改一个页面时影响另一个页面。
- UI、状态、接口、提示词规则混在一起，过一段时间自己也很难回忆当时为什么这样写。

因此规范化不能一上来大重写。正确方式是：先建立边界，再逐步拆分；先保护稳定链路，再整理结构；先写规则，再按规则开发新功能。

## 2. 当前项目实现地图

### 2.1 技术栈

- 前端：Vite + React 19。
- 后端：Node.js + Express。
- 文件上传：`multer` 内存上传。
- 图标：`lucide-react`。
- 打包：`vite build`、`scripts/generate-static-assets.mjs`、`scripts/secure-win-release.mjs`。
- AI 接口：后端代理 OpenAI 兼容图片接口和 chat completions 接口。

### 2.2 启动方式

`package.json` 中当前脚本：

- `npm run dev`：启动 `node server/index.js`。
- `npm run start`：同样启动 `node server/index.js`。
- `npm run build`：构建前端。
- `npm run check`：对服务端主要 JS 文件做语法检查。
- `npm run build:assets`：把前端 dist 资源嵌入到 `server/static-assets.generated.js`。
- `npm run release:win`：生成 Windows 发布包。

本地访问地址默认是：

```text
http://127.0.0.1:8787
```

### 2.3 当前目录职责

```text
D:\RJ\静音AI绘画V5（源码）
├─ src                  前端源码
├─ server               本地后端代理、AI 提示词、历史和文件保存
├─ scripts              构建、嵌入静态资源、Windows 发布脚本
├─ public               图标等公开资源
├─ data                 本地运行数据、历史图片、结果图片、素材库
├─ logs                 生成日志
├─ dist                 前端构建产物
├─ node_modules         依赖
├─ .secure-build        安全发布构建临时目录
└─ docs                 项目文档，规范化后统一放这里
```

### 2.4 当前关键源码文件

| 文件 | 当前职责 | 规范化判断 |
| --- | --- | --- |
| `src/main.jsx` | 主应用外壳、快捷生成、参考生图、一键详情主图、无限画布、历史、保存、弹窗、图片预览、部分图像处理 | 过大，需要逐步拆成 App Shell、功能模块、hooks、API client、工具函数 |
| `src/outfit-workflow.jsx` | 批量生成主工作流，包含批量换装、局部回贴、换背景、设计稿、换脸、姿态、批量改尺寸、上传、裁剪、局部编辑、任务队列 | 过大，需要按“页面设置、上传区、任务队列、局部编辑、批量改尺寸、结果区”逐步拆 |
| `src/image-editor.jsx` | 图片编辑面板 | 已相对独立，可作为规范化样板继续拆小 |
| `src/local-edit-mask.js` | 局部编辑蒙版、选区、alpha mask 工具 | 职责清晰，应保持稳定，后续只补测试和文档 |
| `src/models.js` | 前端模型列表、比例、图片源解析、格式化工具 | 与 `server/channel.js` 有重复，后续应抽公共配置或建立同步规则 |
| `src/styles.css` | 主应用样式 | 过大，需要拆成 tokens、base、components、features |
| `src/outfit-workflow.css` | 批量工作流样式 | 过大，需要按批量模块拆分 |
| `server/index.js` | Express 启动、所有 API 路由、文件存储、历史、代理、保存、静态资源、生成转发 | 过大，需要拆成 app、routes、services、storage、utils |
| `server/channel.js` | 模型、比例、请求变体、响应图片提取 | 职责较清晰，应保留为后端通道适配层 |
| `server/outfit-skill.js` | 批量换装及相关工作流提示词构造 | 属于核心业务规则，改动要非常谨慎 |
| `server/detail-ai.js`、`detail-middleware.js`、`detail-skills.js` | 一键详情主图提示词生成 | 可作为 detail 功能域拆分到 server/features/detail |
| `server/quick-prompt-ai.js` | 快捷生成提示词优化 | 可作为 quickgen 功能域服务 |
| `server/reference-ai.js` | 参考生图提示词扩写 | 可作为 reference-remix 功能域服务 |
| `server/outfit-pose-ai.js` | 批量姿态/智能锚点分析 | 保持业务稳定，后续补接口文档 |
| `server/outfit-master-fit-ai.js` | 母版版型分析 | 保持业务稳定，后续补接口文档 |
| `server/outfit-quality-ai.js` | 批量结果 AI 质检 | 保持业务稳定，后续补接口文档 |

## 3. 当前主要功能链路

### 3.1 快捷生成链路

```text
用户输入提示词和参考图
-> 前端处理参考图、普通裁剪、局部回贴或蒙版
-> POST /api/images
-> server/channel.js 构造请求变体
-> 渠道图片接口
-> 返回图片 URL 或 base64
-> 前端展示、历史记录、复制、下载、自动保存
```

涉及文件：

- `src/main.jsx`
- `src/local-edit-mask.js`
- `server/index.js`
- `server/channel.js`

### 3.2 批量生成链路

```text
用户在批量页上传图1、图2、图3
-> 前端根据当前内部页签判断工作流
-> 前端构建任务队列
-> POST /api/generate-outfit
-> 后端识别工作流：批量换装、局部回贴、换背景、设计稿、换脸、姿态、自定义
-> server/outfit-skill.js 构造最终提示词
-> 可选调用姿态锚点、母版分析、质检
-> 渠道图片接口
-> 前端任务队列更新结果、缓存、保存、下载
```

涉及文件：

- `src/outfit-workflow.jsx`
- `src/outfit-workflow.css`
- `src/local-edit-mask.js`
- `server/index.js`
- `server/outfit-skill.js`
- `server/outfit-pose-ai.js`
- `server/outfit-master-fit-ai.js`
- `server/outfit-quality-ai.js`
- `server/channel.js`

### 3.3 参考生图链路

```text
用户上传产品图和风格参考图
-> 可选提示词扩写：POST /api/reference-prompt-rewrite
-> 生成：POST /api/images
-> 结果进入参考生图结果区和历史
```

### 3.4 一键详情主图链路

```text
用户上传产品图和参考图
-> POST /api/detail-prompts
-> AI 或本地规则生成多屏详情提示词
-> 每个分屏继续调用 POST /api/images
-> 前端按组展示、选择、拼接、下载
```

### 3.5 图片编辑和批量改尺寸链路

图片编辑更多是前端本地 canvas 处理。保存时调用：

- `POST /api/save-processed-image`
- `POST /api/save-image`

批量改尺寸同样应该尽量归类为本地图片处理能力，只有保存目录、导出保存需要经过后端。

### 3.6 本地数据链路

当前本地数据主要分两类：

- 前端缓存：`localStorage`、`IndexedDB`。
- 服务端数据：`data/history.json`、`data/history-images`、`data/reference-assets`、`data/results`、`data/app-settings.json`。

后续规范化时，要明确哪些是源码，哪些是运行数据。运行数据不应该参与源码管理和发布包。

## 4. 当前混乱点

### 4.1 文件过大

当前最大几个人工维护文件：

- `src/main.jsx` 约 355 KB。
- `src/outfit-workflow.jsx` 约 354 KB。
- `server/index.js` 约 99 KB。
- `src/outfit-workflow.css` 约 93 KB。
- `src/styles.css` 约 76 KB。
- `server/outfit-skill.js` 约 68 KB。

这说明 UI、状态、工具函数、接口调用、任务队列、业务规则都混在大文件中。后续不要继续在这些文件里无限加功能。

### 4.2 前后端配置重复

前端 `src/models.js` 和后端 `server/channel.js` 都维护模型列表、比例等信息。短期可以接受，但后续新增模型时容易漏改一边。

### 4.3 页面边界不清

`main.jsx` 既是应用入口，又承担快捷生成、详情主图、参考生图、历史管理、图片预览、无限画布、保存目录等职责。

`outfit-workflow.jsx` 既是批量生成页面，又承担内部页签、上传裁剪、局部编辑、批量改尺寸、任务执行、结果展示、提示词助手等职责。

### 4.4 UI 规则不统一

很多功能是按当时需求直接堆出来的，容易出现：

- 按钮位置不一致。
- 弹窗样式不一致。
- 上传区交互不一致。
- 结果卡片操作不一致。
- 页面底部操作栏有些固定，有些不固定。
- 状态文案和错误提示风格不一致。

### 4.5 业务规则和后处理混杂

例如普通裁剪、局部回贴、蒙版、GPT 微对齐、Banana 边缘校色、批量换装 SKILL、图3参与规则等，都是很重要的稳定链路。它们现在散落在前端和后端里，容易因为一次 UI 调整误伤出图效果。

### 4.6 缺少明确的开发流程

目前没有看到 `.git` 仓库。也就是说，当前目录本身还不是一个 Git 版本库。对第一个项目来说，这很危险：如果一次重构改坏了，很难精确回退。

建议后续先建立版本管理，再做结构拆分。

## 5. 规范化总原则

### 原则 1：不重写，先抽离

不要把当前画板推倒重来。当前已经有很多实测稳定的功能，尤其是快捷生成、批量换装、局部回贴、保存、历史、发布打包。规范化应该采用“抽离式重构”：

```text
复制稳定逻辑
-> 抽到新模块
-> 保持旧入口调用新模块
-> 验证功能一致
-> 再删旧重复代码
```

### 原则 2：一次只移动一个边界

每次只做一种类型的整理：

- 只抽 API client。
- 或只抽 storage。
- 或只拆一个 UI 组件。
- 或只拆一个服务端 route。

不要在同一次改动里同时改 UI、改提示词、改接口、改样式、改保存逻辑。

### 原则 3：稳定出图链路优先保护

以下链路是红线，任何结构调整都必须先验证：

- 快捷生成单图。
- 快捷生成参考图。
- 快捷生成图1局部回贴。
- 批量换装。
- 批量局部回贴。
- 批量换背景。
- 批量换脸。
- 批量改尺寸导出。
- 保存目录和自动保存。
- 历史记录恢复。

### 原则 4：UI 归 UI，业务归业务，工具归工具

后续每个功能都要拆成四层：

```text
页面组件：只负责展示和用户交互
业务 hook：负责状态、任务队列、页面行为
API client：负责调用后端接口
工具函数：负责纯计算、图片处理、格式化
```

### 原则 5：新增功能必须带文档入口

以后新增页面或大功能时，至少更新一个文档：

- 功能放在哪个目录。
- 入口在哪里。
- 调用哪些 API。
- 数据保存在哪里。
- 怎么验证。

## 6. 目标目录结构

这是建议逐步整理成的结构，不要求一次完成。

```text
src
├─ app
│  ├─ App.jsx                 主应用壳，只管理全局布局和路由
│  ├─ navigation.js           左侧导航定义
│  └─ app-state.js            全局设置、主题、保存目录等
├─ api
│  ├─ client.js               fetch 封装、错误处理
│  ├─ images.js               /api/images
│  ├─ outfit.js               /api/generate-outfit 和批量相关接口
│  ├─ history.js              /api/history
│  ├─ assets.js               素材、代理、保存图片
│  └─ prompts.js              快捷、参考、详情提示词接口
├─ components
│  ├─ ui                      Button、Modal、Tabs、Field、Toolbar 等
│  ├─ media                   图片预览、上传缩略图、Lightbox、拖拽下载
│  └─ layout                  Sidebar、Topbar、Workspace、ActionBar
├─ features
│  ├─ quickgen                快捷生成
│  ├─ outfit                  批量换装、局部回贴、换背景、换脸、姿态
│  ├─ reference-remix         参考生图
│  ├─ detail-main             一键详情主图
│  ├─ image-editor            图片编辑
│  ├─ resize                  批量改尺寸
│  └─ infinite-canvas         无限画布，当前可继续隐藏
├─ lib
│  ├─ storage                 localStorage、IndexedDB、迁移
│  ├─ image                   图片压缩、裁剪、贴回、mask
│  ├─ files                   文件名、下载、拖拽
│  └─ format                  时间、文件大小、状态文案
├─ shared
│  └─ models.js               前端共享模型配置
└─ styles
   ├─ tokens.css              颜色、间距、阴影、字号变量
   ├─ base.css                全局 reset 和基础元素
   ├─ components.css          通用组件样式
   └─ features                各功能样式
```

服务端建议整理为：

```text
server
├─ index.js                   只负责启动
├─ app.js                     创建 express app，挂载中间件和 routes
├─ config.js                  端口、目录、超时、渠道地址等配置
├─ routes
│  ├─ config.routes.js
│  ├─ images.routes.js
│  ├─ outfit.routes.js
│  ├─ history.routes.js
│  ├─ assets.routes.js
│  ├─ save.routes.js
│  └─ prompts.routes.js
├─ services
│  ├─ channel.service.js      调渠道接口
│  ├─ image.service.js        图片 buffer、下载、代理
│  ├─ save.service.js         保存目录、编号命名
│  ├─ history.service.js      历史读写和图片归档
│  └─ static.service.js       dist 和嵌入资源
├─ ai
│  ├─ quick-prompt-ai.js
│  ├─ reference-ai.js
│  ├─ detail-ai.js
│  ├─ outfit-skill.js
│  ├─ outfit-pose-ai.js
│  ├─ outfit-master-fit-ai.js
│  └─ outfit-quality-ai.js
├─ storage
│  ├─ paths.js                data、logs、results 等路径
│  └─ json-store.js           JSON 文件安全读写
└─ utils
   ├─ errors.js
   ├─ files.js
   ├─ http.js
   └─ log.js
```

## 7. 功能模块规范

### 7.1 每个功能模块必须包含这些内容

以快捷生成为例：

```text
features/quickgen
├─ QuickgenPage.jsx           页面主组件
├─ QuickgenComposer.jsx       输入区
├─ QuickgenGallery.jsx        结果区
├─ QuickgenTaskQueue.jsx      运行任务
├─ useQuickgenState.js        状态和行为
├─ quickgen.api.js            调用后端接口
├─ quickgen.types.js          数据结构说明，可用 JSDoc
├─ quickgen.constants.js      常量
└─ quickgen.css               仅本功能样式
```

后续其它功能也按同样方式：

- 页面文件只组合组件。
- hook 管状态和操作。
- api 文件只调接口。
- constants 放常量。
- css 只放当前功能样式。

### 7.2 组件命名规则

- 页面组件：`XxxPage`。
- 弹窗组件：`XxxModal`。
- 上传组件：`XxxUploadZone`。
- 结果组件：`XxxGallery`、`XxxResultCard`。
- 工具栏：`XxxToolbar`。
- 状态 hook：`useXxxState`。
- 任务 hook：`useXxxTasks`。
- API 文件：`xxx.api.js`。

### 7.3 状态分层

所有状态分三类，不要混放：

| 类型 | 示例 | 放置位置 |
| --- | --- | --- |
| 全局状态 | 主题、API Key、保存目录、当前页面 | `src/app` |
| 功能状态 | 当前上传图、提示词、任务队列、结果列表 | `features/xxx/useXxxState.js` |
| 临时 UI 状态 | 弹窗开关、拖拽目标、预览缩放、右键菜单 | 对应组件或功能 hook |

### 7.4 图片对象统一结构

后续前端内部尽量统一图片对象，不要每个页面一种写法。

建议结构：

```js
{
  id: "img_xxx",
  file: File,
  uploadFile: File,
  name: "原文件名.jpg",
  previewUrl: "blob:...",
  localEdit: null,
  crop: null,
  selected: true,
  role: "model | clothing | reference | result",
  createdAt: 1780000000000
}
```

### 7.5 任务对象统一结构

建议结构：

```js
{
  id: "task_xxx",
  source: "quickgen | outfit | reference-remix | detail-main",
  workflowMode: "outfit | local-detail | background-change | face-swap | design-draft | pose-remix | custom",
  status: "idle | queued | running | success | failed | cancelled",
  prompt: "",
  params: {},
  references: [],
  result: null,
  error: "",
  timing: null,
  createdAt: 1780000000000,
  updatedAt: 1780000000000
}
```

统一任务结构后，结果区、下载、保存、历史恢复可以复用更多逻辑。

## 8. UI 规范方案

### 8.1 总布局

建议所有页面统一为四块：

```text
左侧导航
顶部状态栏
中间工作区
底部主操作区
```

批量生成已经有“底部提示词到生成按钮固定”的稳定基线，后续可以把它抽成通用的 `ActionDock` 或 `BottomActionBar`。

### 8.2 页面内部标准结构

每个页面从上到下建议固定为：

```text
页面标题和状态
上传区或输入区
参数区
提示词区
结果区或任务队列
底部主操作栏
```

不要每个页面重新发明布局。

### 8.3 通用组件优先级

后续先抽这些通用组件：

- `Button`
- `IconButton`
- `Modal`
- `Tabs`
- `SegmentedControl`
- `Field`
- `TextArea`
- `UploadZone`
- `ImageThumb`
- `ResultCard`
- `TaskCard`
- `Lightbox`
- `ContextMenu`
- `Toast` 或 `InlineMessage`
- `BottomActionBar`

### 8.4 按钮规则

- 主要动作按钮只保留一个，例如“生成”。
- 次要动作放图标按钮，例如复制、下载、删除、预览、保存。
- 运行中按钮必须有明确 loading 状态。
- 危险操作必须二次确认，例如清空历史、删除全部、清空页面。

### 8.5 上传区规则

所有上传区统一支持：

- 点击选择。
- 拖拽上传。
- 粘贴上传，适合快捷生成和批量工作区。
- 缩略图预览。
- 删除。
- 选择或取消选择。
- 普通裁剪。
- 局部回贴入口，只在需要的角色上显示。

### 8.6 结果区规则

所有结果卡统一显示：

- 图片。
- 状态。
- 生成时间或耗时。
- 使用模型。
- 下载。
- 复制。
- 保存到目录。
- 放大预览。
- 重新生成或带提示词回填。

不同功能可以增减，但视觉和交互位置要一致。

### 8.7 样式规范

后续 CSS 分三层：

```text
tokens.css      颜色、圆角、字号、间距、阴影
components.css  通用组件样式
features/*.css  功能页面样式
```

命名建议：

```css
.jy-button {}
.jy-modal {}
.quickgen-page {}
.quickgen-gallery {}
.outfit-page {}
.outfit-task-card {}
```

不要继续随意新增无前缀 class，避免样式互相污染。

## 9. API 规范方案

### 9.1 当前主要接口

| 接口 | 职责 |
| --- | --- |
| `GET /api/config` | 返回模型、默认渠道地址等配置 |
| `POST /api/images` | 通用图片生成，快捷生成、参考生图、详情主图都会用 |
| `POST /api/generate-outfit` | 批量生成工作流 |
| `POST /api/outfit-master-fit-analysis` | 服装母版版型分析 |
| `POST /api/outfit-quality-check` | 批量结果 AI 质检 |
| `POST /api/quick-prompt-rewrite` | 快捷生成提示词优化 |
| `POST /api/reference-prompt-rewrite` | 参考生图提示词扩写 |
| `POST /api/detail-prompts` | 一键详情主图提示词计划 |
| `GET /api/history` | 读取历史 |
| `POST /api/history` | 写入历史 |
| `DELETE /api/history` | 删除或清空历史 |
| `GET /api/history-image/:filename` | 读取历史图片 |
| `GET /api/reference-asset/:filename` | 读取参考素材 |
| `POST /api/canvas-assets` | 上传画布素材 |
| `GET /api/canvas-asset/:filename` | 读取画布素材 |
| `GET /api/save-directory` | 获取保存目录 |
| `POST /api/save-directory` | 设置保存目录 |
| `POST /api/pick-directory` | 打开系统目录选择 |
| `POST /api/open-save-directory` | 打开保存目录 |
| `POST /api/save-image` | 保存生成图片 |
| `POST /api/save-processed-image` | 保存处理后的图片 |
| `GET /api/result/:filename` | 读取批量生成结果缓存 |
| `GET /api/image-proxy` | 远程图片代理和分片下载 |

### 9.2 返回格式统一

后续新接口统一返回：

```js
// 成功
{
  ok: true,
  data: {},
  message: ""
}

// 失败
{
  ok: false,
  error: "missing_api_key",
  message: "请先填写 API Key",
  details: {}
}
```

历史接口可以先保持兼容，但新接口不要再随意返回不同格式。

### 9.3 前端 API client 统一

新增 `src/api/client.js`：

```js
export async function apiJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...(options.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
      ...(options.headers || {})
    }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.message || `请求失败 ${response.status}`);
  }
  return payload;
}
```

然后每个功能只调用自己的 API 文件，不直接在组件里到处写 `fetch("/api/...")`。

## 10. 服务端规范方案

### 10.1 `server/index.js` 最终只做启动

目标：

```js
import { createApp } from "./app.js";
import { config } from "./config.js";

const app = await createApp();
app.listen(config.port, "127.0.0.1", () => {
  console.log(`静音AI绘画运行中：http://127.0.0.1:${config.port}`);
});
```

### 10.2 路由按功能拆

拆分顺序建议：

1. `config.routes.js`
2. `save.routes.js`
3. `history.routes.js`
4. `assets.routes.js`
5. `prompts.routes.js`
6. `images.routes.js`
7. `outfit.routes.js`

原因是前四类风险低，先拆它们可以建立模式；`images` 和 `outfit` 是核心出图链路，最后拆。

### 10.3 服务层职责

| 服务 | 职责 |
| --- | --- |
| `channel.service.js` | 调渠道图片接口，处理重试、请求变体、响应提取 |
| `history.service.js` | 历史 JSON 读写、历史图片归档 |
| `asset.service.js` | reference、canvas、result 本地资源路径和读取 |
| `save.service.js` | 保存目录、编号命名、打开目录 |
| `image.service.js` | 图片 buffer、base64、远程下载、mime、扩展名 |
| `log.service.js` | generation.jsonl 写入 |

### 10.4 AI 提示词模块要稳定

这些文件属于“业务规则核心”，不能和 UI 重构混在一起改：

- `server/outfit-skill.js`
- `server/outfit-pose-ai.js`
- `server/outfit-master-fit-ai.js`
- `server/outfit-quality-ai.js`
- `server/detail-ai.js`
- `server/detail-middleware.js`
- `server/detail-skills.js`
- `server/quick-prompt-ai.js`
- `server/reference-ai.js`

如果要改提示词规则，必须单独做一轮，并写清楚：

- 改了哪个工作流。
- 触发条件是什么。
- 哪些场景不触发。
- 用哪几张测试图验证。
- 是否影响局部回贴、换脸、换背景、设计稿。

## 11. 数据和缓存规范

### 11.1 源码和运行数据分离

当前 `data` 目录里有用户运行数据。后续建议：

- `src`、`server`、`scripts`、`public`、`docs` 是源码和文档。
- `data`、`logs`、`dist`、`.secure-build`、`node_modules` 是运行或构建产物。

如果后续启用 Git，建议 `.gitignore` 至少包含：

```text
node_modules/
dist/
.secure-build/
.release-temp/
data/
logs/
.env
*.local
*.log
```

如果需要保留演示素材，可以新建：

```text
examples/
```

不要把真实用户历史图放进源码版本管理。

### 11.2 localStorage key 需要登记

当前前端有多种 key，例如 settings、prompt library、detail groups、infinite canvas、active view 等。后续建议在文档或代码里建一个 registry：

```js
export const STORAGE_KEYS = {
  settings: `${STORAGE_PREFIX}-settings-v3`,
  promptPresets: `${STORAGE_PREFIX}-prompt-library-v2-20260802`,
  promptCategories: `${STORAGE_PREFIX}-prompt-categories-v2-20260802`,
  detailGroups: `${STORAGE_PREFIX}-detail-groups-v1`,
  activeView: `${STORAGE_PREFIX}-active-view-v1`
};
```

这样升级缓存时不会找不到入口。

### 11.3 数据迁移规则

以后缓存结构升级时，必须遵守：

- 不直接删除旧 key，除非是公共发布包的清理逻辑。
- 新结构带版本号。
- 写迁移函数。
- 迁移失败时回退默认值，不让页面白屏。

## 12. 分阶段实施步骤

### 第 0 阶段：建立保护线

目标：先保证后续每一步都有回退点。

步骤：

1. 确认当前源码可以启动。
2. 运行 `npm run check`。
3. 运行 `npm run build`。
4. 记录当前稳定状态到 `版本记录.md`。
5. 建议初始化 Git 仓库，或者至少复制一份 `D:\RJ\静音AI绘画V5（源码）` 作为重构前备份。
6. 确认 `.gitignore` 忽略 `data`、`logs`、`dist`、`.secure-build`、`node_modules`。

验收标准：

- 本地能打开 `http://127.0.0.1:8787`。
- 快捷生成和批量生成至少能跑通一个简单任务。
- 有可回退备份或 Git commit。

### 第 1 阶段：补齐文档和规则

目标：先让项目可理解。

步骤：

1. 保留本文件作为总方案。
2. 新增 `docs/项目结构说明.md`，记录每个目录和文件职责。
3. 新增 `docs/API接口清单.md`，记录接口、入参、出参、调用页面。
4. 新增 `docs/功能验收清单.md`，记录每次发布前要测的功能。
5. 新增 `docs/提示词规则边界.md`，记录哪些规则属于前端预处理，哪些属于后端 SKILL，哪些属于本地后处理。

验收标准：

- 新人或未来的自己能通过 docs 找到要改的入口。
- 新增功能前可以先定位归属模块。

### 第 2 阶段：抽前端 API client

目标：减少组件里散落的 `fetch`。

步骤：

1. 创建 `src/api/client.js`。
2. 创建 `src/api/images.js`，封装 `/api/images`。
3. 创建 `src/api/outfit.js`，封装 `/api/generate-outfit`、`/api/outfit-master-fit-analysis`、`/api/outfit-quality-check`。
4. 创建 `src/api/history.js`。
5. 创建 `src/api/save.js`。
6. 创建 `src/api/prompts.js`。
7. 先只替换一个低风险接口，例如 `/api/config` 或 `/api/save-directory`。
8. 验证无问题后，再逐步替换其它接口。

验收标准：

- 组件里不再直接散落大量 `fetch("/api/...")`。
- 接口错误提示统一。
- 旧功能表现不变。

### 第 3 阶段：抽通用工具函数

目标：把纯函数从页面大文件里拿出来。

优先抽这些低风险工具：

1. 文件大小、时间格式、文件名安全处理。
2. 图片源解析、base64、blob、mime、扩展名。
3. localStorage 读写。
4. IndexedDB 读写。
5. 拖拽下载命名。

建议目录：

```text
src/lib/format
src/lib/files
src/lib/storage
src/lib/image
```

验收标准：

- 抽出的函数有清晰文件名。
- 不改变行为。
- `npm run build` 通过。

### 第 4 阶段：拆主应用壳

目标：让 `src/main.jsx` 变成真正入口，不继续承载所有业务。

步骤：

1. 新增 `src/app/App.jsx`。
2. 新增 `src/app/navigation.js`。
3. 把左侧导航、主题、全局配置、当前页面切换从 `main.jsx` 移到 `App.jsx`。
4. `main.jsx` 最终只保留：

```js
import React from "react";
import { createRoot } from "react-dom/client";
import App from "./app/App.jsx";
import "./styles.css";

createRoot(document.getElementById("root")).render(<App />);
```

验收标准：

- 页面切换正常。
- 设置弹窗正常。
- API Key、主题、保存目录正常。

### 第 5 阶段：拆快捷生成模块

目标：先拿一个用户最高频页面做模块化样板。

建议拆分：

```text
src/features/quickgen
├─ QuickgenPage.jsx
├─ QuickgenComposer.jsx
├─ QuickgenReferenceTray.jsx
├─ QuickgenGallery.jsx
├─ QuickgenPreviewModal.jsx
├─ useQuickgenState.js
├─ quickgen.api.js
├─ quickgen.constants.js
└─ quickgen.css
```

步骤：

1. 先抽展示组件，不改生成逻辑。
2. 再抽上传和参考图逻辑。
3. 再抽生成任务逻辑。
4. 最后抽历史、下载、保存逻辑。

验收标准：

- 快捷生成无参考图能出图。
- 快捷生成带参考图能出图。
- 普通裁剪仍正常。
- 图1局部回贴仍正常。
- 保存、下载、复制、历史仍正常。

### 第 6 阶段：拆批量工作流

目标：把 `src/outfit-workflow.jsx` 从“大一统页面”拆成可维护模块。

建议拆分：

```text
src/features/outfit
├─ OutfitWorkflow.jsx
├─ pages
│  ├─ OutfitBatchPage.jsx
│  ├─ LocalDetailPage.jsx
│  ├─ BackgroundChangePage.jsx
│  ├─ FaceSwapPage.jsx
│  ├─ DesignDraftPage.jsx
│  ├─ PoseRemixPage.jsx
│  └─ CustomWorkflowPage.jsx
├─ components
│  ├─ OutfitPageTabs.jsx
│  ├─ OutfitUploadGroup.jsx
│  ├─ OutfitTaskQueue.jsx
│  ├─ OutfitGallery.jsx
│  ├─ OutfitActionDock.jsx
│  ├─ OutfitSettingsModal.jsx
│  └─ OutfitPromptAssistant.jsx
├─ hooks
│  ├─ useOutfitPages.js
│  ├─ useOutfitUploads.js
│  ├─ useOutfitTasks.js
│  ├─ useOutfitGeneration.js
│  └─ useOutfitPersistence.js
├─ local-edit
│  ├─ OutfitLocalEditModal.jsx
│  ├─ OutfitCropModal.jsx
│  └─ local-edit-compose.js
├─ outfit.api.js
├─ outfit.constants.js
└─ outfit.css
```

拆分顺序：

1. 内部页签和页面设置。
2. 上传区。
3. 裁剪弹窗。
4. 局部回贴弹窗。
5. 任务队列。
6. 结果预览和下载。
7. 底部固定操作区。
8. 批量改尺寸单独移动到 `features/resize`。

验收标准：

- 批量换装正常。
- 局部回贴正常。
- 换背景正常。
- 换脸正常。
- 设计稿正常。
- 运行中继续追加任务正常。
- 底部固定操作区正常。
- 已有页面缓存能恢复。

### 第 7 阶段：拆服务端 routes

目标：让 `server/index.js` 从“所有东西都在一个文件”变成清晰服务端结构。

步骤：

1. 抽 `server/config.js`。
2. 抽 `server/storage/paths.js`。
3. 抽 `server/services/history.service.js`。
4. 抽 `server/routes/history.routes.js`。
5. 抽 `server/routes/save.routes.js`。
6. 抽 `server/routes/assets.routes.js`。
7. 抽 `server/routes/prompts.routes.js`。
8. 最后抽 `server/routes/images.routes.js` 和 `server/routes/outfit.routes.js`。

验收标准：

- `npm run check` 通过。
- `/api/config` 正常。
- `/api/history` 正常。
- `/api/images` 正常。
- `/api/generate-outfit` 正常。
- Windows 发布脚本仍能跑。

### 第 8 阶段：统一样式系统

目标：减少样式互相覆盖，统一视觉和交互。

步骤：

1. 新增 `src/styles/tokens.css`。
2. 把主题色、背景色、边框、文字色、危险色抽成 CSS 变量。
3. 新增 `src/styles/components.css`。
4. 把按钮、输入框、弹窗、tab、上传区、结果卡片抽通用样式。
5. `styles.css` 只保留全局基础和 App Shell。
6. `outfit-workflow.css` 逐步拆到 `features/outfit/outfit.css` 和子模块样式。

验收标准：

- 页面没有明显错位。
- 移动窗口尺寸时文字不挤出按钮。
- 批量页底部操作区仍稳定。
- 暗色/亮色主题正常。

### 第 9 阶段：统一测试和验收清单

目标：每次改完知道测什么。

建议先不引入复杂测试框架，先建立人工验收和脚本验收。

脚本验收：

```powershell
npm run check
npm run build
npm run build:assets
node --check server/static-assets.generated.js
```

人工验收：

1. 打开首页。
2. 填 API Key。
3. 快捷生成无图。
4. 快捷生成带参考图。
5. 快捷生成图1局部回贴。
6. 批量换装。
7. 批量局部回贴。
8. 批量换背景。
9. 批量换脸。
10. 批量改尺寸导出。
11. 历史记录刷新后仍存在。
12. 保存目录设置、打开、保存图片。
13. 打包发布后启动。

### 第 10 阶段：发布流程规范

目标：以后发客户包时不靠记忆。

标准流程：

1. 确认源码当前功能可用。
2. 清理本地敏感数据，不把 `.env`、`data`、`logs` 带入发布。
3. 运行 `npm run check`。
4. 运行 `npm run build`。
5. 运行 `npm run build:assets`。
6. 运行 `npm run release:win`。
7. 启动生成的 exe，访问 `/api/config`。
8. 在 `docs/发布包记录.md` 记录 EXE 的 SHA256、大小、分支和提交号；如果后续生成 ZIP，再记录 ZIP 的 SHA256。
9. 更新 `docs/开发任务看板.md`。

## 13. 后续新增功能标准流程

以后新增任何功能，按这个流程走：

1. 写一句话目标。
2. 判断属于哪个功能域：quickgen、outfit、resize、detail、reference、editor、server。
3. 先设计数据结构。
4. 再设计接口。
5. 再做 UI。
6. 最后接生成或保存逻辑。
7. 更新对应 docs。
8. 跑验收清单。

模板：

```text
功能名称：
用户场景：
入口页面：
前端目录：
后端接口：
依赖数据：
是否影响出图提示词：
是否影响局部回贴：
是否影响保存和历史：
验收步骤：
回退方式：
```

## 14. 禁止事项

为了保护项目，后续尽量避免：

- 不要继续把新功能直接堆进 `src/main.jsx`。
- 不要继续把批量相关新功能直接堆进 `src/outfit-workflow.jsx`。
- 不要在 UI 重构时顺手改 `server/outfit-skill.js` 的提示词。
- 不要在提示词调整时顺手改上传、裁剪、保存、历史。
- 不要把 `data`、`logs`、`dist`、`.secure-build` 当作源码提交。
- 不要改完不记录版本说明。
- 不要同时拆前端和后端核心出图链路。
- 不要删除旧缓存迁移逻辑，除非确认公共发布包需要清理。

## 15. 第一轮最推荐落地清单

如果从今天开始规范化，建议先做这 8 件事：

1. 确认当前目录是否要启用 Git，并建立第一个稳定基线。
2. 更新 `.gitignore`，加入 `data/`、`.secure-build/`。
3. 新建 `docs/API接口清单.md`。
4. 新建 `docs/功能验收清单.md`。
5. 新建 `src/api/client.js`，先封装 `/api/config` 和保存目录接口。
6. 抽 `src/app/navigation.js`，把导航配置从 `main.jsx` 拿出来。
7. 抽 `src/lib/storage/json-storage.js`，统一 localStorage 读写。
8. 抽 `src/lib/format/index.js`，统一时间和文件大小格式化。

这 8 件事风险低，但能马上让项目“有规矩起来”。

## 16. 第二轮推荐落地清单

第一轮稳定后，再做：

1. 拆快捷生成 `QuickgenPage`。
2. 拆快捷生成上传区和结果区。
3. 拆批量生成上传区。
4. 拆批量生成任务队列。
5. 拆服务端 `history.routes.js`。
6. 拆服务端 `save.routes.js`。
7. 建立 `tokens.css`。
8. 统一 Button、Modal、Tabs、UploadZone。

第二轮完成后，项目会明显从“大文件工程”变成“模块工程”。

## 17. 第三轮推荐落地清单

第二轮稳定后，再处理核心链路：

1. 拆 `/api/images` 到 `images.routes.js` 和 `channel.service.js`。
2. 拆 `/api/generate-outfit` 到 `outfit.routes.js`。
3. 把批量内部页签拆成独立页面组件。
4. 把批量改尺寸从 `outfit-workflow.jsx` 移到 `features/resize`。
5. 把图片编辑移动到 `features/image-editor`。
6. 建立完整人工验收文档。
7. 固化 Windows 发布流程。

这轮风险更高，必须每拆一步都验证快捷生成和批量生成。

## 18. 推荐开发节奏

一个比较稳的节奏：

```text
上午：只拆结构，不改行为
中午：跑 check/build，手动测核心链路
下午：修拆分导致的问题
晚上：更新版本记录和文档
```

每次只做 1 到 3 个小目标，不要一天内同时拆太多核心文件。

## 19. 最终目标

规范化完成后，希望项目达到这个状态：

- 新功能知道放哪里。
- 老功能知道从哪里查。
- 接口有清单。
- 页面有边界。
- 样式有统一规则。
- 提示词规则有独立文档。
- 出图链路可验证。
- 发布流程可重复。
- 即使一个月后回来改，也能快速进入状态。

这个项目是第一个做出来的画板，前期混乱是正常的。现在要做的不是否定之前的开发方式，而是给已经跑起来的东西补上工程骨架，让后续功能可以更快、更稳地长出来。
