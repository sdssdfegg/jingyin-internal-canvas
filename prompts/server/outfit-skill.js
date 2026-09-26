// 批量生成提示词出口。
//
// 2026-09-26：**SKILL / 图1图2 规则已整体删除**。
// 用户实测"不加 SKILL 和图1/图2 的规则效果更好"，要求把批量侧的「换装规则」开关与背后的
// 规则一起删掉（快捷侧的「换装」按钮同理，见 src/shared/quickgen-prompt-rules.js）。
//
// 现在的契约（唯一一条）：
//   - 服务端发给模型的提示词 = 用户自己输入的文字，逐字符不改：
//     原始提示词 + 姿态锚点智能文本（智能介入生成）+ 场景补充；
//   - 不再追加批量换装 Skill、图1/图2 关系、服装类别、成衣比例/长度、模型适配等任何规则块；
//   - 不改模型、渠道、上传图片、尺寸/比例等其它请求字段。
//
// 保留 `buildUserPromptOnly` 这个名字是有意的：它的语义就是"只有用户输入的文字"。

export function primaryOutfitGenerationError(errors) {
  const list = Array.isArray(errors) ? errors.filter(Boolean) : [];
  const nonAuthError = list.find((error) => !/HTTP\s*401|invalid token|unauthorized|api key/i.test(error));
  return nonAuthError || list[list.length - 1] || list[0] || "换装生成失败";
}

/**
 * 最终提示词：**只有用户自己输入的文字**。
 * 不含任何自动追加的规则块，也不动模型/渠道/图片等其它请求字段。
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
 * 批量生成的最终提示词。
 *
 * 历史上有过一层"按 workflow 分派规则构建器"的实现（`buildOutfitPrompt` 会拼
 * 批量换装 Skill / 图3 门控 / 服装类别 / 成衣比例长度 等），已按用户要求删除；
 * 这里保留函数名，调用方（server/index.js 的路由预检与真实请求）不用改。
 */
export function buildOutfitPrompt(payload) {
  return buildUserPromptOnly(payload);
}
