export function primaryOutfitGenerationError(errors) {
  const list = Array.isArray(errors) ? errors.filter(Boolean) : [];
  const nonAuthError = list.find((error) => !/HTTP\s*401|invalid token|unauthorized|api key/i.test(error));
  return nonAuthError || list[list.length - 1] || list[0] || "换装生成失败";
}

export function isBananaOutfitModel(model) {
  return /^nano-banana/i.test(String(model || ""));
}

const GARMENT_PART_OPTIONS = [
  { value: "upper", label: "上衣" },
  { value: "lower", label: "下装" },
  { value: "shoes", label: "鞋子" }
];
const DEFAULT_GARMENT_PARTS = ["upper", "lower"];
const GARMENT_LENGTH_OPTIONS = [
  { value: "", label: "" },
  { value: "reference", label: "按图2原长度" },
  { value: "waist", label: "到腰线" },
  { value: "below-waist", label: "到腰下" },
  { value: "upper-hip", label: "到臀上" },
  { value: "cover-hip", label: "遮臀" },
  { value: "mid-thigh", label: "到大腿中段" },
  { value: "above-knee", label: "到膝上" },
  { value: "knee", label: "到膝盖" },
  { value: "below-knee", label: "到膝下" },
  { value: "mid-calf", label: "到小腿中段" },
  { value: "ankle", label: "到脚踝" },
  { value: "floor", label: "拖地" }
];

function normalizeGarmentParts(value) {
  const raw = Array.isArray(value) ? value : String(value || "").split(/[,\s|，、]+/);
  const next = GARMENT_PART_OPTIONS
    .map((option) => option.value)
    .filter((part) => raw.includes(part));
  return next.length > 0 ? next : DEFAULT_GARMENT_PARTS;
}

function garmentPartLabel(part) {
  return GARMENT_PART_OPTIONS.find((option) => option.value === part)?.label || part;
}

function normalizeGarmentLengths(value = {}, garmentParts = DEFAULT_GARMENT_PARTS) {
  const allowed = new Set(GARMENT_LENGTH_OPTIONS.map((option) => option.value));
  const parts = normalizeGarmentParts(garmentParts);
  const next = {
    upper: allowed.has(value?.upper) ? value.upper : "",
    lower: allowed.has(value?.lower) ? value.lower : ""
  };
  if (!parts.includes("upper")) next.upper = "";
  if (!parts.includes("lower")) next.lower = "";
  return next;
}

function garmentLengthLabel(value) {
  return GARMENT_LENGTH_OPTIONS.find((option) => option.value === value)?.label || "";
}

function buildGarmentLengthSkill(parts, lengths) {
  const selected = normalizeGarmentParts(parts);
  const normalized = normalizeGarmentLengths(lengths, selected);
  const lines = [];
  const addLine = (key, label) => {
    const value = normalized[key];
    if (!value) return;
    if (value === "reference") {
      lines.push(`${label}长度按图2原服装在人体上的相对落点迁移，不按模型审美改短或加长。`);
      return;
    }
    lines.push(`${label}下摆/落点控制为${garmentLengthLabel(value)}，按图1人体比例落到对应位置。`);
  };
  addLine("upper", "上装");
  addLine("lower", "下装");
  if (["ankle", "floor"].includes(normalized.upper) || ["ankle", "floor"].includes(normalized.lower)) {
    lines.push("到脚踝或拖地时，长裙、礼服、长外套的下摆可以自然遮住鞋靴；鞋靴只露出真实可见部分，不要为了展示完整鞋靴而抬高下摆、开叉或缩短衣长。");
  }
  return lines;
}

function buildGarmentPartSkill(parts) {
  const selected = normalizeGarmentParts(parts);
  const skipped = GARMENT_PART_OPTIONS
    .map((option) => option.value)
    .filter((part) => !selected.includes(part));
  const selectedText = selected.map(garmentPartLabel).join("、");
  const skippedText = skipped.map(garmentPartLabel).join("、");
  const lines = [
    `本次只从图2迁移这些服装部位：${selectedText}。模型自行判断上衣具体是外套/衬衫/短袖等，下装具体是裙子/裤子等，不需要用户再细分。`,
    "选中部位必须以图2为事实来源，保持真实类别、版型、长度、宽松程度、颜色、材质和可见结构。"
  ];
  if (skippedText) {
    lines.push(`未选中的图1原有部位保持不变：${skippedText}。不要因为图2里出现这些部位就顺手替换。`);
  }
  lines.push("如果图2没有清楚出现某个已选部位，不要凭空设计；优先保持图1对应部位，除非用户补充信息明确指定。");
  return lines;
}

function bananaPoseLockLines(modelName) {
  return [
    `${modelName}：把图1当作姿态和坐标模板。`,
    "头部、肩颈、重心、手臂、手腕、手指、腿脚、脚底接触和人物在画面中的位置保持原样。",
    "如果图2服装和图1姿态有冲突，优先保留图1姿态，让服装做真实穿着适配。"
  ];
}

function modelPromptSkill(model, options = {}) {
  const localEditLine = options.localEditEnabled
    ? "本次有局部回贴，把图1当作局部编辑补丁，不重构选区外的画面关系。"
    : "本次是整图换装，保持图1画面结构稳定，只替换服装。";
  if (model === "gpt-image") {
    return [
      "GPT：按图层逻辑执行，先锁图1人物与画面，再读取图2服装事实，最后做真实穿着适配。",
      localEditLine,
      "重点防止模型审美漂移：不把图2服装改短、收腰、修身、瘦身或简化细节。"
    ];
  }

  if (model === "nano-banana-pro") {
    return [
      "Nano Banana Pro：商品细节优先，图2服装的版型、长度、松量、材质和层次不要漂。",
      ...bananaPoseLockLines("Nano Banana Pro"),
      localEditLine
    ];
  }

  if (model === "nano-banana2") {
    return [
      "Nano Banana 2：短句硬锁，避免主动重构人物。",
      ...bananaPoseLockLines("Nano Banana 2"),
      "图2只供服装，不把图3或后续参考混成新衣服。",
      localEditLine
    ];
  }

  return [
    "Nano Banana：使用短句图号约束。",
    ...bananaPoseLockLines("Nano Banana"),
    "图2提供唯一服装，图3及以后只做弱参考。",
    localEditLine
  ];
}

function localEditMaterialContinuityRules(localEditIsMask) {
  return [
    "【局部材质延续】",
    localEditIsMask
      ? "本次是涂抹蒙版局部回贴：未涂抹区域只作上下文参考，被涂抹区域内没有被用户明确要求改变的裙子、衣服和面料事实必须沿用原图。"
      : "本次是框选局部回贴：选区内没有被用户明确要求改变的裙子、衣服和面料事实必须沿用原图，不能把局部当成重新设计服装。", 
    "材质事实包括颜色、织纹方向、颗粒大小、帆布/棉麻/皮革/雪纺/网纱等面料类别、厚薄、垂感、光泽、高光位置、褶皱密度、缝线方向和边缘磨损程度。",
    "用户没有明确要求改变面料时，不要把裙子或衣服重新生成成更光滑、更亮、更粗糙、更网格、更皮革、更塑料或更写实的材质；只修指定内容，未指定区域保持原图观感。",
    "选区边缘向内外约 50px 必须参考原图连续纹理、明暗和光泽，让纹理跨边界自然衔接，避免局部补丁感、面料跳变、色块断层、新增花纹或裙摆材质不一致。"
  ];
}

function faceSwapHairStyleRules() {
  return [
    "【发型参考边界】",
    "批量换脸需要包含发型控制：可以参考图2的发型方向、刘海、发缝、卷直程度、发色趋势和妆造气质。",
    "但发型只能在图1原有头部坐标、头发外轮廓、发量范围和头颈关系内自然融合，不能因为参考图2发型而移动头部、放大头部、改变下巴位置、改变脸中心或重绘背景。",
    "如果图2发型和图1差异很大，优先保持图1头型外轮廓和头部位置；只吸收能稳定融合的小范围发型特征。"
  ];
}

function isDesignDraftWorkflow(payload) {
  const text = [
    payload?.workflowMode,
    payload?.pageName,
    payload?.uploadLabels?.model?.title,
    payload?.uploadLabels?.clothing?.title,
    payload?.uploadLabels?.reference?.title
  ].join(" ");
  return String(payload?.workflowMode || "") === "design-draft"
    || /设计稿|設計稿|design|实拍服装|真人实拍|细节补充/i.test(text);
}

function isBackgroundChangeWorkflow(payload) {
  const pageName = String(payload?.pageName || "");
  const modelTitle = String(payload?.uploadLabels?.model?.title || "");
  const clothingTitle = String(payload?.uploadLabels?.clothing?.title || "");
  const referenceTitle = String(payload?.uploadLabels?.reference?.title || "");
  const text = [payload?.workflowMode, pageName, modelTitle, clothingTitle, referenceTitle].join(" ");
  const explicitBackgroundPage = /换背景|換背景|背景更换|背景替换|换场景|換場景/i.test(pageName)
    || /统一场景|场景图|目标场景|背景图|换背景|背景/i.test(clothingTitle);
  const backgroundLabelPair = /人物图|人物照|人物|模特图|模特/i.test(modelTitle)
    && /统一场景|场景图|目标场景|背景图|换背景|背景/i.test(clothingTitle);
  return String(payload?.workflowMode || "") === "background-change"
    || explicitBackgroundPage
    || backgroundLabelPair
    || /PS贴回/i.test(text);
}

function isFaceSwapWorkflow(payload) {
  const pageName = String(payload?.pageName || "");
  const modelTitle = String(payload?.uploadLabels?.model?.title || "");
  const clothingTitle = String(payload?.uploadLabels?.clothing?.title || "");
  const referenceTitle = String(payload?.uploadLabels?.reference?.title || "");
  const text = [payload?.workflowMode, pageName, modelTitle, clothingTitle, referenceTitle].join(" ");
  return String(payload?.workflowMode || "") === "face-swap"
    || /批量换脸|换脸|人脸|脸部|face\s*swap/i.test(text)
    || (/目标人物图|人物图|模特图|原图/i.test(modelTitle) && /人脸参考|脸部参考|人脸身份|换脸|脸/i.test(clothingTitle));
}

function isCustomWorkflow(payload) {
  return String(payload?.workflowMode || "") === "custom"
    || /临时需求|自定义需求|批量需求|custom/i.test(String(payload?.pageName || ""));
}

function buildCustomPrompt(payload) {
  const customPrompt = String(payload.prompt || "").trim();
  const productNote = String(payload.productNote || "").trim();
  const parts = [];
  if (customPrompt) parts.push(customPrompt);
  if (productNote) parts.push(productNote);
  return parts.join("\n\n") || "根据用户上传的参考图片和当前页面需求生成图片。";
}

function designDraftModelSkill(model) {
  if (model === "gpt-image") {
    return [
      "模型适配：GPT 图片模型按“实物服装转设计师手稿款式图”理解，不生成真人图、不生成写实照片、不生成商业摄影成片。",
      "先从图1区域读取实物服装事实：正反面、版型、领口、袖型、袖口、下摆、衣长比例、主要结构、颜色和可识别面料特点。",
      "再读取图2区域的手稿/设计稿风格参考；如果用户文字明确说图3风格，或图3上传了手稿风格图，则图3也作为风格参考，但不能覆盖实物服装事实。",
      "输出必须是服装设计师手稿款式图：纯白背景、无人体、无模特、无场景、无衣架、无摄影质感，只保留服装正反面左右并排。",
      "线条必须有压感：外轮廓黑线两头尖、中间略粗、起笔轻、收笔轻、中段压力重，有自然手绘板笔触；禁止粗细一致、儿童涂抹式、反复描粗的线。"
    ];
  }

  return [
    "模型适配：当前模型容易把参考图混成写实图，必须强制输出服装设计师手稿，不输出真人、不输出照片。",
    "图1区域是实物服装事实，图2/图3只提供手稿风格或细节补充；不要互相替代。",
    "黑色外轮廓要像画笔压感线：两端细、中间粗、干净稳定，不要均匀粗线，不要来回涂抹。",
    "面料只用简化材质符号和少量浅淡铅笔排线暗示，不要真实照片级织物细节。",
    "所有转角、袖口四角、下摆边角、接缝拐点外侧点缀浅灰短定位线，短、小、淡、零散，不画成长贯穿辅助线。"
  ];
}

function buildDesignDraftPrompt(payload) {
  const customPrompt = String(payload.prompt || "").trim();
  const productNote = String(payload.productNote || "").trim();
  const ratio = String(payload.aspectRatio || "3:4");
  const imageSize = String(payload.imageSize || "2K");
  const modelImageCount = Math.max(1, Number.parseInt(payload.modelImageCount || "1", 10) || 1);
  const referenceCount = Number.parseInt(payload.referenceCount || "0", 10) || 0;
  const modelTitle = String(payload?.uploadLabels?.model?.title || "实拍服装图/真人实拍图").trim();
  const clothingTitle = String(payload?.uploadLabels?.clothing?.title || "设计稿风格参考").trim();
  const referenceTitle = String(payload?.uploadLabels?.reference?.title || "细节补充图").trim();
  const designImageIndex = modelImageCount + 1;
  const detailStartIndex = designImageIndex + 1;
  const parts = [
    "【服装设计师手稿款式图 Skill】",
    "目标：参考实物服装正反面，把服装转换为干净的服装设计师手稿风格款式图。",
    "核心原则：图1区域负责实物服装事实，图2区域负责设计稿/手稿风格参考，图3区域可作为细节或风格补充；服装事实优先于风格化，不允许混淆角色。",
    "",
    "【你验证过的成功模板】",
    "参考图1和图2正反面实物服装，转换为图3风格干净的服装设计师手稿风格，纯白背景，无人体、无模特、无场景、无衣架，画面只保留服装正反面左右并排款式图。",
    "服装颜色参考原图实物颜色，保留原服装的版型、领口、袖型、袖口、下摆、长度比例和主要结构。",
    "整体以黑色线稿为主，搭配极浅的米杏色淡填色，不要真实照片质感，不要复杂面料纹理，不要写实细节。",
    "",
    `当前页面图1标题：${modelTitle}`,
    `当前页面图2标题：${clothingTitle}`,
    `当前页面图3标题：${referenceTitle}`,
    "",
    "【图片编号规则】",
    modelImageCount > 1
      ? `第1到第${modelImageCount}张都属于图1区域：实物服装正反面/侧面/局部/真人实拍参考，必须合并理解为同一件服装或同一组服装事实，不要生成多件无关衣服。`
      : "第1张属于图1区域：实物服装或真人实拍参考。提取真实服装事实、版型、面料、颜色、结构和比例。",
    `第${designImageIndex}张属于图2区域：设计稿/手稿风格参考。只提取线稿风格、笔触质感、款式图表达方式和辅助短线感觉，不复制纸张、文字、标注线、人体模板、背景和无关装饰。`,
    referenceCount > 0
      ? `第${detailStartIndex}张及后续属于图3区域：可选细节/风格补充，可用于补充面料、袖口、裙摆、衣领、拼接、里衬、网纱、印花、颜色或手稿辅助线风格。`
      : "当前没有图3补充图时，不要凭空添加复杂结构；以图1实物服装事实和图2手稿风格为主。",
    "",
    "【成功提示词核心要求】",
    "参考图1区域的实物服装，转换为图2/图3参考中的干净服装设计师手稿风格，纯白背景，无人体、无模特、无场景、无衣架。",
    "画面只保留服装正反面左右并排款式图；如果只有单面参考，也要尽量按款式逻辑补出正反面，但不能虚构复杂细节。",
    "服装颜色参考图1实物服装颜色，保留原服装的版型、领口、袖型、袖口、下摆、长度比例和主要结构。",
    "整体以黑色线稿为主，搭配极浅的米杏色或接近实物颜色的淡填色；不要真实照片质感，不要复杂面料纹理，不要写实细节。",
    "",
    "【线条与笔触硬约束】",
    "线条必须像手绘板画笔线：外轮廓线清晰干净，起笔轻、收笔轻、中间压力重，线条两头细、中间粗，有轻微压杆变化和自然手绘笔触。",
    "内部结构线、领口线、袖口线、下摆线、衣身分割线使用更细的线，线条稳定、准确、克制。",
    "禁止粗细一致的机械线；禁止像小孩来回涂抹形成的均匀粗黑边；禁止毛糙乱线、过多重影线、脏污笔刷。",
    "",
    "【拐点定位短线/起稿标记】",
    "服装所有轮廓转角、袖口四角、下摆边角、接缝拐点位置，都要点缀极短的浅灰色纤细定位短线。",
    "这些短线只停留在拐点外侧，短小零散、浅淡、明度远低于黑色衣身轮廓线，是手绘起稿标记拐点残留短线。",
    "辅助短线要比参考图更明显一点点，但不能杂乱、不能延伸、不能变成长贯穿线条、不能抢过主轮廓。",
    "",
    "【面料与填色】",
    "面料填充不要太真实，只抓住面料特点：用非常少量的简化材质符号和浅淡铅笔排线暗示，不出现真实照片级织物细节，不出现复杂编织纹理，不出现杂乱涂抹线。",
    "服装颜色根据图1实物服装来，颜色只做设计手稿淡填色，不做厚重写实上色。",
    "整体像服装打版师、设计师用手绘板画出来的产品工艺手稿：结构清楚、比例准确、线条干净、有轻微手写压感但不凌乱。",
    "",
    "【禁止内容】",
    "不要人体、不要模特、不要脸、不要手脚、不要场景、不要衣架、不要摄影棚、不要真实照片质感、不要商品拍摄阴影、不要品牌 Logo、不要文字说明、不要标注箭头、不要对比拼贴。",
    `输出比例：${ratio}；输出清晰度：${imageSize}。`
  ];

  parts.push("", "【模型提示词适配】", ...designDraftModelSkill(payload.model));

  if (productNote) {
    parts.push(
      "",
      "【服装细节/商品补充信息】",
      "以下内容优先作为服装细节事实执行：",
      productNote
    );
  }

  if (customPrompt) {
    parts.push(
      "",
      "【用户本次提示词】",
      "以下文字只用于补充本次画面目标；如果和图1实拍事实、图2设计稿角色、图3细节补充冲突，按上方优先级处理。",
      customPrompt
    );
  }

  parts.push(
    "",
    "【最终检查】",
    "检查服装是否同时保留了图1真实事实、图2设计风格和图3细节补充；检查是否误把设计稿文字/纸张/标注线带入；检查是否生成了多件衣服或把不同参考图混成不稳定款式。"
  );

  return parts.join("\n");
}

function backgroundChangeModelSkill(model) {
  if (model === "gpt-image") {
    return [
      "模型适配：GPT 图片编辑模型按“人物抠出后换到统一场景”理解，不做换装、不重绘人物主体。",
      "把图1人物当作不可改变的前景图层：人物坐标、主体比例、头身大小、姿势、手脚位置、发型、脸部朝向、服装款式、服装颜色和服装细节都锁定。",
      "把图2当作唯一场景图层：学习图2空间透视、光源方向、色温、地面材质、背景层次和相机高度，让图1人物自然站在图2场景里。",
      "只允许做必要的边缘融合、脚底接触阴影、轻微环境反光和整体色调匹配；这些调整不能改变人物轮廓、衣服颜色、脸部位置、手脚姿势和人物大小。",
      "如果图1有原背景，删除原背景并保留人物完整边缘；如果图1是透明/白底，仍然按人物前景层处理。"
    ];
  }

  if (model === "nano-banana2") {
    return [
      "模型适配：Nano Banana 2 容易重新摆拍人物，必须把图1人物锁成不可移动贴回模板。",
      "不要重新生成一个相似人物；必须保留图1人物原坐标、原站姿、原手势、原服装、原头身比例和原主体占比。",
      "图2只负责统一场景，不能从图2复制人物、衣服、道具遮挡或新的动作到图1人物身上。",
      "人物可以融入图2光影，但不能被换脸、换衣、瘦身、增高、转身、移动、缩放、裁脚、改手、改头或改变服装颜色。",
      "所有批量结果要像同一场景同一摄影方案：一致的色温、对比度、阴影方向、地面接触关系和背景清晰度。"
    ];
  }

  if (model === "nano-banana-pro") {
    return [
      "模型适配：Nano Banana Pro 适合写实商业成片，但要限制它不要重新设计人物。",
      "图1人物是原样保留主体，图2是统一商业场景；保持人物完整、服装真实、边缘干净、站位不变。",
      "以图2的光线和色调作为整批统一标准，给人物添加合理接触阴影和环境融合，不改变服装事实。",
      "禁止把图1人物改成图2场景里的新模特，禁止换衣、换脸、换姿势、换比例或移动人物坐标。"
    ];
  }

  return [
    "模型适配：当前模型使用短句硬约束执行换背景。",
    "图1人物保持原样：位置、比例、姿势、脸、发型、服装、手脚、鞋子全部不变。",
    "图2只提供背景场景：统一光影、色温、透视和地面接触阴影。",
    "图3可选补充，不上传时不要编造复杂道具或新场景元素。",
    "不要换衣服、不要换脸、不要移动人物、不要重新构图、不要输出拼贴对比图。"
  ];
}

function buildBackgroundChangePrompt(payload) {
  const customPrompt = String(payload.prompt || "").trim();
  const productNote = String(payload.productNote || "").trim();
  const poseAnchorPrompt = String(payload.poseAnchorPrompt || "").trim();
  const ratio = String(payload.aspectRatio || "3:4");
  const imageSize = String(payload.imageSize || "2K");
  const referenceCount = Number.parseInt(payload.referenceCount || "0", 10) || 0;
  const localEditEnabled = Boolean(payload.localEdit?.enabled || payload.localEdit === true);
  const localEditIsMask = localEditEnabled && String(payload.localEdit?.editMode || "") === "mask";
  const modelTitle = String(payload?.uploadLabels?.model?.title || "人物图/模特图").trim();
  const sceneTitle = String(payload?.uploadLabels?.clothing?.title || "统一场景图").trim();
  const referenceTitle = String(payload?.uploadLabels?.reference?.title || "补充参考图").trim();
  const parts = [
    "【电商批量换背景 Skill】",
    "目标：把图1人物批量放入图2统一场景中，生成像同一场景摆拍出来的电商成片。这个任务是换背景，不是换装、不是重绘人物、不是重新拍一张相似图。",
    "核心原则：人物事实以图1为绝对标准，场景事实以图2为绝对标准；图3只做可选补充。必须保证人物可用于后期 PS 贴回，所以人物坐标、姿势、比例和服装不能漂移。",
    "",
    `当前页面图1标题：${modelTitle}`,
    `当前页面图2标题：${sceneTitle}`,
    `当前页面图3标题：${referenceTitle}`,
    "",
    "【图片编号规则】",
    "图1：当前要换背景的人物图。可能带原背景，也可能是透明底、白底或干净底。无论图1是否带背景，只保留人物主体和人物身上的服装事实，不保留图1原背景。",
    "图2：目标统一场景图。图2是场景、空间、光影、色温、地面、背景层次、镜头高度和商业氛围的唯一标准。",
    referenceCount > 0
      ? `图3及后续 ${referenceCount} 张：可选补充参考，只能用于补充场景氛围、光线色调、道具边界、地面接触、客户要求或局部细节，不允许改变图1人物。`
      : "当前没有图3补充图时，不要凭空增加复杂道具、文字、水印、品牌标识或额外人物。",
    "",
    "【图1人物硬锁定】",
    "必须完全保持图1人物在画面中的位置、主体大小、头身比例、肩颈方向、身体姿势、重心、手臂位置、手腕角度、手掌朝向、手指数量和弯曲、腿脚姿势、脚尖方向、鞋子形状、头部大小、脸部朝向、发型轮廓、服装款式、服装颜色、服装纹理、服装长度、褶皱和配饰。",
    "人物不能移动、不能缩放、不能重新居中、不能改成更合适场景的站姿、不能换脸、不能换发型、不能换衣服、不能瘦身增高、不能拉腿、不能裁掉脚、不能把手脚改成新的动作。",
    "如果图1是全身图，人物从头到脚要完整保留；如果图1人物靠左、靠右、偏上、偏下或有特殊裁切，也要尽量保持这个坐标关系，不要让模型自动重新构图。",
    "",
    "【图2场景融合】",
    "把图1人物放进图2场景里，场景必须来自图2：空间透视、地面/墙面/背景结构、镜头高度、光源方向、色温、对比度、阴影方向、背景虚实和商业氛围都要向图2统一。",
    "每一张批量结果都要像同一场景里的同一套摄影方案摆拍：统一色温、统一光影、统一阴影方向、统一地面接触关系、统一背景清晰度和统一整体调色。",
    "人物与场景之间可以做必要的边缘融合、脚底接触阴影、轻微环境反光、整体曝光和色调匹配，但这些处理不能改变人物轮廓、服装事实、脸部坐标、手脚姿态、人物比例和人物位置。",
    "",
    "【局部回贴模式】",
    localEditEnabled
      ? localEditIsMask
        ? "本次已开启涂抹蒙版局部回贴：图1发送给模型的是包含涂抹区域周边上下文的局部选区。未涂抹区域只作为透视、光影、色调和边缘参考，重点处理被涂抹区域的背景/边缘融合；画布比例和选区一致，不要输出整张人物图，不要添加边框，不要扩展画布；系统会只把涂抹区域羽化贴回原图同一坐标。"
        : "本次已开启局部回贴：图1发送给模型的是原图中的局部选区。只输出这个选区内的背景/边缘融合结果，画布比例和选区一致，不要输出整张人物图，不要添加边框，不要扩展画布；系统会把结果贴回原图同一坐标。选区边缘必须承接原图光影和主体轮廓。"
      : "如未开启局部回贴，则按整图换背景生成；仍要尽量保持人物坐标、姿势和主体比例不漂移。",
    "",
    "【批量一致性】",
    "批量生成时，每张图只处理当前图1人物，但图2场景标准保持一致。不同人物之间可以因为身高/姿势不同产生自然接触阴影差异，但整体光线、色调、相机透视和场景质感必须统一。",
    "不要让某些结果像棚拍、某些像街拍；不要一张偏暖一张偏冷；不要一张阴影向左一张向右；不要有的人像真实融入，有的人像贴纸。",
    "",
    "【禁止内容】",
    "不要换装、不要换脸、不要换发型、不要改变人物服装颜色和款式、不要移动人物、不要缩放人物、不要重新摆拍、不要生成新人物、不要添加无关人物、不要输出对比图、不要拼贴、不要文字说明、不要水印、不要品牌 Logo。",
    `输出比例：${ratio}；输出清晰度：${imageSize}。`
  ];

  if (localEditEnabled) {
    parts.push("", ...localEditMaterialContinuityRules(localEditIsMask));
  }

  parts.push("", "【模型提示词适配】", ...backgroundChangeModelSkill(payload.model));

  if (poseAnchorPrompt) {
    parts.push(
      "",
      "【智能介入：图1人物坐标与姿势锚点】",
      "以下锚点来自文本/视觉模型对图1的预分析，优先级高于用户补充信息；用于让当前生图模型保持图1人物坐标、头部大小、姿势、服装和主体占比。",
      poseAnchorPrompt
    );
  }

  if (productNote) {
    parts.push(
      "",
      "【本次补充信息】",
      "以下内容只能补充场景融合或客户要求；如果和图1人物硬锁定冲突，必须以图1人物不变为准。",
      productNote
    );
  }

  if (customPrompt) {
    parts.push(
      "",
      "【用户本次提示词】",
      "以下文字只用于补充换背景目标；如果与图1人物锁定或图2场景标准冲突，必须以图1和图2硬规则为准。",
      customPrompt
    );
  }

  parts.push(
    "",
    "【最终检查】",
    "检查人物位置、比例、姿势、脸、发型、服装、手脚和鞋子是否与图1一致；检查场景光影、色调、透视和地面接触是否像图2统一场景；检查结果是否仍然方便后期 PS 贴回。"
  );

  return parts.join("\n");
}

function faceSwapModelSkill(model) {
  if (model === "gpt-image") {
    return [
      "模型适配：GPT 图片编辑模型按“局部身份替换”理解，严格分层处理图1目标人物和图2人脸身份参考。",
      "图1是不可移动底图：头部位置、脸部朝向、头发轮廓、身体姿势、服装、背景、光影和裁切都保持。",
      "图2主要提供身份特征：五官比例、脸型、年龄感、皮肤质感和妆容气质；发型只参考方向、发色趋势和刘海/发缝等可融合特征，不复制图2衣服、背景、饰品或拍摄角度。",
      "如果开启局部回贴，只生成当前脸部选区，不输出整张图，不扩展画布，不添加边框，边缘要自然承接原图光影。"
    ];
  }

  if (model === "nano-banana2") {
    return [
      "模型适配：Nano Banana 2 容易移动头脸，必须使用短句硬锁。",
      "图1头部坐标不变，脸中心不变，头大小不变，脸朝向不变，脖子和肩膀关系不变。",
      "只换脸部身份，不换身体，不换衣服，不换背景，不移动图1发型外轮廓，不重新摆拍。",
      "图2只参考五官、身份和可融合的发型方向，不复制图2姿势、镜头、光线、衣服、背景或饰品。",
      "局部回贴时只输出选区内的脸部结果，保持同角度、同光影、同皮肤明暗过渡。"
    ];
  }

  if (model === "nano-banana-pro") {
    return [
      "模型适配：Nano Banana Pro 偏写实商业图，重点让换脸后仍像图1原片自然拍摄。",
      "保留图1构图、头脸位置、发型轮廓、身体服装和背景；图2只提供身份和五官参考。",
      "融合肤色、妆容、光影和清晰度，但不能移动头部、改变表情幅度、改变头身比例或重绘服装。"
    ];
  }

  return [
    "模型适配：当前模型使用短句硬约束执行换脸。",
    "图1保持位置、头部大小、脸朝向、身体、衣服、背景。",
    "图2只提供人脸身份和五官，不复制衣服背景。",
    "只换脸，不换身体，不换装，不移动人物，不输出拼贴对比图。"
  ];
}

function buildFaceSwapPrompt(payload) {
  const customPrompt = String(payload.prompt || "").trim();
  const productNote = String(payload.productNote || "").trim();
  const poseAnchorPrompt = String(payload.poseAnchorPrompt || "").trim();
  const ratio = String(payload.aspectRatio || "1:1");
  const imageSize = String(payload.imageSize || "2K");
  const referenceCount = Number.parseInt(payload.referenceCount || "0", 10) || 0;
  const localEditEnabled = Boolean(payload.localEdit?.enabled || payload.localEdit === true);
  const localEditIsMask = localEditEnabled && String(payload.localEdit?.editMode || "") === "mask";
  const modelTitle = String(payload?.uploadLabels?.model?.title || "目标人物图").trim();
  const faceTitle = String(payload?.uploadLabels?.clothing?.title || "人脸参考图").trim();
  const referenceTitle = String(payload?.uploadLabels?.reference?.title || "妆容/表情补充图").trim();
  const parts = [
    "【电商批量换脸 Skill】",
    "目标：把图2的人脸身份自然替换到图1人物上，生成可以继续后期 PS 使用的真实成片。这个任务是换脸，不是换装、不是换背景、不是重新生成相似人物。",
    "核心原则：图1负责全部画面事实和坐标，图2只负责人脸身份；图3只做可选补充。必须保证头部位置稳定，方便后期贴回或对齐。",
    "",
    `当前页面图1标题：${modelTitle}`,
    `当前页面图2标题：${faceTitle}`,
    `当前页面图3标题：${referenceTitle}`,
    "",
    "【图片编号规则】",
    "图1：当前要换脸的目标人物原图。必须保留图1的身体、服装、姿势、背景、构图、镜头距离、头部位置、头部大小、脸部朝向、发型轮廓和原始光影。",
    "图2：人脸身份参考图。可以是一张或多张，提取身份、五官比例、脸型、年龄感、皮肤质感、妆容气质，并可参考发型方向、发色趋势、刘海、发缝和卷直程度；不要复制图2的衣服、背景、饰品、拍摄角度或场景。",
    referenceCount > 0
      ? `图3及后续 ${referenceCount} 张：可选补充参考，只能用于补充妆容、表情、年龄感、肤色细节、客户要求或禁忌，不允许改变图1身体服装和背景。`
      : "当前没有图3补充图时，不要凭空添加额外妆容、饰品、文字、水印或新背景。",
    "",
    "【图1硬锁定】",
    "必须保持图1人物头部中心坐标、头顶位置、下巴位置、脸部朝向、脸部倾斜、头部大小、头颈关系、肩颈方向、发型外轮廓、身体比例、服装款式、服装颜色、手脚姿势、背景和画面裁切不变。",
    "禁止因为换脸而把头摆正、把脸重新居中、移动头部、缩放头部、改变脖子长度、改变肩线、改变身体、换衣服、换发型轮廓、换背景、改变光源方向或重构画面。",
    "",
    "【图2身份迁移】",
    "只迁移图2的人脸身份特征：五官结构、脸型、年龄感、皮肤质感、妆容气质和可见表情气质。迁移必须适配图1原有的脸部角度、头部倾斜、光影方向和清晰度。",
    "如果图2与图1角度不同，不能让图1头部跟着转向图2；必须把图2身份贴合到图1原有头脸角度。若身份参考不完整，优先保持图1头部坐标和自然真实，不要编造夸张五官。",
    "",
    "【局部回贴模式】",
    localEditEnabled
      ? localEditIsMask
        ? "本次已开启涂抹蒙版局部回贴：图1发送给模型的是包含涂抹脸部/局部细节周边上下文的选区。未涂抹区域只作为头脸角度、肤色、头发、背景和光影参考，重点处理被涂抹的人脸身份或细节区域；画布比例和选区一致，不要输出整张人物图，不要添加边框，不要扩展画布；系统会只把涂抹区域羽化贴回原图同一坐标。"
        : "本次已开启局部回贴：图1发送给模型的是原图脸部附近选区。只输出这个选区内的换脸结果，画布比例和选区一致，不要输出整张人物图，不要添加边框，不要扩展画布；系统会把结果贴回原图同一坐标。选区边缘要保持原图肤色、头发、背景和光影连续。"
      : "如未开启局部回贴，也必须尽量只改变脸部身份，不要改变图1身体、服装、背景、头部位置和构图。",
    "",
    "【真实融合】",
    "换脸后要像图1现场真实拍摄出来的人：肤色、曝光、阴影、面部清晰度、噪点、镜头质感和周围头发边缘都要统一。不能出现面具感、贴纸感、边缘硬切、双脸、错位五官、过度磨皮、脸部漂移或头发背景被大片重绘。",
    "",
    "【禁止内容】",
    "不要换衣、不要换身体、不要换背景、不要移动人物、不要改变发型轮廓、不要改变头部大小、不要新增人物、不要输出对比图、拼贴图、文字、水印、标注框或步骤图。",
    `输出比例：${ratio}；输出清晰度：${imageSize}。`
  ];

  parts.push("", ...faceSwapHairStyleRules());
  if (localEditEnabled) {
    parts.push("", ...localEditMaterialContinuityRules(localEditIsMask));
  }

  parts.push("", "【模型提示词适配】", ...faceSwapModelSkill(payload.model));

  if (poseAnchorPrompt) {
    parts.push(
      "",
      "【智能介入：图1头脸坐标锚点】",
      "以下锚点来自文本/视觉模型对图1的预分析，优先级高于用户补充信息；用于让当前生图模型保持图1头部坐标、脸部朝向、发型轮廓和人物站位。",
      poseAnchorPrompt
    );
  }

  if (productNote) {
    parts.push(
      "",
      "【本次补充信息】",
      "以下内容只能补充换脸目标、妆容表情或客户要求；如果和图1硬锁定冲突，必须以图1头脸坐标和身体背景不变为准。",
      productNote
    );
  }

  if (customPrompt) {
    parts.push(
      "",
      "【用户本次提示词】",
      "以下文字只用于补充本次换脸目标；如果与图1头部坐标、身体服装背景不变冲突，必须以上方硬规则为准。",
      customPrompt
    );
  }

  parts.push(
    "",
    "【最终检查】",
    "检查脸部身份是否来自图2；检查图1头部坐标、脸部角度、身体、服装、背景和画面裁切是否未变化；检查边缘、肤色和光影是否自然。"
  );

  return parts.join("\n");
}

export function buildOutfitPrompt(payload) {
  if (isCustomWorkflow(payload)) {
    return buildCustomPrompt(payload);
  }

  if (isFaceSwapWorkflow(payload)) {
    return buildFaceSwapPrompt(payload);
  }

  if (isBackgroundChangeWorkflow(payload)) {
    return buildBackgroundChangePrompt(payload);
  }

  if (isDesignDraftWorkflow(payload)) {
    return buildDesignDraftPrompt(payload);
  }

  const customPrompt = String(payload.prompt || "").trim();
  const productNote = String(payload.productNote || "").trim();
  const poseAnchorPrompt = String(payload.poseAnchorPrompt || "").trim();
  const ratio = String(payload.aspectRatio || "3:4");
  const imageSize = String(payload.imageSize || "2K");
  const referenceCount = Number.parseInt(payload.referenceCount || "0", 10) || 0;
  const localEditEnabled = Boolean(payload.localEdit?.enabled || payload.localEdit === true);
  const localEditIsMask = localEditEnabled && String(payload.localEdit?.editMode || "") === "mask";
  const localEditHasContext = localEditEnabled && Boolean(payload.localEdit?.contextRect);
  const localEditBanana2 = localEditEnabled && /^nano-banana2$/i.test(String(payload.model || ""));
  const garmentParts = normalizeGarmentParts(payload.garmentParts);
  const garmentLengthLines = buildGarmentLengthSkill(garmentParts, payload.garmentLengths);
  const parts = [
    "【批量生成换装 Skill】",
    "任务：让图1当前人物穿着图2服装，生成自然干净的电商成片。批量时每次只处理当前这张图1，图2在整批中保持同一服装标准。",
    "图1负责人物和画面事实：身份、发型、头部坐标、身材比例、姿态、手脚动作、镜头、背景、光影和画面位置都保持。",
    "图2负责服装事实：只提取服装本身，不复制图2人物、姿势、背景或无关道具。",
    "只做真实穿着适配和自然褶皱；不要按模型审美把图2服装改短、收腰、修身、瘦身、变顺滑、变完美或简化细节。"
  ];

  parts.push("", "【图2迁移范围】", ...buildGarmentPartSkill(garmentParts));
  if (garmentLengthLines.length > 0) {
    parts.push("", "【服装长度落点】", ...garmentLengthLines);
  }

  if (referenceCount > 0) {
    parts.push(`图3及后续 ${referenceCount} 张只做可选补充：配饰、鞋包、物品、场景调性或客户要求；不能替代图2服装。`);
  } else {
    parts.push("没有图3补充时，不要凭空增加配饰、文字、水印、Logo 或复杂道具。");
  }

  if (localEditEnabled) {
    parts.push(
      "",
      "【图1局部回贴】",
      localEditIsMask
        ? "图1已开启涂抹蒙版局部回贴：只处理被涂抹区域，未涂抹区域用于理解姿态、光影、肤色、背景和衣纹。输出画布必须和选区一致，系统会把蒙版区域羽化贴回原图坐标。"
        : "图1已开启框选局部回贴：只生成这个选区内的换装/细节修正结果，输出画布必须和选区一致，系统会贴回原图同一坐标。",
      localEditHasContext
        ? "系统为了稳定贴回，图1可能包含比实际贴回范围更大的上下文；外围只用于对齐头脸、发丝、肩颈、背景线条、光影和透视，不要重构人物坐标。"
        : "",
      localEditBanana2
        ? "Nano Banana 2 局部回贴容易重排侧身头颈和肩线；把图1局部当成固定坐标补丁，不要重新摆拍、移动脖子、改变下巴位置、重画肩颈连接或让上下身体错位。"
        : "",
      "选区边缘延续原图光影、肤色、背景和服装纹理；未被用户要求改变的面料事实保持原图观感。"
    );
  }

  parts.push("", "【模型适配】", ...modelPromptSkill(payload.model, { localEditEnabled }));

  if (poseAnchorPrompt) {
    parts.push("", "【智能文本锚点】", poseAnchorPrompt);
  }

  if (productNote) {
    parts.push("", "【本次补充】", productNote);
  }

  if (customPrompt) {
    parts.push("", "【前端提示词】", customPrompt);
  }

  parts.push("", `输出比例：${ratio}；输出清晰度：${imageSize}。`);

  return parts.join("\n");
}
