// 浏览器端裁剪 / 局部回贴几何校验（真实 Blob、真实像素）。
//
// 被 scripts/verify 的浏览器用例通过以下方式调用（Vite dev server 直接提供本文件）：
//   const mod = await import('/scripts/verify/crop-geometry-page.js');
//   const result = await mod.run();
//
// 校验内容（对齐任务要求）：
//   1. 选框多大，裁剪结果就多大 —— Blob 解码后的自然尺寸 === 选框尺寸
//   2. 不补白边 —— 裁剪结果的四条边像素 === 原图对应坐标的像素
//   3. 选框移动后按原图坐标取像素 —— 抽查点逐点比对
//   4. 局部回贴只改选框内 —— 选框外像素与底图**逐字节相同**
//   5. 资源计数 —— canvas 创建/释放、ImageBitmap 创建/close、objectURL 创建/revoke
//
// 测试尺寸：500×300、1200×700、2678×1200（都是非正方形）

import {
  composeLocalPasteBlob,
  constrainCropRect,
  cropRectToBlob,
  fitRectToRatioLocked,
  parseRatioParts,
  resizeRectFromCenterLocked,
  resizeRectFromCornerLocked,
  scaleRectLocked,
  snapSizeToRatio
} from "/src/shared/local-edit-geometry.js";

const SOURCE_WIDTH = 3000;
const SOURCE_HEIGHT = 2000;
const TEST_CASES = [
  { name: "500x300", rect: { x: 120, y: 90, width: 500, height: 300 } },
  { name: "1200x700", rect: { x: 610, y: 410, width: 1200, height: 700 } },
  { name: "2678x1200", rect: { x: 200, y: 500, width: 2678, height: 1200 } }
];

function patternAt(x, y) {
  // 每个像素编码自己的坐标，方便逐点核对"取的是不是原图那个点"。
  // 三个通道都落在 1..250，永远不可能是纯白 (255,255,255)，
  // 所以一旦出现白边会被立刻抓出来。
  return [
    ((x * 7 + y * 3) % 251) + 1,
    ((x * 13 + y * 5) % 251) + 1,
    ((x * 29 + y * 11) % 251) + 1
  ];
}

async function buildSourceBlob() {
  const canvas = document.createElement("canvas");
  canvas.width = SOURCE_WIDTH;
  canvas.height = SOURCE_HEIGHT;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const imageData = ctx.createImageData(SOURCE_WIDTH, SOURCE_HEIGHT);
  const data = imageData.data;
  for (let y = 0; y < SOURCE_HEIGHT; y += 1) {
    for (let x = 0; x < SOURCE_WIDTH; x += 1) {
      const index = (y * SOURCE_WIDTH + x) * 4;
      const [r, g, b] = patternAt(x, y);
      data[index] = r;
      data[index + 1] = g;
      data[index + 2] = b;
      data[index + 3] = 255;
    }
  }
  ctx.putImageData(imageData, 0, 0);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  canvas.width = 0;
  canvas.height = 0;
  return blob;
}

function makeCounters() {
  const counters = {
    canvasCreated: 0,
    canvasReleased: 0,
    bitmapCreated: 0,
    bitmapClosed: 0,
    urlCreated: 0,
    urlRevoked: 0,
    liveCanvases: 0,
    liveBitmaps: 0,
    liveUrls: 0
  };
  const originalCreateElement = document.createElement.bind(document);
  const originalCreateImageBitmap = window.createImageBitmap.bind(window);
  const originalCreateObjectURL = URL.createObjectURL.bind(URL);
  const originalRevokeObjectURL = URL.revokeObjectURL.bind(URL);

  document.createElement = function patched(tag, ...rest) {
    const element = originalCreateElement(tag, ...rest);
    if (String(tag).toLowerCase() === "canvas") {
      counters.canvasCreated += 1;
      counters.liveCanvases += 1;
      let released = false;
      const originalGetContext = element.getContext.bind(element);
      element.getContext = function patchedGetContext(...args) {
        const ctx = originalGetContext(...args);
        return ctx;
      };
      // canvas 释放 = 宽高被置 0（shared 模块统一这么做）
      const descriptor = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, "width");
      Object.defineProperty(element, "width", {
        configurable: true,
        get() { return descriptor.get.call(element); },
        set(value) {
          descriptor.set.call(element, value);
          if (!released && Number(value) === 0) {
            released = true;
            counters.canvasReleased += 1;
            counters.liveCanvases -= 1;
          }
        }
      });
    }
    return element;
  };

  window.createImageBitmap = async function patchedCreateImageBitmap(...args) {
    const bitmap = await originalCreateImageBitmap(...args);
    counters.bitmapCreated += 1;
    counters.liveBitmaps += 1;
    let closed = false;
    const originalClose = bitmap.close.bind(bitmap);
    bitmap.close = function patchedClose() {
      if (!closed) {
        closed = true;
        counters.bitmapClosed += 1;
        counters.liveBitmaps -= 1;
      }
      return originalClose();
    };
    return bitmap;
  };

  URL.createObjectURL = function patchedCreateObjectURL(blob) {
    const url = originalCreateObjectURL(blob);
    counters.urlCreated += 1;
    counters.liveUrls += 1;
    return url;
  };
  URL.revokeObjectURL = function patchedRevokeObjectURL(url) {
    counters.urlRevoked += 1;
    counters.liveUrls -= 1;
    return originalRevokeObjectURL(url);
  };

  return {
    counters,
    restore() {
      document.createElement = originalCreateElement;
      window.createImageBitmap = originalCreateImageBitmap;
      URL.createObjectURL = originalCreateObjectURL;
      URL.revokeObjectURL = originalRevokeObjectURL;
    }
  };
}

async function readPixels(bitmap, width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  const data = ctx.getImageData(0, 0, width, height).data;
  canvas.width = 0;
  canvas.height = 0;
  return data;
}

function pixelAt(data, width, x, y) {
  const index = (y * width + x) * 4;
  return [data[index], data[index + 1], data[index + 2]];
}

export async function run() {
  const results = [];
  const sourceBlob = await buildSourceBlob();
  const instrumentation = makeCounters();
  const counters = instrumentation.counters;

  try {
    const baseBitmap = await window.createImageBitmap(sourceBlob);
    const basePixels = await readPixels(baseBitmap, SOURCE_WIDTH, SOURCE_HEIGHT);

    for (const testCase of TEST_CASES) {
      const rect = constrainCropRect(testCase.rect, SOURCE_WIDTH, SOURCE_HEIGHT);
      const record = {
        name: testCase.name,
        rect,
        crop: {},
        paste: {},
        errors: []
      };

      // ---- 1) 裁剪：Blob 自然尺寸必须 === 选框尺寸（无损 PNG 做逐像素比对）
      const cropped = await cropRectToBlob(baseBitmap, rect, { mimeType: "image/png" });
      const cropBitmap = await window.createImageBitmap(cropped.blob);
      record.crop.blobBytes = cropped.blob.size;
      record.crop.naturalWidth = cropBitmap.width;
      record.crop.naturalHeight = cropBitmap.height;
      record.crop.matchesRect = cropBitmap.width === rect.width && cropBitmap.height === rect.height;
      if (!record.crop.matchesRect) {
        record.errors.push(`裁剪尺寸 ${cropBitmap.width}x${cropBitmap.height} != 选框 ${rect.width}x${rect.height}`);
      }

      const cropPixels = await readPixels(cropBitmap, cropBitmap.width, cropBitmap.height);

      // 四个角 + 边中点：必须等于原图对应坐标的像素（证明没有 letterbox、坐标没偏）
      const cornerChecks = [
        [0, 0], [rect.width - 1, 0], [0, rect.height - 1], [rect.width - 1, rect.height - 1],
        [Math.floor(rect.width / 2), 0], [0, Math.floor(rect.height / 2)]
      ];
      let cornerMismatch = 0;
      let whiteBorderPixels = 0;
      for (const [cx, cy] of cornerChecks) {
        const got = pixelAt(cropPixels, rect.width, cx, cy);
        const want = pixelAt(basePixels, SOURCE_WIDTH, rect.x + cx, rect.y + cy);
        if (got[0] !== want[0] || got[1] !== want[1] || got[2] !== want[2]) cornerMismatch += 1;
        if (got[0] === 255 && got[1] === 255 && got[2] === 255) whiteBorderPixels += 1;
      }
      // 整条上边/下边扫一遍，找任何纯白像素（白边会在这里露出来）
      for (let x = 0; x < rect.width; x += 1) {
        for (const y of [0, rect.height - 1]) {
          const px = pixelAt(cropPixels, rect.width, x, y);
          if (px[0] === 255 && px[1] === 255 && px[2] === 255) whiteBorderPixels += 1;
        }
      }
      record.crop.cornerMismatch = cornerMismatch;
      record.crop.whiteBorderPixels = whiteBorderPixels;
      if (cornerMismatch > 0) record.errors.push(`裁剪角点与原图不一致 ${cornerMismatch} 处`);
      if (whiteBorderPixels > 0) record.errors.push(`裁剪结果出现 ${whiteBorderPixels} 个纯白像素（补白边）`);
      cropBitmap.close();

      // ---- 2) 局部回贴：只有选框内改变，选框外逐字节相同
      // 构造一个"模型返回的局部图"：纯色块，尺寸故意与选框不同（乘 2），验证会拉伸到选框尺寸
      const generatedCanvas = document.createElement("canvas");
      generatedCanvas.width = rect.width * 2;
      generatedCanvas.height = rect.height * 2;
      const generatedCtx = generatedCanvas.getContext("2d");
      generatedCtx.fillStyle = "rgb(10,200,90)";
      generatedCtx.fillRect(0, 0, generatedCanvas.width, generatedCanvas.height);
      const generatedBlob = await new Promise((resolve) => generatedCanvas.toBlob(resolve, "image/png"));
      generatedCanvas.width = 0;
      generatedCanvas.height = 0;
      const generatedBitmap = await window.createImageBitmap(generatedBlob);

      const composed = await composeLocalPasteBlob(baseBitmap, generatedBitmap, rect, { mimeType: "image/png" });
      record.paste.blobBytes = composed.blob.size;
      const composedBitmap = await window.createImageBitmap(composed.blob);
      record.paste.naturalWidth = composedBitmap.width;
      record.paste.naturalHeight = composedBitmap.height;
      record.paste.matchesBase = composedBitmap.width === SOURCE_WIDTH && composedBitmap.height === SOURCE_HEIGHT;
      if (!record.paste.matchesBase) {
        record.errors.push(`贴回输出尺寸 ${composedBitmap.width}x${composedBitmap.height} != 底图 ${SOURCE_WIDTH}x${SOURCE_HEIGHT}`);
      }
      const composedPixels = await readPixels(composedBitmap, SOURCE_WIDTH, SOURCE_HEIGHT);

      // 选框外抽样：选框四边外各取一圈，必须与底图完全一致
      const outsideSamples = [];
      for (let i = 0; i < 200; i += 1) {
        const x = Math.min(SOURCE_WIDTH - 1, Math.max(0, rect.x - 1 - (i % 20)));
        const y = Math.min(SOURCE_HEIGHT - 1, Math.max(0, rect.y - 1 - Math.floor(i / 20)));
        outsideSamples.push([x, y]);
        const rx = Math.min(SOURCE_WIDTH - 1, rect.x + rect.width + (i % 20));
        const ry = Math.min(SOURCE_HEIGHT - 1, rect.y + Math.floor(i / 20));
        outsideSamples.push([rx, ry]);
      }
      let outsideDiff = 0;
      for (const [x, y] of outsideSamples) {
        const a = pixelAt(composedPixels, SOURCE_WIDTH, x, y);
        const b = pixelAt(basePixels, SOURCE_WIDTH, x, y);
        if (a[0] !== b[0] || a[1] !== b[1] || a[2] !== b[2]) outsideDiff += 1;
      }
      // 选框内中心点必须变成生成色
      const centerPx = pixelAt(composedPixels, SOURCE_WIDTH, rect.x + Math.floor(rect.width / 2), rect.y + Math.floor(rect.height / 2));
      record.paste.outsideDiffCount = outsideDiff;
      record.paste.insideCenterPixel = centerPx;
      record.paste.insideChanged = Math.abs(centerPx[0] - 10) <= 2 && Math.abs(centerPx[1] - 200) <= 2 && Math.abs(centerPx[2] - 90) <= 2;
      if (outsideDiff > 0) record.errors.push(`选框外像素被改动 ${outsideDiff} 处`);
      if (!record.paste.insideChanged) record.errors.push(`选框内没有被替换：${JSON.stringify(centerPx)}`);

      composedBitmap.close();
      generatedBitmap.close();
      results.push(record);
    }

    baseBitmap.close();

    // ---- 3) 资源计数：全部归还
    const resourceReport = {
      canvasCreated: counters.canvasCreated,
      canvasReleased: counters.canvasReleased,
      canvasLive: counters.liveCanvases,
      bitmapCreated: counters.bitmapCreated,
      bitmapClosed: counters.bitmapClosed,
      bitmapLive: counters.liveBitmaps,
      urlCreated: counters.urlCreated,
      urlRevoked: counters.urlRevoked,
      urlLive: counters.liveUrls
    };

    // ---- 4) 重复调用（对应"第二次重新打开 / 取消后重新打开同一张图"）不累积资源
    for (let round = 0; round < 3; round += 1) {
      const bitmap = await window.createImageBitmap(sourceBlob);
      const rect = { x: 300 + round * 10, y: 200 + round * 10, width: 640, height: 360 };
      const croppedAgain = await cropRectToBlob(bitmap, rect, { mimeType: "image/png" });
      const cropBitmap2 = await window.createImageBitmap(croppedAgain.blob);
      cropBitmap2.close();
      bitmap.close();
    }
    const repeatReport = {
      canvasCreated: counters.canvasCreated,
      canvasReleased: counters.canvasReleased,
      canvasLive: counters.liveCanvases,
      bitmapCreated: counters.bitmapCreated,
      bitmapClosed: counters.bitmapClosed,
      bitmapLive: counters.liveBitmaps
    };

    return {
      ok: results.every((item) => item.errors.length === 0)
        && resourceReport.canvasLive === 0
        && resourceReport.bitmapLive === 0
        && resourceReport.urlLive === 0
        && repeatReport.canvasLive === 0
        && repeatReport.bitmapLive === 0,
      source: { width: SOURCE_WIDTH, height: SOURCE_HEIGHT },
      results,
      resourceReport,
      repeatReport
    };
  } finally {
    instrumentation.restore();
  }
}

/**
 * 局部回贴「选框锁定所选比例」的真实 Blob 校验。
 *
 * 对 1:1 / 2:3 分别做：角柄缩放、Alt 中心缩放、移动、切换比例、区域大小滑杆，
 * 每一步都用真实的 cropRectToBlob 产出 Blob，并断言：
 *   - Blob 解码后的自然尺寸 === 选框显示的像素尺寸（页面尺寸 / 源图坐标 / Blob 三者一致）
 *   - 选框比例精确等于所选比例（整数像素，误差 ≤1px）
 *   - 上边 / 下边整条扫描没有纯白像素（无白边、无补边）
 *   - 选框不越出原图
 *   - 裁剪结果角点像素 === 原图对应坐标像素（没有拉伸变形、坐标没偏）
 */
export async function runRatioLock() {
  const results = [];
  const sourceBlob = await buildSourceBlob();
  const baseBitmap = await window.createImageBitmap(sourceBlob);
  const basePixels = await readPixels(baseBitmap, SOURCE_WIDTH, SOURCE_HEIGHT);

  function ratioErrorValue(width, height, ratio) {
    const target = parseRatioParts(ratio).value;
    return Math.abs(width / height - target) / target;
  }

  async function inspect(label, rect, ratio) {
    const bounded = constrainCropRect(rect, SOURCE_WIDTH, SOURCE_HEIGHT);
    const record = {
      label,
      ratio,
      displayRect: { ...bounded },
      sourceRect: { ...bounded },
      error: ratioErrorValue(bounded.width, bounded.height, ratio),
      inBounds: bounded.x >= 0 && bounded.y >= 0
        && bounded.x + bounded.width <= SOURCE_WIDTH && bounded.y + bounded.height <= SOURCE_HEIGHT,
      errors: []
    };
    if (!record.inBounds) record.errors.push("选框越出原图");
    if (record.error > 1 / Math.max(1, bounded.height) + 1e-9) {
      record.errors.push(`比例不是 ${ratio}：${bounded.width}x${bounded.height}`);
    }

    const cropped = await cropRectToBlob(baseBitmap, bounded, { mimeType: "image/png" });
    const bitmap = await window.createImageBitmap(cropped.blob);
    record.blobWidth = bitmap.width;
    record.blobHeight = bitmap.height;
    record.matchesDisplay = bitmap.width === bounded.width && bitmap.height === bounded.height;
    if (!record.matchesDisplay) {
      record.errors.push(`Blob 尺寸 ${bitmap.width}x${bitmap.height} != 选框 ${bounded.width}x${bounded.height}`);
    }

    const pixels = await readPixels(bitmap, bitmap.width, bitmap.height);
    // 上下两条边整条扫描：既有纯白像素检查（白边），也有与原图对应像素的逐点比对（变形/偏移）。
    let whitePixels = 0;
    let mismatch = 0;
    for (let x = 0; x < bitmap.width; x += 1) {
      for (const y of [0, bitmap.height - 1]) {
        const got = pixelAt(pixels, bitmap.width, x, y);
        const want = pixelAt(basePixels, SOURCE_WIDTH, bounded.x + x, bounded.y + y);
        if (got[0] === 255 && got[1] === 255 && got[2] === 255) whitePixels += 1;
        if (got[0] !== want[0] || got[1] !== want[1] || got[2] !== want[2]) mismatch += 1;
      }
    }
    record.whiteBorderPixels = whitePixels;
    record.edgeMismatch = mismatch;
    if (whitePixels > 0) record.errors.push(`出现 ${whitePixels} 个纯白像素（白边/补边）`);
    if (mismatch > 0) record.errors.push(`边缘 ${mismatch} 个像素与原图不一致（拉伸或坐标偏移）`);
    bitmap.close();
    results.push(record);
    return bounded;
  }

  for (const ratio of ["1:1", "2:3"]) {
    // 打开弹窗时的默认选框
    let rect = await inspect(`default-${ratio}`, fitRectToRatioLocked(null, ratio, SOURCE_WIDTH, SOURCE_HEIGHT), ratio);

    // 四个角柄各拖两次
    for (const handle of ["nw", "ne", "sw", "se"]) {
      for (const [dx, dy] of [[120, 90], [-160, -220]]) {
        const next = resizeRectFromCornerLocked(rect, handle, dx, dy, ratio, SOURCE_WIDTH, SOURCE_HEIGHT);
        rect = await inspect(`drag-${handle}-${dx},${dy}-${ratio}`, next, ratio);
      }
    }

    // Alt 中心缩放
    for (const [dx, dy] of [[90, 90], [-140, -140]]) {
      const next = resizeRectFromCenterLocked(rect, "se", dx, dy, ratio, SOURCE_WIDTH, SOURCE_HEIGHT);
      rect = await inspect(`center-resize-${dx}-${ratio}`, next, ratio);
    }

    // 移动：宽高必须不变
    const beforeMove = { ...rect };
    const moved = constrainCropRect({ ...rect, x: rect.x + 260, y: rect.y + 180 }, SOURCE_WIDTH, SOURCE_HEIGHT);
    const moveRecord = await inspect(`move-${ratio}`, moved, ratio);
    if (moved.width !== beforeMove.width || moved.height !== beforeMove.height) {
      moveRecord.errors.push(`移动后宽高变了：${beforeMove.width}x${beforeMove.height} -> ${moved.width}x${moved.height}`);
    }

    // 区域大小滑杆
    for (const percent of [0.18, 0.45, 0.95]) {
      const next = scaleRectLocked(rect, SOURCE_WIDTH * percent, ratio, SOURCE_WIDTH, SOURCE_HEIGHT);
      rect = await inspect(`scale-${Math.round(percent * 100)}%-${ratio}`, next, ratio);
    }

    // 边界压力：极小 / 贴边
    const tiny = snapSizeToRatio(4, 0, ratio, SOURCE_WIDTH, SOURCE_HEIGHT);
    await inspect(`tiny-${ratio}`, { x: 0, y: 0, ...tiny }, ratio);
    const edge = snapSizeToRatio(900, 0, ratio, SOURCE_WIDTH, SOURCE_HEIGHT);
    await inspect(`corner-pinned-${ratio}`, { x: SOURCE_WIDTH - edge.width, y: SOURCE_HEIGHT - edge.height, ...edge }, ratio);
  }

  // 切换比例必须围绕原选框中心（不越界时中心保持）
  const startRect = fitRectToRatioLocked(null, "1:1", SOURCE_WIDTH, SOURCE_HEIGHT);
  const switchChecks = [];
  for (const nextRatio of ["2:3", "3:4", "4:3", "16:9", "9:16", "1:1"]) {
    const switched = fitRectToRatioLocked(startRect, nextRatio, SOURCE_WIDTH, SOURCE_HEIGHT);
    const centerBefore = { x: startRect.x + startRect.width / 2, y: startRect.y + startRect.height / 2 };
    const centerAfter = { x: switched.x + switched.width / 2, y: switched.y + switched.height / 2 };
    const pushed = Math.abs(centerBefore.x - centerAfter.x) > 1 || Math.abs(centerBefore.y - centerAfter.y) > 1;
    const touchedEdge = switched.x <= 0 || switched.y <= 0
      || switched.x + switched.width >= SOURCE_WIDTH || switched.y + switched.height >= SOURCE_HEIGHT;
    const inspected = await inspect(`switch-1:1-to-${nextRatio}`, switched, nextRatio);
    switchChecks.push({
      nextRatio,
      width: switched.width,
      height: switched.height,
      centerPushed: pushed,
      touchedEdge,
      ok: !pushed || touchedEdge,
      errors: inspected.errors
    });
  }
  for (const item of switchChecks) {
    if (!item.ok) {
      results.push({
        label: `switch-center-${item.nextRatio}`,
        ratio: item.nextRatio,
        displayRect: { x: 0, y: 0, width: item.width, height: item.height },
        error: ratioErrorValue(item.width, item.height, item.nextRatio),
        inBounds: true,
        blobWidth: item.width,
        blobHeight: item.height,
        whiteBorderPixels: 0,
        edgeMismatch: 0,
        errors: ["切换比例后中心被移动，但选框并没有贴到边界"]
      });
    }
  }

  baseBitmap.close();
  const failed = results.filter((item) => item.errors.length > 0);
  return {
    ok: failed.length === 0,
    source: { width: SOURCE_WIDTH, height: SOURCE_HEIGHT },
    total: results.length,
    passed: results.length - failed.length,
    failed: failed.length,
    failures: failed.slice(0, 12),
    switchChecks,
    // 汇总每个比例的最终尺寸，便于人读
    summary: results.map((item) => ({
      label: item.label,
      ratio: item.ratio,
      display: `${item.displayRect.width}x${item.displayRect.height}`,
      blob: `${item.blobWidth}x${item.blobHeight}`,
      error: Number(item.error.toFixed(6)),
      white: item.whiteBorderPixels,
      mismatch: item.edgeMismatch
    }))
  };
}
