// 浏览器侧探针：验证「局部回贴的**裁剪源**与**贴回底图**是同一张原图」。
//
// 事故背景（2026-09-26 批量局部回贴）：
//   上传图片对象上挂着两份文件：
//     - `originalFile`：用户上传的原图（这次事故里是 2334×3500，长边 3500）；
//     - `file`：送中转渠道的**上传副本**。原图 >4MB 时会被压到长边 3072 并重新编码
//       （`src/outfit-workflow.jsx` 的 `compressOriginalImageFile` / `CHANNEL_UPLOAD_MAX_SIDE`）。
//   选框 UI、选框裁剪、诊断快照都按 `originalFile` 的像素坐标算，但贴回底图当时用的是
//   「上传副本优先」的 `imageItemUploadFile()`，于是 3500 空间里的选框被贴到 3072 画布上：
//   输出尺寸掉到 2049×3072（真实产物尺寸）、补丁相对底图放大约 1.14 倍并偏移。
//
// 本探针用**真实 Blob / 真实画布**跑同一条链路（不改生产代码、不联网、不扣费）：
//   1. `resolveLocalEditBaseFile()` 必须返回 `originalFile`（取不到才退回上传副本）
//   2. 裁剪内容必须取自**原图坐标**（错用副本会取到被夹到边界的另一块区域）
//   3. 贴回底图 = 原图 → 输出尺寸 = 原图尺寸（2334×3500），不能是 2049×3072
//   4. 选框外像素与底图逐点相同；选框内像素与补丁逐点相同（贴回就是贴回）
//   5. 反例：如果错用上传副本当底图，输出必然是 2049×3072
//      —— 证明第 3/4 条断言真的抓得住这次事故，而不是恒真
//
// 由 scripts/verify/local-edit-base-file-check.mjs 在页面里 import 并调用 `run()`。

import {
  composeLocalPasteBlob,
  cropRectToBlob,
  resolveLocalEditBaseFile
} from "/src/shared/local-edit-geometry.js";

const SOURCE_WIDTH = 2334;
const SOURCE_HEIGHT = 3500;
// 与 src/outfit-workflow.jsx 的 CHANNEL_UPLOAD_MAX_SIDE 对齐（node 侧脚本会断言它没变）。
const UPLOAD_MAX_SIDE = 3072;
// 3500 空间里的 3:4 选框（和用户实际用的形态一致）。
const RECT = { x: 500, y: 1200, width: 1200, height: 1600 };

/** 每个像素编码自身坐标：任何"取错区域 / 被缩放"都会立刻体现为像素不等。 */
function sourceChannelAt(x, y, channel) {
  return ((x * (channel === 0 ? 7 : channel === 1 ? 13 : 29) + y * (channel === 0 ? 3 : channel === 1 ? 5 : 11)) % 251) + 1;
}

function patchChannelAt(x, y, channel) {
  return 250 - sourceChannelAt(x, y, channel);
}

function scaledSize(width, height, maxSide) {
  const scale = Math.min(1, maxSide / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale))
  };
}

function makeCanvas(width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function releaseCanvas(canvas) {
  if (!canvas) return;
  canvas.width = 0;
  canvas.height = 0;
}

function canvasToBlob(canvas, type = "image/png") {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("画布编码失败"))), type);
  });
}

function fillPattern(canvas, width, height, channelAt) {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const imageData = ctx.createImageData(width, height);
  const data = imageData.data;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      data[index] = channelAt(x, y, 0);
      data[index + 1] = channelAt(x, y, 1);
      data[index + 2] = channelAt(x, y, 2);
      data[index + 3] = 255;
    }
  }
  ctx.putImageData(imageData, 0, 0);
}

async function buildSourceBlob() {
  const canvas = makeCanvas(SOURCE_WIDTH, SOURCE_HEIGHT);
  try {
    fillPattern(canvas, SOURCE_WIDTH, SOURCE_HEIGHT, sourceChannelAt);
    return await canvasToBlob(canvas);
  } finally {
    releaseCanvas(canvas);
  }
}

/** 模拟「送中转渠道的上传副本」：长边压到 3072、保持比例。 */
async function buildUploadCopyBlob(sourceBlob) {
  const bitmap = await createImageBitmap(sourceBlob);
  const size = scaledSize(SOURCE_WIDTH, SOURCE_HEIGHT, UPLOAD_MAX_SIDE);
  const canvas = makeCanvas(size.width, size.height);
  try {
    const ctx = canvas.getContext("2d", { alpha: false });
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return await canvasToBlob(canvas);
  } finally {
    bitmap.close?.();
    releaseCanvas(canvas);
  }
}

/** 模型返回的"局部补丁"：尺寸 == 选框尺寸，内容与底图可区分。 */
async function buildPatchBlob(width, height) {
  const canvas = makeCanvas(width, height);
  try {
    fillPattern(canvas, width, height, patchChannelAt);
    return await canvasToBlob(canvas);
  } finally {
    releaseCanvas(canvas);
  }
}

async function readPixels(blob) {
  const bitmap = await createImageBitmap(blob);
  const canvas = makeCanvas(bitmap.width, bitmap.height);
  try {
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return { width: canvas.width, height: canvas.height, data: imageData.data };
  } finally {
    bitmap.close?.();
    releaseCanvas(canvas);
  }
}

function pixelAt(pixels, x, y) {
  if (!pixels || x < 0 || y < 0 || x >= pixels.width || y >= pixels.height) return null;
  const index = (y * pixels.width + x) * 4;
  return [pixels.data[index], pixels.data[index + 1], pixels.data[index + 2], pixels.data[index + 3]];
}

function samePixel(a, b) {
  return Boolean(a && b) && a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
}

function makeFile(blob, name) {
  return new File([blob], name, { type: blob.type || "image/png" });
}

const OUTSIDE_POINTS = [
  [10, 10],
  [SOURCE_WIDTH - 20, 300],
  [120, SOURCE_HEIGHT - 30],
  [SOURCE_WIDTH - 5, SOURCE_HEIGHT - 5],
  [RECT.x - 30, RECT.y - 30],
  [RECT.x + RECT.width + 50, RECT.y + 50],
  [RECT.x + 20, RECT.y - 40]
];

const INSIDE_POINTS = [
  [RECT.x + 5, RECT.y + 5],
  [RECT.x + RECT.width - 6, RECT.y + RECT.height - 6],
  [RECT.x + Math.floor(RECT.width / 2), RECT.y + Math.floor(RECT.height / 2)],
  [RECT.x + 300, RECT.y + 900]
];

export async function run() {
  const facts = {};
  const sourceBlob = await buildSourceBlob();
  const uploadCopyBlob = await buildUploadCopyBlob(sourceBlob);
  const sourceFile = makeFile(sourceBlob, "source_3500.png");
  const uploadCopyFile = makeFile(uploadCopyBlob, "source_upload.jpg");
  const item = { originalFile: sourceFile, file: uploadCopyFile };

  const sourcePixels = await readPixels(sourceBlob);
  const uploadPixels = await readPixels(uploadCopyBlob);
  facts.sourceSize = { width: sourcePixels.width, height: sourcePixels.height };
  facts.uploadCopySize = { width: uploadPixels.width, height: uploadPixels.height };

  // 1) 取值规则
  facts.resolvedIsOriginal = resolveLocalEditBaseFile(item) === sourceFile;
  facts.resolvedFallsBackToUpload = resolveLocalEditBaseFile({ file: uploadCopyFile }) === uploadCopyFile;
  facts.resolvedNullSafe = resolveLocalEditBaseFile(null) === null && resolveLocalEditBaseFile(undefined) === null;

  // 2) 裁剪：内容和尺寸都必须来自原图坐标
  const sourceBitmap = await createImageBitmap(sourceFile);
  const patchBlob = await buildPatchBlob(RECT.width, RECT.height);
  try {
    const crop = await cropRectToBlob(sourceBitmap, RECT, {
      mimeType: "image/png",
      targetBytes: 64 * 1024 * 1024,
      qualities: [0.98]
    });
    const cropPixels = await readPixels(crop.blob);
    facts.cropSize = { width: cropPixels.width, height: cropPixels.height };
    facts.cropSourceSize = { width: crop.sourceWidth, height: crop.sourceHeight };
    facts.cropPixelMatchesOriginal = samePixel(
      pixelAt(cropPixels, 0, 0),
      pixelAt(sourcePixels, RECT.x, RECT.y)
    );
    facts.cropPixelMatchesUploadCopy = samePixel(
      pixelAt(cropPixels, 0, 0),
      pixelAt(uploadPixels, RECT.x, RECT.y)
    );

    // 3) 贴回：底图取 resolveLocalEditBaseFile(item)（= 原图）
    const patchPixels = await readPixels(patchBlob);
    const patchBitmap = await createImageBitmap(patchBlob);
    try {
      const composed = await composeLocalPasteBlob(sourceBitmap, patchBitmap, RECT, { mimeType: "image/png" });
      const composedPixels = await readPixels(composed.blob);
      facts.composedSize = { width: composedPixels.width, height: composedPixels.height };
      facts.composedEqualsOriginalSize = composedPixels.width === SOURCE_WIDTH && composedPixels.height === SOURCE_HEIGHT;
      facts.outsidePixelsMatchOriginal = OUTSIDE_POINTS.every(([x, y]) => samePixel(
        pixelAt(composedPixels, x, y),
        pixelAt(sourcePixels, x, y)
      ));
      facts.insidePixelsMatchPatch = INSIDE_POINTS.every(([x, y]) => samePixel(
        pixelAt(composedPixels, x, y),
        pixelAt(patchPixels, x - RECT.x, y - RECT.y)
      ));
    } finally {
      patchBitmap.close?.();
    }
  } finally {
    sourceBitmap.close?.();
  }

  // 4) 反例判别力：错用上传副本当底图 → 输出只能是 2049×3072（这正是事故症状）。
  //    有了这条，"底图用错"就不可能悄悄通过上面几条断言。
  const uploadBitmap = await createImageBitmap(uploadCopyFile);
  const patchBitmapForWrongBase = await createImageBitmap(patchBlob);
  try {
    const wrong = await composeLocalPasteBlob(uploadBitmap, patchBitmapForWrongBase, RECT, { mimeType: "image/png" });
    const wrongPixels = await readPixels(wrong.blob);
    facts.wrongBaseSize = { width: wrongPixels.width, height: wrongPixels.height };
    facts.wrongBaseIsUploadCopySize = wrongPixels.width === uploadPixels.width && wrongPixels.height === uploadPixels.height;
    facts.wrongBaseDiffersFromOriginal = wrongPixels.width !== SOURCE_WIDTH || wrongPixels.height !== SOURCE_HEIGHT;
  } finally {
    uploadBitmap.close?.();
    patchBitmapForWrongBase.close?.();
  }

  return facts;
}
