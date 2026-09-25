# V11 ErrorBoundary 接入点验证报告

- 日期：2026-09-25
- 提交：`0218462` test(errors): 补齐 ErrorBoundary 的接入点级验证（27 → 40 项）
- 源码改动：**无**。错误边界的接入本来就在提交 `9ca9880` 里，第 5 步弹窗重构也没动它。
  本轮补的是**证据**：把"检查跑过"升级为"验到接入点在运行时确实生效"。
- 明确没混进来：**Esc 关闭 / body 滚动锁 / dialog 语义属交互变化，另立任务**；
  `masterWearingLockLines` 未启用；`buildDetailPromptGroup`、`LocalDetailPanel` 未动。

---

## 1. 接入点清单（源码证据）

| # | 边界 label | 包裹对象 | 源码位置 | 生效条件 |
|---|---|---|---|---|
| 1 | `应用主界面` | `<main className="appShell">`（整个应用主体） | `src/main.jsx:6423`（闭合 8750） | 始终挂载 |
| 2 | `批量生成` | `<OutfitWorkflow …/>` | `src/main.jsx:6635-6642` | `activeView` 为 `outfit` / `resize` |
| 3 | `图片编辑` | `<ImageEditorPanel …/>` | `src/main.jsx:6644-6655` | `activeView` 为 `image-editor` |

配套模块：`src/shared/error-boundary.jsx`（类组件，`getDerivedStateFromError` + `componentDidCatch`）、
`src/shared/error-report.js`（文案与可复制诊断，脱敏走 `sanitizeErrorText`）、
`src/styles.css` 里的 `.errorBoundaryPanel`。资源入口：
`src/main.jsx:76` 的 import，`appRoot.render(<App />)` 渲染的就是带最外层边界的树。

**覆盖范围**：最外层边界包住 App 的整棵返回树（含所有弹窗），所以任何视图/弹窗渲染期抛错都被兜住，
不会整页白屏；两个内层边界给两个重面板更细粒度的隔离（崩了只换那块，批量页/编辑页以外的部分继续可用）。

## 2. 本轮补的验证（`error-boundary-check.mjs` 27 → 40 项）

### 2.1 活树接线（关键新增）

只读遍历 React fiber：**从当前 DOM 节点的 fiber 往上找到当前根，再向下收集所有 `ErrorBoundary` 及其 label 与父边界 label**。

| 断言 | 实测 detail |
|---|---|
| 能读到 React 根（fiber 可遍历） | `rootFiberFound=true` |
| 应用主体确实在「应用主界面」边界内 | `appShellInsideMain=true` |
| 快捷页存在「应用主界面」边界 | `labels=应用主界面,图片编辑` |
| 切到批量页后挂上「批量生成」边界，且嵌在「应用主界面」内 | `parent=应用主界面` |
| 切到图片编辑后挂上「图片编辑」边界，且嵌在「应用主界面」内 | `parent=应用主界面` |
| 验证完把视图切回进入时的状态（不留副作用） | `restoredView=true` |

也就是说：不是"源码里写了标签"，而是**运行时的活树上真的挂着这三个边界、嵌套关系正确**。

> 踩坑记录：一开始只在开头抓一次 root fiber，React 更新时会替换 root fiber 对象，
> 结果"切到图片编辑"读到的是上一次的树（labels 里还是批量生成）。改成每次从当前 DOM 节点的
> fiber 往上找当前根之后才对。

### 2.2 兜底的行为契约

| 断言 | 说明 |
|---|---|
| `role=alert` + "其它功能仍可继续使用"提示 | 兜底文案明确不是整页不可用 |
| 点「重试这一块」→ 恢复渲染、清掉面板、兄弟内容仍在 | 探针的必崩子组件改成开关控制才能验证 |
| 兄弟隔离：一个边界崩了，旁边另一个边界内容仍在，且只出现 1 个兜底面板、文案是「坏区域」 | 对应批量页与编辑页并列的场景 |
| 嵌套：内层吃掉异常，外层不被触发、外层内容仍在 | 对应 主界面 > 批量生成/图片编辑 结构 |
| 诊断上报 `stage=client-render-error`，带区域名与组件栈 | 排障链路可用 |
| 上报内容与「复制诊断」文本都不含原始 KEY | 脱敏在真实渲染里也生效 |
| 点「复制诊断」不抛错且文本带区域名 | 复制入口可用 |

### 2.3 保留的原有断言

组件契约（class + `getDerivedStateFromError` + `componentDidCatch`）、
脱敏链路（边界 → `error-report` → `sanitizeErrorText`）、不把原始堆栈渲染给用户、
三种恢复入口、以及**源码接线断言**（import、`应用主界面` 包 `appShell`、
`批量生成` 包 `OutfitWorkflow`、`图片编辑` 包 `ImageEditorPanel`、边界数量 ≥ 3）。

## 3. 验证结果（全部在冻结版本上跑）

| 命令 | 结果 |
|---|---|
| `node scripts/verify/error-boundary-check.mjs` | **40/40 通过**，浏览器部分 `ran`（真实页面） |
| `npm test`（run-all 22 个脚本） | **22/22 通过，222.8s，退出 0** |
| `npm run check` | **退出 0** |
| `npm run lint` | **0 error + 26 warning（未变、基线未放宽）** |
| lint 棘轮 | **通过，无回归** |
| `npm run build` | **退出 0**，1606 modules |
| 真实数据 | `data/history.json` 指纹未变（`5B57083BC54F0DA1`）、`history-images` 12 个 |

## 4. 未验证的一项（明确标注）

**没有把崩溃注入到应用自己的子树里**（例如让 `OutfitWorkflow` 真在批量页里抛错），
因此"应用自己的组件崩了会被这三个边界接住"这一点，**是由下面三条间接证据支撑的，不是直接实测的**：

1. 源码接线断言：三个边界确实包住对应组件（标签与包裹对象都在源码里核对过）；
2. 活树 fiber 断言：这三个边界在运行时确实挂在那几个位置、嵌套关系正确；
3. 行为断言：用**应用自己的边界组件**（从 `/src/shared/error-boundary.jsx` 载入，同一个 React 运行时）
   验证了兜底/重试/隔离/嵌套/上报这一整套契约。

**为什么不直接注入**：应用没有"测试钩子"可以强制某个子树抛错；要直接实测只有两条路——
（a）临时改源码让它抛错再改回来（验证过程改源码不可接受），
（b）给应用加一个仅开发环境可用的崩溃注入开关（这是源码改动，且要你确认是否愿意长期保留）。
如果你要"直接实测"，我建议走（b）并单独作为一个任务：加一个 `window.__JINGYIN_TEST_CRASH__`
之类的只读开关（仅 dev 生效），然后让这个检查在批量页/编辑页各注入一次崩溃。

## 5. 可选的后续（未做）

- 给 `detail-main`、`reference-remix`、`resize`、`infinite-canvas` 这些视图也加细粒度边界
  （目前它们由最外层 `应用主界面` 兜住，只是崩了会换掉整个 appShell 而不是单个视图）。
- 若要统一加 Esc 关闭 / body 滚动锁 / `role="dialog"` 与焦点管理：另立任务，四处弹窗一起改并补交互测试。
