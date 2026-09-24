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
  ImageOff,
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
  PlugZap,
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
import { DEFAULT_MODELS, imageSourceFromResult } from "./shared/models.js";
import {
  canonicalModel,
  channelPriceLabel,
  channelsForModel,
  clampPromptForModel,
  convergeSettingsForModel,
  isRoutingCatalogReady,
  modelCapabilities,
  routingFields
} from "./shared/routing.js";
import {
  classifyQuickPrimaryLocalIntent,
  promptForQuickGeneration
} from "./shared/quickgen-prompt-rules.js";
import {
  composeLocalPasteBlob,
  constrainCropRect as sharedConstrainCropRect,
  cropRectToBlob,
  fitRectToRatioLocked,
  resizeRectFromCenterLocked,
  resizeRectFromCornerLocked,
  scaleRectLocked,
  snapSizeToRatio
} from "./shared/local-edit-geometry.js";
import DebouncedTextarea from "./shared/DebouncedTextarea.jsx";
import { ErrorBoundary } from "./shared/error-boundary.jsx";
import { brokenImageReason, isAllowedReferenceImage, resultImageCardState } from "./shared/result-image.js";
import { classifyGenerationError, describeEmptyResult, formatGenerationError } from "./shared/generation-errors.js";
import { fileSize, formatMs } from "./lib/format/index.js";
import { readJsonStorage, removeStorageItem, writeJsonStorage } from "./lib/storage/json-storage.js";
import OutfitWorkflow from "./outfit-workflow.jsx";
import ImageEditorPanel from "./image-editor.jsx";
import { getAppConfig } from "./api/config.js";
import { formatConnectionResult, testConnection } from "./api/connection.js";
import {
  getSaveDirectory,
  openSaveDirectoryRequest,
  pickSaveDirectory as pickSaveDirectoryRequest,
  setSaveDirectory as setSaveDirectoryRequest
} from "./api/save.js";
import {
  appendHistoryResults,
  clearHistoryResultsOnServer,
  deleteHistoryResults,
  getHistoryResults
} from "./api/history.js";
import { generateImages } from "./api/images.js";
import {
  createDetailPrompts,
  rewriteQuickPrompt,
  rewriteReferencePrompt
} from "./api/prompts.js";
import { generateVideo, getVideoStatus } from "./api/videos.js";
import { displayImageRequestUrl, fetchImageBlob, uploadCanvasAssets } from "./api/assets.js";
import { emitClientDiagnosticEvent } from "./api/client.js";
import { isAuthErrorMessage, normalizeApiKeyInput } from "./features/auth/api-key.js";
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
} from "./shared/local-edit-mask.js";
import "./styles.css";

const STORAGE_PREFIX = import.meta.env.VITE_JINGYIN_STORAGE_PREFIX || "jingyin-internal";
const STORAGE_KEY = `${STORAGE_PREFIX}-settings-v3`;
const LEGACY_STORAGE_KEYS = STORAGE_PREFIX === "jingyin-internal" ? ["jingyin-internal-settings-v2"] : [];
const PROMPT_LIBRARY_VERSION = "v2-20260802";
const PROMPT_PRESETS_KEY = `${STORAGE_PREFIX}-prompt-library-${PROMPT_LIBRARY_VERSION}`;
const PROMPT_CATEGORIES_KEY = `${STORAGE_PREFIX}-prompt-categories-${PROMPT_LIBRARY_VERSION}`;
const PROMPT_CATEGORY_DRAG_TYPE = "application/x-jingyin-prompt-category";
const QUICK_RESULT_DRAG_TYPE = "application/x-jingyin-quick-result";
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
const DEFAULT_MAX_REFERENCE_FILES = 5;
const MAX_DETAIL_FILES = 6;
const MAX_REFERENCE_REWRITE_FILES = 6;
// 局部回贴可选比例。2026-09-25：补上 2:3 —— 局部回贴选框必须能锁定到用户选的比例，
// 而 2:3 是竖版服装图最常用的比例之一，之前不在列表里会被回落到 1:1。
const QUICK_LOCAL_EDIT_RATIOS = ["1:1", "2:3", "3:4", "4:3", "16:9", "9:16"];
const DETAIL_ANALYSIS_MODEL = "gpt-5.4-mini";
const CHANNEL_UPLOAD_LIMIT_BYTES = 4 * 1024 * 1024;
const CHANNEL_UPLOAD_TARGET_BYTES = 3.75 * 1024 * 1024;
const CHANNEL_UPLOAD_MAX_SIDE = 3072;
const LOCAL_EDIT_CROP_UPLOAD_TARGET_BYTES = 16 * 1024 * 1024;
const LOCAL_EDIT_CROP_JPEG_QUALITIES = [0.98, 0.96, 0.94, 0.92];
const LOCAL_EDIT_OUTPUT_TARGET_BYTES = 64 * 1024 * 1024;
const LOCAL_EDIT_OUTPUT_JPEG_QUALITIES = [0.985, 0.975, 0.965, 0.95, 0.94];
const CANVAS_NODE_WIDTH = 236;
const CANVAS_NODE_HEIGHT = 260;
const CANVAS_GENERATOR_WIDTH = 286;
const CANVAS_GENERATOR_HEIGHT = 360;
const COUNT_OPTIONS = Array.from({ length: 12 }, (_, index) => index + 1);
const REFERENCE_STRENGTH_OPTIONS = Array.from({ length: 8 }, (_, index) => 30 + index * 10);
const SHOW_INFINITE_CANVAS = false;
const VIDEO_STATUS_POLL_INTERVAL_MS = 4000;
const VIDEO_STATUS_MAX_POLLS = 180;
const VIDEO_REFERENCE_MAX_BYTES = 10 * 1024 * 1024;
const DISPLAY_IMAGE_CACHE = new Map();

const defaultState = {
  baseUrl: "",
  apiKey: "",
  model: "tt-image-2",
  channelId: "",
  dispatchMode: "manual",
  skillRulesEnabled: true,
  imageSize: "2K",
  aspectRatio: "3:4",
  n: 1,
  prompt: "把袖子改长一点点，差不多到手腕的位置",
  theme: "dark"
};

const videoDefaults = {
  model: "seedance-2.0",
  prompt: "",
  duration: 5,
  resolution: "720p",
  aspectRatio: "9:16",
  outputAudio: false,
  imageUrl: ""
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
  model: "tt-image-2",
  channelId: "",
  dispatchMode: "manual",
  skillRulesEnabled: true,
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
  model: "tt-image-2",
  channelId: "",
  dispatchMode: "manual",
  skillRulesEnabled: true,
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
      "局部换装任务：图1是原图，已框选局部编辑区域；图2是本次要换上的服装唯一来源。",
      "请先在内部分析图2服装的面料类别和可见材质事实，例如棉麻、帆布、牛仔、雪纺、皮革、蕾丝、网纱、针织等，以及织纹方向、颗粒大小、厚薄、垂感、光泽、高光位置、透明度、褶皱逻辑、缝线方向和边缘结构；不要输出分析文字，只把分析结果用于生成。",
      "把图2服装真实穿到图1人物局部区域内，严格保持图2的服装类别、版型、廓形、宽松/修身程度、腰身松量、肩线、领口形状、袖型、袖长、袖口、衣长、裙长、下摆宽度、开衩、扣子、拉链、口袋、拼接线、颜色、面料纹理、厚薄、垂感、反光和光泽。",
      "只允许做符合图1姿态和身体角度的真实穿着适配与自然褶皱，不能按模型审美自动美化版型；禁止把图2服装改成更收腰、更细腰、更短、更紧身、更修身、更顺滑、更亮、更薄、更厚或更完美状态。",
      "图1人物的脸、发型、头部位置、身体比例、姿势、手臂手腕手指、腿脚、背景光影和选区边缘必须保持稳定；不要输出整张重构图、对比图、文字、水印或边框。"
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
  const merged = { ...defaultState, ...safeStored, baseUrl: defaultState.baseUrl };
  merged.model = canonicalModel(merged.model);
  merged.dispatchMode = "manual";
  merged.skillRulesEnabled = merged.skillRulesEnabled !== false;
  return merged;
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
    const payload = await getHistoryResults();
    if (Array.isArray(payload.results)) {
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
    await appendHistoryResults(items);
    return;
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
    await deleteHistoryResults(ids);
    return;
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
    await clearHistoryResultsOnServer();
    return;
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

function videoResultUrl(task = {}) {
  return String(task.url || task.videoUrl || task.outputUrl || task.output_url || "").trim();
}

function isVideoTaskCompleted(task = {}) {
  const status = String(task.status || "").toLowerCase();
  return Boolean(videoResultUrl(task)) || /complete|completed|success|succeeded|finished|done/.test(status);
}

function isVideoTaskFailed(task = {}) {
  const status = String(task.status || "").toLowerCase();
  return /fail|failed|error|cancel|cancelled|canceled/.test(status) || Boolean(task.error);
}

function videoTaskStatusText(task = {}) {
  if (isVideoTaskCompleted(task)) return "已完成";
  if (isVideoTaskFailed(task)) return "失败";
  const progress = Number(task.progress);
  if (Number.isFinite(progress) && progress > 0) return `生成中 ${Math.round(progress)}%`;
  const status = String(task.status || "").trim();
  if (/queue|queued|pending/i.test(status)) return "排队中";
  if (/progress|running|processing/i.test(status)) return "生成中";
  return status || "生成中";
}

function durationOptionsForVideoModel(model = {}) {
  if (Array.isArray(model.durations) && model.durations.length > 0) return model.durations;
  const min = Math.max(1, Number(model.minDuration || videoDefaults.duration));
  const max = Math.max(min, Number(model.maxDuration || min));
  const options = [];
  for (let value = min; value <= max; value += 5) options.push(value);
  if (!options.includes(max)) options.push(max);
  return options;
}

function videoPromptPlaceholder(model = {}) {
  return String(model.promptPlaceholder || "输入视频画面、运动、镜头、服装和氛围要求").trim();
}

function videoPricePerSecond(model = {}, resolution = "") {
  const price = Number(model.customerPricePerSecond?.[resolution]);
  return Number.isFinite(price) ? price : null;
}

function videoPriceLabel(model = {}, resolution = "") {
  const price = videoPricePerSecond(model, resolution);
  return price === null ? "" : `算力 ${price.toFixed(3)}/秒`;
}

function normalizeVideoSettingValue(current = {}, videoModel = {}) {
  const durations = durationOptionsForVideoModel(videoModel);
  const resolutions = Array.isArray(videoModel.resolutions) && videoModel.resolutions.length ? videoModel.resolutions : ["720p"];
  const ratios = Array.isArray(videoModel.aspectRatios) && videoModel.aspectRatios.length ? videoModel.aspectRatios : ["9:16"];
  const defaultDuration = Number(videoModel.defaultDuration || durations[0] || videoDefaults.duration);
  const requestedDuration = Number.parseInt(current.duration ?? defaultDuration, 10);
  const duration = durations.includes(requestedDuration) ? requestedDuration : defaultDuration;
  const resolution = resolutions.includes(current.resolution) ? current.resolution : (videoModel.defaultResolution || resolutions[0]);
  const aspectRatio = ratios.includes(current.aspectRatio) ? current.aspectRatio : (videoModel.defaultAspectRatio || ratios[0]);
  return {
    ...current,
    model: videoModel.value || current.model || videoDefaults.model,
    duration,
    resolution,
    aspectRatio
  };
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

function referenceMetaFromQuickRunItems(items, localEditItem = null, role = "reference", startIndex = 0) {
  return (items || []).map((item, index) => {
    const file = quickReferenceRunUploadFile(item, localEditItem);
    const originalFile = quickReferenceOriginalFile(item);
    const isActiveLocalEdit = Boolean(localEditItem?.id && item?.id === localEditItem.id);
    return {
      name: file?.name || originalFile?.name || `reference-${startIndex + index + 1}`,
      role,
      index: startIndex + index,
      size: file?.size || 0,
      type: file?.type || "",
      lastModified: file?.lastModified || originalFile?.lastModified || 0,
      cropEdit: Boolean(!isActiveLocalEdit && item?.cropEdit?.cropFile),
      localEdit: isActiveLocalEdit
    };
  });
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

function preloadDisplayImageUrl(url, timeoutMs = 20000) {
  if (!url || typeof Image !== "function") return Promise.resolve();
  return new Promise((resolve) => {
    const image = new Image();
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      if (timer) window.clearTimeout(timer);
      resolve();
    };
    const timer = typeof window !== "undefined" ? window.setTimeout(done, timeoutMs) : null;
    image.onload = done;
    image.onerror = done;
    image.decoding = "async";
    image.src = url;
    if (typeof image.decode === "function") {
      image.decode().then(done, done);
    }
  });
}

function diagnosticImageSourceType(src) {
  const text = String(src || "");
  if (text.startsWith("data:")) return "base64/data";
  if (text.startsWith("blob:")) return "browser-blob";
  if (text.startsWith("/api/result/") || text.startsWith("/api/history-image/")) return "local-cache";
  if (text.startsWith("/api/image-proxy")) return "local-proxy";
  if (/^https?:\/\//i.test(text)) return "remote-url";
  return text ? "local-url" : "empty";
}

function CachedImage({ src, alt = "", className = "", style, draggable = false, role, tabIndex, onDragStart, onClick, onKeyDown, onError, loading, diagnostic }) {
  const [displaySrc, setDisplaySrc] = useState(() => {
    if (!src || src.startsWith("data:") || src.startsWith("blob:")) return src || "";
    const cached = DISPLAY_IMAGE_CACHE.get(src);
    return cached?.url || "";
  });
  const displayLogKeyRef = useRef("");

  useEffect(() => {
    let cancelled = false;
    const startedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
    const emitDisplayReady = (shownSrc) => {
      const requestId = String(diagnostic?.requestId || diagnostic?.taskId || "").trim();
      if (!requestId) return;
      const key = `${requestId}|${diagnostic?.placement || ""}|${shownSrc || src || ""}`;
      if (displayLogKeyRef.current === key) return;
      displayLogKeyRef.current = key;
      emitClientDiagnosticEvent({
        requestId,
        stage: "client-result-display-ready",
        endpoint: diagnostic?.endpoint || "",
        method: "DISPLAY",
        ok: true,
        durationMs: Math.round((typeof performance !== "undefined" ? performance.now() : Date.now()) - startedAt),
        detail: {
          taskId: requestId,
          placement: diagnostic?.placement || "",
          module: diagnostic?.module || "",
          sourceType: diagnosticImageSourceType(shownSrc || src),
          displayMs: Math.round((typeof performance !== "undefined" ? performance.now() : Date.now()) - startedAt)
        }
      });
    };
    if (!src) {
      setDisplaySrc("");
      return undefined;
    }
    if (src.startsWith("data:") || src.startsWith("blob:")) {
      setDisplaySrc(src);
      emitDisplayReady(src);
      return undefined;
    }
    const requestSrc = displayImageRequestUrl(src);
    const cached = DISPLAY_IMAGE_CACHE.get(src);
    if (cached?.url) {
      setDisplaySrc(cached.url);
      emitDisplayReady(cached.url);
      return undefined;
    }
    const promise = cached?.promise || preloadDisplayImageUrl(requestSrc)
      .then(() => {
        DISPLAY_IMAGE_CACHE.set(src, { url: requestSrc });
        return requestSrc;
      });
    if (!cached?.promise) DISPLAY_IMAGE_CACHE.set(src, { promise });
    setDisplaySrc("");
    promise
      .then((url) => {
        if (!cancelled) {
          setDisplaySrc(url);
          emitDisplayReady(url);
        }
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
      src={displaySrc || undefined}
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

function ReferenceThumbTray({ references, count = 0, className = "", max = 5, onOpen, onContextMenu, onImageDragStart }) {
  const allItems = Array.isArray(references) ? references.filter(Boolean) : [];
  // P1：统一图片地址校验 + 归档缺失标记。
  // 归档已丢失（服务端标记 missing），或地址不在白名单（旧中转站/预签名链接等），
  // 都不再渲染、不再请求，避免每次打开页面 404/502。用数量提示告诉用户当时用了几张参考图。
  const items = allItems.filter((reference) => (
    !reference?.missing && isAllowedReferenceImage(reference, referenceSource)
  ));
  const missingCount = allItems.length - items.length;
  const visibleItems = items.slice(0, max);
  if (visibleItems.length === 0 && (count > 0 || missingCount > 0)) {
    const total = count || allItems.length;
    return (
      <div
        className={`referenceThumbTray ${className}`}
        title={missingCount > 0
          ? `${missingCount} 张参考图缩略图不可用（归档文件不存在或地址不在允许来源），不再重复请求`
          : "旧记录只保存了参考图数量，没有保存缩略图"}
      >
        <span className="referenceCountPill">{total} 张参考</span>
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
                draggable={Boolean(onImageDragStart)}
                role={onOpen ? "button" : undefined}
                tabIndex={onOpen ? 0 : undefined}
                onDragStart={onImageDragStart ? (event) => onImageDragStart(event, reference, index, items) : undefined}
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

async function canvasToHighQualityJpegBlob(canvas, options = {}) {
  const qualities = Array.isArray(options.qualities) && options.qualities.length
    ? options.qualities
    : LOCAL_EDIT_OUTPUT_JPEG_QUALITIES;
  const targetBytes = Math.max(1, Number(options.targetBytes || LOCAL_EDIT_OUTPUT_TARGET_BYTES));
  let best = null;
  for (const quality of qualities) {
    const blob = await canvasToBlob(canvas, "image/jpeg", quality);
    best = { blob, quality };
    if (blob.size <= targetBytes) return best;
  }
  return best;
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

// 2026-09-25 对齐 3.0：删除了"把上传图补白到模型比例"的逻辑。
// 3.0 的裁剪输出就是选框本身，没有任何 letterbox；用户看到的白边正是这里产生的
// （横图按 3:4 上传时上下各补一条白边）。
// 现在上传用的就是裁剪/选框原图，比例交给服务的模型能力校验去处理。
async function ensureQuickUploadCanvasRatio(file) {
  return file;
}

/**
 * 把参考图压成"送 JSON 通道用"的紧凑 data URL。
 *
 * 3.0 对带参考图的请求改走 /v1/images/generations + JSON `image_urls`
 * （main.py:13428-13454），参考图用 `encode_reference_data_url(ref, max_size=1536)`
 * 压到 1536 长边再转 data URL。这里对齐同样的上限与质量：
 *   - 长边不超过 1536
 *   - JPEG q0.85（单张约 200~500KB，base64 后仍在服务端 8MB fieldSize 内）
 * 只在香蕉 Pro（nano-banana-pro）路径上使用，其它模型不受影响。
 */
async function fileToCompactJpegDataUrl(file, maxEdge = 1536, quality = 0.85) {
  if (!(file instanceof Blob)) return "";
  const bitmap = await imageBitmapFromFile(file);
  try {
    const width = bitmap.width || bitmap.naturalWidth || 0;
    const height = bitmap.height || bitmap.naturalHeight || 0;
    if (!width || !height) return "";
    const scale = Math.min(1, maxEdge / Math.max(width, height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    try {
      const ctx = canvas.getContext("2d", { alpha: false });
      if (!ctx) return "";
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL("image/jpeg", quality);
    } finally {
      canvas.width = 0;
      canvas.height = 0;
    }
  } finally {
    bitmap.close?.();
  }
}

// 需要走 JSON + image_urls 参考图通道的模型（对齐 3.0 的带图路径）。
const JSON_IMAGE_URLS_MODELS = new Set(["nano-banana-pro"]);

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

// 选框几何统一走 src/shared/local-edit-geometry.js（批量侧 outfit-workflow.jsx 用同一份），
// 这里保留同名局部引用，调用点不用改。
const constrainCropRect = sharedConstrainCropRect;

// 2026-09-25 对齐 3.0 新源码：删除了 expandLocalEditContextRect。
// 3.0 的局部回贴把用户选框以外的区域当作"不可改动"，上传给模型的局部图
// 就是选框本身（frontend/ecommerce/src/features/crop/cropImage.ts 里
// canvas 尺寸严格等于 sourceRect），不存在"多送一圈上下文"的概念。
// 这里保留一个同语义的显式说明，方便以后回溯为什么没有这个函数。

// canonical ID 是 banana-2；旧存档 nano-banana2 通过 canonicalModel 映射到同一支，
// 保证迁移后这两条「香蕉 2 专属」判断不会失配。
function isBanana2Model(model) {
  return canonicalModel(model, "") === "banana-2";
}

/**
 * 裁剪选框区域，产出送模型（或作为普通裁剪结果）的局部图。
 *
 * 2026-09-25 对齐 3.0 新源码：
 *   - 3.0 `frontend/ecommerce/src/features/crop/cropImage.ts:150`
 *     把画布尺寸**严格**定为 `sourceRect.width × sourceRect.height`；
 *     没有任何补白、补边、按比例外扩。
 *   - 所以这里也只用 `pasteRect`（= 用户选框，夹进原图范围内）建画布，
 *     输出 Blob 的像素尺寸恒等于选框尺寸。
 *   - 不再有 `contextRect`（"多送一圈上下文"），返回值的 `contextRect` 恒为 null，
 *     老调用点读到的字段仍然存在，只是永远为空。
 */
async function cropQuickLocalEditFile(referenceItem, cropRect, suffix = "local_edit", _options = {}) {
  const originalFile = quickReferenceOriginalFile(referenceItem);
  const image = await imageBitmapFromFile(originalFile);
  try {
    // 实际裁剪在 src/shared/local-edit-geometry.js（与批量侧同一份实现）。
    const cropped = await cropRectToBlob(image, cropRect, {
      targetBytes: LOCAL_EDIT_CROP_UPLOAD_TARGET_BYTES,
      qualities: LOCAL_EDIT_CROP_JPEG_QUALITIES
    });
    return {
      file: new File([cropped.blob], `${fileBaseName(originalFile.name)}_${suffix}.jpg`, {
        type: "image/jpeg",
        lastModified: Date.now()
      }),
      cropRect: cropped.rect,
      contextRect: null,
      sourceWidth: cropped.sourceWidth,
      sourceHeight: cropped.sourceHeight,
      cropQuality: cropped.quality,
      cropBytes: cropped.blob.size
    };
  } finally {
    image.close?.();
  }
}

/**
 * 把模型返回的局部结果**按原图坐标**贴回底图。
 *
 * 2026-09-25 对齐 3.0 新源码（frontend/ecommerce/src/shared/image/localPaste.ts:128-202
 * `composeLocalResult`）。3.0 的契约是：
 *   1. 画布 = 底图**完整尺寸**，先把底图画满；
 *   2. 全程**唯一一次**写入是
 *      `context.drawImage(local, rect.x, rect.y, rect.width, rect.height)`
 *      （返回图尺寸与选区不一致时按选区尺寸拉伸贴入，不做 cover 裁切）；
 *   3. **不做**羽化、自动对齐、颜色匹配、中性色调匹配、锐化、护脸/护身保护；
 *   4. 选框外的像素逐字节等于底图。
 *
 * 那一段的原文注释就是："刻意不做运行版的羽化/自动对齐/颜色匹配/护脸等后处理
 * （任务要求不得擅自增加美化、锐化或调色）——贴回就是贴回。"
 *
 * 所以这里删掉了 V11 原有的：
 *   - autoAlign（alignLocalEditPatchCanvas，会对结果做 ±maxShift 位移）
 *   - colorMatch（colorMatchLocalEditPatchCanvas，会改结果颜色）
 *   - protectSkinAndFace（protectSkinAndFaceFromLocalOutfitPatch，
 *     会用 destination-out 把"头顶 12%~34% 的肤色区域"挖掉，让原图盖回来）
 *   - feather（createFeatherMask，会让选框最外圈回退成原图）
 *
 * 涂抹蒙版（LOCAL_EDIT_MASK_MODE）保留：那是**用户自己画出来的选区**，
 * 不是自动保护。它按硬边（不羽化）裁剪，只有用户涂到的地方会被替换。
 *
 * `_options` 保留在签名里，老调用点不用改；其中的保护类参数一律不再生效。
 */
async function composeQuickLocalEditBlob(originalFile, generatedBlob, cropRect, localEdit = null, _options = {}) {
  const original = await imageBitmapFromFile(originalFile);
  const generated = await imageBitmapFromBlob(generatedBlob);
  let maskImage = null;
  let blendMask = null;
  try {
    const isMaskEdit = localEdit?.editMode === LOCAL_EDIT_MASK_MODE && localEdit?.maskDataUrl;
    if (isMaskEdit) {
      // 用户涂抹的选区：按硬边（不羽化）裁剪，只替换涂到的像素。
      const rect = constrainCropRect(
        localEdit?.cropRect || cropRect,
        original.width || original.naturalWidth,
        original.height || original.naturalHeight
      );
      maskImage = await imageBitmapFromDataUrl(localEdit.maskDataUrl);
      blendMask = createLocalEditAlphaMask(maskImage, rect, 0);
    }
    // 实际贴回在 src/shared/local-edit-geometry.js（与批量侧同一份实现）。
    const composed = await composeLocalPasteBlob(original, generated, localEdit?.cropRect || cropRect, {
      maskImage: blendMask,
      targetBytes: LOCAL_EDIT_OUTPUT_TARGET_BYTES,
      qualities: LOCAL_EDIT_OUTPUT_JPEG_QUALITIES
    });
    return composed.blob;
  } finally {
    original.close?.();
    generated.close?.();
    maskImage?.close?.();
  }
}

function shouldNormalizeQuickUploadForModel(model) {
  return isBanana2Model(model);
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
  const preserveFirstFile = Boolean(options.preserveFirstFile);
  const preserveFirstFileMaxBytes = Math.max(CHANNEL_UPLOAD_LIMIT_BYTES, Number(options.preserveFirstFileMaxBytes || CHANNEL_UPLOAD_LIMIT_BYTES));
  for (const [index, file] of (files || []).entries()) {
    originalBytes += file.size || 0;
    if (preserveFirstFile && index === 0 && (file.size || 0) <= preserveFirstFileMaxBytes) {
      uploadBytes += file.size || 0;
      prepared.push(file);
      continue;
    }
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

/**
 * 生图错误的用户可读文案（快捷生成统一出口）。
 *
 * 2026-09-25：不再在这里散写正则，改走 src/shared/generation-errors.js 的分类器，
 * 这样快捷生成和批量生成对同一类错误给出同一句话，并且都会带上服务端返回的 requestId。
 *
 * @param {unknown} error ApiError（带 status/payload）或任意错误 / 错误文本
 * @param {object} [context] `{ phase: "upload"|"request"|"result", cancelled, requestId }`
 */
function normalizeGenerationErrorMessage(error, context = {}) {
  const value = error instanceof Error || (error && typeof error === "object")
    ? error
    : new Error(String(error || ""));
  const info = classifyGenerationError(value, context);
  // 连原始错误文本都没有时，也明确说是"未知错误"，而不是丢一句"生成失败"。
  if (!info.reason && info.kind === "unknown") {
    return `${info.label}：没有拿到具体原因，请重试。${info.advice}`;
  }
  return formatGenerationError(value, context);
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
  // 2026-09-25：默认选框不再用外部比例去"裁"出一个形状，而是按图片自身比例
  // 取居中的 62% 区域。比例按钮仍然存在，点一下才会把选框整形到那个比例。
  // 这样"打开弹窗就变成正方形选框"不会再发生（除非原图本身就是正方形）。
  const imageRatio = height > 0 ? width / height : ratioValue(ratio);
  let cropWidth = width * 0.62;
  let cropHeight = cropWidth / imageRatio;
  if (cropHeight > height * 0.62) {
    cropHeight = height * 0.62;
    cropWidth = cropHeight * imageRatio;
  }
  return constrainCropRect({
    x: (width - cropWidth) / 2,
    y: (height - cropHeight) / 2,
    width: cropWidth,
    height: cropHeight
  }, width, height);
}

async function cropQuickReferenceViewportFile(referenceItem, crop, ratio) {
  const file = quickReferenceOriginalFile(referenceItem);
  if (!(file instanceof File)) throw new Error("无法读取裁剪图片");
  const bitmap = await imageBitmapFromFile(file);
  try {
    const sourceWidth = bitmap.width || bitmap.naturalWidth || 1;
    const sourceHeight = bitmap.height || bitmap.naturalHeight || 1;
    const stageWidth = Math.max(1, Number(crop?.stageWidth) || 1);
    const stageHeight = Math.max(1, Number(crop?.stageHeight) || 1);
    const baseScale = Math.min(stageWidth / sourceWidth, stageHeight / sourceHeight);
    const drawScale = baseScale * Math.max(0.05, Number(crop?.scale) || 1);
    const drawWidth = sourceWidth * drawScale;
    const drawHeight = sourceHeight * drawScale;
    const left = stageWidth / 2 - drawWidth / 2 + (Number(crop?.x) || 0);
    const top = stageHeight / 2 - drawHeight / 2 + (Number(crop?.y) || 0);
    const viewLeft = (0 - left) / drawScale;
    const viewTop = (0 - top) / drawScale;
    const viewRight = (stageWidth - left) / drawScale;
    const viewBottom = (stageHeight - top) / drawScale;

    let sourceX = Math.max(0, Math.min(sourceWidth, viewLeft));
    let sourceY = Math.max(0, Math.min(sourceHeight, viewTop));
    let sourceRight = Math.max(0, Math.min(sourceWidth, viewRight));
    let sourceBottom = Math.max(0, Math.min(sourceHeight, viewBottom));

    if (sourceRight - sourceX < 2 || sourceBottom - sourceY < 2) {
      // 2026-09-25：这里原来会按 ratio 重新凑一个等比源矩形（并在横图/竖图上取中间一块）。
      // 那是"因为比例设置自动扩展选区"的来源之一：用户看到的可见范围会被换掉。
      // 现在只把可见范围夹进图片范围内，不做任何比例重算。
      sourceX = Math.max(0, Math.min(sourceWidth - 1, viewLeft));
      sourceY = Math.max(0, Math.min(sourceHeight - 1, viewTop));
      sourceRight = Math.max(sourceX + 1, Math.min(sourceWidth, viewRight));
      sourceBottom = Math.max(sourceY + 1, Math.min(sourceHeight, viewBottom));
    }

    const cropWidth = Math.max(1, sourceRight - sourceX);
    const cropHeight = Math.max(1, sourceBottom - sourceY);
    const scaleDown = Math.min(1, CHANNEL_UPLOAD_MAX_SIDE / Math.max(cropWidth, cropHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(cropWidth * scaleDown));
    canvas.height = Math.max(1, Math.round(cropHeight * scaleDown));
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("无法创建裁剪画布");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bitmap, sourceX, sourceY, cropWidth, cropHeight, 0, 0, canvas.width, canvas.height);
    const blob = await canvasToBlob(canvas, "image/jpeg", 0.92);
    const croppedFile = new File([blob], `${fileBaseName(file.name)}_crop.jpg`, {
      type: "image/jpeg",
      lastModified: Date.now()
    });
    return {
      file: croppedFile,
      cropRect: {
        x: Math.round(sourceX),
        y: Math.round(sourceY),
        width: Math.round(cropWidth),
        height: Math.round(cropHeight)
      },
      sourceWidth,
      sourceHeight,
      aspectRatio: ratio
    };
  } finally {
    bitmap.close?.();
  }
}

function QuickCropViewportModal({ item, ratio, onClose, onApply, onClear }) {
  const stageRef = useRef(null);
  const dragRef = useRef(null);
  const [imageUrl, setImageUrl] = useState("");
  const [imageSize, setImageSize] = useState({ width: 0, height: 0 });
  const [transform, setTransform] = useState({ x: 0, y: 0, scale: 1 });
  const [working, setWorking] = useState(false);
  const originalFile = quickReferenceOriginalFile(item);
  const activeRatio = ratio || "3:4";
  const activeRatioValue = ratioValue(activeRatio);
  const savedCrop = item?.cropEdit;

  useEffect(() => {
    if (!originalFile) return undefined;
    const nextUrl = URL.createObjectURL(originalFile);
    setImageUrl(nextUrl);
    return () => URL.revokeObjectURL(nextUrl);
  }, [originalFile]);

  function minCropScale() {
    const frame = stageRef.current?.getBoundingClientRect();
    if (!frame?.width || !frame?.height || !imageSize.width || !imageSize.height) return 1;
    const containScale = Math.min(frame.width / imageSize.width, frame.height / imageSize.height);
    const coverScale = Math.max(frame.width / imageSize.width, frame.height / imageSize.height);
    return Math.max(1, coverScale / containScale);
  }

  function clampTransform(next) {
    const frame = stageRef.current?.getBoundingClientRect();
    if (!frame?.width || !frame?.height || !imageSize.width || !imageSize.height) return next;
    const containScale = Math.min(frame.width / imageSize.width, frame.height / imageSize.height);
    const minScale = minCropScale();
    const scale = Math.max(minScale, Math.min(4, Number(next.scale) || minScale));
    const drawWidth = imageSize.width * containScale * scale;
    const drawHeight = imageSize.height * containScale * scale;
    const maxX = Math.max(0, (drawWidth - frame.width) / 2);
    const maxY = Math.max(0, (drawHeight - frame.height) / 2);
    return {
      x: Math.max(-maxX, Math.min(maxX, Number(next.x) || 0)),
      y: Math.max(-maxY, Math.min(maxY, Number(next.y) || 0)),
      scale
    };
  }

  function resetTransform() {
    setTransform({ x: 0, y: 0, scale: minCropScale() });
  }

  useEffect(() => {
    if (!imageSize.width || !imageSize.height) return undefined;
    const frame = window.requestAnimationFrame(resetTransform);
    return () => window.cancelAnimationFrame(frame);
  }, [imageSize.height, imageSize.width, item?.id, activeRatio]);

  function beginDrag(event) {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    dragRef.current = {
      x: event.clientX,
      y: event.clientY,
      start: transform
    };
  }

  function moveDrag(event) {
    const drag = dragRef.current;
    if (!drag) return;
    event.preventDefault();
    setTransform(clampTransform({
      ...drag.start,
      x: drag.start.x + event.clientX - drag.x,
      y: drag.start.y + event.clientY - drag.y
    }));
  }

  function endDrag(event) {
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    dragRef.current = null;
  }

  function zoomByWheel(event) {
    event.preventDefault();
    event.stopPropagation();
    const step = event.deltaY > 0 ? -0.08 : 0.08;
    setTransform((current) => clampTransform({
      ...current,
      scale: current.scale + step
    }));
  }

  async function applyCrop() {
    if (working) return;
    const frame = stageRef.current?.getBoundingClientRect();
    if (!frame?.width || !frame?.height) return;
    setWorking(true);
    try {
      const cropped = await cropQuickReferenceViewportFile(item, {
        ...transform,
        stageWidth: frame.width,
        stageHeight: frame.height
      }, activeRatio);
      onApply(item.id, cropped);
    } finally {
      setWorking(false);
    }
  }

  return (
    <div className="modalLayer previewLayer" onMouseDown={onClose}>
      <section className="quickLocalEditModal quickCropViewportModal" onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <div>
            <h2>普通裁剪</h2>
            <span>{originalFile?.name || "上传图片"} · 裁剪后的参考图参与生成 · {activeRatio}</span>
          </div>
          <button className="iconButton" type="button" onClick={onClose} aria-label="关闭">
            <X size={18} />
          </button>
        </header>
        <div className="quickCropViewportWrap">
          <div
            className="quickCropViewportStage"
            ref={stageRef}
            style={{ aspectRatio: `${activeRatioValue}` }}
            onPointerDown={beginDrag}
            onPointerMove={moveDrag}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onWheel={zoomByWheel}
          >
            {imageUrl && (
              <img
                src={imageUrl}
                alt=""
                draggable={false}
                onLoad={(event) => {
                  setImageSize({
                    width: event.currentTarget.naturalWidth || 0,
                    height: event.currentTarget.naturalHeight || 0
                  });
                }}
                style={{
                  transform: `translate(calc(-50% + ${transform.x}px), calc(-50% + ${transform.y}px)) scale(${transform.scale})`
                }}
              />
            )}
          </div>
        </div>
        <footer>
          <span>拖动画面调整位置，滚轮缩放图片，确认后只保存裁剪后的参考图。</span>
          <div>
            {savedCrop && (
              <button className="smallButton" type="button" onClick={() => onClear(item.id)}>
                <RotateCcw size={15} />
                <span>取消裁剪</span>
              </button>
            )}
            <button className="smallButton" type="button" onClick={onClose}>取消</button>
            <button className="generateButton quickLocalApplyButton" type="button" onClick={applyCrop} disabled={working}>
              {working ? <Loader2 size={16} className="spin" /> : <Crop size={16} />}
              <span>应用裁剪</span>
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
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
  // 只有「局部回贴 + 框选区域」锁比例：
  //   - 涂抹蒙版模式的框是 AI 上下文包围盒，由涂抹轨迹决定，不能按比例改写；
  //   - 普通裁剪按现有自由矩形语义，不锁比例。
  const ratioLocked = isLocalMode && !isMaskMode;
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
      // 卸载/切图后 onload 仍可能触发，对已卸载组件 setState 会报警告并留下悬挂引用。
      // 这里用 cancelled 标记把迟到的回调直接丢掉（见资源生命周期要求）。
      let cancelled = false;
      const maskImage = new Image();
      maskImage.onload = () => {
        if (cancelled) return;
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
      return () => {
        cancelled = true;
        maskImage.onload = null;
      };
    }
    setMaskPainted(false);
    setMaskRevision((current) => current + 1);
    return undefined;
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
      // 局部回贴：旧会话存下来的选框也按当前比例重新整形（中心不动），
      // 避免"头部显示 2:3、选框却是别的比例"。普通裁剪保持原样。
      ? (ratioLocked
        ? fitRectToRatioLocked(savedEdit.cropRect, activeRatio, width, height)
        : constrainCropRect(savedEdit.cropRect, width, height))
      : (ratioLocked
        // 局部回贴打开时，默认选框就是用户当前选定的比例（此前是"按图片自身比例"，
        // 会出现选了 2:3 却给出一个图片比例选框的情况）。
        ? fitRectToRatioLocked(null, activeRatio, width, height)
        // 普通裁剪保持原语义：按图片自身比例取居中的 62% 区域。
        : defaultQuickLocalEditCrop(width, height, activeRatio));
    setCropRect(initial);
    window.requestAnimationFrame(measureImage);
  }

  function fitRectToRatio(rect, nextRatio) {
    if (!imageSize.width || !imageSize.height) return rect;
    // 局部回贴（框选模式）：锁定比例，围绕原选框中心整形，并留在原图范围内。
    if (ratioLocked) {
      return fitRectToRatioLocked(rect, nextRatio, imageSize.width, imageSize.height);
    }
    // 普通裁剪：保持原有的自由矩形语义（只做边界夹取，不锁比例）。
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
      // 局部回贴：任何写入路径都再吸附一次比例，保证选框"始终"是所选比例
      // （例如旧会话里存下来的选框比例和当前选择不一致时）。
      if (ratioLocked) {
        const size = snapSizeToRatio(source.width, source.height, activeRatio, imageSize.width, imageSize.height);
        return constrainCropRect({ ...source, ...size }, imageSize.width, imageSize.height);
      }
      return constrainCropRect(source, imageSize.width, imageSize.height);
    });
  }

  function beginCropDrag(event, mode) {
    if (!cropRect || !displaySize.width || !imageSize.width) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const centerResize = event.altKey && event.button === 0;
    dragRef.current = {
      mode: centerResize && mode === "move" ? "resize-se" : mode,
      centerResize,
      startX: event.clientX,
      startY: event.clientY,
      rect: cropRect
    };
  }

  // 2026-09-25 对齐要求（本轮）：「局部回贴选框必须跟随用户选定的比例」。
  //   - 局部回贴 + 框选区域：角柄缩放 / Alt 中心缩放 / 区域大小滑杆全部锁定 activeRatio，
  //     宽高始终精确满足比例（整数像素），且不越出原图。
  //   - 普通裁剪：保持上一轮确定的自由矩形语义（拖多大就是多大）。
  const CROP_MIN_PIXEL_SIZE = 1;

  function resizeCropRectFromCorner(sourceRect, handle, deltaX, deltaY) {
    if (ratioLocked) {
      return resizeRectFromCornerLocked(
        sourceRect, handle, deltaX, deltaY, activeRatio, imageSize.width, imageSize.height
      );
    }
    const directionX = handle.includes("e") ? 1 : -1;
    const directionY = handle.includes("s") ? 1 : -1;
    const anchorX = directionX > 0 ? sourceRect.x : sourceRect.x + sourceRect.width;
    const anchorY = directionY > 0 ? sourceRect.y : sourceRect.y + sourceRect.height;
    const maxWidth = Math.max(1, directionX > 0 ? imageSize.width - anchorX : anchorX);
    const maxHeight = Math.max(1, directionY > 0 ? imageSize.height - anchorY : anchorY);
    const nextWidth = Math.max(CROP_MIN_PIXEL_SIZE, Math.min(maxWidth, sourceRect.width + deltaX * directionX));
    const nextHeight = Math.max(CROP_MIN_PIXEL_SIZE, Math.min(maxHeight, sourceRect.height + deltaY * directionY));
    return {
      x: directionX > 0 ? anchorX : anchorX - nextWidth,
      y: directionY > 0 ? anchorY : anchorY - nextHeight,
      width: nextWidth,
      height: nextHeight
    };
  }

  function resizeCropRectFromCenter(sourceRect, handle, deltaX, deltaY) {
    if (ratioLocked) {
      return resizeRectFromCenterLocked(
        sourceRect, handle, deltaX, deltaY, activeRatio, imageSize.width, imageSize.height
      );
    }
    const directionX = handle.includes("e") ? 1 : -1;
    const directionY = handle.includes("s") ? 1 : -1;
    const centerX = sourceRect.x + sourceRect.width / 2;
    const centerY = sourceRect.y + sourceRect.height / 2;
    const maxWidth = Math.max(1, Math.min(centerX, imageSize.width - centerX) * 2);
    const maxHeight = Math.max(1, Math.min(centerY, imageSize.height - centerY) * 2);
    const nextWidth = Math.max(CROP_MIN_PIXEL_SIZE, Math.min(maxWidth, sourceRect.width + deltaX * directionX * 2));
    const nextHeight = Math.max(CROP_MIN_PIXEL_SIZE, Math.min(maxHeight, sourceRect.height + deltaY * directionY * 2));
    return {
      x: centerX - nextWidth / 2,
      y: centerY - nextHeight / 2,
      width: nextWidth,
      height: nextHeight
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

    const handle = drag.mode.startsWith("resize-") ? drag.mode.slice("resize-".length) : "se";
    updateCropRect(drag.centerResize
      ? resizeCropRectFromCenter(drag.rect, handle, deltaX, deltaY)
      : resizeCropRectFromCorner(drag.rect, handle, deltaX, deltaY));
  }

  function endCropDrag(event) {
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    dragRef.current = null;
  }

  function changeCropScale(event) {
    if (!cropRect || !imageSize.width || !imageSize.height) return;
    const percent = Number(event.target.value) / 100;
    // 局部回贴：按目标宽度等比缩放，宽高比例不变（原来分别按图宽/图高取百分比会把选框压变形）。
    if (ratioLocked) {
      updateCropRect(scaleRectLocked(cropRect, imageSize.width * percent, activeRatio, imageSize.width, imageSize.height));
      return;
    }
    // 普通裁剪：保持自由矩形语义，对当前选框按图片宽高的百分比自由缩放。
    const nextWidth = Math.max(CROP_MIN_PIXEL_SIZE, imageSize.width * percent);
    const nextHeight = Math.max(CROP_MIN_PIXEL_SIZE, imageSize.height * percent);
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
        // 普通裁剪与局部回贴走**同一套**几何：输出尺寸恒等于选框在原图上的像素尺寸。
        const cropped = await cropQuickLocalEditFile(item, cropRect, isLocalMode ? "local_edit" : "crop");
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
                {["nw", "ne", "sw", "se"].map((handle) => (
                  <i
                    className={`quickLocalCropHandle quickLocalCropHandle-${handle}`}
                    key={handle}
                    onPointerDown={(event) => beginCropDrag(event, `resize-${handle}`)}
                    onPointerMove={moveCropDrag}
                    onPointerUp={endCropDrag}
                    onPointerCancel={endCropDrag}
                  />
                ))}
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
          <span>{isMaskMode ? "涂抹需要 AI 修改的区域，生成后只把涂抹到的像素贴回原图。" : isLocalMode ? "拖动选区调整位置，生成后会按原图坐标原样贴回选框区域，选框外不动。" : "拖动选区调整位置，裁剪后的参考图会参与生成，但结果不贴回原图。"}</span>
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
  // P1 缺图自愈：记录"图片确实加载失败"的结果 id → 原因文案。
  // 只存在内存里，不回写持久化数据（服务端另有"归档文件丢失"的持久标记）。
  const [brokenResultImages, setBrokenResultImages] = useState(() => ({}));
  const [resultFilter, setResultFilter] = useState("all");
  const [quickMode, setQuickMode] = useState("image");
  const [videoSettings, setVideoSettings] = useState(videoDefaults);
  const [videoReferenceFile, setVideoReferenceFile] = useState(null);
  const [videoResults, setVideoResults] = useState([]);
  const [videoTasks, setVideoTasks] = useState([]);
  const [videoStatus, setVideoStatus] = useState("idle");
  const [videoError, setVideoError] = useState("");
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
  // 2026-09-25：设置里原有的「开发诊断」区域（含传参自检按钮）已整体替换为「连接测试」。
  const [isConnectionTesting, setIsConnectionTesting] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState("");
  const [connectionState, setConnectionState] = useState("idle");
  const [isDirectoryModalOpen, setIsDirectoryModalOpen] = useState(false);
  const [isDetailPresetOpen, setIsDetailPresetOpen] = useState(false);
  const [isPromptAssistantOpen, setIsPromptAssistantOpen] = useState(false);
  const [isQuickChannelMenuOpen, setIsQuickChannelMenuOpen] = useState(false);
  const [editingPrompt, setEditingPrompt] = useState(null);
  const [promptCategory, setPromptCategory] = useState("全部");
  const [promptSearch, setPromptSearch] = useState("");
  const [referenceDropTarget, setReferenceDropTarget] = useState(null);
  const [quickResultReplaceTargetId, setQuickResultReplaceTargetId] = useState("");
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
  const videoReferenceInputRef = useRef(null);
  const detailProductInputRef = useRef(null);
  const detailReferenceInputRef = useRef(null);
  const referenceProductInputRef = useRef(null);
  const referenceStyleInputRef = useRef(null);
  const canvasStageRef = useRef(null);
  const canvasFileInputRef = useRef(null);
  const previewDragRef = useRef(null);
  const stitchDragRef = useRef(null);
  const quickResultDragIdRef = useRef("");
  const downloadFeedbackTimersRef = useRef(new Map());

  const models = config.models?.length ? config.models : DEFAULT_MODELS;
  const activeModel = models.find((item) => item.value === settings.model) || models[0];
  // 能力限制唯一来源：routing catalog 的 capabilities（见 src/shared/routing.js）。
  const quickCapabilities = modelCapabilities(settings.model, config.routing || config);
  const ratios = quickCapabilities.ratios;
  const quickSizes = quickCapabilities.sizes;
  // 上传图片数量随当前模型能力收敛：tt-image-2.5 是 8，其余是 14。
  // DEFAULT_MAX_REFERENCE_FILES 只在目录和能力都拿不到时兜底。
  const quickMaxReferenceFiles = Math.max(1, quickCapabilities.maxInputImages || DEFAULT_MAX_REFERENCE_FILES);
  const quickChannels = channelsForModel(settings.model, config.routing || config);
  const quickChannel = quickChannels.find((item) => item.id === settings.channelId) || quickChannels[0] || null;
  const videoModels = Array.isArray(config.videoModels) && config.videoModels.length ? config.videoModels : [];
  const activeVideoModel = videoModels.find((item) => item.value === videoSettings.model) || videoModels[0] || null;
  const videoRatios = activeVideoModel?.aspectRatios?.length ? activeVideoModel.aspectRatios : ["9:16", "16:9", "1:1"];
  const videoResolutions = activeVideoModel?.resolutions?.length ? activeVideoModel.resolutions : ["720p"];
  const videoDurations = activeVideoModel ? durationOptionsForVideoModel(activeVideoModel) : [5];
  const videoPromptHint = activeVideoModel ? videoPromptPlaceholder(activeVideoModel) : "输入视频画面、运动、镜头、服装和氛围要求";
  const videoPriceText = activeVideoModel ? videoPriceLabel(activeVideoModel, videoSettings.resolution) : "";
  const videoChannelEnabled = Boolean(config.videoPolicy?.enabled);
  const billingGatewayEnabled = Boolean(config.billingGatewayPolicy?.enabled);
  const videoBillingRequired = Boolean(config.billingGatewayPolicy?.videoRequired);
  const detailModel = models.find((item) => item.value === detailSettings.model) || models[0];
  const detailRatios = detailModel.ratios || ["1:1", "3:4", "16:9"];
  const referenceModel = models.find((item) => item.value === referenceSettings.model) || models[0];
  const referenceRatios = referenceModel.ratios || ["1:1", "3:4", "16:9"];
  // 分辨率下拉同样吃 capabilities，不再用写死的 1K/2K/4K。
  const detailSizes = modelCapabilities(detailSettings.model, config.routing || config).sizes;
  const referenceSizes = modelCapabilities(referenceSettings.model, config.routing || config).sizes;
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
  const videoReferencePreview = useMemo(() => (
    videoReferenceFile ? { file: videoReferenceFile, url: URL.createObjectURL(videoReferenceFile) } : null
  ), [videoReferenceFile]);
  const quickGalleryRef = useRef(null);
  const runningQuickTasks = quickTasks.filter((task) => task.status === "running");
  const runningVideoTasks = videoTasks.filter((task) => task.status === "running");
  const runningReferenceTasks = referenceTasks.filter((task) => task.status === "running");
  const imageCount = quickResults.length;
  const videoCount = videoResults.length;
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
  const latestVideoStatusText = runningVideoTasks.length > 0
    ? `视频生成中 ${runningVideoTasks.length} 个任务`
    : videoStatus === "failed"
      ? "视频任务失败"
      : videoStatus === "success"
        ? "视频已完成"
        : videoBillingRequired && !billingGatewayEnabled
          ? "等待计费接入"
          : "等待视频生成";
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
    getAppConfig().then((data) => {
      setConfig(data);
      const routingCatalog = data?.routing || data;
      setSettings((current) => {
        // 目录加载完成之前，loadState() 只用 canonical 别名做模型映射，
        // 绝不用默认值覆盖用户存档；目录回来后在这里做一次归一化收敛。
        if (!isRoutingCatalogReady(routingCatalog)) {
          return { ...current, baseUrl: data.defaultBaseUrl || defaultState.baseUrl };
        }
        const converged = convergeSettingsForModel(current, routingCatalog);
        return { ...converged, baseUrl: data.defaultBaseUrl || defaultState.baseUrl };
      });
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
    document.documentElement.setAttribute("data-theme", settings.theme || "dark");
    const timer = window.setTimeout(() => {
      writeJsonStorage(STORAGE_KEY, settings);
    }, 260);
    return () => window.clearTimeout(timer);
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
    if (!writeJsonStorage(INFINITE_CANVAS_KEY, infiniteCanvasState)) {
      addEvent("无限画布", "画布内容较大，部分临时图片可能无法写入本地缓存");
    }
  }, [infiniteCanvasState]);

  useEffect(() => {
    writeJsonStorage(ACTIVE_VIEW_KEY, activeView);
  }, [activeView]);

  useEffect(() => {
    if (!videoModels.length) return;
    setVideoSettings((current) => {
      const model = videoModels.find((item) => item.value === current.model) || videoModels[0];
      return normalizeVideoSettingValue(current, model);
    });
  }, [config.videoModels]);

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

  useEffect(() => () => {
    if (videoReferencePreview?.url) URL.revokeObjectURL(videoReferencePreview.url);
  }, [videoReferencePreview]);

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

  // 线路价格菜单：点击面板外部或按 Esc 关闭，避免菜单挡住底部参数和生成按钮。
  useEffect(() => {
    if (!isQuickChannelMenuOpen) return undefined;
    const onPointerDown = (event) => {
      if (event.target?.closest?.(".quickToolCluster")) return;
      setIsQuickChannelMenuOpen(false);
    };
    const onKeyDown = (event) => {
      if (event.key === "Escape") setIsQuickChannelMenuOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [isQuickChannelMenuOpen]);

  function updateSetting(key, value) {
    setSettings((current) => {
      const next = { ...current, [key]: value };
      if (key === "model") {
        // 切换模型时按新模型的 capabilities 重新收敛：
        // 比例 / 尺寸 / 生成数量 / 质量 / 背景 / 版本 / 线路。
        return convergeSettingsForModel(next, config.routing || config);
      }
      if (key === "channelId") {
        const channels = channelsForModel(next.model, config.routing || config);
        next.channelId = channels.some((item) => item.id === value) ? value : (channels[0]?.id || "");
        return next;
      }
      if (key === "n") next.n = Math.min(clampCount(value), modelCapabilities(next.model, config.routing || config).maxInputImages);
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
      if (key === "n") next.n = Math.min(clampCount(value), modelCapabilities(next.model, config).maxInputImages);
      if (key === "strength") next.strength = clampReferenceStrength(value);
      return next;
    });
  }

  async function applySmartReferencePrompt() {
    if (isReferencePromptRewriting) return;
    const apiKey = normalizeApiKeyInput(settings.apiKey);
    if (!apiKey && !config.hasServerKey) {
      setReferenceError("请先在左下角设置里填写 API Key，智能扩写需要调用当前 AI 模型");
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

      let payload = null;
      try {
        payload = await rewriteReferencePrompt(form);
      } catch (requestError) {
        payload = requestError?.payload || null;
        const message = requestError instanceof Error ? requestError.message : "参考生图提示词扩写失败";
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
      const message = normalizeGenerationErrorMessage(err);
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
      const payload = await uploadCanvasAssets(form);
      if (!payload?.ok) throw new Error(payload?.message || "Canvas assets upload failed");
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
      const canvasRoute = routingFields(params.model, settings.channelId, config.routing);
      form.set("model", canvasRoute.model);
      form.set("channelId", canvasRoute.channelId);
      form.set("dispatchMode", canvasRoute.dispatchMode);
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
      const payload = await generateImages(form);
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
      const message = normalizeGenerationErrorMessage(err);
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
      const remaining = quickMaxReferenceFiles - current.length;
      if (remaining <= 0) {
        addEvent("提示", `最多上传 ${quickMaxReferenceFiles} 张参考图`);
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
      const remaining = quickMaxReferenceFiles - next.length;
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
      const remaining = quickMaxReferenceFiles - current.length;
      if (remaining <= 0) {
        addEvent("提示", `最多上传 ${quickMaxReferenceFiles} 张参考图`);
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
    if (quickMode === "video") {
      setVideoReferenceFile(pastedImages[0]);
      addEvent("视频参考图", "已从剪贴板添加 1 张参考图");
      return;
    }
    appendReferenceFiles(pastedImages, {
      eventLabel: "粘贴上传",
      actionText: "已从剪贴板添加"
    });
  }

  function updateVideoSetting(key, value) {
    setVideoSettings((current) => {
      if (key === "model") {
        const model = videoModels.find((item) => item.value === value) || activeVideoModel || videoModels[0] || {};
        return normalizeVideoSettingValue({ ...current, model: value }, model);
      }
      if (key === "duration") {
        return { ...current, duration: Number.parseInt(value, 10) || videoDefaults.duration };
      }
      if (key === "outputAudio") {
        return { ...current, outputAudio: Boolean(value) };
      }
      return { ...current, [key]: value };
    });
  }

  function acceptVideoReferenceFile(fileList) {
    const picked = imageFilesFromList(fileList);
    if (picked.length === 0) return false;
    const file = picked[0];
    if (file.size > VIDEO_REFERENCE_MAX_BYTES) {
      addEvent("视频参考图", "参考图超过 10MB，请先压缩后再上传");
      return false;
    }
    setVideoReferenceFile(file);
    addEvent("视频参考图", `已添加 ${file.name}`);
    return true;
  }

  function onPickVideoReference(event) {
    acceptVideoReferenceFile(event.target.files);
    event.target.value = "";
  }

  function onVideoComposerDragOver(event) {
    if (!isReferenceDropData(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setIsComposerDragging(true);
  }

  function onVideoComposerDrop(event) {
    event.preventDefault();
    setIsComposerDragging(false);
    void imageFilesFromReferenceDrop(event.dataTransfer)
      .then((droppedFiles) => acceptVideoReferenceFile(droppedFiles))
      .catch((err) => addEvent("视频参考图失败", err instanceof Error ? err.message : String(err)));
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function videoReferencePayload() {
    const url = String(videoSettings.imageUrl || "").trim();
    if (url) return url;
    if (!videoReferenceFile) return "";
    return dataUrlFromBlob(videoReferenceFile);
  }

  async function pollVideoUntilFinished(initialTask, requestId, runSettings, apiKey, startedAt) {
    let task = initialTask || {};
    for (let attempt = 0; attempt < VIDEO_STATUS_MAX_POLLS; attempt += 1) {
      if (isVideoTaskCompleted(task)) return task;
      if (isVideoTaskFailed(task)) {
        throw new Error(task.error?.message || task.error || "视频生成失败");
      }
      setVideoTasks((current) => current.map((item) => (
        item.id === requestId
          ? { ...item, statusText: videoTaskStatusText(task), progress: task.progress, upstreamTaskId: task.taskId || item.upstreamTaskId }
          : item
      )));
      await sleep(VIDEO_STATUS_POLL_INTERVAL_MS);
      const previousTaskId = task.taskId || task.id;
      const statusPayload = await getVideoStatus({
        apiKey,
        taskId: previousTaskId
      });
      const nextTask = statusPayload.task || {};
      task = {
        ...nextTask,
        taskId: nextTask.taskId || nextTask.id || previousTaskId,
        id: nextTask.id || nextTask.taskId || previousTaskId
      };
      setVideoTasks((current) => current.map((item) => (
        item.id === requestId
          ? {
              ...item,
              statusText: videoTaskStatusText(task),
              progress: task.progress,
              upstreamTaskId: task.taskId || item.upstreamTaskId,
              elapsedMs: Date.now() - startedAt,
              modelLabel: runSettings.modelLabel
            }
          : item
      )));
    }
    throw new Error("视频生成等待超时，请稍后到上游任务记录中查看。");
  }

  async function generateVideoFromComposer() {
    const model = activeVideoModel || videoModels[0];
    const modelLabel = model?.label || videoSettings.model || "Seedance";
    const runSettings = normalizeVideoSettingValue({ ...videoSettings }, model || {});
    const apiKey = normalizeApiKeyInput(settings.apiKey);

    if (!apiKey && !config.hasServerKey) {
      setVideoError("请先在左下角设置里填写 API Key");
      setIsSettingsOpen(true);
      setVideoStatus("failed");
      addEvent("无法生成视频", "请先填写 API Key");
      return;
    }
    if (!videoModels.length) {
      setVideoError("视频模型配置未加载");
      setVideoStatus("failed");
      addEvent("无法生成视频", "视频模型配置未加载");
      return;
    }
    if (!videoChannelEnabled) {
      setVideoError("视频通道未配置，请先配置兰兰达视频 KEY");
      setVideoStatus("failed");
      addEvent("无法生成视频", "视频通道未配置");
      return;
    }
    if (videoBillingRequired && !billingGatewayEnabled) {
      setVideoError("视频计费网关未启用，请先接入静音中转站计费后再生成。");
      setVideoStatus("failed");
      addEvent("无法生成视频", "视频计费网关未启用");
      return;
    }
    if (!String(runSettings.prompt || "").trim()) {
      setVideoError("请输入视频提示词");
      setVideoStatus("failed");
      addEvent("无法生成视频", "请输入视频提示词");
      return;
    }
    if (!billingGatewayEnabled) {
      addEvent("计费提示", "当前源码侧计费网关未启用，正式客户版需开启后再交付");
    }

    const requestId = `video_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const startedAt = Date.now();
    setVideoStatus("running");
    setVideoError("");
    setNowTick(startedAt);
    setVideoTasks((current) => [...current, {
      id: requestId,
      status: "running",
      startedAt,
      modelLabel,
      resolution: runSettings.resolution,
      aspectRatio: runSettings.aspectRatio,
      duration: runSettings.duration,
      prompt: runSettings.prompt,
      statusText: "提交中"
    }]);
    addEvent("视频提交", `${modelLabel} / ${runSettings.resolution} / ${runSettings.aspectRatio} / ${runSettings.duration}s`);

    try {
      const image = await videoReferencePayload();
      const payload = await generateVideo({
        apiKey,
        model: runSettings.model,
        prompt: runSettings.prompt,
        duration: runSettings.duration,
        resolution: runSettings.resolution,
        aspectRatio: runSettings.aspectRatio,
        image,
        outputAudio: runSettings.outputAudio,
        metadata: {
          source: "quick-video",
          clientSessionId: CLIENT_SESSION_ID
        }
      });
      const finalTask = await pollVideoUntilFinished(payload.task || {}, requestId, { ...runSettings, modelLabel }, apiKey, startedAt);
      const url = videoResultUrl(finalTask);
      if (!url) throw new Error("视频任务已完成，但没有返回视频地址");
      const totalMs = Date.now() - startedAt;
      const result = {
        id: requestId,
        taskId: finalTask.taskId || payload.task?.taskId || requestId,
        url,
        prompt: runSettings.prompt,
        modelLabel,
        resolution: runSettings.resolution,
        aspectRatio: runSettings.aspectRatio,
        duration: runSettings.duration,
        generationMs: totalMs,
        createdAt: Date.now(),
        submittedAt: startedAt,
        status: "success",
        referenceName: videoReferenceFile?.name || (runSettings.imageUrl ? "URL参考图" : "")
      };
      setVideoResults((current) => [result, ...current]);
      setVideoStatus("success");
      addEvent("视频完成", `生成 1 条视频，用时 ${formatMs(totalMs)}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isAuthErrorMessage(message)) setIsSettingsOpen(true);
      setVideoStatus("failed");
      setVideoError(message);
      addEvent("视频失败", message);
    } finally {
      setVideoTasks((current) => current.filter((task) => task.id !== requestId));
    }
  }

  function downloadVideoResult(item) {
    if (!item?.url) return;
    const link = document.createElement("a");
    link.href = item.url;
    link.download = `静音AI视频-${dragDownloadDateStamp(item.createdAt || Date.now())}.mp4`;
    link.rel = "noreferrer";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    addEvent("视频下载", "已开始下载视频");
  }

  function clearVideoResults() {
    setVideoResults([]);
    setVideoTasks([]);
    setVideoStatus("idle");
    setVideoError("");
    addEvent("视频", "已清空视频结果");
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
    // 2026-09-25：这里原来会在 settings.aspectRatio 不属于 QUICK_LOCAL_EDIT_RATIOS 时
    // 把比例强改成 QUICK_LOCAL_EDIT_RATIOS[0]（也就是 "1:1"）。
    // 模型目录里的 2:3 / auto 等合法比例会因此被悄悄改成正方形，
    // 于是"打开局部回贴就变成正方形选框"。现在不再改用户的比例设置。
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
    setBrokenResultImages((current) => {
      if (!current[id]) return current;
      const next = { ...current };
      delete next[id];
      return next;
    });
    if (detailInfoSelection?.resultId === id) setDetailInfoSelection(null);
    addEvent("删除", "已删除当前图片");
  }

  /**
   * P1 缺图自愈：图片真的加载失败时记下来，卡片改为显示可读原因，
   * 并且不再对同一个地址重复请求（避免每次打开页面都刷 404/502）。
   * 记录里带上失败时的地址，重刷换图后自动失效。
   */
  function markResultImageBroken(item) {
    const src = imageSourceFromResult(item?.image);
    if (!item?.id || !src) return;
    setBrokenResultImages((current) => (
      current[item.id]?.src === src
        ? current
        : { ...current, [item.id]: { src, reason: brokenImageReason() } }
    ));
  }

  function quickResultDragId(event) {
    const fromEvent = event.dataTransfer?.getData?.(QUICK_RESULT_DRAG_TYPE) || "";
    return fromEvent || quickResultDragIdRef.current || "";
  }

  function canReplaceQuickResult(source, target) {
    return Boolean(
      source?.id
      && target?.id
      && source.id !== target.id
      && (!source.source || source.source === "quickgen")
      && (!target.source || target.source === "quickgen")
      && imageSourceFromResult(source.image)
      && imageSourceFromResult(target.image)
    );
  }

  function clearQuickResultDragState() {
    quickResultDragIdRef.current = "";
    setQuickResultReplaceTargetId("");
  }

  function handleQuickResultReplaceDragOver(event, target) {
    const sourceId = quickResultDragId(event);
    const source = results.find((item) => item.id === sourceId);
    if (!canReplaceQuickResult(source, target)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    if (quickResultReplaceTargetId !== target.id) setQuickResultReplaceTargetId(target.id);
  }

  function handleQuickResultReplaceDrop(event, target) {
    const sourceId = quickResultDragId(event);
    if (!sourceId || sourceId === target?.id) {
      clearQuickResultDragState();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    clearQuickResultDragState();
    const source = results.find((item) => item.id === sourceId);
    const latestTarget = results.find((item) => item.id === target.id);
    if (!canReplaceQuickResult(source, latestTarget)) return;
    const nextTarget = {
      ...source,
      id: latestTarget.id,
      replacedFromResultId: source.id,
      submittedAt: latestTarget.submittedAt ?? latestTarget.createdAt ?? source.submittedAt,
      createdAt: latestTarget.createdAt ?? source.createdAt
    };
    setResults((current) => current
      .map((item) => item.id === latestTarget.id ? nextTarget : item)
      .filter((item) => item.id !== source.id));
    setSelectedIds((current) => {
      const next = new Set(current);
      next.delete(source.id);
      return next;
    });
    if (previewResult?.id === source.id || previewResult?.id === latestTarget.id) {
      setPreviewResult(nextTarget);
    }
    void removeHistoryResults([source.id, latestTarget.id]).then(() => saveHistoryResults([nextTarget]));
    addEvent("结果覆盖", "已用拖拽图片覆盖目标图片，原位置已移除");
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
      const payload = await getSaveDirectory();
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
      const payload = await setSaveDirectoryRequest(directoryDraft);
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
      const payload = await pickSaveDirectoryRequest(directoryDraft || saveDirectory);
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
      openSaveDirectoryRequest(directory).then((payload) => {
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
    return fetchImageBlob(src, "图片下载失败");
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
    const blob = await fetchImageBlob(url, "图片读取失败");
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

  function imageMimeFromSource(src, image = null) {
    const explicit = String(image?.mimeType || image?.archiveMime || "").trim();
    if (explicit) return explicit;
    const dataMatch = String(src || "").match(/^data:([^;,]+)/i);
    if (dataMatch?.[1]) return dataMatch[1];
    if (/\.jpe?g(?:$|[?#])/i.test(src)) return "image/jpeg";
    if (/\.webp(?:$|[?#])/i.test(src)) return "image/webp";
    if (/\.gif(?:$|[?#])/i.test(src)) return "image/gif";
    return "image/png";
  }

  function imageExtensionFromSource(src, mimeType) {
    if (/jpe?g/i.test(mimeType)) return "jpg";
    if (/webp/i.test(mimeType)) return "webp";
    if (/gif/i.test(mimeType)) return "gif";
    const pathMatch = String(src || "").match(/\.([a-z0-9]{2,5})(?:$|[?#])/i);
    if (pathMatch && /^(png|jpe?g|webp|gif)$/i.test(pathMatch[1])) {
      return pathMatch[1].toLowerCase().replace("jpeg", "jpg");
    }
    return "png";
  }

  function safeDownloadFileName(name, ext = "png") {
    const base = fileBaseName(name)
      .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "_")
      .replace(/\s+/g, " ")
      .trim() || "image";
    return `${base}.${ext}`;
  }

  function padDragDownloadNumber(value, length = 2) {
    return String(Math.max(0, Number.parseInt(value, 10) || 0)).padStart(length, "0");
  }

  function dragDownloadDateStamp(value) {
    const timestamp = Number(value);
    const date = new Date(Number.isFinite(timestamp) && timestamp > 0 ? timestamp : Date.now());
    const day = [
      date.getFullYear(),
      padDragDownloadNumber(date.getMonth() + 1),
      padDragDownloadNumber(date.getDate())
    ].join("");
    const time = [
      padDragDownloadNumber(date.getHours()),
      padDragDownloadNumber(date.getMinutes()),
      padDragDownloadNumber(date.getSeconds())
    ].join("");
    return `${day}-${time}`;
  }

  function resultDragDownloadName(item, fallbackIndex = null) {
    const savedName = item?.savedFilename || item?.filename;
    if (savedName) return savedName;
    // 拖拽下载无法读取目标文件夹序号，使用生成日期时间+列表序号避免模型名反复重名。
    const createdAt = Number(item?.createdAt || item?.submittedAt || Date.now());
    const sequence = Number.isFinite(fallbackIndex)
      ? fallbackIndex + 1
      : Math.max(1, Math.round(createdAt % 100000));
    return `静音AI绘画-${dragDownloadDateStamp(createdAt)}-${padDragDownloadNumber(sequence, 4)}`;
  }

  function absoluteDownloadUrl(src) {
    const requestUrl = displayImageRequestUrl(src);
    if (!requestUrl || /^(data|blob):/i.test(requestUrl)) return requestUrl || "";
    try {
      return new URL(requestUrl, window.location.href).href;
    } catch {
      return requestUrl;
    }
  }

  function beginImageDownloadDrag(event, src, name = "静音AI绘画", image = null) {
    if (!src) return;
    event.stopPropagation?.();
    const mimeType = imageMimeFromSource(src, image);
    const filename = safeDownloadFileName(name, imageExtensionFromSource(src, mimeType));
    const downloadUrl = absoluteDownloadUrl(src);
    event.dataTransfer.effectAllowed = "copy";
    event.dataTransfer.setData("DownloadURL", `${mimeType}:${filename}:${downloadUrl}`);
    event.dataTransfer.setData("application/x-jingyin-download-url", downloadUrl);
    event.dataTransfer.setData("text/uri-list", src);
    event.dataTransfer.setData("text/plain", src);
  }

  function beginResultImageDrag(event, item, fallbackIndex = null) {
    const src = imageSourceFromResult(item?.image);
    if (!src) return;
    beginImageDownloadDrag(event, src, resultDragDownloadName(item, fallbackIndex), item?.image);
    event.dataTransfer.setData("application/x-jingyin-result-id", item.id || "");
    event.dataTransfer.setData(QUICK_RESULT_DRAG_TYPE, item.id || "");
    event.dataTransfer.effectAllowed = "copyMove";
    quickResultDragIdRef.current = item.id || "";
  }

  function beginReferenceImageDrag(event, reference, index = 0) {
    const src = referenceSource(reference);
    beginImageDownloadDrag(event, src, reference?.name || reference?.label || `参考图-${index + 1}`);
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
      setError("请先在左下角设置里填写 API Key，优化提示词需要调用当前 AI 模型");
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

      let payload = null;
      try {
        payload = await rewriteQuickPrompt(form);
      } catch (requestError) {
        payload = requestError?.payload || null;
        const message = requestError instanceof Error ? requestError.message : "快捷生成提示词优化失败";
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
      const message = normalizeGenerationErrorMessage(err);
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

  function openSettingsPanel() {
    setIsSettingsOpen(true);
  }

  /**
   * 连接测试：对齐 3.0 `/api/providers/test-connection` 的做法 —— 只探测 /v1/models。
   * 不发提示词、不上传图片、不调用生图接口，所以既不会出图也不会扣费。
   */
  async function runConnectionTest() {
    setIsConnectionTesting(true);
    setConnectionState("running");
    setConnectionStatus("正在探测上游模型清单…");
    try {
      const result = await testConnection({
        baseUrl: settings.baseUrl || config.defaultBaseUrl || "",
        apiKey: settings.apiKey,
        model: settings.model,
        channelId: settings.channelId
      });
      setConnectionState(result.ok ? "ok" : "error");
      setConnectionStatus(formatConnectionResult(result));
      addEvent(result.ok ? "连接测试" : "连接测试失败", result.message || "");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setConnectionState("error");
      setConnectionStatus(message || "连接测试失败");
      addEvent("连接测试失败", message || "请求失败");
    } finally {
      setIsConnectionTesting(false);
    }
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
    if (files.length >= quickMaxReferenceFiles) {
      addEvent("参考图", `最多保留 ${quickMaxReferenceFiles} 张参考图`);
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
    void generate({ prompt, n: count, replaceResultId: item.id });
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
      setError("请先在左下角设置里填写 API Key，AI 详情页分析需要调用当前 AI 模型");
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
      const payload = await createDetailPrompts(form);
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
      const message = normalizeGenerationErrorMessage(err);
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
    const detailRoute = routingFields(group.params.model, detailSettings.channelId, config.routing);
    form.set("model", detailRoute.model);
    form.set("channelId", detailRoute.channelId);
    form.set("dispatchMode", detailRoute.dispatchMode);
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
      const payload = await generateImages(form);
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
      const message = normalizeGenerationErrorMessage(err);
      if (isAuthErrorMessage(message)) {
        setIsSettingsOpen(true);
        setError("API Key 无效，请检查后在设置里重新保存。");
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
      setError("API Key 无效，请检查后在设置里重新保存。");
      addEvent("一键详情", "有分屏返回 API Key 无效，请检查 KEY");
    }
    setDetailGroups((current) => current.map((item) => (
      item.id === groupId ? { ...item, status: failed ? "partial" : "success" } : item
    )));
    setDetailStatus(failed ? "failed" : "ready");
    addEvent("一键详情", failed ? `完成，${failed} 屏失败` : "全部屏幕生成完成");
  }

  async function generate(overrides = {}) {
    const { replaceResultId = "", ...settingOverrides } = overrides;
    const runSettings = {
      ...settings,
      ...settingOverrides,
      n: clampCount(settingOverrides.n ?? settings.n),
      baseUrl: config.defaultBaseUrl || settings.baseUrl || defaultState.baseUrl
    };
    const runItems = files.map(normalizeQuickReferenceItem).filter(Boolean);
    const localEditItems = runItems.filter(quickReferenceHasLocalEdit);
    const primaryRunItem = runItems[0] || null;
    const localEditItem = quickReferenceHasLocalEdit(primaryRunItem) ? primaryRunItem : null;
    const primaryLocalEdit = Boolean(localEditItem?.id);
    const ignoredLocalEditCount = localEditItems.filter((item) => item?.id !== localEditItem?.id).length;
    const hasLocalEditConflict = primaryLocalEdit && ignoredLocalEditCount > 0;
    const quickPrimaryLocalIntent = primaryLocalEdit ? classifyQuickPrimaryLocalIntent(runSettings.prompt) : "";
    let localEditForRun = localEditItem?.localEdit || null;
    let localEditRunItem = localEditItem;
    const wholeOutfitIntent = !localEditForRun
      && runItems.length >= 2
      && classifyQuickPrimaryLocalIntent(runSettings.prompt) === "outfit";
    const banana2LocalOutfit = isBanana2Model(runSettings.model)
      && primaryLocalEdit
      && quickPrimaryLocalIntent === "outfit";
    const localAppearanceIntent = primaryLocalEdit && quickPrimaryLocalIntent === "appearance";
    // 2026-09-25 对齐 3.0：删除了 shouldUseExactBanana2LocalCrop 的"香蕉2 再精确重裁一次"分支。
    // 它存在的理由是当时只有香蕉2 用精确选框、其它模型用 contextRect 大图；
    // 现在所有模型上传的都是精确选框（见 cropQuickLocalEditFile），这个特殊分支已经没有意义。
    const runFiles = runItems.map((item) => quickReferenceRunUploadFile(item, localEditRunItem)).filter((file) => file instanceof File);
    const apiPrompt = promptForQuickGeneration(runSettings.prompt, localEditForRun, runSettings.model, {
      primaryLocalEdit,
      localIntent: quickPrimaryLocalIntent,
      wholeOutfit: wholeOutfitIntent,
      // 快捷生成规则 / SKILL 临时开关：关闭时只发用户原始提示词。
      skillRules: runSettings.skillRulesEnabled !== false
    });
    // 提示词上限来自当前模型 capabilities；超限时按目录上限截断并提示，
    // 用户输入框里的原文保持不动。
    const promptClamp = clampPromptForModel(apiPrompt, runSettings.model, config.routing || config);
    const finalPrompt = promptClamp.prompt;
    if (promptClamp.truncated) {
      addEvent("提示词截断", `已按当前模型上限截断到 ${promptClamp.maxPromptLength} 字`);
    }
    const runModel = models.find((item) => item.value === runSettings.model) || models[0];
    const runReferenceMeta = referenceMetaFromQuickRunItems(runItems, localEditRunItem, "reference");

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
    if (!primaryLocalEdit && ignoredLocalEditCount > 0) {
      addEvent("局部回贴", "只有图1会触发局部回贴，图2/图3不会切换成回贴模式");
    }
    if (primaryLocalEdit && quickPrimaryLocalIntent) {
      addEvent(
        "局部触发",
        quickPrimaryLocalIntent === "outfit"
          ? "已启用局部换装"
          : quickPrimaryLocalIntent === "appearance"
            ? "已启用局部换样貌"
            : "已启用局部精修"
      );
    } else if (wholeOutfitIntent) {
      addEvent("换装触发", "已启用整图换装姿势锁定");
    }

    const form = new FormData();
    form.set("baseUrl", runSettings.baseUrl);
    form.set("apiKey", normalizeApiKeyInput(runSettings.apiKey));
    const route = routingFields(runSettings.model, runSettings.channelId, config.routing);
    form.set("model", route.model);
    form.set("channelId", route.channelId);
    form.set("dispatchMode", route.dispatchMode);
    form.set("prompt", finalPrompt);
    form.set("imageSize", runSettings.imageSize);
    form.set("aspectRatio", runSettings.aspectRatio);
    form.set("n", String(runSettings.n));
    form.set("source", "quickgen");
    if (localEditForRun) form.set("deferAutoSave", "1");
    form.set("referenceMeta", JSON.stringify(runReferenceMeta));

    const started = performance.now();
    try {
      const uploadRunFiles = (!localEditForRun && runFiles.length > 0)
        ? [await ensureQuickUploadCanvasRatio(runFiles[0], runSettings.aspectRatio), ...runFiles.slice(1)]
        : runFiles;
      const normalizeForBanana2 = shouldNormalizeQuickUploadForModel(runSettings.model) && uploadRunFiles.length > 0 && !localEditForRun;
      const upload = await prepareImageFilesForChannel(uploadRunFiles, {
        forceJpeg: normalizeForBanana2,
        preserveFirstFile: Boolean(localEditForRun),
        preserveFirstFileMaxBytes: LOCAL_EDIT_CROP_UPLOAD_TARGET_BYTES
      });
      if (upload.compressedCount > 0) {
        addEvent("图片压缩", `已压缩 ${upload.compressedCount} 张参考图到 4MB 内`);
      }
      if (upload.normalizedCount > 0) {
        addEvent("香蕉2原图兼容", `已转换 ${upload.normalizedCount} 张参考图为兼容 JPEG`);
      }
      upload.files.forEach((file) => form.append("image", file, file.name));
      // 香蕉 Pro：参考图改走服务端的 JSON + image_urls 通道（对齐 3.0 的带图路径），
      // 这里额外附上 1536 长边的 JPEG data URL。其它模型不带这个字段，链路不变。
      if (JSON_IMAGE_URLS_MODELS.has(route.model) && upload.files.length > 0 && !localEditForRun?.maskDataUrl) {
        const compactUrls = await Promise.all(upload.files.map((file) => fileToCompactJpegDataUrl(file)));
        compactUrls.filter(Boolean).forEach((dataUrl) => form.append("referenceDataUrl", dataUrl));
      }
      const payload = await generateImages(form);
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
        // 2026-09-25 对齐 3.0：贴回不再做任何后处理。
        // 原来按模型分派的 autoAlign / colorMatch / protectSkinAndFace / feather
        // 全部停用（3.0 localPaste.ts 明确"贴回就是贴回"）。
        // 这里保留一个空对象，调用点签名不变。
        const localCompositeOptions = {};
        void localAppearanceIntent;
        nextResults = await Promise.all(nextResults.map(async (item) => {
          const generatedBlob = await blobFromImageItem(item);
          const composedBlob = await composeQuickLocalEditBlob(originalFile, generatedBlob, localEditForRun.cropRect, localEditForRun, localCompositeOptions);
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
      if (replaceResultId && nextResults[0]) {
        const replacement = {
          ...nextResults[0],
          id: replaceResultId,
          replacedFromResultId: nextResults[0].id
        };
        const extraResults = nextResults.slice(1);
        setResults((current) => [
          ...extraResults,
          ...current.map((item) => item.id === replaceResultId ? {
            ...replacement,
            submittedAt: item.submittedAt ?? replacement.submittedAt,
            createdAt: item.createdAt ?? replacement.createdAt
          } : item)
        ]);
        void removeHistoryResults([replaceResultId, ...nextResults.map((item) => item.id)])
          .then(() => saveHistoryResults([replacement, ...extraResults]));
      } else {
        setResults((current) => [...nextResults, ...current]);
        void saveHistoryResults(nextResults);
      }
      setTiming(payload.timing);
      setStatus("success");
      addEvent(replaceResultId ? "重刷完成" : "完成", `${replaceResultId ? "已原位覆盖，" : `生成 ${nextResults.length} 张，`}用时 ${formatMs(totalMs)}${autoSaveEventText(payload, localEditForRun ? clientAutoSavedCount : null)}`);
    } catch (err) {
      const message = normalizeGenerationErrorMessage(err);
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
    const route = routingFields(runSettings.model, runSettings.channelId, config.routing);
    form.set("model", route.model);
    form.set("channelId", route.channelId);
    form.set("dispatchMode", route.dispatchMode);
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
      const payload = await generateImages(form);
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
    // 最外层兜底：任何一个视图在渲染期抛错，都不会变成整页白屏。
    <ErrorBoundary label="应用主界面">
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

        <button className="settingsEntry" type="button" onClick={() => openSettingsPanel()}>
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
                  className={`tabButton ${quickMode === "image" && resultFilter === "all" ? "active" : ""}`}
                  type="button"
                  onClick={() => { setQuickMode("image"); setResultFilter("all"); }}
                >
                  全部({imageCount + videoCount})
                </button>
                <button
                  className={`tabButton ${quickMode === "image" && resultFilter === "image" ? "active" : ""}`}
                  type="button"
                  onClick={() => { setQuickMode("image"); setResultFilter("image"); }}
                >
                  <ImageIcon size={14} /> 图片({imageCount})
                </button>
                <button
                  className={`tabButton ${quickMode === "video" ? "active" : ""}`}
                  type="button"
                  onClick={() => { setQuickMode("video"); setResultFilter("video"); }}
                >
                  <Video size={14} /> 视频({videoCount})
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
                {quickMode === "video" ? (
                  <>
                    <span className={`taskBadge task-${videoStatus === "failed" ? "failed" : runningVideoTasks.length > 0 ? "running" : videoStatus}`}>{latestVideoStatusText}</span>
                    <button className="toolbarButton" type="button" onClick={() => videoResults[0] && downloadVideoResult(videoResults[0])} disabled={videoResults.length === 0}>
                      <Download size={15} />
                      <span>下载最新</span>
                    </button>
                    <button className="dangerButton" type="button" onClick={clearVideoResults} disabled={videoResults.length === 0 && runningVideoTasks.length === 0}>
                      <Trash2 size={15} />
                      <span>清空视频</span>
                    </button>
                  </>
                ) : (
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
          <ErrorBoundary label="批量生成">
            <OutfitWorkflow
              view={activeView}
              hostTheme={settings.theme}
              hostApiKey={settings.apiKey}
              onOpenHostSettings={openSettingsPanel}
            />
          </ErrorBoundary>
        ) : activeView === "image-editor" ? (
          <ErrorBoundary label="图片编辑">
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
          </ErrorBoundary>
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
                        {detailSizes.map((size) => <option key={size} value={size}>{size}</option>)}
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
                                      <CachedImage
                                        src={src}
                                        alt={`第${prompt.screen}屏结果`}
                                        draggable
                                        onDragStart={(event) => beginResultImageDrag(event, result, resultIndex)}
                                        diagnostic={{ requestId: result.requestId || result.id, endpoint: "/api/images", module: "一键详情", placement: `detail-screen-${prompt.screen}` }}
                                      />
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
                                      <ReferenceThumbTray references={result.references} count={result.referenceCount} max={5} onOpen={openReferencePreview} onContextMenu={openReferenceContextMenu} onImageDragStart={beginReferenceImageDrag} />
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
                    <CachedImage
                      src={imageSourceFromResult(detailInfoItem.result.image)}
                      alt="详情分屏预览"
                      draggable
                      onDragStart={(event) => beginResultImageDrag(event, detailInfoItem.result)}
                      diagnostic={{ requestId: detailInfoItem.result.requestId || detailInfoItem.result.id, endpoint: "/api/images", module: "一键详情", placement: "detail-info" }}
                    />
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
                    <ReferenceThumbTray references={detailInfoItem.result.references} count={detailInfoItem.result.referenceCount} max={6} onOpen={openReferencePreview} onContextMenu={openReferenceContextMenu} onImageDragStart={beginReferenceImageDrag} />
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
                              <CachedImage
                                src={imageSourceFromResult(node.result.image)}
                                alt={node.title}
                                draggable
                                onDragStart={(event) => beginResultImageDrag(event, node.result)}
                              />
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
                                {quickSizes.map((size) => <option key={size} value={size}>{size}</option>)}
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
                                  <CachedImage
                                    src={imageSourceFromResult(result.image)}
                                    alt={`输出 ${resultIndex + 1}`}
                                    draggable
                                    onDragStart={(event) => beginResultImageDrag(event, result, resultIndex)}
                                  />
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
                        {referenceSizes.map((size) => <option key={size} value={size}>{size}</option>)}
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
                      <CachedImage src={src} alt={`参考生图 ${index + 1}`} draggable onDragStart={(event) => beginResultImageDrag(event, item, index)} diagnostic={{ requestId: item.requestId || item.id, endpoint: "/api/images", module: "参考生图", placement: "reference-card" }} />
                      <ReferenceThumbTray references={item.references} count={item.referenceCount} className="assetReferenceTray" onOpen={openReferencePreview} onContextMenu={openReferenceContextMenu} onImageDragStart={beginReferenceImageDrag} />
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
        ) : activeView === "quickgen" && quickMode === "video" ? (
        <div className="canvasBoard videoCanvasBoard">
          <section className="galleryStrip videoGalleryStrip" style={{ "--asset-card-min": `${Math.round(236 * galleryZoom)}px` }}>
            {videoTasks.map((task) => (
              <article className="assetCard loadingCard videoAssetCard" key={task.id}>
                <Loader2 className="spin" size={28} />
                <span>{task.statusText || "视频生成中"}</span>
                <strong>{formatMs(nowTick - task.startedAt)}</strong>
                <em>{task.modelLabel} · {task.resolution} · {task.aspectRatio} · {task.duration}s</em>
              </article>
            ))}
            {videoResults.map((item) => (
              <article className="assetCard videoAssetCard" key={item.id}>
                <button
                  className="assetDownloadButton"
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    downloadVideoResult(item);
                  }}
                  title="下载视频"
                  aria-label="下载视频"
                >
                  <Download size={16} />
                </button>
                {item.generationMs && <div className="assetTimeBadge">用时 {formatMs(item.generationMs)}</div>}
                <video src={item.url} controls preload="metadata" />
                {item.prompt && (
                  <button
                    className="assetPrompt"
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      copyText(item.prompt, "视频提示词已复制");
                    }}
                    title={item.prompt}
                  >
                    {item.prompt}
                  </button>
                )}
                <div className="assetMeta">
                  <span>{item.modelLabel}</span>
                  <strong>{item.resolution} · {item.aspectRatio} · {item.duration}s</strong>
                </div>
              </article>
            ))}
          </section>

          {videoResults.length === 0 && runningVideoTasks.length === 0 && (
            <div className="emptyCanvas">
              <Video size={34} />
              <span>{videoStatus === "failed" ? videoError : "暂无视频"}</span>
            </div>
          )}

          <section
            className={`composer videoComposer ${isComposerDragging ? "dragging" : ""}`}
            onDragOver={onVideoComposerDragOver}
            onDragLeave={onComposerDragLeave}
            onDrop={onVideoComposerDrop}
            onPaste={onComposerPaste}
          >
            {videoPriceText && <span className="videoPriceBadge">{videoPriceText}</span>}
            {/* 2026-09-25 UI 调整：同一组「图片生成 / 视频生成」页签在视频悬浮框里也删掉，
                切回图片模式仍然可以走顶部结果栏的「全部 / 图片」按钮。 */}

            <div className="videoReferenceLine">
              <input ref={videoReferenceInputRef} type="file" accept="image/*" onChange={onPickVideoReference} />
              <button className="videoReferenceTile" type="button" onClick={() => videoReferenceInputRef.current?.click()}>
                {videoReferencePreview ? (
                  <>
                    <img src={videoReferencePreview.url} alt={videoReferencePreview.file.name} />
                    <span>{videoReferencePreview.file.name}</span>
                  </>
                ) : (
                  <>
                    <Plus size={18} />
                    <span>参考图</span>
                  </>
                )}
              </button>
              <input
                className="videoUrlInput"
                value={videoSettings.imageUrl}
                onChange={(event) => updateVideoSetting("imageUrl", event.target.value)}
                placeholder="图片参考 URL，可留空"
              />
              {(videoReferenceFile || videoSettings.imageUrl) && (
                <button className="smallButton" type="button" onClick={() => { setVideoReferenceFile(null); updateVideoSetting("imageUrl", ""); }}>
                  <Trash2 size={15} />
                  <span>清空参考</span>
                </button>
              )}
            </div>

            <textarea
              className="promptBox videoPromptBox"
              value={videoSettings.prompt}
              onChange={(event) => updateVideoSetting("prompt", event.target.value)}
              placeholder={videoPromptHint}
            />

            <div className="composerFooter">
              <div className="leftTools">
                <button className="smallButton" type="button" onClick={() => setIsPromptAssistantOpen(true)}>
                  <BookOpen size={16} />
                  <span>词</span>
                </button>
                <button
                  className={`smallButton ${videoSettings.outputAudio ? "active" : ""}`}
                  type="button"
                  onClick={() => updateVideoSetting("outputAudio", !videoSettings.outputAudio)}
                >
                  <Flame size={16} />
                  <span>{videoSettings.outputAudio ? "音频开" : "音频关"}</span>
                </button>
                {videoBillingRequired && !billingGatewayEnabled && <span className="videoBillingBadge">计费未接入</span>}
              </div>

              <div className="rightTools videoRightTools">
                <select value={videoSettings.model} onChange={(event) => updateVideoSetting("model", event.target.value)}>
                  {videoModels.map((model) => <option key={model.value} value={model.value}>{model.label}</option>)}
                </select>
                <select value={videoSettings.aspectRatio} onChange={(event) => updateVideoSetting("aspectRatio", event.target.value)}>
                  {videoRatios.map((ratio) => <option key={ratio} value={ratio}>{ratio}</option>)}
                </select>
                <select value={videoSettings.resolution} onChange={(event) => updateVideoSetting("resolution", event.target.value)}>
                  {videoResolutions.map((resolution) => <option key={resolution} value={resolution}>{resolution}</option>)}
                </select>
                <select value={videoSettings.duration} onChange={(event) => updateVideoSetting("duration", event.target.value)}>
                  {videoDurations.map((duration) => <option key={duration} value={duration}>{duration}s</option>)}
                </select>
                <button
                  className="generateButton"
                  type="button"
                  onClick={() => void generateVideoFromComposer()}
                  disabled={runningVideoTasks.length > 0}
                >
                  {runningVideoTasks.length > 0 ? <Loader2 className="spin" size={17} /> : <Play size={17} />}
                  <span>生成视频</span>
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
              // P1 缺图自愈：已知失效（服务端标记）或加载失败过 → 不再发请求，直接显示原因。
              // 失败标记带 src 快照：重刷后地址变了就自动失效，不会把新图也判成坏图。
              const cardState = resultImageCardState(item.image, imageSourceFromResult);
              const brokenEntry = brokenResultImages[item.id];
              const brokenReason = cardState.missing
                ? cardState.reason
                : (brokenEntry && brokenEntry.src === src ? brokenEntry.reason : "");
              const selected = selectedIds.has(item.id);
              return (
                <article
                  className={`assetCard ${quickResultReplaceTargetId === item.id ? "replaceTarget" : ""}`}
                  key={galleryItem.key}
                  onClick={() => openPreview(item)}
                  onContextMenu={(event) => openContextMenu(event, item.id)}
                  onDragOver={(event) => handleQuickResultReplaceDragOver(event, item)}
                  onDragLeave={() => setQuickResultReplaceTargetId((current) => current === item.id ? "" : current)}
                  onDrop={(event) => handleQuickResultReplaceDrop(event, item)}
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
                  <button
                    className="assetRerunButton"
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      rerunResult(item, 1);
                    }}
                    title="重刷这张结果"
                    aria-label="重刷这张结果"
                  >
                    <RefreshCw size={15} />
                  </button>
                  <button
                    className="assetDeleteButton"
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      deleteResult(item.id);
                    }}
                    title="删除这张结果"
                    aria-label="删除这张结果"
                  >
                    <Trash2 size={15} />
                  </button>
                  {item.generationMs && <div className="assetTimeBadge">用时 {formatMs(item.generationMs)}</div>}
                  {brokenReason ? (
                    <div className="assetImageFallback" title={brokenReason}>
                      <ImageOff size={26} />
                      <strong>原图已失效</strong>
                      <span>{brokenReason}</span>
                      <em>可点右上角删除按钮清理这条记录</em>
                    </div>
                  ) : (
                    <CachedImage
                      src={src}
                      alt={`生成图片 ${index + 1}`}
                      draggable
                      onDragStart={(event) => beginResultImageDrag(event, item, index)}
                      onDragEnd={clearQuickResultDragState}
                      onError={() => markResultImageBroken(item)}
                      diagnostic={{ requestId: item.requestId || item.id, endpoint: "/api/images", module: "快捷生成", placement: "quick-card" }}
                    />
                  )}
                  <ReferenceThumbTray references={item.references} count={item.referenceCount} className="assetReferenceTray" onOpen={openReferencePreview} onContextMenu={openReferenceContextMenu} onImageDragStart={beginReferenceImageDrag} />
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
            {/* 2026-09-25 UI 调整：删除悬浮框里的「图片生成 / 视频生成」页签。
                它与顶部结果栏的「全部 / 图片 / 视频」是同一功能的重复入口，
                切换逻辑和底层 setQuickMode 都保留（顶部栏仍然可以切）。 */}

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

            <DebouncedTextarea
              className="promptBox"
              value={settings.prompt}
              onChange={(value) => updateSetting("prompt", value)}
              placeholder="输入你要生成或修改的画面"
            />

            <div className="composerFooter">
              {/* 快捷悬浮框右上角功能组：与 3.0 快捷生成右上角四个功能一一对应。
                  清空图片 / 提示词助手 / 优化提示词 / 渠道价格（线路价格）四个功能
                  在本页只保留这一套入口；底部原来的同名入口已删除。 */}
              <div className="quickToolCluster" role="group" aria-label="快捷生成工具">
                <button
                  className="quickToolButton"
                  type="button"
                  title="清空图片"
                  aria-label="清空图片"
                  onClick={() => { setFiles([]); setQuickCropEditTarget(null); setQuickLocalEditTarget(null); setIsQuickChannelMenuOpen(false); }}
                >
                  <Trash2 size={15} />
                </button>
                <button
                  className="quickToolButton"
                  type="button"
                  title="提示词助手"
                  aria-label="提示词助手"
                  onClick={() => { setIsPromptAssistantOpen(true); setIsQuickChannelMenuOpen(false); }}
                >
                  <BookOpen size={15} />
                </button>
                <button
                  className="quickToolButton"
                  type="button"
                  title="优化提示词"
                  aria-label="优化提示词"
                  disabled={isQuickPromptOptimizing}
                  onClick={() => { setIsQuickChannelMenuOpen(false); void optimizePrompt(); }}
                >
                  {isQuickPromptOptimizing ? <Loader2 className="spin" size={15} /> : <Wand2 size={15} />}
                </button>
                <button
                  className={`quickToolButton channelPriceButton ${isQuickChannelMenuOpen ? "active" : ""}`}
                  type="button"
                  title={quickChannel ? `线路价格：${quickChannel.label} ${channelPriceLabel(quickChannel)}` : "线路价格：当前模型暂无可用线路"}
                  aria-label="线路价格"
                  aria-expanded={isQuickChannelMenuOpen}
                  onClick={() => setIsQuickChannelMenuOpen((current) => !current)}
                >
                  <span className="quickToolGlyph">¥</span>
                </button>

                {isQuickChannelMenuOpen && (
                  <div className="quickChannelMenu" role="menu" aria-label="线路价格菜单">
                    <div className="quickChannelMenuTitle">
                      {activeModel?.label || settings.model} 可用线路
                    </div>
                    {quickChannels.map((channel) => (
                      <button
                        key={channel.id}
                        className={`quickChannelItem ${quickChannel?.id === channel.id ? "active" : ""}`}
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          updateSetting("channelId", channel.id);
                          setIsQuickChannelMenuOpen(false);
                        }}
                      >
                        <span>{channel.label}</span>
                        <em>{channelPriceLabel(channel)}</em>
                      </button>
                    ))}
                    {quickChannels.length === 0 && (
                      <p className="quickChannelEmpty">当前模型暂无可用线路，请检查渠道目录</p>
                    )}
                  </div>
                )}
              </div>

              <div className="leftTools">
                {/* 2026-09-25 UI 调整：删除可见的「上传」和「库/素材库」按钮。
                    隐藏的 file input 与拖拽/粘贴上传能力全部保留（onPickFiles / onComposerDrop / onComposerPaste 未改动），
                    只是不再提供这两个重复入口的按钮。 */}
                <input ref={inputRef} type="file" accept="image/*" multiple onChange={onPickFiles} />
              </div>

              <div className="rightTools">
                <select value={settings.model} onChange={(event) => updateSetting("model", event.target.value)}>
                  {models.map((model) => <option key={model.value} value={model.value}>{model.label}</option>)}
                </select>
                <select value={settings.aspectRatio} onChange={(event) => updateSetting("aspectRatio", event.target.value)}>
                  {ratios.map((ratio) => <option key={ratio} value={ratio}>{ratio}</option>)}
                </select>
                <select value={settings.imageSize} onChange={(event) => updateSetting("imageSize", event.target.value)}>
                  {quickSizes.map((size) => <option key={size} value={size}>{size}</option>)}
                </select>
                <select value={settings.n} onChange={(event) => updateSetting("n", event.target.value)}>
                  {COUNT_OPTIONS.filter((count) => count <= quickMaxReferenceFiles).map((count) => (
                    <option key={count} value={count}>{count}张</option>
                  ))}
                </select>
                <button
                  className={`skillToggleButton ${settings.skillRulesEnabled ? "on" : ""}`}
                  type="button"
                  aria-pressed={settings.skillRulesEnabled}
                  title="换装：开启时自动追加换装、局部编辑、图1/图2关系等规则块；关闭时只发送你输入的原始提示词，不改模型、渠道、上传图片和请求字段"
                  onClick={() => updateSetting("skillRulesEnabled", !settings.skillRulesEnabled)}
                >
                  <span>换装</span>
                  <i aria-hidden="true"><b /></i>
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

            <div className="debugBlock">
              <span><Settings size={15} /> 连接测试</span>
              <p>只向上游请求模型清单探测连通性，<strong>不调用生图、不上传图片、不扣费</strong>，也不会显示或保存你的 API Key。</p>
              <div className="debugActions">
                <button className="smallButton" type="button" onClick={() => void runConnectionTest()} disabled={isConnectionTesting}>
                  {isConnectionTesting ? <Loader2 className="spin" size={15} /> : <PlugZap size={15} />}
                  <span>{isConnectionTesting ? "测试中…" : "连接测试"}</span>
                </button>
              </div>
              {connectionStatus && (
                <small className={`fieldHint connectionHint ${connectionState}`}>{connectionStatus}</small>
              )}
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
                {stitchItems.map(({ prompt, result }, stitchIndex) => (
                  <CachedImage
                    key={`${prompt.screen}-${result.id}`}
                    src={imageSourceFromResult(result.image)}
                    alt={`拼图第${prompt.screen}屏`}
                    draggable
                    onDragStart={(event) => beginResultImageDrag(event, result, stitchIndex)}
                    diagnostic={{ requestId: result.requestId || result.id, endpoint: "/api/images", module: "一键详情", placement: "stitch-preview" }}
                  />
                ))}
              </div>
            </div>
          </section>
        </div>
      )}

      {quickCropEditTarget && (
        <QuickCropViewportModal
          item={quickCropEditTarget}
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
                draggable
                onDragStart={(event) => beginReferenceImageDrag(event, referencePreview.items[referencePreview.index], referencePreview.index)}
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
              <img
                src={uploadPreview.url}
                alt={uploadPreview.name}
                draggable
                onDragStart={(event) => beginImageDownloadDrag(event, uploadPreview.url, uploadPreview.name || "上传图片")}
              />
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
    </ErrorBoundary>
  );
}

const appRootElement = document.getElementById("root");
const appRoot = window.__JINGYIN_REACT_ROOT__ || createRoot(appRootElement);
window.__JINGYIN_REACT_ROOT__ = appRoot;

publicReleaseStorageResetPromise.finally(() => {
  appRoot.render(<App />);
});


