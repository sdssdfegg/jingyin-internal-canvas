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

function ratioValue(ratio) {
  const [rawW, rawH] = String(ratio || "1:1").split(":").map((part) => Number(part));
  const w = Number.isFinite(rawW) && rawW > 0 ? rawW : 1;
  const h = Number.isFinite(rawH) && rawH > 0 ? rawH : 1;
  return w / h;
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

export function expandMaskBoundsToCropRect(bounds, imageWidth, imageHeight, ratio, options = {}) {
  if (!bounds || !imageWidth || !imageHeight) return null;
  const targetRatio = ratioValue(ratio);
  const sourceWidth = Math.max(1, Math.round(imageWidth));
  const sourceHeight = Math.max(1, Math.round(imageHeight));
  const safeBounds = {
    x: clamp(Math.round(bounds.x || 0), 0, sourceWidth - 1),
    y: clamp(Math.round(bounds.y || 0), 0, sourceHeight - 1),
    width: Math.max(1, Math.min(Math.round(bounds.width || 1), sourceWidth)),
    height: Math.max(1, Math.min(Math.round(bounds.height || 1), sourceHeight))
  };
  safeBounds.width = Math.min(safeBounds.width, sourceWidth - safeBounds.x);
  safeBounds.height = Math.min(safeBounds.height, sourceHeight - safeBounds.y);

  const padding = Math.max(
    options.minPadding ?? 44,
    Math.round(options.paddingPx ?? 48),
    Math.round(Math.max(safeBounds.width, safeBounds.height) * (options.paddingRatio ?? 0)),
    Math.round(Math.min(sourceWidth, sourceHeight) * (options.imagePaddingRatio ?? 0))
  );
  const requiredWidth = Math.min(sourceWidth, safeBounds.width + padding * 2);
  const requiredHeight = Math.min(sourceHeight, safeBounds.height + padding * 2);
  let cropWidth = requiredWidth;
  let cropHeight = requiredHeight;

  if (cropWidth / cropHeight < targetRatio) {
    cropWidth = cropHeight * targetRatio;
  } else {
    cropHeight = cropWidth / targetRatio;
  }
  if (cropWidth > sourceWidth) {
    cropWidth = sourceWidth;
    cropHeight = cropWidth / targetRatio;
  }
  if (cropHeight > sourceHeight) {
    cropHeight = sourceHeight;
    cropWidth = cropHeight * targetRatio;
  }

  cropWidth = clamp(Math.round(cropWidth), 1, sourceWidth);
  cropHeight = clamp(Math.round(cropHeight), 1, sourceHeight);
  const centerX = safeBounds.x + safeBounds.width / 2;
  const centerY = safeBounds.y + safeBounds.height / 2;
  let x = clamp(Math.round(centerX - cropWidth / 2), 0, sourceWidth - cropWidth);
  let y = clamp(Math.round(centerY - cropHeight / 2), 0, sourceHeight - cropHeight);

  const minXForBounds = clamp(safeBounds.x + safeBounds.width - cropWidth, 0, sourceWidth - cropWidth);
  const maxXForBounds = clamp(safeBounds.x, 0, sourceWidth - cropWidth);
  if (minXForBounds <= maxXForBounds) x = clamp(x, minXForBounds, maxXForBounds);

  const minYForBounds = clamp(safeBounds.y + safeBounds.height - cropHeight, 0, sourceHeight - cropHeight);
  const maxYForBounds = clamp(safeBounds.y, 0, sourceHeight - cropHeight);
  if (minYForBounds <= maxYForBounds) y = clamp(y, minYForBounds, maxYForBounds);

  return { x, y, width: cropWidth, height: cropHeight };
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
