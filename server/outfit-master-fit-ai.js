const DEFAULT_OUTFIT_MASTER_FIT_MODEL = "gpt-5.4-mini";
const OUTFIT_MASTER_FIT_TIMEOUT_MS = 60000;

// 中文注释：把任意输入整理成可放进模型请求的短文本，避免 undefined/null 混入提示词。
function asText(value, fallback = "") {
  const text = String(value ?? "").trim();
  return text || fallback;
}

// 中文注释：压缩模型返回或日志文本，保留有效信息并限制长度，避免提示词过长。
function compact(value, limit = 1200) {
  return String(value || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, limit);
}

// 中文注释：选择用于图2母版分析的视觉文本模型，默认沿用现有换装智能文本模型。
function modelName(input) {
  return asText(input.outfitMasterFitModel || input.outfitPoseModel || input.detailAnalysisModel || input.textModel, DEFAULT_OUTFIT_MASTER_FIT_MODEL);
}

// 中文注释：给上游请求加超时控制，防止分析接口长时间挂起前端。
function createAbortSignal(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    dispose: () => clearTimeout(timer)
  };
}

// 中文注释：兼容不同中转站的 JSON/纯文本错误返回，便于后续提取错误信息。
function readResponse(response) {
  return response.text().then((text) => {
    try {
      return { text, json: JSON.parse(text) };
    } catch {
      return { text, json: null };
    }
  });
}

// 中文注释：从 chat/completions 响应中提取正文，兼容字符串和多段 content。
function responseContent(payload) {
  const message = payload?.choices?.[0]?.message;
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content.map((part) => part.text || part.content || "").join("\n");
  }
  return "";
}

// 中文注释：模型有时会包一层 Markdown，这里只抽取 JSON 对象本体。
function extractJsonObject(text) {
  const raw = String(text || "").trim();
  if (!raw) throw new Error("图2母版版型分析模型没有返回内容");
  const unfenced = raw
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();
  try {
    return JSON.parse(unfenced);
  } catch {
    const start = unfenced.indexOf("{");
    const end = unfenced.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(unfenced.slice(start, end + 1));
    throw new Error("图2母版版型分析模型返回的不是有效 JSON");
  }
}

// 中文注释：部分中转站不支持 response_format，遇到这类错误后改用普通 JSON 提示重试。
function shouldRetryWithoutJsonFormat(status, text) {
  const source = `${status} ${text}`.toLowerCase();
  return status >= 400 && (
    source.includes("response_format") ||
    source.includes("json_object") ||
    source.includes("unsupported")
  );
}

// 中文注释：把上传的图2母版转成 chat/completions 可识别的图片输入。
function safeImagePart(file) {
  return {
    type: "image_url",
    image_url: {
      url: `data:${file.mimetype || "image/png"};base64,${file.buffer.toString("base64")}`,
      detail: "high"
    }
  };
}

// 中文注释：记录图2文件基础信息，只用于分析上下文和本地日志，不包含用户 Key。
function fileMeta(file) {
  return {
    name: file.originalname || "clothing-master-image",
    type: file.mimetype || "",
    size: file.size || file.buffer?.length || 0
  };
}

// 中文注释：把数组或字符串字段整理为一句中文，方便拼回可编辑规格表。
function fieldText(value, fallback = "", limit = 360) {
  if (Array.isArray(value)) return compact(value.filter(Boolean).join("；"), limit);
  return compact(value || fallback, limit);
}

const MASTER_GARMENT_PART_OPTIONS = [
  { value: "upper", label: "上装/外套/内搭" },
  { value: "lower", label: "下装/裙裤" },
  { value: "shoes", label: "鞋子" }
];
const DEFAULT_MASTER_GARMENT_PARTS = ["upper"];
const MASTER_GARMENT_COMPOSITION_OPTIONS = [
  {
    value: "single-upper",
    label: "单件上衣",
    rule: "图2上装按单件上衣分析；不要默认拆成外套+内搭，除非画面清楚存在独立外层和独立内搭。"
  },
  {
    value: "upper-layer",
    label: "外套+内搭",
    rule: "图2上装按外层+内搭组合分析；分别记录外层开合、内搭外露范围和两层衣摆关系。"
  },
  {
    value: "outfit-set",
    label: "套装/上下装组合",
    rule: "图2按上装和下装成套穿法分析；上装与下装的搭配关系、长度和穿法都要保持一致。"
  },
  {
    value: "custom",
    label: "自定义范围",
    rule: "按当前勾选部位和图2可见事实分析；不自动推断未勾选部位。"
  }
];
const DEFAULT_MASTER_GARMENT_COMPOSITION = "single-upper";

function normalizeGarmentParts(value) {
  const raw = Array.isArray(value) ? value : String(value || "").split(/[,\s|，、]+/);
  const next = MASTER_GARMENT_PART_OPTIONS
    .map((option) => option.value)
    .filter((part) => raw.includes(part));
  return next.length > 0 ? next : DEFAULT_MASTER_GARMENT_PARTS;
}

function garmentScope(input) {
  const parts = normalizeGarmentParts(input?.garmentParts);
  return {
    parts,
    upper: parts.includes("upper"),
    lower: parts.includes("lower"),
    shoes: parts.includes("shoes"),
    labels: parts
      .map((part) => MASTER_GARMENT_PART_OPTIONS.find((option) => option.value === part)?.label || part)
      .join("、")
  };
}

function normalizeGarmentComposition(value, parts = DEFAULT_MASTER_GARMENT_PARTS) {
  const allowed = new Set(MASTER_GARMENT_COMPOSITION_OPTIONS.map((option) => option.value));
  const selected = normalizeGarmentParts(parts);
  const next = allowed.has(String(value || "")) ? String(value) : DEFAULT_MASTER_GARMENT_COMPOSITION;
  const upperOnly = selected.length === 1 && selected.includes("upper");
  const upperLowerOnly = selected.length === 2 && selected.includes("upper") && selected.includes("lower");
  if (["single-upper", "upper-layer"].includes(next)) return upperOnly ? next : "custom";
  if (next === "outfit-set") return upperLowerOnly ? next : "custom";
  return "custom";
}

function garmentComposition(input, scope) {
  const value = normalizeGarmentComposition(input?.garmentComposition, scope?.parts || DEFAULT_MASTER_GARMENT_PARTS);
  return MASTER_GARMENT_COMPOSITION_OPTIONS.find((option) => option.value === value)
    || MASTER_GARMENT_COMPOSITION_OPTIONS.find((option) => option.value === "custom");
}

function stripUnselectedLowerText(text, scope) {
  let next = String(text || "");
  if (!scope.lower) {
    next = next
      .split(/[；;。\n]/)
      .map((part) => part.trim())
      .filter((part) => part && !/(下装|下半身|裙|裤|裙摆|裤脚|裤腰|裙腰|腿部|大腿|小腿|袜靴|鞋靴)/.test(part))
      .join("；");
  }
  if (!scope.shoes) {
    next = next
      .split(/[；;。\n]/)
      .map((part) => part.trim())
      .filter((part) => part && !/(鞋|靴|脚踝|脚部)/.test(part))
      .join("；");
  }
  return compact(next, 360);
}

function sanitizeUpperOnlyTuckDrape(text) {
  const raw = compact(text, 360);
  if (!raw) return "";
  return raw
    .split(/[；;。\n]/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => part
      .replace(/(?:高腰)?(?:黑色|白色|蓝色|灰色|粉色|米色|浅色)?(?:A字)?(?:短裙|长裙|半身裙|裙子|裤子|牛仔裤|西裤|短裤|裙裤)/g, "图1原下装")
      .replace(/(?:裙腰|裤腰|腰头)/g, "腰部位置")
      .replace(/(?:图2)?(?:下装|下半身)(?:的)?(?:类型|颜色|长度|裙裤类型|裙裤颜色|裙裤长度)[^；;。\n]*/g, "图2下装类型、颜色和长度不迁移"))
    .filter((part) => {
      if (!part) return false;
      const upperFact = /(上衣|上装|衣摆|下摆|前摆|后摆|外穿|扎入|半扎|开襟|内搭|门襟|包裹|重叠|露出|落点|覆盖|遮挡|腰部)/.test(part);
      const lowerOnly = /(图1原下装|图2下装|腿部|袜靴|鞋靴|大腿|小腿)/.test(part) && !upperFact;
      return !lowerOnly;
    })
    .join("；");
}

function scopeMasterFitFields(fields, scope) {
  const next = { ...fields };
  if (!scope.lower) {
    next.garmentCategory = stripUnselectedLowerText(next.garmentCategory, scope) || "只锁定图2已选上装/外套/内搭；图2下装不迁移";
    next.tuckDrape = sanitizeUpperOnlyTuckDrape(next.tuckDrape)
      || "按图2上装衣摆当前可见状态保持，不在外穿、扎入、半扎、开襟之间随机切换；图2下装类型、颜色和长度不迁移，结果下装以图1原图为准。";
    next.zipperBeltState = stripUnselectedLowerText(next.zipperBeltState, scope) || "只记录已选上装相关拉链、门襟、系带或扣合位置；图2下装腰头不迁移。";
    next.waistFit = stripUnselectedLowerText(next.waistFit, scope) || "只记录已选上装的衣身松量与下摆落点；不锁定图2下装腰线。";
    next.lowerHem = "下装未选择：图2裙子、裤子、腿部、袜靴和下摆层次全部不作为迁移事实；图1原下装保持原样。";
    next.wearingDriftBan = [
      stripUnselectedLowerText(next.wearingDriftBan, scope),
      "禁止把图2未选中的裙子、裤子、腿部、袜靴、下装颜色或下装长度带入图1。"
    ].filter(Boolean).join("；");
    next.driftBan = [
      stripUnselectedLowerText(next.driftBan, scope),
      "禁止复制图2人物脸、下巴、脖子轮廓、身体姿态、下半身和背景。"
    ].filter(Boolean).join("；");
  }
  if (!scope.shoes) {
    next.details = stripUnselectedLowerText(next.details, scope) || next.details;
  }
  return next;
}

function conciseField(value, fallback = "", limit = 160) {
  return compact(value || fallback, limit).replace(/\s+/g, " ");
}

function masterFact(value, fallback = "", limit = 120) {
  const cleaned = conciseField(value, fallback, limit)
    .replace(/([，；。,.]?\s*(?:必须|禁止|不允许|不得|不要|不能|严禁)[^；。,.，]*)/g, "")
    .replace(/\s+/g, " ")
    .replace(/[，；。,.]+$/g, "");
  return cleaned || conciseField(fallback, "", limit);
}

function buildConciseMasterFitPromptBlock(fields, scope, composition) {
  const facts = [
    `类别/结构：${masterFact(fields.garmentCategory, "图2已选服装类别", 100)}，${composition.label}`,
    `版型：${masterFact(fields.silhouette, "图2版型和松量", 120)}；${masterFact(fields.waistFit, "图2腰身松量", 90)}；${masterFact(fields.upperHem, "图2上装衣长和下摆落点", 90)}`,
    scope.lower ? `下装：${masterFact(fields.lowerHem, "图2下装长度和下摆", 90)}` : "",
    `袖口：${masterFact(fields.sleeveCuff, "图2袖长、袖口和袖克夫比例", 120)}；${masterFact(fields.sleeveWearing, "图2袖子放下/卷起状态和袖口落点", 110)}`,
    `领口门襟：${masterFact(fields.closureState, "图2门襟和扣合状态", 110)}；${masterFact(fields.buttonCountState, "图2可见扣子开合比例", 90)}；${masterFact(fields.zipperBeltState, "图2拉链、腰带系法和自由端长度", 120)}；${masterFact(fields.necklineOpening, "图2领口开口范围", 80)}`,
    `衣摆：${masterFact(fields.tuckDrape, "图2当前可见衣摆状态和落点", 120)}`,
    `材质细节：${masterFact(fields.material, "图2材质、厚薄、垂感、光泽和纹理", 100)}；${masterFact(fields.details, "图2可见工艺细节", 120)}`
  ].filter(Boolean);

  return compact(`图2母版事实补充（${scope.labels}）：${facts.join("；")}。`, 560);
}

function buildConciseMasterFitSpec(fields, scope, composition) {
  return compact([
    `迁移范围：${scope.labels}`,
    `服装结构：${composition.label}`,
    `服装母版：${masterFact(fields.garmentCategory, "图2服装类别")}；${masterFact(fields.silhouette, "图2版型和松量")}`,
    `版型尺码感：${masterFact(fields.waistFit, "图2腰身松量")}；${masterFact(fields.upperHem, "图2上装衣长和下摆落点")}${scope.lower ? `；${masterFact(fields.lowerHem, "图2下装长度和下摆")}` : ""}`,
    `袖口袖克夫：${masterFact(fields.sleeveCuff, "图2袖长、袖口和袖克夫比例")}；${masterFact(fields.sleeveWearing, "图2袖子穿法和袖口落点")}`,
    `领口门襟扣合：${masterFact(fields.closureState, "图2门襟和扣合状态")}；${masterFact(fields.buttonCountState, "图2可见扣子开合比例")}；${masterFact(fields.zipperBeltState, "图2拉链、腰带系法、结点和自由端相对落点")}；${masterFact(fields.necklineOpening, "图2领口开口范围")}`,
    `衣摆穿法：${masterFact(fields.tuckDrape, "图2当前可见衣摆状态和落点")}`,
    `材质细节：${masterFact(fields.material, "图2材质、厚薄、垂感、光泽和纹理")}；${masterFact(fields.details, "图2可见工艺细节")}`
  ].join("\n"), 900);
}

// 中文注释：构造给视觉模型的图2母版分析任务，重点提取人体相对落点而不是重新设计服装。
function buildMasterFitAnalysisContent(input, clothingFile) {
  const targetImageModel = asText(input.model, "gpt-image");
  const scope = garmentScope(input);
  const composition = garmentComposition(input, scope);
  const payload = {
    task: "电商 AI 批量换装图2母版服装事实分析",
    goal: `只分析图2这张已经上身的服装母版里【本次勾选迁移范围】对应的可见服装事实：${scope.labels}；本次服装结构按【${composition.label}】理解。把选中范围的类别、版型、松量、长度落点、袖口袖克夫、扣合状态、穿法扎法、衣摆关系和面料细节提取成轻量事实补充，不写成长规则清单。`,
    image: {
      role: "图2：服装上身母版图",
      meta: fileMeta(clothingFile)
    },
    input: {
      targetImageModel,
      aspectRatio: asText(input.aspectRatio, "3:4"),
      imageSize: asText(input.imageSize, "2K"),
      garmentParts: input.garmentParts || [],
      garmentComposition: composition.value,
      garmentCompositionLabel: composition.label,
      garmentLengths: input.garmentLengths || {},
      userPrompt: asText(input.prompt),
      productNote: asText(input.productNote)
    },
    scopeRules: {
      selectedTransferScope: scope.labels,
      garmentComposition: `${composition.label}：${composition.rule}`,
      lowerSelected: scope.lower,
      shoesSelected: scope.shoes,
      upperSelected: scope.upper,
      lowerRule: scope.lower
        ? "已选择下装，可以分析图2裙裤长度、下摆、开衩、腰头和下装穿法。"
        : "未选择下装：图2里的裙子、裤子、腿部、袜靴、下摆层次、下装颜色和下装长度都是非迁移上下文，不得写入服装类别、lowerHem 或 promptBlock；只能用中性语言说明上装衣摆相对图1原下装的外穿/扎入/遮挡关系。",
      shoesRule: scope.shoes
        ? "已选择鞋子，可以分析图2鞋靴。"
        : "未选择鞋子：图2鞋子、袜靴、脚踝和脚部姿态不得写入迁移规格。"
    },
    instructions: [
      "图2不是灵感图，而是同一批图1要统一复刻的母版规格；请优先描述服装在人体上的相对位置和比例。",
      "不要识别人物身份，不要评价长相，不要输出隐私信息；不要把图2人物的脸、下巴、脖子轮廓、身体姿势、背景和道具写入服装规格；只看勾选范围内的服装、面料、结构线和人体相对落点。",
      "必须先执行 scopeRules：未选择的图2部位只能视为非迁移上下文，不能进入 promptBlock 的硬约束，也不能被写成结果必须生成的服装事实。",
      `服装结构类型只用于判断图2真实服装事实：${composition.rule}`,
      "必须特别关注袖子穿法：袖子是自然放下、卷起、挽起、堆在前臂，还是被手臂遮挡；袖口具体落在掌根、腕骨、手背、前臂上段/中段/下段或其他相对位置；卷袖要记录高度、层数、折边宽度和褶皱状态。",
      "必须特别关注风衣/大衣袖克夫：记录袖克夫宽度、环绕位置、袢带方向、扣位、折边、压线和与袖口边缘的距离；如果正面摆拍只露出半边袖克夫，只描述可见比例和保守延续方式，不要补成另一种袖口设计。",
      "必须特别关注扣合和穿法：门襟是全扣、半扣、敞开、内搭外露还是仅上/中/下部分扣合；如果可见扣子，请描述总量、已扣/未扣的大致位置、领口开口大小和下摆开口状态。",
      "必须单独记录扣子数量和开合事实：可见扣子总数、已扣几颗、未扣几颗、从上到下哪几颗打开或扣合、是否只扣中间或只扣下部；看不清时写“按图2可见扣合比例保持，不允许随机全扣或全开”。",
      "必须记录拉链、腰带、系带和领口开口：拉链高度、腰带系法/腰头遮挡、系带是否打结、结点位置、左右自由端长度差、自由端垂落方向、尾端落到腰线/胯部/衣摆哪个相对位置、领口开口深度、翻领角度、内搭外露范围都要作为穿法事实。",
      "必须特别关注衣摆关系：上衣是完全外穿、完全扎入、前中扎入、半扎、只扎一侧、两侧露出、衣摆敞开还是被下装/腰部遮住；如果未选择下装，只能描述上装自身衣摆穿法，不得写图2具体裙裤名称、颜色和长度。",
      "必须特别关注袖口位置、袖克夫长度、肩线、领口、腰线、腰身贴合、已选下装长度、下摆宽度、开衩和可见工艺细节。",
      "如果图中某项不清楚，只写“按图2可见比例”或“看不清不扩写”，不要补成禁止规则。",
      `输出的 promptBlock 必须是给 ${targetImageModel} 图片生成模型看的轻量中文事实补充，只能包含已选迁移范围 ${scope.labels} 的可见服装事实；不要重复通用提示词里的质量规则、禁止规则、图1姿态规则或未选部位规则。`,
      "只输出 JSON，不要 Markdown，不要解释。"
    ],
    outputSchema: {
      garmentCategory: "string，只写已选迁移范围内的服装类别与组合，例如单件上衣、外套+内搭或套装；未选择下装时不得写裙/裤",
      silhouette: "string，整体廓形、修身/宽松程度、肩宽、腰身、下摆轮廓",
      shoulderNeckline: "string，肩线、领口、门襟、衣身结构线",
      sleeveCuff: "string，袖型、袖长、袖口到手腕落点、袖克夫宽度、环绕位置、袢带/扣位/折边/压线和收口方式；只露出半边时写可见比例",
      sleeveWearing: "string，袖子穿法与状态，例如自然放下/卷起/挽起/堆褶；袖口落在掌根、腕骨、手背或前臂的具体相对位置；卷袖高度、层数、折边宽度和褶皱状态",
      closureState: "string，扣子/拉链/门襟状态，例如全扣、半扣、敞开、未扣几颗、已扣几颗、领口和下摆开口状态",
      buttonCountState: "string，可见扣子总数、已扣/未扣数量、从上到下的开合位置；不清楚时给保守锁定规则",
      zipperBeltState: "string，拉链高度、腰带/系带/腰头遮挡、腰部配件、腰带结点位置、左右自由端长度、垂落方向、尾端相对落点和上下装关系",
      necklineOpening: "string，领口开口深度、翻领角度、内搭外露范围、门襟上部开合",
      tuckDrape: scope.lower
        ? "string，上衣衣摆和已选下装穿法关系，例如完全扎入裙/裤、前中扎入两侧外露、半扎、外穿、敞开下摆、被腰带或裙腰遮住"
        : "string，只写图2上衣衣摆当前唯一真实状态和落点，例如已外穿且下摆落在腰部下方、已完全扎入、前中扎入两侧外露、半扎、开襟下摆自然垂落；不得输出“外穿、扎入、半扎”这种选项列表；不得写图2具体裙裤名称、颜色和长度",
      waistFit: "string，腰线位置、腰身粗细、收腰程度、松量",
      upperHem: "string，上装衣长和下摆相对人体落点",
      lowerHem: scope.lower ? "string，已选下装的裙/裤长度、下摆宽度、开衩和相对腿部落点" : "string，固定写下装未选择，不迁移图2裙裤，图1下装保持原样",
      material: "string，面料类别、厚薄、垂感、光泽、纹理、褶皱密度",
      details: "string，扣子、拉链、口袋、拼接、压线、装饰等可见细节",
      wearingDriftBan: "string，禁止穿法漂移项，明确袖子、扣合、衣摆扎法、上下装关系哪些不能改变",
      driftBan: "string，禁止漂移项，明确哪些地方不能变短、变长、变宽、变窄、简化或重设计",
      promptBlock: "string，120-360字中文，后续直接注入换装提示词的母版事实补充；只写已选范围的可见事实，不写必须/禁止/不允许/不得类规则，不得包含未选图2下装/鞋子/人物脸和背景"
    }
  };

  return [
    { type: "text", text: JSON.stringify(payload, null, 2) },
    { type: "text", text: `图2服装上身母版图：${clothingFile.originalname || "clothing-master-image"}` },
    safeImagePart(clothingFile)
  ];
}

// 中文注释：组装 chat/completions 请求体，使用低温度让规格提取尽量稳定。
function buildChatBody(input, clothingFile, withJsonFormat) {
  const body = {
    model: modelName(input),
    temperature: 0.1,
    messages: [
      {
        role: "system",
        content: [
          "你是电商 AI 换装母版版型质检师和提示词架构师。",
          "你的任务是从图2上身母版中提取可复用的服装规格，让同一件衣服迁移到不同图1姿势时保持版型、袖口、腰身、裙长、材质和细节一致。",
          "必须输出严格 JSON。"
        ].join("\n")
      },
      {
        role: "user",
        content: buildMasterFitAnalysisContent(input, clothingFile)
      }
    ]
  };
  if (withJsonFormat) body.response_format = { type: "json_object" };
  return body;
}

// 中文注释：向候选中转站发起图2母版分析请求，外层会按渠道顺序重试。
async function postChatCompletion({ baseUrl, apiKey, input, clothingFile, withJsonFormat, signal }) {
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(buildChatBody(input, clothingFile, withJsonFormat)),
    signal
  });
  const parsed = await readResponse(response);
  return { response, parsed };
}

// 中文注释：把模型 JSON 规整成前端可编辑的规格表，同时保留可直接注入的 promptBlock。
function normalizeMasterFitPlan(plan, input = {}) {
  const scope = garmentScope(input);
  const composition = garmentComposition(input, scope);
  const fields = scopeMasterFitFields({
    garmentCategory: fieldText(plan?.garmentCategory, "按图2可见服装类别保持"),
    silhouette: fieldText(plan?.silhouette, "按图2整体廓形、松量和下摆轮廓保持"),
    shoulderNeckline: fieldText(plan?.shoulderNeckline, "按图2肩线、领口和衣身结构保持"),
    sleeveCuff: fieldText(plan?.sleeveCuff, "按图2袖长、袖口和袖克夫比例保持"),
    sleeveWearing: fieldText(plan?.sleeveWearing, "按图2袖子穿法、袖口落点、卷袖/放下状态保持"),
    closureState: fieldText(plan?.closureState, "按图2门襟、扣子、拉链和开合状态保持"),
    buttonCountState: fieldText(plan?.buttonCountState, "按图2可见扣子数量、扣合数量和从上到下的开合位置保持；看不清时禁止随机全扣或全开"),
    zipperBeltState: fieldText(plan?.zipperBeltState, "按图2拉链高度、腰带系法、结点位置、左右自由端长度、垂落方向、尾端落点和腰部配件关系保持"),
    necklineOpening: fieldText(plan?.necklineOpening, "按图2领口开口深度、翻领角度、内搭外露范围和门襟上部开合保持"),
    tuckDrape: fieldText(plan?.tuckDrape, "按图2衣摆扎法、外穿/内扎关系和下摆露出边界保持"),
    waistFit: fieldText(plan?.waistFit, "按图2腰线、腰身粗细和贴合程度保持"),
    upperHem: fieldText(plan?.upperHem, "按图2上装衣长和下摆落点保持"),
    lowerHem: fieldText(plan?.lowerHem, "按图2裙/裤长度、下摆和开衩保持"),
    material: fieldText(plan?.material, "按图2面料、厚薄、垂感、光泽和纹理保持"),
    details: fieldText(plan?.details, "按图2可见工艺细节保持"),
    wearingDriftBan: fieldText(plan?.wearingDriftBan, "禁止生成模型自行改变袖子放下/卷起状态、扣合方式、衣摆扎法和上下装关系"),
    driftBan: fieldText(plan?.driftBan, "禁止生成模型自行改短、加长、收腰、放宽、简化细节或重设计")
  }, scope);
  const shortPromptBlock = buildConciseMasterFitPromptBlock(fields, scope, composition);
  const shortMasterFitSpec = buildConciseMasterFitSpec(fields, scope, composition);
  if (!shortPromptBlock && !shortMasterFitSpec) throw new Error("图2母版版型分析结果为空");
  return {
    ...fields,
    promptBlock: shortPromptBlock,
    masterFitSpec: shortMasterFitSpec
  };
}

// 中文注释：主入口；按当前 Key 的可用渠道依次分析图2母版，成功后返回可复用规格。
async function createOutfitMasterFitSpec({ input = {}, clothingFile, apiKey, baseUrls = [], timeoutMs = OUTFIT_MASTER_FIT_TIMEOUT_MS }) {
  if (!apiKey) throw new Error("缺少 API Key，无法调用图2母版版型分析模型");
  if (!clothingFile?.buffer) throw new Error("缺少图2服装母版，无法分析版型规格");
  const candidates = baseUrls.filter(Boolean);
  if (candidates.length === 0) throw new Error("没有可用的渠道地址");

  const startedAt = Date.now();
  const abort = createAbortSignal(timeoutMs);
  const attempts = [];

  try {
    for (const baseUrl of candidates) {
      for (const mode of [
        { withJsonFormat: true },
        { withJsonFormat: false }
      ]) {
        const { response, parsed } = await postChatCompletion({
          baseUrl,
          apiKey,
          input,
          clothingFile,
          withJsonFormat: mode.withJsonFormat,
          signal: abort.signal
        });
        const message = parsed.json?.error?.message || parsed.json?.message || parsed.text || `HTTP ${response.status}`;
        attempts.push({
          baseUrl,
          status: response.status,
          ok: response.ok,
          withJsonFormat: mode.withJsonFormat,
          message: String(message).slice(0, 260)
        });

        if (!response.ok && mode.withJsonFormat && shouldRetryWithoutJsonFormat(response.status, message)) continue;
        if (!response.ok) break;

        const plan = normalizeMasterFitPlan(extractJsonObject(responseContent(parsed.json)), input);
        return {
          ok: true,
          model: modelName(input),
          usedBaseUrl: baseUrl,
          mode: "ai-vision",
          timing: { totalMs: Date.now() - startedAt },
          attempts,
          source: fileMeta(clothingFile),
          ...plan
        };
      }
    }
  } finally {
    abort.dispose();
  }

  const last = attempts[attempts.length - 1];
  throw new Error(last?.message || "图2母版版型分析失败");
}

export {
  DEFAULT_OUTFIT_MASTER_FIT_MODEL,
  createOutfitMasterFitSpec
};
