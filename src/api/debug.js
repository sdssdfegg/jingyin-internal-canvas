import { postJson } from "./client.js";

function isBananaModel(model) {
  return /^nano-banana/i.test(String(model || ""));
}

function fieldValue(fields, key) {
  const field = (Array.isArray(fields) ? fields : []).find((item) => item?.key === key);
  return field ? String(field.value ?? "") : "";
}

function imageFieldCount(fields) {
  return (Array.isArray(fields) ? fields : []).filter((item) => item?.key === "image").length;
}

function buildDiagnosticHints(params, primary) {
  const banana = isBananaModel(params.model);
  const hasImages = Boolean(params.hasImages);
  const hints = [];

  if (banana && hasImages) {
    const firstImageSize = fieldValue(primary.fields, "image_size");
    const firstAspectRatio = fieldValue(primary.fields, "aspect_ratio");
    const firstImages = imageFieldCount(primary.fields);
    hints.push("检查结论：当前是香蕉图生图/编辑自检，可以用来对照上游传参。");
    hints.push(`香蕉首跳应为：/images/edits + multipart + image_size=${firstImageSize || "2K"} + aspect_ratio=${firstAspectRatio || params.aspectRatio || "3:4"} + image ${firstImages || params.imageCount || 0} 张。`);
  } else if (banana && !hasImages) {
    hints.push("检查结论：当前选的是香蕉模型，但图片字段为 0，所以本次干跑按文生图生成，不能用来判断香蕉图生图、局部回贴或批量换装传参。");
    hints.push("处理方式：请在实际出问题的页面保留上传图后再点一键传参自检；批量换装至少应包含图1和图2，快捷生成图生图至少应包含 1 张参考图。");
  } else if (!banana) {
    hints.push("检查结论：当前不是香蕉模型，不能用这份报告判断香蕉传参是否正确。");
  }

  if (params.source === "quickgen" && !hasImages) {
    hints.push("入口提示：快捷生成没有上传参考图时，本来就会走文生图接口。");
  }

  return hints;
}

export function inspectImageRequestParams(input) {
  return postJson("/api/debug/image-request-params", input, "传参自检失败");
}

export function formatImageRequestDiagnostic(report = {}) {
  const params = report.params || {};
  const primary = report.primary || {};
  const routes = Array.isArray(report.routes) ? report.routes : [];
  const variants = Array.isArray(report.variants) ? report.variants : [];
  const security = report.security || {};
  const banana = isBananaModel(params.model);
  const hints = buildDiagnosticHints(params, primary);
  const fields = Array.isArray(primary.fields) ? primary.fields : [];
  const lines = [
    "静音AI画板传参自检",
    `时间：${report.generatedAt || ""}`,
    "说明：本报告由本机干跑生成，不调用上游、不扣费、不包含 KEY、真实域名、价格、完整提示词或图片内容。",
    "",
    ...hints,
    hints.length ? "" : null,
    `检查对象：${params.source || "未指定"} / ${params.model || ""}`,
    `是否香蕉模型：${banana ? "是" : "否"}`,
    `是否带图片：${params.hasImages ? `是（${params.imageCount || 0} 张）` : "否（0 张）"}`,
    `模式：${params.hasImages ? "图生图/编辑" : "文生图"}`,
    `尺寸：${params.imageSize || ""} / ${params.aspectRatio || ""}`,
    `数量：n=${params.n || 1}，图片字段 ${params.imageCount || 0} 张`,
    "",
    "第一请求",
    `接口：${primary.path || ""}`,
    `协议：${primary.protocol || ""}`,
    `格式：${primary.requestFormat || ""}`,
    `模型字段：${primary.modelField || ""}`,
    "字段：",
    ...fields.map((field) => `- ${field.key} = ${field.value}`),
    "",
    "候选格式",
    ...variants.map((variant) => `${variant.attempt}. ${variant.requestFormat} / ${variant.protocol} / ${variant.path}`),
    "",
    "通道摘要",
    ...routes.map((route) => `${route.attempt}. ${route.role}${route.fallback ? " / fallback" : ""}`),
    "",
    "安全检查",
    `KEY：${security.apiKeyIncluded ? "异常：包含" : "未包含"}`,
    `提示词正文：${security.promptIncluded ? "异常：包含" : "未包含"}`,
    `图片内容：${security.imageContentIncluded ? "异常：包含" : "未包含"}`,
    `真实域名：${security.upstreamBaseUrlIncluded ? "异常：包含" : "未包含"}`,
    `价格：${security.priceIncluded ? "异常：包含" : "未包含"}`,
    "",
    `计费/调用：${report.upstreamCalled ? "异常：已调用上游" : "未调用上游"}，${report.charged ? "异常：可能扣费" : "不扣费"}`,
    report.billingGateway?.note ? `计费网关：${report.billingGateway.note}` : ""
  ];

  return lines.filter((line) => line != null).join("\n");
}
