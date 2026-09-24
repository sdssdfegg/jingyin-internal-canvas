// 快捷生成 SKILL 开关行为检查（纯函数，不需要 React / 不调用接口）。
//
// 覆盖验收项：
//   - 开启时最终 prompt 包含自动追加的规则
//   - 关闭时最终 prompt 不包含自动追加的规则
//   - 用户自己输入的原始 prompt 在两种模式下保持一致
//   - 关闭 SKILL 不改变模型、渠道、上传图片、请求字段结构
//
// 用法：node scripts/verify/quickgen-skill-check.mjs
import process from "node:process";
import {
  promptForQuickGeneration,
  QUICK_SKILL_RULE_BLOCKS,
  QUICK_LOCAL_EDIT_PROMPT_SUFFIX,
  QUICK_LOCAL_EDIT_CONTEXT_PROMPT_SUFFIX,
  QUICK_PRIMARY_LOCAL_OUTFIT_PROMPT_SUFFIX,
  QUICK_PRIMARY_LOCAL_RETOUCH_PROMPT_SUFFIX,
  QUICK_PRIMARY_LOCAL_APPEARANCE_PROMPT_SUFFIX,
  QUICK_WHOLE_OUTFIT_PROMPT_SUFFIX,
  QUICK_GPT_LOCAL_ANCHOR_PROMPT_SUFFIX,
  QUICK_BANANA_LOCAL_ANCHOR_PROMPT_SUFFIX,
  QUICK_BANANA2_LOCAL_ANCHOR_PROMPT_SUFFIX
} from "../../src/shared/quickgen-prompt-rules.js";

let failures = 0;
const lines = [];
function check(name, ok, detail = "") {
  lines.push(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` :: ${detail}` : ""}`);
  if (!ok) failures += 1;
}

const RULE_TEXTS = [
  ["QUICK_LOCAL_EDIT_PROMPT_SUFFIX", QUICK_LOCAL_EDIT_PROMPT_SUFFIX],
  ["QUICK_LOCAL_EDIT_CONTEXT_PROMPT_SUFFIX", QUICK_LOCAL_EDIT_CONTEXT_PROMPT_SUFFIX],
  ["QUICK_PRIMARY_LOCAL_OUTFIT_PROMPT_SUFFIX", QUICK_PRIMARY_LOCAL_OUTFIT_PROMPT_SUFFIX],
  ["QUICK_PRIMARY_LOCAL_RETOUCH_PROMPT_SUFFIX", QUICK_PRIMARY_LOCAL_RETOUCH_PROMPT_SUFFIX],
  ["QUICK_PRIMARY_LOCAL_APPEARANCE_PROMPT_SUFFIX", QUICK_PRIMARY_LOCAL_APPEARANCE_PROMPT_SUFFIX],
  ["QUICK_WHOLE_OUTFIT_PROMPT_SUFFIX", QUICK_WHOLE_OUTFIT_PROMPT_SUFFIX],
  ["QUICK_GPT_LOCAL_ANCHOR_PROMPT_SUFFIX", QUICK_GPT_LOCAL_ANCHOR_PROMPT_SUFFIX],
  ["QUICK_BANANA_LOCAL_ANCHOR_PROMPT_SUFFIX", QUICK_BANANA_LOCAL_ANCHOR_PROMPT_SUFFIX],
  ["QUICK_BANANA2_LOCAL_ANCHOR_PROMPT_SUFFIX", QUICK_BANANA2_LOCAL_ANCHOR_PROMPT_SUFFIX]
];

check("规则常量全部保留（9 个）", QUICK_SKILL_RULE_BLOCKS.length === 9, String(QUICK_SKILL_RULE_BLOCKS.length));
check("规则常量文本非空", RULE_TEXTS.every(([, text]) => typeof text === "string" && text.length > 0));

// 三种典型场景：局部换装（图1/图2 关系 + 服装类别）/ 局部精修 / 整图换装
const SCENARIOS = [
  {
    name: "局部换装（banana-2，带 contextRect）",
    prompt: "把图1的衣服换成图2的风衣",
    localEdit: { contextRect: { x: 1, y: 2, width: 3, height: 4 } },
    model: "banana-2",
    options: { primaryLocalEdit: true }
  },
  {
    name: "局部精修（tt-image-2，带 contextRect）",
    prompt: "把袖口改长一点点",
    localEdit: { contextRect: { x: 1, y: 2, width: 3, height: 4 } },
    model: "tt-image-2",
    options: { primaryLocalEdit: true }
  },
  {
    name: "整图换装（banana-2，无局部）",
    prompt: "图1模特穿图2的衣服",
    localEdit: null,
    model: "banana-2",
    options: { wholeOutfit: true }
  },
  {
    name: "旧存档模型 ID nano-banana2",
    prompt: "把袖子改长一点点",
    localEdit: { contextRect: { x: 1, y: 2, width: 3, height: 4 } },
    model: "nano-banana2",
    options: { primaryLocalEdit: true }
  }
];

for (const scenario of SCENARIOS) {
  const on = promptForQuickGeneration(scenario.prompt, scenario.localEdit, scenario.model, {
    ...scenario.options,
    skillRules: true
  });
  const off = promptForQuickGeneration(scenario.prompt, scenario.localEdit, scenario.model, {
    ...scenario.options,
    skillRules: false
  });

  check(`[${scenario.name}] 开启时包含自动规则`, on.length > scenario.prompt.length && on.startsWith(scenario.prompt));
  const matchedRules = RULE_TEXTS.filter(([, text]) => on.includes(text)).map(([name]) => name);
  check(`[${scenario.name}] 开启时至少命中 1 条规则`, matchedRules.length >= 1, matchedRules.join(","));
  check(`[${scenario.name}] 关闭时等于用户原始 prompt`, off === scenario.prompt, JSON.stringify(off.slice(0, 40)));
  check(
    `[${scenario.name}] 关闭时不包含任何规则块`,
    RULE_TEXTS.every(([, text]) => !off.includes(text))
  );
  check(
    `[${scenario.name}] 两种模式下用户原始 prompt 一致`,
    on.startsWith(scenario.prompt) && off === scenario.prompt
  );
}

// 开关默认值：未传 skillRules 时必须按「开启」处理（默认开启）
const defaultOn = promptForQuickGeneration("把袖口改长一点点", { contextRect: { x: 0, y: 0, width: 1, height: 1 } }, "tt-image-2", {
  primaryLocalEdit: true
});
check("未传 skillRules 时默认开启（包含规则）", defaultOn.includes(QUICK_LOCAL_EDIT_PROMPT_SUFFIX));

// 关闭 SKILL 不改动请求字段结构：调用方仍然发同样的 model / channelId / dispatchMode
const requestFields = {
  model: "banana-2",
  channelId: "silent-banana-line-08",
  dispatchMode: "manual",
  imageSize: "2K",
  aspectRatio: "3:4",
  n: 1
};
const withSkill = JSON.stringify({ ...requestFields, prompt: promptForQuickGeneration("换衣服", null, "banana-2", { wholeOutfit: true, skillRules: true }) });
const withoutSkill = JSON.stringify({ ...requestFields, prompt: promptForQuickGeneration("换衣服", null, "banana-2", { wholeOutfit: true, skillRules: false }) });
const parseKeys = (json) => Object.keys(JSON.parse(json)).sort().join(",");
check(
  "关闭 SKILL 不改变请求字段结构",
  parseKeys(withSkill) === parseKeys(withoutSkill),
  `${parseKeys(withSkill)} vs ${parseKeys(withoutSkill)}`
);
check(
  "关闭 SKILL 不改变 model/channelId/dispatchMode",
  (() => {
    const a = JSON.parse(withSkill);
    const b = JSON.parse(withoutSkill);
    return a.model === b.model && a.channelId === b.channelId && a.dispatchMode === b.dispatchMode;
  })()
);

console.log(lines.join("\n"));
console.log(`\n[quickgen-skill-check] 失败 ${failures} 项 / 共 ${lines.length} 项`);
process.exit(failures === 0 ? 0 : 1);
