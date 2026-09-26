import {
  FACT_UNRECOGNIZED,
  OUTFIT_PART_OPTIONS,
  normalizeOutfitFacts,
  normalizeOutfitParts,
  recognizedFactKeys,
  resolveUpperLayer
} from "../src/shared/outfit-intent.js";

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

// 中文注释：部位与上装层级都直接用共享模块的枚举，服务端不再维护第二份表。
// 分析请求带的是结构化换装意图（`outfitIntent`），与最终提示词编译器读的是同一份数据。
const DEFAULT_MASTER_GARMENT_PARTS = ["upper"];

function partLabel(part) {
  return OUTFIT_PART_OPTIONS.find((option) => option.value === part)?.label || part;
}

function garmentScope(input) {
  const intent = input?.outfitIntent && typeof input.outfitIntent === "object" ? input.outfitIntent : {};
  const normalized = normalizeOutfitParts(intent.parts);
  const parts = normalized.length > 0 ? normalized : DEFAULT_MASTER_GARMENT_PARTS;
  return {
    parts,
    upper: parts.includes("upper"),
    lower: parts.includes("lower"),
    shoes: parts.includes("shoes"),
    labels: parts.map((part) => partLabel(part)).join("、")
  };
}

/**
 * 上装层级：只影响"图2上装按一件还是内外两层去读"，不再是旧的单件上衣/外套+内搭/套装三选一。
 */
function upperLayerRule(input, scope) {
  if (!scope.upper) return { value: "none", label: "未选择上装", rule: "本次不改上装，不需要分析图2上装结构。" };
  const intent = input?.outfitIntent && typeof input.outfitIntent === "object" ? input.outfitIntent : {};
  const layer = resolveUpperLayer({ ...intent, parts: scope.parts });
  const rules = {
    single: "图2上装按【单件上装】读：不要默认拆成外套+内搭，除非画面清楚存在独立外层和独立内搭。",
    inner: "图2上装按【仅内搭】读：只描述内搭本身，不要把外层结构写进事实。",
    outer: "图2上装按【仅外套】读：只描述外层本身，不要把内搭写进事实。",
    "inner-outer": "图2上装按【内搭+外套两层】读：分别记录外层的开合、内搭的外露范围和两层衣摆关系。"
  };
  if (rules[layer.value]) return { value: layer.value, label: layer.promptLabel, rule: rules[layer.value] };
  return {
    value: layer.value,
    label: layer.promptLabel,
    rule: "图2上装没有指定层级（自动识别）：先按画面可见事实判断是一件还是内外两层，判断不了就写未识别，不要猜。"
  };
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

/**
 * 唯一的图2分析产物：结构化服装事实。
 *
 * 为什么不返回"整段提示词"：需求明确要求分析结果先转成结构化数据、只保留服装事实，
 * 由 `src/shared/outfit-intent.js` 的唯一编译器按本次选中部位压缩后插入最终提示词。
 * 这里**不再**拼 promptBlock / masterFitSpec（那两套近似模板已删除）。
 *
 * 规则：
 *   - 模型没回答或答不清的字段一律写"未识别"，绝不补默认句（不允许自行补全）；
 *   - 未选部位的文本直接丢掉（复用上面已按 scope 过滤的辅助函数）；
 *   - 人物身份、人脸发型肤色、背景光线、姿态、空泛套话在 outputSchema 阶段就不允许输出。
 */
function buildOutfitFacts(plan, input = {}) {
  const scope = garmentScope(input);
  const text = (value, limit = 200) => {
    const joined = Array.isArray(value) ? value.filter(Boolean).join("；") : String(value ?? "");
    return compact(joined, limit).replace(/\s+/g, " ");
  };
  // 未选下装/鞋子时把对应句子剔掉；剔干净了也算"未识别"，不补话。
  const scoped = (value, limit = 200) => {
    const raw = text(value, limit);
    if (!raw) return "";
    if (scope.lower && scope.shoes) return raw;
    const filtered = scope.lower ? raw : stripUnselectedLowerText(raw, scope);
    return filtered || FACT_UNRECOGNIZED;
  };
  const factOrUnknown = (value, limit = 200) => scoped(value, limit) || FACT_UNRECOGNIZED;
  const upperHem = text(plan?.upperHem, 120);
  const lowerHem = scope.lower ? text(plan?.lowerHem, 120) : "";
  const upperOnlyTuck = scope.lower ? text(plan?.tuckDrape, 160) : sanitizeUpperOnlyTuckDrape(plan?.tuckDrape);
  return normalizeOutfitFacts({
    category: factOrUnknown(plan?.garmentCategory),
    color: factOrUnknown(plan?.color, 120),
    material: factOrUnknown(plan?.material, 140),
    silhouette: factOrUnknown(plan?.silhouette, 140),
    length: factOrUnknown([upperHem, lowerHem].filter(Boolean).join("；"), 160),
    collarSleeve: factOrUnknown(
      [text(plan?.shoulderNeckline, 120), text(plan?.necklineOpening, 100), text(plan?.sleeveCuff, 120)].filter(Boolean).join("；"),
      200
    ),
    sleeveState: factOrUnknown(plan?.sleeveWearing, 160),
    closure: factOrUnknown(
      [text(plan?.closureState, 120), text(plan?.buttonCountState, 100), text(plan?.zipperBeltState, 120)].filter(Boolean).join("；"),
      220
    ),
    hem: factOrUnknown(upperOnlyTuck, 160),
    lowerType: scope.lower ? factOrUnknown(plan?.lowerHem, 140) : "",
    shoeType: scope.shoes ? factOrUnknown(plan?.shoeType, 100) : "",
    structure: factOrUnknown(plan?.details, 160)
  });
}

// 中文注释：构造给视觉模型的图2母版分析任务，重点提取人体相对落点而不是重新设计服装。
function buildMasterFitAnalysisContent(input, clothingFile) {
  const targetImageModel = asText(input.model, "gpt-image");
  const scope = garmentScope(input);
  const upperLayer = upperLayerRule(input, scope);
  const payload = {
    task: "电商 AI 批量换装图2服装事实分析",
    goal: `只分析图2这张已经上身的服装母版里【本次勾选迁移范围】对应的可见服装事实：${scope.labels}；图2上装按【${upperLayer.label}】读。把选中范围的类别与内外层、颜色、材质纹理、版型、长度、领口与袖长、袖子状态、扣子或拉链、衣摆扎入、裤型/裙型或鞋型、明显结构提取成结构化字段；不写提示词、不写规则清单、不写人物和背景。`,
    image: {
      role: "图2：服装上身母版图",
      meta: fileMeta(clothingFile)
    },
    input: {
      targetImageModel,
      aspectRatio: asText(input.aspectRatio, "3:4"),
      imageSize: asText(input.imageSize, "2K"),
      parts: scope.parts,
      upperLayer: upperLayer.value,
      upperLayerLabel: upperLayer.label,
      userPrompt: asText(input.prompt),
      productNote: asText(input.productNote)
    },
    scopeRules: {
      selectedTransferScope: scope.labels,
      upperLayer: `${upperLayer.label}：${upperLayer.rule}`,
      lowerSelected: scope.lower,
      shoesSelected: scope.shoes,
      upperSelected: scope.upper,
      lowerRule: scope.lower
        ? "已选择下装，可以分析图2裙裤长度、下摆、开衩、腰头和下装穿法。"
        : "未选择下装：图2里的裙子、裤子、腿部、袜靴、下摆层次、下装颜色和下装长度都是非迁移上下文，不得写入 garmentCategory、lowerHem 或 lowerType；只能用中性语言说明上装衣摆相对图1原下装的外穿/扎入/遮挡关系。",
      shoesRule: scope.shoes
        ? "已选择鞋子，可以分析图2鞋靴并写入 shoeType。"
        : "未选择鞋子：图2鞋子、袜靴、脚踝和脚部姿态不得写入服装事实。"
    },
    instructions: [
      "图2不是灵感图，而是同一批图1要统一复刻的服装事实来源；请优先描述服装在人体上的相对位置和比例。",
      "只提取服装事实。禁止输出人物身份、人脸、发型、肤色、身材长相、背景、光线、摄影风格、人体姿态，以及“保持一致/高质量/自然真实”这类空泛套话；看不清就写“未识别”，不要自行补全。",
      "必须先执行 scopeRules：未选择的图2部位只能视为非迁移上下文，不能进入服装事实。",
      `上装层级只用于判断图2真实服装事实：${upperLayer.rule}`,
      "必须专门提取颜色：每个已选部位的主色和明显的拼接色，用最短的词写清楚（例如“深卡其”“米白”）。",
      "必须特别关注袖子状态：袖子是自然放下、卷起、挽起、堆在前臂，还是被手臂遮挡；袖口落在掌根、腕骨、手背还是前臂；以及袖长本身。",
      "必须特别关注扣合与门襟：全扣、半扣、敞开、内搭外露，还是仅上/中/下部扣合；可见扣子总数、已扣/未扣数量与从上到下的位置；看不清就写未识别。",
      "必须特别关注拉链、腰带与领口开口：拉链高度、腰带系法与结点位置、领口开口深度和翻领角度。",
      "必须特别关注衣摆关系：完全外穿、完全扎入、前中扎入、半扎、只扎一侧、敞开，或被下装/腰部遮住；未选择下装时只描述上装自身衣摆状态。",
      "必须提取长度：上装衣长相对人体的落点；已选下装时还要提取裤长/裙长与裤脚或裙摆状态；已选鞋子时提取鞋型（例如低帮系带运动鞋、短靴）。",
      "已选下装时提取裤型/裙型（直筒、阔腿、包身、A字等）；已选鞋子时提取鞋型。",
      "只输出 JSON，不要 Markdown，不要解释。"
    ],
    outputSchema: {
      garmentCategory: "string，只写已选迁移范围内的服装类别与内外层关系，例如“单件上衣”“外套+内搭两层”“针织圆领上衣”；未选择下装时不得写裙/裤",
      color: "string，已选部位的服装颜色，例如“外套深卡其，内搭米白”；看不清写未识别",
      material: "string，面料类别、厚薄、垂感、光泽、纹理、褶皱密度",
      silhouette: "string，整体廓形、修身/宽松程度、肩宽、腰身、下摆轮廓",
      shoulderNeckline: "string，肩线、领口、门襟、衣身结构线",
      necklineOpening: "string，领口开口深度、翻领角度、内搭外露范围、门襟上部开合",
      sleeveCuff: "string，袖型、袖长、袖口到手腕落点、袖克夫宽度与收口方式",
      sleeveWearing: "string，袖子穿法与状态，例如自然放下/卷起/挽起/堆褶；袖口落在掌根、腕骨、手背或前臂的具体相对位置；卷袖高度与层数",
      closureState: "string，扣子/拉链/门襟状态，例如全扣、半扣、敞开、未扣几颗、已扣几颗",
      buttonCountState: "string，可见扣子总数、已扣/未扣数量、从上到下的开合位置；看不清时写未识别，不要编造",
      zipperBeltState: "string，拉链高度、腰带/系带/腰头遮挡、结点位置、自由端垂落方向和相对落点",
      tuckDrape: scope.lower
        ? "string，上衣衣摆和已选下装穿法关系，例如完全扎入、前中扎入两侧外露、半扎、外穿、被腰带遮挡"
        : "string，只写图2上衣衣摆当前唯一真实状态和落点，例如已外穿且下摆落在腰部下方、已完全扎入、前中扎入两侧外露、半扎；不得输出“外穿、扎入、半扎”这种选项列表；不得写图2具体裙裤名称、颜色和长度",
      waistFit: "string，腰线位置、腰身粗细、收腰程度、松量",
      upperHem: "string，上装衣长和下摆相对人体落点",
      lowerHem: scope.lower ? "string，已选下装的裤长/裙长、裤脚或裙摆状态、开衩和相对腿部落点" : "",
      shoeType: scope.shoes ? "string，鞋型，例如低帮系带运动鞋、短靴、乐福鞋；看不清写未识别" : "",
      details: "string，扣子、拉链、口袋、拼接、压线、装饰等有明显辨识度的服装结构"
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

// 中文注释：把模型返回的 JSON 规整成结构化服装事实；没有可识别事实时明确报错，
// 不返回"空壳规格"让前端以为分析成功了。
function normalizeMasterFitPlan(plan, input = {}) {
  const facts = buildOutfitFacts(plan, input);
  if (recognizedFactKeys(facts).length === 0) {
    throw new Error("图2服装事实分析结果为空（模型没有返回可识别字段）");
  }
  return { facts };
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
