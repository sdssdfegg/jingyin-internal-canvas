// 快捷生成「提示词只发用户原话」检查（纯函数，不需要 React / 不调用接口）。
//
// 2026-09-26：SKILL / 图1图2 规则已整体删除（快捷侧的「换装」开关也不存在了）。
// 本检查钉住新契约：
//   - `promptForQuickGeneration(prompt)` 就是 `prompt.trim()`，不拼接任何后缀；
//   - 传什么场景参数都一样（旧参数 shape 也不会让它追加文本）；
//   - 旧规则块常量必须已经消失（防止有人留下"半条规则"）；
//   - `classifyQuickPrimaryLocalIntent` 仍在（它不是规则，只用于上传/回贴链路分支判断）。
//
// 用法：node scripts/verify/quickgen-prompt-passthrough-check.mjs
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  promptForQuickGeneration,
  classifyQuickPrimaryLocalIntent
} from "../../src/shared/quickgen-prompt-rules.js";

const ROOT = process.cwd();
const rulesSource = readFileSync(path.join(ROOT, "src", "shared", "quickgen-prompt-rules.js"), "utf8");

let failures = 0;
const lines = [];
function check(name, ok, detail = "") {
  lines.push(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` :: ${detail}` : ""}`);
  if (!ok) failures += 1;
}

// 已删除的规则块常量名：共享模块里不该再出现
const REMOVED_RULE_CONSTANTS = [
  "QUICK_LOCAL_EDIT_PROMPT_SUFFIX",
  "QUICK_LOCAL_EDIT_CONTEXT_PROMPT_SUFFIX",
  "QUICK_PRIMARY_LOCAL_RETOUCH_PROMPT_SUFFIX",
  "QUICK_PRIMARY_LOCAL_OUTFIT_PROMPT_SUFFIX",
  "QUICK_PRIMARY_LOCAL_APPEARANCE_PROMPT_SUFFIX",
  "QUICK_WHOLE_OUTFIT_PROMPT_SUFFIX",
  "QUICK_GPT_LOCAL_ANCHOR_PROMPT_SUFFIX",
  "QUICK_BANANA_LOCAL_ANCHOR_PROMPT_SUFFIX",
  "QUICK_BANANA2_LOCAL_ANCHOR_PROMPT_SUFFIX",
  "QUICK_SKILL_RULE_BLOCKS"
];
for (const name of REMOVED_RULE_CONSTANTS) {
  check(`规则块常量已删除：${name}`, !rulesSource.includes(name));
}

// 旧规则正文里的特征字句：任何输出里都不该出现
const REMOVED_RULE_TEXT_MARKERS = [
  "局部编辑任务：当前参考图是从原图中裁剪出的局部区域。",
  "【图1局部换装】",
  "【图1局部换样貌/换发型】",
  "【快捷整图换装】",
  "GPT 局部编辑：按图层逻辑执行",
  "Nano Banana 局部编辑：把图1当作姿态和坐标模板"
];

// 各种历史用法（局部换装 / 局部精修 / 换样貌 / 整图换装 / 旧模型 ID / 旧参数 shape）
const SCENARIOS = [
  { name: "局部换装（banana-2，带 contextRect）", prompt: "把图1的衣服换成图2的风衣", localEdit: { contextRect: { x: 1, y: 2, width: 3, height: 4 } }, model: "banana-2", options: { primaryLocalEdit: true, localIntent: "outfit" } },
  { name: "局部精修（tt-image-2，带 contextRect）", prompt: "把袖口改长一点点", localEdit: { contextRect: { x: 1, y: 2, width: 3, height: 4 } }, model: "tt-image-2", options: { primaryLocalEdit: true, localIntent: "retouch" } },
  { name: "局部换样貌（banana-2）", prompt: "把图1的脸换成图2的样子", localEdit: { contextRect: null }, model: "banana-2", options: { primaryLocalEdit: true, localIntent: "appearance" } },
  { name: "整图换装（banana-2，无局部）", prompt: "图1模特穿图2的衣服", localEdit: null, model: "banana-2", options: { wholeOutfit: true } },
  { name: "旧存档模型 ID nano-banana2", prompt: "把袖子改长一点点", localEdit: { contextRect: { x: 1, y: 2, width: 3, height: 4 } }, model: "nano-banana2", options: { primaryLocalEdit: true } },
  { name: "旧参数 shape（skillRules:true）", prompt: "换衣服", localEdit: null, model: "banana-2", options: { wholeOutfit: true, skillRules: true } }
];

for (const scenario of SCENARIOS) {
  const text = promptForQuickGeneration(scenario.prompt, scenario.localEdit, scenario.model, scenario.options);
  check(`[${scenario.name}] 输出逐字等于用户提示词`, text === scenario.prompt, JSON.stringify(text.slice(0, 60)));
  const hits = REMOVED_RULE_TEXT_MARKERS.filter((marker) => text.includes(marker));
  check(`[${scenario.name}] 不含任何已删除的规则正文`, hits.length === 0, hits.join("|"));
}

// 只有一个参数时（现在的调用方式）行为一致
check("只传 prompt 时同样逐字返回", promptForQuickGeneration("把袖子改长一点点") === "把袖子改长一点点");
check("首尾空白会被 trim（唯一的变化）", promptForQuickGeneration("  换衣服  ") === "换衣服");
check("空 / undefined 安全", promptForQuickGeneration("") === "" && promptForQuickGeneration(undefined) === "");

// 请求字段结构不变：提示词出口只影响 prompt 一项
const requestFields = {
  model: "banana-2",
  channelId: "silent-banana-line-08",
  dispatchMode: "manual",
  imageSize: "2K",
  aspectRatio: "3:4",
  n: 1
};
const builtRequest = JSON.stringify({ ...requestFields, prompt: promptForQuickGeneration("换衣服") });
const parseKeys = (json) => Object.keys(JSON.parse(json)).sort().join(",");
check("请求字段结构不变（只有 prompt 被赋值）",
  parseKeys(builtRequest) === "aspectRatio,channelId,dispatchMode,imageSize,model,n,prompt",
  parseKeys(builtRequest));

// 局部意图判定仍然可用（它只做分支判断，不产生文本）
check("局部意图判定：换装 = outfit", classifyQuickPrimaryLocalIntent("把图1的衣服换成图2的风衣") === "outfit");
check("局部意图判定：细节 = retouch", classifyQuickPrimaryLocalIntent("把袖口改长一点点") === "retouch");
check("局部意图判定：换脸 = appearance", classifyQuickPrimaryLocalIntent("把图1的脸换成图2的样子") === "appearance");

console.log(lines.join("\n"));
console.log(`\n[quickgen-prompt-passthrough-check] 失败 ${failures} 项 / 共 ${lines.length} 项`);
process.exit(failures === 0 ? 0 : 1);
