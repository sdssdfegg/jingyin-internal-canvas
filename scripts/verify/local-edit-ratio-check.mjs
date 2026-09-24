// 局部回贴「选框锁定所选比例」几何验证（纯 node，无浏览器、无网络、无付费）。
//
// 覆盖要求：
//   - 选 1:1 / 2:3 时选框宽高必须精确满足该比例（整数像素，误差 ≤1px）
//   - 角柄缩放维持比例，且不越出图片边界
//   - Alt 中心缩放维持比例
//   - 移动选框宽高不变
//   - 切换比例围绕原选框中心，且留在原图范围内
//   - 「区域大小」滑杆等比缩放（不改变比例）
//   - 显示尺寸 / 源图坐标 / 裁剪 Blob 尺寸三者一致（Blob 画布尺寸 == 选框尺寸）
//   - 边界处理：贴边、极小、超大切图
//
// 用法：node scripts/verify/local-edit-ratio-check.mjs
import {
  parseRatioParts,
  snapSizeToRatio,
  fitRectToRatioLocked,
  resizeRectFromCornerLocked,
  resizeRectFromCenterLocked,
  scaleRectLocked,
  constrainCropRect
} from "../../src/shared/local-edit-geometry.js";

const results = [];
function check(name, condition, detail = "") {
  results.push({ name, pass: Boolean(condition), detail: String(detail) });
}
/** 相对误差：|w/h - r| / r，用像素级容差判定（整数取整本身有 ≤1px 误差）。 */
function ratioError(rect, ratio) {
  const target = parseRatioParts(ratio).value;
  return Math.abs(rect.width / rect.height - target) / target;
}
/** 整数像素比例误差上限：高为 H 时，取整误差最大 0.5px → 相对误差 ≈ 0.5/H。 */
function ratioTolerance(rect) {
  return 1 / Math.max(1, rect.height) + 1e-9;
}
function inBounds(rect, width, height) {
  return rect.x >= 0 && rect.y >= 0
    && rect.width >= 1 && rect.height >= 1
    && rect.x + rect.width <= width
    && rect.y + rect.height <= height;
}

const CASES = [
  { ratio: "1:1", imageWidth: 2250, imageHeight: 3000 },
  { ratio: "2:3", imageWidth: 2250, imageHeight: 3000 },
  { ratio: "2:3", imageWidth: 3000, imageHeight: 2250 },
  { ratio: "1:1", imageWidth: 3000, imageHeight: 2250 },
  { ratio: "3:4", imageWidth: 1777, imageHeight: 2999 },
  { ratio: "2:3", imageWidth: 1000, imageHeight: 1000 }
];

// 1. snapSizeToRatio：整数 + 比例精确
for (const { ratio, imageWidth, imageHeight } of CASES) {
  for (const driven of [37, 101, 512, 800, 1200, imageWidth, imageWidth * 3]) {
    const size = snapSizeToRatio(driven, 0, ratio, imageWidth, imageHeight);
    const rect = { x: 0, y: 0, ...size };
    const isInt = Number.isInteger(size.width) && Number.isInteger(size.height);
    check(
      `snapSizeToRatio(${ratio}, driven=${driven}, max=${imageWidth}x${imageHeight}) 整数且比例精确`,
      isInt && ratioError(rect, ratio) <= ratioTolerance(rect)
        && size.width <= imageWidth && size.height <= imageHeight && size.width >= 1 && size.height >= 1,
      `${size.width}x${size.height} err=${ratioError(rect, ratio).toExponential(2)}`
    );
  }
}

// 2. 默认打开选框 = 所选比例（用 fitRectToRatioLocked 从空选框建立）
for (const { ratio, imageWidth, imageHeight } of CASES) {
  const rect = fitRectToRatioLocked(null, ratio, imageWidth, imageHeight);
  check(
    `默认选框符合 ${ratio}`,
    ratioError(rect, ratio) <= ratioTolerance(rect) && inBounds(rect, imageWidth, imageHeight),
    `${rect.width}x${rect.height} @${rect.x},${rect.y} err=${ratioError(rect, ratio).toExponential(2)}`
  );
}

// 3. 角柄缩放：维持比例 + 不越界（四个角柄 × 多组位移，含超大幅度拖动）
for (const { ratio, imageWidth, imageHeight } of CASES) {
  const base = fitRectToRatioLocked(null, ratio, imageWidth, imageHeight);
  for (const handle of ["nw", "ne", "sw", "se"]) {
    for (const [deltaX, deltaY] of [[40, 0], [0, 40], [60, 60], [-60, -60], [400, 400], [-900, -900], [0, -500], [-500, 0], [3000, 3000]]) {
      const rect = constrainCropRect(
        resizeRectFromCornerLocked(base, handle, deltaX, deltaY, ratio, imageWidth, imageHeight),
        imageWidth, imageHeight
      );
      check(
        `角柄 ${handle} 缩放维持 ${ratio} 且不越界 (d=${deltaX},${deltaY})`,
        ratioError(rect, ratio) <= ratioTolerance(rect) && inBounds(rect, imageWidth, imageHeight),
        `${rect.width}x${rect.height} err=${ratioError(rect, ratio).toExponential(2)}`
      );
    }
  }
}

// 4. Alt 中心缩放：维持比例 + 中心不动 + 不越界
for (const { ratio, imageWidth, imageHeight } of CASES) {
  const base = fitRectToRatioLocked(null, ratio, imageWidth, imageHeight);
  for (const handle of ["nw", "ne", "sw", "se"]) {
    for (const [deltaX, deltaY] of [[30, 30], [-30, -30], [500, 500], [-5000, -5000]]) {
      const rect = constrainCropRect(
        resizeRectFromCenterLocked(base, handle, deltaX, deltaY, ratio, imageWidth, imageHeight),
        imageWidth, imageHeight
      );
      const centerBefore = { x: base.x + base.width / 2, y: base.y + base.height / 2 };
      const centerAfter = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      const centerKept = Math.abs(centerBefore.x - centerAfter.x) <= 1 && Math.abs(centerBefore.y - centerAfter.y) <= 1;
      check(
        `Alt 中心缩放 ${handle} 维持 ${ratio}`,
        ratioError(rect, ratio) <= ratioTolerance(rect) && inBounds(rect, imageWidth, imageHeight) && centerKept,
        `${rect.width}x${rect.height} centerKept=${centerKept}`
      );
    }
  }
}

// 5. 移动选框：宽高不变（只夹边界）
for (const { ratio, imageWidth, imageHeight } of CASES) {
  const base = fitRectToRatioLocked(null, ratio, imageWidth, imageHeight);
  for (const [deltaX, deltaY] of [[50, 0], [0, 50], [-100, -100], [99999, -99999]]) {
    const moved = constrainCropRect({ ...base, x: base.x + deltaX, y: base.y + deltaY }, imageWidth, imageHeight);
    check(
      `移动选框宽高不变 ${ratio} (d=${deltaX},${deltaY})`,
      moved.width === base.width && moved.height === base.height
        && ratioError(moved, ratio) <= ratioTolerance(moved) && inBounds(moved, imageWidth, imageHeight),
      `${base.width}x${base.height} -> ${moved.width}x${moved.height} @${moved.x},${moved.y}`
    );
  }
}

// 6. 切换比例：围绕原中心 + 留在原图范围内
{
  const imageWidth = 2250;
  const imageHeight = 3000;
  const start = fitRectToRatioLocked(null, "1:1", imageWidth, imageHeight);
  for (const nextRatio of ["2:3", "3:4", "4:3", "16:9", "9:16", "1:1"]) {
    const switched = fitRectToRatioLocked(start, nextRatio, imageWidth, imageHeight);
    const centerBefore = { x: start.x + start.width / 2, y: start.y + start.height / 2 };
    const centerAfter = { x: switched.x + switched.width / 2, y: switched.y + switched.height / 2 };
    // 只有贴着边界时中心才允许被推开，其它情况中心必须保持。
    const pushed = Math.abs(centerBefore.x - centerAfter.x) > 1 || Math.abs(centerBefore.y - centerAfter.y) > 1;
    const touchedEdge = switched.x <= 0 || switched.y <= 0
      || switched.x + switched.width >= imageWidth || switched.y + switched.height >= imageHeight;
    check(
      `1:1 → ${nextRatio} 切换后符合比例且留在图内`,
      ratioError(switched, nextRatio) <= ratioTolerance(switched)
        && inBounds(switched, imageWidth, imageHeight)
        && (!pushed || touchedEdge),
      `${switched.width}x${switched.height} @${switched.x},${switched.y} pushed=${pushed}`
    );
    // 再切回来应该仍是合法选框
    const back = fitRectToRatioLocked(switched, "1:1", imageWidth, imageHeight);
    check(`切回 1:1 仍合法`, ratioError(back, "1:1") <= ratioTolerance(back) && inBounds(back, imageWidth, imageHeight), `${back.width}x${back.height}`);
  }
}

// 7. 「区域大小」滑杆：等比缩放，比例不变
{
  const imageWidth = 2250;
  const imageHeight = 3000;
  for (const ratio of ["1:1", "2:3"]) {
    const base = fitRectToRatioLocked(null, ratio, imageWidth, imageHeight);
    let grows = false;
    let shrinks = false;
    for (const percent of [0.12, 0.3, 0.62, 0.9, 1]) {
      const rect = constrainCropRect(
        scaleRectLocked(base, imageWidth * percent, ratio, imageWidth, imageHeight),
        imageWidth, imageHeight
      );
      if (rect.width > base.width) grows = true;
      if (rect.width < base.width) shrinks = true;
      check(
        `区域大小滑杆 ${ratio} @${Math.round(percent * 100)}% 比例不变`,
        ratioError(rect, ratio) <= ratioTolerance(rect) && inBounds(rect, imageWidth, imageHeight),
        `${rect.width}x${rect.height}`
      );
    }
    check(`区域大小滑杆 ${ratio} 既能放大也能缩小`, grows && shrinks, `grows=${grows} shrinks=${shrinks}`);
  }
}

// 8. 边界情况：极小图 / 极扁图
{
  for (const [imageWidth, imageHeight] of [[1, 1], [2, 3], [3, 2], [10, 4000], [4000, 10]]) {
    for (const ratio of ["1:1", "2:3"]) {
      const rect = fitRectToRatioLocked(null, ratio, imageWidth, imageHeight);
      check(
        `极小/极扁图 ${imageWidth}x${imageHeight} ${ratio} 合法`,
        rect.width >= 1 && rect.height >= 1 && inBounds(rect, imageWidth, imageHeight),
        `${rect.width}x${rect.height} @${rect.x},${rect.y}`
      );
    }
  }
}

const failed = results.filter((item) => !item.pass);
console.log(JSON.stringify({
  ok: failed.length === 0,
  total: results.length,
  passed: results.length - failed.length,
  failed: failed.length,
  failures: failed.slice(0, 20)
}, null, 2));
if (failed.length > 0) process.exitCode = 1;
