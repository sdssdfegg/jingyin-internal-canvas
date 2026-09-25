// 快捷生成 UI 去重检查（静态解析 JSX，不启动浏览器）。
//
// 覆盖验收项：
//   - 页面没有重复的清空图片 / 提示词助手 / 优化提示词按钮
//   - 四个功能（清空图片 / 提示词助手 / 优化提示词 / 线路价格）在快捷悬浮框里各只有一套入口
//   - 只删了重复 UI，底层能力函数仍在
//
// 用法：node scripts/verify/ui-duplication-check.mjs
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
let failures = 0;
const lines = [];
function check(name, ok, detail = "") {
  lines.push(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` :: ${detail}` : ""}`);
  if (!ok) failures += 1;
}

const mainJsx = readFileSync(path.join(root, "src", "main.jsx"), "utf8");

// 切出「快捷生成图片模式的悬浮框底部工具区」这一段。
const clusterIndex = mainJsx.indexOf('className="quickToolCluster"');
check("找到快捷悬浮框功能组", clusterIndex > 0);
const footerStart = mainJsx.lastIndexOf('className="composerFooter"', clusterIndex);
const footerEnd = mainJsx.indexOf("</section>", clusterIndex);
const footer = mainJsx.slice(footerStart, footerEnd);
check("成功切出快捷悬浮框底部工具区", footer.length > 200, `len=${footer.length}`);

function countIn(text, token) {
  return text.split(token).length - 1;
}

// 1) 四个功能在悬浮框里各只有一套入口
check("清空图片入口只有 1 个", countIn(footer, 'title="清空图片"') === 1, String(countIn(footer, 'title="清空图片"')));
check("提示词助手入口只有 1 个", countIn(footer, 'title="提示词助手"') === 1, String(countIn(footer, 'title="提示词助手"')));
check("优化提示词入口只有 1 个", countIn(footer, 'title="优化提示词"') === 1, String(countIn(footer, 'title="优化提示词"')));
check("线路价格入口只有 1 个", countIn(footer, 'aria-label="线路价格"') === 1, String(countIn(footer, 'aria-label="线路价格"')));

// 2) 旧入口（底部左右两侧的按钮）已删除
check("底部不再有 <span>清空图片</span> 旧入口", countIn(footer, "<span>清空图片</span>") === 0);
check("底部不再有 <span>优化提示词</span> 旧入口", countIn(footer, "<span>优化提示词</span>") === 0);
check("底部不再有 <span>词</span> 旧入口", countIn(footer, "<span>词</span>") === 0);

// 3) 快捷生成页面其它位置也没有同一功能的第二套按钮
//    参考生图 / 一键详情 属于独立模块，不在快捷生成页，排除。
const quickgenAreaStart = mainJsx.indexOf("className={`composer ${isComposerDragging");
const quickgenAreaEnd = mainJsx.indexOf("{events.length > 0 && (", quickgenAreaStart);
const quickgenSection = mainJsx.slice(quickgenAreaStart, quickgenAreaEnd);
check("快捷生成悬浮框内没有第二套清空图片按钮", countIn(quickgenSection, "<span>清空图片</span>") === 0);
check("快捷生成悬浮框内没有第二套优化提示词按钮", countIn(quickgenSection, "<span>优化提示词</span>") === 0);
check("快捷生成悬浮框内没有第二套词按钮", countIn(quickgenSection, "<span>词</span>") === 0);

// 4) SKILL 开关存在、默认开启、状态持久化
const settingsStateStart = mainJsx.indexOf("const defaultState = {");
const settingsStateEnd = mainJsx.indexOf("};", settingsStateStart);
const defaultStateBlock = mainJsx.slice(settingsStateStart, settingsStateEnd);
check("defaultState 里 skillRulesEnabled 默认 true", /skillRulesEnabled:\s*true/.test(defaultStateBlock));
check("快捷悬浮框里有 SKILL 开关按钮", footer.includes('className={`skillToggleButton'));
// 2026-09-25：按钮文案由「快捷生成规则 / SKILL」改为「换装」（开关状态与持久化行为不变）。
check("快捷悬浮框开关文案为「换装」", footer.includes("<span>换装</span>"));
check("旧的「快捷生成规则 / SKILL」文案已不存在", !footer.includes("快捷生成规则 / SKILL"));

const storageEffect = mainJsx.slice(mainJsx.indexOf("writeJsonStorage(STORAGE_KEY, settings)") - 400, mainJsx.indexOf("writeJsonStorage(STORAGE_KEY, settings)") + 200);
check("settings 会写回本地存档（状态持久化）", storageEffect.includes("writeJsonStorage(STORAGE_KEY, settings)"));
check("loadState 归一化 skillRulesEnabled", /merged\.skillRulesEnabled\s*=\s*merged\.skillRulesEnabled\s*!==\s*false/.test(mainJsx));

// 5) 底层能力函数没有被删除
for (const fn of ["function optimizePrompt", "setIsPromptAssistantOpen", "setFiles([])"]) {
  check(`底层能力仍在：${fn}`, mainJsx.includes(fn));
}

// 6) 规则常量搬到了独立模块，且 main.jsx 不再重复定义
const rulesModule = readFileSync(path.join(root, "src", "shared", "quickgen-prompt-rules.js"), "utf8");
for (const constantName of [
  "QUICK_LOCAL_EDIT_PROMPT_SUFFIX",
  "QUICK_LOCAL_EDIT_CONTEXT_PROMPT_SUFFIX",
  "QUICK_PRIMARY_LOCAL_RETOUCH_PROMPT_SUFFIX",
  "QUICK_PRIMARY_LOCAL_OUTFIT_PROMPT_SUFFIX",
  "QUICK_PRIMARY_LOCAL_APPEARANCE_PROMPT_SUFFIX",
  "QUICK_WHOLE_OUTFIT_PROMPT_SUFFIX",
  "QUICK_GPT_LOCAL_ANCHOR_PROMPT_SUFFIX",
  "QUICK_BANANA_LOCAL_ANCHOR_PROMPT_SUFFIX",
  "QUICK_BANANA2_LOCAL_ANCHOR_PROMPT_SUFFIX"
]) {
  check(`规则常量保留在共享模块：${constantName}`, rulesModule.includes(`export const ${constantName}`));
  check(`main.jsx 不再重复定义：${constantName}`, !mainJsx.includes(`const ${constantName} =`));
}

// 7) 2026-09-25 UI 调整：悬浮框里这四类重复入口必须消失
check("悬浮框不再有「图片生成」页签 JSX", !/className="modeTab active"[\s\S]{0,80}图片生成/.test(quickgenSection));
check("悬浮框不再有「视频生成」页签 JSX", !/className="modeTab"[\s\S]{0,120}视频生成/.test(quickgenSection));
check("悬浮框不再有 .modeTabs 容器", !quickgenSection.includes('className="modeTabs"'));
check("悬浮框不再有可见「上传」按钮", !/<span>上传 \(/.test(footer));
check("悬浮框不再有可见「库」按钮", !/<span>库<\/span>/.test(footer));
check("隐藏 file input 仍保留（上传能力不删）", footer.includes('type="file"'));
check(
  "顶部结果栏仍保留 图片/视频 切换入口（能力不删）",
  /setQuickMode\("video"\)/.test(mainJsx) && /setQuickMode\("image"\)/.test(mainJsx)
);

// 8) 悬浮框尺寸稳定性：min-width / min-height 必须是固定值
const cssText = readFileSync(path.join(root, "src", "styles.css"), "utf8");
const composerBlock = cssText.slice(cssText.indexOf(".composer {"), cssText.indexOf(".composer {") + 700);
check("悬浮框有 min-width", /min-width:\s*\d+px/.test(composerBlock), (composerBlock.match(/min-width:[^;]+/) || [""])[0]);
check("悬浮框有 min-height", /min-height:\s*\d+px/.test(composerBlock), (composerBlock.match(/min-height:[^;]+/) || [""])[0]);
check("悬浮框不再直接吃全局 --shadow（深色厚阴影）", !/box-shadow:\s*var\(--shadow\)/.test(composerBlock), (composerBlock.match(/box-shadow:[^;]+/) || [""])[0]);

// 9) SKILL 开关样式：关闭灰、开启绿（与批量页「智能文本」同色 #49c85b）
check("SKILL 开关有 .on 轨道绿色规则", /\.skillToggleButton\.on > i \{[\s\S]*?#49c85b/.test(cssText));
check("SKILL 开关关闭态为灰色轨道", /\.skillToggleButton > i \{[\s\S]*?background: color-mix\([^)]*var\(--muted\)/.test(cssText));
check("SKILL 开关滑块位移 20px", /\.skillToggleButton\.on > i > b \{[\s\S]*?translateX\(20px\)/.test(cssText));
check("SKILL 开关 JSX 用 span + i > b 结构", /className=\{`skillToggleButton[^`]*`\}[\s\S]{0,600}<i aria-hidden="true"><b \/><\/i>/.test(mainJsx));

// 10) 上游路由错误码必须映射成中文可读文案
// 2026-09-25：映射逻辑（含 manual_channel_required）统一收敛到 src/shared/generation-errors.js，
// main.jsx 走分类器，不再自己写正则。
const generationErrors = readFileSync(path.join(root, "src", "shared", "generation-errors.js"), "utf8");
check(
  "共享错误分类器把 manual_channel_required 映射成可读提示",
  /manual_channel_required/.test(generationErrors) && /模型或渠道不可用/.test(generationErrors)
);
check(
  "快捷生成走共享分类器（main.jsx 不再散写正则）",
  /from "\.\/shared\/generation-errors\.js"/.test(mainJsx) && /formatGenerationError\(/.test(mainJsx)
);

// 11) 设置里的「开发诊断 / 一键传参自检」已替换为「连接测试」
check("设置里是「连接测试」按钮", /onClick=\{\(\) => void runConnectionTest\(\)\}/.test(mainJsx) && /连接测试/.test(mainJsx));
check("旧的诊断入口 UI 已移除（按钮与标题都不在）", !mainJsx.includes("一键传参自检") && !/Settings size=\{15\} \/> 开发诊断/.test(mainJsx));
check("连接测试只探测模型清单（不调用生图）", /\/api\/connection-test/.test(readFileSync(path.join(root, "src", "api", "connection.js"), "utf8")));

console.log(lines.join("\n"));
console.log(`\n[ui-duplication-check] 失败 ${failures} 项 / 共 ${lines.length} 项`);
process.exit(failures === 0 ? 0 : 1);
