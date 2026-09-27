// 批量生成提示词出口。
//
// 2026-09-26 历史：commit d4127ec 把批量侧的 SKILL / 图1图2 规则整块删掉，服务端最终提示词
// 只剩"用户原话"。副作用是：界面上选的「上装 / 下装 / 鞋子 / 上装层级」这些**用户明确输入**
// 虽然在请求里传到了服务端（`payload.outfitIntent`），却在最后一步被完全忽略 —— 这就是
// "以前换装按钮选了没用"的真正原因。
//
// 2026-09-26（本次）重新接上，但只接"用户明确选择"这一层：
//   - 结构化换装意图（更换部位 / 上装层级 / 穿法）→ 由 `src/shared/outfit-intent.js` 的
//     **唯一编译器** `compileOutfitPrompt()` 编译；
//   - 前端把编译结果直接写进「通用换装提示词」框（用户可手改），请求里的 `payload.prompt`
//     就是最终正文，服务端原样转发；前端没给正文时服务端用同一个编译器兜底；
//   - 不再引入任何"通用自动规则块"（旧 SKILL / masterWearingLockLines 整块模板都不回来）；
//   - 补充提示词只在前端并进正文一次，服务端不再重复追加（避免同一段发两遍）；
//   - 其它批量 workflow（姿态 / 扩图 / 固定背景 / 随机背景 / 改色 / 白底精修 / 换脸 /
//     设计稿 / 自定义 / 局部回贴）没有 outfitIntent，走原来的"只发用户原话"契约，行为不变。
//
// 服务端仍然是权威：非法枚举在路由层直接 400（见 server/index.js），这里再归一化一次。

import { compileOutfitPrompt, validateOutfitIntent } from "../../src/shared/outfit-intent.js";
import { compileRetouchPrompt, validateRetouchIntent } from "../../src/shared/retouch-intent.js";

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
 * 服装精修（原「批量白底图精修」）的结构化意图是否应该生效。
 * 只有 workflowMode === "white-refine" 带合法 retouchIntent 时才编译。
 */
export function usesRetouchIntent(payload) {
  if (String(payload?.workflowMode || "") !== "white-refine") return false;
  const raw = payload?.retouchIntent;
  if (!raw || typeof raw !== "object") return false;
  return validateRetouchIntent(raw).ok;
}

/**
 * 服装精修的最终提示词：由共享的唯一编译器生成（前端预览用的是同一个函数）。
 *
 * 与换装的区别：精修页的「通用白底精修提示词」是**用户自己的输入**（不是编译结果），
 * 所以这里必须编译，而不是像换装那样原样转发 payload.prompt。
 * 页面提示词如果还是系统内置默认词，编译器会忽略它（固定段已覆盖同样内容），避免同义重复。
 */
export function buildRetouchPrompt(payload) {
  const { intent } = validateRetouchIntent(payload.retouchIntent);
  const compiled = compileRetouchPrompt({
    intent,
    userPrompt: payload?.prompt,
    productNote: payload?.productNote
  });
  const poseAnchorPrompt = String(payload?.poseAnchorPrompt || "").trim();
  return [compiled.prompt, poseAnchorPrompt].filter(Boolean).join("\n\n");
}

/**
 * 批量生成的最终提示词。
 *
 * 2026-09-26（本轮调整，按用户要求）：
 *   批量换装的「通用换装提示词」框现在**就是真正发送的内容** —— 前端已经把它按
 *   「换装设置 + 图2服装事实 + 补充提示词」生成好，并且用户可以在这个框里手动增删调整。
 *   所以服务端这一层改成：
 *     1. 客户端给了提示词正文 → 原样使用（尊重用户的手改）；
 *     2. 客户端没给正文（其它客户端/脚本）→ 用唯一编译器从 outfitIntent 兜底生成，
 *        保证服务端单独也能产出正确的结构化提示词；
 *     3. 两种情况都不再重复追加 `productNote` —— 补充提示词已经在前端并进正文了，
 *        这里再加一次就是重复发送（用户明确要求不能重复）；
 *     4. 「智能介入」的 poseAnchorPrompt 仍然追加，它不属于补充提示词。
 *
 * 服装精修（white-refine + retouchIntent）走 buildRetouchPrompt()：
 * 页面提示词是用户输入，所以由本层用共享编译器编译，保证"预览 == 实际发送"。
 *
 * 其它情况（既没有合法 outfitIntent 也没有合法 retouchIntent 的批量 workflow）
 * → 只发用户原话（历史契约，行为不变）。
 */
export function buildOutfitPrompt(payload) {
  if (usesRetouchIntent(payload)) return buildRetouchPrompt(payload);
  if (!usesOutfitIntent(payload)) return buildUserPromptOnly(payload);
  const { intent } = validateOutfitIntent(payload.outfitIntent);
  const clientPrompt = String(payload?.prompt || "").trim();
  const base = clientPrompt || compileOutfitPrompt({ intent }).prompt;
  const poseAnchorPrompt = String(payload?.poseAnchorPrompt || "").trim();
  return [base, poseAnchorPrompt].filter(Boolean).join("\n\n");
}
