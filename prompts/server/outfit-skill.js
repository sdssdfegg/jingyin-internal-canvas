// 批量生成提示词出口。
//
// 2026-09-26 历史：commit d4127ec 把批量侧的 SKILL / 图1图2 规则整块删掉，服务端最终提示词
// 只剩"用户原话"。副作用是：界面上选的「上装 / 下装 / 鞋子 / 上装层级」这些**用户明确输入**
// 虽然在请求里传到了服务端（`payload.outfitIntent`），却在最后一步被完全忽略 —— 这就是
// "以前换装按钮选了没用"的真正原因。
//
// 2026-09-26（本次）重新接上，但只接"用户明确选择"这一层：
//   - 结构化换装意图（更换部位 / 上装层级 / 穿法）→ 由 `src/shared/outfit-intent.js` 的
//     **唯一编译器** `compileOutfitPrompt()` 编译，前端预览与服务端发送用的是同一份实现；
//   - 不再引入任何"通用自动规则块"（旧 SKILL / masterWearingLockLines 整块模板都不回来）；
//   - 结构化选择与「智能介入」开关无关：开关关掉也照样进入提示词；
//   - 其它批量 workflow（姿态 / 扩图 / 固定背景 / 随机背景 / 改色 / 白底精修 / 换脸 /
//     设计稿 / 自定义 / 局部回贴）没有 outfitIntent，走原来的"只发用户原话"契约，行为不变。
//
// 服务端仍然是权威：非法枚举在路由层直接 400（见 server/index.js），这里再归一化一次。

import { compileOutfitPrompt, validateOutfitIntent } from "../../src/shared/outfit-intent.js";

export function primaryOutfitGenerationError(errors) {
  const list = Array.isArray(errors) ? errors.filter(Boolean) : [];
  const nonAuthError = list.find((error) => !/HTTP\s*401|invalid token|unauthorized|api key/i.test(error));
  return nonAuthError || list[list.length - 1] || list[0] || "换装生成失败";
}

/**
 * 只有用户文字时的最终提示词（历史契约，其它 workflow 继续走这里）。
 */
export function buildUserPromptOnly(payload) {
  const lines = [];
  const customPrompt = String(payload?.prompt || "").trim();
  const poseAnchorPrompt = String(payload?.poseAnchorPrompt || "").trim();
  const productNote = String(payload?.productNote || "").trim();
  if (customPrompt) lines.push(customPrompt);
  if (poseAnchorPrompt) lines.push(poseAnchorPrompt);
  if (productNote) lines.push(productNote);
  return lines.join("\n\n");
}

/**
 * 批量换装的结构化意图是否应该生效。
 * 只有"批量换装"（workflowMode === "outfit"）带 outfitIntent 时才编译；
 * 其它 workflow 一律回落到只发用户文字，避免把换装目标串到别的分区。
 */
export function usesOutfitIntent(payload) {
  if (String(payload?.workflowMode || "") !== "outfit") return false;
  const raw = payload?.outfitIntent;
  if (!raw || typeof raw !== "object") return false;
  return validateOutfitIntent(raw).ok;
}

/**
 * 批量生成的最终提示词。
 * - 批量换装 + 合法 outfitIntent → 唯一编译器（用户补充 / 本次换装目标 / 图2服装事实 / 穿法状态 / 人物基准）
 * - 其它情况 → 只发用户原话（历史契约）
 */
export function buildOutfitPrompt(payload) {
  if (!usesOutfitIntent(payload)) return buildUserPromptOnly(payload);
  const { intent } = validateOutfitIntent(payload.outfitIntent);
  return compileOutfitPrompt({
    intent,
    userPrompt: payload?.prompt,
    poseAnchorPrompt: payload?.poseAnchorPrompt,
    productNote: payload?.productNote
  }).prompt;
}
