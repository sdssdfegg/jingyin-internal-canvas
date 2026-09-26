// 选框几何 + 裁剪 + 局部回贴的**唯一实现**。
//
// 为什么要有这个文件：
//   1. 要求「普通裁剪和局部回贴都必须使用同一套实际选框几何规则」。
//      V11 原来在 src/main.jsx 和 src/outfit-workflow.jsx 里各抄了一份完全相同的
//      几何/合成函数，改一处忘一处就会两边行为不一致。现在只有这一份。
//   2. 它不依赖 React，可以直接在浏览器里 import 出来跑真实 Blob 验证
//      （见 scripts/verify/crop-geometry-check 的浏览器用例）。
//
// 行为契约（对齐 3.0 新源码 frontend/ecommerce/src）：
//   - `cropImage.ts:150`     裁剪画布尺寸 **严格等于** 选框在原图上的像素尺寸
//   - `compress.ts:186-201`  先保尺寸只降质量；只有超字节上限才等比缩小，绝不上采样
//   - `localPaste.ts:159-175` 贴回 = 整张底图打底 + 唯一一次
//                            `drawImage(generated, rect.x, rect.y, rect.width, rect.height)`
//   - `localPaste.ts:17-18`  明确不做羽化 / 自动对齐 / 颜色匹配 / 护脸
//
// 这里**不含**任何：补白边、按比例外扩、选区外恢复、自动回盖、蒙版膨胀、
// 面部/身份/头脸/肩颈保护区、隐藏保护区域。

export const LOCAL_EDIT_RECT_MODE = "rect";
export const LOCAL_EDIT_MASK_MODE = "mask";

/**
 * 局部回贴：**裁剪源 / 贴回底图必须是同一张图**。规则只有一条 —— 原图优先。
 *
 * 为什么要有这个函数（2026-09-26 批量局部回贴贴回错位事故）：
 *   上传图片对象上其实挂着两份文件：
 *     - `originalFile`：用户上传的原图（长边可能 3500，几 MB 起）；
 *     - `file`：**送中转渠道的上传副本**。原图 >4MB 时会被压到长边 3072 并重新编码
 *       （`src/outfit-workflow.jsx` 的 `compressOriginalImageFile` / `CHANNEL_UPLOAD_MAX_SIDE`），
 *       原图 ≤4MB 时它和 `originalFile` 是同一个 File。
 *   局部选框 UI（`OutfitLocalEditModal`）、选框裁剪、诊断快照全都是按 `originalFile`
 *   的像素坐标算的；所以贴回底图也必须是 `originalFile`。
 *   一旦贴回改回"上传副本优先"，原图 >4MB 时就会出现：
 *   3500 坐标的选框贴到 3072 画布上 → 输出尺寸变成 3072、补丁相对底图放大约 1.14 倍并偏移。
 *   （实测产物：原图 2334×3500 + 上传副本 2049×3072 → 贴回结果 2049×3072。）
 *
 * @param {{originalFile?: File|null, file?: File|null}|null} item 上传图片对象
 * @returns {File|null} 局部回贴的裁剪源 / 贴回底图
 */
export function resolveLocalEditBaseFile(item) {
  if (!item) return null;
  return item.originalFile || item.file || null;
}

/** 像素尺寸文案：局部回贴的"给多少尺寸 → 返回多少尺寸"口径统一用它。 */
export function formatPixelSize(width, height) {
  const w = Math.max(0, Math.round(Number(width) || 0));
  const h = Math.max(0, Math.round(Number(height) || 0));
  return w > 0 && h > 0 ? `${w}×${h}` : "";
}

/**
 * 局部回贴的**尺寸对账单**（写进任务日志、显示在弹窗里）。
 *
 * 契约（用户口径："我给的图多少尺寸，返回的就是多少尺寸"）：
 *   - `base`     = 我给的图（= `resolveLocalEditBaseFile` 那张）的尺寸；
 *   - `rect`     = 选框在 `base` 坐标系里的像素范围（送模型的局部图就是它裁出来的）；
 *   - `output`   = 贴回输出画布尺寸，**必须等于 `base`**；
 *   - `uploadCopy` = 应用为"送中转渠道"另存的副本尺寸（可能比 base 小，不参与贴回）。
 *
 * 把这三四个数摆在一起，"偏移/尺寸不对"就不再是只能靠肉眼判断的事：
 * `matches=false` 明确表示输出尺寸和底图不一致（异常）。
 */
export function localPasteSizeReport(input = {}) {
  const base = input.base || {};
  const rect = input.rect || {};
  const output = input.output || base;
  const uploadCopy = input.uploadCopy || null;
  const baseText = formatPixelSize(base.width, base.height);
  const outputText = formatPixelSize(output.width, output.height);
  return {
    base: baseText,
    uploadCopy: uploadCopy ? formatPixelSize(uploadCopy.width, uploadCopy.height) : "",
    rect: formatPixelSize(rect.width, rect.height),
    rectAt: Number.isFinite(Number(rect.x)) && Number.isFinite(Number(rect.y))
      ? `${Math.round(Number(rect.x))},${Math.round(Number(rect.y))}`
      : "",
    output: outputText,
    matches: Boolean(baseText) && baseText === outputText
  };
}

/** 把选框夹进图片范围内，宽高保持整数像素，**不做任何比例或最小尺寸改写**。 */
export function constrainCropRect(rect, imageWidth, imageHeight) {
  const width = Math.max(1, Math.min(Math.round(rect?.width || 1), imageWidth));
  const height = Math.max(1, Math.min(Math.round(rect?.height || 1), imageHeight));
  return {
    x: Math.max(0, Math.min(Math.round(rect?.x || 0), imageWidth - width)),
    y: Math.max(0, Math.min(Math.round(rect?.y || 0), imageHeight - height)),
    width,
    height
  };
}

/**
 * 解析 "2:3" → `{ width: 2, height: 3, value: 2/3 }`。
 * 非法输入退化为 1:1，保证调用方永远拿到可用比例。
 */
export function parseRatioParts(ratio) {
  const [rawWidth, rawHeight] = String(ratio || "1:1").split(":").map((part) => Number.parseFloat(part));
  const width = Number.isFinite(rawWidth) && rawWidth > 0 ? rawWidth : 1;
  const height = Number.isFinite(rawHeight) && rawHeight > 0 ? rawHeight : 1;
  return { width, height, value: width / height };
}

/**
 * 比例锁定：把任意宽高吸附成**精确符合该比例的整数像素**。
 *
 * 为什么不是各自四舍五入：`round(w)` 和 `round(h)` 各取整一次会漂移，
 * 800.5×1200.75 会变成 801×1201（实际比例 0.667，不是 2:3）。
 * 这里只对宽做一次取整，高由宽反推，误差 ≤ 1px 且方向一致；
 * 再用高上限回推一次宽，确保不越界。
 *
 * @returns {{width: number, height: number}} 两个值都是 ≥1 的整数，且 width/height ≈ ratio
 */
export function snapSizeToRatio(width, height, ratio, maxWidth = Infinity, maxHeight = Infinity) {
  const { width: ratioWidth, height: ratioHeight } = parseRatioParts(ratio);
  const limitWidth = Math.max(1, Math.floor(Number.isFinite(maxWidth) ? maxWidth : Infinity));
  const limitHeight = Math.max(1, Math.floor(Number.isFinite(maxHeight) ? maxHeight : Infinity));

  // 以请求的宽为准取整，高由宽反推（比例精确到最近整数像素）。
  let nextWidth = Math.max(ratioWidth, Math.round(Number.isFinite(width) && width > 0 ? width : ratioWidth));
  let nextHeight = Math.max(ratioHeight, Math.round((nextWidth * ratioHeight) / ratioWidth));

  // 超出高上限时，用高反推宽（仍然只做一次取整）。
  if (nextHeight > limitHeight) {
    nextHeight = limitHeight;
    nextWidth = Math.max(ratioWidth, Math.round((nextHeight * ratioWidth) / ratioHeight));
  }
  // 超出宽上限时，用宽反推高。
  if (nextWidth > limitWidth) {
    nextWidth = limitWidth;
    nextHeight = Math.max(ratioHeight, Math.round((nextWidth * ratioHeight) / ratioWidth));
  }
  // 回推后可能又略微超高（取整导致），按高再夹一次。
  if (nextHeight > limitHeight) {
    nextHeight = limitHeight;
    nextWidth = Math.max(ratioWidth, Math.round((nextHeight * ratioWidth) / ratioHeight));
  }
  return { width: Math.max(1, Math.round(nextWidth)), height: Math.max(1, Math.round(nextHeight)) };
}

/**
 * 按中心点把一个**指定比例**的选框放进图片里。
 * 用于「切换比例」：保持原选框中心，尽量留在原图范围内，不拉伸图像。
 *
 * @param {{x,y,width,height}|null} rect 原选框（只取中心与大致大小）
 * @param {string} ratio "2:3" / "1:1" ...
 */
export function fitRectToRatioLocked(rect, ratio, imageWidth, imageHeight) {
  const sourceWidth = Math.max(1, Math.round(imageWidth || 1));
  const sourceHeight = Math.max(1, Math.round(imageHeight || 1));
  const centerX = rect ? rect.x + rect.width / 2 : sourceWidth / 2;
  const centerY = rect ? rect.y + rect.height / 2 : sourceHeight / 2;
  const wantedWidth = Math.min(sourceWidth, Math.max(1, rect?.width || sourceWidth * 0.62));
  const wantedHeight = Math.min(sourceHeight, Math.max(1, rect?.height || sourceHeight * 0.62));
  const { width: ratioWidth, height: ratioHeight } = parseRatioParts(ratio);
  // 先取能同时放进原选框宽高里的最大同比例尺寸，再整体按比例夹进图片。
  let width = wantedWidth;
  let height = (width * ratioHeight) / ratioWidth;
  if (height > wantedHeight) {
    height = wantedHeight;
    width = (height * ratioWidth) / ratioHeight;
  }
  const size = snapSizeToRatio(width, height, ratio, sourceWidth, sourceHeight);
  return constrainCropRect({
    x: centerX - size.width / 2,
    y: centerY - size.height / 2,
    width: size.width,
    height: size.height
  }, sourceWidth, sourceHeight);
}

/**
 * 角柄缩放（比例锁定）：对角做锚点，宽高始终满足 ratio，且不越界。
 *
 * 拖动时用位移更大的那个轴驱动，另一个轴按比例跟随 —— 手感接近原生裁剪框，
 * 又不会出现"拖了宽高比变了"的形变。
 */
export function resizeRectFromCornerLocked(sourceRect, handle, deltaX, deltaY, ratio, imageWidth, imageHeight) {
  const directionX = handle.includes("e") ? 1 : -1;
  const directionY = handle.includes("s") ? 1 : -1;
  const anchorX = directionX > 0 ? sourceRect.x : sourceRect.x + sourceRect.width;
  const anchorY = directionY > 0 ? sourceRect.y : sourceRect.y + sourceRect.height;
  const maxWidth = Math.max(1, directionX > 0 ? imageWidth - anchorX : anchorX);
  const maxHeight = Math.max(1, directionY > 0 ? imageHeight - anchorY : anchorY);
  const desiredWidth = Math.max(1, sourceRect.width + deltaX * directionX);
  const desiredHeight = Math.max(1, sourceRect.height + deltaY * directionY);
  const { width: ratioWidth, height: ratioHeight } = parseRatioParts(ratio);

  // 位移更大的轴当主导轴，避免对角线抖动时选框乱跳。
  const widthFromHeight = (desiredHeight * ratioWidth) / ratioHeight;
  const driven = Math.abs(deltaX) >= Math.abs(deltaY)
    ? Math.max(1, desiredWidth)
    : Math.max(1, widthFromHeight);
  const size = snapSizeToRatio(driven, 0, ratio, maxWidth, maxHeight);
  return {
    x: directionX > 0 ? anchorX : anchorX - size.width,
    y: directionY > 0 ? anchorY : anchorY - size.height,
    width: size.width,
    height: size.height
  };
}

/** 中心对称缩放（比例锁定，Alt 拖动）：中心不动，宽高始终满足 ratio。 */
export function resizeRectFromCenterLocked(sourceRect, handle, deltaX, deltaY, ratio, imageWidth, imageHeight) {
  const directionX = handle.includes("e") ? 1 : -1;
  const directionY = handle.includes("s") ? 1 : -1;
  const centerX = sourceRect.x + sourceRect.width / 2;
  const centerY = sourceRect.y + sourceRect.height / 2;
  const maxWidth = Math.max(1, Math.min(centerX, imageWidth - centerX) * 2);
  const maxHeight = Math.max(1, Math.min(centerY, imageHeight - centerY) * 2);
  const desiredWidth = Math.max(1, sourceRect.width + deltaX * directionX * 2);
  const desiredHeight = Math.max(1, sourceRect.height + deltaY * directionY * 2);
  const { width: ratioWidth, height: ratioHeight } = parseRatioParts(ratio);
  const widthFromHeight = (desiredHeight * ratioWidth) / ratioHeight;
  const driven = Math.abs(deltaX) >= Math.abs(deltaY)
    ? Math.max(1, desiredWidth)
    : Math.max(1, widthFromHeight);
  const size = snapSizeToRatio(driven, 0, ratio, maxWidth, maxHeight);
  return {
    x: centerX - size.width / 2,
    y: centerY - size.height / 2,
    width: size.width,
    height: size.height
  };
}

/**
 * 「区域大小」滑杆（比例锁定）：按目标宽度等比缩放当前选框，中心不动，宽高仍满足 ratio。
 * 目标宽度按图片宽度的百分比给出，和原滑杆语义一致。
 */
export function scaleRectLocked(sourceRect, targetWidth, ratio, imageWidth, imageHeight) {
  const centerX = sourceRect.x + sourceRect.width / 2;
  const centerY = sourceRect.y + sourceRect.height / 2;
  const maxWidth = Math.max(1, Math.min(centerX, imageWidth - centerX) * 2);
  const maxHeight = Math.max(1, Math.min(centerY, imageHeight - centerY) * 2);
  const size = snapSizeToRatio(Math.max(1, targetWidth), 0, ratio, maxWidth, maxHeight);
  return {
    x: centerX - size.width / 2,
    y: centerY - size.height / 2,
    width: size.width,
    height: size.height
  };
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("图片编码失败"));
    }, type, quality);
  });
}

function releaseCanvas(canvas) {
  if (!canvas) return;
  canvas.width = 0;
  canvas.height = 0;
}

/**
 * 按选框裁出局部图。输出画布尺寸 == 选框尺寸。
 *
 * @returns {{blob: Blob, rect: {x,y,width,height}, quality: number, sourceWidth: number, sourceHeight: number}}
 */
export async function cropRectToBlob(image, rect, options = {}) {
  const sourceWidth = image?.width || image?.naturalWidth || 0;
  const sourceHeight = image?.height || image?.naturalHeight || 0;
  if (!sourceWidth || !sourceHeight) throw new Error("原图尺寸不可用，无法裁剪");
  const pasteRect = constrainCropRect(rect, sourceWidth, sourceHeight);
  const qualities = Array.isArray(options.qualities) && options.qualities.length
    ? options.qualities
    : [0.98, 0.96, 0.94, 0.92];
  const targetBytes = Math.max(1, Number(options.targetBytes || 16 * 1024 * 1024));
  const mimeType = options.mimeType || "image/jpeg";

  const canvas = document.createElement("canvas");
  canvas.width = pasteRect.width;
  canvas.height = pasteRect.height;
  try {
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("无法创建裁剪画布");
    // 白底只是 alpha:false 画布的兜底；drawImage 以 1:1 铺满整块画布，不会留下白边。
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(
      image,
      pasteRect.x, pasteRect.y, pasteRect.width, pasteRect.height,
      0, 0, pasteRect.width, pasteRect.height
    );

    let best = null;
    for (const quality of qualities) {
      const blob = await canvasToBlob(canvas, mimeType, quality);
      best = { blob, quality };
      if (blob.size <= targetBytes) break;
    }
    return {
      blob: best.blob,
      quality: best.quality,
      rect: pasteRect,
      sourceWidth,
      sourceHeight
    };
  } finally {
    releaseCanvas(canvas);
  }
}

/**
 * 把模型返回的局部结果按原图坐标贴回底图。
 *
 * - 画布 = 底图完整尺寸；
 * - 唯一一次写入 = 选框矩形内；
 * - 没有羽化 / 对齐 / 颜色匹配 / 中性色调匹配 / 锐化 / 护脸护身；
 * - 选框外像素逐字节等于底图。
 *
 * @param {ImageBitmap|HTMLImageElement} baseImage 底图（完整原图）
 * @param {ImageBitmap|HTMLImageElement} generatedImage 模型返回的局部图
 * @param {{x,y,width,height}} rect 原图坐标下的选框（= 冻结快照）
 * @param {object} [options] `{ maskImage, mimeType }`；maskImage 是用户涂抹的选区（硬边裁剪）
 */
export async function composeLocalPasteBlob(baseImage, generatedImage, rect, options = {}) {
  const sourceWidth = baseImage?.width || baseImage?.naturalWidth || 0;
  const sourceHeight = baseImage?.height || baseImage?.naturalHeight || 0;
  if (!sourceWidth || !sourceHeight) throw new Error("底图尺寸不可用，无法贴回");
  const pasteRect = constrainCropRect(rect, sourceWidth, sourceHeight);
  const mimeType = options.mimeType || "image/jpeg";
  const maskImage = options.maskImage || null;

  const canvas = document.createElement("canvas");
  canvas.width = sourceWidth;
  canvas.height = sourceHeight;
  let patchCanvas = null;
  try {
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("无法创建局部回贴画布");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(baseImage, 0, 0, sourceWidth, sourceHeight);

    if (maskImage) {
      // 用户涂抹的选区：硬边，不羽化，只替换被涂到的像素。
      patchCanvas = document.createElement("canvas");
      patchCanvas.width = pasteRect.width;
      patchCanvas.height = pasteRect.height;
      const patchCtx = patchCanvas.getContext("2d");
      if (!patchCtx) throw new Error("无法创建局部融合画布");
      patchCtx.imageSmoothingEnabled = true;
      patchCtx.imageSmoothingQuality = "high";
      patchCtx.drawImage(generatedImage, 0, 0, pasteRect.width, pasteRect.height);
      patchCtx.globalCompositeOperation = "destination-in";
      patchCtx.drawImage(maskImage, 0, 0, pasteRect.width, pasteRect.height);
      patchCtx.globalCompositeOperation = "source-over";
      ctx.drawImage(patchCanvas, pasteRect.x, pasteRect.y);
    } else {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(generatedImage, pasteRect.x, pasteRect.y, pasteRect.width, pasteRect.height);
    }

    const qualities = Array.isArray(options.qualities) && options.qualities.length
      ? options.qualities
      : [0.985, 0.975, 0.965, 0.95, 0.94];
    const targetBytes = Math.max(1, Number(options.targetBytes || 64 * 1024 * 1024));
    let best = null;
    for (const quality of qualities) {
      const blob = await canvasToBlob(canvas, mimeType, quality);
      best = { blob, quality };
      if (mimeType === "image/png" || blob.size <= targetBytes) break;
    }
    return { blob: best.blob, quality: best.quality, rect: pasteRect, sourceWidth, sourceHeight };
  } finally {
    releaseCanvas(patchCanvas);
    releaseCanvas(canvas);
  }
}
