export const LOCAL_EDIT_RECT_MODE = "rect";
export const LOCAL_EDIT_MASK_MODE = "mask";
export const LOCAL_EDIT_MASK_COLOR = "rgba(255, 255, 255, 1)";
export const LOCAL_EDIT_BRUSH_DEFAULT = 34;
export const LOCAL_EDIT_BRUSH_MIN = 8;
export const LOCAL_EDIT_BRUSH_MAX = 160;
export const LOCAL_EDIT_MASK_OPACITY_DEFAULT = 60;

export function clampLocalEditBrushSize(value) {
  return Math.round(clamp(Number(value) || LOCAL_EDIT_BRUSH_DEFAULT, LOCAL_EDIT_BRUSH_MIN, LOCAL_EDIT_BRUSH_MAX));
}

export function clampLocalEditMaskOpacity(value) {
  return Math.round(clamp(Number(value) || LOCAL_EDIT_MASK_OPACITY_DEFAULT, 10, 100));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function maskCanvasHasPaint(canvas, threshold = 10) {
  return Boolean(maskBoundsFromCanvas(canvas, threshold));
}

export function maskBoundsFromCanvas(canvas, threshold = 10) {
  if (!canvas?.width || !canvas?.height) return null;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  const { width, height } = canvas;
  const data = ctx.getImageData(0, 0, width, height).data;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const alpha = data[(y * width + x) * 4 + 3];
      if (alpha <= threshold) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }

  if (maxX < minX || maxY < minY) return null;
  return {
    x: minX,
    y: minY,
    width: maxX - minX + 1,
    height: maxY - minY + 1
  };
}

/**
 * 涂抹蒙版的包围盒 → 实际选框。
 *
 * 2026-09-25 对齐 3.0 新源码（frontend/ecommerce/src/shared/image/localPaste.ts）：
 * 3.0 的局部回贴几何是"**选框就是选区**"，贴回时唯一一次写入
 * `context.drawImage(local, rect.x, rect.y, rect.width, rect.height)`，框外像素逐字节不变。
 * 它**没有**运行版那套"包围盒 + 48px padding + 按比例外扩"的 Nl()。
 *
 * 所以这里不再做任何外扩或比例适配：
 *   - 不做 `padding = max(44, 48)` 的外扩（那是"自动扩大蒙版/选框外多送区域"）
 *   - 不按 `ratio` 重新凑比例（那是"因为比例设置自动扩展选区"）
 *   - 只把包围盒夹进图片范围内，宽高保持用户实际涂抹的像素尺寸
 *
 * 兼容性：`ratio` 与 `options` 参数保留在签名里，老调用点不用改；
 * 它们不再影响返回值。
 */
export function expandMaskBoundsToCropRect(bounds, imageWidth, imageHeight, _ratio, _options = {}) {
  if (!bounds || !imageWidth || !imageHeight) return null;
  const sourceWidth = Math.max(1, Math.round(imageWidth));
  const sourceHeight = Math.max(1, Math.round(imageHeight));
  const width = clamp(Math.round(bounds.width || 1), 1, sourceWidth);
  const height = clamp(Math.round(bounds.height || 1), 1, sourceHeight);
  const x = clamp(Math.round(bounds.x || 0), 0, sourceWidth - width);
  const y = clamp(Math.round(bounds.y || 0), 0, sourceHeight - height);
  return { x, y, width, height };
}

export function canvasToPngDataUrl(canvas) {
  return canvas?.toDataURL?.("image/png") || "";
}

export function normalizeMaskCanvas(canvas, threshold = 10) {
  if (!canvas?.width || !canvas?.height) return;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return;
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const { data } = imageData;
  for (let index = 0; index < data.length; index += 4) {
    const alpha = data[index + 3];
    if (alpha > threshold) {
      data[index] = 255;
      data[index + 1] = 255;
      data[index + 2] = 255;
      data[index + 3] = 255;
    } else {
      data[index] = 0;
      data[index + 1] = 0;
      data[index + 2] = 0;
      data[index + 3] = 0;
    }
  }
  ctx.putImageData(imageData, 0, 0);
}

export async function imageBitmapFromDataUrl(dataUrl) {
  if (!dataUrl) return null;
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  if (window.createImageBitmap) {
    try {
      return await window.createImageBitmap(blob);
    } catch {
      // Fall back to HTMLImageElement below.
    }
  }

  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("无法读取蒙版"));
    };
    image.src = url;
  });
}

export function createLocalEditAlphaMask(maskImage, cropRect, feather = 18) {
  if (!maskImage || !cropRect?.width || !cropRect?.height) return null;
  const rect = {
    x: Math.round(cropRect.x || 0),
    y: Math.round(cropRect.y || 0),
    width: Math.max(1, Math.round(cropRect.width || 1)),
    height: Math.max(1, Math.round(cropRect.height || 1))
  };
  const baseCanvas = document.createElement("canvas");
  baseCanvas.width = rect.width;
  baseCanvas.height = rect.height;
  const baseCtx = baseCanvas.getContext("2d");
  if (!baseCtx) return null;
  baseCtx.clearRect(0, 0, rect.width, rect.height);
  baseCtx.drawImage(maskImage, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height);
  normalizeMaskCanvas(baseCanvas);

  const safeFeather = Math.max(0, Math.round(feather || 0));
  if (safeFeather <= 0) return baseCanvas;

  const softCanvas = document.createElement("canvas");
  softCanvas.width = rect.width;
  softCanvas.height = rect.height;
  const softCtx = softCanvas.getContext("2d");
  if (!softCtx) return baseCanvas;
  if ("filter" in softCtx) {
    softCtx.filter = `blur(${safeFeather}px)`;
  }
  softCtx.drawImage(baseCanvas, 0, 0);
  if ("filter" in softCtx) {
    softCtx.filter = "none";
  }

  const mergedCanvas = document.createElement("canvas");
  mergedCanvas.width = rect.width;
  mergedCanvas.height = rect.height;
  const mergedCtx = mergedCanvas.getContext("2d");
  if (!mergedCtx) return baseCanvas;
  mergedCtx.drawImage(softCanvas, 0, 0);
  mergedCtx.globalCompositeOperation = "source-over";
  mergedCtx.drawImage(baseCanvas, 0, 0);
  mergedCtx.globalCompositeOperation = "source-over";
  return mergedCanvas;
}
