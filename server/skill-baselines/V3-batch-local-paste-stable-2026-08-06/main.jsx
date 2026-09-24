import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Archive,
  BookOpen,
  Box,
  Brush,
  Check,
  CheckSquare,
  ChevronLeft,
  ChevronRight,
  Copy,
  Crop,
  Download,
  Eye,
  EyeOff,
  FileText,
  Flame,
  Folder,
  FolderOpen,
  History,
  Image as ImageIcon,
  KeyRound,
  Layers,
  Library,
  Lightbulb,
  Link2,
  Loader2,
  Maximize2,
  Minus,
  MousePointer2,
  Move,
  Palette,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Scissors,
  Search,
  Settings,
  Sparkles,
  Square,
  Trash2,
  Unlink,
  Upload,
  Video,
  Wand2,
  X
} from "lucide-react";
import { DEFAULT_MODELS, IMAGE_SIZES, fileSize, formatMs, imageSourceFromResult } from "./models.js";
import OutfitWorkflow from "./outfit-workflow.jsx";
import ImageEditorPanel from "./image-editor.jsx";
import {
  LOCAL_EDIT_MASK_COLOR,
  LOCAL_EDIT_MASK_MODE,
  LOCAL_EDIT_BRUSH_DEFAULT,
  LOCAL_EDIT_MASK_OPACITY_DEFAULT,
  LOCAL_EDIT_RECT_MODE,
  canvasToPngDataUrl,
  clampLocalEditBrushSize,
  clampLocalEditMaskOpacity,
  createLocalEditAlphaMask,
  expandMaskBoundsToCropRect,
  imageBitmapFromDataUrl,
  maskBoundsFromCanvas,
  maskCanvasHasPaint,
  normalizeMaskCanvas
} from "./local-edit-mask.js";
import "./styles.css";

const STORAGE_PREFIX = import.meta.env.VITE_JINGYIN_STORAGE_PREFIX || "jingyin-internal";
const STORAGE_KEY = `${STORAGE_PREFIX}-settings-v3`;
const LEGACY_STORAGE_KEYS = STORAGE_PREFIX === "jingyin-internal" ? ["jingyin-internal-settings-v2"] : [];
const PROMPT_LIBRARY_VERSION = "v2-20260802";
const PROMPT_PRESETS_KEY = `${STORAGE_PREFIX}-prompt-library-${PROMPT_LIBRARY_VERSION}`;
const PROMPT_CATEGORIES_KEY = `${STORAGE_PREFIX}-prompt-categories-${PROMPT_LIBRARY_VERSION}`;
const PROMPT_CATEGORY_DRAG_TYPE = "application/x-jingyin-prompt-category";
const DETAIL_PRESETS_KEY = `${STORAGE_PREFIX}-detail-presets-v1`;
const DETAIL_GROUPS_KEY = `${STORAGE_PREFIX}-detail-groups-v1`;
const INFINITE_CANVAS_KEY = `${STORAGE_PREFIX}-infinite-canvases-v1`;
const HISTORY_DB_NAME = `${STORAGE_PREFIX}-history`;
const HISTORY_DB_VERSION = 1;
const HISTORY_STORE_NAME = "results";
const HISTORY_FALLBACK_KEY = `${STORAGE_PREFIX}-history-fallback-v1`;
const PUBLIC_RELEASE_MODE = import.meta.env.VITE_JINGYIN_PUBLIC_RELEASE === "1";
const PUBLIC_RELEASE_ID = import.meta.env.VITE_JINGYIN_RELEASE_ID || STORAGE_PREFIX;
const PUBLIC_RELEASE_RESET_KEY = `${STORAGE_PREFIX}-public-reset-${PUBLIC_RELEASE_ID}`;
const ACTIVE_VIEW_KEY = `${STORAGE_PREFIX}-active-view-v1`;
const CLIENT_SESSION_ID = `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const MAX_REFERENCE_FILES = 5;
const MAX_DETAIL_FILES = 6;
const MAX_REFERENCE_REWRITE_FILES = 6;
const QUICK_LOCAL_EDIT_RATIOS = ["1:1", "3:4"];
const DETAIL_ANALYSIS_MODEL = "gpt-5.4-mini";
const CHANNEL_UPLOAD_LIMIT_BYTES = 4 * 1024 * 1024;
const CHANNEL_UPLOAD_TARGET_BYTES = 3.75 * 1024 * 1024;
const CHANNEL_UPLOAD_MAX_SIDE = 3072;
const CANVAS_NODE_WIDTH = 236;
const CANVAS_NODE_HEIGHT = 260;
const CANVAS_GENERATOR_WIDTH = 286;
const CANVAS_GENERATOR_HEIGHT = 360;
const COUNT_OPTIONS = Array.from({ length: 12 }, (_, index) => index + 1);
const REFERENCE_STRENGTH_OPTIONS = Array.from({ length: 8 }, (_, index) => 30 + index * 10);
const SHOW_INFINITE_CANVAS = false;
const QUICK_LOCAL_EDIT_PROMPT_SUFFIX = [
  "局部编辑任务：当前参考图是从原图中裁剪出的局部区域。",
  "局部选区只是 AI 工作画布，不代表选区内全部内容都可以改变；只重绘用户提示词明确点名的目标内容。",
  "保持原图透视、光源、色调、清晰度、材质衔接和边缘连续。",
  "如果用户没有明确要求改脸、改头发、改五官、改表情、改妆容或改头颈，脸部、头发、脖子、皮肤、肩颈关系都必须当作保护区，不能生成第二张脸、重复五官或移动下巴。",
  "如果局部里包含裙子、衣服或面料，未被用户明确要求改变的材质事实必须沿用原图：颜色、织纹方向、颗粒大小、厚薄、垂感、光泽、高光位置、褶皱密度和缝线方向都要和周围原图连续。",
  "不要把原图面料重新设计成更光滑、更亮、更粗糙、更网格、更皮革或更写实；选区边缘约 50px 内要参考原图纹理和光影，避免面料跳变、色块断层或新增花纹。",
  "如果本次使用涂抹蒙版，未涂抹区域只是上下文参考，重点处理被涂抹区域并让边缘自然过渡。",
  "输出必须像一张可以直接贴回原图同一位置的局部替换图，不要改变整体构图，不要增加边框、文字、水印或白边。"
].join("\n");
const QUICK_LOCAL_EDIT_CONTEXT_PROMPT_SUFFIX = "系统为了稳定贴回，可能发送了比实际贴回范围更大的上下文截图；外围上下文只用于对齐头脸、发丝、肩颈、背景线条、光影和透视，不要在局部图内重新构图、移动头部或改变人物坐标。";
const QUICK_PRIMARY_LOCAL_RETOUCH_PROMPT_SUFFIX = [
  "【图1局部精修】",
  "图1已开启局部回贴，本次按局部精修理解，不按整图换装理解。",
  "只处理用户明确点名的局部目标，例如扣子、袖口、袖长、口袋、局部面料或局部污点；没有点名的脸、头发、脖子、身体、背景、裙子和整体衣身保持原图观感。",
  "图2如果存在，只作为被点名局部目标的款式/材质/颜色参考，不要把图2当成整套服装来源，也不要重绘人物、背景或整件衣服。",
  "输出必须能贴回原图同一位置，不能出现横向断层、错位碎片、第二张脸、重复五官或背景块状割裂。"
].join("\n");
const QUICK_PRIMARY_LOCAL_OUTFIT_PROMPT_SUFFIX = [
  "【图1局部换装】",
  "图1已开启局部回贴，本次按局部换装理解：图1是人物、姿态、坐标和原画面事实，图2是服装事实来源。",
  "只在当前局部选区内把图2服装真实穿到图1人物身上，不输出整张重构图，不扩展画布，不重新摆拍。",
  "保持图1人物身份、脸部、发型、头部位置、身体比例、姿态、肩颈关系、手臂手腕手指、腿脚、背景光影和选区边缘连续。",
  "图2服装的类别、版型、长度、松量、领口、袖口、扣子、拼接线、颜色、材质和可见结构是换装标准；只做真实穿着适配，不按模型审美改短、收腰、修身、瘦身或简化细节。",
  "正面、侧身、半侧身都按图1原坐标执行；下巴、脖子、肩线、躯干上下关系和人物重心不能错位。"
].join("\n");
const QUICK_GPT_LOCAL_ANCHOR_PROMPT_SUFFIX = "GPT 局部回贴：按图层逻辑执行，先锁定图1局部坐标和人物结构，再处理用户要求，未指定区域延续原图。";
const QUICK_BANANA_LOCAL_ANCHOR_PROMPT_SUFFIX = "Nano Banana 局部回贴：把图1当作姿态和坐标模板，头部、肩颈、重心、手臂、手腕、手指、腿脚、脚底接触和人物位置保持原样。";
const QUICK_BANANA2_LOCAL_ANCHOR_PROMPT_SUFFIX = "Nano Banana 2 局部回贴：短句硬锁，避免主动重构人物；无论正面、侧身还是半侧身，都不要重新摆拍、移动脖子、改变下巴位置、重画肩颈连接、重排骨架或让上下身体错位。";
const DISPLAY_IMAGE_CACHE = new Map();

const defaultState = {
  baseUrl: "",
  apiKey: "",
  model: "gpt-image",
  imageSize: "2K",
  aspectRatio: "3:4",
  n: 1,
  prompt: "把袖子改长一点点，差不多到手腕的位置",
  theme: "dark"
};

const navItems = [
  { id: "quickgen", label: "快捷生成", icon: Sparkles },
  { id: "outfit", label: "批量生成", icon: Wand2 },
  { id: "image-editor", label: "图片编辑", icon: Brush },
  { id: "resize", label: "批量改尺寸", icon: Crop },
  { id: "reference-remix", label: "参考生图", icon: Layers },
  { id: "detail-main", label: "一键详情/主图", icon: FileText },
  ...(SHOW_INFINITE_CANVAS ? [{ id: "infinite-canvas", label: "无限画布", icon: Box }] : []),
  { id: "prompts", label: "提示词助手", icon: BookOpen }
];
const ACTIVE_VIEW_IDS = new Set(navItems.filter((item) => item.id !== "prompts").map((item) => item.id));
const DEFAULT_ACTIVE_VIEW = PUBLIC_RELEASE_MODE ? "outfit" : "quickgen";

const referenceDefaults = {
  model: "gpt-image",
  imageSize: "2K",
  aspectRatio: "3:4",
  n: 1,
  strength: 60,
  element: "medium",
  composition: "light",
  scene: "medium",
  prompt: ""
};

const referenceControlOptions = [
  { value: "none", label: "不参考" },
  { value: "light", label: "轻参考" },
  { value: "medium", label: "中等参考" },
  { value: "strong", label: "重点参考" }
];

const canvasImageRoleOptions = [
  { value: "auto", label: "自动" },
  { value: "model", label: "模特图" },
  { value: "fixed", label: "固定服装" },
  { value: "reference", label: "通用参考" }
];

const canvasBatchModeOptions = [
  { value: "single", label: "单次生成" },
  { value: "by-model", label: "按模特批量" }
];

const detailDefaults = {
  workflow: "taobao-detail",
  analysisMode: "ai",
  model: "gpt-image",
  ratio: "9:16",
  imageSize: "2K",
  count: 10,
  copywriting: "need",
  richness: "simple",
  fontStyle: "heiti",
  modelMode: "use-model",
  modelPose: "regular",
  modelUsage: 4,
  reverseScreens: 2,
  lang: "中文",
  productName: "",
  productFeature: "",
  userInstruction: "",
  sellingPoints: ""
};

const workflowOptions = [
  { value: "taobao-main", label: "淘宝 / 主图" },
  { value: "taobao-detail", label: "淘宝 / 详情页" },
  { value: "tmall-detail", label: "天猫 / 详情页" },
  { value: "jd-detail", label: "京东 / 详情页" },
  { value: "douyin-detail", label: "抖音 / 详情页" },
  { value: "redbook-detail", label: "小红书 / 种草图文" },
  { value: "pdd-detail", label: "拼多多 / 详情页" },
  { value: "amazon-main", label: "亚马逊 / 主图" },
  { value: "amazon-detail", label: "亚马逊 / 详情页" },
  { value: "shein-detail", label: "SHEIN / 详情页" },
  { value: "temu-detail", label: "Temu / 详情页" }
];

const copywritingOptions = [
  { value: "need", label: "需要文案" },
  { value: "blank", label: "文案留白" },
  { value: "poster", label: "无文案纯海报" }
];

const richnessOptions = [
  { value: "simple", label: "精简" },
  { value: "balanced", label: "均衡" },
  { value: "rich", label: "丰富" }
];

const fontStyleOptions = [
  { value: "soft", label: "柔和女性" },
  { value: "heiti", label: "常用黑体" },
  { value: "modern", label: "现代杂志" },
  { value: "bold", label: "醒目电商" },
  { value: "auto", label: "自动判断" }
];

const modelModeOptions = [
  { value: "no-model", label: "无模特" },
  { value: "use-model", label: "使用模特" }
];

const modelPoseOptions = [
  { value: "regular", label: "常规姿态" },
  { value: "special", label: "特殊姿态" }
];

const themeOptions = [
  { value: "dark", label: "暗夜", colors: ["#080910", "#151522", "#10cfc4"] },
  { value: "jade", label: "柔粉", colors: ["#fff2f7", "#fffafd", "#ec6f9e"] },
  { value: "graphite", label: "米杏", colors: ["#f3e6d4", "#fff8ec", "#c98652"] },
  { value: "mist", label: "浅雾", colors: ["#f5f7fa", "#ffffff", "#0d7a76"] }
];

const promptCategories = ["全部", "常用", "批量复刻", "批量sku", "局部迁移"];

const builtinPrompts = [
  {
    id: "portrait-retouch",
    title: "人像精修",
    category: "常用",
    content: "保留人物五官、神态和身份特征，优化皮肤质感、发丝细节和服装纹理，商业摄影质感，柔和自然光，背景干净。"
  },
  {
    id: "product-retouch",
    title: "产品精修",
    category: "常用",
    content: "保留产品结构、材质、比例和关键细节，增强边缘清晰度与表面质感，干净高级的电商主图光线，画面真实。"
  },
  {
    id: "local-outfit-material-fit",
    title: "局部换装锁版型面料",
    category: "常用",
    content: [
      "局部换装任务：图1是原图，已框选局部回贴区域；图2是本次要换上的服装唯一来源。",
      "请先在内部分析图2服装的面料类别和可见材质事实，例如棉麻、帆布、牛仔、雪纺、皮革、蕾丝、网纱、针织等，以及织纹方向、颗粒大小、厚薄、垂感、光泽、高光位置、透明度、褶皱逻辑、缝线方向和边缘结构；不要输出分析文字，只把分析结果用于生成。",
      "把图2服装真实穿到图1人物局部区域内，严格保持图2的服装类别、版型、廓形、宽松/修身程度、腰身松量、肩线、领口形状、袖型、袖长、袖口、衣长、裙长、下摆宽度、开衩、扣子、拉链、口袋、拼接线、颜色、面料纹理、厚薄、垂感、反光和光泽。",
      "只允许做符合图1姿态和身体角度的真实穿着适配与自然褶皱，不能按模型审美自动美化版型；禁止把图2服装改成更收腰、更细腰、更短、更紧身、更修身、更顺滑、更亮、更薄、更厚或更完美状态。",
      "图1人物的脸、发型、头部位置、身体比例、姿势、手臂手腕手指、腿脚、背景光影和选区边缘必须保持稳定；局部结果要能自然贴回原图同一坐标，不要输出整张重构图、对比图、文字、水印或边框。"
    ].join("\n")
  },
  {
    id: "upscale",
    title: "超分",
    category: "常用",
    content: "提升图片清晰度和细节层次，去除噪点、压缩痕迹和轻微模糊，保持原图构图、人物特征、产品结构和色彩风格不变。"
  },
  {
    id: "old-photo",
    title: "老照片修复",
    category: "常用",
    content: "修复老照片划痕、褪色、污点和破损区域，增强面部细节与自然色彩，保持年代感和原始构图，不改变人物身份。"
  },
  {
    id: "classic-figure",
    title: "经典手办",
    category: "批量复刻",
    content: "把主体做成高品质经典手办展示图，保留角色特征和服装结构，材质细腻，工作室灯光，底座干净，商业级成品质感。"
  },
  {
    id: "portrait-grid",
    title: "人物九宫格",
    category: "批量复刻",
    content: "生成同一人物的九宫格头像或半身图，保持人物身份一致，变化表情、角度、动作和光线，整体风格统一，画面干净。"
  },
  {
    id: "ip-four-view",
    title: "ip四视图",
    category: "批量sku",
    content: "生成同一 IP 角色四视图，正面、侧面、背面和三分之二视角，角色设定一致，比例准确，服装与配色统一，白底展示。"
  },
  {
    id: "line-color",
    title: "线稿上色",
    category: "局部迁移",
    content: "在保留原始线稿结构和线条细节的基础上进行上色，颜色干净协调，明暗层次自然，画面完整，不改变构图。"
  }
];

function readJsonStorage(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key) || "null") || fallback;
  } catch {
    return fallback;
  }
}

function writeJsonStorage(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function removeStorageItem(key) {
  try {
    localStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

function normalizeActiveView(value) {
  return ACTIVE_VIEW_IDS.has(value) ? value : DEFAULT_ACTIVE_VIEW;
}

function loadActiveView() {
  return normalizeActiveView(readJsonStorage(ACTIVE_VIEW_KEY, DEFAULT_ACTIVE_VIEW));
}

function deleteIndexedDbSafely(name) {
  if (typeof window === "undefined" || !window.indexedDB || !name) return Promise.resolve();
  return new Promise((resolve) => {
    try {
      const request = window.indexedDB.deleteDatabase(name);
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      request.onblocked = () => resolve();
    } catch {
      resolve();
    }
  });
}

function runPublicReleaseStorageReset() {
  if (!PUBLIC_RELEASE_MODE || typeof window === "undefined" || !window.localStorage) {
    return Promise.resolve();
  }

  try {
    const resetMarker = readJsonStorage(PUBLIC_RELEASE_RESET_KEY, localStorage.getItem(PUBLIC_RELEASE_RESET_KEY));
    if (resetMarker === "done") {
      return Promise.resolve();
    }

    [
      STORAGE_KEY,
      ACTIVE_VIEW_KEY,
      PROMPT_PRESETS_KEY,
      PROMPT_CATEGORIES_KEY,
      DETAIL_PRESETS_KEY,
      DETAIL_GROUPS_KEY,
      INFINITE_CANVAS_KEY,
      "jingyin-outfit-workflow-task-history-v1",
      "jingyin-outfit-workflow-settings-v1",
      "jingyin-outfit-workflow-pages-v1",
      "jingyin-outfit-workflow-prompt-library-v1",
      "jingyin-outfit-workflow-prompt-categories-v1",
      "jingyin-outfit-workflow-prompt-library-v2-20260802",
      "jingyin-outfit-workflow-prompt-categories-v2-20260802",
      "jingyin-outfit-workflow-resize-settings-v3",
      "jingyin-outfit-workflow-resize-batch-crop-v1",
      HISTORY_FALLBACK_KEY
    ].forEach((key) => removeStorageItem(key));

    writeJsonStorage(PUBLIC_RELEASE_RESET_KEY, "done");
  } catch {
    // Public release packages should still start if storage cleanup is blocked.
  }

  return Promise.all([
    deleteIndexedDbSafely(HISTORY_DB_NAME),
    deleteIndexedDbSafely("jingyin-public-clean-20260728-history"),
    deleteIndexedDbSafely("jingyin-public-clean-history"),
    deleteIndexedDbSafely("jingyin-internal-history"),
    deleteIndexedDbSafely("jingyin-outfit-workflow-local-v1"),
    deleteIndexedDbSafely("jingyin-image-editor-v1")
  ]).then(() => undefined);
}

const publicReleaseStorageResetPromise = runPublicReleaseStorageReset();

function normalizePromptCategoryName(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 18);
}

function normalizePromptCategories(values) {
  const next = ["全部"];
  for (const value of Array.isArray(values) ? values : []) {
    const name = normalizePromptCategoryName(value);
    if (!name || name === "全部" || next.includes(name)) continue;
    next.push(name);
  }
  if (next.length === 1) next.push("常用");
  return next.slice(0, 24);
}

function loadPromptCategories() {
  const storedCategories = readJsonStorage(PROMPT_CATEGORIES_KEY, null);
  const storedPrompts = readJsonStorage(PROMPT_PRESETS_KEY, null) || [];
  const presetCategories = Array.isArray(storedPrompts)
    ? storedPrompts.map((preset) => preset?.category)
    : [];
  const base = Array.isArray(storedCategories) && storedCategories.length > 0
    ? ["全部", ...storedCategories]
    : promptCategories;
  return normalizePromptCategories([...base, ...presetCategories]);
}

function createCanvasNode(type, patch = {}) {
  const now = Date.now();
  const size = type === "generator"
    ? { w: CANVAS_GENERATOR_WIDTH, h: CANVAS_GENERATOR_HEIGHT }
    : { w: CANVAS_NODE_WIDTH, h: CANVAS_NODE_HEIGHT };
  const base = {
    id: patch.id || makeResultId(),
    type,
    title: patch.title || (type === "generator" ? "生图节点" : type === "prompt" ? "提示词节点" : type === "output" ? "输出节点" : "图片节点"),
    x: Number.isFinite(patch.x) ? patch.x : 120,
    y: Number.isFinite(patch.y) ? patch.y : 120,
    w: Number.isFinite(patch.w) ? patch.w : size.w,
    h: Number.isFinite(patch.h) ? patch.h : size.h,
    createdAt: patch.createdAt || now,
    updatedAt: now
  };

  if (type === "prompt") {
    return {
      ...base,
      text: patch.text || "输入你要生成的画面要求，连接到生图节点后会自动读取。"
    };
  }

  if (type === "generator") {
    return {
      ...base,
      params: {
        model: patch.params?.model || defaultState.model,
        imageSize: patch.params?.imageSize || defaultState.imageSize,
        aspectRatio: patch.params?.aspectRatio || defaultState.aspectRatio,
        n: clampCount(patch.params?.n || 1),
        batchMode: canvasBatchModeOptions.some((option) => option.value === patch.params?.batchMode)
          ? patch.params.batchMode
          : "single"
      },
      prompt: patch.prompt || "",
      status: patch.status || "idle",
      error: patch.error || "",
      generationMs: Number.isFinite(patch.generationMs) ? patch.generationMs : null
    };
  }

  if (type === "output") {
    return {
      ...base,
      results: Array.isArray(patch.results) ? patch.results : [],
      prompt: patch.prompt || "",
      status: patch.status || "success",
      generationMs: Number.isFinite(patch.generationMs) ? patch.generationMs : null
    };
  }

  return {
    ...base,
    result: patch.result || null,
    role: canvasImageRoleOptions.some((option) => option.value === patch.role) ? patch.role : "auto",
    prompt: patch.prompt || patch.result?.prompt || ""
  };
}

function createInfiniteCanvas(name = "") {
  const createdAt = Date.now();
  const promptNode = createCanvasNode("prompt", {
    title: "画面提示词",
    x: 80,
    y: 100,
    text: "输入本次画面的核心要求。连接图片节点后，生图节点会自动把连入图片当成参考图。"
  });
  const generatorNode = createCanvasNode("generator", {
    title: "API 生图",
    x: 420,
    y: 78
  });

  return {
    id: `canvas_${createdAt}_${Math.random().toString(36).slice(2, 7)}`,
    name: name || `画布 ${new Date(createdAt).toLocaleString("zh-CN", { hour12: false }).slice(5, 16)}`,
    createdAt,
    updatedAt: createdAt,
    nodes: [promptNode, generatorNode],
    connections: [{
      id: makeResultId(),
      fromNodeId: promptNode.id,
      toNodeId: generatorNode.id
    }]
  };
}

function normalizeCanvasNode(node, index = 0) {
  if (!node || typeof node !== "object") return null;
  const type = ["image", "prompt", "generator", "output"].includes(node.type) ? node.type : "image";
  return createCanvasNode(type, {
    ...node,
    id: String(node.id || `canvas_node_${index}`),
    x: Number(node.x),
    y: Number(node.y),
    w: Number(node.w),
    h: Number(node.h)
  });
}

function normalizeInfiniteCanvasState(raw) {
  const incoming = raw && typeof raw === "object" ? raw : {};
  const canvases = Array.isArray(incoming.canvases)
    ? incoming.canvases.map((canvas, canvasIndex) => {
        const normalizedNodes = Array.isArray(canvas?.nodes)
          ? canvas.nodes.map(normalizeCanvasNode).filter(Boolean)
          : [];
        const nodeIds = new Set(normalizedNodes.map((node) => node.id));
        const connections = Array.isArray(canvas?.connections)
          ? canvas.connections.filter((connection) => (
              connection?.fromNodeId
              && connection?.toNodeId
              && nodeIds.has(connection.fromNodeId)
              && nodeIds.has(connection.toNodeId)
            )).map((connection, index) => ({
              id: String(connection.id || `canvas_link_${canvasIndex}_${index}`),
              fromNodeId: String(connection.fromNodeId),
              toNodeId: String(connection.toNodeId)
            }))
          : [];
        return {
          id: String(canvas?.id || `canvas_${canvasIndex}_${Date.now()}`),
          name: String(canvas?.name || `画布 ${canvasIndex + 1}`),
          createdAt: Number(canvas?.createdAt || Date.now()),
          updatedAt: Number(canvas?.updatedAt || Date.now()),
          nodes: normalizedNodes.length > 0 ? normalizedNodes : createInfiniteCanvas().nodes,
          connections
        };
      }).filter(Boolean)
    : [];
  const nextCanvases = canvases.length > 0 ? canvases : [createInfiniteCanvas("默认画布")];
  const activeId = nextCanvases.some((canvas) => canvas.id === incoming.activeId)
    ? incoming.activeId
    : nextCanvases[0].id;
  return { activeId, canvases: nextCanvases };
}

function loadInfiniteCanvasState() {
  return normalizeInfiniteCanvasState(readJsonStorage(INFINITE_CANVAS_KEY, null));
}

function loadState() {
  const stored = readJsonStorage(STORAGE_KEY, null)
    || LEGACY_STORAGE_KEYS.map((key) => readJsonStorage(key, null)).find(Boolean)
    || {};
  const { baseUrl: _discardedBaseUrl, ...safeStored } = stored;
  return { ...defaultState, ...safeStored, baseUrl: defaultState.baseUrl };
}

function normalizePromptPreset(preset, index = 0) {
  const rawCategory = normalizePromptCategoryName(preset?.category);
  const category = rawCategory && rawCategory !== "全部" ? rawCategory : "常用";
  return {
    id: String(preset?.id || `prompt_${Date.now()}_${index}`),
    title: String(preset?.title || "未命名提示词").trim() || "未命名提示词",
    category,
    content: String(preset?.content || "").trim(),
    custom: Boolean(preset?.custom)
  };
}

function normalizeDetailSettings(settings = {}) {
  const next = { ...detailDefaults, ...(settings || {}) };
  next.analysisMode = "ai";
  if (next.copywriting === "light") next.copywriting = "blank";
  if (next.copywriting === "none") next.copywriting = "poster";
  next.count = clampDetailCount(next.count);
  next.modelUsage = clampDetailModelUsage(next.modelUsage);
  next.reverseScreens = clampReverseScreens(next.reverseScreens);
  return next;
}

function referenceControlText(value, target) {
  const skillMap = {
    元素: {
      none: "参考元素：不使用运营参考图里的道具、装饰、文字、品牌标识和人物身份，只保留产品图本身的商品信息。",
      light: "参考元素：只提取少量安全元素方向，例如色块、材质氛围、轻量道具类别；所有元素必须重新组合，不能照搬参考图主体。",
      medium: "参考元素：可吸收参考图中对转化有帮助的元素类别和层级，例如卖点承托物、背景材质、配色呼应；必须替换具体样式和摆放。",
      strong: "参考元素：重点学习参考图的元素策略和商业层次，但要重构道具、背景细节、文字位置和视觉符号，避免同款、商标、水印和原图文案。"
    },
    构图: {
      none: "参考构图：不沿用参考图构图，采用稳定电商构图，主体清晰、留白合理、卖点视线顺畅。",
      light: "参考构图：只轻参考画面方向和主体占比，重新安排视角、留白、前后景关系，避免相同镜头和相同版式。",
      medium: "参考构图：保留参考图的视觉节奏和主次层级，例如主体位置、卖点区域、景深关系；但重新设计裁切、角度和空间比例。",
      strong: "参考构图：重点参考参考图的转化型构图逻辑和视觉动线，但必须改变关键排版、画面比例、镜头距离和元素位置，不能复刻。"
    },
    场景主题: {
      none: "参考场景主题：不参考运营参考图场景，重新生成符合商品调性的干净电商场景。",
      light: "参考场景主题：只参考氛围方向，例如清爽、户外、居家、轻奢、专业感；场景地点和细节必须重建。",
      medium: "参考场景主题：可吸收相近使用场景和情绪价值，让商品更有代入感；但替换空间结构、背景物和光线细节。",
      strong: "参考场景主题：重点参考参考图的场景类型和消费情绪，但必须重构环境、装饰、人物关系和品牌信息，避免同图感。"
    }
  };
  return skillMap[target]?.[value] || skillMap[target]?.none || `不参考运营参考图的${target}。`;
}

function referenceStrengthText(value) {
  const strength = Math.max(30, Math.min(100, Number.parseInt(value, 10) || referenceDefaults.strength));
  const map = {
    30: "极低参考：只判断参考图是否有可用方向，主要由产品图和输入提示词主导。",
    40: "低参考：提取少量配色、氛围或运营意图，保持画面明显原创。",
    50: "轻中参考：吸收参考图的商业气质，但产品呈现、场景和构图以重新设计为主。",
    60: "中参考：保留参考图的关键视觉策略，同时重组画面层次和电商卖点表达。",
    70: "中高参考：较明显参考运营图的风格、节奏和转化逻辑，但替换关键画面细节。",
    80: "高参考：强参考运营图的视觉方向和商业表达，必须重构元素、构图、场景，避免同款感。",
    90: "极高参考：尽量靠近参考图的运营策略，但必须避开相同版式、相同背景、相同文案和品牌信息。",
    100: "满参考：最大程度吸收参考图的投放策略和视觉记忆点，同时强制重绘所有可识别细节，不能复制原图。"
  };
  return map[Math.round(strength / 10) * 10] || map[60];
}

function buildReferenceRemixPrompt(settings, productCount, styleCount) {
  const basePrompt = settings.prompt.trim() || "生成一张适合电商展示的高质量商品图，画面干净、真实、商业感强。";
  return [
    "你正在为电商运营生成一张参考改写图片。",
    `上传图片顺序说明：前 ${productCount} 张是产品图/产品主体，用于锁定商品结构、颜色、材质、比例和关键细节；后 ${styleCount} 张是运营参考图，只用于参考视觉方向。`,
    `参考值：${settings.strength}%（${referenceStrengthText(settings.strength)}）`,
    referenceControlText(settings.element, "元素"),
    referenceControlText(settings.composition, "构图"),
    referenceControlText(settings.scene, "场景主题"),
    "必须保持产品主体真实可信，不改变核心款式、结构和面料信息；不要照搬参考图里的品牌、人物身份、文字、水印、边框、排版比例或完全相同背景。",
    "如果参考图里有不适合当前产品的内容，自动舍弃，只保留有助于电商转化的视觉策略。",
    `整体提示词：${basePrompt}`
  ].join("\n");
}

function buildSmartReferencePrompt(settings) {
  const userIntent = settings.prompt.trim();
  const baseIntent = userIntent || "生成一张适合电商投放和商品展示的高质量图片，突出产品真实款式、材质、颜色、卖点和购买欲。";
  return [
    baseIntent,
    `参考策略：${settings.strength}%参考，${referenceStrengthText(settings.strength)}产品图优先级最高，参考图只用于提取运营方向。`,
    referenceControlText(settings.element, "元素"),
    referenceControlText(settings.composition, "构图"),
    referenceControlText(settings.scene, "场景主题"),
    "电商画面要求：主体清晰、商品不变形、材质纹理真实、光线柔和干净、画面有转化感；适合淘宝/抖音/小红书等平台展示。",
    "规避项：不要照搬参考图，不要出现水印、商标、乱码文字、无关人物、错误结构、夸张畸变和虚假卖点。"
  ].join("\n");
}

function loadPromptPresets() {
  const stored = readJsonStorage(PROMPT_PRESETS_KEY, null);
  if (Array.isArray(stored) && stored.length > 0) {
    return stored.map(normalizePromptPreset).filter((preset) => preset.content);
  }

  return builtinPrompts;
}

function loadDetailPresets() {
  const stored = readJsonStorage(DETAIL_PRESETS_KEY, []);
  if (!Array.isArray(stored)) return [];
  return stored
    .map((preset, index) => ({
      id: String(preset?.id || `detail_preset_${index}`),
      name: String(preset?.name || "未命名预设").trim() || "未命名预设",
      createdAt: Number(preset?.createdAt || Date.now()),
      settings: normalizeDetailSettings(preset?.settings)
    }))
    .slice(0, 30);
}

function sanitizeStoredImage(image) {
  if (!image || typeof image !== "object") return null;
  if (image.localUrl || image.archiveFile || image.type === "url") {
    return {
      type: image.type || "url",
      value: image.value || image.localUrl || "",
      ...(image.localUrl ? { localUrl: image.localUrl } : {}),
      ...(image.archiveFile ? { archiveFile: image.archiveFile } : {}),
      ...(image.archiveMime ? { archiveMime: image.archiveMime } : {})
    };
  }
  if (image.type === "b64_json") {
    return { type: "b64_json", value: "" };
  }
  return null;
}

function sanitizeDetailResultForStorage(result) {
  return {
    ...result,
    image: sanitizeStoredImage(result?.image)
  };
}

function sanitizeDetailGroupsForStorage(groups) {
  return (Array.isArray(groups) ? groups : []).map((group) => ({
    ...group,
    productFiles: [],
    referenceFiles: [],
    prompts: (group.prompts || []).map((prompt) => ({
      ...prompt,
      results: (prompt.results || []).map(sanitizeDetailResultForStorage)
    }))
  })).slice(0, 20);
}

function loadDetailGroups() {
  const stored = readJsonStorage(DETAIL_GROUPS_KEY, []);
  if (!Array.isArray(stored)) return [];
  return stored.map((group, groupIndex) => ({
    ...group,
    id: String(group?.id || `detail_group_${Date.now()}_${groupIndex}`),
    label: String(group?.label || "详情记录"),
    createdAt: Number(group?.createdAt || Date.now()),
    status: group?.status || "success",
    productFiles: [],
    referenceFiles: [],
    params: normalizeDetailSettings(group?.params || {}),
    prompts: (group?.prompts || []).map((prompt, promptIndex) => ({
      ...prompt,
      screen: Number(prompt?.screen || promptIndex + 1),
      enabled: prompt?.enabled !== false,
      status: prompt?.status === "running" ? "idle" : (prompt?.status || "idle"),
      results: (prompt?.results || []).map((result, resultIndex) => ({
        ...result,
        id: String(result?.id || `stored_detail_${groupIndex}_${promptIndex}_${resultIndex}`),
        image: sanitizeStoredImage(result?.image),
        source: "detail-main"
      }))
    }))
  })).filter((group) => group.prompts.length > 0).slice(0, 20);
}

function hydrateDetailGroupsWithHistory(groups, historyResults) {
  if (!Array.isArray(groups) || groups.length === 0 || !Array.isArray(historyResults) || historyResults.length === 0) {
    return groups;
  }
  const historyById = new Map(historyResults.map((item) => [item.id, item]));
  return groups.map((group) => ({
    ...group,
    prompts: (group.prompts || []).map((prompt) => ({
      ...prompt,
      results: (prompt.results || []).map((result) => {
        const match = historyById.get(result.id);
        if (!match) return result;
        return {
          ...result,
          ...match,
          prompt: result.prompt || match.prompt || prompt.text,
          source: "detail-main"
        };
      })
    }))
  }));
}

function openHistoryDb() {
  if (!window.indexedDB) return Promise.resolve(null);

  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(HISTORY_DB_NAME, HISTORY_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(HISTORY_STORE_NAME)) {
        db.createObjectStore(HISTORY_STORE_NAME, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function waitForTransaction(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

async function loadHistoryResults() {
  await publicReleaseStorageResetPromise;

  try {
    const response = await fetch("/api/history");
    const payload = await response.json();
    if (response.ok && payload?.ok && Array.isArray(payload.results)) {
      return payload.results.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    }
  } catch {
    // Browser-only preview can still use local history below.
  }

  try {
    const db = await openHistoryDb();
    if (!db) return readJsonStorage(HISTORY_FALLBACK_KEY, []);

    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(HISTORY_STORE_NAME, "readonly");
      const store = transaction.objectStore(HISTORY_STORE_NAME);
      const request = store.getAll();
      request.onsuccess = () => {
        resolve((request.result || []).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)));
      };
      request.onerror = () => reject(request.error);
      transaction.oncomplete = () => db.close();
      transaction.onerror = () => db.close();
    });
  } catch {
    return readJsonStorage(HISTORY_FALLBACK_KEY, []);
  }
}

async function saveHistoryResults(items) {
  if (!items?.length) return;
  try {
    const response = await fetch("/api/history", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items })
    });
    if (response.ok) return;
  } catch {
    // Fall back to browser storage below.
  }

  try {
    const db = await openHistoryDb();
    if (!db) {
      const current = readJsonStorage(HISTORY_FALLBACK_KEY, []);
      writeJsonStorage(HISTORY_FALLBACK_KEY, [...items, ...current].map((item) => ({
        ...item,
        image: sanitizeStoredImage(item.image)
      })).slice(0, 120));
      return;
    }

    const transaction = db.transaction(HISTORY_STORE_NAME, "readwrite");
    const store = transaction.objectStore(HISTORY_STORE_NAME);
    items.forEach((item) => store.put(item));
    await waitForTransaction(transaction);
    db.close();
  } catch {
    const current = readJsonStorage(HISTORY_FALLBACK_KEY, []);
    writeJsonStorage(HISTORY_FALLBACK_KEY, [...items, ...current].map((item) => ({
      ...item,
      image: sanitizeStoredImage(item.image)
    })).slice(0, 120));
  }
}

async function removeHistoryResults(ids) {
  if (!ids?.length) return;
  try {
    const response = await fetch("/api/history", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids })
    });
    if (response.ok) return;
  } catch {
    // Fall back to browser storage below.
  }

  try {
    const db = await openHistoryDb();
    if (!db) {
      const current = readJsonStorage(HISTORY_FALLBACK_KEY, []);
      writeJsonStorage(HISTORY_FALLBACK_KEY, current.filter((item) => !ids.includes(item.id)).map((item) => ({
        ...item,
        image: sanitizeStoredImage(item.image)
      })).slice(0, 120));
      return;
    }

    const transaction = db.transaction(HISTORY_STORE_NAME, "readwrite");
    const store = transaction.objectStore(HISTORY_STORE_NAME);
    ids.forEach((id) => store.delete(id));
    await waitForTransaction(transaction);
    db.close();
  } catch {
    const current = readJsonStorage(HISTORY_FALLBACK_KEY, []);
    writeJsonStorage(HISTORY_FALLBACK_KEY, current.filter((item) => !ids.includes(item.id)).map((item) => ({
      ...item,
      image: sanitizeStoredImage(item.image)
    })).slice(0, 120));
  }
}

async function clearHistoryResults() {
  try {
    const response = await fetch("/api/history", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clear: true })
    });
    if (response.ok) return;
  } catch {
    // Fall back to browser storage below.
  }

  try {
    const db = await openHistoryDb();
    if (!db) {
      removeStorageItem(HISTORY_FALLBACK_KEY);
      return;
    }

    const transaction = db.transaction(HISTORY_STORE_NAME, "readwrite");
    transaction.objectStore(HISTORY_STORE_NAME).clear();
    await waitForTransaction(transaction);
    db.close();
  } catch {
    removeStorageItem(HISTORY_FALLBACK_KEY);
  }
}

function clampCount(value) {
  return Math.max(1, Math.min(12, Number.parseInt(value, 10) || 1));
}

function clampDetailCount(value) {
  return Math.max(1, Math.min(12, Number.parseInt(value, 10) || detailDefaults.count));
}

function clampDetailModelUsage(value) {
  return Math.max(1, Math.min(12, Number.parseInt(value, 10) || detailDefaults.modelUsage));
}

function clampReverseScreens(value) {
  return Math.max(0, Math.min(4, Number.parseInt(value, 10) || 0));
}

function clampReferenceStrength(value) {
  const parsed = Number.parseInt(value, 10);
  const rounded = Math.round((Number.isFinite(parsed) ? parsed : referenceDefaults.strength) / 10) * 10;
  return Math.max(30, Math.min(100, rounded));
}

function makeResultId() {
  return `result_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function isImageFile(file) {
  return file.type.startsWith("image/") || /\.(png|jpe?g|webp|gif|bmp)$/i.test(file.name);
}

function imageFilesFromList(fileList) {
  return Array.from(fileList || []).filter(isImageFile);
}

function imageFilesFromClipboard(clipboardData) {
  const directFiles = imageFilesFromList(clipboardData?.files);
  if (directFiles.length > 0) return directFiles;

  return Array.from(clipboardData?.items || [])
    .filter((item) => item.kind === "file" && item.type?.startsWith("image/"))
    .map((item, index) => {
      const file = item.getAsFile();
      if (!file) return null;
      if (file.name) return file;
      return new File([file], `clipboard-${Date.now()}-${index + 1}.${imageExtension(file.type)}`, {
        type: file.type || "image/png",
        lastModified: Date.now()
      });
    })
    .filter(Boolean);
}

function makeQuickReferenceItem(file) {
  return {
    id: `quick_ref_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    file,
    originalFile: file,
    cropEdit: null,
    localEdit: null,
    createdAt: Date.now()
  };
}

function normalizeQuickReferenceItem(item) {
  if (!item) return null;
  if (item instanceof File) return makeQuickReferenceItem(item);
  const file = item.file || item.originalFile;
  if (!(file instanceof File)) return null;
  return {
    ...item,
    id: item.id || `quick_ref_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    file,
    originalFile: item.originalFile || file,
    cropEdit: item.cropEdit || null,
    localEdit: item.localEdit || null
  };
}

function quickReferenceOriginalFile(item) {
  return item?.originalFile || item?.file || item;
}

function quickReferenceUploadFile(item) {
  return item?.localEdit?.cropFile || item?.cropEdit?.cropFile || item?.file || item;
}

function quickReferenceHasLocalEdit(item) {
  return Boolean(item?.localEdit?.cropFile && item?.localEdit?.cropRect);
}

function quickReferenceHasCropEdit(item) {
  return Boolean(item?.cropEdit?.cropFile && item?.cropEdit?.cropRect);
}

function quickReferenceUploadFiles(items) {
  return (items || []).map(quickReferenceUploadFile).filter((file) => file instanceof File);
}

function quickReferenceRunUploadFile(item, localEditItem = null) {
  if (localEditItem?.id && item?.id === localEditItem.id) {
    return item?.localEdit?.cropFile || quickReferenceUploadFile(item);
  }
  return item?.cropEdit?.cropFile || quickReferenceOriginalFile(item);
}

function referenceMetaFromQuickItems(items, role = "reference", startIndex = 0) {
  return (items || []).map((item, index) => {
    const file = quickReferenceUploadFile(item);
    const originalFile = quickReferenceOriginalFile(item);
    return {
      name: file?.name || originalFile?.name || `reference-${startIndex + index + 1}`,
      role,
      index: startIndex + index,
      size: file?.size || 0,
      type: file?.type || "",
      lastModified: file?.lastModified || originalFile?.lastModified || 0,
      cropEdit: quickReferenceHasCropEdit(item),
      localEdit: quickReferenceHasLocalEdit(item)
    };
  });
}

function classifyQuickPrimaryLocalIntent(prompt) {
  const text = String(prompt || "").replace(/\s+/g, "");
  const localDetailTarget = /(扣子|纽扣|袖口|袖长|口袋|拉链|腰带|腰封|领口|衣领|下摆|开叉|褶皱|缝线|拼接线|局部面料|面料纹理|污点|瑕疵|修补|补丁|小细节|细节|改长一点|改短一点|去掉|去除|抹掉|补上)/.test(text);
  const strongOutfitIntent = /(换装|换衣|换衣服|穿上|穿着图2|换成图2服装|换成图2衣服|图2服装|图2衣服|整件衣服|整套衣服|整身衣服|全身换装|把衣服换成|把上衣换成|把外套换成|把风衣换成|把裙子换成|把裤子换成|把鞋子换成)/.test(text);
  const garmentReplacement = /(上衣|外套|风衣|衬衫|T恤|卫衣|毛衣|西装|连衣裙|裙子|半身裙|裤子|牛仔裤|短裤|鞋子|靴子|高跟鞋).{0,8}(换成|改成|替换成|变成)/.test(text)
    || /(换成|改成|替换成|变成).{0,8}(上衣|外套|风衣|衬衫|T恤|卫衣|毛衣|西装|连衣裙|裙子|半身裙|裤子|牛仔裤|短裤|鞋子|靴子|高跟鞋)/.test(text);
  if (localDetailTarget && !/(整件|整套|整身|全身|换装|换衣服)/.test(text)) return "retouch";
  if (strongOutfitIntent || garmentReplacement) return "outfit";
  return "retouch";
}

function promptForQuickGeneration(prompt, localEdit = null, model = "", options = {}) {
  const basePrompt = String(prompt || "").trim();
  if (!localEdit) return basePrompt;
  const suffixes = [QUICK_LOCAL_EDIT_PROMPT_SUFFIX];
  if (localEdit.contextRect) suffixes.push(QUICK_LOCAL_EDIT_CONTEXT_PROMPT_SUFFIX);
  if (options.primaryLocalEdit) {
    const localIntent = options.localIntent || classifyQuickPrimaryLocalIntent(basePrompt);
    suffixes.push(localIntent === "outfit" ? QUICK_PRIMARY_LOCAL_OUTFIT_PROMPT_SUFFIX : QUICK_PRIMARY_LOCAL_RETOUCH_PROMPT_SUFFIX);
    if (/^gpt-image$/i.test(String(model || ""))) suffixes.push(QUICK_GPT_LOCAL_ANCHOR_PROMPT_SUFFIX);
    else if (/^nano-banana2$/i.test(String(model || ""))) suffixes.push(QUICK_BANANA2_LOCAL_ANCHOR_PROMPT_SUFFIX);
    else if (/^nano-banana/i.test(String(model || ""))) suffixes.push(QUICK_BANANA_LOCAL_ANCHOR_PROMPT_SUFFIX);
  }
  return `${basePrompt}\n\n${suffixes.join("\n")}`;
}

function referenceMetaFromFiles(files, role = "reference", startIndex = 0) {
  return (files || []).map((file, index) => ({
    name: file.name || `reference-${startIndex + index + 1}`,
    role,
    index: startIndex + index,
    size: file.size || 0,
    type: file.type || "",
    lastModified: file.lastModified || 0
  }));
}

function referenceSource(reference) {
  return reference?.localUrl || reference?.url || reference?.value || "";
}

function displayImageRequestUrl(src) {
  if (!src || src.startsWith("data:") || src.startsWith("blob:")) return src;
  return /^https?:\/\//i.test(src) ? `/api/image-proxy?url=${encodeURIComponent(src)}` : src;
}

function preloadDisplayImageUrl(url) {
  if (!url || typeof Image !== "function") return Promise.resolve();
  return new Promise((resolve) => {
    const image = new Image();
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    image.onload = done;
    image.onerror = done;
    image.src = url;
    if (typeof image.decode === "function") {
      image.decode().then(done, done);
    }
  });
}

function CachedImage({ src, alt = "", className = "", style, draggable = false, role, tabIndex, onDragStart, onClick, onKeyDown, onError, loading }) {
  const [displaySrc, setDisplaySrc] = useState(() => {
    if (!src || src.startsWith("data:") || src.startsWith("blob:")) return src || "";
    const cached = DISPLAY_IMAGE_CACHE.get(src);
    return cached?.url || "";
  });

  useEffect(() => {
    let cancelled = false;
    if (!src) {
      setDisplaySrc("");
      return undefined;
    }
    if (src.startsWith("data:") || src.startsWith("blob:")) {
      setDisplaySrc(src);
      return undefined;
    }
    const cached = DISPLAY_IMAGE_CACHE.get(src);
    if (cached?.url) {
      setDisplaySrc(cached.url);
      return undefined;
    }
    const promise = cached?.promise || fetch(displayImageRequestUrl(src))
      .then((response) => {
        if (!response.ok) throw new Error(`image_cache_http_${response.status}`);
        return response.blob();
      })
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        return preloadDisplayImageUrl(url).then(() => {
          DISPLAY_IMAGE_CACHE.set(src, { url });
          return url;
        });
      });
    if (!cached?.promise) DISPLAY_IMAGE_CACHE.set(src, { promise });
    setDisplaySrc("");
    promise
      .then((url) => {
        if (!cancelled) setDisplaySrc(url);
      })
      .catch((error) => {
        DISPLAY_IMAGE_CACHE.delete(src);
        if (!cancelled) {
          setDisplaySrc(src);
          onError?.(error);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [src]);

  return (
    <img
      className={className}
      src={displaySrc || src || ""}
      alt={alt}
      style={style}
      draggable={draggable}
      role={role}
      tabIndex={tabIndex}
      onDragStart={onDragStart}
      onClick={onClick}
      onKeyDown={onKeyDown}
      loading={loading}
      onError={onError}
    />
  );
}

function ReferenceThumbTray({ references, count = 0, className = "", max = 5, onOpen, onContextMenu }) {
  const items = Array.isArray(references) ? references.filter(Boolean) : [];
  const visibleItems = items.slice(0, max);
  if (visibleItems.length === 0 && count > 0) {
    return (
      <div className={`referenceThumbTray ${className}`} title="旧记录只保存了参考图数量，没有保存缩略图">
        <span className="referenceCountPill">{count} 张参考</span>
      </div>
    );
  }
  if (visibleItems.length === 0) return null;
  return (
    <div className={`referenceThumbTray ${className}`} title={`本张图使用了 ${items.length} 张参考图`}>
      {visibleItems.map((reference, index) => {
        const src = referenceSource(reference);
        return (
          <span
            className="referenceMiniThumb"
            key={reference.id || `${reference.name}-${index}`}
            title={reference.name || `参考图 ${index + 1}`}
            onContextMenu={onContextMenu ? (event) => {
              event.preventDefault();
              event.stopPropagation();
              onContextMenu(event, reference, index, items);
            } : undefined}
          >
            {src && (
              <CachedImage
                src={src}
                alt=""
                loading="lazy"
                role={onOpen ? "button" : undefined}
                tabIndex={onOpen ? 0 : undefined}
                onClick={onOpen ? (event) => {
                  event.stopPropagation();
                  onOpen(items, index);
                } : undefined}
                onKeyDown={onOpen ? (event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    event.stopPropagation();
                    onOpen(items, index);
                  }
                } : undefined}
                onError={(event) => {
                  event.currentTarget.style.display = "none";
                  event.currentTarget.parentElement?.classList.add("missing");
                }}
              />
            )}
          </span>
        );
      })}
      {items.length > max && <span className="referenceMoreThumb">+{items.length - max}</span>}
    </div>
  );
}

function fileBaseName(filename) {
  return String(filename || "image").replace(/\.[^.]+$/, "") || "image";
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("图片压缩失败"));
    }, type, quality);
  });
}

async function imageBitmapFromFile(file) {
  if (window.createImageBitmap) {
    try {
      return await window.createImageBitmap(file, { imageOrientation: "from-image" });
    } catch {
      // Some formats are better handled by HTMLImageElement below.
    }
  }

  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("无法读取图片"));
    };
    img.src = url;
  });
}

async function imageBitmapFromBlob(blob) {
  if (window.createImageBitmap) {
    try {
      return await window.createImageBitmap(blob);
    } catch {
      // Fall back to HTMLImageElement below.
    }
  }

  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("无法读取图片"));
    };
    img.src = url;
  });
}

function ratioValue(ratio) {
  const [rawW, rawH] = String(ratio || "1:1").split(":").map((part) => Number(part));
  const w = Number.isFinite(rawW) && rawW > 0 ? rawW : 1;
  const h = Number.isFinite(rawH) && rawH > 0 ? rawH : 1;
  return w / h;
}

function constrainCropRect(rect, imageWidth, imageHeight) {
  const width = Math.max(1, Math.min(Math.round(rect.width || 1), imageWidth));
  const height = Math.max(1, Math.min(Math.round(rect.height || 1), imageHeight));
  return {
    x: Math.max(0, Math.min(Math.round(rect.x || 0), imageWidth - width)),
    y: Math.max(0, Math.min(Math.round(rect.y || 0), imageHeight - height)),
    width,
    height
  };
}

function expandLocalEditContextRect(rect, imageWidth, imageHeight) {
  const base = constrainCropRect(rect, imageWidth, imageHeight);
  if (base.width >= imageWidth * 0.92 && base.height >= imageHeight * 0.92) return base;
  const ratio = base.width / base.height;
  const margin = Math.max(32, Math.min(220, Math.round(Math.min(base.width, base.height) * 0.24)));
  let width = Math.min(imageWidth, base.width + margin * 2);
  let height = Math.round(width / ratio);
  if (height > imageHeight) {
    height = Math.min(imageHeight, base.height + margin * 2);
    width = Math.round(height * ratio);
  }
  width = Math.max(base.width, Math.min(imageWidth, Math.round(width)));
  height = Math.max(base.height, Math.min(imageHeight, Math.round(height)));
  const centerX = base.x + base.width / 2;
  const centerY = base.y + base.height / 2;
  const x = Math.max(0, Math.min(Math.round(centerX - width / 2), imageWidth - width));
  const y = Math.max(0, Math.min(Math.round(centerY - height / 2), imageHeight - height));
  const context = constrainCropRect({ x, y, width, height }, imageWidth, imageHeight);
  const expandedEnough = context.width - base.width >= 16 || context.height - base.height >= 16;
  return expandedEnough ? context : base;
}

function rectsDiffer(a, b) {
  return ["x", "y", "width", "height"].some((key) => Math.round(a?.[key] || 0) !== Math.round(b?.[key] || 0));
}

function shouldUseExactBanana2LocalCrop(model, localEdit) {
  return /^nano-banana2$/i.test(String(model || ""))
    && Boolean(localEdit?.contextRect)
    && String(localEdit?.editMode || LOCAL_EDIT_RECT_MODE) !== LOCAL_EDIT_MASK_MODE;
}

function drawImageCover(ctx, image, x, y, width, height) {
  const sourceWidth = image.width || image.naturalWidth;
  const sourceHeight = image.height || image.naturalHeight;
  if (!sourceWidth || !sourceHeight || width <= 0 || height <= 0) return;
  const sourceRatio = sourceWidth / sourceHeight;
  const targetRatio = width / height;
  let sx = 0;
  let sy = 0;
  let sw = sourceWidth;
  let sh = sourceHeight;
  if (sourceRatio > targetRatio) {
    sw = sourceHeight * targetRatio;
    sx = (sourceWidth - sw) / 2;
  } else if (sourceRatio < targetRatio) {
    sh = sourceWidth / targetRatio;
    sy = (sourceHeight - sh) / 2;
  }
  ctx.drawImage(image, sx, sy, sw, sh, x, y, width, height);
}

function createFeatherMask(width, height, feather) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx || feather <= 0) {
    ctx?.fillRect(0, 0, width, height);
    return canvas;
  }
  const imageData = ctx.createImageData(width, height);
  const data = imageData.data;
  const maxX = width - 1;
  const maxY = height - 1;
  const safeFeather = Math.max(1, feather);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      const distance = Math.min(x, y, maxX - x, maxY - y);
      const t = Math.max(0, Math.min(1, distance / safeFeather));
      const alpha = Math.round(255 * t * t * (3 - 2 * t));
      data[index] = 255;
      data[index + 1] = 255;
      data[index + 2] = 255;
      data[index + 3] = alpha;
    }
  }
  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

function localEditBoundarySamples(width, height) {
  const minSide = Math.max(1, Math.min(width, height));
  const band = Math.max(8, Math.min(28, Math.round(minSide * 0.022)));
  const stride = Math.max(4, Math.min(18, Math.round(minSide / 180)));
  const samples = [];
  for (let y = 0; y < height; y += stride) {
    for (let x = 0; x < width; x += stride) {
      const nearEdge = x < band || y < band || width - x <= band || height - y <= band;
      if (!nearEdge) continue;
      samples.push({ x, y, weight: y < band ? 2 : 1 });
    }
  }
  return samples;
}

function localEditAlignmentScore(patchData, originalData, width, height, samples, dx, dy) {
  let score = 0;
  let totalWeight = 0;
  for (const sample of samples) {
    const px = sample.x - dx;
    const py = sample.y - dy;
    if (px < 0 || py < 0 || px >= width || py >= height) continue;
    const patchIndex = (py * width + px) * 4;
    const originalIndex = (sample.y * width + sample.x) * 4;
    const weight = sample.weight || 1;
    const dr = Math.abs(patchData[patchIndex] - originalData[originalIndex]);
    const dg = Math.abs(patchData[patchIndex + 1] - originalData[originalIndex + 1]);
    const db = Math.abs(patchData[patchIndex + 2] - originalData[originalIndex + 2]);
    score += ((dr + dg + db) / 3) * weight;
    totalWeight += weight;
  }
  return totalWeight > 0 ? score / totalWeight : Number.POSITIVE_INFINITY;
}

function alignLocalEditPatchCanvas(patchCanvas, original, pasteRect, options = {}) {
  const width = patchCanvas.width;
  const height = patchCanvas.height;
  if (width < 48 || height < 48) return patchCanvas;
  const patchCtx = patchCanvas.getContext("2d");
  if (!patchCtx) return patchCanvas;
  const originalCanvas = document.createElement("canvas");
  originalCanvas.width = width;
  originalCanvas.height = height;
  const originalCtx = originalCanvas.getContext("2d");
  if (!originalCtx) return patchCanvas;
  originalCtx.drawImage(original, pasteRect.x, pasteRect.y, width, height, 0, 0, width, height);
  const patchData = patchCtx.getImageData(0, 0, width, height).data;
  const originalData = originalCtx.getImageData(0, 0, width, height).data;
  const samples = localEditBoundarySamples(width, height);
  if (!samples.length) return patchCanvas;
  const radius = Math.max(2, Math.min(10, Number(options.maxShift || 7)));
  const baseline = localEditAlignmentScore(patchData, originalData, width, height, samples, 0, 0);
  let best = { dx: 0, dy: 0, score: baseline };
  for (let dy = -radius; dy <= radius; dy += 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      if (dx === 0 && dy === 0) continue;
      const score = localEditAlignmentScore(patchData, originalData, width, height, samples, dx, dy);
      if (score < best.score) best = { dx, dy, score };
    }
  }
  if ((best.dx === 0 && best.dy === 0) || best.score + 0.8 >= baseline) return patchCanvas;
  const alignedCanvas = document.createElement("canvas");
  alignedCanvas.width = width;
  alignedCanvas.height = height;
  const alignedCtx = alignedCanvas.getContext("2d");
  if (!alignedCtx) return patchCanvas;
  alignedCtx.drawImage(patchCanvas, best.dx, best.dy);
  return alignedCanvas;
}

async function cropQuickLocalEditFile(referenceItem, cropRect, suffix = "local_edit", options = {}) {
  const originalFile = quickReferenceOriginalFile(referenceItem);
  const image = await imageBitmapFromFile(originalFile);
  try {
    const sourceWidth = image.width || image.naturalWidth;
    const sourceHeight = image.height || image.naturalHeight;
    const pasteRect = constrainCropRect(cropRect, sourceWidth, sourceHeight);
    const contextRect = options.withContext
      ? expandLocalEditContextRect(pasteRect, sourceWidth, sourceHeight)
      : pasteRect;
    const canvas = document.createElement("canvas");
    canvas.width = contextRect.width;
    canvas.height = contextRect.height;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("无法创建局部裁剪画布");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, contextRect.x, contextRect.y, contextRect.width, contextRect.height, 0, 0, contextRect.width, contextRect.height);
    const blob = await canvasToBlob(canvas, "image/jpeg", 0.92);
    return {
      file: new File([blob], `${fileBaseName(originalFile.name)}_${suffix}.jpg`, {
        type: "image/jpeg",
        lastModified: Date.now()
      }),
      cropRect: pasteRect,
      contextRect: rectsDiffer(contextRect, pasteRect) ? contextRect : null,
      sourceWidth,
      sourceHeight
    };
  } finally {
    image.close?.();
  }
}

async function composeQuickLocalEditBlob(originalFile, generatedBlob, cropRect, localEdit = null, options = {}) {
  const original = await imageBitmapFromFile(originalFile);
  const generated = await imageBitmapFromBlob(generatedBlob);
  let maskImage = null;
  try {
    const sourceWidth = original.width || original.naturalWidth;
    const sourceHeight = original.height || original.naturalHeight;
    const pasteRect = constrainCropRect(localEdit?.cropRect || cropRect, sourceWidth, sourceHeight);
    const contextRect = localEdit?.contextRect
      ? constrainCropRect(localEdit.contextRect, sourceWidth, sourceHeight)
      : pasteRect;
    const canvas = document.createElement("canvas");
    canvas.width = sourceWidth;
    canvas.height = sourceHeight;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("无法创建局部回贴画布");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(original, 0, 0, sourceWidth, sourceHeight);
    const contextCanvas = document.createElement("canvas");
    contextCanvas.width = contextRect.width;
    contextCanvas.height = contextRect.height;
    const contextCtx = contextCanvas.getContext("2d");
    if (!contextCtx) throw new Error("无法创建局部上下文画布");
    drawImageCover(contextCtx, generated, 0, 0, contextRect.width, contextRect.height);
    let patchCanvas = document.createElement("canvas");
    patchCanvas.width = pasteRect.width;
    patchCanvas.height = pasteRect.height;
    let patchCtx = patchCanvas.getContext("2d");
    if (!patchCtx) throw new Error("无法创建局部融合画布");
    const sx = Math.max(0, pasteRect.x - contextRect.x);
    const sy = Math.max(0, pasteRect.y - contextRect.y);
    patchCtx.drawImage(contextCanvas, sx, sy, pasteRect.width, pasteRect.height, 0, 0, pasteRect.width, pasteRect.height);
    if (options.autoAlign) {
      patchCanvas = alignLocalEditPatchCanvas(patchCanvas, original, pasteRect, { maxShift: options.maxShift || 7 });
      patchCtx = patchCanvas.getContext("2d");
      if (!patchCtx) throw new Error("无法创建局部对齐画布");
    }
    const isMaskEdit = localEdit?.editMode === LOCAL_EDIT_MASK_MODE && localEdit?.maskDataUrl;
    const feather = isMaskEdit
      ? Math.max(8, Math.min(64, Math.round(Math.min(pasteRect.width, pasteRect.height) * 0.035)))
      : Math.max(8, Math.min(Number(options.rectFeatherMax || 72), Math.round(Math.min(pasteRect.width, pasteRect.height) * Number(options.rectFeatherRatio || 0.08))));
    patchCtx.globalCompositeOperation = "destination-in";
    if (isMaskEdit) {
      maskImage = await imageBitmapFromDataUrl(localEdit.maskDataUrl);
      const alphaMask = createLocalEditAlphaMask(maskImage, pasteRect, feather);
      if (alphaMask) {
        patchCtx.drawImage(alphaMask, 0, 0);
      } else {
        patchCtx.drawImage(createFeatherMask(pasteRect.width, pasteRect.height, feather), 0, 0);
      }
    } else {
      patchCtx.drawImage(createFeatherMask(pasteRect.width, pasteRect.height, feather), 0, 0);
    }
    patchCtx.globalCompositeOperation = "source-over";
    ctx.drawImage(patchCanvas, pasteRect.x, pasteRect.y);
    return canvasToBlob(canvas, "image/jpeg", 0.94);
  } finally {
    original.close?.();
    generated.close?.();
    maskImage?.close?.();
  }
}

function shouldNormalizeQuickUploadForModel(model) {
  return /^nano-banana2$/i.test(String(model || ""));
}

async function compressImageForChannel(file, options = {}) {
  const forceJpeg = Boolean(options.forceJpeg);
  if (!file || (!forceJpeg && file.size <= CHANNEL_UPLOAD_LIMIT_BYTES)) {
    return { file, compressed: false, normalized: false };
  }
  const bitmap = await imageBitmapFromFile(file);
  try {
    const sourceWidth = bitmap.width || bitmap.naturalWidth;
    const sourceHeight = bitmap.height || bitmap.naturalHeight;
    if (!sourceWidth || !sourceHeight) return { file, compressed: false, normalized: false };

    let scale = Math.min(1, CHANNEL_UPLOAD_MAX_SIDE / Math.max(sourceWidth, sourceHeight));
    let bestBlob = null;
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) return { file, compressed: false, normalized: false };
    const targetBytes = CHANNEL_UPLOAD_TARGET_BYTES;
    const qualitySteps = forceJpeg
      ? [0.92, 0.88, 0.82, 0.76, 0.68, 0.58, 0.48, 0.42]
      : [0.88, 0.8, 0.72, 0.64, 0.56, 0.48, 0.42];

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const width = Math.max(1, Math.round(sourceWidth * scale));
      const height = Math.max(1, Math.round(sourceHeight * scale));
      canvas.width = width;
      canvas.height = height;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(bitmap, 0, 0, width, height);

      for (const quality of qualitySteps) {
        const blob = await canvasToBlob(canvas, "image/jpeg", quality);
        bestBlob = blob;
        if (blob.size <= targetBytes) {
          return {
            file: new File([blob], `${fileBaseName(file.name)}_upload.jpg`, {
              type: "image/jpeg",
              lastModified: Date.now()
            }),
            compressed: blob.size < file.size || file.size > CHANNEL_UPLOAD_LIMIT_BYTES,
            normalized: forceJpeg
          };
        }
      }
      scale *= 0.78;
    }

    if (!bestBlob || bestBlob.size > CHANNEL_UPLOAD_LIMIT_BYTES || (!forceJpeg && bestBlob.size >= file.size)) {
      return { file, compressed: false, normalized: false };
    }
    return {
      file: new File([bestBlob], `${fileBaseName(file.name)}_upload.jpg`, {
        type: "image/jpeg",
        lastModified: Date.now()
      }),
      compressed: bestBlob.size < file.size || file.size > CHANNEL_UPLOAD_LIMIT_BYTES,
      normalized: forceJpeg
    };
  } finally {
    bitmap.close?.();
  }
}

async function prepareImageFilesForChannel(files, options = {}) {
  const prepared = [];
  let compressedCount = 0;
  let normalizedCount = 0;
  let originalBytes = 0;
  let uploadBytes = 0;
  for (const file of files || []) {
    originalBytes += file.size || 0;
    let next;
    try {
      next = await compressImageForChannel(file, options);
    } catch {
      next = { file, compressed: false, normalized: false };
    }
    if ((next.file.size || 0) > CHANNEL_UPLOAD_LIMIT_BYTES) {
      throw new Error(`image too large, max 4MB: ${file.name}`);
    }
    if (next.compressed) compressedCount += 1;
    if (next.normalized) normalizedCount += 1;
    uploadBytes += next.file.size || 0;
    prepared.push(next.file);
  }
  return { files: prepared, compressedCount, normalizedCount, originalBytes, uploadBytes };
}

function imageExtension(type) {
  if (type?.includes("jpeg")) return "jpg";
  if (type?.includes("webp")) return "webp";
  if (type?.includes("gif")) return "gif";
  return "png";
}

function isAuthErrorMessage(message) {
  return /invalid token|unauthorized|api key|401|密钥|key 无效|key无效/i.test(String(message || ""));
}

function normalizeGenerationErrorMessage(message) {
  const text = String(message || "");
  if (/image too large|max\s*(?:2|4|10)mb|(?:2|4|10)\s*mb/i.test(text)) {
    return "上传的产品图/参考图压缩后仍超过 4MB。2K 是输出尺寸，不是上传素材大小；请删除特别大的原图后重新上传，或换成尺寸更轻的素材。";
  }
  return text;
}

function normalizeApiKeyInput(value) {
  return String(value || "")
    .replace(/^Bearer\s+/i, "")
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/[\s\u200B-\u200D\uFEFF]/g, "");
}

function DetailUploadZone({
  title,
  subtitle,
  previews,
  count,
  maxCount,
  inputRef,
  onPick,
  onAddFiles,
  onRemove,
  onPreview,
  onAssetLibrary
}) {
  function onDrop(event) {
    event.preventDefault();
    onAddFiles(event.dataTransfer.files);
  }

  return (
    <section
      className="detailUploadBox"
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDrop={onDrop}
      aria-label={title}
    >
      <header>
        <div>
          <strong>{title}</strong>
          <span>{subtitle}</span>
        </div>
        <button className="smallButton" type="button" onClick={onAssetLibrary}>
          <Folder size={14} />
          <span>素材库</span>
        </button>
      </header>
      <button className="detailDropArea" type="button" onClick={() => inputRef.current?.click()}>
        <ImageIcon size={30} />
        <b>{title}</b>
        <span>{subtitle}</span>
      </button>
      {previews.length > 0 && (
        <div className="detailThumbGrid">
          {previews.map((item, index) => (
            <div
              className="detailThumb"
              key={`${item.file.name}-${item.file.lastModified}-${index}`}
              onClick={() => onPreview?.(item)}
              role="button"
              tabIndex={0}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onPreview?.(item);
                }
              }}
            >
              <img src={item.url} alt={item.file.name} draggable={false} />
              <b>图{index + 1}</b>
              <button type="button" onClick={(event) => { event.stopPropagation(); onRemove(index); }} aria-label="移除图片">
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
      <input ref={inputRef} type="file" accept="image/*" multiple onChange={onPick} />
      <small>{count}/{maxCount}</small>
    </section>
  );
}

function defaultQuickLocalEditCrop(width, height, ratio) {
  const targetRatio = ratioValue(ratio);
  let cropWidth = width * 0.62;
  let cropHeight = cropWidth / targetRatio;
  if (cropHeight > height * 0.62) {
    cropHeight = height * 0.62;
    cropWidth = cropHeight * targetRatio;
  }
  return constrainCropRect({
    x: (width - cropWidth) / 2,
    y: (height - cropHeight) / 2,
    width: cropWidth,
    height: cropHeight
  }, width, height);
}

function QuickLocalEditThumbOverlay({ localEdit }) {
  const sourceWidth = Number(localEdit?.sourceWidth || 0);
  const sourceHeight = Number(localEdit?.sourceHeight || 0);
  const rect = localEdit?.cropRect;
  if (!sourceWidth || !sourceHeight || !rect) return null;
  const isMaskEdit = localEdit?.editMode === LOCAL_EDIT_MASK_MODE && localEdit?.maskDataUrl;
  return (
    <>
      {isMaskEdit && (
        <img className="thumbLocalMaskOverlay" src={localEdit.maskDataUrl} alt="" draggable={false} />
      )}
      <svg
        className={`thumbLocalEditOverlay ${isMaskEdit ? "mask" : "rect"}`}
        viewBox={`0 0 ${sourceWidth} ${sourceHeight}`}
        preserveAspectRatio="xMidYMid meet"
        aria-hidden="true"
      >
        <rect
          x={rect.x}
          y={rect.y}
          width={rect.width}
          height={rect.height}
          rx={Math.max(8, Math.min(sourceWidth, sourceHeight) * 0.008)}
        />
      </svg>
    </>
  );
}

function QuickLocalEditModal({ item, ratio, mode = "local", onRatioChange, onClose, onApply, onClear }) {
  const imageRef = useRef(null);
  const maskCanvasRef = useRef(null);
  const dragRef = useRef(null);
  const paintRef = useRef(null);
  const brushResizeRef = useRef(null);
  const maskInitRef = useRef("");
  const [imageUrl, setImageUrl] = useState("");
  const [imageSize, setImageSize] = useState({ width: 0, height: 0 });
  const [displaySize, setDisplaySize] = useState({ width: 0, height: 0 });
  const [cropRect, setCropRect] = useState(null);
  const [editMode, setEditMode] = useState(LOCAL_EDIT_RECT_MODE);
  const [maskTool, setMaskTool] = useState("brush");
  const [brushSize, setBrushSize] = useState(LOCAL_EDIT_BRUSH_DEFAULT);
  const [maskOpacity, setMaskOpacity] = useState(LOCAL_EDIT_MASK_OPACITY_DEFAULT);
  const [brushCursor, setBrushCursor] = useState({ x: 0, y: 0, visible: false });
  const [maskPainted, setMaskPainted] = useState(false);
  const [maskRevision, setMaskRevision] = useState(0);
  const [working, setWorking] = useState(false);
  const originalFile = quickReferenceOriginalFile(item);
  const isLocalMode = mode === "local";
  const savedEdit = isLocalMode ? item?.localEdit : item?.cropEdit;
  const isMaskMode = isLocalMode && editMode === LOCAL_EDIT_MASK_MODE;
  const activeRatio = isLocalMode
    ? (QUICK_LOCAL_EDIT_RATIOS.includes(ratio) ? ratio : QUICK_LOCAL_EDIT_RATIOS[0])
    : (savedEdit?.aspectRatio || ratio || "1:1");
  const modalTitle = isLocalMode ? "局部回贴" : "普通裁剪";
  const modalDescription = isLocalMode ? "生成后贴回原图同一坐标" : "只裁剪送入模型的参考图，不做回贴";

  useEffect(() => {
    if (!originalFile) return undefined;
    const nextUrl = URL.createObjectURL(originalFile);
    setImageUrl(nextUrl);
    return () => URL.revokeObjectURL(nextUrl);
  }, [originalFile]);

  function measureImage() {
    const image = imageRef.current;
    if (!image) return;
    setDisplaySize({
      width: image.clientWidth || 0,
      height: image.clientHeight || 0
    });
  }

  useEffect(() => {
    window.addEventListener("resize", measureImage);
    return () => window.removeEventListener("resize", measureImage);
  }, []);

  useEffect(() => {
    setEditMode(isLocalMode && savedEdit?.editMode === LOCAL_EDIT_MASK_MODE ? LOCAL_EDIT_MASK_MODE : LOCAL_EDIT_RECT_MODE);
    setMaskPainted(Boolean(isLocalMode && savedEdit?.editMode === LOCAL_EDIT_MASK_MODE && savedEdit?.maskDataUrl));
    setMaskTool("brush");
    setBrushSize(clampLocalEditBrushSize(savedEdit?.brushSize || LOCAL_EDIT_BRUSH_DEFAULT));
    setMaskOpacity(clampLocalEditMaskOpacity(savedEdit?.maskOpacity || LOCAL_EDIT_MASK_OPACITY_DEFAULT));
    setBrushCursor({ x: 0, y: 0, visible: false });
    maskInitRef.current = "";
  }, [item?.id, isLocalMode]);

  useEffect(() => {
    if (!isMaskMode) return undefined;
    function changeBrushByKeyboard(event) {
      const target = event.target;
      const isTyping = target?.tagName === "INPUT"
        || target?.tagName === "TEXTAREA"
        || target?.tagName === "SELECT"
        || target?.isContentEditable;
      if (isTyping) return;
      const isDecrease = event.key === "[" || event.code === "BracketLeft";
      const isIncrease = event.key === "]" || event.code === "BracketRight";
      if (!isDecrease && !isIncrease) return;
      event.preventDefault();
      const step = event.shiftKey ? 12 : 4;
      setBrushSize((current) => clampLocalEditBrushSize(current + (isIncrease ? step : -step)));
    }
    window.addEventListener("keydown", changeBrushByKeyboard);
    return () => window.removeEventListener("keydown", changeBrushByKeyboard);
  }, [isMaskMode]);

  useEffect(() => {
    const canvas = maskCanvasRef.current;
    if (!canvas || !isLocalMode || !imageSize.width || !imageSize.height) return;
    const initKey = `${item?.id || "item"}:${imageSize.width}x${imageSize.height}`;
    if (maskInitRef.current === initKey && canvas.width === imageSize.width && canvas.height === imageSize.height) return;
    canvas.width = imageSize.width;
    canvas.height = imageSize.height;
    const ctx = canvas.getContext("2d");
    ctx?.clearRect(0, 0, canvas.width, canvas.height);
    maskInitRef.current = initKey;

    if (savedEdit?.editMode === LOCAL_EDIT_MASK_MODE && savedEdit?.maskDataUrl) {
      const maskImage = new Image();
      maskImage.onload = () => {
        const nextCtx = canvas.getContext("2d");
        if (!nextCtx) return;
        nextCtx.clearRect(0, 0, canvas.width, canvas.height);
        nextCtx.drawImage(maskImage, 0, 0, canvas.width, canvas.height);
        normalizeMaskCanvas(canvas);
        const bounds = maskBoundsFromCanvas(canvas);
        setMaskPainted(Boolean(bounds));
        if (bounds) {
          setCropRect(expandMaskBoundsToCropRect(bounds, imageSize.width, imageSize.height, activeRatio) || savedEdit.cropRect || null);
        }
        setMaskRevision((current) => current + 1);
      };
      maskImage.src = savedEdit.maskDataUrl;
    } else {
      setMaskPainted(false);
      setMaskRevision((current) => current + 1);
    }
  }, [activeRatio, imageSize.height, imageSize.width, isLocalMode, item?.id, savedEdit?.editMode, savedEdit?.maskDataUrl]);

  useEffect(() => {
    if (!isMaskMode || !imageSize.width || !imageSize.height) return;
    const bounds = maskBoundsFromCanvas(maskCanvasRef.current);
    if (!bounds) return;
    const nextRect = expandMaskBoundsToCropRect(bounds, imageSize.width, imageSize.height, activeRatio);
    if (nextRect) setCropRect(nextRect);
  }, [activeRatio, imageSize.height, imageSize.width, isMaskMode, maskRevision]);

  function onImageLoad(event) {
    const width = event.currentTarget.naturalWidth || 1;
    const height = event.currentTarget.naturalHeight || 1;
    setImageSize({ width, height });
    const initial = savedEdit?.cropRect
      ? constrainCropRect(savedEdit.cropRect, width, height)
      : defaultQuickLocalEditCrop(width, height, activeRatio);
    setCropRect(initial);
    window.requestAnimationFrame(measureImage);
  }

  function fitRectToRatio(rect, nextRatio) {
    if (!imageSize.width || !imageSize.height) return rect;
    const targetRatio = ratioValue(nextRatio);
    const centerX = rect ? rect.x + rect.width / 2 : imageSize.width / 2;
    const centerY = rect ? rect.y + rect.height / 2 : imageSize.height / 2;
    const baseWidth = rect?.width || imageSize.width * 0.62;
    const baseHeight = rect?.height || imageSize.height * 0.62;
    let nextWidth = baseWidth;
    let nextHeight = nextWidth / targetRatio;
    if (nextHeight > baseHeight) {
      nextHeight = baseHeight;
      nextWidth = nextHeight * targetRatio;
    }
    if (nextWidth > imageSize.width) {
      nextWidth = imageSize.width;
      nextHeight = nextWidth / targetRatio;
    }
    if (nextHeight > imageSize.height) {
      nextHeight = imageSize.height;
      nextWidth = nextHeight * targetRatio;
    }
    return constrainCropRect({
      x: centerX - nextWidth / 2,
      y: centerY - nextHeight / 2,
      width: nextWidth,
      height: nextHeight
    }, imageSize.width, imageSize.height);
  }

  function chooseLocalRatio(nextRatio) {
    if (!isLocalMode || !QUICK_LOCAL_EDIT_RATIOS.includes(nextRatio)) return;
    onRatioChange?.(nextRatio);
    if (isMaskMode) {
      const bounds = maskBoundsFromCanvas(maskCanvasRef.current);
      if (bounds) {
        setCropRect(expandMaskBoundsToCropRect(bounds, imageSize.width, imageSize.height, nextRatio));
      }
      return;
    }
    setCropRect((current) => fitRectToRatio(current, nextRatio));
  }

  function chooseEditMode(nextMode) {
    if (!isLocalMode || nextMode === editMode) return;
    setEditMode(nextMode);
    if (nextMode === LOCAL_EDIT_MASK_MODE) {
      const bounds = maskBoundsFromCanvas(maskCanvasRef.current);
      setMaskPainted(Boolean(bounds));
      if (bounds) {
        setCropRect(expandMaskBoundsToCropRect(bounds, imageSize.width, imageSize.height, activeRatio));
      }
    } else if (cropRect) {
      setCropRect((current) => fitRectToRatio(current, activeRatio));
    }
  }

  function updateCropRect(nextRect) {
    setCropRect((current) => {
      const source = nextRect || current;
      if (!source || !imageSize.width || !imageSize.height) return current;
      return constrainCropRect(source, imageSize.width, imageSize.height);
    });
  }

  function beginCropDrag(event, mode) {
    if (!cropRect || !displaySize.width || !imageSize.width) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    dragRef.current = {
      mode,
      startX: event.clientX,
      startY: event.clientY,
      rect: cropRect
    };
  }

  function moveCropDrag(event) {
    const drag = dragRef.current;
    if (!drag || !cropRect || !displaySize.width || !displaySize.height) return;
    event.preventDefault();
    const scaleX = imageSize.width / Math.max(1, displaySize.width);
    const scaleY = imageSize.height / Math.max(1, displaySize.height);
    const deltaX = (event.clientX - drag.startX) * scaleX;
    const deltaY = (event.clientY - drag.startY) * scaleY;
    if (drag.mode === "move") {
      updateCropRect({
        ...drag.rect,
        x: drag.rect.x + deltaX,
        y: drag.rect.y + deltaY
      });
      return;
    }

    const targetRatio = ratioValue(activeRatio);
    const minSize = Math.max(24, Math.min(imageSize.width, imageSize.height) * 0.06);
    const desiredWidth = Math.max(minSize, drag.rect.width + deltaX);
    const desiredHeight = Math.max(minSize, drag.rect.height + deltaY);
    let nextWidth = Math.max(desiredWidth, desiredHeight * targetRatio);
    let nextHeight = nextWidth / targetRatio;
    if (drag.rect.x + nextWidth > imageSize.width) {
      nextWidth = imageSize.width - drag.rect.x;
      nextHeight = nextWidth / targetRatio;
    }
    if (drag.rect.y + nextHeight > imageSize.height) {
      nextHeight = imageSize.height - drag.rect.y;
      nextWidth = nextHeight * targetRatio;
    }
    updateCropRect({
      ...drag.rect,
      width: nextWidth,
      height: nextHeight
    });
  }

  function endCropDrag(event) {
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    dragRef.current = null;
  }

  function changeCropScale(event) {
    if (!cropRect || !imageSize.width || !imageSize.height) return;
    const percent = Number(event.target.value) / 100;
    const targetRatio = ratioValue(activeRatio);
    let nextWidth = imageSize.width * percent;
    let nextHeight = nextWidth / targetRatio;
    if (nextHeight > imageSize.height * percent) {
      nextHeight = imageSize.height * percent;
      nextWidth = nextHeight * targetRatio;
    }
    const centerX = cropRect.x + cropRect.width / 2;
    const centerY = cropRect.y + cropRect.height / 2;
    updateCropRect({
      x: centerX - nextWidth / 2,
      y: centerY - nextHeight / 2,
      width: nextWidth,
      height: nextHeight
    });
  }

  function maskPointerPoint(event) {
    const canvas = maskCanvasRef.current;
    if (!canvas || !displaySize.width || !displaySize.height || !imageSize.width || !imageSize.height) return null;
    const box = canvas.getBoundingClientRect();
    const x = Math.max(0, Math.min(imageSize.width, ((event.clientX - box.left) / Math.max(1, box.width)) * imageSize.width));
    const y = Math.max(0, Math.min(imageSize.height, ((event.clientY - box.top) / Math.max(1, box.height)) * imageSize.height));
    return { x, y };
  }

  function maskPointerDisplayPoint(event) {
    const canvas = maskCanvasRef.current;
    if (!canvas) return null;
    const box = canvas.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(box.width, event.clientX - box.left)),
      y: Math.max(0, Math.min(box.height, event.clientY - box.top))
    };
  }

  function updateBrushCursor(event, visible = true) {
    const point = maskPointerDisplayPoint(event);
    if (!point) return;
    setBrushCursor({ ...point, visible });
  }

  function sourceBrushSize() {
    if (!displaySize.width || !displaySize.height) return brushSize;
    const scaleX = imageSize.width / Math.max(1, displaySize.width);
    const scaleY = imageSize.height / Math.max(1, displaySize.height);
    return Math.max(4, brushSize * Math.max(scaleX, scaleY));
  }

  function paintMask(event, fresh = false) {
    const canvas = maskCanvasRef.current;
    const point = maskPointerPoint(event);
    if (!canvas || !point) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const size = sourceBrushSize();
    const previous = fresh ? null : paintRef.current?.last || null;
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineWidth = size;
    ctx.globalCompositeOperation = maskTool === "eraser" ? "destination-out" : "source-over";
    ctx.strokeStyle = LOCAL_EDIT_MASK_COLOR;
    ctx.fillStyle = LOCAL_EDIT_MASK_COLOR;
    ctx.beginPath();
    if (previous) {
      ctx.moveTo(previous.x, previous.y);
      ctx.lineTo(point.x, point.y);
      ctx.stroke();
    } else {
      ctx.arc(point.x, point.y, size / 2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
    paintRef.current = { painting: true, last: point };
  }

  function refreshMaskState() {
    const canvas = maskCanvasRef.current;
    const bounds = maskBoundsFromCanvas(canvas);
    setMaskPainted(Boolean(bounds));
    if (bounds) {
      setCropRect(expandMaskBoundsToCropRect(bounds, imageSize.width, imageSize.height, activeRatio));
    }
    setMaskRevision((current) => current + 1);
  }

  function beginMaskPaint(event) {
    if (!isMaskMode || working) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    updateBrushCursor(event);
    if (event.button === 2) {
      brushResizeRef.current = {
        startX: event.clientX,
        startSize: brushSize
      };
      return;
    }
    paintMask(event, true);
  }

  function moveMaskPaint(event) {
    if (!isMaskMode) return;
    updateBrushCursor(event);
    if (brushResizeRef.current) {
      event.preventDefault();
      const delta = event.clientX - brushResizeRef.current.startX;
      setBrushSize(clampLocalEditBrushSize(brushResizeRef.current.startSize + delta * 0.5));
      return;
    }
    if (!paintRef.current?.painting) return;
    event.preventDefault();
    paintMask(event);
  }

  function endMaskPaint(event) {
    event.preventDefault();
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    if (brushResizeRef.current) {
      brushResizeRef.current = null;
      return;
    }
    if (!paintRef.current?.painting) return;
    paintRef.current = null;
    refreshMaskState();
  }

  function leaveMaskPaint() {
    setBrushCursor((current) => ({ ...current, visible: false }));
  }

  function clearMask() {
    const canvas = maskCanvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    setMaskPainted(false);
    setMaskRevision((current) => current + 1);
  }

  async function applyLocalEdit() {
    if (!cropRect || working) return;
    if (isMaskMode && !maskCanvasHasPaint(maskCanvasRef.current)) return;
    setWorking(true);
    try {
      if (isMaskMode) {
        const canvas = maskCanvasRef.current;
        const bounds = maskBoundsFromCanvas(canvas);
        const maskCropRect = expandMaskBoundsToCropRect(bounds, imageSize.width, imageSize.height, activeRatio) || cropRect;
        const cropped = await cropQuickLocalEditFile(item, maskCropRect, "mask_edit");
        onApply(item.id, {
          ...cropped,
          cropRect: maskCropRect,
          aspectRatio: activeRatio,
          editMode: LOCAL_EDIT_MASK_MODE,
          maskDataUrl: canvasToPngDataUrl(canvas),
          maskBounds: bounds,
          brushSize,
          maskOpacity
        });
      } else {
        const cropped = await cropQuickLocalEditFile(item, cropRect, isLocalMode ? "local_edit" : "crop", {
          withContext: isLocalMode
        });
        onApply(item.id, { ...cropped, aspectRatio: activeRatio, editMode: LOCAL_EDIT_RECT_MODE });
      }
    } finally {
      setWorking(false);
    }
  }

  const scale = imageSize.width && displaySize.width ? displaySize.width / imageSize.width : 1;
  const cropStyle = cropRect ? {
    left: `${cropRect.x * scale}px`,
    top: `${cropRect.y * scale}px`,
    width: `${cropRect.width * scale}px`,
    height: `${cropRect.height * scale}px`
  } : {};
  const cropPercent = cropRect && imageSize.width ? Math.round((cropRect.width / imageSize.width) * 100) : 62;
  const maskCanvasStyle = displaySize.width && displaySize.height ? {
    width: `${displaySize.width}px`,
    height: `${displaySize.height}px`,
    opacity: isMaskMode ? maskOpacity / 100 : 0
  } : {};
  const brushCursorStyle = {
    left: `${brushCursor.x}px`,
    top: `${brushCursor.y}px`,
    width: `${brushSize}px`,
    height: `${brushSize}px`
  };
  const applyDisabled = working || !cropRect || (isMaskMode && !maskPainted);

  return (
    <div className="modalLayer previewLayer" onMouseDown={onClose}>
      <section className="quickLocalEditModal" onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <div>
            <h2>{modalTitle}</h2>
            <span>{originalFile?.name || "上传图片"} · {modalDescription} · {activeRatio}</span>
          </div>
          <button className="iconButton" type="button" onClick={onClose} aria-label="关闭">
            <X size={18} />
          </button>
        </header>
        <div className="quickLocalEditStage">
          <div className="quickLocalEditImageWrap">
            {imageUrl && (
              <img
                ref={imageRef}
                src={imageUrl}
                alt=""
                draggable={false}
                onLoad={onImageLoad}
              />
            )}
            {isLocalMode && (
              <canvas
                ref={maskCanvasRef}
                className={`quickLocalMaskCanvas ${isMaskMode ? "active" : ""}`}
                style={maskCanvasStyle}
                onPointerDown={beginMaskPaint}
                onPointerMove={moveMaskPaint}
                onPointerUp={endMaskPaint}
                onPointerCancel={endMaskPaint}
                onPointerEnter={(event) => updateBrushCursor(event)}
                onPointerLeave={leaveMaskPaint}
                onContextMenu={(event) => event.preventDefault()}
              />
            )}
            {isMaskMode && brushCursor.visible && (
              <div
                className={`quickLocalBrushCursor ${maskTool === "eraser" ? "erase" : "paint"}`}
                style={brushCursorStyle}
              />
            )}
            {cropRect && displaySize.width > 0 && !isMaskMode && (
              <div
                className="quickLocalCropBox"
                style={cropStyle}
                onPointerDown={(event) => beginCropDrag(event, "move")}
                onPointerMove={moveCropDrag}
                onPointerUp={endCropDrag}
                onPointerCancel={endCropDrag}
              >
                <span />
                <i
                  onPointerDown={(event) => beginCropDrag(event, "resize")}
                  onPointerMove={moveCropDrag}
                  onPointerUp={endCropDrag}
                  onPointerCancel={endCropDrag}
                />
              </div>
            )}
            {cropRect && displaySize.width > 0 && isMaskMode && maskPainted && (
              <div className="quickLocalMaskContextBox" style={cropStyle}>
                <span>AI上下文</span>
              </div>
            )}
          </div>
        </div>
        <div className="quickLocalEditControls">
          {isLocalMode && (
            <div className="quickLocalModeGroup" role="group" aria-label="局部编辑模式">
              <button
                className={editMode === LOCAL_EDIT_RECT_MODE ? "active" : ""}
                type="button"
                onClick={() => chooseEditMode(LOCAL_EDIT_RECT_MODE)}
              >
                <Crop size={14} />
                <span>框选区域</span>
              </button>
              <button
                className={editMode === LOCAL_EDIT_MASK_MODE ? "active" : ""}
                type="button"
                onClick={() => chooseEditMode(LOCAL_EDIT_MASK_MODE)}
              >
                <Brush size={14} />
                <span>涂抹蒙版</span>
              </button>
            </div>
          )}
          {isLocalMode && (
            <div className="quickLocalRatioGroup" role="group" aria-label="局部区域比例">
              {QUICK_LOCAL_EDIT_RATIOS.map((itemRatio) => (
                <button
                  key={itemRatio}
                  className={activeRatio === itemRatio ? "active" : ""}
                  type="button"
                  onClick={() => chooseLocalRatio(itemRatio)}
                >
                  {itemRatio}
                </button>
              ))}
            </div>
          )}
          {isMaskMode ? (
            <div className="quickLocalBrushTools">
              <button
                className={maskTool === "brush" ? "active" : ""}
                type="button"
                onClick={() => setMaskTool("brush")}
                title="白笔添加"
              >
                <span className="quickLocalBrushSwatch white" />
                <span>白笔</span>
              </button>
              <button
                className={maskTool === "eraser" ? "active" : ""}
                type="button"
                onClick={() => setMaskTool("eraser")}
                title="黑笔擦除"
              >
                <span className="quickLocalBrushSwatch black" />
                <span>黑笔</span>
              </button>
              <label>
                <span>笔刷 {brushSize}</span>
                <input
                  type="range"
                  min="8"
                  max="160"
                  value={brushSize}
                  onChange={(event) => setBrushSize(clampLocalEditBrushSize(event.target.value))}
                />
              </label>
              <label>
                <span>透明度 {maskOpacity}%</span>
                <input
                  type="range"
                  min="10"
                  max="100"
                  value={maskOpacity}
                  onChange={(event) => setMaskOpacity(clampLocalEditMaskOpacity(event.target.value))}
                />
              </label>
              <button type="button" onClick={clearMask} disabled={!maskPainted}>清空</button>
            </div>
          ) : (
            <label>
              <span>区域大小</span>
              <input
                type="range"
                min="12"
                max="100"
                value={Math.max(12, Math.min(100, cropPercent))}
                onChange={changeCropScale}
              />
            </label>
          )}
          {cropRect && (
            <small>{isMaskMode ? "上下文 " : ""}{Math.round(cropRect.width)} × {Math.round(cropRect.height)} px</small>
          )}
        </div>
        <footer>
          <span>{isMaskMode ? "涂抹需要 AI 修改的区域，生成后只把涂抹部分羽化贴回原图。" : isLocalMode ? "拖动选区调整位置，生成后会贴回原图同一坐标。" : "拖动选区调整位置，裁剪后的参考图会参与生成，但结果不贴回原图。"}</span>
          <div>
            {savedEdit && (
              <button className="smallButton" type="button" onClick={isMaskMode ? clearMask : () => onClear(item.id)}>
                {isMaskMode ? <Brush size={15} /> : <RotateCcw size={15} />}
                <span>{isMaskMode ? "清除涂抹" : isLocalMode ? "取消局部回贴" : "取消裁剪"}</span>
              </button>
            )}
            <button className="smallButton" type="button" onClick={onClose}>取消</button>
            <button className="generateButton quickLocalApplyButton" type="button" onClick={applyLocalEdit} disabled={applyDisabled}>
              {working ? <Loader2 size={16} className="spin" /> : isMaskMode ? <Brush size={16} /> : isLocalMode ? <Scissors size={16} /> : <Crop size={16} />}
              <span>{isMaskMode ? "应用蒙版回贴" : isLocalMode ? "应用局部回贴" : "应用裁剪"}</span>
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}

function App() {
  const [config, setConfig] = useState({ hasServerKey: false, models: DEFAULT_MODELS, defaultBaseUrl: defaultState.baseUrl });
  const [settings, setSettings] = useState(loadState);
  const [promptPresets, setPromptPresets] = useState(loadPromptPresets);
  const [promptCategories, setPromptCategories] = useState(loadPromptCategories);
  const [activeView, setActiveView] = useState(loadActiveView);
  const [detailSettings, setDetailSettings] = useState(detailDefaults);
  const [detailPresets, setDetailPresets] = useState(loadDetailPresets);
  const [detailProductFiles, setDetailProductFiles] = useState([]);
  const [detailReferenceFiles, setDetailReferenceFiles] = useState([]);
  const [detailGroups, setDetailGroups] = useState(loadDetailGroups);
  const [detailStatus, setDetailStatus] = useState("idle");
  const [activeDetailGroupId, setActiveDetailGroupId] = useState("");
  const [detailInfoSelection, setDetailInfoSelection] = useState(null);
  const [detailColumns, setDetailColumns] = useState(5);
  const [detailForwardSort, setDetailForwardSort] = useState(true);
  const [detailDragScreen, setDetailDragScreen] = useState(null);
  const [stitchPreview, setStitchPreview] = useState(null);
  const [stitchZoom, setStitchZoom] = useState(1);
  const [stitchPan, setStitchPan] = useState({ x: 0, y: 0 });
  const [referenceSettings, setReferenceSettings] = useState(referenceDefaults);
  const [referenceProductFiles, setReferenceProductFiles] = useState([]);
  const [referenceStyleFiles, setReferenceStyleFiles] = useState([]);
  const [referenceTasks, setReferenceTasks] = useState([]);
  const [referenceStatus, setReferenceStatus] = useState("idle");
  const [referenceError, setReferenceError] = useState("");
  const [isReferencePromptRewriting, setIsReferencePromptRewriting] = useState(false);
  const [infiniteCanvasState, setInfiniteCanvasState] = useState(loadInfiniteCanvasState);
  const [canvasViewport, setCanvasViewport] = useState({ x: 34, y: 18, scale: 1 });
  const [canvasTasks, setCanvasTasks] = useState([]);
  const [canvasConnectStart, setCanvasConnectStart] = useState(null);
  const [canvasDrag, setCanvasDrag] = useState(null);
  const [canvasSelectedNodeId, setCanvasSelectedNodeId] = useState("");
  const [saveDirectory, setSaveDirectory] = useState("");
  const [directoryDraft, setDirectoryDraft] = useState("");
  const [isPickingDirectory, setIsPickingDirectory] = useState(false);
  const [files, setFiles] = useState([]);
  const [results, setResults] = useState([]);
  const [resultFilter, setResultFilter] = useState("all");
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [status, setStatus] = useState("idle");
  const [quickTasks, setQuickTasks] = useState([]);
  const [galleryZoom, setGalleryZoom] = useState(1);
  const [downloadFeedbackIds, setDownloadFeedbackIds] = useState(() => new Set());
  const [error, setError] = useState("");
  const [isQuickPromptOptimizing, setIsQuickPromptOptimizing] = useState(false);
  const [timing, setTiming] = useState(null);
  const [events, setEvents] = useState([]);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isApiKeyVisible, setIsApiKeyVisible] = useState(false);
  const [apiSaveStatus, setApiSaveStatus] = useState("");
  const [isDirectoryModalOpen, setIsDirectoryModalOpen] = useState(false);
  const [isDetailPresetOpen, setIsDetailPresetOpen] = useState(false);
  const [isPromptAssistantOpen, setIsPromptAssistantOpen] = useState(false);
  const [editingPrompt, setEditingPrompt] = useState(null);
  const [promptCategory, setPromptCategory] = useState("全部");
  const [promptSearch, setPromptSearch] = useState("");
  const [referenceDropTarget, setReferenceDropTarget] = useState(null);
  const [quickCropEditTarget, setQuickCropEditTarget] = useState(null);
  const [quickLocalEditTarget, setQuickLocalEditTarget] = useState(null);
  const [draggedPromptId, setDraggedPromptId] = useState(null);
  const [promptDropCategory, setPromptDropCategory] = useState("");
  const [draggedPromptCategory, setDraggedPromptCategory] = useState("");
  const [promptCategoryDropTarget, setPromptCategoryDropTarget] = useState(null);
  const [isComposerDragging, setIsComposerDragging] = useState(false);
  const [nowTick, setNowTick] = useState(Date.now());
  const [previewResult, setPreviewResult] = useState(null);
  const [uploadPreview, setUploadPreview] = useState(null);
  const [referencePreview, setReferencePreview] = useState(null);
  const [previewZoom, setPreviewZoom] = useState(1);
  const [previewPan, setPreviewPan] = useState({ x: 0, y: 0 });
  const [contextMenu, setContextMenu] = useState(null);
  const [referenceContextMenu, setReferenceContextMenu] = useState(null);
  const [stitchContextMenu, setStitchContextMenu] = useState(null);
  const [imageEditorSeed, setImageEditorSeed] = useState(null);
  const inputRef = useRef(null);
  const detailProductInputRef = useRef(null);
  const detailReferenceInputRef = useRef(null);
  const referenceProductInputRef = useRef(null);
  const referenceStyleInputRef = useRef(null);
  const canvasStageRef = useRef(null);
  const canvasFileInputRef = useRef(null);
  const previewDragRef = useRef(null);
  const stitchDragRef = useRef(null);
  const downloadFeedbackTimersRef = useRef(new Map());

  const models = config.models?.length ? config.models : DEFAULT_MODELS;
  const activeModel = models.find((item) => item.value === settings.model) || models[0];
  const ratios = activeModel.ratios || ["1:1", "3:4", "16:9"];
  const detailModel = models.find((item) => item.value === detailSettings.model) || models[0];
  const detailRatios = detailModel.ratios || ["1:1", "3:4", "16:9"];
  const referenceModel = models.find((item) => item.value === referenceSettings.model) || models[0];
  const referenceRatios = referenceModel.ratios || ["1:1", "3:4", "16:9"];
  const detailRunningCount = detailGroups.reduce((count, group) => (
    count + group.prompts.reduce((screenCount, prompt) => screenCount + (prompt.status === "running" ? 1 : 0), 0)
  ), 0);
  const detailStatusText = detailStatus === "planning"
    ? "正在生成分段提示词"
    : detailRunningCount > 0
      ? `详情图生成中 ${detailRunningCount} 个任务`
      : detailStatus === "failed"
        ? "详情任务失败"
        : detailGroups.length > 0
          ? "提示词已生成"
          : "等待输入产品信息";
  const filteredPromptPresets = useMemo(() => {
    const keyword = promptSearch.trim().toLowerCase();
    return promptPresets.filter((preset) => {
      const matchesCategory = promptCategory === "全部" || preset.category === promptCategory;
      const matchesKeyword = !keyword
        || preset.title.toLowerCase().includes(keyword)
        || preset.content.toLowerCase().includes(keyword);
      return matchesCategory && matchesKeyword;
    });
  }, [promptPresets, promptCategory, promptSearch]);
  const previewFiles = useMemo(
    () => files
      .map(normalizeQuickReferenceItem)
      .filter(Boolean)
      .map((item) => {
        const originalFile = quickReferenceOriginalFile(item);
        const uploadFile = quickReferenceUploadFile(item);
        const displayFile = uploadFile || originalFile;
        return {
          ...item,
          file: originalFile,
          uploadFile,
          originalFile,
          url: URL.createObjectURL(displayFile || originalFile),
          uploadName: uploadFile?.name || originalFile?.name || "",
          uploadSize: uploadFile?.size || originalFile?.size || 0
        };
      }),
    [files]
  );
  const detailProductPreviews = useMemo(
    () => detailProductFiles.map((file) => ({ file, url: URL.createObjectURL(file) })),
    [detailProductFiles]
  );
  const detailReferencePreviews = useMemo(
    () => detailReferenceFiles.map((file) => ({ file, url: URL.createObjectURL(file) })),
    [detailReferenceFiles]
  );
  const referenceProductPreviews = useMemo(
    () => referenceProductFiles.map((file) => ({ file, url: URL.createObjectURL(file) })),
    [referenceProductFiles]
  );
  const referenceStylePreviews = useMemo(
    () => referenceStyleFiles.map((file) => ({ file, url: URL.createObjectURL(file) })),
    [referenceStyleFiles]
  );
  const canvases = infiniteCanvasState.canvases;
  const activeCanvasId = infiniteCanvasState.activeId;
  const activeCanvas = canvases.find((canvas) => canvas.id === activeCanvasId) || canvases[0] || null;
  const canvasRunningCount = canvasTasks.filter((task) => task.status === "running").length;
  const canvasStatusText = canvasRunningCount > 0
    ? `运行中 ${canvasRunningCount} 个任务`
    : activeCanvas
      ? `${activeCanvas.nodes.length} 个节点`
      : "等待新建画布";
  const activeDetailGroup = detailGroups.find((group) => group.id === activeDetailGroupId) || detailGroups[0] || null;
  const visibleDetailPrompts = activeDetailGroup
    ? (detailForwardSort ? activeDetailGroup.prompts : [...activeDetailGroup.prompts].reverse())
    : [];
  const activeDetailResults = activeDetailGroup
    ? visibleDetailPrompts.flatMap((prompt) => (prompt.results || []).map((result) => ({ group: activeDetailGroup, prompt, result })))
    : [];
  const detailInfoItem = detailInfoSelection
    ? activeDetailResults.find((item) => item.result.id === detailInfoSelection.resultId) || null
    : null;
  const stitchGroup = stitchPreview
    ? detailGroups.find((group) => group.id === stitchPreview.groupId) || null
    : null;
  const stitchContextGroup = stitchContextMenu
    ? detailGroups.find((group) => group.id === stitchContextMenu.groupId) || null
    : null;
  const stitchPrompts = stitchGroup
    ? (detailForwardSort ? stitchGroup.prompts : [...stitchGroup.prompts].reverse())
    : [];
  const stitchItems = stitchPrompts.flatMap((prompt) => (prompt.results || []).map((result) => ({ prompt, result })));
  const quickResults = useMemo(() => results.filter((item) => !item.source || item.source === "quickgen"), [results]);
  const referenceResults = useMemo(() => results.filter((item) => item.source === "reference-remix"), [results]);
  const quickGalleryRef = useRef(null);
  const runningQuickTasks = quickTasks.filter((task) => task.status === "running");
  const runningReferenceTasks = referenceTasks.filter((task) => task.status === "running");
  const imageCount = quickResults.length;
  const visibleResults = resultFilter === "image" ? quickResults : quickResults;
  const quickGalleryItems = useMemo(() => {
    const resultItems = visibleResults.map((item, index) => ({
        kind: "result",
        key: `result-${item.id}`,
        result: item,
        orderAt: Number.isFinite(item.submittedAt) ? item.submittedAt : (Number.isFinite(item.createdAt) ? item.createdAt : 0),
        fallbackIndex: index
      }))
      .sort((a, b) => (a.orderAt - b.orderAt) || (a.fallbackIndex - b.fallbackIndex));
    const galleryItems = [...resultItems];
    runningQuickTasks.forEach((task, index) => {
      galleryItems.push({
        kind: "task",
        key: `task-${task.id}`,
        task,
        orderAt: task.startedAt || 0,
        fallbackIndex: visibleResults.length + index
      });
    });
    return galleryItems.sort((a, b) => (a.orderAt - b.orderAt) || (a.fallbackIndex - b.fallbackIndex));
  }, [visibleResults, runningQuickTasks]);
  const referenceGalleryItems = useMemo(() => {
    const sessionItems = [];
    const historyItems = [];
    referenceResults.forEach((item, index) => {
      const entry = {
        kind: "result",
        key: `reference-result-${item.id}`,
        result: item,
        orderAt: Number.isFinite(item.submittedAt) ? item.submittedAt : (Number.isFinite(item.createdAt) ? item.createdAt : 0),
        fallbackIndex: index
      };
      if (item.clientSessionId === CLIENT_SESSION_ID) {
        sessionItems.push(entry);
      } else {
        historyItems.push(entry);
      }
    });
    runningReferenceTasks.forEach((task, index) => {
      sessionItems.push({
        kind: "task",
        key: `reference-task-${task.id}`,
        task,
        orderAt: task.startedAt || 0,
        fallbackIndex: referenceResults.length + index
      });
    });
    sessionItems.sort((a, b) => (a.orderAt - b.orderAt) || (a.fallbackIndex - b.fallbackIndex));
    return [...sessionItems, ...historyItems];
  }, [referenceResults, runningReferenceTasks]);
  const quickSelectedCount = quickResults.reduce((count, item) => count + (selectedIds.has(item.id) ? 1 : 0), 0);
  const selectedCount = selectedIds.size;
  const galleryZoomPercent = Math.round(galleryZoom * 100);
  const galleryCardMin = Math.round(170 * galleryZoom);
  const quickStatus = runningQuickTasks.length > 0 ? "running" : status;
  const latestStatusText = runningQuickTasks.length > 0
    ? `运行中 ${runningQuickTasks.length} 个任务`
    : status === "failed"
      ? "当前任务失败"
      : status === "success"
        ? "当前任务已完成"
        : "等待生成";
  const referenceStatusText = runningReferenceTasks.length > 0
    ? `运行中 ${runningReferenceTasks.length} 个任务`
    : referenceStatus === "failed"
      ? "参考生图失败"
      : referenceStatus === "success"
        ? "参考生图已完成"
        : "等待参考生图";
  const contextItem = contextMenu ? results.find((item) => item.id === contextMenu.itemId) : null;
  const contextIndex = contextItem ? results.findIndex((item) => item.id === contextItem.id) : -1;
  const quickGalleryTailKey = quickGalleryItems.at(-1)?.key || "";
  const previewNavigationItems = useMemo(() => {
    if (!previewResult) return [];
    const previewSource = previewResult.source || "quickgen";
    if (previewSource === "detail-main") {
      return activeDetailResults.map((item) => item.result).filter(Boolean);
    }
    if (previewSource === "reference-remix") {
      return referenceGalleryItems
        .filter((item) => item.kind === "result")
        .map((item) => item.result)
        .filter(Boolean);
    }
    if (previewSource === "infinite-canvas") {
      return results
        .filter((item) => item.source === "infinite-canvas")
        .sort((a, b) => (
          (Number.isFinite(a.submittedAt) ? a.submittedAt : (Number.isFinite(a.createdAt) ? a.createdAt : 0))
          - (Number.isFinite(b.submittedAt) ? b.submittedAt : (Number.isFinite(b.createdAt) ? b.createdAt : 0))
        ));
    }
    return quickGalleryItems
      .filter((item) => item.kind === "result")
      .map((item) => item.result)
      .filter(Boolean);
  }, [previewResult, activeDetailResults, referenceGalleryItems, quickGalleryItems, results]);

  useEffect(() => {
    fetch("/api/config").then((res) => res.json()).then((data) => {
      setConfig(data);
      setSettings((current) => ({
        ...current,
        baseUrl: data.defaultBaseUrl || defaultState.baseUrl
      }));
    }).catch(() => {});

    refreshSaveDirectory();
  }, []);

  useEffect(() => {
    let active = true;
    loadHistoryResults().then((storedResults) => {
      if (!active) return;
      setResults(storedResults);
      setDetailGroups((current) => hydrateDetailGroupsWithHistory(current, storedResults));
      if (storedResults.length > 0) addEvent("历史记录", `已载入 ${storedResults.length} 张图片`);
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    writeJsonStorage(STORAGE_KEY, settings);
    document.documentElement.setAttribute("data-theme", settings.theme || "dark");
  }, [settings]);

  useEffect(() => {
    writeJsonStorage(PROMPT_PRESETS_KEY, promptPresets);
  }, [promptPresets]);

  useEffect(() => {
    writeJsonStorage(PROMPT_CATEGORIES_KEY, promptCategories.filter((category) => category !== "全部"));
  }, [promptCategories]);

  useEffect(() => {
    if (promptCategory !== "全部" && !promptCategories.includes(promptCategory)) {
      setPromptCategory(promptCategories.find((category) => category !== "全部") || "全部");
    }
  }, [promptCategories, promptCategory]);

  useEffect(() => {
    writeJsonStorage(DETAIL_PRESETS_KEY, detailPresets);
  }, [detailPresets]);

  useEffect(() => {
    writeJsonStorage(DETAIL_GROUPS_KEY, sanitizeDetailGroupsForStorage(detailGroups));
  }, [detailGroups]);

  useEffect(() => {
    try {
      localStorage.setItem(INFINITE_CANVAS_KEY, JSON.stringify(infiniteCanvasState));
    } catch {
      addEvent("无限画布", "画布内容较大，部分临时图片可能无法写入本地缓存");
    }
  }, [infiniteCanvasState]);

  useEffect(() => {
    writeJsonStorage(ACTIVE_VIEW_KEY, activeView);
  }, [activeView]);

  useEffect(() => {
    if (detailGroups.length === 0) {
      setActiveDetailGroupId("");
      setDetailInfoSelection(null);
      return;
    }
    if (!activeDetailGroupId || !detailGroups.some((group) => group.id === activeDetailGroupId)) {
      setActiveDetailGroupId(detailGroups[0].id);
    }
  }, [detailGroups, activeDetailGroupId]);

  useEffect(() => () => {
    previewFiles.forEach((item) => URL.revokeObjectURL(item.url));
  }, [previewFiles]);

  useEffect(() => () => {
    detailProductPreviews.forEach((item) => URL.revokeObjectURL(item.url));
  }, [detailProductPreviews]);

  useEffect(() => () => {
    detailReferencePreviews.forEach((item) => URL.revokeObjectURL(item.url));
  }, [detailReferencePreviews]);

  useEffect(() => () => {
    referenceProductPreviews.forEach((item) => URL.revokeObjectURL(item.url));
  }, [referenceProductPreviews]);

  useEffect(() => () => {
    referenceStylePreviews.forEach((item) => URL.revokeObjectURL(item.url));
  }, [referenceStylePreviews]);

  useEffect(() => {
    if (quickTasks.length === 0 && referenceTasks.length === 0 && canvasTasks.length === 0) return undefined;
    setNowTick(Date.now());
    const timer = window.setInterval(() => setNowTick(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [quickTasks.length, referenceTasks.length, canvasTasks.length]);

  useEffect(() => {
    if (activeView !== "quickgen" || quickGalleryItems.length === 0) return undefined;
    const frame = window.requestAnimationFrame(() => {
      const gallery = quickGalleryRef.current;
      if (!gallery) return;
      gallery.scrollTop = gallery.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeView, quickGalleryItems.length, quickGalleryTailKey, galleryZoom]);

  useEffect(() => {
    const closeMenu = () => {
      setContextMenu(null);
      setReferenceContextMenu(null);
      setStitchContextMenu(null);
    };
    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        setContextMenu(null);
        setReferenceContextMenu(null);
        setStitchContextMenu(null);
        closeReferencePreview();
        closePreview();
        setIsPromptAssistantOpen(false);
        setEditingPrompt(null);
        setIsDirectoryModalOpen(false);
        setIsDetailPresetOpen(false);
      }
    };
    window.addEventListener("click", closeMenu);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", closeMenu);
    return () => {
      window.removeEventListener("click", closeMenu);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", closeMenu);
    };
  }, []);

  useEffect(() => {
    if (!previewResult) return undefined;
    const onPreviewKeyDown = (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      shiftPreview(event.key === "ArrowRight" ? 1 : -1);
    };
    window.addEventListener("keydown", onPreviewKeyDown);
    return () => window.removeEventListener("keydown", onPreviewKeyDown);
  }, [previewResult, previewNavigationItems]);

  useEffect(() => {
    if (!referencePreview) return undefined;
    const onReferencePreviewKeyDown = (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      shiftReferencePreview(event.key === "ArrowRight" ? 1 : -1);
    };
    window.addEventListener("keydown", onReferencePreviewKeyDown);
    return () => window.removeEventListener("keydown", onReferencePreviewKeyDown);
  }, [referencePreview]);

  useEffect(() => () => {
    downloadFeedbackTimersRef.current.forEach((timer) => window.clearTimeout(timer));
    downloadFeedbackTimersRef.current.clear();
  }, []);

  function updateSetting(key, value) {
    setSettings((current) => {
      const next = { ...current, [key]: value };
      if (key === "model") {
        const nextModel = models.find((item) => item.value === value) || models[0];
        if (!nextModel.ratios.includes(next.aspectRatio)) next.aspectRatio = nextModel.ratios[0];
      }
      if (key === "n") next.n = clampCount(value);
      return next;
    });
  }

  function updateDetailSetting(key, value) {
    setDetailSettings((current) => {
      const next = { ...current, [key]: value };
      if (key === "model") {
        const nextModel = models.find((item) => item.value === value) || models[0];
        if (!nextModel.ratios.includes(next.ratio)) next.ratio = nextModel.ratios[0];
      }
      if (key === "count") next.count = clampDetailCount(value);
      if (key === "modelUsage") next.modelUsage = clampDetailModelUsage(value);
      if (key === "reverseScreens") next.reverseScreens = clampReverseScreens(value);
      return next;
    });
  }

  function updateReferenceSetting(key, value) {
    setReferenceSettings((current) => {
      const next = { ...current, [key]: value };
      if (key === "model") {
        const nextModel = models.find((item) => item.value === value) || models[0];
        if (!nextModel.ratios.includes(next.aspectRatio)) next.aspectRatio = nextModel.ratios[0];
      }
      if (key === "n") next.n = clampCount(value);
      if (key === "strength") next.strength = clampReferenceStrength(value);
      return next;
    });
  }

  async function applySmartReferencePrompt() {
    if (isReferencePromptRewriting) return;
    const apiKey = normalizeApiKeyInput(settings.apiKey);
    if (!apiKey && !config.hasServerKey) {
      setReferenceError("请先在左下角设置里填写 API Key，智能扩写需要调用当前渠道文本模型");
      setIsSettingsOpen(true);
      addEvent("参考生图", "请先保存 API Key 后再智能扩写");
      return;
    }

    setIsReferencePromptRewriting(true);
    setReferenceError("");
    try {
      const productUpload = await prepareImageFilesForChannel(referenceProductFiles);
      const referenceUpload = await prepareImageFilesForChannel(referenceStyleFiles);
      if (productUpload.compressedCount + referenceUpload.compressedCount > 0) {
        addEvent("图片压缩", `智能扩写已压缩 ${productUpload.compressedCount + referenceUpload.compressedCount} 张素材到 4MB 内`);
      }

      const form = new FormData();
      form.set("payload", JSON.stringify({
        ...referenceSettings,
        apiKey,
        baseUrl: config.defaultBaseUrl || settings.baseUrl || defaultState.baseUrl,
        detailAnalysisModel: DETAIL_ANALYSIS_MODEL,
        productImages: productUpload.files.map((file) => ({ name: file.name, size: file.size, type: file.type })),
        referenceImages: referenceUpload.files.map((file) => ({ name: file.name, size: file.size, type: file.type }))
      }));
      productUpload.files.forEach((file) => form.append("productImage", file, file.name));
      referenceUpload.files.forEach((file) => form.append("referenceImage", file, file.name));

      const response = await fetch("/api/reference-prompt-rewrite", {
        method: "POST",
        body: form
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.ok) {
        const message = payload?.message || `HTTP ${response.status}`;
        if (isAuthErrorMessage(message)) {
          setIsSettingsOpen(true);
          throw new Error(message);
        }
        const fallbackPrompt = payload?.fallbackPrompt || buildSmartReferencePrompt(referenceSettings);
        setReferenceSettings((current) => ({ ...current, prompt: fallbackPrompt }));
        addEvent("参考生图", "文本模型扩写失败，已使用保守 Skill 兜底");
        throw new Error(message);
      }

      setReferenceSettings((current) => ({
        ...current,
        prompt: payload.prompt || current.prompt
      }));
      addEvent("参考生图", `文本模型扩写完成：${payload.mode === "ai-vision" ? "已读取图片" : "纯文本规划"}`);
    } catch (err) {
      const message = normalizeGenerationErrorMessage(err instanceof Error ? err.message : String(err));
      setReferenceError(message);
      addEvent("智能扩写失败", message);
    } finally {
      setIsReferencePromptRewriting(false);
    }
  }

  function patchActiveCanvas(updater) {
    setInfiniteCanvasState((current) => {
      const activeId = current.activeId || current.canvases[0]?.id;
      return {
        ...current,
        activeId,
        canvases: current.canvases.map((canvas) => {
          if (canvas.id !== activeId) return canvas;
          const patch = typeof updater === "function" ? updater(canvas) : updater;
          return { ...canvas, ...patch, updatedAt: Date.now() };
        })
      };
    });
  }

  function patchCanvasById(canvasId, updater) {
    setInfiniteCanvasState((current) => ({
      ...current,
      canvases: current.canvases.map((canvas) => {
        if (canvas.id !== canvasId) return canvas;
        const patch = typeof updater === "function" ? updater(canvas) : updater;
        return { ...canvas, ...patch, updatedAt: Date.now() };
      })
    }));
  }

  function updateCanvasNode(nodeId, updater) {
    patchActiveCanvas((canvas) => ({
      nodes: canvas.nodes.map((node) => {
        if (node.id !== nodeId) return node;
        const patch = typeof updater === "function" ? updater(node) : updater;
        return { ...node, ...patch, updatedAt: Date.now() };
      })
    }));
  }

  function updateCanvasNodeByCanvasId(canvasId, nodeId, updater) {
    patchCanvasById(canvasId, (canvas) => ({
      nodes: canvas.nodes.map((node) => {
        if (node.id !== nodeId) return node;
        const patch = typeof updater === "function" ? updater(node) : updater;
        return { ...node, ...patch, updatedAt: Date.now() };
      })
    }));
  }

  function createCanvas() {
    const canvas = createInfiniteCanvas();
    setInfiniteCanvasState((current) => ({
      activeId: canvas.id,
      canvases: [canvas, ...current.canvases]
    }));
    setCanvasSelectedNodeId("");
    setCanvasViewport({ x: 34, y: 18, scale: 1 });
    addEvent("无限画布", "已新建画布");
  }

  function renameCanvas() {
    if (!activeCanvas) return;
    const name = window.prompt("请输入画布名称", activeCanvas.name);
    if (!name?.trim()) return;
    patchActiveCanvas({ name: name.trim() });
    addEvent("无限画布", "画布已重命名");
  }

  function deleteCanvas() {
    if (!activeCanvas) return;
    const confirmed = window.confirm(`确定删除「${activeCanvas.name}」吗？画布内节点会被清理，不影响其它栏目。`);
    if (!confirmed) return;
    setInfiniteCanvasState((current) => {
      if (current.canvases.length <= 1) {
        const replacement = createInfiniteCanvas("默认画布");
        return { activeId: replacement.id, canvases: [replacement] };
      }
      const nextCanvases = current.canvases.filter((canvas) => canvas.id !== activeCanvas.id);
      return { activeId: nextCanvases[0].id, canvases: nextCanvases };
    });
    setCanvasSelectedNodeId("");
    addEvent("无限画布", "画布已删除");
  }

  function clearCanvas() {
    if (!activeCanvas) return;
    const confirmed = window.confirm("确定清空当前画布吗？只会清理无限画布，不影响其它栏目。");
    if (!confirmed) return;
    const reset = createInfiniteCanvas(activeCanvas.name);
    patchActiveCanvas({
      nodes: reset.nodes,
      connections: reset.connections
    });
    setCanvasSelectedNodeId("");
    addEvent("无限画布", "当前画布已清空");
  }

  function selectCanvas(canvasId) {
    setInfiniteCanvasState((current) => ({
      ...current,
      activeId: canvasId
    }));
    setCanvasSelectedNodeId("");
    setCanvasConnectStart(null);
  }

  function screenToCanvasPoint(clientX, clientY) {
    const rect = canvasStageRef.current?.getBoundingClientRect();
    if (!rect) return { x: 120, y: 120 };
    return {
      x: (clientX - rect.left - canvasViewport.x) / canvasViewport.scale,
      y: (clientY - rect.top - canvasViewport.y) / canvasViewport.scale
    };
  }

  function canvasCenterPoint(offsetX = 0, offsetY = 0) {
    const rect = canvasStageRef.current?.getBoundingClientRect();
    if (!rect) return { x: 120 + offsetX, y: 120 + offsetY };
    return {
      x: (rect.width / 2 - canvasViewport.x) / canvasViewport.scale + offsetX,
      y: (rect.height / 2 - canvasViewport.y) / canvasViewport.scale + offsetY
    };
  }

  function addCanvasNode(type, patch = {}) {
    const point = patch.x == null || patch.y == null ? canvasCenterPoint() : { x: patch.x, y: patch.y };
    const node = createCanvasNode(type, { ...patch, x: point.x, y: point.y });
    patchActiveCanvas((canvas) => ({
      nodes: [...canvas.nodes, node]
    }));
    setCanvasSelectedNodeId(node.id);
    return node;
  }

  function deleteCanvasNode(nodeId) {
    patchActiveCanvas((canvas) => ({
      nodes: canvas.nodes.filter((node) => node.id !== nodeId),
      connections: canvas.connections.filter((connection) => connection.fromNodeId !== nodeId && connection.toNodeId !== nodeId)
    }));
    setCanvasSelectedNodeId((current) => current === nodeId ? "" : current);
    setCanvasConnectStart((current) => current?.nodeId === nodeId ? null : current);
  }

  function fitCanvasView() {
    if (!activeCanvas || activeCanvas.nodes.length === 0) {
      setCanvasViewport({ x: 34, y: 18, scale: 1 });
      return;
    }
    const rect = canvasStageRef.current?.getBoundingClientRect();
    const minX = Math.min(...activeCanvas.nodes.map((node) => node.x));
    const minY = Math.min(...activeCanvas.nodes.map((node) => node.y));
    const maxX = Math.max(...activeCanvas.nodes.map((node) => node.x + node.w));
    const maxY = Math.max(...activeCanvas.nodes.map((node) => node.y + node.h));
    if (!rect) {
      setCanvasViewport({ x: 34 - minX, y: 18 - minY, scale: 1 });
      return;
    }
    const scale = Math.max(0.35, Math.min(1.2, Math.min((rect.width - 100) / Math.max(1, maxX - minX), (rect.height - 100) / Math.max(1, maxY - minY))));
    setCanvasViewport({
      x: rect.width / 2 - ((minX + maxX) / 2) * scale,
      y: rect.height / 2 - ((minY + maxY) / 2) * scale,
      scale: Number(scale.toFixed(2))
    });
  }

  function handleCanvasWheel(event) {
    event.preventDefault();
    const rect = canvasStageRef.current?.getBoundingClientRect();
    if (!rect) return;
    const nextScale = Math.max(0.25, Math.min(2.4, Number((canvasViewport.scale * (event.deltaY < 0 ? 1.08 : 0.92)).toFixed(3))));
    const worldX = (event.clientX - rect.left - canvasViewport.x) / canvasViewport.scale;
    const worldY = (event.clientY - rect.top - canvasViewport.y) / canvasViewport.scale;
    setCanvasViewport({
      x: event.clientX - rect.left - worldX * nextScale,
      y: event.clientY - rect.top - worldY * nextScale,
      scale: nextScale
    });
  }

  function beginCanvasPan(event) {
    if (event.button !== 0) return;
    if (event.target.closest(".infiniteNode") || event.target.closest("button,input,select,textarea")) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setCanvasDrag({
      type: "pan",
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startViewport: canvasViewport
    });
  }

  function beginCanvasNodeDrag(event, nodeId) {
    if (event.button !== 0) return;
    if (event.target.closest("button,input,select,textarea")) return;
    const node = activeCanvas?.nodes.find((item) => item.id === nodeId);
    if (!node) return;
    event.preventDefault();
    event.stopPropagation();
    canvasStageRef.current?.setPointerCapture?.(event.pointerId);
    setCanvasSelectedNodeId(nodeId);
    setCanvasDrag({
      type: "node",
      nodeId,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startNode: { x: node.x, y: node.y }
    });
  }

  function moveCanvasDrag(event) {
    if (!canvasDrag) return;
    if (canvasDrag.type === "pan") {
      setCanvasViewport({
        ...canvasDrag.startViewport,
        x: canvasDrag.startViewport.x + event.clientX - canvasDrag.startX,
        y: canvasDrag.startViewport.y + event.clientY - canvasDrag.startY
      });
      return;
    }
    if (canvasDrag.type === "node") {
      const deltaX = (event.clientX - canvasDrag.startX) / canvasViewport.scale;
      const deltaY = (event.clientY - canvasDrag.startY) / canvasViewport.scale;
      updateCanvasNode(canvasDrag.nodeId, {
        x: Math.round(canvasDrag.startNode.x + deltaX),
        y: Math.round(canvasDrag.startNode.y + deltaY)
      });
    }
  }

  function endCanvasDrag(event) {
    if (!canvasDrag) return;
    event.currentTarget.releasePointerCapture?.(canvasDrag.pointerId);
    setCanvasDrag(null);
  }

  function beginCanvasConnection(nodeId) {
    setCanvasConnectStart((current) => current?.nodeId === nodeId ? null : { nodeId });
  }

  function completeCanvasConnection(targetNodeId) {
    if (!canvasConnectStart || canvasConnectStart.nodeId === targetNodeId) return;
    patchActiveCanvas((canvas) => {
      const exists = canvas.connections.some((connection) => (
        connection.fromNodeId === canvasConnectStart.nodeId && connection.toNodeId === targetNodeId
      ));
      if (exists) return {};
      return {
        connections: [
          ...canvas.connections,
          { id: makeResultId(), fromNodeId: canvasConnectStart.nodeId, toNodeId: targetNodeId }
        ]
      };
    });
    setCanvasConnectStart(null);
    addEvent("无限画布", "节点已连接");
  }

  function removeCanvasConnection(connectionId) {
    patchActiveCanvas((canvas) => ({
      connections: canvas.connections.filter((connection) => connection.id !== connectionId)
    }));
  }

  function incomingCanvasNodes(canvas, nodeId) {
    if (!canvas) return [];
    return canvas.connections
      .filter((connection) => connection.toNodeId === nodeId)
      .map((connection) => canvas.nodes.find((node) => node.id === connection.fromNodeId))
      .filter(Boolean);
  }

  function canvasResultItemsFromNode(node) {
    if (!node) return [];
    if (node.type === "image" && node.result) return [node.result];
    if (node.type === "output" && Array.isArray(node.results)) return node.results;
    return [];
  }

  function canvasPromptForGenerator(canvas, node) {
    const incoming = incomingCanvasNodes(canvas, node.id);
    const promptParts = incoming.flatMap((sourceNode) => {
      if (sourceNode.type === "prompt") return [sourceNode.text || ""];
      if (sourceNode.type === "image") return [sourceNode.prompt || sourceNode.result?.prompt || ""];
      if (sourceNode.type === "output") return [sourceNode.prompt || ""];
      return [];
    });
    promptParts.push(node.prompt || "");
    return promptParts.map((part) => part.trim()).filter(Boolean).join("\n\n");
  }

  function canvasImagesForGenerator(canvas, node) {
    return incomingCanvasNodes(canvas, node.id).flatMap(canvasResultItemsFromNode);
  }

  function canvasImageEntriesForGenerator(canvas, node) {
    return incomingCanvasNodes(canvas, node.id).flatMap((sourceNode) => (
      canvasResultItemsFromNode(sourceNode).map((result, index) => ({
        result,
        sourceNode,
        role: sourceNode.role || (sourceNode.type === "output" ? "reference" : "auto"),
        label: sourceNode.title || `图片 ${index + 1}`
      }))
    ));
  }

  function splitCanvasBatchEntries(entries) {
    const explicitModels = entries.filter((entry) => entry.role === "model");
    if (explicitModels.length > 0) {
      return {
        modelEntries: explicitModels,
        fixedEntries: entries.filter((entry) => entry.role !== "model")
      };
    }

    const fixedEntries = entries.filter((entry) => entry.role === "fixed" || entry.role === "reference");
    const autoEntries = entries.filter((entry) => entry.role === "auto");
    if (fixedEntries.length > 0) {
      return { modelEntries: autoEntries, fixedEntries };
    }
    if (autoEntries.length > 1) {
      return {
        modelEntries: autoEntries.slice(0, -1),
        fixedEntries: autoEntries.slice(-1)
      };
    }
    return { modelEntries: autoEntries, fixedEntries };
  }

  function buildCanvasBatchPrompt(basePrompt, modelIndex, modelTotal, fixedCount) {
    return [
      `批量换装任务 ${modelIndex + 1}/${modelTotal}：图1是当前模特图，只处理当前这一位模特。`,
      fixedCount > 0
        ? "图2开始是固定服装/产品参考图，必须让图1人物穿着固定服装图里的衣服，服装款式、版型、颜色、面料纹理、袖口、纽扣、拼接结构等关键细节保持一致。"
        : "没有标记固定服装图时，请按提示词完成当前模特的单独出图。",
      "保持当前模特的脸部身份、体型比例和自然姿态，不要融合其它模特，不要把多位模特放进同一张图。",
      basePrompt
    ].filter(Boolean).join("\n");
  }

  async function canvasFileFromResult(item, index) {
    const blob = await blobFromImageItem(item);
    return new File([blob], `canvas-ref-${index + 1}.${imageExtension(blob.type)}`, {
      type: blob.type || "image/png"
    });
  }

  async function addCanvasFiles(fileList, point = canvasCenterPoint()) {
    const picked = imageFilesFromList(fileList);
    if (picked.length === 0) return;
    const form = new FormData();
    picked.slice(0, 12).forEach((file) => form.append("image", file, file.name));
    try {
      const response = await fetch("/api/canvas-assets", {
        method: "POST",
        body: form
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.ok) throw new Error(payload?.message || `HTTP ${response.status}`);
      const nodes = (payload.assets || []).map((asset, index) => createCanvasNode("image", {
        title: asset.name || `图片 ${index + 1}`,
        x: point.x + index * 28,
        y: point.y + index * 28,
        result: {
          id: asset.id || makeResultId(),
          image: { type: "url", value: asset.url, localUrl: asset.url },
          prompt: "",
          modelLabel: "画布素材",
          imageSize: fileSize(asset.size),
          aspectRatio: "",
          referenceCount: 0,
          source: "infinite-canvas",
          originalName: asset.name,
          createdAt: asset.createdAt || Date.now() + index
        }
      }));
      patchActiveCanvas((canvas) => ({ nodes: [...canvas.nodes, ...nodes] }));
      if (nodes[0]) setCanvasSelectedNodeId(nodes[0].id);
      addEvent("无限画布", `已加入 ${nodes.length} 张图片节点`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      addEvent("无限画布上传失败", message);
    }
  }

  function handleCanvasDrop(event) {
    if (!Array.from(event.dataTransfer?.types || []).includes("Files")) return;
    event.preventDefault();
    void addCanvasFiles(event.dataTransfer.files, screenToCanvasPoint(event.clientX, event.clientY));
  }

  function sendResultToCanvas(item) {
    if (!item) return;
    const point = canvasCenterPoint(-CANVAS_NODE_WIDTH / 2, -CANVAS_NODE_HEIGHT / 2);
    const copy = {
      ...item,
      id: makeResultId(),
      source: "infinite-canvas",
      copiedFromResultId: item.id,
      copiedToCanvasAt: Date.now()
    };
    const node = createCanvasNode("image", {
      title: item.modelLabel || "跨模块图片",
      x: point.x,
      y: point.y,
      result: copy,
      prompt: item.prompt || ""
    });
    patchActiveCanvas((canvas) => ({
      nodes: [...canvas.nodes, node]
    }));
    setActiveView("infinite-canvas");
    setCanvasSelectedNodeId(node.id);
    addEvent("无限画布", "已发送副本到当前画布");
  }

  async function runCanvasImageRequest({ canvasId, nodeId, params, runModel, prompt, referenceItems, taskLabel }) {
    const taskId = makeResultId();
    const startedAt = Date.now();
    setCanvasTasks((current) => [{
      id: taskId,
      canvasId,
      nodeId,
      startedAt,
      prompt,
      taskLabel,
      modelLabel: runModel.label,
      imageSize: params.imageSize,
      aspectRatio: params.aspectRatio
    }, ...current]);

    try {
      const filesFromNodes = await Promise.all(referenceItems.slice(0, 6).map((item, index) => canvasFileFromResult(item, index)));
      const form = new FormData();
      form.set("baseUrl", config.defaultBaseUrl || settings.baseUrl || defaultState.baseUrl);
      form.set("apiKey", normalizeApiKeyInput(settings.apiKey));
      form.set("model", params.model);
      form.set("prompt", prompt);
      form.set("imageSize", params.imageSize);
    form.set("aspectRatio", params.aspectRatio);
    form.set("n", String(params.n));
    form.set("source", "infinite-canvas");
    form.set("referenceMeta", JSON.stringify(referenceItems.slice(0, 6).map((item, index) => ({
      name: item.originalName || item.modelLabel || item.taskLabel || `canvas-reference-${index + 1}`,
      role: item.source === "quickgen" ? "reference" : (item.source || "reference"),
      index,
      size: 0,
      type: ""
    }))));
    const upload = await prepareImageFilesForChannel(filesFromNodes);
      if (upload.compressedCount > 0) {
        addEvent("图片压缩", `画布节点已压缩 ${upload.compressedCount} 张素材到 4MB 内`);
      }
      upload.files.forEach((file) => form.append("image", file, file.name));

      const started = performance.now();
      const response = await fetch("/api/images", {
        method: "POST",
        body: form
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.ok) throw new Error(payload?.message || `HTTP ${response.status}`);
      if (!payload.images?.length) throw new Error("接口返回成功，但没有解析到图片");

      const totalMs = Number.isFinite(payload.timing?.totalMs) ? payload.timing.totalMs : performance.now() - started;
      const returnedItems = Array.isArray(payload.historyItems) && payload.historyItems.length > 0
        ? payload.historyItems
        : null;
      const nextResults = (returnedItems || payload.images).map((entry, index) => {
        const serverItem = returnedItems ? entry : null;
        return {
          ...serverItem,
          id: serverItem?.id || makeResultId(),
          image: serverItem?.image || entry,
          prompt,
          modelLabel: runModel.label,
          imageSize: params.imageSize,
          aspectRatio: params.aspectRatio,
          referenceCount: filesFromNodes.length,
          generationMs: totalMs,
          source: "infinite-canvas",
          canvasId,
          generatorNodeId: nodeId,
          taskLabel,
          createdAt: serverItem?.createdAt || Date.now() + index
        };
      });
      if (nextResults.length === 0) throw new Error("接口返回成功，但没有解析到图片");

      return {
        prompt,
        results: nextResults,
        totalMs,
        taskLabel
      };
    } finally {
      setCanvasTasks((current) => current.filter((task) => task.id !== taskId));
    }
  }

  async function generateCanvasNode(nodeId) {
    const canvas = activeCanvas;
    const node = canvas?.nodes.find((item) => item.id === nodeId);
    if (!canvas || !node || node.type !== "generator") return;
    if (!normalizeApiKeyInput(settings.apiKey) && !config.hasServerKey) {
      setIsSettingsOpen(true);
      addEvent("无限画布", "请先在设置里填写 API Key");
      updateCanvasNodeByCanvasId(canvas.id, nodeId, { status: "failed", error: "missing_api_key" });
      return;
    }

    const prompt = canvasPromptForGenerator(canvas, node);
    if (!prompt) {
      updateCanvasNodeByCanvasId(canvas.id, nodeId, { status: "failed", error: "请连接提示词节点，或在生图节点里输入提示词" });
      addEvent("无限画布", "缺少提示词");
      return;
    }

    const params = {
      model: node.params?.model || settings.model,
      imageSize: node.params?.imageSize || settings.imageSize,
      aspectRatio: node.params?.aspectRatio || settings.aspectRatio,
      n: clampCount(node.params?.n || 1),
      batchMode: node.params?.batchMode || "single"
    };
    const runModel = models.find((item) => item.value === params.model) || models[0];
    const imageEntries = canvasImageEntriesForGenerator(canvas, node);
    const startedAt = Date.now();
    updateCanvasNodeByCanvasId(canvas.id, nodeId, { status: "running", error: "", generationMs: null });

    try {
      const runs = params.batchMode === "by-model"
        ? (() => {
            const { modelEntries, fixedEntries } = splitCanvasBatchEntries(imageEntries);
            if (modelEntries.length === 0) {
              throw new Error("按模特批量需要至少连接一张模特图");
            }
            return modelEntries.map((entry, index) => ({
              prompt: buildCanvasBatchPrompt(prompt, index, modelEntries.length, fixedEntries.length),
              referenceItems: [entry.result, ...fixedEntries.map((item) => item.result)],
              taskLabel: `模特 ${index + 1}/${modelEntries.length}`,
              yOffset: index * 42
            }));
          })()
        : [{
            prompt,
            referenceItems: imageEntries.map((entry) => entry.result),
            taskLabel: "单次生成",
            yOffset: 0
          }];

      addEvent("无限画布", params.batchMode === "by-model"
        ? `并发提交 ${runs.length} 个模特任务`
        : `${runModel.label} / ${params.imageSize} / ${params.aspectRatio}`);

      const settled = await Promise.allSettled(runs.map((run) => runCanvasImageRequest({
        canvasId: canvas.id,
        nodeId,
        params,
        runModel,
        prompt: run.prompt,
        referenceItems: run.referenceItems,
        taskLabel: run.taskLabel
      })));

      const successfulRuns = settled
        .map((item, index) => ({ item, index }))
        .filter(({ item }) => item.status === "fulfilled")
        .map(({ item, index }) => ({ ...item.value, index }));
      const failedRuns = settled.filter((item) => item.status === "rejected");
      if (successfulRuns.length === 0) {
        const firstError = failedRuns[0]?.reason;
        throw firstError instanceof Error ? firstError : new Error(String(firstError || "画布批量生成失败"));
      }

      const outputNodes = successfulRuns.map((run) => createCanvasNode("output", {
        title: params.batchMode === "by-model" ? run.taskLabel : `输出 ${new Date().toLocaleTimeString("zh-CN", { hour12: false })}`,
        x: node.x + node.w + 86,
        y: node.y + (params.batchMode === "by-model" ? run.index * (CANVAS_NODE_HEIGHT + 24) : Math.max(0, canvas.nodes.filter((item) => item.type === "output").length % 4) * 36),
        results: run.results,
        prompt: run.prompt,
        generationMs: run.totalMs,
        status: "success"
      }));
      const allResults = successfulRuns.flatMap((run) => run.results);
      patchCanvasById(canvas.id, (currentCanvas) => ({
        nodes: [...currentCanvas.nodes, ...outputNodes],
        connections: [
          ...currentCanvas.connections,
          ...outputNodes.map((outputNode) => ({ id: makeResultId(), fromNodeId: nodeId, toNodeId: outputNode.id }))
        ]
      }));
      setResults((current) => [...allResults, ...current]);
      void saveHistoryResults(allResults);
      updateCanvasNodeByCanvasId(canvas.id, nodeId, {
        status: failedRuns.length > 0 ? "partial" : "success",
        generationMs: Date.now() - startedAt,
        error: failedRuns.length > 0 ? `${failedRuns.length} 个任务失败，其余已输出` : ""
      });
      if (outputNodes[0]) setCanvasSelectedNodeId(outputNodes[0].id);
      addEvent("无限画布", failedRuns.length > 0
        ? `完成 ${allResults.length} 张，${failedRuns.length} 个任务失败`
        : `生成 ${allResults.length} 张，用时 ${formatMs(Date.now() - startedAt)}`);
    } catch (err) {
      const message = normalizeGenerationErrorMessage(err instanceof Error ? err.message : String(err));
      if (isAuthErrorMessage(message)) setIsSettingsOpen(true);
      updateCanvasNodeByCanvasId(canvas.id, nodeId, { status: "failed", error: message, generationMs: Date.now() - startedAt });
      addEvent("无限画布失败", message);
    }
  }

  function addEvent(label, detail) {
    setEvents((current) => [
      { time: new Date().toLocaleTimeString("zh-CN", { hour12: false }), label, detail },
      ...current
    ].slice(0, 6));
  }

  function addDetailFiles(role, fileList) {
    const picked = imageFilesFromList(fileList);
    if (picked.length === 0) return;
    const used = role === "product" ? detailProductFiles.length : detailReferenceFiles.length;
    const remaining = MAX_DETAIL_FILES - used;
    if (remaining <= 0) {
      addEvent("一键详情", `${role === "product" ? "产品图" : "参考图"}最多 ${MAX_DETAIL_FILES} 张`);
      return;
    }
    const accepted = picked.slice(0, remaining);
    if (role === "product") {
      setDetailProductFiles((current) => [...current, ...accepted]);
    } else {
      setDetailReferenceFiles((current) => [...current, ...accepted]);
    }
    addEvent("一键详情", `已添加 ${accepted.length} 张${role === "product" ? "产品图" : "参考图"}`);
  }

  function removeDetailFile(role, index) {
    if (role === "product") {
      setDetailProductFiles((current) => current.filter((_, itemIndex) => itemIndex !== index));
    } else {
      setDetailReferenceFiles((current) => current.filter((_, itemIndex) => itemIndex !== index));
    }
  }

  function addReferenceRewriteFiles(role, fileList) {
    const picked = imageFilesFromList(fileList);
    if (picked.length === 0) return;
    const used = referenceProductFiles.length + referenceStyleFiles.length;
    const remaining = MAX_REFERENCE_REWRITE_FILES - used;
    if (remaining <= 0) {
      addEvent("参考生图", `产品图和参考图合计最多 ${MAX_REFERENCE_REWRITE_FILES} 张`);
      return;
    }
    const accepted = picked.slice(0, remaining);
    if (role === "product") {
      setReferenceProductFiles((current) => [...current, ...accepted]);
    } else {
      setReferenceStyleFiles((current) => [...current, ...accepted]);
    }
    addEvent("参考生图", `已添加 ${accepted.length} 张${role === "product" ? "产品图" : "参考图"}`);
  }

  function removeReferenceRewriteFile(role, index) {
    if (role === "product") {
      setReferenceProductFiles((current) => current.filter((_, itemIndex) => itemIndex !== index));
    } else {
      setReferenceStyleFiles((current) => current.filter((_, itemIndex) => itemIndex !== index));
    }
  }

  function appendReferenceFiles(fileList, options = {}) {
    const picked = imageFilesFromList(fileList);
    if (picked.length === 0) return;
    setFiles((current) => {
      const remaining = MAX_REFERENCE_FILES - current.length;
      if (remaining <= 0) {
        addEvent("提示", `最多上传 ${MAX_REFERENCE_FILES} 张参考图`);
        return current;
      }
      const accepted = picked.slice(0, remaining).map(makeQuickReferenceItem);
      addEvent(options.eventLabel || "上传", `${options.actionText || "追加"} ${accepted.length} 张参考图`);
      return [...current, ...accepted];
    });
  }

  function replaceReferenceFiles(index, fileList) {
    const picked = imageFilesFromList(fileList);
    if (picked.length === 0) return;
    setFiles((current) => {
      if (index < 0 || index >= current.length) return current;
      const next = [...current];
      next[index] = makeQuickReferenceItem(picked[0]);
      const remaining = MAX_REFERENCE_FILES - next.length;
      if (remaining > 0 && picked.length > 1) {
        next.splice(index + 1, 0, ...picked.slice(1, remaining + 1).map(makeQuickReferenceItem));
      }
      addEvent("参考图", `已替换图${index + 1}`);
      return next;
    });
  }

  function insertReferenceFiles(index, fileList) {
    const picked = imageFilesFromList(fileList);
    if (picked.length === 0) return;
    setFiles((current) => {
      const remaining = MAX_REFERENCE_FILES - current.length;
      if (remaining <= 0) {
        addEvent("提示", `最多上传 ${MAX_REFERENCE_FILES} 张参考图`);
        return current;
      }
      const accepted = picked.slice(0, remaining).map(makeQuickReferenceItem);
      const next = [...current];
      next.splice(Math.max(0, Math.min(index, next.length)), 0, ...accepted);
      addEvent("参考图", `已插入 ${accepted.length} 张参考图`);
      return next;
    });
  }

  function onPickFiles(event) {
    appendReferenceFiles(event.target.files);
    event.target.value = "";
  }

  function isReferenceDropData(dataTransfer) {
    const types = Array.from(dataTransfer?.types || []);
    return types.includes("Files")
      || types.includes("application/x-jingyin-result-id")
      || types.includes("text/uri-list")
      || types.includes("text/plain");
  }

  function onComposerDragOver(event) {
    if (!isReferenceDropData(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setIsComposerDragging(true);
  }

  function onComposerDragLeave(event) {
    if (event.relatedTarget && event.currentTarget.contains(event.relatedTarget)) return;
    setIsComposerDragging(false);
  }

  function onComposerDrop(event) {
    event.preventDefault();
    setIsComposerDragging(false);
    setReferenceDropTarget(null);
    void imageFilesFromReferenceDrop(event.dataTransfer)
      .then((droppedFiles) => appendReferenceFiles(droppedFiles))
      .catch((err) => addEvent("拖拽上传失败", err instanceof Error ? err.message : String(err)));
  }

  function onComposerPaste(event) {
    const pastedImages = imageFilesFromClipboard(event.clipboardData);
    if (pastedImages.length === 0) return;
    event.preventDefault();
    appendReferenceFiles(pastedImages, {
      eventLabel: "粘贴上传",
      actionText: "已从剪贴板添加"
    });
  }

  function removeReferenceImage(index) {
    setFiles((current) => {
      const removed = current[index];
      if (quickCropEditTarget?.id && removed?.id === quickCropEditTarget.id) {
        setQuickCropEditTarget(null);
      }
      if (quickLocalEditTarget?.id && removed?.id === quickLocalEditTarget.id) {
        setQuickLocalEditTarget(null);
      }
      return current.filter((_, itemIndex) => itemIndex !== index);
    });
  }

  function openQuickCropEdit(item) {
    if (!item?.id) return;
    setQuickCropEditTarget(item);
  }

  function openQuickLocalEdit(item) {
    if (!item?.id) return;
    if (!QUICK_LOCAL_EDIT_RATIOS.includes(settings.aspectRatio)) {
      updateSetting("aspectRatio", QUICK_LOCAL_EDIT_RATIOS[0]);
    }
    setQuickLocalEditTarget(item);
  }

  function applyQuickCropEdit(itemId, cropped) {
    setFiles((current) => current.map((item) => {
      if (item.id !== itemId) return item;
      return {
        ...item,
        cropEdit: {
          cropFile: cropped.file,
          cropRect: cropped.cropRect,
          sourceWidth: cropped.sourceWidth,
          sourceHeight: cropped.sourceHeight,
          aspectRatio: cropped.aspectRatio || settings.aspectRatio,
          appliedAt: Date.now()
        },
        localEdit: null
      };
    }));
    setQuickCropEditTarget(null);
    addEvent("普通裁剪", "已启用普通裁剪，生成结果不会贴回原图");
  }

  function applyQuickLocalEdit(itemId, cropped) {
    const nextRatio = QUICK_LOCAL_EDIT_RATIOS.includes(cropped.aspectRatio) ? cropped.aspectRatio : QUICK_LOCAL_EDIT_RATIOS[0];
    updateSetting("aspectRatio", nextRatio);
    setFiles((current) => current.map((item) => {
      if (item.id !== itemId) return item;
      return {
        ...item,
        cropEdit: null,
        localEdit: {
          cropFile: cropped.file,
          cropRect: cropped.cropRect,
          contextRect: cropped.contextRect || null,
          sourceWidth: cropped.sourceWidth,
          sourceHeight: cropped.sourceHeight,
          aspectRatio: nextRatio,
          editMode: cropped.editMode || LOCAL_EDIT_RECT_MODE,
          maskDataUrl: cropped.maskDataUrl || "",
          maskBounds: cropped.maskBounds || null,
          brushSize: cropped.brushSize || LOCAL_EDIT_BRUSH_DEFAULT,
          maskOpacity: cropped.maskOpacity || LOCAL_EDIT_MASK_OPACITY_DEFAULT,
          appliedAt: Date.now()
        }
      };
    }));
    setQuickLocalEditTarget(null);
    addEvent("局部编辑", cropped.editMode === LOCAL_EDIT_MASK_MODE ? "已启用涂抹蒙版，生成后只回贴涂抹区域" : "已启用局部裁剪，生成后会贴回原图");
  }

  function clearQuickCropEdit(itemId) {
    setFiles((current) => current.map((item) => (
      item.id === itemId ? { ...item, cropEdit: null } : item
    )));
    setQuickCropEditTarget(null);
    addEvent("普通裁剪", "已取消普通裁剪");
  }

  function clearQuickLocalEdit(itemId) {
    setFiles((current) => current.map((item) => (
      item.id === itemId ? { ...item, localEdit: null } : item
    )));
    setQuickLocalEditTarget(null);
    addEvent("局部编辑", "已取消局部裁剪");
  }

  function beginReferenceDrop(event, type, index) {
    if (!isReferenceDropData(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "copy";
    setReferenceDropTarget({ type, index });
  }

  function endReferenceDrop() {
    setReferenceDropTarget(null);
  }

  function onReferenceDrop(event, type, index) {
    event.preventDefault();
    event.stopPropagation();
    setIsComposerDragging(false);
    setReferenceDropTarget(null);
    void imageFilesFromReferenceDrop(event.dataTransfer)
      .then((droppedFiles) => {
        if (type === "replace") replaceReferenceFiles(index, droppedFiles);
        else insertReferenceFiles(index, droppedFiles);
      })
      .catch((err) => addEvent("拖拽上传失败", err instanceof Error ? err.message : String(err)));
  }

  function toggleSelected(id) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function clearSelection() {
    setSelectedIds(new Set());
  }

  function deleteSelected() {
    if (selectedIds.size === 0) return;
    const ids = activeView === "quickgen"
      ? quickResults.filter((item) => selectedIds.has(item.id)).map((item) => item.id)
      : Array.from(selectedIds);
    if (ids.length === 0) return;
    setResults((current) => current.filter((item) => !ids.includes(item.id)));
    removeDetailResultIds(ids);
    void removeHistoryResults(ids);
    clearSelection();
    addEvent("删除", `已删除 ${ids.length} 张图片`);
  }

  function deleteResult(id) {
    setResults((current) => current.filter((item) => item.id !== id));
    removeDetailResultIds([id]);
    void removeHistoryResults([id]);
    setSelectedIds((current) => {
      const next = new Set(current);
      next.delete(id);
      return next;
    });
    if (detailInfoSelection?.resultId === id) setDetailInfoSelection(null);
    addEvent("删除", "已删除当前图片");
  }

  function removeDetailResultIds(ids) {
    setDetailGroups((current) => current.map((group) => ({
      ...group,
      prompts: group.prompts.map((prompt) => ({
        ...prompt,
        results: (prompt.results || []).filter((result) => !ids.includes(result.id))
      }))
    })));
  }

  function clearAll() {
    const targetResults = activeView === "reference-remix" ? referenceResults : quickResults;
    const moduleName = activeView === "reference-remix" ? "参考生图" : "快捷生成";
    const confirmed = window.confirm(`确定清空${moduleName}历史记录吗？这个操作不会影响其他模块。`);
    if (!confirmed) return;
    const ids = targetResults.map((item) => item.id);
    setResults((current) => current.filter((item) => !ids.includes(item.id)));
    setSelectedIds((current) => {
      const next = new Set(current);
      ids.forEach((id) => next.delete(id));
      return next;
    });
    if (activeView === "reference-remix") {
      setReferenceProductFiles([]);
      setReferenceStyleFiles([]);
      setReferenceTasks([]);
      setReferenceStatus("idle");
      setReferenceError("");
    } else {
      setFiles([]);
      setQuickLocalEditTarget(null);
      setTiming(null);
      setError("");
      setStatus("idle");
      setQuickTasks([]);
    }
    setEvents([]);
    void removeHistoryResults(ids);
  }

  async function refreshHistory() {
    const storedResults = await loadHistoryResults();
    setResults(storedResults);
    setDetailGroups((current) => hydrateDetailGroupsWithHistory(current, storedResults));
    clearSelection();
    addEvent("刷新", `已载入 ${storedResults.length} 张历史图片`);
  }

  async function syncHistoryFromServer() {
    const storedResults = await loadHistoryResults();
    setResults(storedResults);
    setDetailGroups((current) => hydrateDetailGroupsWithHistory(current, storedResults));
  }

  async function refreshSaveDirectory() {
    try {
      const response = await fetch("/api/save-directory");
      const payload = await response.json();
      if (!response.ok || !payload?.ok) throw new Error(payload?.message || "读取保存目录失败");
      setSaveDirectory(payload.directory);
      setDirectoryDraft(payload.directory);
      return payload.directory;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      addEvent("保存目录", message);
      return "";
    }
  }

  function openDirectoryModal() {
    setDirectoryDraft(saveDirectory);
    setIsDirectoryModalOpen(true);
  }

  async function confirmSaveDirectory() {
    try {
      const response = await fetch("/api/save-directory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ directory: directoryDraft })
      });
      const payload = await response.json();
      if (!response.ok || !payload?.ok) throw new Error(payload?.message || "保存目录设置失败");
      setSaveDirectory(payload.directory);
      setDirectoryDraft(payload.directory);
      setIsDirectoryModalOpen(false);
      addEvent("保存目录", "目录已更新");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      addEvent("保存目录失败", message);
    }
  }

  async function pickSaveDirectory() {
    if (isPickingDirectory) return;
    setIsPickingDirectory(true);
    try {
      const response = await fetch("/api/pick-directory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ directory: directoryDraft || saveDirectory })
      });
      const payload = await response.json();
      if (!response.ok || !payload?.ok) throw new Error(payload?.message || "目录选择失败");
      if (!payload.cancelled && payload.directory) {
        setDirectoryDraft(payload.directory);
        addEvent("保存目录", "已选择目录，点击确定后生效");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      addEvent("目录选择失败", message);
    } finally {
      setIsPickingDirectory(false);
    }
  }

  function openSaveDirectory() {
    const sendOpenRequest = (directory) => {
      addEvent("保存目录", "正在打开保存目录");
      fetch("/api/open-save-directory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ directory })
      }).then(async (response) => {
        const payload = await response.json().catch(() => null);
        if (!response.ok || !payload?.ok) throw new Error(payload?.message || "打开保存目录失败");
        setSaveDirectory(payload.directory);
        setDirectoryDraft((current) => current || payload.directory);
        addEvent("保存目录", `已打开 ${payload.directory}`);
      }).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        addEvent("打开失败", message);
      });
    };

    const directory = saveDirectory || directoryDraft;
    if (directory) {
      sendOpenRequest(directory);
      return;
    }

    void refreshSaveDirectory().then((nextDirectory) => {
      if (nextDirectory) sendOpenRequest(nextDirectory);
    });
  }

  async function saveProcessedImageFile(file, subfolder = "") {
    const directory = saveDirectory || await refreshSaveDirectory();
    if (!directory) throw new Error("未找到指定文件夹");
    const form = new FormData();
    form.append("directory", directory);
    form.append("subfolder", subfolder || "");
    form.append("image", file, file.name || `image-${Date.now()}.jpg`);
    const response = await fetch("/api/save-processed-image", {
      method: "POST",
      body: form
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) throw new Error(payload?.message || "保存图片失败");
    setSaveDirectory(payload.directory);
    setDirectoryDraft(payload.directory);
    return payload;
  }

  function changeGalleryZoom(delta) {
    setGalleryZoom((current) => Math.max(0.75, Math.min(1.45, Number((current + delta).toFixed(2)))));
  }

  function onQuickBoardWheel(event) {
    const gallery = quickGalleryRef.current;
    if (!gallery) return;
    if (event.target?.closest?.("textarea,input,select,.composerReferences")) return;
    if (gallery.contains(event.target)) return;
    if (gallery.scrollHeight <= gallery.clientHeight) return;
    event.preventDefault();
    gallery.scrollTop += event.deltaY;
  }

  function autoSaveEventText(payload, overrideCount = null) {
    const count = Number((overrideCount ?? payload?.autoSavedCount) || 0);
    return count > 0 ? `，已自动保存 ${count} 张` : "";
  }

  async function copyText(text, successMessage = "已复制") {
    if (!text) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const field = document.createElement("textarea");
        field.value = text;
        field.style.position = "fixed";
        field.style.opacity = "0";
        document.body.appendChild(field);
        field.select();
        document.execCommand("copy");
        document.body.removeChild(field);
      }
      addEvent("复制", successMessage);
    } catch {
      addEvent("复制失败", "浏览器没有允许剪贴板权限");
    }
  }

  async function blobFromImageItem(item) {
    const src = imageSourceFromResult(item?.image);
    if (!src) throw new Error("图片地址无效");
    const requestUrl = displayImageRequestUrl(src);
    const response = await fetch(requestUrl);
    if (!response.ok) throw new Error(`图片下载失败 HTTP ${response.status}`);
    return response.blob();
  }

  function dataUrlFromBlob(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(reader.error || new Error("长图编码失败"));
      reader.readAsDataURL(blob);
    });
  }

  function findGeneratedResultById(id) {
    if (!id) return null;
    return results.find((item) => item.id === id)
      || detailGroups.flatMap((group) => group.prompts || []).flatMap((prompt) => prompt.results || []).find((item) => item.id === id)
      || null;
  }

  async function fileFromImageUrl(url, name = `drag-${Date.now()}`) {
    const response = await fetch(displayImageRequestUrl(url));
    if (!response.ok) throw new Error(`图片读取失败 HTTP ${response.status}`);
    const blob = await response.blob();
    return new File([blob], `${fileBaseName(name)}.${imageExtension(blob.type)}`, {
      type: blob.type || "image/png",
      lastModified: Date.now()
    });
  }

  async function imageFilesFromReferenceDrop(dataTransfer) {
    const resultId = dataTransfer?.getData?.("application/x-jingyin-result-id") || "";
    if (resultId) {
      const item = findGeneratedResultById(resultId);
      if (item) {
        const blob = await blobFromImageItem(item);
        return [new File([blob], `${fileBaseName(item.modelLabel || "result")}-${Date.now()}.${imageExtension(blob.type)}`, {
          type: blob.type || "image/png",
          lastModified: Date.now()
        })];
      }
    }

    const directFiles = imageFilesFromList(dataTransfer?.files);
    if (directFiles.length > 0) return directFiles;

    const uri = String(dataTransfer?.getData?.("text/uri-list") || dataTransfer?.getData?.("text/plain") || "")
      .split(/\r?\n/)
      .find((line) => line && !line.startsWith("#"));
    if (uri && (/^https?:\/\//i.test(uri) || uri.startsWith("/") || uri.startsWith("data:"))) {
      return [await fileFromImageUrl(uri, "drag-image")];
    }
    return [];
  }

  function beginResultImageDrag(event, item) {
    const src = imageSourceFromResult(item?.image);
    if (!src) return;
    event.dataTransfer.effectAllowed = "copy";
    event.dataTransfer.setData("application/x-jingyin-result-id", item.id || "");
    event.dataTransfer.setData("text/uri-list", src);
    event.dataTransfer.setData("text/plain", src);
  }

  async function bitmapFromBlob(blob) {
    if (window.createImageBitmap) {
      return window.createImageBitmap(blob);
    }
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve(img);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("长图素材读取失败"));
      };
      img.src = url;
    });
  }

  async function stitchDetailGroupBlob(group) {
    const items = detailResultItemsForGroup(group);
    if (items.length === 0) throw new Error("暂无可拼接的分屏图片");
    const bitmaps = [];
    try {
      for (const { result } of items) {
        const blob = await blobFromImageItem(result);
        bitmaps.push(await bitmapFromBlob(blob));
      }
      const maxSourceWidth = Math.max(...bitmaps.map((bitmap) => bitmap.width || bitmap.naturalWidth || 1));
      const sourceHeights = bitmaps.map((bitmap) => bitmap.height || bitmap.naturalHeight || 1);
      let targetWidth = Math.min(1600, maxSourceWidth);
      let targetHeights = bitmaps.map((bitmap, index) => {
        const width = bitmap.width || bitmap.naturalWidth || targetWidth;
        return Math.max(1, Math.round(sourceHeights[index] * (targetWidth / width)));
      });
      let totalHeight = targetHeights.reduce((sum, height) => sum + height, 0);
      if (totalHeight > 30000) {
        targetWidth = Math.max(720, Math.round(targetWidth * (30000 / totalHeight)));
        targetHeights = bitmaps.map((bitmap, index) => {
          const width = bitmap.width || bitmap.naturalWidth || targetWidth;
          return Math.max(1, Math.round(sourceHeights[index] * (targetWidth / width)));
        });
        totalHeight = targetHeights.reduce((sum, height) => sum + height, 0);
      }
      const canvas = document.createElement("canvas");
      canvas.width = targetWidth;
      canvas.height = totalHeight;
      const ctx = canvas.getContext("2d", { alpha: false });
      if (!ctx) throw new Error("长图画布创建失败");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      let y = 0;
      bitmaps.forEach((bitmap, index) => {
        ctx.drawImage(bitmap, 0, y, targetWidth, targetHeights[index]);
        y += targetHeights[index];
      });
      return await canvasToBlob(canvas, "image/jpeg", 0.92);
    } finally {
      bitmaps.forEach((bitmap) => bitmap.close?.());
    }
  }

  async function downloadStitchPreview(group) {
    try {
      const directory = saveDirectory || await refreshSaveDirectory();
      const blob = await stitchDetailGroupBlob(group);
      const dataUrl = await dataUrlFromBlob(blob);
      const response = await fetch("/api/save-image", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          directory,
          item: {
            id: `${group.id}_stitch_${Date.now()}`,
            image: { type: "b64_json", value: dataUrl },
            modelLabel: "详情长图",
            imageSize: `${detailResultItemsForGroup(group).length}屏`,
            aspectRatio: "long",
            createdAt: Date.now()
          }
        })
      });
      const payload = await response.json();
      if (!response.ok || !payload?.ok) throw new Error(payload?.message || "保存长图失败");
      setSaveDirectory(payload.directory);
      setDirectoryDraft(payload.directory);
      addEvent("拼图下载", `长图已保存到 ${payload.filename}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      addEvent("拼图下载失败", message);
    }
  }

  async function copyImage(item) {
    const src = imageSourceFromResult(item?.image);
    try {
      const blob = await blobFromImageItem(item);
      if (navigator.clipboard?.write && window.ClipboardItem) {
        await navigator.clipboard.write([new window.ClipboardItem({ [blob.type || "image/png"]: blob })]);
        addEvent("复制", "图片已复制到剪贴板");
        return;
      }
      await copyText(src, "图片地址已复制");
    } catch {
      await copyText(src, "图片地址已复制");
    }
  }

  async function downloadItem(item, index = 0) {
    try {
      const directory = saveDirectory || await refreshSaveDirectory();
      const response = await fetch("/api/save-image", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          directory,
          item
        })
      });
      const payload = await response.json();
      if (!response.ok || !payload?.ok) throw new Error(payload?.message || "保存图片失败");
      setSaveDirectory(payload.directory);
      setDirectoryDraft(payload.directory);
      flashDownloadFeedback(item.id);
      addEvent("下载", `已保存到 ${payload.filename}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      addEvent("下载失败", message);
    }
  }

  async function autoSaveGeneratedItems(items) {
    if (!items?.length) return 0;
    let savedCount = 0;
    try {
      const directory = saveDirectory || await refreshSaveDirectory();
      for (const item of items) {
        const response = await fetch("/api/save-image", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            directory,
            item
          })
        });
        const payload = await response.json().catch(() => null);
        if (!response.ok || !payload?.ok) throw new Error(payload?.message || "保存图片失败");
        setSaveDirectory(payload.directory);
        setDirectoryDraft(payload.directory);
        savedCount += 1;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      addEvent("自动保存失败", message);
    }
    return savedCount;
  }

  function flashDownloadFeedback(id) {
    if (!id) return;
    setDownloadFeedbackIds((current) => {
      const next = new Set(current);
      next.add(id);
      return next;
    });
    const previousTimer = downloadFeedbackTimersRef.current.get(id);
    if (previousTimer) window.clearTimeout(previousTimer);
    const timer = window.setTimeout(() => {
      setDownloadFeedbackIds((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
      downloadFeedbackTimersRef.current.delete(id);
    }, 1300);
    downloadFeedbackTimersRef.current.set(id, timer);
  }

  async function downloadSelected() {
    let saved = 0;
    for (const [index, item] of quickResults.entries()) {
      if (selectedIds.has(item.id)) void downloadItem(item, index);
      if (selectedIds.has(item.id)) saved += 1;
    }
    if (saved > 0) addEvent("下载选中", `已提交 ${saved} 张保存任务`);
  }

  async function downloadAll() {
    quickResults.forEach((item, index) => void downloadItem(item, index));
    if (quickResults.length > 0) addEvent("下载全部", `已提交 ${quickResults.length} 张保存任务`);
  }

  async function optimizePrompt() {
    if (isQuickPromptOptimizing) return;
    const apiKey = normalizeApiKeyInput(settings.apiKey);
    if (!apiKey && !config.hasServerKey) {
      setError("请先在左下角设置里填写 API Key，优化提示词需要调用当前渠道文本模型");
      setIsSettingsOpen(true);
      addEvent("优化提示词", "请先保存 API Key 后再优化");
      return;
    }

    setIsQuickPromptOptimizing(true);
    setError("");
    try {
      const quickFiles = quickReferenceUploadFiles(files.map(normalizeQuickReferenceItem).filter(Boolean));
      const upload = await prepareImageFilesForChannel(quickFiles);
      if (upload.compressedCount > 0) {
        addEvent("图片压缩", `优化提示词已压缩 ${upload.compressedCount} 张参考图到 4MB 内`);
      }

      const form = new FormData();
      form.set("payload", JSON.stringify({
        prompt: settings.prompt,
        model: settings.model,
        imageSize: settings.imageSize,
        aspectRatio: settings.aspectRatio,
        n: settings.n,
        apiKey,
        baseUrl: config.defaultBaseUrl || settings.baseUrl || defaultState.baseUrl,
        detailAnalysisModel: DETAIL_ANALYSIS_MODEL,
        referenceImages: upload.files.map((file) => ({ name: file.name, size: file.size, type: file.type }))
      }));
      upload.files.forEach((file) => form.append("image", file, file.name));

      const response = await fetch("/api/quick-prompt-rewrite", {
        method: "POST",
        body: form
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.ok) {
        const message = payload?.message || `HTTP ${response.status}`;
        if (isAuthErrorMessage(message)) {
          setIsSettingsOpen(true);
          throw new Error(message);
        }
        if (payload?.fallbackPrompt) {
          updateSetting("prompt", payload.fallbackPrompt);
          addEvent("优化提示词", "文本模型优化失败，已使用保守 Skill 兜底");
        }
        throw new Error(message);
      }

      updateSetting("prompt", payload.prompt || settings.prompt);
      addEvent("优化提示词", `文本模型优化完成，${payload.mode === "ai-vision" ? "已读取参考图" : "纯文本优化"}`);
    } catch (err) {
      const message = normalizeGenerationErrorMessage(err instanceof Error ? err.message : String(err));
      setError(message);
      addEvent("优化提示词失败", message);
    } finally {
      setIsQuickPromptOptimizing(false);
    }
  }

  function applyPromptPreset(preset) {
    updateSetting("prompt", preset.content);
    setIsPromptAssistantOpen(false);
    addEvent("提示词", `已应用「${preset.title}」`);
  }

  function promptFallbackCategory(excluded = "") {
    return promptCategories.find((category) => category !== "全部" && category !== excluded) || "常用";
  }

  function editPromptPreset(preset) {
    setEditingPrompt({ ...preset });
  }

  function addPromptCategory() {
    const input = window.prompt("请输入新分类名称", "");
    const name = normalizePromptCategoryName(input);
    if (!name) return;
    if (name === "全部") {
      addEvent("提示词分类", "「全部」是系统分类，不能新建同名分类");
      return;
    }
    if (promptCategories.includes(name)) {
      setPromptCategory(name);
      addEvent("提示词分类", `「${name}」已存在`);
      return;
    }
    setPromptCategories((current) => normalizePromptCategories([...current, name]));
    setPromptCategory(name);
    addEvent("提示词分类", `已新建「${name}」`);
  }

  function renamePromptCategory(category) {
    if (!category || category === "全部") return;
    const input = window.prompt("修改分类名称", category);
    const nextName = normalizePromptCategoryName(input);
    if (!nextName || nextName === category) return;
    if (nextName === "全部") {
      addEvent("提示词分类", "不能改成系统分类「全部」");
      return;
    }
    if (promptCategories.includes(nextName)) {
      addEvent("提示词分类", `「${nextName}」已存在`);
      return;
    }
    setPromptCategories((current) => current.map((item) => item === category ? nextName : item));
    setPromptPresets((current) => current.map((preset) => (
      preset.category === category ? { ...preset, category: nextName } : preset
    )));
    if (promptCategory === category) setPromptCategory(nextName);
    if (editingPrompt?.category === category) updateEditingPrompt("category", nextName);
    addEvent("提示词分类", `已改名为「${nextName}」`);
  }

  function deletePromptCategory(category) {
    if (!category || category === "全部") return;
    const fallback = promptFallbackCategory(category);
    const shouldDelete = window.confirm(`删除分类「${category}」？里面的提示词会移动到「${fallback}」。`);
    if (!shouldDelete) return;
    setPromptCategories((current) => normalizePromptCategories(current.filter((item) => item !== category)));
    setPromptPresets((current) => current.map((preset) => (
      preset.category === category ? { ...preset, category: fallback } : preset
    )));
    if (promptCategory === category) setPromptCategory(fallback);
    if (editingPrompt?.category === category) updateEditingPrompt("category", fallback);
    addEvent("提示词分类", `已删除「${category}」，提示词已移动到「${fallback}」`);
  }

  function deletePromptPreset(preset) {
    setPromptPresets((current) => current.filter((item) => item.id !== preset.id));
    if (editingPrompt?.id === preset.id) setEditingPrompt(null);
    addEvent("提示词", "已删除提示词");
  }

  function beginPromptDrag(event, presetId) {
    setDraggedPromptId(presetId);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", presetId);
  }

  function endPromptDrag() {
    setDraggedPromptId(null);
    setPromptDropCategory("");
  }

  function promptIdFromDrag(event) {
    return draggedPromptId || event.dataTransfer.getData("text/plain");
  }

  function promptCategoryFromDrag(event) {
    return draggedPromptCategory || event.dataTransfer.getData(PROMPT_CATEGORY_DRAG_TYPE);
  }

  function isPromptCategoryDrag(event) {
    return Boolean(
      draggedPromptCategory
      || Array.from(event.dataTransfer?.types || []).includes(PROMPT_CATEGORY_DRAG_TYPE)
    );
  }

  function promptCategoryDropEdge(event) {
    const rect = event.currentTarget.getBoundingClientRect();
    return event.clientX > rect.left + rect.width / 2 ? "after" : "before";
  }

  function beginPromptCategoryDrag(event, category) {
    if (!category || category === "全部") return;
    setDraggedPromptCategory(category);
    setPromptDropCategory("");
    setPromptCategoryDropTarget(null);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(PROMPT_CATEGORY_DRAG_TYPE, category);
  }

  function endPromptCategoryDrag() {
    setDraggedPromptCategory("");
    setPromptCategoryDropTarget(null);
  }

  function dragPromptCategoryOver(event, category) {
    if (category === "全部") return;
    if (isPromptCategoryDrag(event)) {
      const source = promptCategoryFromDrag(event);
      if (!source || source === category) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      setPromptCategoryDropTarget({ category, edge: promptCategoryDropEdge(event) });
      return;
    }

    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setPromptDropCategory(category);
  }

  function dropPromptCategoryOnCategory(event, category) {
    const source = promptCategoryFromDrag(event);
    if (!source || source === "全部" || !category || category === "全部" || source === category) return false;
    event.preventDefault();
    const dropTarget = promptCategoryDropTarget?.category === category
      ? promptCategoryDropTarget
      : { category, edge: promptCategoryDropEdge(event) };
    setPromptCategories((current) => {
      if (!current.includes(source) || !current.includes(category)) return current;
      const next = current.filter((item) => item !== source);
      let insertIndex = next.indexOf(category);
      if (insertIndex < 0) return current;
      if (dropTarget.edge === "after") insertIndex += 1;
      next.splice(Math.max(1, insertIndex), 0, source);
      return normalizePromptCategories(next);
    });
    setDraggedPromptCategory("");
    setPromptCategoryDropTarget(null);
    addEvent("提示词分类", "分类顺序已更新");
    return true;
  }

  function dropPromptOnCategory(event, category) {
    const promptId = promptIdFromDrag(event);
    if (!promptId || category === "全部") return;
    event.preventDefault();
    setPromptPresets((current) => current.map((preset) => (
      preset.id === promptId ? { ...preset, category } : preset
    )));
    setPromptDropCategory("");
    setDraggedPromptId(null);
    addEvent("提示词", `已移动到「${category}」`);
  }

  function dropOnPromptCategory(event, category) {
    if (isPromptCategoryDrag(event)) {
      dropPromptCategoryOnCategory(event, category);
      return;
    }
    dropPromptOnCategory(event, category);
  }

  function dropPromptOnPreset(event, targetId) {
    const promptId = promptIdFromDrag(event);
    if (!promptId || promptId === targetId) return;
    event.preventDefault();
    setPromptPresets((current) => {
      const next = [...current];
      const fromIndex = next.findIndex((item) => item.id === promptId);
      const toIndex = next.findIndex((item) => item.id === targetId);
      if (fromIndex < 0 || toIndex < 0) return current;
      const [moved] = next.splice(fromIndex, 1);
      const adjustedIndex = fromIndex < toIndex ? toIndex - 1 : toIndex;
      next.splice(adjustedIndex, 0, moved);
      return next;
    });
    setDraggedPromptId(null);
    addEvent("提示词", "顺序已更新");
  }

  function openNewPromptEditor() {
    const content = settings.prompt.trim();
    const category = promptCategory === "全部" ? promptFallbackCategory() : promptCategory;
    setEditingPrompt({
      id: "",
      title: "",
      category,
      content,
      custom: true
    });
  }

  function updateEditingPrompt(key, value) {
    setEditingPrompt((current) => current ? { ...current, [key]: value } : current);
  }

  function saveEditingPrompt() {
    if (!editingPrompt) return;
    const title = editingPrompt.title.trim();
    const content = editingPrompt.content.trim();
    const category = promptCategories.includes(editingPrompt.category) && editingPrompt.category !== "全部"
      ? editingPrompt.category
      : promptFallbackCategory();

    if (!title || !content) {
      addEvent("提示词", "分类、标题和内容都需要填写");
      return;
    }

    const nextPreset = {
      id: editingPrompt.id || makeResultId(),
      title,
      category,
      content,
      custom: true
    };
    setPromptPresets((current) => {
      const exists = current.some((item) => item.id === nextPreset.id);
      return exists
        ? current.map((item) => item.id === nextPreset.id ? nextPreset : item)
        : [nextPreset, ...current];
    });
    setPromptCategory(category);
    setEditingPrompt(null);
    addEvent("提示词", "已保存提示词");
  }

  function saveApiKey() {
    const cleanedKey = normalizeApiKeyInput(settings.apiKey);
    const nextSettings = { ...settings, apiKey: cleanedKey };
    setSettings(nextSettings);
    writeJsonStorage(STORAGE_KEY, nextSettings);
    setApiSaveStatus(cleanedKey ? `已清理格式并保存（长度 ${cleanedKey.length}）` : "已清空本机 Key");
    addEvent("设置", "API Key 已保存");
    window.setTimeout(() => setApiSaveStatus(""), 1800);
  }

  function openUploadPreview(item) {
    if (!item?.url) return;
    setUploadPreview({
      url: item.url,
      name: item.uploadName || item.file?.name || "上传图片",
      size: item.uploadSize || item.file?.size || 0
    });
  }

  function closeUploadPreview() {
    setUploadPreview(null);
  }

  function openReferencePreview(references, index = 0) {
    const items = (Array.isArray(references) ? references : []).filter((reference) => referenceSource(reference));
    if (items.length === 0) return;
    setReferencePreview({
      items,
      index: Math.max(0, Math.min(items.length - 1, index))
    });
  }

  function closeReferencePreview() {
    setReferencePreview(null);
  }

  function shiftReferencePreview(direction) {
    setReferencePreview((current) => {
      if (!current?.items?.length) return current;
      const nextIndex = Math.max(0, Math.min(current.items.length - 1, current.index + direction));
      return nextIndex === current.index ? current : { ...current, index: nextIndex };
    });
  }

  function openPreview(item) {
    setPreviewResult(item);
    setPreviewZoom(1);
    setPreviewPan({ x: 0, y: 0 });
  }

  function shiftPreview(direction) {
    if (!previewResult || previewNavigationItems.length <= 1) return;
    const index = previewNavigationItems.findIndex((item) => item.id === previewResult.id);
    if (index < 0) return;
    const nextIndex = Math.max(0, Math.min(previewNavigationItems.length - 1, index + direction));
    if (nextIndex === index) return;
    openPreview(previewNavigationItems[nextIndex]);
  }

  function closePreview() {
    setPreviewResult(null);
    setPreviewZoom(1);
    setPreviewPan({ x: 0, y: 0 });
    previewDragRef.current = null;
  }

  function handlePreviewWheel(event) {
    event.preventDefault();
    const direction = event.deltaY < 0 ? 1 : -1;
    setPreviewZoom((current) => {
      const next = current + direction * 0.12;
      return Math.max(0.35, Math.min(4, Number(next.toFixed(2))));
    });
  }

  function beginPreviewDrag(event) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    previewDragRef.current = {
      active: true,
      moved: false,
      startX: event.clientX,
      startY: event.clientY,
      startPan: previewPan
    };
  }

  function movePreviewDrag(event) {
    const drag = previewDragRef.current;
    if (!drag?.active) return;
    const deltaX = event.clientX - drag.startX;
    const deltaY = event.clientY - drag.startY;
    if (Math.abs(deltaX) > 3 || Math.abs(deltaY) > 3) drag.moved = true;
    setPreviewPan({
      x: drag.startPan.x + deltaX,
      y: drag.startPan.y + deltaY
    });
  }

  function endPreviewDrag(event) {
    const drag = previewDragRef.current;
    if (!drag?.active) return;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    previewDragRef.current = null;
    if (!drag.moved) closePreview();
  }

  async function addResultToReferences(item) {
    if (files.length >= MAX_REFERENCE_FILES) {
      addEvent("参考图", `最多保留 ${MAX_REFERENCE_FILES} 张参考图`);
      return;
    }
    try {
      const blob = await blobFromImageItem(item);
      const file = new File([blob], `result-${Date.now()}.${imageExtension(blob.type)}`, {
        type: blob.type || "image/png"
      });
      appendReferenceFiles([file]);
      addEvent("参考图", "已添加到参考图");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      addEvent("参考图失败", message);
    }
  }

  async function sendResultToImageEditor(item, slot = "base") {
    try {
      const blob = await blobFromImageItem(item);
      const file = new File([blob], `${fileBaseName(item?.modelLabel || item?.id || "result")}-${slot}-${Date.now()}.${imageExtension(blob.type)}`, {
        type: blob.type || "image/png",
        lastModified: Date.now()
      });
      setImageEditorSeed({
        id: `image_editor_seed_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        slot,
        file
      });
      setActiveView("image-editor");
      addEvent("图片编辑", slot === "overlay" ? "已设为上层图" : "已设为底图");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      addEvent("图片编辑失败", message);
    }
  }

  async function addReferenceThumbToUploads(reference) {
    const src = referenceSource(reference);
    setReferenceContextMenu(null);
    if (!src) {
      addEvent("参考图", "这张缩略图没有可读取的图片地址");
      return;
    }
    try {
      const file = await fileFromImageUrl(src, reference?.name || reference?.label || "reference");
      appendReferenceFiles([file], {
        eventLabel: "参考图",
        actionText: "已发送到图片上传区"
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      addEvent("参考图失败", message);
    }
  }

  function openContextMenu(event, itemId) {
    event.preventDefault();
    event.stopPropagation();
    const menuWidth = 176;
    const menuHeight = 476;
    setReferenceContextMenu(null);
    setStitchContextMenu(null);
    setContextMenu({
      itemId,
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - menuWidth - 8)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - menuHeight - 8))
    });
  }

  function openReferenceContextMenu(event, reference, index, items) {
    event.preventDefault();
    event.stopPropagation();
    const menuWidth = 190;
    const menuHeight = 52;
    setContextMenu(null);
    setStitchContextMenu(null);
    setReferenceContextMenu({
      reference,
      index,
      count: Array.isArray(items) ? items.length : 0,
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - menuWidth - 8)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - menuHeight - 8))
    });
  }

  function openStitchContextMenu(event, groupId) {
    event.preventDefault();
    event.stopPropagation();
    const menuWidth = 176;
    const menuHeight = 132;
    setContextMenu(null);
    setReferenceContextMenu(null);
    setStitchContextMenu({
      groupId,
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - menuWidth - 8)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - menuHeight - 8))
    });
  }

  function findDetailPromptByResult(resultId) {
    for (const group of detailGroups) {
      for (const prompt of group.prompts) {
        if ((prompt.results || []).some((result) => result.id === resultId)) {
          return { group, prompt };
        }
      }
    }
    return null;
  }

  function rerunResult(item, count = 1) {
    if (item.source === "infinite-canvas") {
      setActiveView("infinite-canvas");
      addEvent("无限画布", "画布结果请通过生图节点继续生成");
      return;
    }
    const detailMatch = findDetailPromptByResult(item.id);
    if (detailMatch) {
      void generateDetailPrompt(detailMatch.group, detailMatch.prompt, detailMatch.prompt.screen, count);
      return;
    }
    const prompt = item.prompt || settings.prompt;
    setSettings((current) => ({ ...current, prompt, n: count }));
    void generate({ prompt, n: count });
  }

  function pushPromptToInput(item) {
    updateSetting("prompt", item.prompt || "");
    addEvent("输入框", "提示词已推送");
  }

  function markDeferredFeature(label) {
    addEvent(label, "此功能会在后续模块接入");
  }

  function orderedPromptsForGroup(group) {
    if (!group?.prompts) return [];
    return detailForwardSort ? group.prompts : [...group.prompts].reverse();
  }

  function detailResultItemsForGroup(group) {
    return orderedPromptsForGroup(group).flatMap((prompt) => (
      (prompt.results || []).map((result) => ({ group, prompt, result }))
    ));
  }

  function selectDetailResult(group, prompt, result) {
    setDetailInfoSelection({ groupId: group.id, promptScreen: prompt.screen, resultId: result.id });
  }

  function beginDetailScreenDrag(event, groupId, screen) {
    setDetailDragScreen({ groupId, screen });
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", JSON.stringify({ groupId, screen }));
  }

  function endDetailScreenDrag() {
    setDetailDragScreen(null);
  }

  function dropDetailScreen(event, groupId, targetScreen) {
    event.preventDefault();
    const source = detailDragScreen || (() => {
      try {
        return JSON.parse(event.dataTransfer.getData("text/plain") || "null");
      } catch {
        return null;
      }
    })();
    if (!source || source.groupId !== groupId || source.screen === targetScreen) {
      setDetailDragScreen(null);
      return;
    }

    setDetailGroups((current) => current.map((group) => {
      if (group.id !== groupId) return group;
      const displayOrder = detailForwardSort ? [...group.prompts] : [...group.prompts].reverse();
      const fromIndex = displayOrder.findIndex((prompt) => prompt.screen === source.screen);
      const toIndex = displayOrder.findIndex((prompt) => prompt.screen === targetScreen);
      if (fromIndex < 0 || toIndex < 0) return group;
      const [moved] = displayOrder.splice(fromIndex, 1);
      displayOrder.splice(toIndex, 0, moved);
      return {
        ...group,
        prompts: detailForwardSort ? displayOrder : [...displayOrder].reverse()
      };
    }));
    setDetailDragScreen(null);
    addEvent("一键详情", "分屏顺序已更新");
  }

  function openStitchPreview(group) {
    const items = detailResultItemsForGroup(group);
    if (items.length === 0) {
      addEvent("拼图预览", "请先生成至少一张分屏图片");
      return;
    }
    setStitchPreview({ groupId: group.id });
    setStitchZoom(1);
    setStitchPan({ x: 0, y: 0 });
  }

  function closeStitchPreview() {
    setStitchPreview(null);
    setStitchContextMenu(null);
    setStitchZoom(1);
    setStitchPan({ x: 0, y: 0 });
    stitchDragRef.current = null;
  }

  function handleStitchWheel(event) {
    event.preventDefault();
    const direction = event.deltaY < 0 ? 1 : -1;
    setStitchZoom((current) => {
      const next = current + direction * 0.1;
      return Math.max(0.25, Math.min(4, Number(next.toFixed(2))));
    });
  }

  function beginStitchDrag(event) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    stitchDragRef.current = {
      active: true,
      startX: event.clientX,
      startY: event.clientY,
      startPan: stitchPan
    };
  }

  function moveStitchDrag(event) {
    const drag = stitchDragRef.current;
    if (!drag?.active) return;
    setStitchPan({
      x: drag.startPan.x + event.clientX - drag.startX,
      y: drag.startPan.y + event.clientY - drag.startY
    });
  }

  function endStitchDrag(event) {
    const drag = stitchDragRef.current;
    if (!drag?.active) return;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    stitchDragRef.current = null;
  }

  function downloadDetailGroup(group, selectedOnly = false) {
    const items = detailResultItemsForGroup(group).filter(({ result }) => !selectedOnly || selectedIds.has(result.id));
    if (items.length === 0) {
      addEvent("下载", selectedOnly ? "请先勾选要下载的分屏图片" : "暂无可下载分屏图片");
      return;
    }
    items.forEach(({ result }, index) => void downloadItem(result, index));
    addEvent("下载", `已提交 ${items.length} 张分屏图片保存任务`);
  }

  function updateDetailPrompt(groupId, screen, patch) {
    setDetailGroups((current) => current.map((group) => {
      if (group.id !== groupId) return group;
      return {
        ...group,
        prompts: group.prompts.map((prompt) => (
          prompt.screen === screen ? { ...prompt, ...patch } : prompt
        ))
      };
    }));
  }

  function toggleDetailPrompt(groupId, screen) {
    setDetailGroups((current) => current.map((group) => {
      if (group.id !== groupId) return group;
      return {
        ...group,
        prompts: group.prompts.map((prompt) => (
          prompt.screen === screen ? { ...prompt, enabled: !prompt.enabled } : prompt
        ))
      };
    }));
  }

  async function createDetailPromptPlan() {
    if (detailProductFiles.length === 0) {
      addEvent("一键详情", "请至少上传一张产品图");
      return;
    }
    const detailApiKey = normalizeApiKeyInput(settings.apiKey);
    if (!detailApiKey && !config.hasServerKey) {
      setError("请先在左下角设置里填写 API Key，AI 详情页分析需要调用当前渠道的文本模型");
      setIsSettingsOpen(true);
      setDetailStatus("failed");
      return;
    }

    setDetailStatus("planning");
    try {
      const productUpload = await prepareImageFilesForChannel(detailProductFiles);
      const referenceUpload = await prepareImageFilesForChannel(detailReferenceFiles);
      if (productUpload.compressedCount + referenceUpload.compressedCount > 0) {
        addEvent("图片压缩", `已压缩 ${productUpload.compressedCount + referenceUpload.compressedCount} 张素材到 4MB 内`);
      }
      const form = new FormData();
      form.set("payload", JSON.stringify({
        ...detailSettings,
        analysisMode: "ai",
        detailAnalysisModel: DETAIL_ANALYSIS_MODEL,
        apiKey: detailApiKey,
        baseUrl: config.defaultBaseUrl || settings.baseUrl || defaultState.baseUrl,
        productImages: productUpload.files.map((file) => ({ name: file.name, size: file.size, type: file.type })),
        referenceImages: referenceUpload.files.map((file) => ({ name: file.name, size: file.size, type: file.type }))
      }));
      productUpload.files.forEach((file) => form.append("productImage", file, file.name));
      referenceUpload.files.forEach((file) => form.append("referenceImage", file, file.name));
      const response = await fetch("/api/detail-prompts", {
        method: "POST",
        body: form
      });
      const payload = await response.json();
      if (!response.ok || !payload?.ok) throw new Error(payload?.message || "分段提示词生成失败");
      const group = {
        ...payload.group,
        productFiles: [...productUpload.files],
        referenceFiles: [...referenceUpload.files]
      };
      setDetailGroups((current) => [group, ...current].slice(0, 20));
      setActiveDetailGroupId(group.id);
      setDetailInfoSelection(null);
      setDetailStatus("ready");
      addEvent("一键详情", `已生成 ${group.prompts.length} 屏分段提示词`);
    } catch (err) {
      const message = normalizeGenerationErrorMessage(err instanceof Error ? err.message : String(err));
      setDetailStatus("failed");
      addEvent("一键详情失败", message);
    }
  }

  function applyDetailPromptToQuickgen(prompt) {
    updateSetting("prompt", prompt.text);
    setActiveView("quickgen");
    addEvent("快捷生成", `已推送第${prompt.screen}屏提示词`);
  }

  function saveDetailPreset() {
    const name = detailSettings.productName.trim()
      || detailSettings.userInstruction.trim().slice(0, 18)
      || new Date().toLocaleString("zh-CN", { hour12: false });
    const preset = {
      id: makeResultId(),
      name,
      createdAt: Date.now(),
      settings: { ...detailSettings }
    };
    setDetailPresets((current) => [preset, ...current.filter((item) => item.name !== name)].slice(0, 30));
    addEvent("一键详情", `已保存预设「${name}」`);
  }

  function loadDetailPreset(preset) {
    setDetailSettings(normalizeDetailSettings(preset.settings));
    setIsDetailPresetOpen(false);
    addEvent("一键详情", `已加载预设「${preset.name}」`);
  }

  function deleteDetailPreset(id) {
    setDetailPresets((current) => current.filter((preset) => preset.id !== id));
    addEvent("一键详情", "已删除预设");
  }

  async function generateDetailPrompt(group, prompt, index = 0, count = 1) {
    const pickFiles = (list, indexes) => {
      if (!Array.isArray(indexes) || indexes.length === 0) return list.length > 0 ? [list[0]] : [];
      return indexes.map((fileIndex) => list[fileIndex]).filter(Boolean);
    };
    const productFiles = group.productFiles || [];
    const referenceFiles = group.referenceFiles || [];
    const selectedProductFiles = pickFiles(productFiles, prompt.productFileIndexes);
    const selectedReferenceFiles = Array.isArray(prompt.referenceFileIndexes)
      ? prompt.referenceFileIndexes.map((fileIndex) => referenceFiles[fileIndex]).filter(Boolean)
      : referenceFiles.slice(0, 1);
    const runFiles = [...selectedProductFiles, ...selectedReferenceFiles].slice(0, 6);
    const runReferenceMeta = [
      ...referenceMetaFromFiles(selectedProductFiles, "product"),
      ...referenceMetaFromFiles(selectedReferenceFiles, "reference", selectedProductFiles.length)
    ].slice(0, 6);
    const runModel = models.find((item) => item.value === group.params.model) || models[0];
    const started = performance.now();
    updateDetailPrompt(group.id, prompt.screen, { status: "running", error: "", generationMs: null });

    const form = new FormData();
    form.set("baseUrl", config.defaultBaseUrl || settings.baseUrl || defaultState.baseUrl);
    form.set("apiKey", normalizeApiKeyInput(settings.apiKey));
    form.set("model", group.params.model);
    form.set("prompt", prompt.text);
    form.set("imageSize", group.params.imageSize);
    form.set("aspectRatio", group.params.ratio);
    form.set("n", String(clampCount(count)));
    form.set("source", "detail-main");
    form.set("referenceMeta", JSON.stringify(runReferenceMeta));

    try {
      const upload = await prepareImageFilesForChannel(runFiles);
      if (upload.compressedCount > 0) {
        addEvent("图片压缩", `第${prompt.screen}屏已压缩 ${upload.compressedCount} 张素材到 4MB 内`);
      }
      upload.files.forEach((file) => form.append("image", file, file.name));
      const response = await fetch("/api/images", {
        method: "POST",
        body: form
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.ok) throw new Error(payload?.message || `HTTP ${response.status}`);
      const totalMs = Number.isFinite(payload.timing?.totalMs) ? payload.timing.totalMs : performance.now() - started;
      const returnedItems = Array.isArray(payload.historyItems) && payload.historyItems.length > 0
        ? payload.historyItems
        : null;
      const nextResults = (returnedItems || payload.images || []).map((entry, resultIndex) => {
        const serverItem = returnedItems ? entry : null;
        return {
          ...serverItem,
          id: serverItem?.id || makeResultId(),
          image: serverItem?.image || entry,
          prompt: prompt.text,
          modelLabel: runModel.label,
          imageSize: group.params.imageSize,
          aspectRatio: group.params.ratio,
          referenceCount: runFiles.length,
          generationMs: totalMs,
          source: "detail-main",
          detailScreen: prompt.screen,
          createdAt: serverItem?.createdAt || Date.now() + index + resultIndex
        };
      });
      if (nextResults.length === 0) throw new Error("接口返回成功，但没有解析到图片");
      setResults((current) => [...nextResults, ...current]);
      void saveHistoryResults(nextResults);
      window.setTimeout(() => {
        void syncHistoryFromServer();
      }, 2400);
      if (nextResults[0]) {
        setDetailInfoSelection({ groupId: group.id, promptScreen: prompt.screen, resultId: nextResults[0].id });
      }
      updateDetailPrompt(group.id, prompt.screen, {
        status: "success",
        generationMs: totalMs,
        results: nextResults
      });
      addEvent("一键详情", `第${prompt.screen}屏完成，用时 ${formatMs(totalMs)}`);
      return nextResults;
    } catch (err) {
      const message = normalizeGenerationErrorMessage(err instanceof Error ? err.message : String(err));
      if (isAuthErrorMessage(message)) {
        setIsSettingsOpen(true);
        setError("当前接口地址不接受这把 API Key，请确认它是否属于当前渠道域名，并在设置里重新保存。");
      }
      updateDetailPrompt(group.id, prompt.screen, {
        status: "failed",
        error: message,
        generationMs: performance.now() - started
      });
      addEvent(`第${prompt.screen}屏失败`, message);
      throw err;
    }
  }

  async function generateDetailGroup(groupId) {
    const group = detailGroups.find((item) => item.id === groupId);
    if (!group) return;
    if (!normalizeApiKeyInput(settings.apiKey) && !config.hasServerKey) {
      setError("请先在左下角设置里填写 API Key");
      setIsSettingsOpen(true);
      setDetailStatus("failed");
      return;
    }
    const enabledPrompts = group.prompts.filter((prompt) => prompt.enabled && prompt.status !== "running");
    if (enabledPrompts.length === 0) {
      addEvent("一键详情", "没有可提交的分屏，请先勾选未在生成中的提示词");
      return;
    }

    setDetailStatus("generating");
    setDetailGroups((current) => current.map((item) => (
      item.id === groupId ? { ...item, status: "generating" } : item
    )));
    addEvent("一键详情", `并发提交 ${enabledPrompts.length} 个分屏任务`);
    const settled = await Promise.allSettled(
      enabledPrompts.map((prompt, index) => generateDetailPrompt(group, prompt, index))
    );
    const failed = settled.filter((item) => item.status === "rejected").length;
    const hasAuthFailure = settled.some((item) => (
      item.status === "rejected" && isAuthErrorMessage(item.reason instanceof Error ? item.reason.message : String(item.reason))
    ));
    if (hasAuthFailure) {
      setIsSettingsOpen(true);
      setError("当前接口地址不接受这把 API Key，请确认它是否属于当前渠道域名，并在设置里重新保存。");
      addEvent("一键详情", "有分屏返回 API Key 无效，请检查当前渠道 Key");
    }
    setDetailGroups((current) => current.map((item) => (
      item.id === groupId ? { ...item, status: failed ? "partial" : "success" } : item
    )));
    setDetailStatus(failed ? "failed" : "ready");
    addEvent("一键详情", failed ? `完成，${failed} 屏失败` : "全部屏幕生成完成");
  }

  async function generate(overrides = {}) {
    const runSettings = {
      ...settings,
      ...overrides,
      n: clampCount(overrides.n ?? settings.n),
      baseUrl: config.defaultBaseUrl || settings.baseUrl || defaultState.baseUrl
    };
    const runItems = files.map(normalizeQuickReferenceItem).filter(Boolean);
    const localEditItems = runItems.filter(quickReferenceHasLocalEdit);
    const hasLocalEditConflict = localEditItems.length > 1;
    const localEditItem = localEditItems[0] || null;
    const primaryLocalEdit = Boolean(localEditItem?.id && runItems[0]?.id === localEditItem.id);
    const quickPrimaryLocalIntent = primaryLocalEdit ? classifyQuickPrimaryLocalIntent(runSettings.prompt) : "";
    let localEditForRun = localEditItem?.localEdit || null;
    let localEditRunItem = localEditItem;
    if (localEditItem && shouldUseExactBanana2LocalCrop(runSettings.model, localEditForRun)) {
      const exactCropped = await cropQuickLocalEditFile(localEditItem, localEditForRun.cropRect, "banana2_local_edit", { withContext: false });
      localEditForRun = {
        ...localEditForRun,
        cropFile: exactCropped.file,
        contextRect: null
      };
      localEditRunItem = {
        ...localEditItem,
        localEdit: localEditForRun
      };
    }
    const runFiles = runItems.map((item) => quickReferenceRunUploadFile(item, localEditRunItem)).filter((file) => file instanceof File);
    const apiPrompt = promptForQuickGeneration(runSettings.prompt, localEditForRun, runSettings.model, {
      primaryLocalEdit,
      localIntent: quickPrimaryLocalIntent
    });
    const runModel = models.find((item) => item.value === runSettings.model) || models[0];
    const runReferenceMeta = referenceMetaFromQuickItems(runItems, "reference").map((meta, index) => ({
      ...meta,
      localEdit: Boolean(localEditRunItem?.id && runItems[index]?.id === localEditRunItem.id),
      cropEdit: Boolean(runItems[index]?.cropEdit?.cropFile && (!localEditRunItem?.id || runItems[index]?.id !== localEditRunItem.id))
    }));

    if (!normalizeApiKeyInput(runSettings.apiKey) && !config.hasServerKey) {
      setError("请先在左下角设置里填写 API Key");
      setIsSettingsOpen(true);
      setStatus("failed");
      addEvent("无法生成", "请先填写 API Key");
      return;
    }
    if (!runSettings.prompt.trim()) {
      setError("请输入提示词");
      setStatus("failed");
      addEvent("无法生成", "请输入提示词");
      return;
    }
    if (localEditForRun?.aspectRatio && localEditForRun.aspectRatio !== runSettings.aspectRatio) {
      runSettings.aspectRatio = localEditForRun.aspectRatio;
      updateSetting("aspectRatio", localEditForRun.aspectRatio);
    }

    const taskId = makeResultId();
    const taskStartedAt = Date.now();
    setStatus("running");
    setError("");
    setTiming(null);
    setNowTick(taskStartedAt);
    setQuickTasks((current) => [...current, {
      id: taskId,
      status: "running",
      startedAt: taskStartedAt,
      modelLabel: runModel.label,
      imageSize: runSettings.imageSize,
      aspectRatio: runSettings.aspectRatio,
      prompt: runSettings.prompt
    }]);
    addEvent("提交", `${runModel.label} / ${runSettings.imageSize} / ${runSettings.aspectRatio}`);
    if (hasLocalEditConflict) {
      addEvent("局部回贴", "检测到多张局部图，本次只用第一张做回贴，其他图按普通参考图上传");
    }
    if (primaryLocalEdit && quickPrimaryLocalIntent) {
      addEvent("局部触发", quickPrimaryLocalIntent === "outfit" ? "已启用局部换装" : "已启用局部精修");
    }

    const form = new FormData();
    form.set("baseUrl", runSettings.baseUrl);
    form.set("apiKey", normalizeApiKeyInput(runSettings.apiKey));
    form.set("model", runSettings.model);
    form.set("prompt", apiPrompt);
    form.set("imageSize", runSettings.imageSize);
    form.set("aspectRatio", runSettings.aspectRatio);
    form.set("n", String(runSettings.n));
    form.set("source", "quickgen");
    if (localEditForRun) form.set("deferAutoSave", "1");
    form.set("referenceMeta", JSON.stringify(runReferenceMeta));

    const started = performance.now();
    try {
      const normalizeForBanana2 = shouldNormalizeQuickUploadForModel(runSettings.model) && runFiles.length > 0 && !localEditForRun;
      const upload = await prepareImageFilesForChannel(runFiles, { forceJpeg: normalizeForBanana2 });
      if (upload.compressedCount > 0) {
        addEvent("图片压缩", `已压缩 ${upload.compressedCount} 张参考图到 4MB 内`);
      }
      if (upload.normalizedCount > 0) {
        addEvent("香蕉2原图兼容", `已转换 ${upload.normalizedCount} 张参考图为兼容 JPEG`);
      }
      upload.files.forEach((file) => form.append("image", file, file.name));
      const response = await fetch("/api/images", {
        method: "POST",
        body: form
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.ok) {
        throw new Error(payload?.message || `HTTP ${response.status}`);
      }
      if (!payload.images?.length) {
        throw new Error("接口返回成功，但没有解析到图片");
      }

      const totalMs = Number.isFinite(payload.timing?.totalMs) ? payload.timing.totalMs : performance.now() - started;
      const returnedItems = Array.isArray(payload.historyItems) && payload.historyItems.length > 0
        ? payload.historyItems
        : null;
      let nextResults = (returnedItems || payload.images).map((entry, index) => {
        const serverItem = returnedItems ? entry : null;
        return {
          ...serverItem,
          id: serverItem?.id || makeResultId(),
          image: serverItem?.image || entry,
          prompt: runSettings.prompt,
          modelLabel: runModel.label,
          imageSize: runSettings.imageSize,
          aspectRatio: runSettings.aspectRatio,
          referenceCount: runFiles.length,
          generationMs: totalMs,
          source: "quickgen",
          taskId,
          submittedAt: taskStartedAt + index,
          clientSessionId: CLIENT_SESSION_ID,
          createdAt: serverItem?.createdAt || taskStartedAt + index
        };
      });
      let clientAutoSavedCount = 0;
      if (localEditRunItem && localEditForRun) {
        const originalFile = quickReferenceOriginalFile(localEditRunItem);
        const preciseGptLocalComposite = /^gpt-image$/i.test(String(runSettings.model || ""));
        nextResults = await Promise.all(nextResults.map(async (item) => {
          const generatedBlob = await blobFromImageItem(item);
          const composedBlob = await composeQuickLocalEditBlob(originalFile, generatedBlob, localEditForRun.cropRect, localEditForRun, preciseGptLocalComposite ? {
            autoAlign: true,
            maxShift: 7,
            rectFeatherRatio: 0.045,
            rectFeatherMax: 48
          } : {});
          const dataUrl = await dataUrlFromBlob(composedBlob);
          return {
            ...item,
            image: { type: "b64_json", value: dataUrl, mimeType: "image/jpeg" },
          localEdit: {
            enabled: true,
            editMode: localEditForRun.editMode || LOCAL_EDIT_RECT_MODE,
            sourceName: originalFile?.name || "",
            cropRect: localEditForRun.cropRect,
            contextRect: localEditForRun.contextRect || null,
            sourceWidth: localEditForRun.sourceWidth,
            sourceHeight: localEditForRun.sourceHeight,
            maskBounds: localEditForRun.maskBounds || null
          }
          };
        }));
        clientAutoSavedCount = await autoSaveGeneratedItems(nextResults);
      }
      setResults((current) => [...nextResults, ...current]);
      void saveHistoryResults(nextResults);
      setTiming(payload.timing);
      setStatus("success");
      addEvent("完成", `生成 ${nextResults.length} 张，用时 ${formatMs(totalMs)}${autoSaveEventText(payload, localEditForRun ? clientAutoSavedCount : null)}`);
    } catch (err) {
      const message = normalizeGenerationErrorMessage(err instanceof Error ? err.message : String(err));
      if (isAuthErrorMessage(message)) {
        setIsSettingsOpen(true);
      }
      setStatus("failed");
      setError(message);
      addEvent("失败", message);
    } finally {
      setQuickTasks((current) => current.filter((task) => task.id !== taskId));
    }
  }

  async function generateReferenceRemix(overrides = {}) {
    const runSettings = {
      ...referenceSettings,
      ...overrides,
      n: clampCount(overrides.n ?? referenceSettings.n),
      strength: clampReferenceStrength(overrides.strength ?? referenceSettings.strength)
    };
    const productFiles = [...referenceProductFiles];
    const styleFiles = [...referenceStyleFiles];
    const runFiles = [...productFiles, ...styleFiles];
    const runReferenceMeta = [
      ...referenceMetaFromFiles(productFiles, "product"),
      ...referenceMetaFromFiles(styleFiles, "style", productFiles.length)
    ];
    const runModel = models.find((item) => item.value === runSettings.model) || models[0];

    if (!normalizeApiKeyInput(settings.apiKey) && !config.hasServerKey) {
      setReferenceError("请先在左下角设置里填写 API Key");
      setIsSettingsOpen(true);
      setReferenceStatus("failed");
      return;
    }
    if (productFiles.length === 0) {
      setReferenceError("请先上传产品图，参考生图需要先锁定商品主体");
      setReferenceStatus("failed");
      addEvent("参考生图", "请先上传产品图");
      return;
    }

    const expandedPrompt = buildReferenceRemixPrompt(runSettings, productFiles.length, styleFiles.length);
    const taskId = makeResultId();
    const taskStartedAt = Date.now();
    setReferenceStatus("running");
    setReferenceError("");
    setNowTick(taskStartedAt);
    setReferenceTasks((current) => [...current, {
      id: taskId,
      status: "running",
      startedAt: taskStartedAt,
      modelLabel: runModel.label,
      imageSize: runSettings.imageSize,
      aspectRatio: runSettings.aspectRatio,
      prompt: expandedPrompt
    }]);
    addEvent("参考生图", `${runModel.label} / 参考值 ${runSettings.strength}% / ${runSettings.imageSize}`);

    const form = new FormData();
    form.set("baseUrl", config.defaultBaseUrl || defaultState.baseUrl);
    form.set("apiKey", normalizeApiKeyInput(settings.apiKey));
    form.set("model", runSettings.model);
    form.set("prompt", expandedPrompt);
    form.set("imageSize", runSettings.imageSize);
    form.set("aspectRatio", runSettings.aspectRatio);
    form.set("n", String(runSettings.n));
    form.set("source", "reference-remix");
    form.set("referenceMeta", JSON.stringify(runReferenceMeta));

    const started = performance.now();
    try {
      const upload = await prepareImageFilesForChannel(runFiles);
      if (upload.compressedCount > 0) {
        addEvent("图片压缩", `参考生图已压缩 ${upload.compressedCount} 张素材到 4MB 内`);
      }
      upload.files.forEach((file) => form.append("image", file, file.name));
      const response = await fetch("/api/images", {
        method: "POST",
        body: form
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.ok) {
        throw new Error(payload?.message || `HTTP ${response.status}`);
      }
      if (!payload.images?.length) {
        throw new Error("接口返回成功，但没有解析到图片");
      }

      const totalMs = Number.isFinite(payload.timing?.totalMs) ? payload.timing.totalMs : performance.now() - started;
      const returnedItems = Array.isArray(payload.historyItems) && payload.historyItems.length > 0
        ? payload.historyItems
        : null;
      const nextResults = (returnedItems || payload.images).map((entry, index) => {
        const serverItem = returnedItems ? entry : null;
        return {
          ...serverItem,
          id: serverItem?.id || makeResultId(),
          image: serverItem?.image || entry,
          prompt: expandedPrompt,
          displayPrompt: runSettings.prompt,
          modelLabel: runModel.label,
          imageSize: runSettings.imageSize,
          aspectRatio: runSettings.aspectRatio,
          referenceCount: runFiles.length,
          generationMs: totalMs,
          source: "reference-remix",
          referenceStrength: runSettings.strength,
          referenceControls: {
            element: runSettings.element,
            composition: runSettings.composition,
            scene: runSettings.scene
          },
          taskId,
          submittedAt: taskStartedAt + index,
          clientSessionId: CLIENT_SESSION_ID,
          createdAt: serverItem?.createdAt || taskStartedAt + index
        };
      });
      setResults((current) => [...nextResults, ...current]);
      void saveHistoryResults(nextResults);
      setReferenceStatus("success");
      addEvent("参考生图", `生成 ${nextResults.length} 张，用时 ${formatMs(totalMs)}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isAuthErrorMessage(message)) setIsSettingsOpen(true);
      setReferenceStatus("failed");
      setReferenceError(message);
      addEvent("参考生图失败", message);
    } finally {
      setReferenceTasks((current) => current.filter((task) => task.id !== taskId));
    }
  }

  return (
    <main className="appShell">
      <aside className="sidebar">
        <div className="brand">
          <div className="avatar">
            <img src="/app-avatar.webp" alt="" />
          </div>
          <div>
            <h1>静音AI绘画</h1>
            <span>静音相伴 从容设计</span>
            <span>静音:15871470202</span>
          </div>
        </div>

        <nav className="navList">
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.label}
                className={`navItem ${activeView === item.id ? "active" : ""} ${item.child ? "subNavItem" : ""}`}
                type="button"
                onClick={() => {
                  if (item.id === "prompts") {
                    setIsPromptAssistantOpen(true);
                    return;
                  }
                  setActiveView(item.id);
                }}
              >
                <Icon size={17} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>

        <button className="settingsEntry" type="button" onClick={() => setIsSettingsOpen(true)}>
          <Settings size={17} />
          <span>设置</span>
        </button>
      </aside>

      <section className={`quickgenArea ${["outfit", "resize"].includes(activeView) ? "embeddedWorkflowArea" : ""}`}>
        {!["outfit", "resize"].includes(activeView) && (
        <header className="topBar">
          <div className="resultTabs">
            {activeView === "infinite-canvas" ? (
              <div className="viewTitle">
                <Box size={16} />
                <span>无限画布</span>
              </div>
            ) : activeView === "detail-main" ? (
              <div className="viewTitle">
                <FileText size={16} />
                <span>一键详情/主图</span>
              </div>
            ) : activeView === "reference-remix" ? (
              <div className="viewTitle">
                <Layers size={16} />
                <span>参考生图</span>
              </div>
            ) : activeView === "image-editor" ? (
              <div className="viewTitle">
                <Brush size={16} />
                <span>图片编辑</span>
              </div>
            ) : (
              <>
                <button
                  className={`tabButton ${resultFilter === "all" ? "active" : ""}`}
                  type="button"
                  onClick={() => setResultFilter("all")}
                >
                  全部({imageCount})
                </button>
                <button
                  className={`tabButton ${resultFilter === "image" ? "active" : ""}`}
                  type="button"
                  onClick={() => setResultFilter("image")}
                >
                  <ImageIcon size={14} /> 图片({imageCount})
                </button>
                <button className="tabButton" type="button" onClick={() => addEvent("视频", "视频模块暂未接入")}>
                  <Video size={14} /> 视频(0)
                </button>
              </>
            )}
          </div>

          <div className="topActions">
            {activeView === "quickgen" && (
              <button className="toolbarButton" type="button" onClick={() => void refreshHistory()}>
                <RefreshCw size={15} />
                <span>刷新</span>
              </button>
            )}
            <button className="toolbarButton" type="button" onClick={openDirectoryModal}>
              <FolderOpen size={15} />
              <span>指定文件夹</span>
            </button>
            {activeView === "detail-main" && (
              <button
                className="generateButton pinnedFolderButton"
                type="button"
                onClick={() => activeDetailGroup && openStitchPreview(activeDetailGroup)}
                disabled={!activeDetailGroup || activeDetailResults.length === 0}
              >
                <Layers size={15} />
                <span>拼图预览</span>
              </button>
            )}
            <button className="toolbarButton pinnedFolderButton" type="button" onClick={() => void openSaveDirectory()}>
              <FolderOpen size={15} />
              <span>打开保存目录</span>
            </button>
            {activeView === "infinite-canvas" && (
              <>
                <select className="toolbarSelect" value={activeCanvasId || ""} onChange={(event) => selectCanvas(event.target.value)}>
                  {canvases.map((canvas) => <option key={canvas.id} value={canvas.id}>{canvas.name}</option>)}
                </select>
                <span className={`taskBadge task-${canvasRunningCount > 0 ? "running" : "success"}`}>{canvasStatusText}</span>
                <button className="toolbarButton" type="button" onClick={createCanvas}>
                  <Plus size={15} />
                  <span>新建画布</span>
                </button>
                <button className="toolbarButton" type="button" onClick={renameCanvas} disabled={!activeCanvas}>
                  <Pencil size={15} />
                  <span>重命名</span>
                </button>
                <button className="toolbarButton" type="button" onClick={fitCanvasView} disabled={!activeCanvas}>
                  <Maximize2 size={15} />
                  <span>适配</span>
                </button>
                <button className="dangerButton" type="button" onClick={clearCanvas} disabled={!activeCanvas}>
                  <Trash2 size={15} />
                  <span>清空</span>
                </button>
              </>
            )}
            {activeView === "detail-main" && (
              <span className={`taskBadge task-${detailStatus === "failed" ? "failed" : detailRunningCount > 0 || detailStatus === "planning" ? "running" : "success"}`}>
                {detailStatusText}
              </span>
            )}
            {activeView === "quickgen" && (
              <>
                <span className={`taskBadge task-${quickStatus}`}>{latestStatusText}</span>
                <button className="toolbarButton" type="button" onClick={downloadSelected} disabled={quickSelectedCount === 0}>
                  <Download size={15} />
                  <span>下载选中</span>
                </button>
                <button className="toolbarButton" type="button" onClick={downloadAll} disabled={quickResults.length === 0}>
                  <Download size={15} />
                  <span>下载全部</span>
                </button>
                <button className="dangerButton" type="button" onClick={deleteSelected} disabled={quickSelectedCount === 0}>
                  <Trash2 size={15} />
                  <span>删除选中</span>
                </button>
                <button className="dangerButton" type="button" onClick={clearAll}>
                  <Trash2 size={15} />
                  <span>清空全部</span>
                </button>
                <div className="zoomControl">
                  <button type="button" onClick={() => changeGalleryZoom(-0.1)} disabled={galleryZoom <= 0.75} aria-label="缩小图库">
                    <Minus size={14} />
                  </button>
                  <span style={{ "--zoom-fill": `${Math.max(0, Math.min(100, ((galleryZoom - 0.75) / 0.7) * 100))}%` }} />
                  <button type="button" onClick={() => changeGalleryZoom(0.1)} disabled={galleryZoom >= 1.45} aria-label="放大图库">
                    <Plus size={14} />
                  </button>
                  <strong>{galleryZoomPercent}%</strong>
                </div>
              </>
            )}
            {activeView === "reference-remix" && (
              <>
                <span className={`taskBadge task-${runningReferenceTasks.length > 0 ? "running" : referenceStatus}`}>
                  {referenceStatusText}
                </span>
                <button className="toolbarButton" type="button" onClick={clearAll} disabled={referenceResults.length === 0}>
                  <Trash2 size={15} />
                  <span>清空参考结果</span>
                </button>
              </>
            )}
          </div>
        </header>
        )}

        {["outfit", "resize"].includes(activeView) ? (
          <OutfitWorkflow
            view={activeView}
            hostTheme={settings.theme}
            hostApiKey={settings.apiKey}
            onOpenHostSettings={() => setIsSettingsOpen(true)}
          />
        ) : activeView === "image-editor" ? (
          <ImageEditorPanel
            incomingImage={imageEditorSeed}
            onIncomingHandled={(id) => setImageEditorSeed((current) => current?.id === id ? null : current)}
            resolveDroppedFiles={imageFilesFromReferenceDrop}
            saveDirectory={saveDirectory}
            onChooseDirectory={openDirectoryModal}
            onOpenSaveDirectory={() => void openSaveDirectory()}
            onSaveMergedImage={saveProcessedImageFile}
            onAddEvent={addEvent}
          />
        ) : activeView === "detail-main" ? (
          <section className="detailWorkbench">
            <aside className="detailInputPanel">
              <div className="detailPanelScroll">
                <DetailUploadZone
                  title="产品图（包含模特图）"
                  subtitle={`最多 ${MAX_DETAIL_FILES} 张，优先放主商品、细节、模特图`}
                  previews={detailProductPreviews}
                  count={detailProductFiles.length}
                  maxCount={MAX_DETAIL_FILES}
                  inputRef={detailProductInputRef}
                  onPick={(event) => {
                    addDetailFiles("product", event.target.files);
                    event.target.value = "";
                  }}
                  onAddFiles={(fileList) => addDetailFiles("product", fileList)}
                  onRemove={(index) => removeDetailFile("product", index)}
                  onPreview={openUploadPreview}
                  onAssetLibrary={() => markDeferredFeature("素材库")}
                />

                <DetailUploadZone
                  title="参考图（设计风格参考）"
                  subtitle={`最多 ${MAX_DETAIL_FILES} 张，只参考风格、配色、版式`}
                  previews={detailReferencePreviews}
                  count={detailReferenceFiles.length}
                  maxCount={MAX_DETAIL_FILES}
                  inputRef={detailReferenceInputRef}
                  onPick={(event) => {
                    addDetailFiles("reference", event.target.files);
                    event.target.value = "";
                  }}
                  onAddFiles={(fileList) => addDetailFiles("reference", fileList)}
                  onRemove={(index) => removeDetailFile("reference", index)}
                  onPreview={openUploadPreview}
                  onAssetLibrary={() => markDeferredFeature("素材库")}
                />

                <div className="detailPresetRow">
                  <button className="smallButton" type="button" onClick={saveDetailPreset}>
                    <Save size={15} />
                    <span>保存预设</span>
                  </button>
                  <button className="smallButton" type="button" onClick={() => setIsDetailPresetOpen(true)}>
                    <FolderOpen size={15} />
                    <span>加载预设</span>
                  </button>
                </div>

                <div className="detailDivider" />

                <section className="detailFormSection">
                  <h3>基础参数</h3>
                  <div className="detailParamGrid">
                    <label>
                      <span>工作流</span>
                      <select value={detailSettings.workflow} onChange={(event) => updateDetailSetting("workflow", event.target.value)}>
                        {workflowOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                      </select>
                    </label>
                    <label>
                      <span>图片模型</span>
                      <select value={detailSettings.model} onChange={(event) => updateDetailSetting("model", event.target.value)}>
                        {models.map((model) => <option key={model.value} value={model.value}>{model.label}</option>)}
                      </select>
                    </label>
                    <label>
                      <span>图片比例</span>
                      <select value={detailSettings.ratio} onChange={(event) => updateDetailSetting("ratio", event.target.value)}>
                        {detailRatios.map((ratio) => <option key={ratio} value={ratio}>{ratio}</option>)}
                      </select>
                    </label>
                    <label>
                      <span>分辨率</span>
                      <select value={detailSettings.imageSize} onChange={(event) => updateDetailSetting("imageSize", event.target.value)}>
                        {IMAGE_SIZES.map((size) => <option key={size} value={size}>{size}</option>)}
                      </select>
                    </label>
                    <label>
                      <span>生成数量</span>
                      <select value={detailSettings.count} onChange={(event) => updateDetailSetting("count", event.target.value)}>
                        {COUNT_OPTIONS.map((count) => <option key={count} value={count}>{count}张</option>)}
                      </select>
                    </label>
                    <label>
                      <span>文案设置</span>
                      <select value={detailSettings.copywriting} onChange={(event) => updateDetailSetting("copywriting", event.target.value)}>
                        {copywritingOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                      </select>
                    </label>
                    <label>
                      <span>画面丰富</span>
                      <select value={detailSettings.richness} onChange={(event) => updateDetailSetting("richness", event.target.value)}>
                        {richnessOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                      </select>
                    </label>
                    <label>
                      <span>字体风格</span>
                      <select value={detailSettings.fontStyle} onChange={(event) => updateDetailSetting("fontStyle", event.target.value)}>
                        {fontStyleOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                      </select>
                    </label>
                    <label>
                      <span>模特设置</span>
                      <select value={detailSettings.modelMode} onChange={(event) => updateDetailSetting("modelMode", event.target.value)}>
                        {modelModeOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                      </select>
                    </label>
                    <label>
                      <span>模特姿势</span>
                      <select
                        value={detailSettings.modelPose}
                        disabled={detailSettings.modelMode !== "use-model"}
                        onChange={(event) => updateDetailSetting("modelPose", event.target.value)}
                      >
                        {modelPoseOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                      </select>
                    </label>
                    <label>
                      <span>模特使用率</span>
                      <select
                        value={detailSettings.modelUsage}
                        disabled={detailSettings.modelMode !== "use-model"}
                        onChange={(event) => updateDetailSetting("modelUsage", event.target.value)}
                      >
                        {Array.from({ length: 12 }, (_, index) => index + 1).map((count) => (
                          <option key={count} value={count}>{count}</option>
                        ))}
                      </select>
                    </label>
                    <label>
                      <span>插入反转屏</span>
                      <select value={detailSettings.reverseScreens} onChange={(event) => updateDetailSetting("reverseScreens", event.target.value)}>
                        {Array.from({ length: 5 }, (_, index) => index).map((count) => (
                          <option key={count} value={count}>{count}</option>
                        ))}
                      </select>
                    </label>
                    <label>
                      <span>输出语种</span>
                      <input value={detailSettings.lang} onChange={(event) => updateDetailSetting("lang", event.target.value)} />
                    </label>
                  </div>
                </section>

                <div className="detailDivider" />

                <section className="detailFormSection">
                  <h3>内容输入（可选）</h3>
                  <label className="detailField">
                    <span>产品名称</span>
                    <input
                      value={detailSettings.productName}
                      onChange={(event) => updateDetailSetting("productName", event.target.value)}
                      placeholder="例：女装假两件上衣"
                    />
                  </label>
                  <label className="detailField">
                    <span>产品特征</span>
                    <textarea
                      value={detailSettings.productFeature}
                      onChange={(event) => updateDetailSetting("productFeature", event.target.value)}
                      placeholder="产品大小，尺寸，特征信息用于锁死产品一致性（可不输入）"
                    />
                  </label>
                  <label className="detailField">
                    <span className="detailFieldTitle">
                      <b>用户指令</b>
                      <button type="button" onClick={() => setIsPromptAssistantOpen(true)}>
                        <BookOpen size={13} />
                        提示词助手
                      </button>
                    </span>
                    <textarea
                      value={detailSettings.userInstruction}
                      onChange={(event) => updateDetailSetting("userInstruction", event.target.value)}
                      placeholder="用户指令：屏数、风格、图1/2/3 用法等"
                    />
                  </label>
                  <label className="detailField">
                    <span>卖点</span>
                    <textarea
                      value={detailSettings.sellingPoints}
                      onChange={(event) => updateDetailSetting("sellingPoints", event.target.value)}
                      placeholder="每行一个卖点，可留空"
                    />
                  </label>
                </section>
              </div>

              <div className="detailPanelFooter">
                <button
                  className="generateButton"
                  type="button"
                  disabled={detailStatus === "planning"}
                  onClick={() => void createDetailPromptPlan()}
                >
                  {detailStatus === "planning" ? <Loader2 className="spin" size={16} /> : <Play size={16} />}
                  <span>{detailStatus === "planning" ? "分析中..." : "生成分段提示词"}</span>
                </button>
              </div>
            </aside>

            <section className={`detailResultBoard ${detailInfoItem ? "withInfo" : ""}`}>
              <div className="detailBoardMain">
                {detailGroups.length === 0 ? (
                  <div className="detailEmpty">
                    <FileText size={34} />
                    <span>上传产品图后，点击「生成分段提示词」开始</span>
                  </div>
                ) : (
                  <>
                    <div className="detailGroupTabs">
                      <div>
                        {detailGroups.map((group, index) => (
                          <button
                            className={activeDetailGroup?.id === group.id ? "active" : ""}
                            key={group.id}
                            type="button"
                            onClick={() => {
                              setActiveDetailGroupId(group.id);
                              setDetailInfoSelection(null);
                            }}
                          >
                            分组 #{detailGroups.length - index}
                          </button>
                        ))}
                      </div>
                      <div className="detailViewControls">
                        <label>
                          <span>每行展示</span>
                          <select value={detailColumns} onChange={(event) => setDetailColumns(Number(event.target.value))}>
                            {[2, 3, 4, 5, 6].map((count) => <option key={count} value={count}>{count}</option>)}
                          </select>
                        </label>
                        <button
                          className={`switchButton ${detailForwardSort ? "active" : ""}`}
                          type="button"
                          onClick={() => setDetailForwardSort((current) => !current)}
                        >
                          <span>正向排序</span>
                          <i />
                        </button>
                      </div>
                    </div>

                    {activeDetailGroup && (
                      <article className="detailGroup" key={activeDetailGroup.id}>
                        <header className="detailGroupHeader">
                          <div>
                            <strong>{activeDetailGroup.label}</strong>
                            <span>
                              {activeDetailGroup.params.platform}{activeDetailGroup.params.pageType} ·
                              {activeDetailGroup.params.model} · {activeDetailGroup.params.ratio} · {activeDetailGroup.params.imageSize} ·
                              已出图 {activeDetailResults.length} 屏
                            </span>
                          </div>
                          <div className="detailGroupActions">
                            <button
                              className="smallButton"
                              type="button"
                              onClick={() => markDeferredFeature("切换模型")}
                            >
                              <Settings size={14} />
                              <span>切换模型</span>
                            </button>
                            <button className="smallButton" type="button" onClick={() => downloadDetailGroup(activeDetailGroup)}>
                              <Download size={14} />
                              <span>下载全部</span>
                            </button>
                            <button className="smallButton" type="button" disabled={selectedCount === 0} onClick={() => downloadDetailGroup(activeDetailGroup, true)}>
                              <Download size={14} />
                              <span>下载选中</span>
                            </button>
                            <button
                              className="generateButton"
                              type="button"
                              onClick={() => void generateDetailGroup(activeDetailGroup.id)}
                            >
                              {detailRunningCount > 0 ? <Loader2 className="spin" size={16} /> : <Play size={16} />}
                              <span>批量生成</span>
                            </button>
                          </div>
                        </header>

                        <section className="detailPromptConfirm">
                          <header>
                            <div>
                              <strong>分段提示词确认</strong>
                              <span>确认每一屏内容无误后，再点击批量生成或单屏生成。</span>
                            </div>
                          </header>
                          <div className="detailPromptGrid">
                            {visibleDetailPrompts.map((prompt) => (
                              <article className={`detailPromptCard ${prompt.status}`} key={`${activeDetailGroup.id}-${prompt.screen}`}>
                                <header>
                                  <label className="detailCheck">
                                    <input
                                      type="checkbox"
                                      checked={prompt.enabled}
                                      onChange={() => toggleDetailPrompt(activeDetailGroup.id, prompt.screen)}
                                    />
                                    <span>第{prompt.screen}屏</span>
                                  </label>
                                  <small>{prompt.intervention}</small>
                                </header>
                                <h3>{prompt.title}</h3>
                                <p>{prompt.summary}</p>
                                {prompt.referenceStrategy && <small>{prompt.referenceStrategy}</small>}
                                <textarea
                                  value={prompt.text}
                                  onChange={(event) => updateDetailPrompt(activeDetailGroup.id, prompt.screen, { text: event.target.value })}
                                />
                                <div className="detailPromptActions">
                                  <button className="smallButton" type="button" onClick={() => void copyText(prompt.text, `第${prompt.screen}屏提示词已复制`)}>
                                    <Copy size={14} />
                                    <span>复制</span>
                                  </button>
                                  <button className="smallButton" type="button" onClick={() => applyDetailPromptToQuickgen(prompt)}>
                                    <Sparkles size={14} />
                                    <span>推送</span>
                                  </button>
                                  <button
                                    className="smallButton"
                                    type="button"
                                    disabled={prompt.status === "running"}
                                    onClick={() => void generateDetailPrompt(activeDetailGroup, prompt, prompt.screen)}
                                  >
                                    {prompt.status === "running" ? <Loader2 className="spin" size={14} /> : <Play size={14} />}
                                    <span>生成</span>
                                  </button>
                                </div>
                                {(prompt.generationMs || prompt.status === "failed") && (
                                  <div className="detailPromptStatus">
                                    {prompt.generationMs && <span>用时 {formatMs(prompt.generationMs)}</span>}
                                    {prompt.error && <strong>{prompt.error}</strong>}
                                  </div>
                                )}
                              </article>
                            ))}
                          </div>
                        </section>

                        {activeDetailResults.length > 0 && (
                          <section className="detailImageSection">
                            <header>
                              <div>
                                <strong>生成分屏</strong>
                                <span>左键点击查看信息，按住拖拽调整拼图顺序，右键打开图片操作。</span>
                              </div>
                            </header>
                            <div className="detailScreensGrid" style={{ "--detail-columns": detailColumns }}>
                              {activeDetailResults.map(({ prompt, result }, resultIndex) => {
                                const src = imageSourceFromResult(result.image);
                                const selected = selectedIds.has(result.id);
                                return (
                                  <article
                                    className={`detailScreenCard ${detailInfoSelection?.resultId === result.id ? "selected" : ""} ${detailDragScreen?.screen === prompt.screen ? "dragging" : ""}`}
                                    key={result.id}
                                    draggable
                                    onDragStart={(event) => beginDetailScreenDrag(event, activeDetailGroup.id, prompt.screen)}
                                    onDragOver={(event) => event.preventDefault()}
                                    onDrop={(event) => dropDetailScreen(event, activeDetailGroup.id, prompt.screen)}
                                    onDragEnd={endDetailScreenDrag}
                                  >
                                    <header>
                                      <span>{String(resultIndex + 1).padStart(2, "0")}</span>
                                      <i>⋮</i>
                                    </header>
                                    <button
                                      className="detailScreenSelect"
                                      type="button"
                                      onClick={(event) => {
                                        event.stopPropagation();
                                        toggleSelected(result.id);
                                      }}
                                      aria-label="选择分屏图片"
                                    >
                                      {selected ? <CheckSquare size={18} /> : <Square size={18} />}
                                    </button>
                                    <button
                                      className="detailScreenImage"
                                      type="button"
                                      draggable={false}
                                      onClick={() => {
                                        selectDetailResult(activeDetailGroup, prompt, result);
                                        openPreview(result);
                                      }}
                                      onContextMenu={(event) => openContextMenu(event, result.id)}
                                    >
                                      <img src={src} alt={`第${prompt.screen}屏结果`} draggable={false} />
                                    </button>
                                    <button
                                      className="detailScreenPrompt"
                                      type="button"
                                      onClick={() => void copyText(prompt.text, `第${prompt.screen}屏提示词已复制`)}
                                      title={prompt.text}
                                    >
                                      {prompt.text}
                                    </button>
                                    <div className="detailReferenceTray">
                                      <ReferenceThumbTray references={result.references} count={result.referenceCount} max={5} onOpen={openReferencePreview} onContextMenu={openReferenceContextMenu} />
                                      <button type="button" onClick={() => markDeferredFeature("追加参考图")}>
                                        <Plus size={13} />
                                      </button>
                                    </div>
                                  </article>
                                );
                              })}
                            </div>
                          </section>
                        )}
                      </article>
                    )}
                  </>
                )}
              </div>

              {detailInfoItem && (
                <aside className="detailInfoPanel">
                  <header>
                    <div>
                      <strong>生图信息</strong>
                      <span>第{detailInfoItem.prompt.screen}屏 · {detailInfoItem.prompt.title}</span>
                    </div>
                    <button className="iconButton" type="button" onClick={() => setDetailInfoSelection(null)} aria-label="关闭">
                      <X size={16} />
                    </button>
                  </header>
                  <button
                    className="detailInfoPreview"
                    type="button"
                    onClick={() => openPreview(detailInfoItem.result)}
                    onContextMenu={(event) => openContextMenu(event, detailInfoItem.result.id)}
                  >
                    <img src={imageSourceFromResult(detailInfoItem.result.image)} alt="详情分屏预览" />
                  </button>
                  <div className="detailInfoMeta">
                    <span>模型</span><strong>{detailInfoItem.result.modelLabel}</strong>
                    <span>尺寸</span><strong>{detailInfoItem.result.imageSize} · {detailInfoItem.result.aspectRatio}</strong>
                    <span>参考图</span><strong>{detailInfoItem.result.referenceCount} 张</strong>
                    <span>用时</span><strong>{detailInfoItem.result.generationMs ? formatMs(detailInfoItem.result.generationMs) : "--"}</strong>
                    <span>状态</span><strong>{detailInfoItem.prompt.status === "success" ? "已完成" : detailInfoItem.prompt.status}</strong>
                  </div>
                  <section className="detailInfoReferences">
                    <span>本张参考图</span>
                    <ReferenceThumbTray references={detailInfoItem.result.references} count={detailInfoItem.result.referenceCount} max={6} onOpen={openReferencePreview} onContextMenu={openReferenceContextMenu} />
                  </section>
                  <label className="detailInfoPrompt">
                    <span>提示词</span>
                    <textarea value={detailInfoItem.prompt.text} readOnly />
                  </label>
                  <div className="detailInfoActions">
                    <button className="smallButton" type="button" onClick={() => void copyText(detailInfoItem.prompt.text, "提示词已复制")}>
                      <Copy size={14} />
                      <span>复制提示词</span>
                    </button>
                    <button className="smallButton" type="button" onClick={() => rerunResult(detailInfoItem.result, 1)}>
                      <RotateCcw size={14} />
                      <span>重刷</span>
                    </button>
                    <button className="smallButton" type="button" onClick={() => void downloadItem(detailInfoItem.result, 0)}>
                      <Download size={14} />
                      <span>下载</span>
                    </button>
                  </div>
                </aside>
              )}

              {events.length > 0 && (
                <div className="eventPill">
                  <strong>{events[0].label}</strong>
                  <span>{events[0].detail}</span>
                </div>
              )}
            </section>
          </section>
        ) : activeView === "infinite-canvas" ? (
          <section className="infiniteCanvasView">
            <aside className="canvasToolPanel">
              <header>
                <div>
                  <strong>{activeCanvas?.name || "无限画布"}</strong>
                  <span>{canvasStatusText}</span>
                </div>
              </header>

              <div className="canvasToolGroup">
                <button className="smallButton" type="button" onClick={() => addCanvasNode("prompt", canvasCenterPoint(-180, -80))}>
                  <FileText size={15} />
                  <span>提示词</span>
                </button>
                <button className="smallButton" type="button" onClick={() => addCanvasNode("generator", canvasCenterPoint(40, -120))}>
                  <Sparkles size={15} />
                  <span>生图</span>
                </button>
                <button className="smallButton" type="button" onClick={() => canvasFileInputRef.current?.click()}>
                  <Upload size={15} />
                  <span>图片</span>
                </button>
                <input
                  ref={canvasFileInputRef}
                  type="file"
                  accept="image/*"
                  multiple
                  onChange={(event) => {
                    void addCanvasFiles(event.target.files);
                    event.target.value = "";
                  }}
                />
              </div>

              <div className="canvasToolGroup">
                <button className="smallButton" type="button" onClick={createCanvas}>
                  <Plus size={15} />
                  <span>新建</span>
                </button>
                <button className="smallButton" type="button" onClick={renameCanvas} disabled={!activeCanvas}>
                  <Pencil size={15} />
                  <span>重命名</span>
                </button>
                <button className="dangerButton" type="button" onClick={deleteCanvas} disabled={!activeCanvas}>
                  <Trash2 size={15} />
                  <span>删除画布</span>
                </button>
              </div>

              <section className="canvasConnectionList">
                <strong>连线</strong>
                {(activeCanvas?.connections || []).map((connection) => {
                  const fromNode = activeCanvas.nodes.find((node) => node.id === connection.fromNodeId);
                  const toNode = activeCanvas.nodes.find((node) => node.id === connection.toNodeId);
                  return (
                    <div key={connection.id}>
                      <span>{fromNode?.title || "节点"} → {toNode?.title || "节点"}</span>
                      <button className="iconButton" type="button" onClick={() => removeCanvasConnection(connection.id)} title="断开">
                        <Unlink size={14} />
                      </button>
                    </div>
                  );
                })}
                {(!activeCanvas || activeCanvas.connections.length === 0) && <p>暂无连线</p>}
              </section>
            </aside>

            <section
              className={`infiniteCanvasStage ${canvasDrag?.type === "pan" ? "panning" : ""}`}
              ref={canvasStageRef}
              onWheel={handleCanvasWheel}
              onPointerDown={beginCanvasPan}
              onPointerMove={moveCanvasDrag}
              onPointerUp={endCanvasDrag}
              onPointerCancel={endCanvasDrag}
              onDragOver={(event) => {
                if (!Array.from(event.dataTransfer?.types || []).includes("Files")) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "copy";
              }}
              onDrop={handleCanvasDrop}
            >
              <div className="infiniteCanvasGrid" />
              {activeCanvas && (
                <div
                  className="infiniteWorld"
                  style={{ transform: `translate(${canvasViewport.x}px, ${canvasViewport.y}px) scale(${canvasViewport.scale})` }}
                >
                  <svg className="infiniteLinks" aria-hidden="true">
                    {activeCanvas.connections.map((connection) => {
                      const fromNode = activeCanvas.nodes.find((node) => node.id === connection.fromNodeId);
                      const toNode = activeCanvas.nodes.find((node) => node.id === connection.toNodeId);
                      if (!fromNode || !toNode) return null;
                      const fromX = fromNode.x + fromNode.w;
                      const fromY = fromNode.y + 44;
                      const toX = toNode.x;
                      const toY = toNode.y + 44;
                      return (
                        <path
                          key={connection.id}
                          d={`M ${fromX} ${fromY} C ${fromX + 90} ${fromY}, ${toX - 90} ${toY}, ${toX} ${toY}`}
                        />
                      );
                    })}
                  </svg>

                  {activeCanvas.nodes.map((node) => {
                    const selected = canvasSelectedNodeId === node.id;
                    const nodeTasks = canvasTasks.filter((task) => task.canvasId === activeCanvas.id && task.nodeId === node.id);
                    const incomingNodes = node.type === "generator" ? incomingCanvasNodes(activeCanvas, node.id) : [];
                    const incomingImages = node.type === "generator" ? canvasImagesForGenerator(activeCanvas, node) : [];
                    const incomingImageEntries = node.type === "generator" ? canvasImageEntriesForGenerator(activeCanvas, node) : [];
                    const batchParts = node.type === "generator" ? splitCanvasBatchEntries(incomingImageEntries) : { modelEntries: [], fixedEntries: [] };
                    const resultItems = canvasResultItemsFromNode(node);
                    const nodeIcon = node.type === "generator"
                      ? <Sparkles size={15} />
                      : node.type === "prompt"
                        ? <FileText size={15} />
                        : node.type === "output"
                          ? <Layers size={15} />
                          : <ImageIcon size={15} />;
                    return (
                      <article
                        className={`infiniteNode ${node.type} ${selected ? "selected" : ""}`}
                        key={node.id}
                        style={{ left: node.x, top: node.y, width: node.w, minHeight: node.h }}
                        onPointerDown={(event) => beginCanvasNodeDrag(event, node.id)}
                      >
                        {node.type !== "generator" && (
                          <button
                            className={`nodePort output ${canvasConnectStart?.nodeId === node.id ? "active" : ""}`}
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              beginCanvasConnection(node.id);
                            }}
                            title="输出"
                          >
                            <Link2 size={13} />
                          </button>
                        )}
                        {node.type === "generator" && (
                          <button
                            className={`nodePort input ${canvasConnectStart ? "ready" : ""}`}
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              completeCanvasConnection(node.id);
                            }}
                            title="输入"
                          >
                            <Link2 size={13} />
                          </button>
                        )}
                        <header>
                          <span>{nodeIcon}</span>
                          <input
                            value={node.title}
                            onChange={(event) => updateCanvasNode(node.id, { title: event.target.value })}
                            onPointerDown={(event) => event.stopPropagation()}
                          />
                          <button className="iconButton" type="button" onClick={() => deleteCanvasNode(node.id)} title="删除节点">
                            <X size={14} />
                          </button>
                        </header>

                        {node.type === "prompt" && (
                          <textarea
                            className="canvasPromptTextarea"
                            value={node.text}
                            onChange={(event) => updateCanvasNode(node.id, { text: event.target.value })}
                            onPointerDown={(event) => event.stopPropagation()}
                          />
                        )}

                        {node.type === "image" && node.result && (
                          <>
                            <button
                              className="canvasImagePreview"
                              type="button"
                              onClick={() => openPreview(node.result)}
                              onContextMenu={(event) => openContextMenu(event, node.result.id)}
                            >
                              <img src={imageSourceFromResult(node.result.image)} alt={node.title} draggable={false} />
                            </button>
                            <label className="canvasImageRole">
                              <span>角色</span>
                              <select
                                value={node.role || "auto"}
                                onChange={(event) => updateCanvasNode(node.id, { role: event.target.value })}
                                onPointerDown={(event) => event.stopPropagation()}
                              >
                                {canvasImageRoleOptions.map((option) => (
                                  <option key={option.value} value={option.value}>{option.label}</option>
                                ))}
                              </select>
                            </label>
                            <textarea
                              className="canvasNodePrompt"
                              value={node.prompt || ""}
                              onChange={(event) => updateCanvasNode(node.id, { prompt: event.target.value })}
                              onPointerDown={(event) => event.stopPropagation()}
                              placeholder="参考备注"
                            />
                            <button className="smallButton" type="button" onClick={() => void downloadItem(node.result, 0)}>
                              <Download size={14} />
                              <span>下载</span>
                            </button>
                          </>
                        )}

                        {node.type === "generator" && (
                          <div className="canvasGeneratorBody">
                            <div className="canvasNodeStats">
                              <span>输入 {incomingNodes.length}</span>
                              <span>参考图 {incomingImages.length}</span>
                              <span>模特 {batchParts.modelEntries.length}</span>
                              <span>固定 {batchParts.fixedEntries.length}</span>
                            </div>
                            <label>
                              <span>模式</span>
                              <select
                                value={node.params?.batchMode || "single"}
                                onChange={(event) => updateCanvasNode(node.id, {
                                  params: { ...node.params, batchMode: event.target.value }
                                })}
                                onPointerDown={(event) => event.stopPropagation()}
                              >
                                {canvasBatchModeOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                              </select>
                            </label>
                            <label>
                              <span>模型</span>
                              <select
                                value={node.params?.model || settings.model}
                                onChange={(event) => updateCanvasNode(node.id, {
                                  params: { ...node.params, model: event.target.value }
                                })}
                                onPointerDown={(event) => event.stopPropagation()}
                              >
                                {models.map((model) => <option key={model.value} value={model.value}>{model.label}</option>)}
                              </select>
                            </label>
                            <label>
                              <span>比例</span>
                              <select
                                value={node.params?.aspectRatio || settings.aspectRatio}
                                onChange={(event) => updateCanvasNode(node.id, {
                                  params: { ...node.params, aspectRatio: event.target.value }
                                })}
                                onPointerDown={(event) => event.stopPropagation()}
                              >
                                {(models.find((model) => model.value === (node.params?.model || settings.model))?.ratios || ratios).map((ratio) => (
                                  <option key={ratio} value={ratio}>{ratio}</option>
                                ))}
                              </select>
                            </label>
                            <label>
                              <span>清晰度</span>
                              <select
                                value={node.params?.imageSize || settings.imageSize}
                                onChange={(event) => updateCanvasNode(node.id, {
                                  params: { ...node.params, imageSize: event.target.value }
                                })}
                                onPointerDown={(event) => event.stopPropagation()}
                              >
                                {IMAGE_SIZES.map((size) => <option key={size} value={size}>{size}</option>)}
                              </select>
                            </label>
                            <label>
                              <span>数量</span>
                              <select
                                value={node.params?.n || 1}
                                onChange={(event) => updateCanvasNode(node.id, {
                                  params: { ...node.params, n: clampCount(event.target.value) }
                                })}
                                onPointerDown={(event) => event.stopPropagation()}
                              >
                                {COUNT_OPTIONS.map((count) => <option key={count} value={count}>{count}</option>)}
                              </select>
                            </label>
                            <textarea
                              value={node.prompt || ""}
                              onChange={(event) => updateCanvasNode(node.id, { prompt: event.target.value })}
                              onPointerDown={(event) => event.stopPropagation()}
                              placeholder="补充提示词"
                            />
                            <button className="generateButton" type="button" onClick={() => void generateCanvasNode(node.id)}>
                              {nodeTasks.length > 0 ? <Loader2 className="spin" size={15} /> : <Play size={15} />}
                              <span>生成输出</span>
                            </button>
                            {nodeTasks.map((task) => (
                              <small className="canvasTaskLine" key={task.id}>{task.taskLabel || "任务"} · {formatMs(nowTick - task.startedAt)} · {task.modelLabel}</small>
                            ))}
                            {node.error && <strong className="canvasNodeError">{node.error}</strong>}
                            {node.generationMs && !node.error && <small className="canvasTaskLine">上次 {formatMs(node.generationMs)}</small>}
                          </div>
                        )}

                        {node.type === "output" && (
                          <div className="canvasOutputBody">
                            <div className="canvasOutputGrid">
                              {resultItems.map((result, resultIndex) => (
                                <button
                                  type="button"
                                  key={result.id}
                                  onClick={() => openPreview(result)}
                                  onContextMenu={(event) => openContextMenu(event, result.id)}
                                >
                                  <img src={imageSourceFromResult(result.image)} alt={`输出 ${resultIndex + 1}`} draggable={false} />
                                </button>
                              ))}
                            </div>
                            <button className="smallButton" type="button" onClick={() => void copyText(node.prompt, "提示词已复制")}>
                              <Copy size={14} />
                              <span>复制提示词</span>
                            </button>
                            {node.generationMs && <small className="canvasTaskLine">用时 {formatMs(node.generationMs)}</small>}
                          </div>
                        )}
                      </article>
                    );
                  })}
                </div>
              )}

              {events.length > 0 && (
                <div className="eventPill">
                  <strong>{events[0].label}</strong>
                  <span>{events[0].detail}</span>
                </div>
              )}
            </section>
          </section>
        ) : activeView === "reference-remix" ? (
          <section className="referenceWorkbench">
            <aside className="referenceInputPanel">
              <div className="detailPanelScroll">
                <DetailUploadZone
                  title="产品图（主体锁定）"
                  subtitle={`产品图 + 参考图合计最多 ${MAX_REFERENCE_REWRITE_FILES} 张`}
                  previews={referenceProductPreviews}
                  count={referenceProductFiles.length + referenceStyleFiles.length}
                  maxCount={MAX_REFERENCE_REWRITE_FILES}
                  inputRef={referenceProductInputRef}
                  onPick={(event) => {
                    addReferenceRewriteFiles("product", event.target.files);
                    event.target.value = "";
                  }}
                  onAddFiles={(fileList) => addReferenceRewriteFiles("product", fileList)}
                  onRemove={(index) => removeReferenceRewriteFile("product", index)}
                  onPreview={openUploadPreview}
                  onAssetLibrary={() => markDeferredFeature("素材库")}
                />

                <DetailUploadZone
                  title="参考图（运营参考）"
                  subtitle={`元素、构图、场景方向 · 与产品图合计最多 ${MAX_REFERENCE_REWRITE_FILES} 张`}
                  previews={referenceStylePreviews}
                  count={referenceProductFiles.length + referenceStyleFiles.length}
                  maxCount={MAX_REFERENCE_REWRITE_FILES}
                  inputRef={referenceStyleInputRef}
                  onPick={(event) => {
                    addReferenceRewriteFiles("style", event.target.files);
                    event.target.value = "";
                  }}
                  onAddFiles={(fileList) => addReferenceRewriteFiles("style", fileList)}
                  onRemove={(index) => removeReferenceRewriteFile("style", index)}
                  onPreview={openUploadPreview}
                  onAssetLibrary={() => markDeferredFeature("素材库")}
                />

                <div className="detailDivider" />

                <section className="detailFormSection">
                  <h3>参考控制</h3>
                  <div className="detailParamGrid">
                    <label>
                      <span>图片模型</span>
                      <select value={referenceSettings.model} onChange={(event) => updateReferenceSetting("model", event.target.value)}>
                        {models.map((model) => <option key={model.value} value={model.value}>{model.label}</option>)}
                      </select>
                    </label>
                    <label>
                      <span>图片比例</span>
                      <select value={referenceSettings.aspectRatio} onChange={(event) => updateReferenceSetting("aspectRatio", event.target.value)}>
                        {referenceRatios.map((ratio) => <option key={ratio} value={ratio}>{ratio}</option>)}
                      </select>
                    </label>
                    <label>
                      <span>分辨率</span>
                      <select value={referenceSettings.imageSize} onChange={(event) => updateReferenceSetting("imageSize", event.target.value)}>
                        {IMAGE_SIZES.map((size) => <option key={size} value={size}>{size}</option>)}
                      </select>
                    </label>
                    <label>
                      <span>生成数量</span>
                      <select value={referenceSettings.n} onChange={(event) => updateReferenceSetting("n", event.target.value)}>
                        {COUNT_OPTIONS.map((count) => <option key={count} value={count}>{count}张</option>)}
                      </select>
                    </label>
                    <label>
                      <span>参考值</span>
                      <select value={referenceSettings.strength} onChange={(event) => updateReferenceSetting("strength", event.target.value)}>
                        {REFERENCE_STRENGTH_OPTIONS.map((value) => <option key={value} value={value}>{value}%</option>)}
                      </select>
                    </label>
                    <label>
                      <span>参考元素</span>
                      <select value={referenceSettings.element} onChange={(event) => updateReferenceSetting("element", event.target.value)}>
                        {referenceControlOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                      </select>
                    </label>
                    <label>
                      <span>参考构图</span>
                      <select value={referenceSettings.composition} onChange={(event) => updateReferenceSetting("composition", event.target.value)}>
                        {referenceControlOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                      </select>
                    </label>
                    <label>
                      <span>参考场景主题</span>
                      <select value={referenceSettings.scene} onChange={(event) => updateReferenceSetting("scene", event.target.value)}>
                        {referenceControlOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                      </select>
                    </label>
                  </div>
                </section>

                <section className="detailFormSection">
                  <div className="referencePromptHeader">
                    <h3>整体提示词</h3>
                    <button className="smallButton" type="button" onClick={() => void applySmartReferencePrompt()} disabled={isReferencePromptRewriting}>
                      {isReferencePromptRewriting ? <Loader2 className="spin" size={15} /> : <Wand2 size={15} />}
                      <span>智能扩写提示词</span>
                    </button>
                  </div>
                  <label className="detailField">
                    <span>生成要求</span>
                    <textarea
                      value={referenceSettings.prompt}
                      onChange={(event) => updateReferenceSetting("prompt", event.target.value)}
                      placeholder="例：生成一张女装主图，浅色调，干净电商质感，突出面料和版型，不要照抄参考图文字。"
                    />
                  </label>
                  <p className="referenceHint">
                    30% 以下参考意义很弱，所以这里从 30% 起步；参考越高越接近运营图方向，但后台会强制避开照抄、品牌、水印和相同文字。
                  </p>
                </section>
              </div>

              <div className="detailPanelFooter">
                <button className="generateButton" type="button" onClick={() => void generateReferenceRemix()}>
                  {runningReferenceTasks.length > 0 ? <Loader2 className="spin" size={16} /> : <Play size={16} />}
                  <span>生成参考图</span>
                </button>
              </div>
            </aside>

            <section className="referenceResultBoard">
              <header className="referenceBoardHeader">
                <div>
                  <strong>参考生图结果</strong>
                  <span>结果只保存在参考生图模块，不进入快捷生成和一键详情分屏。</span>
                </div>
              </header>

              <div className="referenceGallery">
                {referenceGalleryItems.map((galleryItem, index) => {
                  if (galleryItem.kind === "task") {
                    const task = galleryItem.task;
                    return (
                      <article className="assetCard loadingCard referenceAssetCard" key={galleryItem.key}>
                        <Loader2 className="spin" size={28} />
                        <span>参考生图中</span>
                        <strong>{formatMs(nowTick - task.startedAt)}</strong>
                        <em>{task.modelLabel} · {task.imageSize} · {task.aspectRatio}</em>
                      </article>
                    );
                  }
                  const item = galleryItem.result;
                  const src = imageSourceFromResult(item.image);
                  const promptText = item.displayPrompt || item.prompt;
                  return (
                    <article
                      className="assetCard referenceAssetCard"
                      key={galleryItem.key}
                      onClick={() => openPreview(item)}
                      onContextMenu={(event) => openContextMenu(event, item.id)}
                    >
                      <button
                        className={`assetDownloadButton ${downloadFeedbackIds.has(item.id) ? "downloaded" : ""}`}
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          void downloadItem(item, index);
                        }}
                        title="下载到指定文件夹"
                        aria-label="下载到指定文件夹"
                      >
                        {downloadFeedbackIds.has(item.id) ? <Check size={16} /> : <Download size={16} />}
                      </button>
                      {item.generationMs && <div className="assetTimeBadge">用时 {formatMs(item.generationMs)}</div>}
                      <CachedImage src={src} alt={`参考生图 ${index + 1}`} draggable onDragStart={(event) => beginResultImageDrag(event, item)} />
                      <ReferenceThumbTray references={item.references} count={item.referenceCount} className="assetReferenceTray" onOpen={openReferencePreview} onContextMenu={openReferenceContextMenu} />
                      {promptText && (
                        <button
                          className="assetPrompt"
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            copyText(promptText, "提示词已复制");
                          }}
                          title={promptText}
                        >
                          {promptText}
                        </button>
                      )}
                      <div className="assetMeta">
                        <span>{item.modelLabel}</span>
                        <strong>{item.referenceStrength || referenceSettings.strength}% · {item.imageSize}</strong>
                      </div>
                    </article>
                  );
                })}
              </div>

              {referenceResults.length === 0 && runningReferenceTasks.length === 0 && (
                <div className="referenceEmpty">
                  <Layers size={34} />
                  <span>{referenceStatus === "failed" ? referenceError : "上传产品图和运营参考图后开始生成"}</span>
                </div>
              )}

              {events.length > 0 && (
                <div className="eventPill">
                  <strong>{events[0].label}</strong>
                  <span>{events[0].detail}</span>
                </div>
              )}
            </section>
          </section>
        ) : (
        <div className="canvasBoard" onWheel={onQuickBoardWheel}>
          <section ref={quickGalleryRef} className="galleryStrip" style={{ "--asset-card-min": `${galleryCardMin}px` }}>
            {quickGalleryItems.map((galleryItem, index) => {
              if (galleryItem.kind === "task") {
                const task = galleryItem.task;
                return (
                  <article className="assetCard loadingCard" key={galleryItem.key}>
                    <Loader2 className="spin" size={28} />
                    <span>生成中</span>
                    <strong>{formatMs(nowTick - task.startedAt)}</strong>
                    <em>{task.modelLabel} · {task.imageSize} · {task.aspectRatio}</em>
                  </article>
                );
              }
              const item = galleryItem.result;
              const src = imageSourceFromResult(item.image);
              const selected = selectedIds.has(item.id);
              return (
                <article
                  className="assetCard"
                  key={galleryItem.key}
                  onClick={() => openPreview(item)}
                  onContextMenu={(event) => openContextMenu(event, item.id)}
                >
                  <button
                    className="selectBox"
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      toggleSelected(item.id);
                    }}
                    aria-label="选择图片"
                  >
                    {selected ? <CheckSquare size={24} /> : <Square size={24} />}
                  </button>
                  <button
                    className={`assetDownloadButton ${downloadFeedbackIds.has(item.id) ? "downloaded" : ""}`}
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      void downloadItem(item, index);
                    }}
                    title="下载到指定文件夹"
                    aria-label="下载到指定文件夹"
                  >
                    {downloadFeedbackIds.has(item.id) ? <Check size={16} /> : <Download size={16} />}
                  </button>
                  {item.generationMs && <div className="assetTimeBadge">用时 {formatMs(item.generationMs)}</div>}
                  <CachedImage src={src} alt={`生成图片 ${index + 1}`} draggable onDragStart={(event) => beginResultImageDrag(event, item)} />
                  <ReferenceThumbTray references={item.references} count={item.referenceCount} className="assetReferenceTray" onOpen={openReferencePreview} onContextMenu={openReferenceContextMenu} />
                  {item.prompt && (
                    <button
                      className="assetPrompt"
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        copyText(item.prompt, "提示词已复制");
                      }}
                      title={item.prompt}
                    >
                      {item.prompt}
                    </button>
                  )}
                  <div className="assetMeta">
                    <span>{item.modelLabel}</span>
                    <strong>{item.imageSize} · {item.aspectRatio}</strong>
                  </div>
                </article>
              );
            })}
          </section>

          {quickResults.length === 0 && runningQuickTasks.length === 0 && (
            <div className="emptyCanvas">
              <ImageIcon size={34} />
              <span>{status === "failed" ? error : "暂无图片"}</span>
            </div>
          )}

          <section
            className={`composer ${isComposerDragging ? "dragging" : ""}`}
            onDragOver={onComposerDragOver}
            onDragLeave={onComposerDragLeave}
            onDrop={onComposerDrop}
            onPaste={onComposerPaste}
          >
            <div className="modeTabs">
              <button className="modeTab active" type="button"><ImageIcon size={15} /> 图片生成</button>
              <button className="modeTab" type="button"><Video size={15} /> 视频生成</button>
            </div>

            {previewFiles.length > 0 && (
              <div className="composerReferences">
                <div
                  className={`referenceInsertZone ${referenceDropTarget?.type === "insert" && referenceDropTarget.index === 0 ? "active" : ""}`}
                  onDragOver={(event) => beginReferenceDrop(event, "insert", 0)}
                  onDragLeave={endReferenceDrop}
                  onDrop={(event) => onReferenceDrop(event, "insert", 0)}
                  title="拖到这里插入图片"
                />
                {previewFiles.map((item, index) => (
                  <React.Fragment key={item.id || `${item.file.name}-${item.file.lastModified}-${index}`}>
                    <div className="referenceThumbWrap">
                      <div
                      className={`referenceThumb ${referenceDropTarget?.type === "replace" && referenceDropTarget.index === index ? "replaceTarget" : ""} ${item.cropEdit ? "cropEditReady" : ""} ${item.localEdit ? "localEditReady" : ""}`}
                      data-reference-index={index}
                      draggable={false}
                      onDragOver={(event) => beginReferenceDrop(event, "replace", index)}
                      onDragLeave={endReferenceDrop}
                      onDrop={(event) => onReferenceDrop(event, "replace", index)}
                      onClick={() => openUploadPreview(item)}
                      title={`${item.file.name} · ${fileSize(item.file.size)}，拖新图到这里可替换`}
                    >
                      <b>图{index + 1}</b>
                      <img src={item.url} alt={item.file.name} draggable={false} />
                      <button
                        type="button"
                        onClick={(event) => { event.stopPropagation(); removeReferenceImage(index); }}
                        onPointerDown={(event) => event.stopPropagation()}
                        aria-label="移除参考图"
                      >
                        <X size={12} />
                      </button>
                      </div>
                      <div className="referenceToolRow">
                        <button
                          className={`referenceToolButton ${item.cropEdit ? "active" : ""}`}
                          type="button"
                          onClick={(event) => { event.stopPropagation(); openQuickCropEdit(item); }}
                          title={item.cropEdit ? "重新调整普通裁剪" : "普通裁剪"}
                          aria-label={item.cropEdit ? "重新调整普通裁剪" : "普通裁剪"}
                        >
                          <Crop size={14} />
                        </button>
                        <button
                          className={`referenceToolButton ${item.localEdit ? "active" : ""}`}
                          type="button"
                          onClick={(event) => { event.stopPropagation(); openQuickLocalEdit(item); }}
                          title={item.localEdit ? "重新调整局部回贴" : "局部回贴"}
                          aria-label={item.localEdit ? "重新调整局部回贴" : "局部回贴"}
                        >
                          <Scissors size={14} />
                        </button>
                      </div>
                    </div>
                    <div
                      className={`referenceInsertZone ${referenceDropTarget?.type === "insert" && referenceDropTarget.index === index + 1 ? "active" : ""}`}
                      onDragOver={(event) => beginReferenceDrop(event, "insert", index + 1)}
                      onDragLeave={endReferenceDrop}
                      onDrop={(event) => onReferenceDrop(event, "insert", index + 1)}
                      title="拖到这里插入图片"
                    />
                  </React.Fragment>
                ))}
              </div>
            )}

            <textarea
              className="promptBox"
              value={settings.prompt}
              onChange={(event) => updateSetting("prompt", event.target.value)}
              placeholder="输入你要生成或修改的画面"
            />

            <div className="composerFooter">
              <div className="leftTools">
                <input ref={inputRef} type="file" accept="image/*" multiple onChange={onPickFiles} />
                <button className="smallButton" type="button" onClick={() => inputRef.current?.click()}>
                  <Upload size={16} />
                  <span>上传 ({files.length}/{MAX_REFERENCE_FILES})</span>
                </button>
                <button className="smallButton" type="button" onClick={() => { setFiles([]); setQuickCropEditTarget(null); setQuickLocalEditTarget(null); }}>
                  <Trash2 size={16} />
                  <span>清空图片</span>
                </button>
                <button className="smallButton" type="button" onClick={() => addEvent("素材库", "素材库模块暂未接入")}>
                  <Library size={16} />
                  <span>库</span>
                </button>
                <button className="smallButton" type="button" onClick={() => setIsPromptAssistantOpen(true)}>
                  <BookOpen size={16} />
                  <span>词</span>
                </button>
              </div>

              <div className="rightTools">
                <select value={settings.model} onChange={(event) => updateSetting("model", event.target.value)}>
                  {models.map((model) => <option key={model.value} value={model.value}>{model.label}</option>)}
                </select>
                <select value={settings.aspectRatio} onChange={(event) => updateSetting("aspectRatio", event.target.value)}>
                  {ratios.map((ratio) => <option key={ratio} value={ratio}>{ratio}</option>)}
                </select>
                <select value={settings.imageSize} onChange={(event) => updateSetting("imageSize", event.target.value)}>
                  {IMAGE_SIZES.map((size) => <option key={size} value={size}>{size}</option>)}
                </select>
                <select value={settings.n} onChange={(event) => updateSetting("n", event.target.value)}>
                  {COUNT_OPTIONS.map((count) => <option key={count} value={count}>{count}张</option>)}
                </select>
                <button className="smallButton" type="button" onClick={() => void optimizePrompt()} disabled={isQuickPromptOptimizing}>
                  {isQuickPromptOptimizing ? <Loader2 className="spin" size={16} /> : <Wand2 size={16} />}
                  <span>优化提示词</span>
                </button>
                <button className="generateButton" type="button" onClick={() => generate()}>
                  {runningQuickTasks.length > 0 ? <Loader2 className="spin" size={17} /> : <Play size={17} />}
                  <span>生成</span>
                </button>
              </div>
            </div>
          </section>

          {events.length > 0 && (
            <div className="eventPill">
              <strong>{events[0].label}</strong>
              <span>{events[0].detail}</span>
            </div>
          )}
        </div>
        )}
      </section>

      {isDirectoryModalOpen && (
        <div className="modalLayer" onMouseDown={() => setIsDirectoryModalOpen(false)}>
          <section className="saveDirectoryModal" onMouseDown={(event) => event.stopPropagation()}>
            <header>
              <div>
                <h2>指定文件夹</h2>
                <span>生成图片将保存到这个目录</span>
              </div>
              <button className="iconButton" type="button" onClick={() => setIsDirectoryModalOpen(false)} aria-label="关闭">
                <X size={18} />
              </button>
            </header>
            <label className="modalField">
              <span><FolderOpen size={15} /> 保存目录</span>
              <input
                value={directoryDraft}
                readOnly
                onClick={() => void pickSaveDirectory()}
                placeholder="例如 D:\RJ\静音内测\data\asset-library"
                title="点击选择保存目录"
              />
              <small className="fieldHint">
                {isPickingDirectory ? "正在等待目录选择..." : "点击输入框选择目录，点击确定后生效"}
              </small>
            </label>
            <footer className="directoryModalActions">
              <div>
                <button className="smallButton" type="button" onClick={() => setIsDirectoryModalOpen(false)}>取消</button>
                <button className="generateButton" type="button" onClick={() => void confirmSaveDirectory()}>确定</button>
              </div>
            </footer>
          </section>
        </div>
      )}

      {isDetailPresetOpen && (
        <div className="modalLayer" onMouseDown={() => setIsDetailPresetOpen(false)}>
          <section className="detailPresetModal" onMouseDown={(event) => event.stopPropagation()}>
            <header>
              <div>
                <h2>加载详情预设</h2>
                <span>恢复一键详情/主图的参数与文案</span>
              </div>
              <button className="iconButton" type="button" onClick={() => setIsDetailPresetOpen(false)} aria-label="关闭">
                <X size={18} />
              </button>
            </header>
            <div className="detailPresetList">
              {detailPresets.map((preset) => (
                <article className="detailPresetItem" key={preset.id}>
                  <button type="button" onClick={() => loadDetailPreset(preset)}>
                    <strong>{preset.name}</strong>
                    <span>{new Date(preset.createdAt).toLocaleString("zh-CN", { hour12: false })}</span>
                  </button>
                  <button className="iconButton" type="button" onClick={() => deleteDetailPreset(preset.id)} title="删除预设">
                    <Trash2 size={15} />
                  </button>
                </article>
              ))}
              {detailPresets.length === 0 && <p className="promptEmpty">还没有保存过详情预设</p>}
            </div>
          </section>
        </div>
      )}

      {isSettingsOpen && (
        <div className="modalLayer" onMouseDown={() => setIsSettingsOpen(false)}>
          <section className="settingsModal" onMouseDown={(event) => event.stopPropagation()}>
            <header>
              <div>
                <h2>设置</h2>
                <span>API Key 与界面皮肤</span>
              </div>
              <button className="iconButton" type="button" onClick={() => setIsSettingsOpen(false)} aria-label="关闭">
                <X size={18} />
              </button>
            </header>

            <label className="modalField">
              <span><KeyRound size={15} /> API Key</span>
              <div className="apiKeyRow">
                <input
                  type={isApiKeyVisible ? "text" : "password"}
                  value={settings.apiKey}
                  placeholder={config.hasServerKey ? "服务器已配置" : "sk-..."}
                  onChange={(event) => updateSetting("apiKey", event.target.value)}
                />
                <button
                  className="iconButton"
                  type="button"
                  onClick={() => setIsApiKeyVisible((current) => !current)}
                  title={isApiKeyVisible ? "隐藏 API Key" : "显示 API Key"}
                >
                  {isApiKeyVisible ? <EyeOff size={17} /> : <Eye size={17} />}
                </button>
                <button className="smallButton saveKeyButton" type="button" onClick={saveApiKey}>
                  <Save size={15} />
                  <span>保存</span>
                </button>
              </div>
              {apiSaveStatus && <small className="fieldHint">{apiSaveStatus}</small>}
            </label>

            <div className="skinBlock">
              <span><Palette size={15} /> 皮肤</span>
              <div className="themeGrid">
                {themeOptions.map((theme) => (
                  <button
                    className={`themeButton ${settings.theme === theme.value ? "selected" : ""}`}
                    key={theme.value}
                    type="button"
                    onClick={() => updateSetting("theme", theme.value)}
                  >
                    <i>
                      {theme.colors.map((color) => <b key={color} style={{ backgroundColor: color }} />)}
                    </i>
                    <span>{theme.label}</span>
                  </button>
                ))}
              </div>
            </div>
          </section>
        </div>
      )}

      {isPromptAssistantOpen && (
        <div className="modalLayer promptLayer" onMouseDown={() => setIsPromptAssistantOpen(false)}>
          <section className="promptAssistantModal" onMouseDown={(event) => event.stopPropagation()}>
            <header>
              <h2>提示词助手</h2>
              <button className="iconButton" type="button" onClick={() => setIsPromptAssistantOpen(false)} aria-label="关闭">
                <X size={18} />
              </button>
            </header>
            <div className="promptAssistantBody">
              <div className="promptTabs">
                {promptCategories.map((category) => (
                  <span className="promptCategoryItem" key={category}>
                    <button
                      className={[
                        "promptTab",
                        promptCategory === category ? "active" : "",
                        promptDropCategory === category ? "dropTarget" : "",
                        draggedPromptCategory === category ? "categoryDragging" : "",
                        promptCategoryDropTarget?.category === category ? `categoryDrop-${promptCategoryDropTarget.edge}` : ""
                      ].filter(Boolean).join(" ")}
                      type="button"
                      draggable={category !== "全部"}
                      onClick={() => setPromptCategory(category)}
                      onDoubleClick={(event) => {
                        if (category === "全部") return;
                        event.preventDefault();
                        event.stopPropagation();
                        renamePromptCategory(category);
                      }}
                      onDragStart={(event) => beginPromptCategoryDrag(event, category)}
                      onDragEnd={endPromptCategoryDrag}
                      onDragOver={(event) => dragPromptCategoryOver(event, category)}
                      onDragLeave={() => {
                        setPromptDropCategory("");
                        setPromptCategoryDropTarget(null);
                      }}
                      onDrop={(event) => dropOnPromptCategory(event, category)}
                      title={category === "全部" ? "全部分类" : "双击改名，按住拖动调整顺序"}
                    >
                      {category}
                    </button>
                    {category !== "全部" && (
                      <button
                        className="promptCategoryDelete"
                        type="button"
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          deletePromptCategory(category);
                        }}
                        title={`删除分类「${category}」`}
                        aria-label={`删除分类${category}`}
                      >
                        <X size={11} />
                      </button>
                    )}
                  </span>
                ))}
                <button className="promptTab promptCategoryAdd" type="button" onClick={addPromptCategory} title="新建分类">
                  <Plus size={13} />
                  <span>新建</span>
                </button>
              </div>
              <label className="promptSearch">
                <Search size={16} />
                <input
                  value={promptSearch}
                  onChange={(event) => setPromptSearch(event.target.value)}
                  placeholder="搜索标题或内容..."
                />
              </label>
              <button className="newPromptButton" type="button" onClick={openNewPromptEditor}>
                <Plus size={15} />
                <span>新建提示词</span>
              </button>
              <div className="promptPresetGrid">
                {filteredPromptPresets.map((preset) => (
                  <div
                    className={`promptChip ${draggedPromptId === preset.id ? "dragging" : ""}`}
                    key={preset.id}
                    draggable
                    onDragStart={(event) => beginPromptDrag(event, preset.id)}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={(event) => dropPromptOnPreset(event, preset.id)}
                    onDragEnd={endPromptDrag}
                  >
                    <button
                      className="promptChipMain"
                      type="button"
                      onClick={() => applyPromptPreset(preset)}
                      title={preset.content}
                    >
                      {preset.title}
                    </button>
                    <button className="promptChipIcon" type="button" onClick={() => editPromptPreset(preset)} title="编辑提示词">
                      <Pencil size={14} />
                    </button>
                    <button className="promptChipIcon" type="button" onClick={() => deletePromptPreset(preset)} title="删除">
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
                {filteredPromptPresets.length === 0 && <p className="promptEmpty">没有找到匹配的提示词</p>}
              </div>
            </div>
          </section>
        </div>
      )}

      {editingPrompt && (
        <div className="modalLayer promptEditorLayer" onMouseDown={() => setEditingPrompt(null)}>
          <section className="promptEditorModal" onMouseDown={(event) => event.stopPropagation()}>
            <header>
              <h2>编辑提示词</h2>
              <button className="iconButton" type="button" onClick={() => setEditingPrompt(null)} aria-label="关闭">
                <X size={18} />
              </button>
            </header>
            <div className="promptEditorBody">
              <label className="editorField">
                <span>分类</span>
                <select
                  value={editingPrompt.category}
                  onChange={(event) => updateEditingPrompt("category", event.target.value)}
                >
                  {promptCategories.filter((category) => category !== "全部").map((category) => (
                    <option key={category} value={category}>{category}</option>
                  ))}
                </select>
              </label>
              <label className="editorField">
                <span>标题</span>
                <input
                  value={editingPrompt.title}
                  onChange={(event) => updateEditingPrompt("title", event.target.value)}
                  placeholder="输入标题"
                />
              </label>
              <label className="editorField">
                <span>提示词内容</span>
                <textarea
                  value={editingPrompt.content}
                  onChange={(event) => updateEditingPrompt("content", event.target.value)}
                  placeholder="输入提示词内容"
                />
              </label>
            </div>
            <footer>
              <button className="dangerButton editorDeleteButton" type="button" onClick={() => deletePromptPreset(editingPrompt)}>
                删除
              </button>
              <div>
                <button className="smallButton" type="button" onClick={() => setEditingPrompt(null)}>取消</button>
                <button className="generateButton editorSaveButton" type="button" onClick={saveEditingPrompt}>保存</button>
              </div>
            </footer>
          </section>
        </div>
      )}

      {stitchPreview && stitchGroup && (
        <div className="modalLayer stitchLayer" onMouseDown={closeStitchPreview}>
          <section className="stitchPreviewModal" onMouseDown={(event) => event.stopPropagation()}>
            <header>
              <div>
                <h2>拼图预览</h2>
                <span>{stitchGroup.label} · 共 {stitchItems.length} 屏</span>
              </div>
              <div className="stitchHeaderActions">
                <button className="darkButton" type="button" onClick={() => void downloadStitchPreview(stitchGroup)}>
                  <Download size={15} />
                  <span>下载长图</span>
                </button>
                <button className="iconButton" type="button" onClick={closeStitchPreview} aria-label="关闭">
                  <X size={18} />
                </button>
              </div>
            </header>
            <div
              className="stitchCanvasFrame"
              onWheel={handleStitchWheel}
              onPointerDown={beginStitchDrag}
              onPointerMove={moveStitchDrag}
              onPointerUp={endStitchDrag}
              onPointerCancel={endStitchDrag}
              onContextMenu={(event) => openStitchContextMenu(event, stitchGroup.id)}
              title="滚轮缩放，按住拖动画面"
            >
              <div
                className="stitchLongImage"
                style={{ transform: `translate(${stitchPan.x}px, ${stitchPan.y}px) scale(${stitchZoom})` }}
              >
                {stitchItems.map(({ prompt, result }) => (
                  <img
                    key={`${prompt.screen}-${result.id}`}
                    src={imageSourceFromResult(result.image)}
                    alt={`拼图第${prompt.screen}屏`}
                    draggable={false}
                  />
                ))}
              </div>
            </div>
          </section>
        </div>
      )}

      {quickCropEditTarget && (
        <QuickLocalEditModal
          item={quickCropEditTarget}
          mode="crop"
          ratio={settings.aspectRatio}
          onClose={() => setQuickCropEditTarget(null)}
          onApply={applyQuickCropEdit}
          onClear={clearQuickCropEdit}
        />
      )}

      {quickLocalEditTarget && (
        <QuickLocalEditModal
          item={quickLocalEditTarget}
          mode="local"
          ratio={settings.aspectRatio}
          onRatioChange={(nextRatio) => updateSetting("aspectRatio", nextRatio)}
          onClose={() => setQuickLocalEditTarget(null)}
          onApply={applyQuickLocalEdit}
          onClear={clearQuickLocalEdit}
        />
      )}

      {referencePreview && (
        <div className="modalLayer previewLayer" onMouseDown={closeReferencePreview}>
          <section className="previewModal referencePreviewModal" onMouseDown={(event) => event.stopPropagation()}>
            <header>
              <div>
                <h2>使用图预览</h2>
                <span>{referencePreview.items[referencePreview.index]?.name || `参考图 ${referencePreview.index + 1}`} · {referencePreview.index + 1}/{referencePreview.items.length}</span>
              </div>
              <button className="iconButton" type="button" onClick={closeReferencePreview} aria-label="关闭">
                <X size={18} />
              </button>
            </header>
            <div className="previewImageFrame referencePreviewFrame">
              {referencePreview.items.length > 1 && (
                <button className="previewArrow previewArrowLeft" type="button" onClick={(event) => { event.stopPropagation(); shiftReferencePreview(-1); }} disabled={referencePreview.index <= 0}>
                  <ChevronLeft size={22} />
                </button>
              )}
              <CachedImage
                src={referenceSource(referencePreview.items[referencePreview.index])}
                alt="使用图预览"
              />
              {referencePreview.items.length > 1 && (
                <button className="previewArrow previewArrowRight" type="button" onClick={(event) => { event.stopPropagation(); shiftReferencePreview(1); }} disabled={referencePreview.index >= referencePreview.items.length - 1}>
                  <ChevronRight size={22} />
                </button>
              )}
            </div>
          </section>
        </div>
      )}

      {uploadPreview && (
        <div className="modalLayer previewLayer" onMouseDown={closeUploadPreview}>
          <section className="previewModal" onMouseDown={(event) => event.stopPropagation()}>
            <header>
              <div>
                <h2>上传图片预览</h2>
                <span>{uploadPreview.name} · {fileSize(uploadPreview.size)}</span>
              </div>
              <button className="iconButton" type="button" onClick={closeUploadPreview} aria-label="关闭">
                <X size={18} />
              </button>
            </header>
            <div className="previewImageFrame uploadPreviewFrame" onMouseDown={closeUploadPreview} title="单击关闭">
              <img src={uploadPreview.url} alt={uploadPreview.name} />
            </div>
          </section>
        </div>
      )}

      {previewResult && (
        <div className="modalLayer previewLayer" onMouseDown={closePreview}>
          <section className="previewModal" onMouseDown={(event) => event.stopPropagation()}>
            <header>
              <div>
                <h2>图片预览</h2>
                <span>{previewResult.modelLabel} · {previewResult.imageSize} · {previewResult.aspectRatio}</span>
              </div>
              <button className="iconButton" type="button" onClick={closePreview} aria-label="关闭">
                <X size={18} />
              </button>
            </header>
            <div
              className="previewImageFrame"
              onWheel={handlePreviewWheel}
              onPointerDown={beginPreviewDrag}
              onPointerMove={movePreviewDrag}
              onPointerUp={endPreviewDrag}
              onPointerCancel={endPreviewDrag}
              onContextMenu={(event) => openContextMenu(event, previewResult.id)}
              title="滚轮缩放，按住拖动，单击关闭"
            >
              <CachedImage
                src={imageSourceFromResult(previewResult.image)}
                alt="放大预览"
                draggable
                onDragStart={(event) => beginResultImageDrag(event, previewResult)}
                style={{ transform: `translate(${previewPan.x}px, ${previewPan.y}px) scale(${previewZoom})` }}
              />
            </div>
            {previewResult.prompt && (
              <button
                className="previewPrompt"
                type="button"
                onClick={() => copyText(previewResult.prompt, "提示词已复制")}
                title="点击复制提示词"
              >
                {previewResult.prompt}
              </button>
            )}
          </section>
        </div>
      )}

      {referenceContextMenu?.reference && (
        <div
          className="imageContextMenu referenceContextMenu"
          style={{ left: referenceContextMenu.x, top: referenceContextMenu.y }}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
          <button type="button" onClick={() => void addReferenceThumbToUploads(referenceContextMenu.reference)}>
            <Upload size={15} />
            <span>发送到图片上传区</span>
          </button>
        </div>
      )}

      {stitchContextMenu && stitchContextGroup && (
        <div
          className="imageContextMenu stitchContextMenu"
          style={{ left: stitchContextMenu.x, top: stitchContextMenu.y }}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
          <button type="button" onClick={() => { void downloadStitchPreview(stitchContextGroup); setStitchContextMenu(null); }}>
            <Download size={15} />
            <span>下载长图</span>
          </button>
          <button type="button" onClick={() => { downloadDetailGroup(stitchContextGroup); setStitchContextMenu(null); }}>
            <Layers size={15} />
            <span>下载分屏</span>
          </button>
          <button type="button" onClick={() => { void openSaveDirectory(); setStitchContextMenu(null); }}>
            <FolderOpen size={15} />
            <span>打开保存目录</span>
          </button>
        </div>
      )}

      {contextMenu && contextItem && (
        <div
          className="imageContextMenu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
          <button type="button" onClick={() => { void copyImage(contextItem); setContextMenu(null); }}>
            <Copy size={15} />
            <span>复制</span>
          </button>
          <button type="button" onClick={() => { rerunResult(contextItem, 1); setContextMenu(null); }}>
            <RotateCcw size={15} />
            <span>重刷</span>
          </button>
          <button type="button" onClick={() => { rerunResult(contextItem, 4); setContextMenu(null); }}>
            <Flame size={15} />
            <span>重刷x4</span>
          </button>
          <button type="button" onClick={() => { void downloadItem(contextItem, contextIndex); setContextMenu(null); }}>
            <Download size={15} />
            <span>下载图片</span>
          </button>
          <button type="button" onClick={() => { void sendResultToImageEditor(contextItem, "base"); setContextMenu(null); }}>
            <Layers size={15} />
            <span>设为编辑底图</span>
          </button>
          <button type="button" onClick={() => { void sendResultToImageEditor(contextItem, "overlay"); setContextMenu(null); }}>
            <Move size={15} />
            <span>设为编辑上层</span>
          </button>
          {SHOW_INFINITE_CANVAS && (
            <button type="button" onClick={() => { sendResultToCanvas(contextItem); setContextMenu(null); }}>
              <Box size={15} />
              <span>发送到无限画布</span>
            </button>
          )}
          <button type="button" onClick={() => { markDeferredFeature("局部编辑"); setContextMenu(null); }}>
            <Crop size={15} />
            <span>局部编辑</span>
          </button>
          <button type="button" onClick={() => { void openSaveDirectory(); setContextMenu(null); }}>
            <FolderOpen size={15} />
            <span>打开所在目录</span>
          </button>
          <button type="button" onClick={() => { markDeferredFeature("转 PSD"); setContextMenu(null); }}>
            <Archive size={15} />
            <span>转 PSD</span>
          </button>
          <hr />
          <button className="contextDanger" type="button" onClick={() => { deleteResult(contextItem.id); setContextMenu(null); }}>
            <Trash2 size={15} />
            <span>删除</span>
          </button>
        </div>
      )}
    </main>
  );
}

const appRootElement = document.getElementById("root");
const appRoot = window.__JINGYIN_REACT_ROOT__ || createRoot(appRootElement);
window.__JINGYIN_REACT_ROOT__ = appRoot;

publicReleaseStorageResetPromise.finally(() => {
  appRoot.render(<App />);
});
