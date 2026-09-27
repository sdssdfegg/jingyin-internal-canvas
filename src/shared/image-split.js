// 精修（原「批量白底图精修」）结果图「中线剪裁成两张」。
//
// 用户的工作流是「图1+图2 正反两件并列摆放，一次生成」，成品需要再拆成左右两张。
// 这里与 3.0（`main.py` 的 `white_refine_split_save_result_bytes`）保持同一套口径：
//   - 中间线 = clamp(floor(宽/2), 1, 宽-1)，纯竖切，**不补边、不改比例**；
//   - 左右各输出一张 PNG；
//   - 开关状态存在 localStorage，默认**打开**（与 3.0 的 `jingyin-white-refine-split-halves-v1` 完全一致）。
//
// 3.0 是在服务端用 Pillow 切的；V11 服务端不做图像处理（只搬字节），
// 所以这里用浏览器 canvas 切好再走既有的 `/api/save-processed-image` 保存，效果一致。

export const SPLIT_HALVES_STORAGE_KEY = "jingyin-white-refine-split-halves-v1";

/** 中线位置：与 3.0 完全一致（宽 < 2 时无法切，返回 null）。 */
export function splitHalvesBounds(width) {
  const value = Math.floor(Number(width) || 0);
  if (value < 2) return null;
  const middle = Math.max(1, Math.min(value - 1, Math.floor(value / 2)));
  return {
    width: value,
    middle,
    left: { x: 0, y: 0, width: middle },
    right: { x: middle, y: 0, width: value - middle }
  };
}

/** 开关：默认打开；只有明确存过 "0" 才算关闭（3.0 同口径）。 */
export function readSplitHalvesEnabled(storage) {
  const store = storage || (typeof localStorage !== "undefined" ? localStorage : null);
  if (!store) return true;
  let raw = null;
  try {
    raw = store.getItem(SPLIT_HALVES_STORAGE_KEY);
  } catch {
    raw = null;
  }
  return raw === null || raw === undefined ? true : raw === "1";
}

export function writeSplitHalvesEnabled(value, storage) {
  const store = storage || (typeof localStorage !== "undefined" ? localStorage : null);
  if (!store) return;
  try {
    store.setItem(SPLIT_HALVES_STORAGE_KEY, value ? "1" : "0");
  } catch {
    /* 隐私模式下写不进去：不影响本次生成 */
  }
}

function loadDrawable(source) {
  if (typeof createImageBitmap === "function" && source instanceof Blob) {
    return createImageBitmap(source, { imageOrientation: "from-image" }).catch(() => loadImageElement(source));
  }
  return loadImageElement(source);
}

function loadImageElement(source) {
  return new Promise((resolve, reject) => {
    const url = typeof source === "string" ? source : URL.createObjectURL(source);
    const image = new Image();
    image.decoding = "async";
    image.onload = () => {
      if (url !== source) URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      if (url !== source) URL.revokeObjectURL(url);
      reject(new Error("结果图读取失败，无法从中线裁切"));
    };
    image.src = url;
  });
}

function canvasToPngBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("裁切结果编码失败"));
    }, "image/png");
  });
}

/**
 * 把一张结果图中线竖切成左右两张 PNG。
 *
 * @param {string|Blob} source 结果图地址（同源 URL / data URL / blob:）或图片 Blob/File
 * @returns {Promise<{width:number, height:number, middle:number, halves: Array<{label:string, blob:Blob, width:number, height:number}>}>}
 */
export async function splitImageIntoHalves(source) {
  if (!source) throw new Error("结果图地址不可用，无法从中线裁切");
  const drawable = await loadDrawable(source);
  const width = Math.floor(drawable.width || drawable.naturalWidth || 0);
  const height = Math.floor(drawable.height || drawable.naturalHeight || 0);
  const bounds = splitHalvesBounds(width);
  if (!bounds || height < 1) {
    if (drawable.close) drawable.close();
    throw new Error("结果图尺寸无效，无法从中线裁切");
  }
  const halves = [];
  try {
    for (const [label, rect] of [["左", bounds.left], ["右", bounds.right]]) {
      const canvas = document.createElement("canvas");
      canvas.width = rect.width;
      canvas.height = height;
      try {
        const ctx = canvas.getContext("2d", { alpha: false });
        if (!ctx) throw new Error("无法创建裁切画布");
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(drawable, rect.x, 0, rect.width, height, 0, 0, rect.width, height);
        const blob = await canvasToPngBlob(canvas);
        halves.push({ label, blob, width: rect.width, height });
      } finally {
        canvas.width = 0;
        canvas.height = 0;
      }
    }
  } finally {
    if (drawable.close) drawable.close();
  }
  return { width, height, middle: bounds.middle, halves };
}

/** 两张半图存进保存目录时的文件名（服务端会再补日期序号，这里只给可读来源名）。 */
export function splitHalvesFileName(label, sourceName = "") {
  const base = String(sourceName || "").replace(/\.[a-z0-9]+$/i, "").trim();
  return `${base ? `${base}-` : ""}${label}.png`;
}
