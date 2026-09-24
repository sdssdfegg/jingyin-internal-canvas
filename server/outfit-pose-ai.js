const DEFAULT_OUTFIT_POSE_MODEL = "gpt-5.4-mini";
const OUTFIT_POSE_TIMEOUT_MS = 45000;

function asText(value, fallback = "") {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function compact(value, limit = 1200) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

function modelName(input) {
  return asText(input.outfitPoseModel || input.detailAnalysisModel || input.textModel, DEFAULT_OUTFIT_POSE_MODEL);
}

function isBackgroundChangeInput(input) {
  const pageName = String(input?.pageName || "");
  const modelTitle = String(input?.uploadLabels?.model?.title || "");
  const clothingTitle = String(input?.uploadLabels?.clothing?.title || "");
  const referenceTitle = String(input?.uploadLabels?.reference?.title || "");
  const text = [input?.workflowMode, pageName, modelTitle, clothingTitle, referenceTitle].join(" ");
  const explicitBackgroundPage = /换固定背景|固定背景|换背景|換背景|背景更换|背景替换|换场景/i.test(pageName)
    || /固定背景|统一场景|场景图|目标场景|背景图|换背景|背景/i.test(clothingTitle);
  const backgroundLabelPair = /人物图|人物照|人物|模特图|模特/i.test(modelTitle)
    && /固定背景|统一场景|场景图|目标场景|背景图|换背景|背景/i.test(clothingTitle);
  return String(input?.workflowMode || "") === "background-change"
    || explicitBackgroundPage
    || backgroundLabelPair
    || /PS贴回/i.test(text);
}

function isFaceSwapInput(input) {
  const pageName = String(input?.pageName || "");
  const modelTitle = String(input?.uploadLabels?.model?.title || "");
  const clothingTitle = String(input?.uploadLabels?.clothing?.title || "");
  const referenceTitle = String(input?.uploadLabels?.reference?.title || "");
  const text = [input?.workflowMode, pageName, modelTitle, clothingTitle, referenceTitle].join(" ");
  return String(input?.workflowMode || "") === "face-swap"
    || /批量换脸|换脸|人脸|脸部|face\s*swap/i.test(pageName)
    || /人脸参考|脸部参考|人脸身份|脸部身份/i.test(text)
    || (/目标人物图|人物图|模特图|原图/i.test(modelTitle) && /人脸参考|脸部参考|人脸身份|换脸|脸/i.test(clothingTitle));
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
  if (!raw) throw new Error("换装姿态分析模型没有返回内容");
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
    throw new Error("换装姿态分析模型返回的不是有效 JSON");
  }
}

function shouldRetryWithoutJsonFormat(status, text) {
  const source = `${status} ${text}`.toLowerCase();
  return status >= 400 && (
    source.includes("response_format") ||
    source.includes("json_object") ||
    source.includes("unsupported")
  );
}

function safeImagePart(file) {
  return {
    type: "image_url",
    image_url: {
      url: `data:${file.mimetype || "image/png"};base64,${file.buffer.toString("base64")}`,
      detail: "high"
    }
  };
}

function fileMeta(file) {
  return {
    name: file.originalname || "model-image",
    type: file.mimetype || "",
    size: file.size || file.buffer?.length || 0
  };
}

function buildPoseAnalysisContent(input, modelFile, includeImage) {
  const targetImageModel = asText(input.model, "gpt-image");
  const backgroundChange = isBackgroundChangeInput(input);
  const faceSwap = isFaceSwapInput(input);
  const payload = {
    task: faceSwap ? "批量 AI 换脸智能头脸锚点分析" : backgroundChange ? "批量 AI 换背景智能人物锚点分析" : "批量 AI 换装智能姿态锚点分析",
    goal: faceSwap
      ? "只分析图1目标人物图，输出给后续生图模型使用的头部坐标、脸部朝向、下巴脖子接口、头颈关系、头身比、背景边界和光影锚点。重点解决换脸后头部偏移、脸中心漂移、脸部角度改变、脖子畸形和头身比变化导致无法后期贴回的问题；图1原脸型、原发型和原头饰只作为定位干扰源记录，不作为最终妆造标准。"
      : backgroundChange
      ? "只分析图1人物图，输出给后续生图模型使用的人物坐标、姿势、主体比例、裁切边界、人物结构和服装不变提示词。重点解决换固定背景后人物偏移、缩放、补全下半身、服装变化、姿势变化和人物光影融合不自然导致像 P 图的问题。"
      : "只分析图1目标模特底图，输出给后续生图模型使用的姿态/头部坐标锁定提示词。重点解决换装生成后头部偏移、脸部坐标变化、肩颈重排导致无法后期贴脸的问题。",
    image: {
      role: "图1目标模特底图",
      meta: fileMeta(modelFile)
    },
    input: {
      targetImageModel,
      aspectRatio: asText(input.aspectRatio, "3:4"),
      imageSize: asText(input.imageSize, "2K"),
      userPrompt: asText(input.prompt),
      productNote: asText(input.productNote)
    },
    instructions: [
      faceSwap ? "只看图1人物，不分析图2人脸身份，也不要设计新表情、新头位或新角度。" : backgroundChange ? "只看图1人物，不分析图2场景，也不要设计新动作或新站位。" : "只看图1人物，不分析图2服装，也不要设计新动作。",
      "估算头部、脸中心、头顶、下巴、肩线、双手、双脚和人物中心在画面中的相对位置。用百分比或相对描述，允许近似，但必须可执行。",
      "特别关注：头部中心是否偏左/偏右、脸是否倾斜、头肩关系、脖子长度和粗细、下巴到锁骨/衣领距离、下巴到肩线距离、头发与背景/衣领交界、头身比、耳饰/发饰/项圈等能帮助后期贴回的边界锚点。图1原发型和头饰只记录边界，不作为最终发型头饰参考。",
      faceSwap
        ? `输出的 promptBlock 必须是给 ${targetImageModel} 图片生成模型看的中文硬约束，强调换脸时不要移动头部、不要改变脸中心、头部大小、脸部朝向、下巴、脖子肩线、头身比、身体服装和背景；脸型、五官、发型整体轮廓、发色、刘海、头饰/发饰、脸部肤色明暗、妆容浓淡、唇色饱和度、面部对比度和清晰度以图2脸母图为统一标准。图1原脸型、原发型、原头饰不得干扰结果；图2头部姿态、衣服、衣领、肩膀、背景和拍摄角度不得进入结果。`
        : backgroundChange
        ? `输出的 promptBlock 必须是给 ${targetImageModel} 图片生成模型看的中文硬约束，强调换固定背景时不要移动人物、不要缩放人物、不要改变人物姿势、服装、头部大小、脸部坐标、主体占比和原图裁切；半身不补腿，全身不扩画布；人物可做自然重光照和色温统一以融入图2固定背景。`
        : `输出的 promptBlock 必须是给 ${targetImageModel} 图片生成模型看的中文硬约束，强调不要把头摆正、不要重新居中、不要改变头部大小和脸部坐标。`,
      "不要识别人物身份，不要输出隐私信息，不要描述无关背景故事。",
      "只输出 JSON，不要 Markdown，不要解释。"
    ],
    outputSchema: {
      headAnchor: "string，头部/脸部位置、大小、倾斜方向、下巴、脖子接口、头身比、头发背景交界和原饰品位置锚点；图1原发型/头饰只作边界定位",
      bodyAnchor: "string，肩颈、脖子长度、锁骨/衣领连接、躯干、重心、手臂、手腕、手掌、腿脚姿态锚点",
      compositionAnchor: "string，人物在画面中的整体位置、镜头距离、裁切边界和背景关系锚点",
      promptBlock: faceSwap
        ? "string，120-260字中文，直接注入换脸提示词，强制当前生图模型保持图1头部坐标、脸中心、头部大小、脸部朝向、下巴、脖子肩线、头身比、身体服装和背景；脸型、五官、发型整体轮廓、发色、刘海、头饰/发饰、脸部肤色明暗、妆容浓淡、唇色饱和度、面部对比度和清晰度以图2脸母图为统一标准；禁止图1原脸型/发型/头饰干扰结果，并禁止图2头部姿态、衣服、衣领、肩膀、背景进入结果"
        : backgroundChange
        ? "string，120-260字中文，直接注入换固定背景提示词，强制当前生图模型保持图1人物坐标、姿势、服装、头部大小、脸部朝向、主体占比、半身/全身裁切；允许人物自然重光照、色温统一和接触阴影匹配图2固定背景"
        : "string，120-260字中文，直接注入换装提示词，强制当前生图模型保持图1头部坐标、脸部朝向、肩颈关系和人物站位"
    }
  };

  const content = [{ type: "text", text: JSON.stringify(payload, null, 2) }];
  if (includeImage) {
    content.push({
      type: "text",
      text: `图1目标模特底图：${modelFile.originalname || "model-image"}`
    });
    content.push(safeImagePart(modelFile));
  }
  return content;
}

function buildChatBody(input, modelFile, includeImage, withJsonFormat) {
  const backgroundChange = isBackgroundChangeInput(input);
  const faceSwap = isFaceSwapInput(input);
  const body = {
    model: modelName(input),
    temperature: 0.1,
    messages: [
      {
        role: "system",
        content: [
          faceSwap ? "你是电商 AI 换脸头脸坐标质检师和提示词架构师。" : backgroundChange ? "你是电商 AI 换背景人物锚点质检师和提示词架构师。" : "你是电商 AI 换装姿态质检师和提示词架构师。",
          faceSwap
            ? "你的任务是从图1中提取头部、脸部、肩颈、头发背景边界和画面坐标锚点，帮助后续图片生成模型替换图2脸型发型头饰时不移动头脸、不换衣、不换背景；图1原发型头饰不是最终参考。"
            : backgroundChange
            ? "你的任务是从图1中提取人物位置、主体大小、姿势、服装和画面坐标锚点，帮助后续图片生成模型只换背景，不重排人物、不改变服装。"
            : "你的任务是从图1中提取头部、脸部、肩颈、手脚和画面坐标锚点，帮助后续图片生成模型只换衣服，不重排人物。",
          "必须输出严格 JSON。"
        ].join("\n")
      },
      {
        role: "user",
        content: buildPoseAnalysisContent(input, modelFile, includeImage)
      }
    ]
  };
  if (withJsonFormat) body.response_format = { type: "json_object" };
  return body;
}

async function postChatCompletion({ baseUrl, apiKey, input, modelFile, includeImage, withJsonFormat, signal }) {
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(buildChatBody(input, modelFile, includeImage, withJsonFormat)),
    signal
  });
  const parsed = await readResponse(response);
  return { response, parsed };
}

function normalizePosePlan(plan, input = {}) {
  const backgroundChange = isBackgroundChangeInput(input);
  const faceSwap = isFaceSwapInput(input);
  const headAnchor = compact(plan?.headAnchor, 500);
  const bodyAnchor = compact(plan?.bodyAnchor, 500);
  const compositionAnchor = compact(plan?.compositionAnchor, 500);
  const fallback = faceSwap
    ? [
        "智能头脸锚点：把图1的头部中心、脸中心、头部大小、下巴、脸部朝向、脖子肩线、头身比和人物画面坐标当作不可移动模板；图1原发型、原脸型和原头饰只作为需要被图2覆盖的干扰源，不作为最终参考。",
        headAnchor,
        bodyAnchor,
        compositionAnchor,
        "只把图2的人脸身份、脸型、发型整体轮廓、发量、发色、刘海、头饰/发饰、统一脸部肤色妆容色调融合到图1原头部坐标；同批口红色相/饱和度、肤色明暗、妆容浓淡、面部对比度和清晰度保持同一张图2脸母图标准。不要移动头部、不要缩放头部、不要改变脸部朝向、下巴、脖子肩线、头身比、身体、服装、衣领、肩膀、背景或人物在画面中的位置；图2头部姿态、衣服、衣领、肩膀、背景和拍摄角度不得进入结果。"
      ]
    : backgroundChange
    ? [
        "智能人物锚点：把图1人物的头部中心、脸部朝向、头发外轮廓、肩颈倾斜、服装轮廓、手脚位置、主体大小和人物画面坐标当作不可移动模板。",
        headAnchor,
        bodyAnchor,
        compositionAnchor,
        "只替换人物背后的场景并融合图2光影，不要移动人物、不要缩放人物、不要改变脸部大小、服装款式、服装颜色、手脚姿势、站立重心或人物在画面中的位置。"
      ]
    : [
        "智能姿态锚点：把图1的头部中心、脸部朝向、头发外轮廓、肩颈倾斜、手脚位置和人物画面坐标当作不可移动模板。",
        headAnchor,
        bodyAnchor,
        compositionAnchor,
        "只让图2服装贴合到原人物身上，不要把头摆正、不要重新居中、不要改变脸部大小、脖子长度、肩线高度、站立重心或人物在画面中的位置。"
      ];
  const promptBlock = compact(plan?.promptBlock || fallback.filter(Boolean).join(" "), 900);

  if (!promptBlock) throw new Error("换装姿态分析结果为空");
  return {
    headAnchor,
    bodyAnchor,
    compositionAnchor,
    promptBlock
  };
}

async function createOutfitPoseAnchor({ input = {}, modelFile, apiKey, baseUrls = [], timeoutMs = OUTFIT_POSE_TIMEOUT_MS }) {
  if (!apiKey) throw new Error("缺少 API Key，无法调用换装姿态分析模型");
  if (!modelFile?.buffer) throw new Error("缺少图1模特图，无法分析姿态锚点");
  const candidates = baseUrls.filter(Boolean);
  if (candidates.length === 0) throw new Error("没有可用的渠道地址");

  const startedAt = Date.now();
  const abort = createAbortSignal(timeoutMs);
  const attempts = [];

  try {
    for (const baseUrl of candidates) {
      for (const mode of [
        { includeImage: true, withJsonFormat: true },
        { includeImage: true, withJsonFormat: false }
      ]) {
        const { response, parsed } = await postChatCompletion({
          baseUrl,
          apiKey,
          input,
          modelFile,
          includeImage: mode.includeImage,
          withJsonFormat: mode.withJsonFormat,
          signal: abort.signal
        });
        const message = parsed.json?.error?.message || parsed.text || `HTTP ${response.status}`;
        attempts.push({
          baseUrl,
          status: response.status,
          ok: response.ok,
          includeImage: mode.includeImage,
          withJsonFormat: mode.withJsonFormat,
          message: String(message).slice(0, 260)
        });

        if (!response.ok && mode.withJsonFormat && shouldRetryWithoutJsonFormat(response.status, message)) continue;
        if (!response.ok) break;

        const plan = normalizePosePlan(extractJsonObject(responseContent(parsed.json)), input);
        return {
          ok: true,
          model: modelName(input),
          usedBaseUrl: baseUrl,
          mode: "ai-vision",
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
  throw new Error(last?.message || "换装姿态分析失败");
}

export {
  DEFAULT_OUTFIT_POSE_MODEL,
  createOutfitPoseAnchor
};
