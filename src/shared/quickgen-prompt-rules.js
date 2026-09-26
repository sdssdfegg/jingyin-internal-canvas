// 快捷生成提示词出口 + 「图1局部意图」判定。
//
// 2026-09-26 **SKILL 规则已整体删除**：用户实测"不加 SKILL 和图1/图2 的规则效果更好"，
// 要求把快捷侧的「换装」按钮与背后的规则一起删掉（批量侧的 SKILL / 服装规则同理，见
// prompts/server/outfit-skill.js）。
//
// 现在的契约（唯一一条）：
//   - 发给接口的提示词 = 用户自己输入的文字，逐字符不改；
//   - 不再追加任何规则块（换装、局部编辑、图1/图2 关系、模型锚点……全部已删除）；
//   - 不改模型、渠道、上传图片、请求字段结构。
//
// 这里保留的 `classifyQuickPrimaryLocalIntent` 不是 SKILL：它只用来判断"用户这句话想干什么"，
// 供调用方做上传/回贴链路的分支判断（例如是否按整图换装处理），不产生任何追加文本。

/**
 * 最终 prompt：**只有用户自己输入的文字**。
 *
 * 保留这个函数（而不是让调用方直接写 prompt）是为了让"提示词出口"仍然只有一处，
 * 以后若要再追加文本，改动点集中在这里。
 */
export function promptForQuickGeneration(prompt) {
  return String(prompt || "").trim();
}

export function classifyQuickPrimaryLocalIntent(prompt) {
  const text = String(prompt || "").replace(/\s+/g, "");
  const localDetailTarget = /(扣子|纽扣|袖口|袖长|口袋|拉链|腰带|腰封|领口|衣领|下摆|开叉|褶皱|缝线|拼接线|局部面料|面料纹理|污点|瑕疵|修补|补丁|小细节|细节|改长一点|改短一点|去掉|去除|抹掉|补上)/.test(text);
  const appearanceIntent = /(换脸|换头|换发型|改发型|换头发|改头发|换样貌|改样貌|样貌换成|样貌改成|长相换成|长相改成|脸换成|脸部换成|五官换成|模特样貌|模特发型|发型样貌|图2的脸|图2样貌|图2发型|图二的脸|图二样貌|图二发型)/.test(text);
  const strongOutfitIntent = /(换装|换衣|换衣服|穿上|穿着图2|换成图2服装|换成图2衣服|图2服装|图2衣服|整件衣服|整套衣服|整身衣服|全身换装|把衣服换成|把上衣换成|把外套换成|把风衣换成|把裙子换成|把裤子换成|把鞋子换成)/.test(text);
  const garmentReplacement = /(上衣|外套|风衣|衬衫|T恤|卫衣|毛衣|西装|连衣裙|裙子|半身裙|裤子|牛仔裤|短裤|鞋子|靴子|高跟鞋).{0,8}(换成|改成|替换成|变成)/.test(text)
    || /(换成|改成|替换成|变成).{0,8}(上衣|外套|风衣|衬衫|T恤|卫衣|毛衣|西装|连衣裙|裙子|半身裙|裤子|牛仔裤|短裤|鞋子|靴子|高跟鞋)/.test(text);
  if (appearanceIntent && !strongOutfitIntent && !garmentReplacement) return "appearance";
  if (strongOutfitIntent || garmentReplacement) return "outfit";
  if (localDetailTarget && !/(整件|整套|整身|全身|换装|换衣服)/.test(text)) return "retouch";
  return "retouch";
}
