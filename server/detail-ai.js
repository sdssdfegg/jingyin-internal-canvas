import {
  BASE_SKILL,
  INDUSTRY_SKILLS,
  QUALITY_SKILL,
  SCREEN_MODULES,
  getIndustrySkillByText,
  getPlatformSkill
} from "./detail-skills.js";

const DEFAULT_DETAIL_ANALYSIS_MODEL = "gpt-5.4-mini";
const DETAIL_ANALYSIS_TIMEOUT_MS = 120000;
const MAX_AI_IMAGE_COUNT = 10;

function clamp(value, min, max, fallback) {
  return Math.max(min, Math.min(max, Number.parseInt(value, 10) || fallback));
}

function asText(value, fallback = "") {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function createAbortSignal(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    dispose: () => clearTimeout(timer)
  };
}

function detailModel(input) {
  return asText(input.detailAnalysisModel || input.textModel || DEFAULT_DETAIL_ANALYSIS_MODEL, DEFAULT_DETAIL_ANALYSIS_MODEL);
}

function safeImagePart(file) {
  const mimeType = file.mimetype || "image/png";
  return {
    type: "image_url",
    image_url: {
      url: `data:${mimeType};base64,${file.buffer.toString("base64")}`,
      detail: "low"
    }
  };
}

function fileMeta(file, index, role) {
  return {
    index,
    role,
    name: file.originalname || `${role}-${index + 1}`,
    type: file.mimetype || "",
    size: file.size || file.buffer?.length || 0
  };
}

function compactSkillPack(input) {
  const platformSkill = getPlatformSkill(input.workflow);
  const industrySeed = [
    input.productName,
    input.productFeature,
    input.sellingPoints,
    input.userInstruction
  ].join(" ");
  const industrySkill = getIndustrySkillByText(industrySeed);
  return {
    base: {
      productAuthenticityLock: BASE_SKILL.productAuthenticityLock,
      screenCountRule: BASE_SKILL.screenCountRule,
      imageNumberRules: BASE_SKILL.imageNumberRules,
      globalStyleConsistency: BASE_SKILL.globalStyleConsistency
    },
    platform: {
      id: platformSkill.id,
      platform: platformSkill.platform,
      pageType: platformSkill.pageType,
      rhythm: platformSkill.rhythm,
      copyRule: platformSkill.copyRule,
      visualRule: platformSkill.visualRule,
      imageNorms: platformSkill.imageNorms,
      conversionTraits: platformSkill.conversionTraits
    },
    industryCandidates: Object.values(INDUSTRY_SKILLS).map((skill) => ({
      id: skill.id,
      name: skill.name,
      analyzeAttributes: skill.analyzeAttributes,
      sellingAngles: skill.sellingAngles,
      recommendedScreens: skill.recommendedScreens,
      taboos: skill.taboos,
      qcRules: skill.qcRules
    })),
    seedIndustry: {
      id: industrySkill.id,
      name: industrySkill.name
    },
    modules: Object.values(SCREEN_MODULES).map((module) => ({
      id: module.id,
      name: module.name,
      purpose: module.purpose,
      referenceNeed: module.referenceNeed,
      qcRules: module.qcRules
    })),
    quality: QUALITY_SKILL
  };
}

function buildDetailAnalysisContent(input, files, includeImages) {
  const productFiles = files.filter((file) => file.detailRole === "product");
  const referenceFiles = files.filter((file) => file.detailRole === "reference");
  const count = clamp(input.count, BASE_SKILL.screenCountRule.min, BASE_SKILL.screenCountRule.max, BASE_SKILL.screenCountRule.defaultCount);
  const textPayload = {
    task: "完整 AI 详情页 Skill 分析与分屏提示词规划",
    instruction: [
      "你需要先分析商品图，再结合行业 Skill、平台 Skill、分屏模块库和质检 Skill，输出可直接用于图像生成的分屏 JSON。",
      "必须保护商品真实性。不要凭空发明材质、参数、认证、疗效、销量、品牌背书。",
      "productFileIndexes 和 referenceFileIndexes 必须使用 0 基索引，并且只能选择确实存在的图片。",
      "每屏只选择必要参考图，避免所有图片都进入同一屏导致主体漂移。",
      "如果无法从图片确认某个属性，请写成保守描述，不要假装确定。",
      "只输出 JSON，不要 Markdown，不要解释。"
    ],
    input: {
      workflow: input.workflow,
      productName: input.productName,
      productFeature: input.productFeature,
      userInstruction: input.userInstruction,
      sellingPoints: input.sellingPoints,
      copywriting: input.copywriting,
      richness: input.richness,
      fontStyle: input.fontStyle,
      modelMode: input.modelMode,
      modelPose: input.modelPose,
      modelUsage: input.modelUsage,
      reverseScreens: input.reverseScreens,
      lang: input.lang,
      ratio: input.ratio,
      imageSize: input.imageSize,
      screenCount: count
    },
    images: {
      productImages: productFiles.map((file, index) => fileMeta(file, index, "product")),
      referenceImages: referenceFiles.map((file, index) => fileMeta(file, index, "reference"))
    },
    skillPack: compactSkillPack(input),
    outputSchema: {
      product: {
        name: "string",
        industryId: "apparel|beauty|food|home|electronics|motherBaby|pet|jewelry|sports|generic",
        industryName: "string",
        targetAudience: "string",
        materials: ["string"],
        colors: ["string"],
        structureLocks: ["string"],
        realSellingPoints: ["string"],
        riskNotes: ["string"],
        styleDirection: "string"
      },
      strategy: {
        globalStyle: "string",
        copywritingTone: "string",
        pageRhythm: ["string"],
        platformNotes: ["string"],
        consistencyRules: ["string"]
      },
      screens: [
        {
          screen: 1,
          moduleId: "hero|painReverse|coreSellingPoint|materialDetail|useScenario|specInfo|trustProof|conversionClose|fitStructure",
          title: "string",
          summary: "string",
          sellingPoint: "string",
          composition: "string",
          copywriting: "string",
          productFileIndexes: [0],
          referenceFileIndexes: [0],
          referenceReason: "string",
          modelPolicyHint: "string",
          promptDirectives: ["string"],
          negativeConstraints: ["string"],
          qualityChecks: ["string"]
        }
      ],
      qc: {
        globalChecks: ["string"],
        commonFailureRisks: ["string"],
        retryAdvice: ["string"]
      }
    }
  };

  const content = [
    {
      type: "text",
      text: JSON.stringify(textPayload, null, 2)
    }
  ];

  if (!includeImages) return content;

  let attachedCount = 0;
  for (const [role, list] of [["product", productFiles], ["reference", referenceFiles]]) {
    for (const [index, file] of list.entries()) {
      if (attachedCount >= MAX_AI_IMAGE_COUNT) break;
      content.push({
        type: "text",
        text: `${role === "product" ? "产品图" : "参考图"} ${role}Image[${index}]：${file.originalname || `${role}-${index + 1}`}`
      });
      content.push(safeImagePart(file));
      attachedCount += 1;
    }
  }

  return content;
}

function buildChatBody(input, files, includeImages, withJsonFormat) {
  const body = {
    model: detailModel(input),
    temperature: 0.2,
    messages: [
      {
        role: "system",
        content: "你是资深电商详情页视觉策略总监、商品真实性审校员和 AI 生图提示词架构师。你必须用中文输出严格 JSON。"
      },
      {
        role: "user",
        content: buildDetailAnalysisContent(input, files, includeImages)
      }
    ]
  };
  if (withJsonFormat) body.response_format = { type: "json_object" };
  return body;
}

async function readResponse(response) {
  const text = await response.text();
  try {
    return { text, json: JSON.parse(text) };
  } catch {
    return { text, json: null };
  }
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
  if (!raw) throw new Error("AI 分析模型没有返回内容");
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
    throw new Error("AI 分析模型返回的不是有效 JSON");
  }
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

async function postChatCompletion({ baseUrl, apiKey, input, files, includeImages, withJsonFormat, signal }) {
  const url = `${baseUrl}/chat/completions`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(buildChatBody(input, files, includeImages, withJsonFormat)),
    signal
  });
  const parsed = await readResponse(response);
  return { url, response, parsed };
}

async function createDetailAiPlan({ input = {}, files = [], apiKey, baseUrls = [], timeoutMs = DETAIL_ANALYSIS_TIMEOUT_MS }) {
  if (!apiKey) throw new Error("缺少 API Key，无法调用详情 AI 分析模型");
  const candidates = baseUrls.filter(Boolean);
  if (candidates.length === 0) throw new Error("没有可用的渠道地址");

  const startedAt = Date.now();
  const attempts = [];
  const abort = createAbortSignal(timeoutMs);

  try {
    for (const baseUrl of candidates) {
      for (const mode of [
        { includeImages: true, withJsonFormat: true },
        { includeImages: true, withJsonFormat: false },
        { includeImages: false, withJsonFormat: true },
        { includeImages: false, withJsonFormat: false }
      ]) {
        const { url, response, parsed } = await postChatCompletion({
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
          url,
          status: response.status,
          ok: response.ok,
          includeImages: mode.includeImages,
          withJsonFormat: mode.withJsonFormat,
          message: String(message).slice(0, 260)
        });

        if (!response.ok && mode.withJsonFormat && shouldRetryWithoutJsonFormat(response.status, message)) continue;
        if (!response.ok && mode.includeImages && shouldRetryWithoutImages(response.status, message)) continue;
        if (!response.ok) break;

        const content = responseContent(parsed.json);
        const plan = extractJsonObject(content);
        return {
          ok: true,
          model: detailModel(input),
          usedBaseUrl: baseUrl,
          mode: mode.includeImages ? "ai-vision" : "ai-text",
          timing: {
            totalMs: Date.now() - startedAt
          },
          attempts,
          plan
        };
      }
    }
  } finally {
    abort.dispose();
  }

  const last = attempts[attempts.length - 1];
  throw new Error(last?.message || "详情 AI 分析失败");
}

export {
  DEFAULT_DETAIL_ANALYSIS_MODEL,
  createDetailAiPlan
};
