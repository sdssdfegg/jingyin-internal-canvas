// 快捷生成「自动追加规则块」的唯一出口（前端 SKILL 规则）。
//
// 从 src/main.jsx 原样搬出，文本一字未改；main.jsx 继续 import 这里的同名常量。
// 搬到独立模块的原因：
//   1. 「快捷生成规则 / SKILL」开关必须能**被证明**：开启时最终 prompt 包含规则块，
//      关闭时不包含，而用户自己输入的原始 prompt 两种模式完全一致。
//      独立纯函数模块可以直接用 node 跑对照测试，不必启动 React。
//   2. prompts/README.md 规划把前端默认词迁到 prompts/frontend/quickgen-prompts.js，
//      这里先做成无依赖纯模块，后续整文件搬迁即可。
//
// 关闭 SKILL 时会被跳过的规则块（常量全部保留，随时可恢复）：
//   - QUICK_LOCAL_EDIT_PROMPT_SUFFIX            局部编辑任务规则 / 保持原图透视规则
//   - QUICK_LOCAL_EDIT_CONTEXT_PROMPT_SUFFIX    局部编辑上下文规则
//   - QUICK_PRIMARY_LOCAL_OUTFIT_PROMPT_SUFFIX  图1局部换装规则 / 图2服装类别规则
//   - QUICK_PRIMARY_LOCAL_APPEARANCE_PROMPT_SUFFIX 图1局部换样貌规则
//   - QUICK_PRIMARY_LOCAL_RETOUCH_PROMPT_SUFFIX 图1局部精修规则
//   - QUICK_WHOLE_OUTFIT_PROMPT_SUFFIX          图1/图2图片关系规则（整图换装）
//   - QUICK_GPT_LOCAL_ANCHOR_PROMPT_SUFFIX      模型锚点规则（TT Image 2）
//   - QUICK_BANANA_LOCAL_ANCHOR_PROMPT_SUFFIX   模型锚点规则（香蕉族）
//   - QUICK_BANANA2_LOCAL_ANCHOR_PROMPT_SUFFIX  模型锚点规则（香蕉 2）
//
// 关闭 SKILL 时**不会**改变：用户原始 prompt、模型、渠道、上传图片、请求字段结构。
// 与渠道/模型相关的能力限制（图片数量、大小、提示词长度、比例、尺寸）不属于 SKILL 规则，
// 关闭后依然生效。

export const QUICK_LOCAL_EDIT_PROMPT_SUFFIX = [
  "局部编辑任务：当前参考图是从原图中裁剪出的局部区域。",
  "局部选区只是 AI 工作画布，不代表选区内全部内容都可以改变；只重绘用户提示词明确点名的目标内容。",
  "保持原图透视、光源、色调、清晰度、材质衔接和边缘连续。",
  "如果用户没有明确要求改脸、改头发、改五官、改表情、改妆容或改头颈，脸部、头发、脖子、皮肤、肩颈关系都必须当作保护区，不能生成第二张脸、重复五官或移动下巴。",
  "如果局部里包含裙子、衣服或面料，未被用户明确要求改变的材质事实必须沿用原图：颜色、织纹方向、颗粒大小、厚薄、垂感、光泽、高光位置、褶皱密度和缝线方向都要和周围原图连续。",
  "不要把原图面料重新设计成更光滑、更亮、更粗糙、更网格、更皮革或更写实；选区边缘附近参考原图纹理和光影，避免面料跳变、色块断层或新增花纹。",
  "如果本次使用涂抹蒙版，只处理被涂抹且被用户点名的区域，未涂抹区域用于保持同一画面的连续观感。",
  "保持当前局部图的构图、角度和画布边界，不要增加边框、文字、水印或白边。"
].join("\n");
export const QUICK_LOCAL_EDIT_CONTEXT_PROMPT_SUFFIX = "当前局部图可能包含比实际修改范围更大的周边画面；外围只用于对齐头脸、发丝、肩颈、背景线条、光影和透视，不要重新构图、移动头部或改变人物坐标。";
export const QUICK_PRIMARY_LOCAL_RETOUCH_PROMPT_SUFFIX = [
  "【图1局部精修】",
  "图1已指定局部编辑区域，本次按局部精修理解，不按整图换装理解。",
  "只处理用户明确点名的局部目标，例如扣子、袖口、袖长、口袋、局部面料或局部污点；没有点名的脸、头发、脖子、身体、背景、裙子和整体衣身保持原图观感。",
  "图2如果存在，只作为被点名局部目标的款式/材质/颜色参考，不要把图2当成整套服装来源，也不要重绘人物、背景或整件衣服。",
  "保持局部图的原坐标关系和边缘连续，不能出现横向断层、错位碎片、第二张脸、重复五官或背景块状割裂。"
].join("\n");
export const QUICK_PRIMARY_LOCAL_OUTFIT_PROMPT_SUFFIX = [
  "【图1局部换装】",
  "图1已指定局部编辑区域，本次按局部换装理解：图1是人物、姿态、坐标和原画面事实，图2是服装事实来源。",
  "只在当前局部选区内把图2服装真实穿到图1人物身上，不输出整张重构图，不扩展画布，不重新摆拍。",
  "保持图1人物身份、原脸质感、发型、头部位置、身体比例、姿态、肩颈关系、手脚、背景光影和选区边缘连续；不磨皮、不变脸。",
  "图1模特身上的原服装不作为图2服装的款式、版型、大小、松量、袖长、衣长或下摆参考；被替换的服装区域必须完整换成图2/用户指定服装，不保留图1原上衣轮廓、短袖边、露手臂状态或旧下摆。",
  "图2服装的类别、版型、长度、松量、领口、袖口、扣子、拼接线、颜色、材质和可见结构是换装标准；服装必须画完整、结构闭合、袖子和下摆连续，不要只生成半件衣服或让旧衣服残留。",
  "领口必须围绕图1原脖子根部自然闭合，按原下巴、脖子和肩线位置贴合；半高领/高领不能漂浮到头发后面，不能压住下巴，不能露出旧领口，也不能把脖子位置推高或拉低。",
  "如果图2或用户要求的是风衣、外套、毛衣或长袖上装，左右袖管都要完整画到手腕，覆盖原图裸露手臂，袖口自然包住手腕；不要短袖化、半袖化、上提、卷起、缺袖或露出不该露出的手臂。",
  "正面、侧身、半侧身都按图1原坐标执行；不要混合图1原衣服和图2服装，不要让图2服装画到一半，不要加入额外噪点、麻点、斑点或脏颗粒。"
].join("\n");
export const QUICK_PRIMARY_LOCAL_APPEARANCE_PROMPT_SUFFIX = [
  "【图1局部换样貌/换发型】",
  "图1已指定局部编辑区域，本次只按局部换脸、换样貌、换发型或五官融合理解，不按换装、不按整张人像重拍理解。",
  "图1是唯一底图：头部中心、头部大小、脸部朝向、下巴位置、头颈关系、肩膀位置、身体、衣服、背景、光影、裁切和选区边缘都必须保持原坐标。",
  "图2只提供目标样貌身份、五官比例、妆容气质、发型方向、刘海、发缝、卷直程度和发色趋势；不要复制图2的衣服、背景、饰品、镜头角度、白底棚拍感或人物姿势。",
  "如果用户说“图1的模特发型样貌换成图2的”，意思是把图2的脸和发型特征自然融合到图1头脸区域，不是把图2整个人、衣服或背景搬到图1。",
  "发型只能在图1原头部轮廓、头发体积和选区范围内自然替换或融合；不能让头变大、头部偏移、脸中心改变、肩膀重画或背景被大片重绘。",
  "输出只服务局部回贴：保持局部图画布边界和周边光影连续，不能出现白衬衫替换、换衣服、背景变白、双脸、面具感、贴纸边缘、过度磨皮或五官错位。"
].join("\n");
export const QUICK_WHOLE_OUTFIT_PROMPT_SUFFIX = [
  "【快捷整图换装】",
  "本次是整图换装，不是局部回贴：输出完整成片，但人物姿势和画面构图必须以图1为基准。",
  "图1只提供模特身份、原脸质感、发型、身体比例、姿势动作、手脚位置、站位、镜头角度、场景和光影；图1原有服装不能作为图2服装的版型、样式、面料、颜色、袖长、衣长、松量或穿法参考。",
  "图2是服装事实来源：服装类别、版型松量、领口、门襟、扣子开合数量、袖子是撸起还是自然垂下、袖口位置、衣摆塞/不塞、衣长、下摆落点、内外层关系、面料质感、颜色和垂感都按图2或用户文字。",
  "只做真实穿着适配，不让图1原衣服决定图2衣服大小；不要擅自扣扣子、解扣子、撸袖、放袖、收腰、改短、加长、改修身或按模型审美美化版型。",
  "保持图1人物位置、身体比例、头肩方向、手部姿势、腿脚姿势、脚底接触点和画面构图不变；不磨皮、不变脸、不改变脸部质感，不重新摆拍。"
].join("\n");
export const QUICK_GPT_LOCAL_ANCHOR_PROMPT_SUFFIX = "GPT 局部编辑：按图层逻辑执行，先锁定图1局部坐标和人物结构，再处理用户要求，未指定区域延续原图。";
export const QUICK_BANANA_LOCAL_ANCHOR_PROMPT_SUFFIX = "Nano Banana 局部编辑：把图1当作姿态和坐标模板，头部、肩颈、重心、手臂、手腕、手指、腿脚、脚底接触和人物位置保持原样。";
export const QUICK_BANANA2_LOCAL_ANCHOR_PROMPT_SUFFIX = [
  "Nano Banana 2 局部编辑：短句硬锁，避免主动重构人物；无论正面、侧身还是半侧身，都不要重新摆拍、移动脖子、改变下巴位置、重画肩颈连接、重排骨架或让上下身体错位。",
  "当前图1局部不是一张新的人像构图，不要补全完整头脸、不要生成第二个头、不要把头部或肩颈重画成另一张人像；只按原局部坐标换衣服。",
  "图1原衣服只用于判断身体姿势和遮挡，不能参与新服装设计；新衣服必须完整覆盖被替换区域，不能混入图1原衣服的短袖、旧下摆或裸露手臂状态。"
].join("\n");

// 所有自动追加规则块的常量名，SKILL 关闭时必须全部跳过。
export const QUICK_SKILL_RULE_BLOCKS = Object.freeze([
  "QUICK_LOCAL_EDIT_PROMPT_SUFFIX",
  "QUICK_LOCAL_EDIT_CONTEXT_PROMPT_SUFFIX",
  "QUICK_PRIMARY_LOCAL_RETOUCH_PROMPT_SUFFIX",
  "QUICK_PRIMARY_LOCAL_OUTFIT_PROMPT_SUFFIX",
  "QUICK_PRIMARY_LOCAL_APPEARANCE_PROMPT_SUFFIX",
  "QUICK_WHOLE_OUTFIT_PROMPT_SUFFIX",
  "QUICK_GPT_LOCAL_ANCHOR_PROMPT_SUFFIX",
  "QUICK_BANANA_LOCAL_ANCHOR_PROMPT_SUFFIX",
  "QUICK_BANANA2_LOCAL_ANCHOR_PROMPT_SUFFIX"
]);

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

/**
 * 快捷生成最终 prompt 组装。
 *
 * @param {string} prompt 用户原始提示词（任何模式下都不改动）
 * @param {object|null} localEdit 局部回贴信息
 * @param {string} model canonical 模型 ID
 * @param {object} options { skillRules, primaryLocalEdit, localIntent, wholeOutfit }
 * @returns {string} 最终发给接口的 prompt
 */
export function promptForQuickGeneration(prompt, localEdit = null, model = "", options = {}) {
  const basePrompt = String(prompt || "").trim();
  // SKILL 关闭：只发用户原始提示词，不追加任何自动规则块。
  // 注意这里完全不碰 basePrompt，所以原始提示词在两种模式下逐字符一致。
  if (options.skillRules === false) return basePrompt;

  const suffixes = [];
  if (localEdit) {
    suffixes.push(QUICK_LOCAL_EDIT_PROMPT_SUFFIX);
    if (localEdit.contextRect) suffixes.push(QUICK_LOCAL_EDIT_CONTEXT_PROMPT_SUFFIX);
  }
  if (localEdit && options.primaryLocalEdit) {
    const localIntent = options.localIntent || classifyQuickPrimaryLocalIntent(basePrompt);
    suffixes.push(
      localIntent === "outfit"
        ? QUICK_PRIMARY_LOCAL_OUTFIT_PROMPT_SUFFIX
        : localIntent === "appearance"
          ? QUICK_PRIMARY_LOCAL_APPEARANCE_PROMPT_SUFFIX
          : QUICK_PRIMARY_LOCAL_RETOUCH_PROMPT_SUFFIX
    );
    if (isTtImageLocally(model)) suffixes.push(QUICK_GPT_LOCAL_ANCHOR_PROMPT_SUFFIX);
    else if (isBanana2Locally(model)) suffixes.push(QUICK_BANANA2_LOCAL_ANCHOR_PROMPT_SUFFIX);
    else if (isBananaLocally(model)) suffixes.push(QUICK_BANANA_LOCAL_ANCHOR_PROMPT_SUFFIX);
  } else if (options.wholeOutfit) {
    suffixes.push(QUICK_WHOLE_OUTFIT_PROMPT_SUFFIX);
  }
  return suffixes.length ? `${basePrompt}\n\n${suffixes.join("\n")}` : basePrompt;
}

// 模型族判定：canonical ID 是 tt-image-2 / banana-2 / nano-banana-pro，
// 旧存档 ID（gpt-image / nano-banana2 / nano-banana）也归到同一族，避免迁移动到一半失配。
function isTtImageLocally(model) {
  return /^(tt-image|gpt-image)/i.test(String(model || "").trim());
}

function isBanana2Locally(model) {
  return /^(banana-2|nano-banana2|nano-banana-2)$/i.test(String(model || "").trim());
}

function isBananaLocally(model) {
  return /^(nano-banana|banana)/i.test(String(model || "").trim());
}
