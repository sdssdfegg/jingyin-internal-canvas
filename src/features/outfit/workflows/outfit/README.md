# 换装 workflow

| 项 | 内容 |
| --- | --- |
| tab | 换装（2026-09-26 前叫「批量换装」，旧名字仍作为别名识别并自动迁移） |
| workflowMode | `outfit` |
| 当前代码 | `src/outfit-workflow.jsx` |
| 搜索词 | `DEFAULT_OUTFIT_PAGE_NAME`、`OUTFIT_DEFAULT_PROMPT`、`isOutfitWorkflow`、`outfitIntent` |
| 前端 API | `src/api/outfit.js` 的 `generateOutfit()` / `analyzeOutfitMasterFit()` |
| 本地接口 | `/api/generate-outfit`、`/api/outfit-master-fit-analysis` |
| 后端提示词出口 | `prompts/server/outfit-skill.js` |
| **结构化意图与编译器（唯一来源）** | `src/shared/outfit-intent.js` |
| 样式 | `src/features/outfit/outfit-intent.css` |
| 验证脚本 | `scripts/verify/outfit-intent-check.mjs`（纯逻辑）、`scripts/verify/outfit-intent-request-check.mjs`（mock 上游，钉住真正发出去的提示词） |

图1是模特/主体图，图2是服装图，图3是可选参考图。这个 workflow 是其他批量分区的主模板，改通用上传、任务队列、结果卡时要同步检查其他 workflow。

## 结构化换装设置（2026-09-26 重做）

用户在这页做的选择不再只是"发一句用户原话"，而是先变成一个结构化对象 `outfitIntent`：

```js
{
  parts: ["upper", "lower", "shoes"],          // 更换部位（多选，至少一个）
  upperLayer: "auto|single|inner|outer|inner-outer",  // 上装层级（仅选上装时）
  wearing: { mode: "follow|natural|custom", values: { closure, outerState, hem, sleeve, collar, fit, waistband, lowerHem } },
  facts: { category, color, material, silhouette, length, collarSleeve, sleeveState, closure, hem, lowerType, shoeType, structure },
  factsSource: { mode: "none|auto|manual", sourceId, analyzedAt }
}
```

数据流（每一层都必须保持接通，缺一层就是"选了没用"）：

```
界面（更换部位/上装层级/穿法/图2事实）
  → settings.outfitIntent（唯一来源，持久化在页面设置里）
  → buildTasks() 冻结进每个任务快照 task.outfitIntent（批次开始后再改界面只影响下一批）
  → POST /api/generate-outfit 的 payload.outfitIntent（不再发旧的 garmentParts/garmentLengths/masterFitSpec）
  → 服务端 validateOutfitIntent() 权威校验（非法枚举 400 invalid_outfit_intent）
  → compileOutfitPrompt() 生成最终提示词
  → 发给模型
```

最终提示词顺序（由 `compileOutfitPrompt()` 唯一决定，前端预览与后端发送用的是同一个函数）：

```
【用户补充】     用户原话 + 智能介入文本 + 场景补充（原样保留）
【本次换装目标】 让图1模特穿着图2的…。 + 未选部位"图1的…保持不变。"
【图2服装事实】  只保留本次选中部位的事实（没有就整段省略）
【穿法状态】     跟随图2 / 常规自然穿着 / 自定义锁定
【人物基准】     图1是唯一人物身份、人体结构和姿势基准，不改变图1人物的身份、骨骼和姿势。
```

## 这一页的硬约束

0. **更换部位**：上装 / 下装 / 连衣裙 / 鞋子（2026-09-26 新增连衣裙、默认选中上装）。
   上装层级只有 `仅一件上装 / 仅内搭 / 仅外套 / 内搭+外套`（**已删除"自动识别图2"**，默认"仅一件上装"）。
   选了连衣裙时不再写"上装/下装保持不变"（连衣裙本身就是一件式）；鞋子永远不写进保持句。
1. **只允许一个编译器**：任何拼提示词的地方都必须调用 `src/shared/outfit-intent.js` 的
   `compileOutfitPrompt()`；不允许在按钮事件里再拼一份近似文案。
2. **结构化选择属于用户明确输入**：即使通用自动规则（智能介入 / 旧 SKILL 开关）关闭，也必须进入提示词。
3. **图2分析只产出结构化事实**：不再产出"整段母版提示词"，也不允许把整段分析文本直接拼进最终提示词。
   分析不确定的字段写"未识别"，不补全。
4. **旧字段只做安全读取**：旧存档里的 `garmentLengths` / `masterFitLock` / `masterFitSpec` /
   `masterFitSourceId` 可以留在对象里，但不得影响任何行为，也不得覆盖 `outfitIntent`。
   旧 UI（单件上衣 / 外套+内搭 / 套装、上装长度 / 下装长度、母版锁版型）已删除，不要恢复。
5. **不再有 masterWearingLockLines 之类的整块模板**：规则只以"结构化选择 + 图2事实"的形式进入。
6. **图1～图3 上传区不动**：上传/删除/预览/拖拽/裁剪/局部回贴/顺序/角色都不属于这次改造范围。
7. **改这页要跑**：`npm run check`（含两个 outfit-intent 脚本）与 `npm run build`。
