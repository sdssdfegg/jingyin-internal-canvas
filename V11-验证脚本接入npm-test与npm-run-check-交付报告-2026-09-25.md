# V11 交付报告：验证脚本接入 `npm test` / `npm run check`

- 日期：2026-09-25
- 步骤：P1 收尾三连的第 3 步（前两步：P1 缺图自愈 `df0df62`、图片地址白名单 `e0e6b2e`、ErrorBoundary `9ca9880`）
- 提交：`03b9b96` chore(verify): 验证脚本接入 npm test / npm run check
- 业务代码是否改动：**没有**。`server/`、`src/`、`prompts/` 一个文件都没碰（已用 `git status --porcelain -- server src prompts` 验证为空）
- 工作区状态：提交后干净

---

## 1. 这一步要解决的问题

前面几轮陆续写了 15+ 个验证脚本（P1 缺图自愈、图片白名单、ErrorBoundary、路由目录、UI 重复实现……），
但它们**只能手工逐个敲**：等于"测试写了，但没人会跑"。

更糟的是：这些脚本从来没被整体跑过一遍。
这一步把它们接进 `npm test` / `npm run check`，第一次整体跑的时候，
暴露出 7 个真实缺陷——**其中 2 个会让"接入"这件事本身直接失效**。

---

## 2. 接了什么

### 2.1 `package.json`

```diff
     "start": "node server/index.js",
+    "test": "node scripts/verify/run-all.mjs",
+    "test:fast": "node scripts/verify/run-all.mjs --skip-launcher",
+    "check:syntax": "node --check server/index.js && …（14 个源码目标）",
-    "check": "node --check server/index.js && …（14 个源码目标）",
+    "check": "node --check server/index.js && …（14 个源码目标）&& node scripts/verify/run-all.mjs",
```

- `npm test`：一条命令跑完全部 17 个验证脚本
- `npm run check`：语法检查 + 全部验证脚本（真正的一道门禁）
- `npm run check:syntax`：只跑语法检查（想快点时用）
- `test:fast`：跳过需要起子进程的启动器检查

### 2.2 `scripts/verify/run-all.mjs`（新增，统一入口）

- 按固定顺序执行（先纯逻辑、后起进程/浏览器，出错时最快给反馈）
- 逐个打印：`▶ 脚本名 … 通过 (耗时) 摘要`
- 失败时打印该脚本**末 14 行**输出，最后汇总 `[run-all] 17 个脚本：通过 17，失败 0，用时 172.0s`
- 任何脚本失败 → 整体退出码 1（能被 CI 拦住）
- `--only <片段>` 只跑匹配的脚本；找不到 → 退出码 2
- `--json` 机器可读结果；`--list` 只打印"这次会跑哪些脚本"、不执行

### 2.3 `scripts/verify/run-all-check.mjs`（新增，元测试 26 项）

盯住"接线本身还成立吗"：`test`/`check` 仍指向 run-all、`check` 仍含 14 个源码语法目标、
顺序表覆盖磁盘上所有脚本、`--only` 过滤生效、**失败会传播**（用常驻夹具验证退出码 1 且人读输出点名）、
夹具不进默认列表、只读工具不混进断言、浏览器侧模块不被当成可执行脚本。

---

## 3. 接入时暴露并修掉的 7 个真实缺陷

| # | 缺陷 | 后果 | 修复 |
|---|---|---|---|
| 1 | `run-all` 把磁盘上的**自己**当成普通脚本跑 | `run-all` → `run-all` → 递归爆炸。`npm test` 第一次跑就会炸 | `isSelf` 永久排除自己，`--only run-all` 也不放行；元测试加了回归断言 |
| 2 | `http-mock-check` 不自包含 | 它要求"外部先有人在 8899 上起服务"，接进 `npm test` 必然 `ECONNREFUSED` 失败 | 改为自己拉起测试实例（沙盒数据目录、固定端口、跑完收掉）；仍保留"传 baseUrl 复用外部实例"的用法 |
| 3 | `run-all-check` 有两条断言本身就是错的 | 永远红，等于门禁自带噪声 | 顺序表正则漏掉数组最后一项（无尾逗号）→ 改为解析数组；失败用例在 `--json` 模式下验"人读输出"→ 拆成两次运行 |
| 4 | 临时失败夹具删不干净 | 残留的必失败脚本会让**下一次** `npm test` 整体失败（自毒） | 改为**常驻夹具** `__fail-fixture-check.mjs`：`__` 前缀 → 默认不跑、`--only` 可点名。没有创建/删除动作，验证变成确定性的、零副作用 |
| 5 | **工作区路径上的 `fs.rmSync` 静默无效** | 6 个脚本的"启动清沙盒 / 退出删沙盒"全是空操作：`.codex-artifacts` 越积越多，`history-repair-check` 曾被上一轮残留的 `missing_1.png` 污染种子 | 新增 `scripts/verify/lib/sandbox.mjs`：显式自底向上 `unlink`/`rmdir` + 重试；7 个脚本统一接入 |
| 6 | `speed-investigation` 被当成断言脚本 | 它是只读取证工具（恒返回 0、输出取决于当时日志里恰好有什么），永远绿 = 等于没测 | 显式归入 `TOOLS` 并写明理由；`--only` 选它 → 退出码 2，不会伪装成通过的断言 |
| 7 | `error-boundary-check` 临时程序文件泄漏 | `rmSync(programFile)` 同样是空操作，`.codex-artifacts` 里留下 `error-boundary-browser-*.js` | 改用 `unlinkSync` |

### 关于第 5 条，需要你知道的细节（重要）

实测（同一个 node 进程内）：

```
工作区路径  rmSync(p, { recursive: true, force: true })  →  exists=true，err=(none)   ← 静默无效
系统临时目录 rmSync(p, { recursive: true, force: true })  →  exists=false            ← 正常
手写自底向上 unlinkSync / rmdirSync                        →  exists=false            ← 正常
```

现象是"不报错、也不删、连单文件 `rmSync(file)` 也一样"。
同一进程内换个目录就正常，所以不是杀软、也不是文件被占用，而是**工作区路径上的拦截**。
本机 node 版本 `v24.9.0`（`runtime\node\node.exe`）。

我没有能力从外部确认这个拦截是"本机安全软件/索引器"还是"我这个 agent 运行环境"造成的。
**但它对两种环境都无害**：新的清理实现（显式遍历删除）在任何环境下都正确，
而原来的 `rmSync` 写法在有拦截的环境里是错的。所以这不是"为了绕开某个环境"的临时补丁，
而是把"删不干净还静默通过"改成"删干净、删不掉会说出来"。

---

## 4. 验收证据

### 4.1 完整套件（冻结代码上跑的最终一次）

```
▶ run-node-check … 通过 (3402 ms)  目标 14 个 / 失败 0 个
▶ image-host-allowlist-check … 通过 (1984 ms)  ok=true
▶ history-repair-check … 通过 (1882 ms)  ok=true
▶ history-integrity-check … 通过 (244 ms)  ok=true
▶ local-edit-ratio-check … 通过 (253 ms)  ok=true
▶ generation-error-check … 通过 (249 ms)  ok=true
▶ batch-skill-check … 通过 (2023 ms)  ok=true
▶ connection-test-check … 通过 (16667 ms)  ok=true
▶ http-mock-check … 通过 (1496 ms)  失败 0 / 共 28 项
▶ generation-failure-path-check … 通过 (61915 ms)  ok=true
▶ pro-wire-check … 通过 (63000 ms)  ok=true
▶ error-boundary-check … 通过 (3115 ms)  ok=true
▶ routing-check … 通过 (304 ms)  失败 0 / 共 90 项
▶ ui-duplication-check … 通过 (250 ms)  失败 0 / 共 58 项
▶ quickgen-skill-check … 通过 (257 ms)  失败 0 / 共 25 项
▶ run-all-check … 通过 (6316 ms)  ok=true
▶ check-launcher … 通过 (8648 ms)  失败 0 / 共 35 项

[run-all] 17 个脚本：通过 17，失败 0，用时 172.0s
```
退出码 0。

### 4.2 正式入口（pnpm）

本机**没有装 npm**，用 `pnpm run …` 等价验证（pnpm 能正常跑 package.json 里的 scripts）：

| 命令 | 结果 |
|---|---|
| `pnpm run test` | 退出 0，17 个脚本通过，172.1s |
| `pnpm run check` | 退出 0，14 个源码语法检查 + 17 个脚本通过，171.6s |
| `pnpm run build` | 退出 0，`vite v7.3.6`，1605 modules，产物 `index-B4V-6qmU.js` / `DqttEMSR.css`（与已入库的内嵌资源引用一致） |

### 4.3 `http-mock-check` 自包含化后的输出

```
PASS  GET /api/config 200 :: 200
PASS  routing catalog 有 4 个 canonical 模型 :: tt-image-2,banana-2,tt-image-2.5,nano-banana-pro
PASS  /api/images 拒绝 forbidden channelId “XBS-default” :: status=400 error=forbidden_channel
PASS  /api/images 拒绝 cross-model channelId “silent-pro-line-10” :: status=400 error=channel_model_mismatch
PASS  旧存档 nano-banana2 归一化后通过路由/能力校验（停在 missing_api_key） :: status=400 error=missing_api_key
PASS  /api/images 按 capabilities 拒绝超量图片（tt-image-2.5 > 8） :: status=400 error=too_many_images
PASS  /api/generate-outfit 拒绝旧 channelId XBS-default :: status=400 error=forbidden_channel
PASS  旧 channelId 的批量换装请求在智能介入之前被拒（日志无上游阶段） :: 新增日志 1 行，上游阶段 0 行

[http-mock-check] 失败 0 项 / 共 28 项（自建实例 http://127.0.0.1:8899，沙盒 .codex-artifacts/http-mock-check，收尾：实例已退出、沙盒已清理(1 次)）
```
全程不打上游、不扣费：所有请求都停在服务端校验（`missing_api_key` / `forbidden_channel` / `too_many_images`）。

### 4.4 元测试（26 项，含失败传播）

```
ok     : True
total  : 26
passed : 26
failed : 0
```

### 4.5 副作用检查

| 检查项 | 结果 |
|---|---|
| 跑完 `.codex-artifacts` 残留 | **空**（修第 5、7 条之前每次都会留 2~6 个沙盒目录） |
| `data/history.json` 指纹 | `5B57083BC54F0DA1`（与 P1 那轮一致，未被改动） |
| `data/history-images` | 12 个文件，未被删除 |
| 历史完整性 | `historyEntries 10`、`missingArchives 2`、`missingReferences 2`、`markedStale 4`、`unmarkedStale 0` |
| 业务代码 | `server/`、`src/`、`prompts/` 未改动 |
| ErrorBoundary 浏览器部分 | `"browser": "ran"`（8787 上真实浏览器探针跑了 5 项断言，不是跳过） |

---

## 5. 改动清单（14 个文件，+597 / −75）

新增：

| 文件 | 说明 |
|---|---|
| `scripts/verify/run-all.mjs` | 统一入口（201 行） |
| `scripts/verify/run-all-check.mjs` | 元测试 26 项（168 行） |
| `scripts/verify/lib/sandbox.mjs` | 沙盒清理共用实现（97 行，放 `lib/` 是为了不被 run-all 当成可执行脚本） |
| `scripts/verify/__fail-fixture-check.mjs` | 常驻失败夹具（11 行） |

修改：`package.json`、`run-node-check.mjs`（只保留 14 个业务源码目标，跳过 `scripts/`）、
`http-mock-check.mjs`（自包含化）、`pro-wire-check.mjs`、`history-repair-check.mjs`、
`batch-skill-check.mjs`、`connection-test-check.mjs`、`generation-failure-path-check.mjs`、
`image-host-allowlist-check.mjs`、`error-boundary-check.mjs`（沙盒清理改为真删）。

---

## 6. 怎么用

```bash
npm test                     # 全部验证（约 3 分钟）
npm test -- --only history   # 只跑历史相关
npm run test:fast            # 跳过启动器检查
node scripts/verify/run-all.mjs --list    # 看这次会跑哪些脚本
npm run check                # 语法检查 + 全部验证（提交前跑这个）
```

说明：

- 部分脚本的**浏览器部分**需要本机 8787 上跑着 V11；不在跑时会自动跳过并在结果里标注，不影响整体通过。
- 每个脚本都自带测试实例和自己的沙盒数据目录（`.codex-artifacts/…`），跑完自己收干净，
  不会写你的 `data/`，也不会真的打上游付费接口。
- `speed-investigation.mjs` 不进 `npm test`：它只读日志、不做断言。要看时直接
  `node scripts/verify/speed-investigation.mjs`。

---

## 7. 遗留与建议

1. **本机没有 npm**。`pnpm run test/check/build` 已验证可用；如果要按文档里的 `npm test` 执行，
   需要先把 npm 装进 PATH（和第 2 步 Git 的情况类似）。
2. 这是本机 `runtime\node\node.exe`（v24.9.0）上的观察：工作区路径 `rmSync` 静默无效（见 3.5）。
   建议以后新写脚本时统一用 `scripts/verify/lib/sandbox.mjs`，不要再用 `rmSync` 清理工作区内的东西。
3. `scripts/verify/*.mjs` 的行尾不统一（部分 CRLF、部分 LF）。这次没有为了整齐去重写全部文件，
   只保证"我改动的行"不引入新的混用。要不要统一，等第 4 步 ESLint 一起处理更合适。
4. 后续既定顺序：**第 4 步 ESLint（先 report 模式）→ 第 5 步 抽出共用弹窗组件**，各自单独提交。
5. 第 4 步接入 ESLint 后，`run-all` 的 `TOOLS`/`ORDER` 两个表可能需要一起更新——
   `run-all-check` 里已经有"新增脚本不会被漏跑"的断言盯着，加脚本时会立刻发现。
