import {
  BASE_SKILL,
  INDUSTRY_SKILLS,
  PLATFORM_SKILLS,
  QUALITY_SKILL,
  SCREEN_MODULES,
  buildQualityChecklist,
  getIndustrySkillByText,
  getPlatformSkill,
  getScreenModule,
  uniqueList
} from "./detail-skills.js";

const DEFAULT_COUNT = BASE_SKILL.screenCountRule.defaultCount;

function clamp(value, min, max, fallback) {
  return Math.max(min, Math.min(max, Number.parseInt(value, 10) || fallback));
}

function parseList(value) {
  return String(value || "")
    .split(/\r?\n|[，,；;]/)
    .map((item) => item.replace(/^第?\d+[屏、.:\s-]*/, "").trim())
    .filter(Boolean);
}

function imageDimensions(buffer) {
  if (!buffer || buffer.length < 24) return null;
  if (buffer.toString("ascii", 1, 4) === "PNG") {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset < buffer.length) {
      if (buffer[offset] !== 0xff) break;
      const marker = buffer[offset + 1];
      const length = buffer.readUInt16BE(offset + 2);
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        return { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) };
      }
      offset += 2 + length;
    }
  }
  return null;
}

function assetsFromInput(inputImages, files, role) {
  const fileAssets = files.map((file, index) => {
    const dims = imageDimensions(file.buffer);
    return {
      index,
      role,
      name: file.originalname || `${role}-${index + 1}`,
      size: file.size,
      type: file.mimetype || "",
      width: dims?.width || null,
      height: dims?.height || null,
      hasPixels: true
    };
  });
  if (fileAssets.length > 0) return fileAssets;
  return (Array.isArray(inputImages) ? inputImages : []).map((item, index) => ({
    index,
    role,
    name: String(item?.name || `${role}-${index + 1}`),
    size: Number(item?.size || 0),
    type: String(item?.type || ""),
    width: null,
    height: null,
    hasPixels: false
  }));
}

function inferIndustry(input, productImages) {
  const text = [
    input.productName,
    input.productFeature,
    input.userInstruction,
    input.sellingPoints,
    ...productImages.map((item) => item.name)
  ].join(" ");
  return getIndustrySkillByText(text);
}

function aiIndustry(input, productImages, aiPlan) {
  const aiText = [
    aiPlan?.product?.industryId,
    aiPlan?.product?.industryName,
    aiPlan?.product?.name,
    ...(Array.isArray(aiPlan?.product?.realSellingPoints) ? aiPlan.product.realSellingPoints : []),
    ...(Array.isArray(aiPlan?.product?.materials) ? aiPlan.product.materials : [])
  ].join(" ");
  const skill = getIndustrySkillByText(aiText);
  return skill.id !== "generic" ? skill : inferIndustry(input, productImages);
}

function asText(value, fallback = "") {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function asArray(value) {
  if (Array.isArray(value)) return value.map((item) => asText(item)).filter(Boolean);
  if (typeof value === "string") return parseList(value);
  return [];
}

function normalizeIndexList(value, max) {
  const indexes = Array.isArray(value) ? value : [];
  return uniqueList(indexes.map((item) => Number.parseInt(item, 10)))
    .filter((index) => Number.isInteger(index) && index >= 0 && index < max)
    .slice(0, 3);
}

function normalizeAiScreens(aiPlan, count, productCount, referenceCount) {
  const screens = Array.isArray(aiPlan?.screens) ? aiPlan.screens : [];
  if (screens.length === 0) return [];
  return Array.from({ length: count }, (_, index) => {
    const found = screens.find((screen) => Number.parseInt(screen?.screen, 10) === index + 1) || screens[index] || {};
    return {
      screen: index + 1,
      moduleId: asText(found.moduleId || found.module || found.moduleName),
      title: asText(found.title),
      summary: asText(found.summary),
      sellingPoint: asText(found.sellingPoint || found.selling_point),
      composition: asText(found.composition),
      copywriting: asText(found.copywriting || found.copy),
      referenceReason: asText(found.referenceReason || found.reference_reason),
      modelPolicyHint: asText(found.modelPolicyHint || found.model_policy),
      promptDirectives: asArray(found.promptDirectives || found.directives),
      negativeConstraints: asArray(found.negativeConstraints || found.negative),
      qualityChecks: asArray(found.qualityChecks || found.qcRules),
      productFileIndexes: normalizeIndexList(found.productFileIndexes, productCount),
      referenceFileIndexes: normalizeIndexList(found.referenceFileIndexes, referenceCount)
    };
  });
}

function mergeAiAnalysis(localAnalysis, aiPlan, aiMeta, aiError) {
  if (!aiPlan) {
    return {
      ...localAnalysis,
      ...(aiError ? {
        aiError,
        limitation: `AI 分析未完成，已切回本地五层 Skill 兜底。失败原因：${aiError}`
      } : {})
    };
  }

  const product = aiPlan.product || {};
  const strategy = aiPlan.strategy || {};
  const sellingPoints = uniqueList([
    ...asArray(product.realSellingPoints),
    ...asArray(strategy.pageRhythm),
    ...localAnalysis.sellingPoints
  ]);

  return {
    ...localAnalysis,
    mode: aiMeta?.mode || "ai-vision",
    confidence: aiMeta?.mode === "ai-vision" ? "high" : "medium",
    industry: asText(product.industryName, localAnalysis.industry),
    targetAudience: asText(product.targetAudience, localAnalysis.targetAudience),
    materialHints: asArray(product.materials).length > 0 ? asArray(product.materials) : localAnalysis.materialHints,
    sellingPoints: sellingPoints.length > 0 ? sellingPoints : localAnalysis.sellingPoints,
    visualStyle: asText(strategy.globalStyle || product.styleDirection, localAnalysis.visualStyle),
    productLocks: asArray(product.structureLocks),
    colors: asArray(product.colors),
    riskNotes: asArray(product.riskNotes),
    aiModel: aiMeta?.model || "",
    aiTiming: aiMeta?.timing || null,
    limitation: aiMeta?.mode === "ai-vision"
      ? "已调用 AI 文本/视觉模型读取商品图，并由五层 Skill 做规则约束、分屏规划和提示词安全清洗。"
      : "已调用 AI 文本模型做策略规划；当前模型未完成图片读取时，商品事实仍以用户输入和本地 Skill 兜底为准。"
  };
}

function inferAudience(input, industrySkill) {
  const text = `${input.productName || ""} ${input.productFeature || ""} ${input.userInstruction || ""}`;
  if (/女装|裙|通勤|轻熟|温柔|少女|辣妹|显瘦/.test(text)) return "女性消费者，关注版型、显瘦、面料质感和穿搭场景";
  if (/男装|男士|商务|通勤/.test(text)) return "男性消费者，关注质感、实用性、版型和场景适配";
  if (/儿童|宝宝|母婴|童装|亲子/.test(text)) return "亲子/家庭用户，关注安全、舒适、真实使用和清洁便利";
  if (industrySkill.id === "electronics") return "理性决策用户，关注参数、功能、可靠性和兼容场景";
  if (industrySkill.id === "beauty") return "审美与体验型用户，关注包装质感、肤感表达和使用仪式感";
  if (industrySkill.id === "food") return "日常消费用户，关注口感联想、包装规格、食用场景和信任感";
  return "电商浏览用户，关注第一眼质感、核心卖点、真实细节和购买理由";
}

function inferMaterials(input, industrySkill) {
  const text = `${input.productName || ""} ${input.productFeature || ""} ${input.userInstruction || ""} ${input.sellingPoints || ""}`;
  const candidates = [
    "棉",
    "羊毛",
    "针织",
    "雪纺",
    "牛仔",
    "皮革",
    "亚麻",
    "丝绸",
    "蕾丝",
    "玻璃",
    "金属",
    "木质",
    "陶瓷",
    "塑料",
    "硅胶",
    "不锈钢",
    "亚克力",
    "真皮",
    "珍珠",
    "黄金",
    "银饰"
  ];
  const matched = candidates.filter((item) => text.includes(item));
  if (matched.length > 0) return matched;
  return [`以${industrySkill.name}商品图中的真实材质为准，重点保留表面纹理、结构边缘和工艺细节`];
}

function inferVisualStyle(input, referenceImages, industrySkill, platformSkill) {
  const text = `${input.userInstruction || ""} ${input.productFeature || ""} ${referenceImages.map((item) => item.name).join(" ")}`;
  if (/极简|白墙|浅色|咖啡馆|草坪|柔粉|米色/.test(text)) return "浅色极简、电商高级感、柔和低反差";
  if (/赛博|科技|未来|金属|冷光/.test(text)) return "科技感、结构化光线、冷静高对比";
  if (/复古|胶片|法式|中古/.test(text)) return "复古生活方式、柔和颗粒、暖色调";
  if (/小红书|种草|生活方式/.test(`${platformSkill.platform} ${text}`)) return "自然生活方式、真实氛围、轻商业感";
  return industrySkill.visualAnchors.join("、");
}

function buildProductAnalysis(input, productImages, referenceImages, industrySkill, platformSkill) {
  const providedFeatures = parseList(input.productFeature);
  const providedSelling = parseList(input.sellingPoints);
  const imageFacts = productImages.map((item) => {
    const ratio = item.width && item.height ? `${item.width}x${item.height}` : "未读取尺寸";
    return `${item.name} / ${item.type || "未知类型"} / ${ratio}`;
  });
  const sellingPoints = uniqueList([
    ...providedSelling,
    ...providedFeatures.slice(0, 4),
    ...industrySkill.sellingAngles
  ]);

  return {
    mode: input.analysisMode === "ai" ? "ai-ready-fallback" : "local-rule",
    confidence: productImages.some((item) => item.hasPixels) ? "medium" : "low",
    industry: industrySkill.name,
    platform: platformSkill.platform,
    targetAudience: inferAudience(input, industrySkill),
    materialHints: inferMaterials(input, industrySkill),
    analyzeAttributes: industrySkill.analyzeAttributes,
    sellingPoints,
    visualStyle: inferVisualStyle(input, referenceImages, industrySkill, platformSkill),
    imageFacts,
    limitation: input.analysisMode === "ai"
      ? "当前版本已接收商品原图，但未额外调用视觉分析模型；在渠道确认支持文本/视觉分析并配置中间件计费前，仍使用本地 Skill 规则规划。"
      : "本地 Skill 规划不会额外消耗 AI 分析费用；真正视觉识别可在后续接入中间件接口。"
  };
}

function copywritingText(copywriting) {
  if (copywriting === "poster") return "无文案纯海报：画面中不要生成任何文字、标题、卖点、标签、促销信息或水印。";
  if (copywriting === "blank") return "文案留白：预留干净文字排版区域，文字极少或不直接生成，留白不能遮挡产品。";
  return "需要文案：生成清晰可读的电商文案，标题、卖点和辅助说明层级分明，文字必须无错字乱码。";
}

function fontPolicy(fontStyle, copywriting) {
  if (copywriting === "poster") return "无文案模式下不生成字体，只保留海报式画面层级。";
  const map = {
    soft: "柔和女性字体气质，笔画圆润、字重中等、排版轻盈，适合女装/美妆/生活方式。",
    heiti: "常用黑体风格，类似思源黑体、微软雅黑、阿里巴巴普惠体的干净无衬线，易读、稳定、适合电商详情。",
    modern: "现代杂志感无衬线，标题克制，留白更多，适合高质感品牌表达。",
    bold: "醒目电商标题，字重更高，但不要廉价促销感，避免大红大黄堆叠。",
    auto: "根据平台和行业自动选择字体气质，优先保证清晰可读和统一。"
  };
  return map[String(fontStyle || "soft")] || map.soft;
}

function richnessPolicy(richness) {
  const map = {
    simple: "画面保持精简，一屏只表达一个重点，文案少、留白充足。",
    balanced: "信息密度均衡，标题、卖点、产品和场景都有明确层级。",
    rich: "信息更完整，可加入辅助标签、局部细节和场景说明，但必须保持清爽不拥挤。"
  };
  return map[String(richness || "simple")] || map.simple;
}

function modelPolicy(input, index, count) {
  const modelMode = String(input.modelMode || "no-model");
  const modelPose = String(input.modelPose || "regular");
  const modelUsage = clamp(input.modelUsage, 1, 12, 4);
  if (modelMode !== "use-model") return "本屏无模特，禁止出现真人、人体局部、手持穿着或模特影子。";
  const useModel = index < Math.min(modelUsage, count);
  if (!useModel) return "本屏不使用模特，使用静物、细节、平铺或场景陈列。";
  if (modelPose === "special") {
    return "本屏使用特殊姿态模特：可用广角镜头、极端透视、动态姿态和视觉主体贴近镜头的冲击力，但产品结构、版型、面料和细节必须真实。";
  }
  return "本屏使用常规姿态模特：自然站姿、坐姿或行走，镜头透视正常，清晰展示穿着效果。";
}

function buildScreenTitles(count, platformSkill, industrySkill, reverseScreens) {
  const targetReverseCount = Math.min(clamp(reverseScreens, 0, 4, 0), Math.max(0, count - 2));
  const seedTitles = uniqueList([
    ...platformSkill.rhythm,
    ...industrySkill.recommendedScreens,
    ...industrySkill.sellingAngles
  ]).filter((title) => getScreenModule(title).id !== "painReverse");
  const titles = Array.from({ length: count }, (_, index) => seedTitles[index % seedTitles.length] || `第${index + 1}屏`);
  const candidateSlots = Array.from({ length: Math.max(0, count - 2) }, (_, index) => index + 1);

  for (let index = 0; index < targetReverseCount; index += 1) {
    const rawSlot = Math.round(((index + 1) * (candidateSlots.length + 1)) / (targetReverseCount + 1)) - 1;
    const slot = candidateSlots[Math.max(0, Math.min(candidateSlots.length - 1, rawSlot))];
    if (slot === undefined) continue;
    titles[slot] = "痛点反转";
  }

  if (count > 0) titles[0] = "首屏主视觉";
  if (count > 1) titles[count - 1] = "收尾转化";

  return titles;
}

function referencePlanForScreen(index, count, productImages, referenceImages, moduleSkill) {
  const productIndexes = [];
  if (productImages.length > 0) productIndexes.push(0);
  if (["materialDetail", "fitStructure"].includes(moduleSkill.id) && productImages.length > 1) productIndexes.push(1);
  if (["useScenario", "hero"].includes(moduleSkill.id) && productImages.length > 2) productIndexes.push(2);

  let referenceIndexes = [];
  if (referenceImages.length > 0) {
    if (["hero", "conversionClose"].includes(moduleSkill.id)) {
      referenceIndexes = [0];
    } else if (["useScenario", "painReverse"].includes(moduleSkill.id)) {
      referenceIndexes = referenceImages.slice(0, 2).map((_, refIndex) => refIndex);
    } else if (["specInfo", "trustProof", "coreSellingPoint"].includes(moduleSkill.id)) {
      referenceIndexes = [referenceImages.length - 1];
    }
  }

  if (index === count - 1 && referenceImages.length > 0) referenceIndexes = [0];

  return {
    productFileIndexes: uniqueList(productIndexes).slice(0, 3),
    referenceFileIndexes: uniqueList(referenceIndexes).slice(0, 3)
  };
}

function buildImageSlots(productImages, referenceImages, plan) {
  const slots = [];
  for (const sourceIndex of plan.productFileIndexes) {
    const image = productImages[sourceIndex];
    if (!image) continue;
    slots.push({
      slot: slots.length + 1,
      role: "product",
      label: `商品图${sourceIndex + 1}`,
      sourceIndex,
      name: image.name
    });
  }
  for (const sourceIndex of plan.referenceFileIndexes) {
    const image = referenceImages[sourceIndex];
    if (!image) continue;
    slots.push({
      slot: slots.length + 1,
      role: "reference",
      label: `参考图${sourceIndex + 1}`,
      sourceIndex,
      name: image.name
    });
  }
  return slots;
}

function imageSlotText(slots) {
  if (!slots.length) return "本屏没有可用图片附件，请根据文字描述生成，但必须保持商品真实性约束。";
  return slots.map((item) => (
    `图${item.slot}=${item.label}「${item.name}」`
  )).join("；");
}

function referenceStrategyText(plan, moduleSkill) {
  return `商品图 ${plan.productFileIndexes.length} / 参考图 ${plan.referenceFileIndexes.length} · ${moduleSkill.referenceNeed}`;
}

function buildGlobalLock({ input, platformSkill, industrySkill, analysis, productName, ratio, imageSize, lang, copywriting }) {
  return [
    `目标平台：${platformSkill.platform}${platformSkill.pageType}；输出语言：${lang}；比例：${ratio}；分辨率：${imageSize}。`,
    `目标商品：只以商品图里的「${productName}」为准，${BASE_SKILL.productAuthenticityLock.join(" ")}`,
    `行业识别：${analysis.industry}；重点观察：${industrySkill.analyzeAttributes.join("、")}。`,
    `受众：${analysis.targetAudience}；材质线索：${analysis.materialHints.join("、")}。`,
    `全局风格：${analysis.visualStyle}；${BASE_SKILL.globalStyleConsistency.join(" ")}`,
    `平台规则：${platformSkill.visualRule} ${platformSkill.copyRule}`,
    `文案规则：${copywritingText(copywriting)}；字体规则：${fontPolicy(input.fontStyle, copywriting)}；信息密度：${richnessPolicy(input.richness)}。`,
    `行业禁忌：${industrySkill.taboos.join("；")}。`
  ].join("\n");
}

function buildRounds(platformSkill, industrySkill, analysis, count, reverseScreens) {
  return [
    {
      stage: "通用底座",
      title: "真实性、格式、数量和编号",
      content: [
        BASE_SKILL.productAuthenticityLock.join("；"),
        `输出 JSON 字段：${BASE_SKILL.outputJsonFormat.requiredGroupFields.join("、")}；每屏字段：${BASE_SKILL.outputJsonFormat.requiredPromptFields.join("、")}。`,
        `分屏数量：${count}，允许范围 ${BASE_SKILL.screenCountRule.min}-${BASE_SKILL.screenCountRule.max}。`,
        BASE_SKILL.imageNumberRules.join("；"),
        BASE_SKILL.globalStyleConsistency.join("；")
      ].join("\n")
    },
    {
      stage: "行业 Skill",
      title: industrySkill.name,
      content: `分析属性：${industrySkill.analyzeAttributes.join("、")}。\n推荐卖点：${industrySkill.sellingAngles.join("、")}。\n行业禁忌：${industrySkill.taboos.join("、")}。`
    },
    {
      stage: "平台 Skill",
      title: `${platformSkill.platform}${platformSkill.pageType}`,
      content: `页面节奏：${platformSkill.rhythm.join(" -> ")}。\n文案风格：${platformSkill.copyRule}\n图片规范：${platformSkill.imageNorms.join("、")}。\n转化特点：${platformSkill.conversionTraits.join("、")}。`
    },
    {
      stage: "分屏模块库",
      title: `本组 ${count} 屏，反转屏 ${reverseScreens} 屏`,
      content: `可用模块：${Object.values(SCREEN_MODULES).map((module) => module.name).join("、")}。本组会按平台节奏、行业卖点和反转屏数量动态分配。`
    },
    {
      stage: "质检 Skill",
      title: "生成前后自查",
      content: `全局质检：${QUALITY_SKILL.globalChecks.join("；")}。\n负面约束：${QUALITY_SKILL.negativePrompt.join("、")}。\n规划模式：${analysis.limitation}`
    }
  ];
}

function buildDetailPromptGroup(input = {}, files = [], options = {}) {
  const count = clamp(input.count, BASE_SKILL.screenCountRule.min, BASE_SKILL.screenCountRule.max, DEFAULT_COUNT);
  const workflow = String(input.workflow || "taobao-detail").trim();
  const platformSkill = getPlatformSkill(workflow);
  const productFiles = files.filter((file) => file.detailRole === "product");
  const referenceFiles = files.filter((file) => file.detailRole === "reference");
  const productImages = assetsFromInput(input.productImages, productFiles, "product");
  const referenceImages = assetsFromInput(input.referenceImages, referenceFiles, "reference");
  const aiPlan = options.aiPlan || null;
  const industrySkill = aiPlan ? aiIndustry(input, productImages, aiPlan) : inferIndustry(input, productImages);
  const localAnalysis = buildProductAnalysis(input, productImages, referenceImages, industrySkill, platformSkill);
  const analysis = mergeAiAnalysis(localAnalysis, aiPlan, options.aiMeta, options.aiError);
  const productName = String(input.productName || "").trim() || "目标产品";
  const ratio = String(input.ratio || "21:9").trim();
  const imageSize = String(input.imageSize || "2K").trim();
  const model = String(input.model || "gpt-image").trim();
  const lang = String(input.lang || "中文").trim() || "中文";
  const copywriting = String(input.copywriting || "need") === "none" ? "poster" : String(input.copywriting || "need");
  const reverseScreens = clamp(input.reverseScreens, 0, 4, 0);
  const sellingList = analysis.sellingPoints.length > 0 ? analysis.sellingPoints : industrySkill.sellingAngles;
  const fallbackScreenTitles = buildScreenTitles(count, platformSkill, industrySkill, reverseScreens);
  const aiScreens = normalizeAiScreens(aiPlan, count, productImages.length, referenceImages.length);
  const screenTitles = aiScreens.length > 0
    ? aiScreens.map((screen, index) => screen.title || SCREEN_MODULES[screen.moduleId]?.name || fallbackScreenTitles[index])
    : fallbackScreenTitles;
  const createdAt = Date.now();

  const globalLock = buildGlobalLock({
    input,
    platformSkill,
    industrySkill,
    analysis,
    productName,
    ratio,
    imageSize,
    lang,
    copywriting
  });

  const prompts = screenTitles.map((title, index) => {
    const aiScreen = aiScreens[index] || null;
    const moduleSkill = SCREEN_MODULES[aiScreen?.moduleId]
      || Object.values(SCREEN_MODULES).find((module) => module.name === aiScreen?.moduleId)
      || getScreenModule(aiScreen?.title || title, index, count);
    const selling = aiScreen?.sellingPoint || aiScreen?.summary || sellingList[index % sellingList.length] || moduleSkill.name;
    const rulePlan = referencePlanForScreen(index, count, productImages, referenceImages, moduleSkill);
    const plan = aiScreen
      ? {
          productFileIndexes: aiScreen.productFileIndexes.length > 0 ? aiScreen.productFileIndexes : rulePlan.productFileIndexes,
          referenceFileIndexes: aiScreen.referenceFileIndexes
        }
      : rulePlan;
    if (plan.productFileIndexes.length === 0 && productImages.length > 0) plan.productFileIndexes = [0];
    const imageSlots = buildImageSlots(productImages, referenceImages, plan);
    const qualityChecklist = uniqueList([
      ...buildQualityChecklist(platformSkill, industrySkill, moduleSkill),
      ...(aiScreen?.qualityChecks || [])
    ]);
    const promptDirectives = uniqueList([
      ...moduleSkill.promptDirectives,
      ...(aiScreen?.promptDirectives || [])
    ]);
    const negativeConstraints = uniqueList([
      ...QUALITY_SKILL.negativePrompt,
      ...(aiScreen?.negativeConstraints || [])
    ]);
    const aiInsight = aiPlan
      ? `【AI商品洞察】目标人群：${analysis.targetAudience}；真实材质/颜色：${[...(analysis.materialHints || []), ...(analysis.colors || [])].slice(0, 8).join("、") || "以商品图为准"}；结构锁定：${(analysis.productLocks || []).slice(0, 6).join("、") || "保持商品图真实结构"}。`
      : "";
    const text = [
      `第${index + 1}屏：${title}`,
      `【本屏模块】${moduleSkill.name}：${moduleSkill.purpose}`,
      aiInsight,
      `【本次图片编号】${imageSlotText(imageSlots)}。生成时严格按此编号理解图片，禁止引用未列入本屏的其它素材。`,
      `【全局一致性锁定】${globalLock}`,
      `【本屏卖点】${selling}`,
      aiScreen?.copywriting ? `【本屏文案】${aiScreen.copywriting}` : "",
      `【画面任务】${aiScreen?.composition || moduleSkill.composition}`,
      `【模块指令】${promptDirectives.join("；")}。`,
      `【参考图使用】${aiScreen?.referenceReason || moduleSkill.referenceNeed}；参考图只吸收允许的场景、构图、配色或版式，不复制品牌、水印、人物身份和无关商品。`,
      `【模特与镜头】${aiScreen?.modelPolicyHint || modelPolicy(input, index, count)}`,
      `【构图与光线】主体清晰、边缘干净、柔和四面光、低反差、无生硬黑影；细节屏可以近景，但必须保留产品真实结构。`,
      `【质检自查】${qualityChecklist.slice(0, 8).join("；")}。`,
      `【负面约束】${negativeConstraints.join("、")}。`
    ].filter(Boolean).join("\n");

    return {
      screen: index + 1,
      title,
      summary: selling,
      intervention: aiPlan
        ? (index === 0 ? "AI视觉定调" : index === count - 1 ? "AI收尾质检" : `AI ${moduleSkill.name}`)
        : (index === 0 ? "通用底座定调" : index === count - 1 ? "收尾转化质检" : `${moduleSkill.name}介入`),
      referenceStrategy: referenceStrategyText(plan, moduleSkill),
      productFileIndexes: plan.productFileIndexes,
      referenceFileIndexes: plan.referenceFileIndexes,
      imageSlots,
      moduleKey: moduleSkill.id,
      moduleName: moduleSkill.name,
      qualityChecklist,
      aiScreen: aiScreen ? {
        referenceReason: aiScreen.referenceReason,
        copywriting: aiScreen.copywriting,
        composition: aiScreen.composition
      } : null,
      analysisMode: analysis.mode,
      text,
      enabled: true,
      status: "pending",
      generationMs: null,
      results: []
    };
  });

  const rounds = buildRounds(platformSkill, industrySkill, analysis, count, reverseScreens);

  return {
    id: `detail_${createdAt}_${Math.random().toString(36).slice(2, 8)}`,
    label: `${new Date(createdAt).toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit" })} | ${productName}`,
    createdAt,
    status: "confirming",
    params: {
      workflow,
      platform: platformSkill.platform,
      pageType: platformSkill.pageType,
      model,
      ratio,
      imageSize,
      count,
      lang,
      copywriting,
      richness: String(input.richness || "simple"),
      fontStyle: String(input.fontStyle || "soft"),
      modelMode: String(input.modelMode || "no-model"),
      modelPose: String(input.modelPose || "regular"),
      modelUsage: clamp(input.modelUsage, 1, 12, 4),
      reverseScreens,
      analysisMode: analysis.mode,
      industry: analysis.industry,
      productName,
      productImageNames: productImages.map((item) => item.name).filter(Boolean),
      referenceImageNames: referenceImages.map((item) => item.name).filter(Boolean)
    },
    analysis,
    skillLayers: {
      base: BASE_SKILL,
      industry: industrySkill,
      platform: platformSkill,
      modules: prompts.map((prompt) => ({
        screen: prompt.screen,
        moduleKey: prompt.moduleKey,
        moduleName: prompt.moduleName,
        title: prompt.title
      })),
      quality: QUALITY_SKILL
    },
    rounds,
    prompts
  };
}

export {
  buildDetailPromptGroup,
  BASE_SKILL,
  INDUSTRY_SKILLS,
  PLATFORM_SKILLS,
  QUALITY_SKILL
};
