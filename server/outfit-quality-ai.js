const DEFAULT_OUTFIT_QUALITY_MODEL = "gpt-5.4-mini";
const OUTFIT_QUALITY_TIMEOUT_MS = 75000;

// 中文注释：把任意输入整理成短文本，避免 undefined/null 混入质检提示词。
function asText(value, fallback = "") {
  const text = String(value ?? "").trim();
  return text || fallback;
}

// 中文注释：压缩日志和模型返回文本，防止异常信息撑爆前端提示。
function compact(value, limit = 1200) {
  return String(value || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, limit);
}

// 中文注释：选择视觉质检模型，默认沿用当前项目的轻量视觉文本模型。
function modelName(input) {
  return asText(input.outfitQualityModel || input.outfitMasterFitModel || input.outfitPoseModel || input.detailAnalysisModel || input.textModel, DEFAULT_OUTFIT_QUALITY_MODEL);
}

// 中文注释：给质检请求加超时，避免生成完成后质检长期占用前端状态。
function createAbortSignal(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    dispose: () => clearTimeout(timer)
  };
}

// 中文注释：兼容中转站 JSON 或纯文本错误返回，便于统一提取错误信息。
function readResponse(response) {
  return response.text().then((text) => {
    try {
      return { text, json: JSON.parse(text) };
    } catch {
      return { text, json: null };
    }
  });
}

// 中文注释：从 chat/completions 结果里提取正文，兼容字符串与多段 content。
function responseContent(payload) {
  const message = payload?.choices?.[0]?.message;
  if (!message) return "";
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content.map((part) => part.text || part.content || "").join("\n");
  }
  return "";
}

// 中文注释：模型可能包 Markdown 代码块，这里只抽 JSON 对象本体。
function extractJsonObject(text) {
  const raw = String(text || "").trim();
  if (!raw) throw new Error("AI质检没有返回内容");
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
    throw new Error("AI质检返回的不是有效 JSON");
  }
}

// 中文注释：部分中转站不支持 response_format，遇到这类错误后取消 JSON 格式约束重试。
function shouldRetryWithoutJsonFormat(status, text) {
  const source = `${status} ${text}`.toLowerCase();
  return status >= 400 && (
    source.includes("response_format")
    || source.includes("json_object")
    || source.includes("unsupported")
  );
}

// 中文注释：把上传图转成视觉模型可读的 data URL 图片输入。
function safeImagePart(file) {
  return {
    type: "image_url",
    image_url: {
      url: `data:${file.mimetype || "image/png"};base64,${file.buffer.toString("base64")}`,
      detail: "high"
    }
  };
}

// 中文注释：记录文件基础信息用于质检上下文和本地日志，不包含用户 Key。
function fileMeta(file, fallback = "image") {
  return {
    name: file?.originalname || fallback,
    type: file?.mimetype || "",
    size: file?.size || file?.buffer?.length || 0
  };
}

// 中文注释：统一整理质检布尔开关，前端和服务端都可以传 true/false/中文状态。
function isPoseRemixWorkflow(input) {
  const text = [
    input?.workflowMode,
    input?.pageName,
    input?.uploadLabels?.model?.title,
    input?.uploadLabels?.clothing?.title,
    input?.uploadLabels?.reference?.title
  ].join(" ");
  if (String(input?.workflowMode || "") === "face-swap" || /批量换脸|换脸|face/i.test(text)) return false;
  return String(input?.workflowMode || "") === "pose-remix"
    || /批量姿态|批量姿态图|姿态参考图|固定模特换姿势|固定模特|固定人物|固定成片|固定母版成片|批量姿势|批量姿势参考图|换姿势|姿势生成|姿势参考|pose/i.test(text);
}

// 中文注释：按当前工作流生成不同质检标准，批量姿态重点防止复制图1衣服和固定头肩。
function workflowQualityRules(input) {
  if (isPoseRemixWorkflow(input)) {
    return {
      mode: "pose-remix",
      title: "批量姿态质检",
      rules: [
        "图1是批量姿态参考图：结果必须跟随图1的人脸朝向、肩膀角度、手臂手腕手掌、下半身、重心、站坐走状态和构图动势。",
        "图1只提供姿态，不提供服装、穿法、背景、人物身份或场景；如果结果复制了图1衣服、裙裤、扎法、背景或陌生人物，要判为不合格。",
        "图2是固定母版成片：结果必须保持图2的人物身份、脸、发型、服装、袖口袖克夫、扣合状态、衣摆扎法、腰身、裙长/裤长、材质、场景、光影和商业摄影风格。",
        "人脸不能发糊、五官不能崩、头肩手臂不能像固定母版一样不动；需要在姿态跟随和母版事实之间做自然适配。",
        "重点检查下半身是否跟图1对上号，不能只改一点手臂或肩膀。"
      ]
    };
  }

  const text = [input?.workflowMode, input?.pageName].join(" ");
  if (/换脸|face/i.test(text)) {
    return {
      mode: "face-swap",
      title: "批量换脸质检",
      rules: [
        "图1是目标人物原图：结果必须保持图1身体、服装、姿势、背景、构图、镜头距离、头部位置、头部大小、脸部朝向、下巴位置、脖子肩线、头身比和原始光影；图1原脸型、原发型和原头饰不应干扰最终头脸妆造。",
        "图2是头脸妆造母图：结果的人脸身份、五官、脸型、年龄感、脸部肤色妆容色调、发型整体轮廓、发量、发色、刘海、发缝、头饰/发饰/耳饰应来自图2；如果仍明显保留图1原脸型、原发型或原头饰导致不像图2，要判为不合格。",
        "换脸后只能改变脸部身份、脸型、发型和头饰，不能把图1身体衣服改成图2母图衣服，不能复制图2衣服、衣领、肩膀、背景、拍摄角度、场景或头部姿态，不能移动头部、改变脖子肩线、改变下巴到锁骨/衣领距离、改变头身比或重构画面。",
        "同一批换脸结果的脸部主体要保持同一张图2脸母图的肤色明暗、妆容浓淡、口红色相和饱和度、面部对比度、磨皮程度和清晰度；如果一张口红更鲜艳、一张低饱和、一张更白皙或像不同光源拍摄，要判为不合格。",
        "脸部和发型边缘要清晰自然，不能糊、错位、面具感、双脸、混合图1和图2脸、脖子畸形、下巴重影或头身比例异常；脸部主体肤色妆容和发型头饰应接近图2脸母图，边缘曝光、背景和光影必须自然承接图1。"
      ]
    };
  }

  if (/换固定背景|固定背景|换背景|背景|background/i.test(text)) {
    return {
      mode: "background-change",
      title: "批量换固定背景质检",
      rules: [
        "图1人物坐标、姿势、脸、发型、服装、主体占比和半身/全身裁切必须保持，图2只提供统一背景场景。",
        "结果不能换衣、换脸、移动人物、补全半身下半身、扩出腿脚、扩展画布；人物可以自然重光照贴合图2固定背景，但不能改变身份、服装款式和人物结构。",
        "主光方向、色温、白平衡、对比度、地面接触阴影、边缘环境光和透视应像图2固定背景里的真实拍摄；如果人物像贴纸、边缘断层、阴影缺失或明显 P 图感，要判为不合格。"
      ]
    };
  }

  return {
    mode: "outfit",
    title: "批量换装质检",
    rules: [
      "图1人物身份、脸、发型、姿势、头身比例、手脚、场景和光影应稳定。",
      "图2服装事实应稳定迁移，袖口、袖克夫、袖长、卷袖/放下状态、扣子数量和开合位置、拉链高度、衣摆扎法、腰身、裙长/裤长、面料和细节不能随机漂移。",
      "如果图2衣摆扎入下装、袖子卷起、扣子只扣一部分或领口有固定开口，结果必须保持同一穿法；不能生成未扎、放下袖、随机全扣/全开或不同领口深度。",
      "结果脸部不能发糊失真，服装不能被重设计，批量商业成片质感要干净。"
    ]
  };
}

// 中文注释：构造质检模型输入，强制返回前端可以直接展示的 JSON。
function buildQualityCheckContent(input, files) {
  const rules = workflowQualityRules(input);
  const referenceFiles = files.reference || [];
  const masterFitSpec = compact(input.masterFitSpec, 1800);
  const payload = {
    task: rules.title,
    workflowMode: rules.mode,
    goal: "判断生成结果是否满足当前画板工作流；只做质检标记和修复建议，不自动返修。",
    images: {
      image1: fileMeta(files.image1, "image1"),
      image2: fileMeta(files.image2, "image2"),
      result: fileMeta(files.result, "result"),
      reference: referenceFiles.map((file, index) => fileMeta(file, `reference-${index + 1}`))
    },
    input: {
      pageName: asText(input.pageName),
      model: asText(input.model, "gpt-image"),
      aspectRatio: asText(input.aspectRatio, "3:4"),
      imageSize: asText(input.imageSize, "2K"),
      userPrompt: asText(input.prompt),
      productNote: asText(input.productNote),
      masterFitLock: Boolean(input.masterFitLock),
      masterFitSpec,
      uploadLabels: input.uploadLabels || {}
    },
    rules: [
      ...rules.rules,
      ...(masterFitSpec ? [
        "本次开启了图2母版版型锁定；必须额外按 masterFitSpec 检查袖口袖克夫、袖子穿法、扣子数量、拉链高度、领口开口、衣摆扎法、腰身、衣长、裙/裤长度和面料细节。",
        "如果结果与 masterFitSpec 冲突，即使单张视觉看起来好看，也要把服装一致性判为风险或不合格。"
      ] : [])
    ],
    scoring: [
      "90-100：可直接交付，只有非常轻微问题。",
      "75-89：基本合格，有小漂移但不影响整组一致性。",
      "60-74：边界不稳，需要返修或重跑。",
      "0-59：明显不合格，例如批量姿态复制了图1衣服、脸糊、服装穿法漂移、姿势没跟上。"
    ],
    outputSchema: {
      pass: "boolean，score>=78且没有关键错误时为 true",
      score: "number，0-100",
      summary: "string，30-80字中文总结",
      issues: "string[]，列出不合格点或风险点，最多6条",
      repairPrompt: "string，80-260字中文返修提示词；合格时给保持建议",
      faceQuality: "string，清晰/轻微糊/明显糊/五官失真",
      poseMatch: "string，姿态匹配情况",
      outfitMatch: "string，服装版型穿法匹配情况"
    }
  };

  const content = [
    { type: "text", text: JSON.stringify(payload, null, 2) },
    { type: "text", text: "图1：当前工作流的第一张输入图" },
    safeImagePart(files.image1),
    { type: "text", text: "图2：当前工作流的第二张输入图" },
    safeImagePart(files.image2),
    { type: "text", text: "生成结果：需要质检的输出图" },
    safeImagePart(files.result)
  ];

  referenceFiles.forEach((file, index) => {
    content.push(
      { type: "text", text: `图3补充参考 ${index + 1}：只在用户提示词明确启用时作为弱参考` },
      safeImagePart(file)
    );
  });

  return content;
}

// 中文注释：组装 chat/completions 请求体，用低温度保证质检结果稳定。
function buildChatBody(input, files, withJsonFormat) {
  const body = {
    model: modelName(input),
    temperature: 0.1,
    messages: [
      {
        role: "system",
        content: [
          "你是静音AI画板的电商生图质检员。",
          "你只根据用户给的图1、图2和生成结果做视觉质检，重点检查人物脸部清晰度、姿态跟随、服装版型穿法、场景光影和批量一致性。",
          "必须输出严格 JSON，不要 Markdown，不要解释。"
        ].join("\n")
      },
      {
        role: "user",
        content: buildQualityCheckContent(input, files)
      }
    ]
  };
  if (withJsonFormat) body.response_format = { type: "json_object" };
  return body;
}

// 中文注释：向候选中转站发起质检请求，失败时外层按渠道顺序重试。
async function postChatCompletion({ baseUrl, apiKey, input, files, withJsonFormat, signal }) {
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(buildChatBody(input, files, withJsonFormat)),
    signal
  });
  const parsed = await readResponse(response);
  return { response, parsed };
}

// 中文注释：规整模型质检 JSON，保证前端永远拿到稳定字段。
function normalizeQualityPlan(plan, input = {}) {
  const mode = workflowQualityRules(input).mode;
  const scoreRaw = Number(plan?.score);
  const score = Number.isFinite(scoreRaw) ? Math.max(0, Math.min(100, Math.round(scoreRaw))) : 0;
  const issues = Array.isArray(plan?.issues)
    ? plan.issues.map((item) => compact(item, 120)).filter(Boolean).slice(0, 6)
    : compact(plan?.issues, 300).split(/[；;\n]+/).map((item) => compact(item, 120)).filter(Boolean).slice(0, 6);
  const commonCritical = /脸.*(糊|崩|失真|错位|双脸|面具)|头.*(偏移|移动|变大|变小)|头身比.*(变|错|异常|不对)|下巴.*(重影|偏移|错|变)|脖子.*(断层|错|变|畸形|拉长|缩短)|头颈.*(错|变|畸形)|肤色.*(断层|不自然)/;
  const workflowCritical = mode === "face-swap"
    ? /(复制|带入|出现|参考|保留).*图2.*(衣|服装|衣领|肩膀|背景|场景|身体|姿势|拍摄角度|头部姿态|头发外轮廓|脖子|头身比)|图2.*(衣|服装|衣领|肩膀|背景|场景|身体|姿势|拍摄角度|头部姿态|头发外轮廓|脖子|头身比).*(复制|带入|进入|出现)|换衣|换装|衣服.*(改|换|变|不是图1)|背景.*(换|变|不是图1)|姿势.*(不像|不跟|没跟).*图1|像.*(母图|图2).*姿势/
    : mode === "pose-remix"
      ? /复制图1.*(衣|服装|背景)|姿态.*(不跟|没跟|固定)|下半身.*不/
      : /穿法.*漂移|袖口.*漂移|袖克夫.*漂移|扣子.*(错|漂移|不一致|多|少)|衣摆.*(未扎|漂移|不一致)|卷袖.*(错|漂移|不一致)|拉链.*(错|漂移)|领口.*(错|漂移)|下半身.*不/;
  const criticalIssue = issues.some((issue) => commonCritical.test(issue) || workflowCritical.test(issue));
  const pass = typeof plan?.pass === "boolean" ? plan.pass : score >= 78 && !criticalIssue;
  return {
    pass,
    score,
    summary: compact(plan?.summary, 160) || (pass ? "质检通过，人物、姿态和服装整体稳定。" : "质检发现明显漂移，需要复核或返修。"),
    issues,
    repairPrompt: compact(plan?.repairPrompt, 360) || (pass ? "保持当前人物、服装、姿态和场景一致性继续生成。" : "返修时加强图1/图2角色边界，修复脸部清晰度、姿态跟随和服装穿法漂移。"),
    faceQuality: compact(plan?.faceQuality, 80),
    poseMatch: compact(plan?.poseMatch, 100),
    outfitMatch: compact(plan?.outfitMatch, 120)
  };
}

// 中文注释：主入口；按当前 Key 可用渠道依次质检，成功返回可展示结果。
async function createOutfitQualityCheck({ input = {}, files = {}, apiKey, baseUrls = [], timeoutMs = OUTFIT_QUALITY_TIMEOUT_MS }) {
  if (!apiKey) throw new Error("缺少 API Key，无法调用 AI质检员");
  if (!files.image1?.buffer) throw new Error("缺少图1，无法质检");
  if (!files.image2?.buffer) throw new Error("缺少图2，无法质检");
  if (!files.result?.buffer) throw new Error("缺少生成结果，无法质检");
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
          files,
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

        const plan = normalizeQualityPlan(extractJsonObject(responseContent(parsed.json)), input);
        return {
          ok: true,
          model: modelName(input),
          usedBaseUrl: baseUrl,
          mode: workflowQualityRules(input).mode,
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
  throw new Error(last?.message || "AI质检失败");
}

export {
  DEFAULT_OUTFIT_QUALITY_MODEL,
  createOutfitQualityCheck
};
