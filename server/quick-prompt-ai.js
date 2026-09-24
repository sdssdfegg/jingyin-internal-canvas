const DEFAULT_QUICK_PROMPT_MODEL = "gpt-5.4-mini";
const QUICK_PROMPT_TIMEOUT_MS = 90000;
const MAX_QUICK_PROMPT_IMAGE_COUNT = 6;

function asText(value, fallback = "") {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function modelName(input) {
  return asText(input.detailAnalysisModel || input.quickPromptModel || input.textModel || DEFAULT_QUICK_PROMPT_MODEL, DEFAULT_QUICK_PROMPT_MODEL);
}

function createAbortSignal(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    dispose: () => clearTimeout(timer)
  };
}

function readResponse(response) {
  return response.text().then((text) => {
    try {
      return { text, json: JSON.parse(text) };
    } catch {
      return { text, json: null };
    }
  });
}

function responseContent(payload) {
  const message = payload?.choices?.[0]?.message;
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content.map((part) => part.text || part.content || "").join("\n");
  }
  return "";
}

function extractJsonObject(text) {
  const raw = String(text || "").trim();
  if (!raw) throw new Error("快捷生成文本模型没有返回内容");
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
    throw new Error("快捷生成文本模型返回的不是有效 JSON");
  }
}

function fileMeta(file, index) {
  return {
    index,
    name: file.originalname || `reference-${index + 1}`,
    type: file.mimetype || "",
    size: file.size || file.buffer?.length || 0
  };
}

function isQuickOutfitTransfer(input = {}, files = []) {
  if (files.length < 2) return false;
  if (isQuickAppearanceTransfer(input, files)) return false;
  const text = String(input.prompt || "").replace(/\s+/g, "");
  return /(图1|第一张).{0,12}(模特|人物|人).{0,12}(穿|换|穿着|穿上).{0,12}(图2|第二张)/.test(text)
    || /(图1|第一张).{0,18}(穿着图2|穿上图2|换成图2|图2服装|图2衣服)/.test(text)
    || /(模特|人物|人).{0,12}(穿着图2|穿上图2|换成图2|图2服装|图2衣服)/.test(text);
}

function isQuickAppearanceTransfer(input = {}, files = []) {
  if (files.length < 2) return false;
  const text = String(input.prompt || "").replace(/\s+/g, "");
  const appearanceIntent = /(换脸|换头|换发型|改发型|换头发|改头发|换样貌|改样貌|样貌换成|样貌改成|长相换成|长相改成|脸换成|脸部换成|五官换成|模特样貌|模特发型|发型样貌|图2的脸|图2样貌|图2发型|图二的脸|图二样貌|图二发型)/.test(text);
  const outfitIntent = /(换装|换衣|换衣服|穿上|穿着图2|换成图2服装|换成图2衣服|图2服装|图2衣服)/.test(text)
    || /(上衣|外套|风衣|衬衫|T恤|卫衣|毛衣|西装|连衣裙|裙子|半身裙|裤子|牛仔裤|短裤|鞋子|靴子|高跟鞋).{0,8}(换成|改成|替换成|变成)/.test(text)
    || /(换成|改成|替换成|变成).{0,8}(上衣|外套|风衣|衬衫|T恤|卫衣|毛衣|西装|连衣裙|裙子|半身裙|裤子|牛仔裤|短裤|鞋子|靴子|高跟鞋)/.test(text);
  return appearanceIntent && !outfitIntent;
}

function safeImagePart(file) {
  return {
    type: "image_url",
    image_url: {
      url: `data:${file.mimetype || "image/png"};base64,${file.buffer.toString("base64")}`,
      detail: "low"
    }
  };
}

function quickPromptFallback(input = {}, files = []) {
  const userPrompt = asText(input.prompt, "生成一张高质量电商商品图，突出商品真实结构、材质、颜色和核心卖点。");
  if (isQuickAppearanceTransfer(input, files)) {
    return [
      userPrompt,
      "图1是唯一底图：保留图1头部位置、头部大小、脸部朝向、头颈关系、身体、衣服、背景、光影、裁切和构图。",
      "图2只作为目标样貌/人脸/发型参考：提取五官比例、脸型、年龄感、妆容气质、发型方向、刘海、发缝、卷直程度和发色趋势。",
      "不要复制图2衣服、背景、饰品、拍摄角度或白底棚拍感；不要换衣、不要换背景、不要重拍整个人。只在图1头脸区域自然融合图2样貌，边缘、肤色和光影必须连续。"
    ].join("\n");
  }
  if (isQuickOutfitTransfer(input, files)) {
    return [
      userPrompt,
      "图1只作为模特身份、脸部质感、发型、身体比例、姿势、手脚位置、站位、镜头角度、场景和光影基准；图1原服装不作为版型、样式、面料、颜色、长度或穿法参考。",
      "图2作为服装事实来源，按图2的真实穿法生成：扣子开合数量、领口门襟、袖子撸起或垂下、衣摆塞/不塞、宽松或直筒状态、衣长袖长、内外层关系、面料垂感和颜色都要保留。",
      "只让图1模特真实穿上图2服装，保持图1姿势、位置、身体比例、手部姿势和画面构图不变；不磨皮、不变脸、不重新摆拍，不按模型审美改短、收腰或美化版型。"
    ].join("\n");
  }
  const referenceRule = files.length > 0
    ? `已上传 ${files.length} 张参考图：参考图只用于锁定商品事实、人物/服装/道具关系或局部细节，不要平均混合多张图的风格。`
    : "无参考图：根据用户原始需求建立一个干净、统一、适合电商投放的画面方向。";
  return [
    userPrompt,
    referenceRule,
    "电商生图要求：画面只保留一个稳定主调，主体清晰，产品不变形，材质纹理真实，边缘干净，构图服务转化，光线柔和自然，避免过曝、强硬黑影和拼贴感。",
    "禁止：水印、商标、乱码文字、虚假卖点、错误结构、多余肢体、畸形手、低清晰度、廉价促销感、多个冲突场景。"
  ].join("\n");
}

function buildSkillPayload(input, files, includeImages) {
  const textPayload = {
    task: "快捷生成悬浮框提示词优化",
    goal: "把用户的原始提示词优化成一段可直接用于图片生成模型的电商生图提示词。",
    input: {
      prompt: asText(input.prompt),
      imageSize: asText(input.imageSize, "2K"),
      aspectRatio: asText(input.aspectRatio, "3:4"),
      targetImageModel: asText(input.model, "gpt-image"),
      count: Number.parseInt(input.n, 10) || 1,
      source: "quickgen"
    },
    images: {
      referenceCount: files.length,
      uploadOrder: "所有图片都是快捷生成参考图，按用户缩略图顺序编号。需要优先理解用户文字中的图1、图2等指代关系。",
      references: files.map(fileMeta),
      outfitTransferDetected: isQuickOutfitTransfer(input, files),
      appearanceTransferDetected: isQuickAppearanceTransfer(input, files)
    },
    skill: {
      baseRules: [
        "用户原始提示词优先级最高，必须保留用户真正想生成的主体、动作、商品关系和限制。",
        "有参考图时，参考图是事实锚点，不是风格素材包；尤其要尊重图1、图2、图3的编号关系。",
        "如果用户说图1样貌、脸、五官、发型或头发换成图2：图1是唯一底图，必须锁定头部坐标、身体、衣服、背景和构图；图2只提供人脸身份、五官、妆容和发型趋势，不能复制图2衣服、背景、饰品、拍摄角度或白底棚拍感。",
        "换脸/换样貌/换发型时只处理头脸发区域的自然融合，不能换装、不能换身体、不能换背景、不能把图1重拍成图2的人像。",
        "如果用户说图1人物穿图2衣服：图1只锁定人物身份、脸部质感、发型、身体比例、姿势、手脚、站位、镜头、场景和光影；图1原服装不作为图2服装的版型、样式、面料、颜色、长度或穿法参考。",
        "图2服装必须按真实穿法迁移：扣子开合数量、领口门襟、袖子撸起/垂下、袖口落点、衣摆塞/不塞、宽松/直筒/修身状态、衣长袖长、内外层关系、面料垂感和颜色都要尊重图2或用户文字。",
        "换装时只做真实穿着适配，保持图1人物姿势、位置、身体比例、手部姿势和画面构图不变；不磨皮、不变脸、不重新摆拍，不按模型审美改短、收腰或美化版型。",
        "只选择一个主视觉方向，不要把多个场景、光线、色调和构图平均混合成缝合感。",
        "提示词应该像资深电商摄影指导给生图模型的指令，连贯、具体、可执行，不要输出规则清单。",
        "不要凭空新增虚假功能、虚假材质、品牌、价格、认证、功效或平台违禁表达。"
      ],
      ecommerceRules: [
        "商品真实性锁定：商品结构、比例、颜色、材质、纹理、版型和关键细节不能被改错。",
        "转化表达：主体清晰，卖点可见，背景干净，留白合理，构图有商业海报/主图质感。",
        "光线质检：避免过曝、油亮反光、脏灰、强硬黑影、低清晰度和过度磨皮。",
        "人物质检：如出现模特，避免多余肢体、畸形手、脸部崩坏、姿态僵硬、衣服穿帮。",
        "文字质检：除非用户明确要求文案，否则不要生成大段文字；必须避免乱码、水印、商标和错误标识。"
      ],
      outputStyle: [
        "输出中文。",
        "最终 prompt 控制在 120-260 字，适合直接填入快捷生成。",
        "如果用户原始提示词很短，可以补充电商图需要的镜头、光线、质感、背景和负面约束。",
        "如果用户原始提示词已经很具体，只做结构化增强，不要改变题材和审美调性。"
      ],
      requiredOutput: {
        prompt: "string，最终可直接用于生图的一段中文提示词，不要 Markdown。",
        strategy: {
          mainIntent: "string，保留的用户核心意图",
          styleAxis: "string，单一主视觉方向",
          referenceUsage: ["string，说明参考图如何被使用"]
        },
        negative: ["string，主要负面约束"]
      }
    }
  };

  const content = [{ type: "text", text: JSON.stringify(textPayload, null, 2) }];
  if (!includeImages) return content;

  files.slice(0, MAX_QUICK_PROMPT_IMAGE_COUNT).forEach((file, index) => {
    content.push({
      type: "text",
      text: `参考图 image[${index + 1}]：${file.originalname || `reference-${index + 1}`}`
    });
    content.push(safeImagePart(file));
  });
  return content;
}

function shouldRetryWithoutImages(status, text) {
  const source = `${status} ${text}`.toLowerCase();
  return status >= 400 && (
    source.includes("image") ||
    source.includes("vision") ||
    source.includes("multimodal") ||
    source.includes("content part") ||
    source.includes("image_url")
  );
}

function shouldRetryWithoutJsonFormat(status, text) {
  const source = `${status} ${text}`.toLowerCase();
  return status >= 400 && (
    source.includes("response_format") ||
    source.includes("json_object") ||
    source.includes("unsupported")
  );
}

function buildChatBody(input, files, includeImages, withJsonFormat) {
  const body = {
    model: modelName(input),
    temperature: 0.18,
    messages: [
      {
        role: "system",
        content: [
          "你是资深电商视觉策略师、商品图质检师和 AI 生图提示词架构师。",
          "你的任务不是堆砌好词，而是把用户原始意图、参考图事实和电商转化要求整合成一段稳定提示词。",
          "必须先做取舍：锁定商品事实，保留用户意图，选择一个主视觉方向，避免缝合怪和过曝。",
          "必须输出严格 JSON，不要 Markdown，不要解释。"
        ].join("\n")
      },
      {
        role: "user",
        content: buildSkillPayload(input, files, includeImages)
      }
    ]
  };
  if (withJsonFormat) body.response_format = { type: "json_object" };
  return body;
}

async function postChatCompletion({ baseUrl, apiKey, input, files, includeImages, withJsonFormat, signal }) {
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(buildChatBody(input, files, includeImages, withJsonFormat)),
    signal
  });
  const parsed = await readResponse(response);
  return { response, parsed };
}

function normalizePlan(plan, input, files) {
  const prompt = asText(plan?.prompt, quickPromptFallback(input, files));
  return {
    prompt,
    strategy: plan?.strategy && typeof plan.strategy === "object" ? plan.strategy : {
      mainIntent: asText(input.prompt),
      styleAxis: "电商商品图",
      referenceUsage: files.length ? ["按上传顺序理解参考图关系"] : []
    },
    negative: Array.isArray(plan?.negative) ? plan.negative.map((item) => asText(item)).filter(Boolean) : []
  };
}

async function createQuickPromptRewrite({ input = {}, files = [], apiKey, baseUrls = [], timeoutMs = QUICK_PROMPT_TIMEOUT_MS }) {
  if (!apiKey) throw new Error("缺少 API Key，无法调用快捷生成文本模型");
  const candidates = baseUrls.filter(Boolean);
  if (candidates.length === 0) throw new Error("没有可用的渠道地址");

  const startedAt = Date.now();
  const abort = createAbortSignal(timeoutMs);
  const attempts = [];

  try {
    for (const baseUrl of candidates) {
      for (const mode of [
        { includeImages: files.length > 0, withJsonFormat: true },
        { includeImages: files.length > 0, withJsonFormat: false },
        { includeImages: false, withJsonFormat: true },
        { includeImages: false, withJsonFormat: false }
      ]) {
        const { response, parsed } = await postChatCompletion({
          baseUrl,
          apiKey,
          input,
          files,
          includeImages: mode.includeImages,
          withJsonFormat: mode.withJsonFormat,
          signal: abort.signal
        });
        const message = parsed.json?.error?.message || parsed.text || `HTTP ${response.status}`;
        attempts.push({
          baseUrl,
          status: response.status,
          ok: response.ok,
          includeImages: mode.includeImages,
          withJsonFormat: mode.withJsonFormat,
          message: String(message).slice(0, 260)
        });

        if (!response.ok && mode.withJsonFormat && shouldRetryWithoutJsonFormat(response.status, message)) continue;
        if (!response.ok && mode.includeImages && shouldRetryWithoutImages(response.status, message)) continue;
        if (!response.ok) break;

        const plan = normalizePlan(extractJsonObject(responseContent(parsed.json)), input, files);
        return {
          ok: true,
          mode: mode.includeImages ? "ai-vision" : "ai-text",
          model: modelName(input),
          usedBaseUrl: baseUrl,
          timing: { totalMs: Date.now() - startedAt },
          attempts,
          ...plan
        };
      }
    }
  } finally {
    abort.dispose();
  }

  const last = attempts[attempts.length - 1];
  throw new Error(last?.message || "快捷生成文本模型优化失败");
}

export {
  DEFAULT_QUICK_PROMPT_MODEL,
  createQuickPromptRewrite,
  quickPromptFallback
};
