import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  BookOpen,
  Brush,
  Check,
  CheckSquare,
  Crop,
  Download,
  Eye,
  EyeOff,
  FolderOpen,
  Images,
  Loader2,
  Lock,
  Maximize2,
  Minus,
  Move,
  Palette,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Save,
  Scissors,
  Search,
  Settings,
  Sparkles,
  Square,
  Trash2,
  Unlock,
  Upload,
  Video,
  Wand2,
  X
} from "lucide-react";
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
import "./outfit-workflow.css";

const STORAGE_KEY = "jingyin-outfit-workflow-settings-v1";
const TASK_HISTORY_KEY = "jingyin-outfit-workflow-task-history-v1";
const OUTFIT_PAGES_KEY = "jingyin-outfit-workflow-pages-v1";
const OUTFIT_LOCAL_DB_NAME = "jingyin-outfit-workflow-local-v1";
const OUTFIT_LOCAL_STORE = "state";
const OUTFIT_TASK_HISTORY_DB_KEY = "task-history";
const OUTFIT_DRAFT_DB_KEY = "page-draft";
const OUTFIT_RESULT_IMAGE_CACHE_PREFIX = "result-image-cache:";
const OUTFIT_TEMP_IMAGE_CACHE_PREFIX = "temp-image-cache:";
const OUTFIT_SESSION_ID = `outfit_session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const PROMPT_LIBRARY_VERSION = "v2-20260802";
const PROMPT_PRESETS_KEY = `jingyin-outfit-workflow-prompt-library-${PROMPT_LIBRARY_VERSION}`;
const PROMPT_CATEGORIES_KEY = `jingyin-outfit-workflow-prompt-categories-${PROMPT_LIBRARY_VERSION}`;
const DEFAULT_OUTFIT_PAGE_NAME = "批量生成";
const DEFAULT_BACKGROUND_CHANGE_PAGE_NAME = "换背景";
const DEFAULT_FACE_SWAP_PAGE_NAME = "批量换脸";
const DEFAULT_DESIGN_DRAFT_PAGE_NAME = "设计稿";
const DEFAULT_CUSTOM_PAGE_NAME = "临时需求";
const FACE_SWAP_DEFAULT_PROMPT = [
  "批量换脸任务：图1上传区是需要保留身体、服装、姿势、背景和构图的目标人物图，图2上传区是要迁移的人脸身份参考，图3上传区是可选补充信息。",
  "替换图1人物的脸部身份特征，并在用户需要时参考图2的发型气质、刘海方向、发缝、卷直程度和发色趋势；必须保留图1的头部位置、头部大小、脸部朝向、头颈关系、身体比例、衣服、手脚、背景、光影和画面裁切。发型只能在图1原有头部轮廓和发量范围内自然融合，不能导致头部偏移、头变大、脸中心改变或背景被大片重绘。",
  "如果图1已设置局部回贴区域，本次只生成这个局部区域，输出必须和局部区域同构图、同角度、同光影，不要输出整张图、不要扩展画布、不要添加边框；系统会把生成区域贴回原图。",
  "图2可以是一张或多张脸部/发型参考图，用于身份、五官、妆容气质和发型方向参考；不要复制图2的衣服、背景、拍摄角度、饰品或画面风格。图3不是必填，只在上传时补充妆容、表情、发型细节、年龄感、皮肤质感、客户要求或禁忌。",
  "最终结果必须像原图里真实拍出来的人物，只换脸，不换衣、不换身体、不换背景、不移动人物，不要输出对比图、拼贴图、文字、水印或标注。"
].join("\n");
const BACKGROUND_CHANGE_DEFAULT_PROMPT = [
  "批量换背景任务：图1上传区是要保留的人物图，图2上传区是统一场景图，图3上传区是可选补充信息。",
  "必须完全保持图1人物的位置、姿势、身体比例、头部大小、脸部朝向、发型、服装款式、服装颜色、服装细节、手脚姿态和人物在画面中的占比不变，方便后期 PS 贴回。",
  "只把图1人物自然放入图2场景中，让每一张结果都像同一场景里的统一摆拍，光影方向、色温、对比度、地面接触阴影、透视和整体色调必须一致。",
  "如果图1原本有背景或是透明/白底图，只提取人物主体和原服装事实，不保留图1原背景；不能改变人物衣服、姿态或重新摆拍。",
  "图3不是必填，只在上传时用于补充场景氛围、光线、色调、道具边界或客户额外要求；没有图3时不要凭空添加复杂道具、文字、水印或品牌元素。"
].join("\n");
const DESIGN_DRAFT_DEFAULT_PROMPT = [
  "参考图1上传区的实拍服装图或真人实拍服装图，将服装转换为图2上传区所参考的干净服装设计师手稿风格。图1上传区可能只有一张图，也可能有多张正面、背面、侧面或细节图；请把图1上传区的所有图片当作同一件服装的参考，综合识别服装颜色、版型、领口、袖型、袖口、下摆、长度比例、结构线、拼接方式和主要面料特点。图3上传区是可选的细节补充图，只有上传时才作为面料、袖口、裙摆、衣领、纹理或辅助线效果的补充参考；如果图3没有上传，不要强行假设图3内容。",
  "输出纯白背景的服装设计师手稿图，无人体、无模特、无场景、无衣架，画面只保留服装款式图。能从参考图中判断正反面时，优先输出服装正反面左右并排款式图；如果只有单面参考且背面信息不足，背面只能做保守、简洁、符合服装结构逻辑的合理补全，不要编造复杂设计。服装颜色以图1实拍服装为准，保留原服装的版型、廓形、领口、袖型、袖口、下摆、长度比例和主要结构。整体以黑色线稿为主，搭配极浅的米杏色淡填色，不要真实照片质感，不要复杂面料纹理，不要写实细节。",
  "线条使用手绘板绘制的服装款式图线条，外轮廓线清晰干净，起笔轻、收笔轻、中间压力重，线条两头尖、中间略粗，有自然的笔压变化和克制的手绘笔触；不要像儿童涂抹一样粗细一致、反复描边或杂乱涂抹。内部结构线、领口线、袖口线、下摆线、衣身分割线使用更细的线，线条稳定、准确、干净。",
  "服装所有轮廓转角、袖口四角、下摆边角、接缝拐点位置，点缀极短的浅灰色纤细定位短线。短线只停留在拐点外侧，短小零散，不要长贯穿线条；线条浅淡但要比普通起稿痕迹略明显，明度低于黑色衣身轮廓线，是设计师手稿里的拐点定位辅助短线，不杂乱、不延伸。",
  "面料质感只用非常少量的简化材质符号和浅淡铅笔排线暗示，抓住面料特点即可，不出现真实照片级织物细节，不出现复杂编织纹理，不出现杂乱涂抹线。整体像服装打版师、设计师用手绘板画出来的产品工艺手稿，结构清楚、比例准确、线条干净、有轻微手写压感但不凌乱。"
].join("\n");
const MAX_UPLOAD_IMAGES = 10;
const IMAGE_SIZES = ["1K", "2K", "4K"];
const GENERATION_COUNT_OPTIONS = ["auto", ...Array.from({ length: MAX_UPLOAD_IMAGES }, (_, index) => index + 1)];
const CHANNEL_UPLOAD_LIMIT_BYTES = 4 * 1024 * 1024;
const CHANNEL_UPLOAD_TARGET_BYTES = 3.75 * 1024 * 1024;
const CHANNEL_UPLOAD_MAX_SIDE = 3072;
const DEFAULT_MODELS = [
  { value: "gpt-image", label: "GPT2", ratios: ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "5:4", "4:5", "21:9"] },
  { value: "nano-banana-pro", label: "香蕉 Pro", ratios: ["1:1", "16:9", "9:16", "4:3", "3:4"] },
  { value: "nano-banana2", label: "香蕉 2", ratios: ["1:1", "16:9", "9:16", "4:3", "3:4", "1:4", "4:1", "1:8", "8:1"] },
  { value: "nano-banana", label: "香蕉", ratios: ["1:1", "16:9", "9:16", "4:3", "3:4"] }
];

const PREPROCESS_OPTIONS = [
  { value: "crop", label: "手动裁剪" },
  { value: "pad", label: "白底补边" },
  { value: "soft", label: "柔和补边" },
  { value: "original", label: "原图" }
];
const DEFAULT_PREPROCESS_MODE = "original";
const BATCH_LOCAL_EDIT_RATIOS = ["1:1", "3:4"];
const GARMENT_PART_OPTIONS = [
  { value: "upper", label: "上衣" },
  { value: "lower", label: "下装" },
  { value: "shoes", label: "鞋子" }
];
const DEFAULT_GARMENT_PARTS = ["upper", "lower"];
const GARMENT_LENGTH_OPTIONS = [
  { value: "", label: "不触发" },
  { value: "reference", label: "按图2原长度" },
  { value: "waist", label: "到腰线" },
  { value: "below-waist", label: "到腰下" },
  { value: "upper-hip", label: "到臀上" },
  { value: "cover-hip", label: "遮臀" },
  { value: "mid-thigh", label: "到大腿中段" },
  { value: "above-knee", label: "到膝上" },
  { value: "knee", label: "到膝盖" },
  { value: "below-knee", label: "到膝下" },
  { value: "mid-calf", label: "到小腿中段" },
  { value: "ankle", label: "到脚踝" },
  { value: "floor", label: "拖地" }
];
const DEFAULT_GARMENT_LENGTHS = { upper: "", lower: "" };

const BATCH_RATIO_OPTIONS = ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "5:4", "4:5", "21:9"];
const RESIZE_RESOLUTION_OPTIONS = [
  { value: "custom", label: "自定义" },
  { value: "1K", label: "1K" },
  { value: "2K", label: "2K" },
  { value: "4K", label: "4K" }
];
const RESIZE_RESOLUTION_MAP = {
  "1K": 1024,
  "2K": 2304,
  "4K": 4096
};
const RESIZE_FILL_OPTIONS = [
  { value: "#ffffff", label: "白" },
  { value: "#000000", label: "黑" }
];
const RESIZE_SETTINGS_KEY = "jingyin-outfit-workflow-resize-settings-v3";
const RESIZE_BATCH_CROP_KEY = "jingyin-outfit-workflow-resize-batch-crop-v1";
const RESIZE_OUTPUT_FOLDER = "原图改尺寸";
const LOCAL_DETAIL_OUTPUT_FOLDER = "局部细节";
const DEFAULT_UPLOAD_LABELS = {
  model: {
    title: "带场景模特图",
    hint: "上传完整模特和场景底图；批量时按左到右顺序逐张生成。"
  },
  clothing: {
    title: "服装/产品图",
    hint: "可上传模特穿着图或平铺产品图；后台只抽取服装款式和细节。"
  },
  reference: {
    title: "参考图/物品图",
    hint: "可选；只做物品、配饰、场景或调性参考，不替代图2服装。"
  }
};
const CUSTOM_UPLOAD_LABELS = {
  model: {
    title: "图1",
    hint: "上传本次临时需求的图1，可按需求使用裁剪或局部回贴。"
  },
  clothing: {
    title: "图2",
    hint: "上传本次临时需求的图2。"
  },
  reference: {
    title: "图3",
    hint: "可选；上传补充参考图或额外要求。"
  }
};
const BACKGROUND_CHANGE_UPLOAD_LABELS = {
  model: {
    title: "人物图/模特图",
    hint: "批量上传要保留的人物；位置、姿势、比例、服装和主体占比都要锁定不变。"
  },
  clothing: {
    title: "统一场景图",
    hint: "上传一张目标场景；批量人物都放进同一场景，光影色调和透视要统一。"
  },
  reference: {
    title: "补充参考图",
    hint: "可选；补充场景氛围、光线、色调、道具边界或本次客户要求。"
  }
};
const FACE_SWAP_UPLOAD_LABELS = {
  model: {
    title: "目标人物图",
    hint: "批量上传要换脸的原图；身体、衣服、姿势、背景和构图都要保留，建议在脸部位置使用局部回贴。"
  },
  clothing: {
    title: "人脸参考图",
    hint: "上传要替换进去的人脸身份参考；可固定一张，也可按顺序/循环匹配，后台只提取脸部身份特征。"
  },
  reference: {
    title: "妆容/表情补充图",
    hint: "可选；补充妆容、表情、年龄感、皮肤质感、客户要求或禁忌，不上传时不强行添加。"
  }
};
const DESIGN_DRAFT_UPLOAD_LABELS = {
  model: {
    title: "实拍服装图/真人实拍图",
    hint: "上传单张或多张实拍参考；正反面、侧面会合并识别为同一件服装。"
  },
  clothing: {
    title: "手稿风格参考图",
    hint: "上传设计稿或手稿样式参考；用于笔触、线条、淡填色和拐点短线风格。"
  },
  reference: {
    title: "细节/手稿补充图",
    hint: "可选；补充面料、袖口、裙摆、衣领、纹理或辅助短线效果。"
  }
};
const DEFAULT_RESIZE_SETTINGS = {
  ratio: "3:4",
  longEdge: 2304,
  resolution: "2K",
  fitMode: "pad",
  fillColor: "#ffffff",
  cropMode: "batch"
};

const OUTFIT_DEFAULT_PROMPT = [
  "让图1当前人物穿着图2服装，生成自然干净的电商成片。",
  "图1负责人物和画面事实：保留身份、发型、头部位置、身材比例、姿势、手脚动作、镜头、背景、光影和画面位置。",
  "图2是唯一服装标准：保留款式、版型、长度、松量、颜色、面料、领口、袖口、下摆、扣子、拉链、拼接、里衬/网纱层次等关键细节。",
  "图3只做可选补充，不替代图2。只做真实穿着适配，不按模型审美把图2改短、收腰、修身、瘦身、重设计或简化细节。"
].join("\n");

const PROMPT_BUILTIN_PRESETS = [
  {
    id: "outfit-keep",
    title: "换装保结构",
    category: "常用",
    content: OUTFIT_DEFAULT_PROMPT
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
    id: "detail-lock",
    title: "细节锁定",
    category: "常用",
    content: "重点锁定图2服装的面料纹理、领口、袖口、扣子、拼接线、褶皱、内衬、网纱/蕾丝外层和内里长度差，确保批量结果细节一致，避免衣长漂移、版型变修身、腰身松量变化、错位和材质漂移。"
  },
  {
    id: "soft-pad",
    title: "背景边缘扩充",
    category: "常用",
    content: "只扩充或裁剪画布边缘来匹配目标比例，人物/主体的站位、中心、大小和构图重心必须保持原图不偏移；扩展区域从原图背景边缘自然填充，不要移动、重绘或替换主体。"
  },
  {
    id: "batch-copy",
    title: "批量复刻",
    category: "批量复刻",
    content: "保持同一批结果在人物风格、镜头、布光、构图和商品表现上统一，只允许在目标内容上做必要替换，其他部分尽量一致。"
  },
  {
    id: "batch-sku",
    title: "批量SKU",
    category: "批量sku",
    content: "批量生成同一商品的不同SKU画面时，统一电商调性、背景洁净、主体清晰，颜色和款式切换准确，避免无关变化。"
  },
  {
    id: "partial-migrate",
    title: "局部迁移",
    category: "局部迁移",
    content: "仅迁移指定局部信息，其余区域保持原图结构和风格稳定，避免整体被重绘成新的风格。"
  }
];

const THEME_OPTIONS = [
  { value: "dark", label: "暗夜", colors: ["#080910", "#151522", "#10cfc4"] },
  { value: "jade", label: "柔粉", colors: ["#fff2f7", "#fffafd", "#ec6f9e"] },
  { value: "graphite", label: "米杏", colors: ["#f3e6d4", "#fff8ec", "#c98652"] },
  { value: "mist", label: "浅雾", colors: ["#f5f7fa", "#ffffff", "#0d7a76"] }
];

const PROMPT_PRESET_GROUPS = [
  {
    category: "常用",
    presets: [
      {
        title: "标准换装",
        content: "让图1人物穿着图2服装，保留人物脸部、身材比例和自然姿态，服装版型、颜色、材质、领口、袖口、纽扣、腰线和长度准确自然。"
      },
      {
        title: "电商主图",
        content: "生成一张干净高级的电商主图，人物和服装占画面主体，背景简洁，光线柔和，服装边缘贴合自然，避免拼接感、过曝和廉价滤镜。"
      },
      {
        title: "白底展示",
        content: "输出白底或浅灰干净背景，模特自然站姿，完整展示服装正面穿着效果，保持衣服真实版型、颜色和细节，不改变人物五官和身材比例。"
      }
    ]
  },
  {
    category: "细节锁定",
    presets: [
      {
        title: "面料纹理",
        content: "重点锁定图2服装的面料纹理、厚薄、垂感、光泽和褶皱逻辑，穿到图1人物身上后保持真实服装质感，不能变成塑料感或糊成一片。"
      },
      {
        title: "版型结构",
        content: "严格保留图2服装的版型结构，包括领型、肩线、袖长、腰线、下摆长度、扣子位置和拼接结构，避免错领、错袖、错扣和比例变形。"
      },
      {
        title: "蕾丝双层",
        content: "如果图2是蕾丝、网纱、假两件或内外双层结构，必须保留外层纹理和内层布面/内衬的层次关系，不能合并成单层布料。"
      },
      {
        title: "鞋包配饰",
        content: "保留图1人物原有姿态和适合画面的鞋包配饰，只让服装替换为图2款式；无关品牌标识、水印和文字不要进入最终画面。"
      }
    ]
  },
  {
    category: "构图光线",
    presets: [
      {
        title: "全身海报",
        content: "全身构图，人物从头到脚完整入画，鞋子和下摆不能被裁掉，四周留出自然呼吸空间，适合女装海报和电商详情首屏。"
      },
      {
        title: "柔光质感",
        content: "使用柔和四面补光，低反差，无生硬黑影，突出衣服轮廓、面料纹理和高级质感，背景干净真实，不要过曝。"
      },
      {
        title: "轻场景",
        content: "场景为简约室内、白墙建筑、浅色咖啡馆或干净街拍氛围，场景只服务服装展示，避免繁杂道具和网红打卡感。"
      }
    ]
  }
];

const PROMPT_CATEGORIES = ["全部", ...new Set([
  ...PROMPT_PRESET_GROUPS.map((group) => group.category),
  ...PROMPT_BUILTIN_PRESETS.map((preset) => preset.category)
])];

const BUILTIN_PROMPT_LIBRARY = [
  ...PROMPT_BUILTIN_PRESETS,
  ...PROMPT_PRESET_GROUPS.flatMap((group, groupIndex) => group.presets.map((preset, presetIndex) => ({
    id: `legacy_${groupIndex}_${presetIndex}`,
    title: preset.title,
    category: group.category,
    content: preset.content
  })))
];

function shouldRepairOutfitPrompt(prompt) {
  const text = String(prompt || "").trim();
  if (!text) return true;
  if (/补齐画布|背景从原图氛围自然延展|不要引入新的主体元素/.test(text)) return true;
  if (/让图1模特穿着图2服装，图1模特的样貌[\s\S]*不优化图2服装款式/.test(text)) return true;
  if (/必须让图1人物穿着图2服装。保持图1模特[\s\S]*手脚位置[\s\S]*不优化、重设计/.test(text)) return true;
  if (/批量换装任务：图1是当前模特图[\s\S]*图2服装是唯一换装标准[\s\S]*不优化、重设计或简化图2服装款式/.test(text)) return true;
  return false;
}

function normalizeSmartIntervention(value) {
  if (value === true) return true;
  if (value === false) return false;
  const text = String(value ?? "false").trim().toLowerCase();
  return ["1", "true", "on", "smart", "智能", "开启"].includes(text);
}

function normalizeGarmentParts(value) {
  const raw = Array.isArray(value) ? value : String(value || "").split(/[,\s|，、]+/);
  const next = GARMENT_PART_OPTIONS
    .map((option) => option.value)
    .filter((part) => raw.includes(part));
  return next.length > 0 ? next : DEFAULT_GARMENT_PARTS;
}

function normalizeGarmentLengths(value = {}, garmentParts = DEFAULT_GARMENT_PARTS) {
  const allowed = new Set(GARMENT_LENGTH_OPTIONS.map((option) => option.value));
  const parts = normalizeGarmentParts(garmentParts);
  const next = {
    upper: allowed.has(value?.upper) ? value.upper : "",
    lower: allowed.has(value?.lower) ? value.lower : ""
  };
  if (!parts.includes("upper")) next.upper = "";
  if (!parts.includes("lower")) next.lower = "";
  return next;
}

const defaultSettings = {
  apiKey: "",
  model: "gpt-image",
  aspectRatio: "3:4",
  imageSize: "2K",
  concurrency: 3,
  generationCount: "auto",
  smartIntervention: false,
  garmentParts: DEFAULT_GARMENT_PARTS,
  garmentLengths: DEFAULT_GARMENT_LENGTHS,
  pairingMode: "fixed",
  preprocessMode: DEFAULT_PREPROCESS_MODE,
  theme: "dark",
  prompt: OUTFIT_DEFAULT_PROMPT,
  productNote: ""
};

function readSettings() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null") || {};
    const settings = { ...defaultSettings, ...stored };
    if (shouldRepairOutfitPrompt(settings.prompt)) settings.prompt = OUTFIT_DEFAULT_PROMPT;
    settings.generationCount = normalizeGenerationCount(settings.generationCount);
    settings.smartIntervention = normalizeSmartIntervention(settings.smartIntervention);
    settings.garmentParts = normalizeGarmentParts(settings.garmentParts);
    settings.garmentLengths = normalizeGarmentLengths(settings.garmentLengths, settings.garmentParts);
    settings.preprocessMode = DEFAULT_PREPROCESS_MODE;
    return settings;
  } catch {
    return defaultSettings;
  }
}

function normalizeOutfitPageName(value, fallback = DEFAULT_OUTFIT_PAGE_NAME) {
  const name = String(value || "").replace(/\s+/g, " ").trim();
  if (name === "批量AI换装") return DEFAULT_OUTFIT_PAGE_NAME;
  return (name || fallback).slice(0, 18);
}

function isBackgroundChangePageName(value) {
  return /换背景|換背景|背景更换|背景替换|换场景|換場景|场景图|统一场景/i.test(String(value || ""));
}

function isDesignDraftPageName(value) {
  return /设计稿|設計稿|design/i.test(String(value || ""));
}

function isFaceSwapPageName(value) {
  return /批量换脸|换脸|人脸|脸部|face\s*swap/i.test(String(value || ""));
}

function isCustomWorkflowPageName(value) {
  return /临时需求|自定义需求|批量需求|custom/i.test(String(value || ""));
}

function defaultUploadLabelsForPage(name) {
  if (isDesignDraftPageName(name)) return DESIGN_DRAFT_UPLOAD_LABELS;
  if (isFaceSwapPageName(name)) return FACE_SWAP_UPLOAD_LABELS;
  if (isBackgroundChangePageName(name)) return BACKGROUND_CHANGE_UPLOAD_LABELS;
  if (isCustomWorkflowPageName(name)) return CUSTOM_UPLOAD_LABELS;
  return DEFAULT_UPLOAD_LABELS;
}

function defaultPromptForWorkflowMode(mode) {
  if (mode === "design-draft") return DESIGN_DRAFT_DEFAULT_PROMPT;
  if (mode === "face-swap") return FACE_SWAP_DEFAULT_PROMPT;
  if (mode === "background-change") return BACKGROUND_CHANGE_DEFAULT_PROMPT;
  if (mode === "custom") return "";
  return OUTFIT_DEFAULT_PROMPT;
}

function workflowModeFromPage(pageName, uploadLabels) {
  const modelTitle = String(uploadLabels?.model?.title || "");
  const clothingTitle = String(uploadLabels?.clothing?.title || "");
  const referenceTitle = String(uploadLabels?.reference?.title || "");
  const text = [pageName, modelTitle, clothingTitle, referenceTitle].join(" ");
  if (isCustomWorkflowPageName(pageName)) {
    return "custom";
  }
  if (isFaceSwapPageName(text) || /目标人物图|人脸参考图|妆容|表情|脸部身份/.test(text)) {
    return "face-swap";
  }
  if (isDesignDraftPageName(text) || /设计稿|設計稿|design|实拍服装|真人实拍|细节补充/.test(text)) {
    return "design-draft";
  }
  const explicitBackgroundPage = isBackgroundChangePageName(pageName) || isBackgroundChangePageName(clothingTitle);
  const backgroundLabelPair = /人物图|人物照|人物|模特图|模特/i.test(modelTitle)
    && /统一场景|场景图|目标场景|背景图|换背景|背景/i.test(clothingTitle);
  if (explicitBackgroundPage || backgroundLabelPair || /PS贴回/i.test(text)) {
    return "background-change";
  }
  return "outfit";
}

function normalizeUploadLabelText(value, fallback, limit = 80) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return (text || fallback).slice(0, limit);
}

function normalizeUploadLabels(value = {}, pageName = DEFAULT_OUTFIT_PAGE_NAME) {
  const defaults = defaultUploadLabelsForPage(pageName);
  return Object.fromEntries(["model", "clothing", "reference"].map((key) => {
    const current = value?.[key] || {};
    return [key, {
      title: normalizeUploadLabelText(current.title, defaults[key].title, 36),
      hint: normalizeUploadLabelText(current.hint, defaults[key].hint, 140)
    }];
  }));
}

function sameUploadLabels(left, right) {
  const normalizedLeft = normalizeUploadLabels(left);
  const normalizedRight = normalizeUploadLabels(right);
  return ["model", "clothing", "reference"].every((key) => (
    normalizedLeft[key].title === normalizedRight[key].title
    && normalizedLeft[key].hint === normalizedRight[key].hint
  ));
}

function inferOutfitWorkflowMode(pageName, uploadLabels) {
  return workflowModeFromPage(pageName, uploadLabels);
}

function normalizeOutfitPageSettings(value = {}, options = {}) {
  const settings = { ...defaultSettings, ...(value || {}) };
  if (!(options.allowEmptyPrompt && !String(settings.prompt || "").trim()) && shouldRepairOutfitPrompt(settings.prompt)) {
    settings.prompt = OUTFIT_DEFAULT_PROMPT;
  }
  settings.generationCount = normalizeGenerationCount(settings.generationCount);
  settings.smartIntervention = normalizeSmartIntervention(settings.smartIntervention);
  settings.garmentParts = normalizeGarmentParts(settings.garmentParts);
  settings.garmentLengths = normalizeGarmentLengths(settings.garmentLengths, settings.garmentParts);
  settings.theme = normalizeTheme(settings.theme);
  settings.apiKey = normalizeApiKeyInput(settings.apiKey);
  settings.preprocessMode = DEFAULT_PREPROCESS_MODE;
  return settings;
}

function stripOutfitPageGlobalSettings(value = {}, options = {}) {
  const next = normalizeOutfitPageSettings(value, options);
  const { apiKey, theme, preprocessMode, ...pageSettings } = next;
  return pageSettings;
}

function mergeOutfitPageSettings(pageSettings = {}, currentSettings = readSettings(), options = {}) {
  const next = normalizeOutfitPageSettings({ ...currentSettings, ...(pageSettings || {}) }, options);
  return {
    ...next,
    apiKey: currentSettings.apiKey || "",
    theme: normalizeTheme(currentSettings.theme)
  };
}

function makeOutfitPage(name = DEFAULT_OUTFIT_PAGE_NAME, patch = {}) {
  const pageName = normalizeOutfitPageName(name || patch.name, DEFAULT_OUTFIT_PAGE_NAME);
  const allowEmptyPrompt = patch.allowEmptyPrompt || inferOutfitWorkflowMode(pageName, patch.uploadLabels || {}) === "custom";
  return {
    id: String(patch.id || makeId("outfit_page")),
    name: pageName,
    deleteLocked: Boolean(patch.deleteLocked),
    settings: stripOutfitPageGlobalSettings(patch.settings || readSettings(), { allowEmptyPrompt }),
    modelImages: Array.isArray(patch.modelImages) ? patch.modelImages : [],
    clothingImages: Array.isArray(patch.clothingImages) ? patch.clothingImages : [],
    referenceImages: Array.isArray(patch.referenceImages) ? patch.referenceImages : [],
    fixedClothingId: String(patch.fixedClothingId || ""),
    tasks: Array.isArray(patch.tasks) ? patch.tasks : [],
    originalLibrary: Array.isArray(patch.originalLibrary) ? patch.originalLibrary : [],
    activeUploadGroup: patch.activeUploadGroup || "model",
    uploadLabels: normalizeUploadLabels(patch.uploadLabels || {}, pageName)
  };
}

function makeDesignDraftPage(baseSettings = readSettings(), patch = {}) {
  return makeOutfitPage(DEFAULT_DESIGN_DRAFT_PAGE_NAME, {
    deleteLocked: true,
    ...patch,
    settings: {
      ...baseSettings,
      prompt: DESIGN_DRAFT_DEFAULT_PROMPT,
      productNote: "",
      smartIntervention: false,
      ...(patch.settings || {})
    },
    uploadLabels: patch.uploadLabels || DESIGN_DRAFT_UPLOAD_LABELS
  });
}

function makeBackgroundChangePage(baseSettings = readSettings(), patch = {}) {
  return makeOutfitPage(DEFAULT_BACKGROUND_CHANGE_PAGE_NAME, {
    deleteLocked: true,
    ...patch,
    settings: {
      ...baseSettings,
      prompt: BACKGROUND_CHANGE_DEFAULT_PROMPT,
      productNote: "",
      smartIntervention: false,
      ...(patch.settings || {})
    },
    uploadLabels: patch.uploadLabels || BACKGROUND_CHANGE_UPLOAD_LABELS
  });
}

function makeFaceSwapPage(baseSettings = readSettings(), patch = {}) {
  return makeOutfitPage(DEFAULT_FACE_SWAP_PAGE_NAME, {
    deleteLocked: true,
    ...patch,
    settings: {
      ...baseSettings,
      prompt: FACE_SWAP_DEFAULT_PROMPT,
      productNote: "",
      smartIntervention: false,
      pairingMode: "fixed",
      ...(patch.settings || {})
    },
    uploadLabels: patch.uploadLabels || FACE_SWAP_UPLOAD_LABELS
  });
}

function ensureWorkflowPages(pages = [], baseSettings = readSettings()) {
  const nextPages = Array.isArray(pages) ? pages.filter(Boolean) : [];
  const hasBackgroundChangePage = nextPages.some((page) => inferOutfitWorkflowMode(page.name, page.uploadLabels) === "background-change");
  const hasFaceSwapPage = nextPages.some((page) => inferOutfitWorkflowMode(page.name, page.uploadLabels) === "face-swap");
  const hasDesignDraftPage = nextPages.some((page) => inferOutfitWorkflowMode(page.name, page.uploadLabels) === "design-draft");

  let output = nextPages;
  if (!hasBackgroundChangePage) {
    const designIndex = output.findIndex((page) => inferOutfitWorkflowMode(page.name, page.uploadLabels) === "design-draft");
    const backgroundPage = makeBackgroundChangePage(baseSettings);
    output = designIndex >= 0
      ? [...output.slice(0, designIndex), backgroundPage, ...output.slice(designIndex)]
      : [...output, backgroundPage];
  }

  if (!hasFaceSwapPage) {
    const designIndex = output.findIndex((page) => inferOutfitWorkflowMode(page.name, page.uploadLabels) === "design-draft");
    const faceSwapPage = makeFaceSwapPage(baseSettings);
    output = designIndex >= 0
      ? [...output.slice(0, designIndex), faceSwapPage, ...output.slice(designIndex)]
      : [...output, faceSwapPage];
  }

  if (!hasDesignDraftPage) {
    output = [...output, makeDesignDraftPage(baseSettings)];
  }

  return output;
}

function serializeOutfitPage(page) {
  const pageName = normalizeOutfitPageName(page?.name, DEFAULT_OUTFIT_PAGE_NAME);
  const allowEmptyPrompt = inferOutfitWorkflowMode(pageName, page?.uploadLabels || {}) === "custom";
  return {
    id: String(page?.id || makeId("outfit_page")),
    name: pageName,
    deleteLocked: Boolean(page?.deleteLocked),
    settings: stripOutfitPageGlobalSettings(page?.settings || {}, { allowEmptyPrompt }),
    uploadLabels: normalizeUploadLabels(page?.uploadLabels || {}, pageName)
  };
}

function readOutfitPages() {
  const baseSettings = readSettings();
  const stored = readJsonStorage(OUTFIT_PAGES_KEY, null);
  if (Array.isArray(stored) && stored.length > 0) {
    const pages = stored.map((page, index) => makeOutfitPage(
      page?.name || (index === 0 ? DEFAULT_OUTFIT_PAGE_NAME : `批量需求 ${index + 1}`),
      {
        ...page,
        settings: { ...baseSettings, ...(page?.settings || {}) },
        tasks: index === 0 ? readTaskHistory() : []
      }
    ));
    if (pages.length > 0) return ensureWorkflowPages(pages, baseSettings);
  }
  return ensureWorkflowPages([
    makeOutfitPage(DEFAULT_OUTFIT_PAGE_NAME, { settings: baseSettings, tasks: readTaskHistory() })
  ], baseSettings);
}

function pickInitialOutfitPage(pages = []) {
  const list = Array.isArray(pages) ? pages.filter(Boolean) : [];
  return list.find((page) => inferOutfitWorkflowMode(page.name, page.uploadLabels) === "outfit")
    || list.find((page) => inferOutfitWorkflowMode(page.name, page.uploadLabels) === "background-change")
    || list.find((page) => inferOutfitWorkflowMode(page.name, page.uploadLabels) === "design-draft")
    || list[0]
    || makeOutfitPage(DEFAULT_OUTFIT_PAGE_NAME);
}

function normalizeTheme(value) {
  return THEME_OPTIONS.some((theme) => theme.value === value) ? value : defaultSettings.theme;
}

function themeToVars(theme) {
  const palette = {
    dark: {
      appBg: "#07090d",
      shellBg: "#0b0d14",
      sidebarBg: "rgba(12, 13, 20, 0.92)",
      topbarBg: "rgba(7, 9, 13, 0.88)",
      panelBg: "rgba(255, 255, 255, 0.045)",
      panelStrongBg: "rgba(255, 255, 255, 0.055)",
      inputBg: "rgba(255, 255, 255, 0.06)",
      buttonBg: "rgba(255, 255, 255, 0.055)",
      border: "rgba(255, 255, 255, 0.1)",
      text: "#eef4f5",
      textSoft: "#93a0aa",
      accent: "#1fcfc3",
      accentText: "#061515",
      accentBorder: "#1fcfc3",
      danger: "#ffb3b3",
      optionBg: "#141821"
    },
    jade: {
      appBg: "#fff5f9",
      shellBg: "#fff1f6",
      sidebarBg: "rgba(255, 242, 247, 0.96)",
      topbarBg: "rgba(255, 248, 251, 0.94)",
      panelBg: "rgba(255, 255, 255, 0.72)",
      panelStrongBg: "rgba(255, 255, 255, 0.82)",
      inputBg: "rgba(255, 255, 255, 0.85)",
      buttonBg: "rgba(255, 255, 255, 0.8)",
      border: "rgba(236, 111, 158, 0.18)",
      text: "#35212a",
      textSoft: "#8d7280",
      accent: "#ec6f9e",
      accentText: "#ffffff",
      accentBorder: "#ec6f9e",
      danger: "#cf5b79",
      optionBg: "#fff7fb"
    },
    graphite: {
      appBg: "#fcf4e7",
      shellBg: "#f6ebdb",
      sidebarBg: "rgba(249, 239, 226, 0.96)",
      topbarBg: "rgba(252, 246, 236, 0.94)",
      panelBg: "rgba(255, 251, 244, 0.82)",
      panelStrongBg: "rgba(255, 252, 247, 0.9)",
      inputBg: "rgba(255, 255, 255, 0.88)",
      buttonBg: "rgba(255, 255, 255, 0.82)",
      border: "rgba(201, 134, 82, 0.18)",
      text: "#3b2d22",
      textSoft: "#907561",
      accent: "#c98652",
      accentText: "#ffffff",
      accentBorder: "#c98652",
      danger: "#b86c4b",
      optionBg: "#fffaf3"
    },
    mist: {
      appBg: "#eef5f7",
      shellBg: "#f6fbfc",
      sidebarBg: "rgba(245, 249, 250, 0.96)",
      topbarBg: "rgba(248, 251, 252, 0.94)",
      panelBg: "rgba(255, 255, 255, 0.82)",
      panelStrongBg: "rgba(255, 255, 255, 0.92)",
      inputBg: "rgba(255, 255, 255, 0.88)",
      buttonBg: "rgba(255, 255, 255, 0.82)",
      border: "rgba(13, 122, 118, 0.16)",
      text: "#1f3132",
      textSoft: "#6e8082",
      accent: "#0d7a76",
      accentText: "#ffffff",
      accentBorder: "#0d7a76",
      danger: "#c65d5d",
      optionBg: "#f7fbfc"
    }
  };
  return palette[normalizeTheme(theme)] || palette.dark;
}

function buildPromptPresetMap() {
  const map = new Map();
  for (const group of PROMPT_PRESET_GROUPS) {
    for (const preset of group.presets) {
      map.set(preset.title, preset.content);
    }
  }
  return map;
}

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

function openOutfitLocalDb() {
  if (typeof window === "undefined" || !window.indexedDB) return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const request = window.indexedDB.open(OUTFIT_LOCAL_DB_NAME, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(OUTFIT_LOCAL_STORE)) {
          db.createObjectStore(OUTFIT_LOCAL_STORE, { keyPath: "key" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function outfitLocalGet(key, fallback = null) {
  const db = await openOutfitLocalDb();
  if (!db) return fallback;
  return new Promise((resolve) => {
    try {
      const transaction = db.transaction(OUTFIT_LOCAL_STORE, "readonly");
      const store = transaction.objectStore(OUTFIT_LOCAL_STORE);
      const request = store.get(key);
      request.onsuccess = () => resolve(request.result?.value ?? fallback);
      request.onerror = () => resolve(fallback);
      transaction.oncomplete = () => db.close();
      transaction.onerror = () => db.close();
      transaction.onabort = () => db.close();
    } catch {
      try {
        db.close();
      } catch {}
      resolve(fallback);
    }
  });
}

async function outfitLocalSet(key, value) {
  const db = await openOutfitLocalDb();
  if (!db) return false;
  return new Promise((resolve) => {
    try {
      const transaction = db.transaction(OUTFIT_LOCAL_STORE, "readwrite");
      const store = transaction.objectStore(OUTFIT_LOCAL_STORE);
      store.put({ key, value, updatedAt: Date.now() });
      transaction.oncomplete = () => {
        db.close();
        resolve(true);
      };
      transaction.onerror = () => {
        db.close();
        resolve(false);
      };
      transaction.onabort = () => {
        db.close();
        resolve(false);
      };
    } catch {
      try {
        db.close();
      } catch {}
      resolve(false);
    }
  });
}

async function outfitLocalDelete(key) {
  const db = await openOutfitLocalDb();
  if (!db) return false;
  return new Promise((resolve) => {
    try {
      const transaction = db.transaction(OUTFIT_LOCAL_STORE, "readwrite");
      const store = transaction.objectStore(OUTFIT_LOCAL_STORE);
      store.delete(key);
      transaction.oncomplete = () => {
        db.close();
        resolve(true);
      };
      transaction.onerror = () => {
        db.close();
        resolve(false);
      };
      transaction.onabort = () => {
        db.close();
        resolve(false);
      };
    } catch {
      try {
        db.close();
      } catch {}
      resolve(false);
    }
  });
}

async function outfitLocalDeleteByPrefix(prefix) {
  const db = await openOutfitLocalDb();
  if (!db) return 0;
  return new Promise((resolve) => {
    let deleted = 0;
    try {
      const transaction = db.transaction(OUTFIT_LOCAL_STORE, "readwrite");
      const store = transaction.objectStore(OUTFIT_LOCAL_STORE);
      const request = store.openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        const key = String(cursor.key || "");
        if (key.startsWith(prefix)) {
          cursor.delete();
          deleted += 1;
        }
        cursor.continue();
      };
      transaction.oncomplete = () => {
        db.close();
        resolve(deleted);
      };
      transaction.onerror = () => {
        db.close();
        resolve(deleted);
      };
      transaction.onabort = () => {
        db.close();
        resolve(deleted);
      };
    } catch {
      try {
        db.close();
      } catch {}
      resolve(deleted);
    }
  });
}

function clampResizeEdge(value) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return DEFAULT_RESIZE_SETTINGS.longEdge;
  return Math.max(256, Math.min(8192, number));
}

function normalizeResizeSettings(settings = {}) {
  const next = { ...DEFAULT_RESIZE_SETTINGS, ...(settings || {}) };
  if (!BATCH_RATIO_OPTIONS.includes(next.ratio)) next.ratio = DEFAULT_RESIZE_SETTINGS.ratio;
  if (!RESIZE_RESOLUTION_OPTIONS.some((option) => option.value === next.resolution)) {
    next.resolution = DEFAULT_RESIZE_SETTINGS.resolution;
  }
  next.longEdge = clampResizeEdge(next.longEdge);
  next.fitMode = ["pad", "crop", "original-size"].includes(next.fitMode) ? next.fitMode : "pad";
  next.fillColor = RESIZE_FILL_OPTIONS.some((option) => option.value === next.fillColor) ? next.fillColor : "#ffffff";
  next.cropMode = next.cropMode === "individual" ? "individual" : "batch";
  if (next.resolution !== "custom") {
    next.longEdge = RESIZE_RESOLUTION_MAP[next.resolution] || next.longEdge;
  }
  return next;
}

function readResizeSettings() {
  return normalizeResizeSettings(readJsonStorage(RESIZE_SETTINGS_KEY, null));
}

function resolveResizeLongEdge(settings) {
  const normalized = normalizeResizeSettings(settings);
  return normalized.resolution === "custom"
    ? clampResizeEdge(normalized.longEdge)
    : RESIZE_RESOLUTION_MAP[normalized.resolution] || normalized.longEdge;
}

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

function loadPromptPresets() {
  const builtins = BUILTIN_PROMPT_LIBRARY.map(normalizePromptPreset).filter((preset) => preset.content);
  const stored = readJsonStorage(PROMPT_PRESETS_KEY, null);
  if (Array.isArray(stored) && stored.length > 0) {
    const builtinsById = new Map(builtins.map((preset) => [preset.id, preset]));
    const seenIds = new Set();
    const merged = stored.map(normalizePromptPreset).filter((preset) => preset.content).map((preset) => {
      seenIds.add(preset.id);
      const builtin = builtinsById.get(preset.id);
      if (!builtin || preset.custom) return preset;
      return {
        ...preset,
        title: builtin.title,
        content: builtin.content,
        custom: false
      };
    });
    builtins.forEach((preset) => {
      if (!seenIds.has(preset.id)) merged.push(preset);
    });
    return merged;
  }
  return builtins;
}

function loadPromptCategories() {
  const storedCategories = readJsonStorage(PROMPT_CATEGORIES_KEY, null);
  const storedPrompts = readJsonStorage(PROMPT_PRESETS_KEY, null) || [];
  const presetCategories = Array.isArray(storedPrompts)
    ? storedPrompts.map((preset) => preset?.category)
    : [];
  const base = Array.isArray(storedCategories) && storedCategories.length > 0
    ? ["全部", ...storedCategories]
    : PROMPT_CATEGORIES;
  return normalizePromptCategories([...base, ...presetCategories]);
}

function makeId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function ratioParts(ratio) {
  const [w, h] = String(ratio || "3:4").split(":").map((part) => Number.parseFloat(part));
  return Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0 ? { w, h, value: w / h } : { w: 3, h: 4, value: 3 / 4 };
}

function fileSize(bytes) {
  if (!Number.isFinite(bytes)) return "";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatMs(ms) {
  if (!Number.isFinite(ms)) return "--";
  const seconds = Math.max(ms > 0 ? 1 : 0, Math.ceil(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}分${seconds % 60}秒`;
}

function formatClock(value) {
  const time = Number(value);
  if (!Number.isFinite(time) || time <= 0) return "--";
  return new Date(time).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function taskStatusLabel(status) {
  if (status === "queued") return "等待";
  if (status === "running") return "生成中";
  if (status === "success") return "完成";
  if (status === "failed") return "失败";
  return status || "--";
}

function hasGenerationPendingStatus(task) {
  return task?.status === "running" || task?.status === "queued";
}

function isLiveGenerationTask(task) {
  return hasGenerationPendingStatus(task) && task?.sessionId === OUTFIT_SESSION_ID;
}

function taskDurationMs(task, now = Date.now()) {
  if (Number.isFinite(task?.timingMs) && task.timingMs > 0) return task.timingMs;
  const startedAt = Number(task?.startedAt || 0);
  const finishedAt = Number(task?.finishedAt || 0);
  if (startedAt > 0 && finishedAt > 0) return Math.max(0, finishedAt - startedAt);
  if (startedAt > 0 && isLiveGenerationTask(task)) return Math.max(0, now - startedAt);
  if (Number(task?.createdAt) > 0 && finishedAt > 0) return Math.max(0, finishedAt - Number(task.createdAt));
  return null;
}

function imageSource(image) {
  if (!image) return "";
  if (image.cachedUrl) return image.cachedUrl;
  if (image.localUrl) return image.localUrl;
  if (image.type === "b64_json") {
    const value = String(image.value || "");
    if (value.startsWith("data:")) return value;
    return `data:${image.mimeType || image.archiveMime || "image/png"};base64,${value}`;
  }
  if (image.type === "url") return image.value;
  return "";
}

function displayImageRequestUrl(src) {
  if (!src || src.startsWith("data:") || src.startsWith("blob:")) return src;
  return /^https?:\/\//i.test(src) ? `/api/image-proxy?url=${encodeURIComponent(src)}` : src;
}

function cacheableResultImageSource(image) {
  if (!image) return "";
  if (image.localUrl) return image.localUrl;
  if (image.type === "url" && image.value) return image.value;
  return "";
}

function resultImageCacheKey(image) {
  const source = cacheableResultImageSource(image);
  return source ? `${OUTFIT_RESULT_IMAGE_CACHE_PREFIX}${source}` : "";
}

function stripRuntimeResultImageCache(image) {
  if (!image || typeof image !== "object") return image;
  const { cachedUrl, cachedFrom, cachedAt, ...rest } = image;
  return rest;
}

function revokeResultImageRuntimeCache(image) {
  const url = image?.cachedUrl;
  if (typeof url === "string" && url.startsWith("blob:")) {
    try {
      URL.revokeObjectURL(url);
    } catch {}
  }
}

function revokeTaskResultRuntimeCaches(tasks = []) {
  (Array.isArray(tasks) ? tasks : []).forEach((task) => revokeResultImageRuntimeCache(task?.result));
}

function sanitizeTaskReferenceThumbs(references = []) {
  return (Array.isArray(references) ? references : [])
    .map((reference, index) => {
      const url = String(reference?.url || reference?.previewUrl || reference?.localUrl || "").trim();
      if (!url || (!url.startsWith("data:image/") && !url.startsWith("http") && !url.startsWith("/"))) return null;
      return {
        label: String(reference?.label || `图${index + 1}`).slice(0, 16),
        name: String(reference?.name || reference?.label || `参考图 ${index + 1}`).slice(0, 160),
        url
      };
    })
    .filter(Boolean)
    .slice(0, 12);
}

function stripTaskUploadImageCache(task) {
  if (!task || typeof task !== "object") return task;
  return {
    ...task,
    modelItem: null,
    extraModelItems: [],
    clothingItem: null,
    referenceItems: [],
    referenceThumbs: sanitizeTaskReferenceThumbs(task.referenceThumbs)
  };
}

function stripPageNonResultImages(page) {
  if (!page || typeof page !== "object") return page;
  return {
    ...page,
    modelImages: [],
    clothingImages: [],
    referenceImages: [],
    fixedClothingId: "",
    originalLibrary: [],
    tasks: Array.isArray(page.tasks) ? page.tasks.map(stripTaskUploadImageCache) : []
  };
}

function revokePageNonResultImageUrls(page) {
  if (!page || typeof page !== "object") return;
  [
    ...(Array.isArray(page.modelImages) ? page.modelImages : []),
    ...(Array.isArray(page.clothingImages) ? page.clothingImages : []),
    ...(Array.isArray(page.referenceImages) ? page.referenceImages : [])
  ].forEach(revokeImageUrls);
  (Array.isArray(page.originalLibrary) ? page.originalLibrary : []).forEach((item) => {
    if (item?.url) {
      try {
        URL.revokeObjectURL(item.url);
      } catch {}
    }
  });
}

function cachedResultBlobFromRecord(record) {
  if (typeof Blob === "undefined") return null;
  if (record instanceof Blob) return record;
  if (record?.blob instanceof Blob) return record.blob;
  return null;
}

function fetchBlobWithTimeout(url, timeoutMs = 45000) {
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = controller ? window.setTimeout(() => controller.abort(), timeoutMs) : null;
  return fetch(url, {
    cache: "force-cache",
    ...(controller ? { signal: controller.signal } : {})
  }).finally(() => {
    if (timer) window.clearTimeout(timer);
  }).then((response) => {
    if (!response.ok) throw new Error(`缓存图片失败 HTTP ${response.status}`);
    return response.blob();
  });
}

function preloadImageUrl(url, timeoutMs = 8000) {
  if (!url || typeof Image !== "function") return Promise.resolve();
  return new Promise((resolve) => {
    const image = new Image();
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const timer = window.setTimeout(finish, timeoutMs);
    const done = () => {
      window.clearTimeout(timer);
      finish();
    };
    image.onload = done;
    image.onerror = done;
    image.decoding = "async";
    image.src = url;
    if (typeof image.decode === "function") {
      image.decode().then(done, done);
    }
  });
}

async function cacheResultImageBlob(image) {
  const source = cacheableResultImageSource(image);
  const key = resultImageCacheKey(image);
  if (!source || !key || typeof window === "undefined" || typeof URL === "undefined") return image;

  try {
    const cached = await outfitLocalGet(key, null);
    const cachedBlob = cachedResultBlobFromRecord(cached);
    if (cachedBlob) {
      const cachedUrl = URL.createObjectURL(cachedBlob);
      await preloadImageUrl(cachedUrl);
      return {
        ...image,
        cachedUrl,
        cachedFrom: source,
        cachedAt: Number(cached?.createdAt || cached?.updatedAt || Date.now())
      };
    }
  } catch {}

  try {
    const blob = await fetchBlobWithTimeout(source);
    if (!blob || blob.size <= 0) return image;
    const createdAt = Date.now();
    const cachedUrl = URL.createObjectURL(blob);
    await outfitLocalSet(key, {
      blob,
      mimeType: blob.type || image.archiveMime || image.mimeType || "image/png",
      source,
      createdAt
    });
    await preloadImageUrl(cachedUrl);
    return {
      ...image,
      cachedUrl,
      cachedFrom: source,
      cachedAt: createdAt
    };
  } catch {
    return image;
  }
}

function referenceSource(reference) {
  return reference?.localUrl || reference?.previewUrl || reference?.url || reference?.value || "";
}

function imageItemPreviewSource(item) {
  return item?.localEdit?.previewUrl || item?.previewUrl || item?.originalUrl || "";
}

function imageItemPreviewFile(item) {
  return item?.localEdit?.cropFile || item?.file || item?.originalFile || null;
}

function taskReferencePreviewItems(task) {
  const extraModelItems = Array.isArray(task?.extraModelItems) ? task.extraModelItems : [];
  const referenceItems = Array.isArray(task?.referenceItems) ? task.referenceItems : [];
  const fallbackReferenceNames = referenceItems.length
    ? []
    : (Array.isArray(task?.referenceNames) ? task.referenceNames : []);
  return [
    {
      label: "图1",
      name: task?.modelItem?.name || task?.modelName || "图1",
      url: imageItemPreviewSource(task?.modelItem),
      item: task?.modelItem
    },
    ...extraModelItems.map((item, index) => ({
      label: `图1-${index + 2}`,
      name: item?.name || `图1-${index + 2}`,
      url: imageItemPreviewSource(item),
      item
    })),
    {
      label: "图2",
      name: task?.clothingItem?.name || task?.clothingName || "图2",
      url: imageItemPreviewSource(task?.clothingItem),
      item: task?.clothingItem
    },
    ...referenceItems.map((item, index) => ({
      label: `图${index + 3}`,
      name: item?.name || `图${index + 3}`,
      url: imageItemPreviewSource(item),
      item
    })),
    ...fallbackReferenceNames.map((name, index) => ({
      label: `图${index + 3}`,
      name,
      url: ""
    }))
  ].filter((reference) => reference.name || reference.url || reference.item);
}

function ReferenceThumbTray({ references, count = 0, className = "", max = 5, onOpen, onContextMenu }) {
  const items = Array.isArray(references) ? references.filter(Boolean) : [];
  const imageItems = items.filter((reference) => referenceSource(reference));
  const visibleItems = imageItems.slice(0, max);
  const totalCount = Math.max(Number(count) || 0, items.length);
  if (visibleItems.length === 0 && totalCount > 0) {
    return (
      <div className={`referenceThumbTray ${className}`} title="旧记录只保存了参考图数量，没有保存缩略图">
        <span className="referenceCountPill">{totalCount} 张参考</span>
      </div>
    );
  }
  if (visibleItems.length === 0) return null;
  return (
    <div className={`referenceThumbTray ${className}`} title={`本张图使用了 ${totalCount || imageItems.length} 张参考图`}>
      {visibleItems.map((reference, index) => {
        const src = referenceSource(reference);
        return (
          <span
            className="referenceMiniThumb"
            key={reference.id || `${reference.name || "reference"}-${index}`}
            title={reference.name || `参考图 ${index + 1}`}
            onContextMenu={onContextMenu ? (event) => {
              event.preventDefault();
              event.stopPropagation();
              onContextMenu(event, reference, index, items);
            } : undefined}
          >
            {src && (
              <img
                src={src}
                alt=""
                loading="lazy"
                role={onOpen ? "button" : undefined}
                tabIndex={onOpen ? 0 : undefined}
                onClick={onOpen ? (event) => {
                  event.stopPropagation();
                  onOpen(reference, index, items);
                } : undefined}
                onKeyDown={onOpen ? (event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    event.stopPropagation();
                    onOpen(reference, index, items);
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
      {(totalCount || imageItems.length) > max && <span className="referenceMoreThumb">+{(totalCount || imageItems.length) - max}</span>}
    </div>
  );
}

function isImageFile(file) {
  return String(file?.type || "").startsWith("image/")
    || /\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(String(file?.name || ""));
}

function imageFilesFromList(list) {
  return Array.from(list || []).filter(isImageFile);
}

function imageExtensionFromMime(type) {
  if (type?.includes("jpeg")) return "jpg";
  if (type?.includes("webp")) return "webp";
  if (type?.includes("gif")) return "gif";
  return "png";
}

async function imageFileFromDropUrl(url, name = `drag-${Date.now()}`) {
  const response = await fetch(/^https?:\/\//i.test(url) ? `/api/image-proxy?url=${encodeURIComponent(url)}` : url);
  if (!response.ok) throw new Error(`图片读取失败 HTTP ${response.status}`);
  const blob = await response.blob();
  return new File([blob], `${String(name || "drag-image").replace(/\.[^.]+$/, "")}.${imageExtensionFromMime(blob.type)}`, {
    type: blob.type || "image/png",
    lastModified: Date.now()
  });
}

function imageFilesFromClipboard(clipboardData) {
  const directFiles = imageFilesFromList(clipboardData?.files);
  if (directFiles.length > 0) return directFiles;
  return Array.from(clipboardData?.items || [])
    .filter((item) => item.kind === "file" && String(item.type || "").startsWith("image/"))
    .map((item, index) => item.getAsFile() || new File([], `clipboard-${Date.now()}-${index + 1}.png`, { type: item.type || "image/png" }))
    .filter(Boolean);
}

function fileFromEntry(entry) {
  return new Promise((resolve, reject) => {
    entry.file(resolve, reject);
  });
}

function readDirectoryBatch(reader) {
  return new Promise((resolve, reject) => {
    reader.readEntries(resolve, reject);
  });
}

async function filesFromEntry(entry) {
  if (!entry) return [];
  if (entry.isFile) {
    const file = await fileFromEntry(entry);
    return isImageFile(file) ? [file] : [];
  }
  if (!entry.isDirectory) return [];

  const reader = entry.createReader();
  const entries = [];
  while (true) {
    const batch = await readDirectoryBatch(reader);
    if (!batch.length) break;
    entries.push(...batch);
  }

  entries.sort((left, right) => String(left.name || "").localeCompare(String(right.name || ""), "zh-Hans-CN", { numeric: true }));
  const nested = await Promise.all(entries.map(filesFromEntry));
  return nested.flat();
}

async function imageFilesFromDataTransfer(dataTransfer) {
  const items = Array.from(dataTransfer?.items || []);
  const entries = items
    .map((item) => (typeof item.webkitGetAsEntry === "function" ? item.webkitGetAsEntry() : null))
    .filter(Boolean);

  if (entries.length > 0) {
    const nested = await Promise.all(entries.map(filesFromEntry));
    const seen = new Set();
    return nested.flat().filter((file) => {
      const key = `${file.name}_${file.size}_${file.lastModified}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return isImageFile(file);
    });
  }

  const directFiles = imageFilesFromList(dataTransfer?.files);
  if (directFiles.length > 0) return directFiles;

  const uri = String(dataTransfer?.getData?.("text/uri-list") || dataTransfer?.getData?.("text/plain") || "")
    .split(/\r?\n/)
    .find((line) => line && !line.startsWith("#"));
  if (uri && (/^https?:\/\//i.test(uri) || uri.startsWith("/") || uri.startsWith("data:"))) {
    return [await imageFileFromDropUrl(uri, "drag-image")];
  }
  return [];
}

function normalizeApiKeyInput(value) {
  return String(value || "")
    .replace(/^Bearer\s+/i, "")
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/[\s\u200B-\u200D\uFEFF]/g, "");
}

function preprocessModeLabel(mode) {
  return PREPROCESS_OPTIONS.find((option) => option.value === mode)?.label
    || PREPROCESS_OPTIONS.find((option) => option.value === DEFAULT_PREPROCESS_MODE)?.label
    || "白底补边";
}

function preprocessModeMark(mode) {
  if (mode === "crop") return "裁";
  if (mode === "soft") return "柔";
  if (mode === "original") return "原";
  return "白";
}

function groupPreprocessValue(items, fallbackMode) {
  if (!items.length) return fallbackMode;
  const modes = [...new Set(items.map((item) => item.mode || fallbackMode))];
  return modes.length === 1 ? modes[0] : "mixed";
}

function normalizeGenerationCount(value) {
  if (value === "auto") return "auto";
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return "auto";
  return Math.max(1, Math.min(MAX_UPLOAD_IMAGES, number));
}

function summarizeGenerationError(message) {
  const text = String(message || "").trim();
  if (!text) return "";
  const quotaMatch = text.match(/token quota is not enough[\s\S]*?remain quota:\s*[＄$]?([\d.]+)[\s\S]*?need quota:\s*[＄$]?([\d.]+)/i);
  if (quotaMatch) {
    return `额度不足：剩余 $${quotaMatch[1]} / 需要 $${quotaMatch[2]}`;
  }
  if (/quota|余额|额度|remain quota|need quota/i.test(text)) {
    return "渠道额度不足（查看详情）";
  }
  if (/HTTP\s*403|status\s*403|forbidden|permission|quota|余额|额度|无权限/i.test(text)) {
    return "渠道拒绝请求（查看详情）";
  }
  if (/401|invalid token|unauthorized|invalid_api_key|api key.*invalid|不接受这把 API Key|token/i.test(text)) {
    return "当前渠道不接受这把 API Key";
  }
  if (/model_not_found/i.test(text)) {
    return "当前模型在渠道不可用";
  }
  if (/openai_error|upstream|HTTP\s*502|status\s*502|上游模型/i.test(text)) {
    return "网关上游模型失败（查看详情）";
  }
  if (/image too large|max\s*2mb|2mb/i.test(text)) {
    return "图片超过 4MB";
  }
  if (/timeout|aborted|abort/i.test(text)) {
    return "请求超时";
  }
  return text.split(/\r?\n/)[0].slice(0, 80);
}

function sanitizeTaskHistoryItem(task) {
  if (!task) return null;
  return {
    id: task.id,
    order: task.order,
    status: task.status,
    error: task.error || "",
    errorDetail: task.errorDetail || "",
    prompt: task.prompt || "",
    timingMs: task.timingMs ?? null,
    startedAt: task.startedAt ?? null,
    finishedAt: task.finishedAt ?? null,
    createdAt: task.createdAt ?? Date.now(),
    modelLabel: task.modelLabel || "",
    imageSize: task.imageSize || "",
    aspectRatio: task.aspectRatio || "",
    workflowMode: task.workflowMode || "",
    pageName: task.pageName || "",
    modelName: task.modelItem?.name || task.modelName || "",
    clothingName: task.clothingItem?.name || task.clothingName || "",
    referenceNames: Array.isArray(task.referenceItems)
      ? task.referenceItems.map((item) => item?.name).filter(Boolean)
      : Array.isArray(task.referenceNames) ? task.referenceNames : [],
    referenceThumbs: sanitizeTaskReferenceThumbs(task.referenceThumbs),
    referenceCount: Number(task.referenceCount || task.referenceThumbs?.length || 0),
    result: stripRuntimeResultImageCache(task.result) || null,
    savedFilename: task.savedFilename || "",
    savedPath: task.savedPath || "",
    autoSaveFailed: Boolean(task.autoSaveFailed),
    source: task.source || "outfit"
  };
}

function recoverPersistedTask(task) {
  const item = sanitizeTaskHistoryItem(task);
  if (!item) return null;
  if (!hasGenerationPendingStatus(item)) return item;
  const finishedAt = Date.now();
  const startedAt = Number(item.startedAt || item.createdAt || finishedAt);
  return {
    ...item,
    status: "failed",
    error: "页面刷新后任务已中断，请重新生成",
    errorDetail: "页面刷新会中断当前浏览器里的批量生成 worker；已停止旧计时，避免秒数继续增长。",
    timingMs: Math.max(1, finishedAt - startedAt),
    finishedAt,
    autoSaveFailed: false
  };
}

function recoverPersistedTasks(tasks = []) {
  return (Array.isArray(tasks) ? tasks : []).map(recoverPersistedTask).filter(Boolean);
}

function readTaskHistory() {
  try {
    const parsed = JSON.parse(localStorage.getItem(TASK_HISTORY_KEY) || "[]");
    return recoverPersistedTasks(parsed);
  } catch {
    return [];
  }
}

async function readTaskHistoryAsync() {
  const idbHistory = await outfitLocalGet(OUTFIT_TASK_HISTORY_DB_KEY, null);
  if (Array.isArray(idbHistory)) {
    return recoverPersistedTasks(idbHistory);
  }
  return readTaskHistory();
}

async function persistTaskHistory(items) {
  const list = Array.isArray(items) ? items : [];
  await outfitLocalSet(OUTFIT_TASK_HISTORY_DB_KEY, list.map((task) => ({
    ...task,
    result: stripRuntimeResultImageCache(task.result) || null
  })));
  try {
    localStorage.removeItem(TASK_HISTORY_KEY);
  } catch {}
  writeJsonStorage(TASK_HISTORY_KEY, list.map((task) => ({
    ...task,
    result: null
  })).slice(-120));
}

function loadImageFromUrl(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = url;
  });
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

async function patchJpegDensity(blob, dpi = 72) {
  if (!blob || blob.type !== "image/jpeg") return blob;
  const source = new Uint8Array(await blob.arrayBuffer());
  if (source.length < 4 || source[0] !== 0xff || source[1] !== 0xd8) return blob;

  const density = Math.max(1, Math.min(65535, Math.round(dpi)));
  const app0 = new Uint8Array([
    0xff, 0xe0, 0x00, 0x10,
    0x4a, 0x46, 0x49, 0x46, 0x00,
    0x01, 0x01,
    0x01,
    density >> 8,
    density & 0xff,
    density >> 8,
    density & 0xff,
    0x00,
    0x00
  ]);

  let pos = 2;
  while (pos + 3 < source.length) {
    if (source[pos] !== 0xff) {
      pos += 1;
      continue;
    }
    let marker = source[pos + 1];
    while (marker === 0xff && pos + 2 < source.length) {
      pos += 1;
      marker = source[pos + 1];
    }
    if (marker === 0xd9 || marker === 0xda) break;
    const segmentLength = (source[pos + 2] << 8) | source[pos + 3];
    if (segmentLength < 2 || pos + 2 + segmentLength > source.length) break;
    if (marker === 0xe0 && segmentLength >= 16) {
      const isJfif =
        source[pos + 4] === 0x4a &&
        source[pos + 5] === 0x46 &&
        source[pos + 6] === 0x49 &&
        source[pos + 7] === 0x46 &&
        source[pos + 8] === 0x00;
      if (isJfif) {
        const updated = source.slice();
        updated[pos + 11] = 0x01;
        updated[pos + 12] = density >> 8;
        updated[pos + 13] = density & 0xff;
        updated[pos + 14] = density >> 8;
        updated[pos + 15] = density & 0xff;
        return new Blob([updated], { type: blob.type });
      }
    }
    pos += 2 + segmentLength;
  }

  return new Blob([source.slice(0, 2), app0, source.slice(2)], { type: blob.type });
}

async function canvasToFile(canvas, name, type = "image/jpeg", quality = 0.92) {
  const blob = await canvasToBlob(canvas, type, quality);
  const outputBlob = type === "image/jpeg" ? await patchJpegDensity(blob, 72) : blob;
  return new File([outputBlob], name.replace(/\.[^.]+$/, ".jpg"), { type, lastModified: Date.now() });
}

async function imageBitmapFromFile(file) {
  if (window.createImageBitmap) {
    try {
      return await window.createImageBitmap(file, { imageOrientation: "from-image" });
    } catch {
      // Fall back to HTMLImageElement for formats the browser bitmap decoder rejects.
    }
  }

  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("无法读取图片"));
    };
    image.src = url;
  });
}

async function imageBitmapFromBlob(blob) {
  if (window.createImageBitmap) {
    try {
      return await window.createImageBitmap(blob);
    } catch {
      // Fall back to HTMLImageElement for formats the browser bitmap decoder rejects.
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
      reject(new Error("无法读取图片"));
    };
    image.src = url;
  });
}

function constrainLocalEditRect(rect, imageWidth, imageHeight) {
  const width = Math.max(1, Math.min(Math.round(rect?.width || 1), imageWidth));
  const height = Math.max(1, Math.min(Math.round(rect?.height || 1), imageHeight));
  return {
    x: Math.max(0, Math.min(Math.round(rect?.x || 0), imageWidth - width)),
    y: Math.max(0, Math.min(Math.round(rect?.y || 0), imageHeight - height)),
    width,
    height
  };
}

function expandLocalEditContextRect(rect, imageWidth, imageHeight) {
  const base = constrainLocalEditRect(rect, imageWidth, imageHeight);
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
  const context = constrainLocalEditRect({ x, y, width, height }, imageWidth, imageHeight);
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

async function cropOutfitLocalEditFile(imageItem, cropRect, suffix = "local_edit", options = {}) {
  const originalFile = imageItem?.originalFile || imageItem?.file;
  if (!originalFile) throw new Error("缺少原图，无法创建局部回贴区域");
  const image = await imageBitmapFromFile(originalFile);
  try {
    const sourceWidth = image.width || image.naturalWidth;
    const sourceHeight = image.height || image.naturalHeight;
    const pasteRect = constrainLocalEditRect(cropRect, sourceWidth, sourceHeight);
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

async function composeOutfitLocalEditBlob(originalFile, generatedBlob, cropRect, localEdit = null, options = {}) {
  const original = await imageBitmapFromFile(originalFile);
  const generated = await imageBitmapFromBlob(generatedBlob);
  let maskImage = null;
  try {
    const sourceWidth = original.width || original.naturalWidth;
    const sourceHeight = original.height || original.naturalHeight;
    const pasteRect = constrainLocalEditRect(localEdit?.cropRect || cropRect, sourceWidth, sourceHeight);
    const contextRect = localEdit?.contextRect
      ? constrainLocalEditRect(localEdit.contextRect, sourceWidth, sourceHeight)
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

async function blobFromOutfitImage(image) {
  const src = imageSource(image);
  if (!src) throw new Error("图片地址无效");
  const response = await fetch(displayImageRequestUrl(src));
  if (!response.ok) throw new Error(`图片下载失败 HTTP ${response.status}`);
  return response.blob();
}

function dataUrlFromBlob(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("图片编码失败"));
    reader.readAsDataURL(blob);
  });
}

async function imageThumbnailDataUrlFromFile(file, maxSide = 96) {
  if (!(file instanceof File)) return "";
  const image = await imageBitmapFromFile(file);
  try {
    const sourceWidth = image.width || image.naturalWidth || 1;
    const sourceHeight = image.height || image.naturalHeight || 1;
    const scale = Math.min(1, maxSide / Math.max(sourceWidth, sourceHeight));
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) return "";
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(image, 0, 0, width, height);
    const blob = await canvasToBlob(canvas, "image/jpeg", 0.72);
    return dataUrlFromBlob(blob);
  } finally {
    image.close?.();
  }
}

async function buildTaskReferenceThumbs(task) {
  const references = taskReferencePreviewItems(task);
  const thumbs = await Promise.all(references.map(async (reference) => {
    let url = reference.url || "";
    const file = imageItemPreviewFile(reference.item);
    if (file instanceof File) {
      try {
        url = await imageThumbnailDataUrlFromFile(file);
      } catch {}
    }
    return {
      label: reference.label,
      name: reference.name || reference.label,
      url
    };
  }));
  return {
    references,
    thumbs: sanitizeTaskReferenceThumbs(thumbs)
  };
}

async function attachTaskReferenceThumbs(task) {
  const { references, thumbs } = await buildTaskReferenceThumbs(task);
  return {
    ...task,
    referenceThumbs: thumbs,
    referenceCount: references.length
  };
}

async function canvasToChannelFile(canvas, name, type = "image/jpeg", quality = 0.92) {
  const qualities = [quality, 0.86, 0.8, 0.72, 0.64, 0.56, 0.48, 0.42];
  let scale = 1;
  let workingCanvas = canvas;
  let bestBlob = null;

  const makeFile = (blob) => new File([blob], `${fileBaseName(name)}_upload.jpg`, {
    type: "image/jpeg",
    lastModified: Date.now()
  });

  for (let attempt = 0; attempt < 7; attempt += 1) {
    for (const nextQuality of qualities) {
      const blob = await canvasToBlob(workingCanvas, type, nextQuality);
      bestBlob = blob;
      if (blob.size <= CHANNEL_UPLOAD_TARGET_BYTES) return makeFile(blob);
    }

    scale *= 0.82;
    const nextCanvas = document.createElement("canvas");
    nextCanvas.width = Math.max(1, Math.round(canvas.width * scale));
    nextCanvas.height = Math.max(1, Math.round(canvas.height * scale));
    const ctx = nextCanvas.getContext("2d", { alpha: false });
    if (!ctx) break;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, nextCanvas.width, nextCanvas.height);
    ctx.drawImage(canvas, 0, 0, nextCanvas.width, nextCanvas.height);
    workingCanvas = nextCanvas;
  }

  if (bestBlob && bestBlob.size <= CHANNEL_UPLOAD_LIMIT_BYTES) return makeFile(bestBlob);
  throw new Error("图片处理后仍超过 4MB，请换一张更轻的素材再试");
}

async function compressOriginalImageFile(file) {
  if (!file || file.size <= CHANNEL_UPLOAD_LIMIT_BYTES) return file;
  const originalUrl = URL.createObjectURL(file);
  try {
    const image = await loadImageFromUrl(originalUrl);
    const scale = Math.min(1, CHANNEL_UPLOAD_MAX_SIDE / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) return file;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    return await canvasToChannelFile(canvas, file.name);
  } finally {
    URL.revokeObjectURL(originalUrl);
  }
}

function outputSizeForRatio(ratio, maxSide = CHANNEL_UPLOAD_MAX_SIDE) {
  const { w, h } = ratioParts(ratio);
  if (w >= h) {
    return { width: maxSide, height: Math.round(maxSide * h / w) };
  }
  return { width: Math.round(maxSide * w / h), height: maxSide };
}

async function processImageFile(file, ratio, mode = "pad", crop = null) {
  if (mode === "original") return await compressOriginalImageFile(file);
  const originalUrl = URL.createObjectURL(file);
  try {
    const image = await loadImageFromUrl(originalUrl);
    if (mode === "crop" && crop) {
      return await cropImageFile(file, image, ratio, crop);
    }
    return await padImageFile(file, image, ratio, mode === "soft");
  } finally {
    URL.revokeObjectURL(originalUrl);
  }
}

function drawSoftEdgeBackground(ctx, image, drawX, drawY, drawWidth, drawHeight, canvasWidth, canvasHeight) {
  const blur = 14;
  const stripX = Math.max(1, Math.min(image.naturalWidth, Math.round(image.naturalWidth * 0.08)));
  const stripY = Math.max(1, Math.min(image.naturalHeight, Math.round(image.naturalHeight * 0.08)));

  function drawClipped(rectX, rectY, rectWidth, rectHeight, sx, sy, sw, sh, dx, dy, dw, dh) {
    if (rectWidth <= 0 || rectHeight <= 0 || dw <= 0 || dh <= 0) return;
    ctx.save();
    ctx.beginPath();
    ctx.rect(rectX, rectY, rectWidth, rectHeight);
    ctx.clip();
    ctx.filter = `blur(${blur}px) saturate(1.04)`;
    ctx.drawImage(image, sx, sy, sw, sh, dx, dy, dw, dh);
    ctx.restore();
  }

  if (drawX > 0.5) {
    drawClipped(0, 0, drawX + 1, canvasHeight, 0, 0, stripX, image.naturalHeight, -blur, -blur, drawX + blur * 2 + 1, canvasHeight + blur * 2);
    drawClipped(drawX + drawWidth - 1, 0, canvasWidth - drawX - drawWidth + 1, canvasHeight, image.naturalWidth - stripX, 0, stripX, image.naturalHeight, drawX + drawWidth - 1 - blur, -blur, canvasWidth - drawX - drawWidth + blur * 2 + 1, canvasHeight + blur * 2);
  }

  if (drawY > 0.5) {
    drawClipped(0, 0, canvasWidth, drawY + 1, 0, 0, image.naturalWidth, stripY, -blur, -blur, canvasWidth + blur * 2, drawY + blur * 2 + 1);
    drawClipped(0, drawY + drawHeight - 1, canvasWidth, canvasHeight - drawY - drawHeight + 1, 0, image.naturalHeight - stripY, image.naturalWidth, stripY, -blur, drawY + drawHeight - 1 - blur, canvasWidth + blur * 2, canvasHeight - drawY - drawHeight + blur * 2 + 1);
  }

  ctx.save();
  ctx.globalAlpha = 0.18;
  ctx.fillStyle = "#ffffff";
  if (drawX > 0.5) {
    ctx.fillRect(0, 0, drawX, canvasHeight);
    ctx.fillRect(drawX + drawWidth, 0, canvasWidth - drawX - drawWidth, canvasHeight);
  }
  if (drawY > 0.5) {
    ctx.fillRect(0, 0, canvasWidth, drawY);
    ctx.fillRect(0, drawY + drawHeight, canvasWidth, canvasHeight - drawY - drawHeight);
  }
  ctx.restore();
}

async function padImageFile(file, image, ratio, softBackground = false) {
  const sourceRatio = image.naturalWidth / image.naturalHeight;
  const targetRatio = ratioParts(ratio).value;
  let targetWidth = image.naturalWidth;
  let targetHeight = image.naturalHeight;

  if (sourceRatio < targetRatio) targetWidth = Math.round(image.naturalHeight * targetRatio);
  else targetHeight = Math.round(image.naturalWidth / targetRatio);

  const scaleDown = Math.min(1, CHANNEL_UPLOAD_MAX_SIDE / Math.max(targetWidth, targetHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(targetWidth * scaleDown));
  canvas.height = Math.max(1, Math.round(targetHeight * scaleDown));
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = softBackground ? "#f7f1f4" : "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const drawWidth = image.naturalWidth * scaleDown;
  const drawHeight = image.naturalHeight * scaleDown;
  const drawX = (canvas.width - drawWidth) / 2;
  const drawY = (canvas.height - drawHeight) / 2;

  if (softBackground) {
    drawSoftEdgeBackground(ctx, image, drawX, drawY, drawWidth, drawHeight, canvas.width, canvas.height);
  }

  ctx.drawImage(image, drawX, drawY, drawWidth, drawHeight);
  return canvasToChannelFile(canvas, file.name);
}

async function cropImageFile(file, image, ratio, crop) {
  const { width, height } = outputSizeForRatio(ratio);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);

  const stageWidth = Math.max(1, Number(crop?.stageWidth) || width);
  const stageHeight = Math.max(1, Number(crop?.stageHeight) || height);
  const baseScale = Math.min(stageWidth / image.naturalWidth, stageHeight / image.naturalHeight);
  const drawScale = baseScale * Math.max(0.05, Number(crop?.scale) || 1);
  const drawWidth = image.naturalWidth * drawScale;
  const drawHeight = image.naturalHeight * drawScale;
  const left = stageWidth / 2 - drawWidth / 2 + (Number(crop?.x) || 0);
  const top = stageHeight / 2 - drawHeight / 2 + (Number(crop?.y) || 0);
  const scaleX = width / stageWidth;
  const scaleY = height / stageHeight;

  ctx.drawImage(
    image,
    left * scaleX,
    top * scaleY,
    drawWidth * scaleX,
    drawHeight * scaleY
  );
  return canvasToChannelFile(canvas, file.name);
}

async function resizeImageFile(file, settings, crop = null) {
  const normalized = normalizeResizeSettings(settings);
  const sourceUrl = URL.createObjectURL(file);
  try {
    const image = await loadImageFromUrl(sourceUrl);
    if (normalized.fitMode === "original-size") {
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("无法创建画布");
      ctx.drawImage(image, 0, 0, image.naturalWidth, image.naturalHeight);
      return canvasToFile(canvas, file.name, "image/jpeg", 0.92);
    }

    const edge = resolveResizeLongEdge(normalized);
    const { width, height } = outputSizeForRatio(normalized.ratio, edge);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("无法创建画布");

    if (normalized.fitMode === "crop") {
      ctx.fillStyle = normalized.fillColor;
      ctx.fillRect(0, 0, width, height);
      if (!crop) {
        const scale = Math.max(width / image.naturalWidth, height / image.naturalHeight);
        const drawWidth = image.naturalWidth * scale;
        const drawHeight = image.naturalHeight * scale;
        ctx.drawImage(image, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);
        return canvasToFile(canvas, file.name, "image/jpeg", 0.92);
      }
      const stageWidth = Math.max(1, Number(crop?.stageWidth) || width);
      const stageHeight = Math.max(1, Number(crop?.stageHeight) || height);
      const baseScale = Math.min(stageWidth / image.naturalWidth, stageHeight / image.naturalHeight);
      const drawScale = baseScale * Math.max(0.05, Number(crop?.scale) || 1);
      const drawWidth = image.naturalWidth * drawScale;
      const drawHeight = image.naturalHeight * drawScale;
      const left = stageWidth / 2 - drawWidth / 2 + (Number(crop?.x) || 0);
      const top = stageHeight / 2 - drawHeight / 2 + (Number(crop?.y) || 0);
      const scaleX = width / stageWidth;
      const scaleY = height / stageHeight;
      ctx.drawImage(
        image,
        left * scaleX,
        top * scaleY,
        drawWidth * scaleX,
        drawHeight * scaleY
      );
      return canvasToFile(canvas, file.name, "image/jpeg", 0.92);
    }

    ctx.fillStyle = normalized.fillColor === "#000000" ? "#000000" : "#ffffff";
    ctx.fillRect(0, 0, width, height);
    const scale = Math.min(width / image.naturalWidth, height / image.naturalHeight);
    const drawWidth = image.naturalWidth * scale;
    const drawHeight = image.naturalHeight * scale;
    ctx.drawImage(image, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);
    return canvasToFile(canvas, file.name, "image/jpeg", 0.92);
  } finally {
    URL.revokeObjectURL(sourceUrl);
  }
}

async function createImageItem(file, ratio, mode) {
  const originalUrl = URL.createObjectURL(file);
  const processedFile = await processImageFile(file, ratio, mode);
  const processedUrl = URL.createObjectURL(processedFile);
  return {
    id: makeId("img"),
    name: file.name,
    originalFile: file,
    file: processedFile,
    originalUrl,
    previewUrl: processedUrl,
    mode,
    localEdit: null,
    selected: true,
    createdAt: Date.now()
  };
}

function serializeDraftImageItem(item) {
  if (!item?.originalFile && !item?.file) return null;
  const localEdit = item.localEdit?.cropFile && item.localEdit?.cropRect
    ? {
        cropFile: item.localEdit.cropFile,
        cropRect: item.localEdit.cropRect,
        contextRect: item.localEdit.contextRect || null,
        sourceWidth: Number(item.localEdit.sourceWidth || 0),
        sourceHeight: Number(item.localEdit.sourceHeight || 0),
        aspectRatio: item.localEdit.aspectRatio || "1:1",
        editMode: item.localEdit.editMode || LOCAL_EDIT_RECT_MODE,
        maskDataUrl: item.localEdit.maskDataUrl || "",
        maskBounds: item.localEdit.maskBounds || null,
        brushSize: item.localEdit.brushSize || LOCAL_EDIT_BRUSH_DEFAULT,
        maskOpacity: item.localEdit.maskOpacity || LOCAL_EDIT_MASK_OPACITY_DEFAULT,
        appliedAt: Number(item.localEdit.appliedAt || Date.now())
      }
    : null;
  return {
    id: String(item.id || makeId("img")),
    name: String(item.name || item.originalFile?.name || item.file?.name || "image.jpg"),
    originalFile: item.originalFile || item.file,
    file: item.file || item.originalFile,
    mode: item.mode || DEFAULT_PREPROCESS_MODE,
    localEdit,
    selected: item.selected !== false,
    createdAt: Number(item.createdAt || Date.now())
  };
}

function hydrateDraftImageItem(item) {
  const originalFile = item?.originalFile || item?.file;
  const file = item?.file || originalFile;
  if (!originalFile || !file) return null;
  return {
    id: String(item.id || makeId("img")),
    name: String(item.name || originalFile.name || file.name || "image.jpg"),
    originalFile,
    file,
    originalUrl: URL.createObjectURL(originalFile),
    previewUrl: URL.createObjectURL(file),
    mode: item.mode || DEFAULT_PREPROCESS_MODE,
    localEdit: item.localEdit?.cropFile && item.localEdit?.cropRect
      ? {
          cropFile: item.localEdit.cropFile,
          cropRect: item.localEdit.cropRect,
          contextRect: item.localEdit.contextRect || null,
          sourceWidth: Number(item.localEdit.sourceWidth || 0),
          sourceHeight: Number(item.localEdit.sourceHeight || 0),
          previewUrl: URL.createObjectURL(item.localEdit.cropFile),
          aspectRatio: item.localEdit.aspectRatio || "1:1",
          editMode: item.localEdit.editMode || LOCAL_EDIT_RECT_MODE,
          maskDataUrl: item.localEdit.maskDataUrl || "",
          maskBounds: item.localEdit.maskBounds || null,
          brushSize: item.localEdit.brushSize || LOCAL_EDIT_BRUSH_DEFAULT,
          maskOpacity: item.localEdit.maskOpacity || LOCAL_EDIT_MASK_OPACITY_DEFAULT,
          appliedAt: Number(item.localEdit.appliedAt || Date.now())
        }
      : null,
    selected: item.selected !== false,
    createdAt: Number(item.createdAt || Date.now())
  };
}

function serializeOriginalDraftItem(item, imageById) {
  const source = imageById.get(item?.sourceId);
  const file = source?.originalFile || source?.file || null;
  if (!file) return null;
  return {
    id: String(item.id || makeId("origin")),
    group: item.group || "",
    sourceId: String(item.sourceId || source.id || ""),
    name: String(item.name || file.name || "image.jpg"),
    file,
    size: Number(item.size || file.size || 0),
    createdAt: Number(item.createdAt || Date.now())
  };
}

function hydrateOriginalDraftItem(item) {
  const file = item?.file;
  if (!file) return null;
  return {
    id: String(item.id || makeId("origin")),
    group: item.group || "",
    sourceId: String(item.sourceId || ""),
    name: String(item.name || file.name || "image.jpg"),
    url: URL.createObjectURL(file),
    size: Number(item.size || file.size || 0),
    createdAt: Number(item.createdAt || Date.now())
  };
}

function serializeDraftPage(page) {
  const modelImages = (page?.modelImages || []).map(serializeDraftImageItem).filter(Boolean);
  const clothingImages = (page?.clothingImages || []).map(serializeDraftImageItem).filter(Boolean);
  const referenceImages = (page?.referenceImages || []).map(serializeDraftImageItem).filter(Boolean);
  const imageById = new Map([...modelImages, ...clothingImages, ...referenceImages].map((item) => [item.id, item]));
  return {
    ...serializeOutfitPage(page),
    modelImages,
    clothingImages,
    referenceImages,
    fixedClothingId: String(page?.fixedClothingId || ""),
    originalLibrary: (page?.originalLibrary || []).map((item) => serializeOriginalDraftItem(item, imageById)).filter(Boolean),
    activeUploadGroup: page?.activeUploadGroup || "model",
    tasks: Array.isArray(page?.tasks) ? page.tasks.map(sanitizeTaskHistoryItem).filter(Boolean) : []
  };
}

function hydrateDraftPage(page) {
  const pageName = normalizeOutfitPageName(page?.name, DEFAULT_OUTFIT_PAGE_NAME);
  return makeOutfitPage(pageName, {
    ...page,
    modelImages: (page?.modelImages || []).map(hydrateDraftImageItem).filter(Boolean),
    clothingImages: (page?.clothingImages || []).map(hydrateDraftImageItem).filter(Boolean),
    referenceImages: (page?.referenceImages || []).map(hydrateDraftImageItem).filter(Boolean),
    originalLibrary: (page?.originalLibrary || []).map(hydrateOriginalDraftItem).filter(Boolean),
    uploadLabels: normalizeUploadLabels(page?.uploadLabels || {}, pageName),
    tasks: recoverPersistedTasks(page?.tasks)
  });
}

async function persistOutfitDraftState(pages, activeId) {
  const serializablePages = ensureWorkflowPages(pages, readSettings()).map(serializeDraftPage);
  await outfitLocalSet(OUTFIT_DRAFT_DB_KEY, {
    activeId,
    pages: serializablePages,
    updatedAt: Date.now()
  });
}

async function loadOutfitDraftState() {
  const draft = await outfitLocalGet(OUTFIT_DRAFT_DB_KEY, null);
  if (!draft || !Array.isArray(draft.pages) || draft.pages.length === 0) return null;
  const pages = draft.pages.map(hydrateDraftPage).filter(Boolean);
  if (!pages.length) return null;
  return {
    activeId: pages.some((page) => page.id === draft.activeId) ? draft.activeId : pages[0].id,
    pages
  };
}

function moveItemByDrop(items, fromId, toId, placement) {
  if (!fromId || !toId || fromId === toId) return items;
  const fromIndex = items.findIndex((item) => item.id === fromId);
  const targetIndex = items.findIndex((item) => item.id === toId);
  if (fromIndex < 0 || targetIndex < 0) return items;

  const next = [...items];
  const [moved] = next.splice(fromIndex, 1);
  const normalizedTargetIndex = next.findIndex((item) => item.id === toId);
  next.splice(placement === "after" ? normalizedTargetIndex + 1 : normalizedTargetIndex, 0, moved);
  return next;
}

function revokePreviewUrl(item) {
  if (item?.previewUrl) URL.revokeObjectURL(item.previewUrl);
  if (item?.localEdit?.previewUrl) URL.revokeObjectURL(item.localEdit.previewUrl);
}

function revokeImageUrls(item) {
  if (item?.originalUrl) URL.revokeObjectURL(item.originalUrl);
  revokePreviewUrl(item);
}

function UploadZone({
  title,
  hint,
  slotPrefix = "",
  titleText = "",
  hintText = "",
  onEditTitle = null,
  onEditHint = null,
  items,
  onPick,
  onRemove,
  onOpenCrop,
  onOpenLocalEdit,
  onToggle,
  onReorder,
  onReplace,
  onClear,
  onSetFixed,
  onPreview,
  fixedId,
  acceptMultiple = true,
  compact = false,
  primary = false,
  maxCount = MAX_UPLOAD_IMAGES,
  onLimit,
  onActivate,
  bulkMode = "pad",
  onBulkModeChange,
  showBulkControl = true,
  localEditEnabled = false,
  footerControls = null
}) {
  const inputRef = useRef(null);
  const pointerSortRef = useRef(null);
  const suppressOpenRef = useRef(false);
  const [dragging, setDragging] = useState(false);
  const [draggingImageId, setDraggingImageId] = useState("");
  const [dropTarget, setDropTarget] = useState(null);
  const [replaceTargetId, setReplaceTargetId] = useState("");
  const columnCount = primary ? 5 : 2;
  const mixedMode = bulkMode === "mixed";
  const displayTitle = titleText || title;
  const displayHint = hintText || hint;

  useEffect(() => {
    function preventFileDropNavigation(event) {
      const types = Array.from(event.dataTransfer?.types || []);
      if (!types.includes("Files")) return;
      event.preventDefault();
    }

    window.addEventListener("dragover", preventFileDropNavigation);
    window.addEventListener("drop", preventFileDropNavigation);
    return () => {
      window.removeEventListener("dragover", preventFileDropNavigation);
      window.removeEventListener("drop", preventFileDropNavigation);
    };
  }, []);

  function handleFiles(fileList) {
    const incoming = imageFilesFromList(fileList);
    const allowed = Math.max(0, maxCount - items.length);
    if (allowed <= 0) {
      onLimit?.(`最多上传 ${maxCount} 张`);
      return;
    }
    const files = incoming.slice(0, allowed);
    if (incoming.length > files.length) onLimit?.(`已保留前 ${maxCount} 张，超出的图片未加入`);
    if (files.length) onPick(files);
  }

  async function handleReplaceDrop(event, item) {
    if (isSortingDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
    setReplaceTargetId("");
    try {
      const files = await imageFilesFromDataTransfer(event.dataTransfer);
      const file = files.find(isImageFile);
      if (!file) {
        onLimit?.("没有读取到可替换的图片");
        return;
      }
      onReplace?.(item.id, file);
    } catch (error) {
      onLimit?.(`替换失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function isSortingDrag(event) {
    return Array.from(event.dataTransfer?.types || []).includes("application/x-jingyin-image-id");
  }

  function isLeavingElement(event) {
    const rect = event.currentTarget.getBoundingClientRect();
    const { clientX, clientY } = event;
    return clientX <= rect.left || clientX >= rect.right || clientY <= rect.top || clientY >= rect.bottom;
  }

  function markReplaceTarget(event, item) {
    if (isSortingDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "copy";
    setReplaceTargetId(item.id);
  }

  function beginPointerSort(event, item) {
    if (event.button !== 0 || items.length <= 1) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest(".thumbActions,.thumbImage")) return;
    pointerSortRef.current = {
      id: item.id,
      startX: event.clientX,
      startY: event.clientY,
      active: false,
      target: null
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function movePointerSort(event) {
    const sort = pointerSortRef.current;
    if (!sort) return;
    const deltaX = event.clientX - sort.startX;
    const deltaY = event.clientY - sort.startY;
    if (!sort.active && Math.hypot(deltaX, deltaY) < 8) return;

    sort.active = true;
    setDraggingImageId(sort.id);
    event.preventDefault();
    event.stopPropagation();

    const target = document.elementFromPoint(event.clientX, event.clientY);
    const card = target?.closest?.(".thumbCard[data-image-id]");
    const targetId = card?.dataset?.imageId;
    if (!card || !targetId || targetId === sort.id) {
      sort.target = null;
      setDropTarget(null);
      return;
    }

    const rect = card.getBoundingClientRect();
    const placement = event.clientX > rect.left + rect.width / 2 ? "after" : "before";
    sort.target = { id: targetId, placement };
    setDropTarget(sort.target);
  }

  function endPointerSort(event) {
    const sort = pointerSortRef.current;
    if (!sort) return;
    if (sort.active) {
      event.preventDefault();
      event.stopPropagation();
      if (sort.target) onReorder?.(sort.id, sort.target.id, sort.target.placement);
      suppressOpenRef.current = true;
      window.setTimeout(() => {
        suppressOpenRef.current = false;
      }, 150);
    }
    pointerSortRef.current = null;
    setDraggingImageId("");
    setDropTarget(null);
  }

  function cancelPointerSort() {
    pointerSortRef.current = null;
    setDraggingImageId("");
    setDropTarget(null);
  }

  function openCrop(item) {
    if (suppressOpenRef.current) return;
    onOpenCrop(item);
  }

  function openLocalEdit(item) {
    if (suppressOpenRef.current) return;
    onOpenLocalEdit?.(item);
  }

  return (
    <section
      tabIndex={0}
      className={`uploadZone ${compact ? "compact" : ""} ${primary ? "primary" : ""} ${dragging ? "dragging" : ""}`}
      style={{ "--upload-columns": columnCount }}
      onFocus={onActivate}
      onPointerDown={onActivate}
      onDragOver={(event) => {
        if (isSortingDrag(event)) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(event) => {
        if (isLeavingElement(event)) setDragging(false);
      }}
      onDrop={async (event) => {
        if (isSortingDrag(event)) return;
        event.preventDefault();
        setDragging(false);
        try {
          const files = await imageFilesFromDataTransfer(event.dataTransfer);
          handleFiles(files);
        } catch (error) {
          onLimit?.(`文件夹读取失败：${error instanceof Error ? error.message : String(error)}`);
        }
      }}
      onPaste={(event) => {
        const pastedImages = imageFilesFromClipboard(event.clipboardData);
        if (pastedImages.length === 0) return;
        event.preventDefault();
        event.stopPropagation();
        handleFiles(pastedImages);
      }}
    >
      <header>
        <div>
          {slotPrefix ? (
            <h3 className="uploadTitleLine">
              <span className="uploadSlotPrefix">{slotPrefix}</span>
              <button className="uploadEditableText" type="button" onDoubleClick={onEditTitle} title="双击修改">
                {displayTitle}
              </button>
            </h3>
          ) : (
            <h3>{displayTitle}</h3>
          )}
          {onEditHint ? (
            <button className="uploadEditableHint" type="button" onDoubleClick={onEditHint} title="双击修改">
              {displayHint} · {items.length}/{maxCount}
            </button>
          ) : (
            <span>{displayHint} · {items.length}/{maxCount}</span>
          )}
        </div>
        <div className="uploadHeaderActions">
          <button className="smallButton" type="button" onClick={() => inputRef.current?.click()}>
            <Upload size={15} />
            <span>上传</span>
          </button>
          {items.length > 0 && onClear && (
            <button className="smallButton clearUploadButton" type="button" onClick={onClear}>
              <Trash2 size={15} />
              <span>清除</span>
            </button>
          )}
        </div>
      </header>
      <div className="thumbGrid">
        {items.map((item, index) => {
          const placement = dropTarget?.id === item.id ? dropTarget.placement : "";
          const thumbPreviewUrl = imageItemPreviewSource(item);
          return (
          <article
            className={`thumbCard ${items.length > 1 ? "sortable" : ""} ${!item.selected ? "muted" : ""} ${fixedId === item.id ? "fixed" : ""} ${item.localEdit ? "localEditReady" : ""} ${draggingImageId === item.id ? "sorting" : ""} ${replaceTargetId === item.id ? "replaceTarget" : ""} ${placement === "before" ? "dropBefore" : ""} ${placement === "after" ? "dropAfter" : ""}`}
            data-image-id={item.id}
            key={item.id}
            onPointerDown={(event) => beginPointerSort(event, item)}
            onPointerMove={movePointerSort}
            onPointerUp={endPointerSort}
            onPointerCancel={cancelPointerSort}
            onDragEnter={(event) => markReplaceTarget(event, item)}
            onDragOver={(event) => markReplaceTarget(event, item)}
            onDragLeave={(event) => {
              if (isLeavingElement(event)) setReplaceTargetId("");
            }}
            onDrop={(event) => void handleReplaceDrop(event, item)}
          >
            <button className={`thumbImage mode-${item.mode || "pad"}`} type="button" onClick={() => onPreview?.({ ...item, previewUrl: thumbPreviewUrl })}>
              <img src={thumbPreviewUrl} alt="" draggable={false} />
              <i>{index + 1}</i>
              <em>{item.mode === "crop" ? "裁" : item.mode === "soft" ? "柔" : item.mode === "original" ? "原" : "白"}</em>
              {items.length > 1 && <span className="dragHandle" title="拖拽调整顺序"><Move size={13} /></span>}
            </button>
            <div className="thumbMeta">
              <strong title={item.name}>{item.name}</strong>
              <span>{item.mode === "crop" ? "手动裁剪" : item.mode === "soft" ? "柔和补边" : item.mode === "original" ? "原图" : "白底补边"} · {fileSize(item.file.size)}</span>
            </div>
            <div className="thumbActions">
              <button type="button" onClick={() => onToggle(item.id)} title="参与本次批量">
                {item.selected ? <Check size={14} /> : <X size={14} />}
              </button>
              {onSetFixed && (
                <button type="button" onClick={() => onSetFixed(item.id)} title="设为固定服装">
                  <Lock size={14} />
                </button>
              )}
              <button type="button" onClick={() => onOpenCrop(item)} title="裁剪/补边">
                <Crop size={14} />
              </button>
              {localEditEnabled && (
                <button
                  className={item.localEdit ? "active" : ""}
                  type="button"
                  onClick={() => openLocalEdit(item)}
                  title={item.localEdit ? "重新调整局部回贴" : "局部回贴"}
                >
                  <Scissors size={14} />
                </button>
              )}
              <button type="button" onClick={() => onRemove(item.id)} title="删除">
                <Trash2 size={14} />
              </button>
            </div>
          </article>
          );
        })}
        {items.length === 0 && (
          <button className="emptyUpload" type="button" onClick={() => inputRef.current?.click()}>
            <Images size={24} />
            <span>拖入图片或点击上传</span>
          </button>
        )}
      </div>
      {(showBulkControl || footerControls) && (
        <div className={`uploadZoneFooter ${mixedMode ? "mixed" : ""}`}>
          {showBulkControl && (
            <label className="bulkModeControl">
              <span>统一处理</span>
              <select className={mixedMode ? "mixed" : ""} value={bulkMode} onChange={(event) => onBulkModeChange?.(event.target.value)}>
                <option value="mixed" disabled>混合状态</option>
                {bulkMode === "crop" && <option value="crop" disabled>{preprocessModeLabel("crop")}</option>}
                {PREPROCESS_OPTIONS.filter((option) => option.value !== "crop").map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
          )}
          {footerControls && <div className="uploadZoneFooterControls">{footerControls}</div>}
          {showBulkControl && (
            <small>{items.length > 0 ? (mixedMode ? "当前图组处于混合状态，选择后可统一应用" : `当前：${preprocessModeLabel(bulkMode)}`) : `新上传默认：${preprocessModeLabel(bulkMode)}`}</small>
          )}
        </div>
      )}
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple={acceptMultiple}
        onChange={(event) => {
          handleFiles(event.target.files);
          event.target.value = "";
        }}
      />
    </section>
  );
}

function OutfitLocalEditThumbOverlay({ localEdit }) {
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

function CropModal({
  item,
  ratio,
  onClose,
  onApply,
  processor = processImageFile,
  initialMode = null,
  title = "裁剪 / 比例整理",
  subtitle = null,
  footerText = null,
  modeOptions = null,
  collectOnly = false,
  onCollectCrop = null
}) {
  const stageRef = useRef(null);
  const dragRef = useRef(null);
  const [mode, setMode] = useState(initialMode || modeOptions?.[0]?.[0] || "crop");
  const [transform, setTransform] = useState({ x: 0, y: 0, scale: 1 });
  const [working, setWorking] = useState(false);

  const ratioValue = ratioParts(ratio).value;

  function onPointerDown(event) {
    if (mode !== "crop") return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { x: event.clientX, y: event.clientY, start: transform };
  }

  function onPointerMove(event) {
    if (!dragRef.current || mode !== "crop") return;
    const deltaX = event.clientX - dragRef.current.x;
    const deltaY = event.clientY - dragRef.current.y;
    setTransform({
      ...dragRef.current.start,
      x: dragRef.current.start.x + deltaX,
      y: dragRef.current.start.y + deltaY
    });
  }

  function onWheel(event) {
    if (mode !== "crop") return;
    event.preventDefault();
    setTransform((current) => ({
      ...current,
      scale: Math.max(0.2, Math.min(4, current.scale + (event.deltaY > 0 ? -0.08 : 0.08)))
    }));
  }

  async function confirm() {
    setWorking(true);
    try {
      let crop = null;
      if (mode === "crop") {
        const stage = stageRef.current;
        const frame = stage?.getBoundingClientRect();
        crop = {
          x: transform.x,
          y: transform.y,
          scale: transform.scale,
          stageWidth: frame?.width,
          stageHeight: frame?.height
        };
      }
      if (collectOnly) {
        onCollectCrop?.(crop, mode);
        return;
      }
      const nextFile = await processor(item.originalFile, ratio, mode, crop);
      const nextUrl = URL.createObjectURL(nextFile);
      onApply({ ...item, file: nextFile, previewUrl: nextUrl, mode });
    } finally {
      setWorking(false);
    }
  }

  return (
    <div className="modalLayer" onMouseDown={onClose}>
      <section className="cropModal" onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <div>
            <h2>{title}</h2>
            <span>{subtitle || `${item.name} · 输出 ${ratio}`}</span>
          </div>
          <button className="iconButton" type="button" onClick={onClose}>
            <X size={18} />
          </button>
        </header>
        <div className="cropModeTabs">
          {(modeOptions || [
            ["crop", "手动裁剪"],
            ["pad", "白底补边"],
            ["soft", "柔和补边"],
            ["original", "原图"]
          ]).map(([value, label]) => (
            <button className={mode === value ? "active" : ""} key={value} type="button" onClick={() => setMode(value)}>
              {label}
            </button>
          ))}
        </div>
        <div className="cropPreviewWrap">
          <div
            className={`cropStage ${mode === "crop" ? "interactive" : ""}`}
            ref={stageRef}
            style={{ aspectRatio: `${ratioValue}` }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={() => { dragRef.current = null; }}
            onWheel={onWheel}
          >
            <img
              src={item.originalUrl}
              alt=""
              style={mode === "crop" ? {
                transform: `translate(calc(-50% + ${transform.x}px), calc(-50% + ${transform.y}px)) scale(${transform.scale})`
              } : undefined}
            />
          </div>
        </div>
        <footer>
          <span>{footerText || (mode === "crop" ? "默认显示完整原图，拖动画面选择区域，滚轮缩放后再应用。" : "确认后会在本地生成整理后的参考图。")}</span>
          <div>
            <button className="smallButton" type="button" onClick={onClose}>取消</button>
            <button className="primaryButton" type="button" onClick={confirm} disabled={working}>
              {working ? <Loader2 size={16} className="spin" /> : <Save size={16} />}
              <span>应用</span>
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}

function defaultLocalEditCrop(width, height, ratio) {
  const targetRatio = ratioParts(ratio).value;
  let cropWidth = width * 0.62;
  let cropHeight = cropWidth / targetRatio;
  if (cropHeight > height * 0.62) {
    cropHeight = height * 0.62;
    cropWidth = cropHeight * targetRatio;
  }
  return constrainLocalEditRect({
    x: (width - cropWidth) / 2,
    y: (height - cropHeight) / 2,
    width: cropWidth,
    height: cropHeight
  }, width, height);
}

function OutfitLocalEditModal({ item, ratio, onRatioChange, onClose, onApply, onClear }) {
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
  const originalFile = item?.originalFile || item?.file;
  const savedEdit = item?.localEdit || null;
  const isMaskMode = editMode === LOCAL_EDIT_MASK_MODE;
  const activeRatio = BATCH_LOCAL_EDIT_RATIOS.includes(ratio)
    ? ratio
    : BATCH_LOCAL_EDIT_RATIOS.includes(savedEdit?.aspectRatio)
      ? savedEdit.aspectRatio
      : BATCH_LOCAL_EDIT_RATIOS[0];

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
    setEditMode(savedEdit?.editMode === LOCAL_EDIT_MASK_MODE ? LOCAL_EDIT_MASK_MODE : LOCAL_EDIT_RECT_MODE);
    setMaskPainted(Boolean(savedEdit?.editMode === LOCAL_EDIT_MASK_MODE && savedEdit?.maskDataUrl));
    setMaskTool("brush");
    setBrushSize(clampLocalEditBrushSize(savedEdit?.brushSize || LOCAL_EDIT_BRUSH_DEFAULT));
    setMaskOpacity(clampLocalEditMaskOpacity(savedEdit?.maskOpacity || LOCAL_EDIT_MASK_OPACITY_DEFAULT));
    setBrushCursor({ x: 0, y: 0, visible: false });
    maskInitRef.current = "";
  }, [item?.id]);

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
    if (!canvas || !imageSize.width || !imageSize.height) return;
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
  }, [activeRatio, imageSize.height, imageSize.width, item?.id, savedEdit?.editMode, savedEdit?.maskDataUrl]);

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
      ? constrainLocalEditRect(savedEdit.cropRect, width, height)
      : defaultLocalEditCrop(width, height, activeRatio);
    setCropRect(initial);
    window.requestAnimationFrame(measureImage);
  }

  function fitRectToRatio(rect, nextRatio) {
    if (!imageSize.width || !imageSize.height) return rect;
    const targetRatio = ratioParts(nextRatio).value;
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
    return constrainLocalEditRect({
      x: centerX - nextWidth / 2,
      y: centerY - nextHeight / 2,
      width: nextWidth,
      height: nextHeight
    }, imageSize.width, imageSize.height);
  }

  function chooseRatio(nextRatio) {
    if (!BATCH_LOCAL_EDIT_RATIOS.includes(nextRatio)) return;
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
    if (nextMode === editMode) return;
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
      return constrainLocalEditRect(source, imageSize.width, imageSize.height);
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

    const targetRatio = ratioParts(activeRatio).value;
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
    const targetRatio = ratioParts(activeRatio).value;
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
        const cropped = await cropOutfitLocalEditFile(item, maskCropRect, "mask_edit");
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
        const cropped = await cropOutfitLocalEditFile(item, cropRect, "local_edit", { withContext: true });
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
            <h2>局部回贴</h2>
            <span>{originalFile?.name || "上传图片"} · 生成后贴回原图同一坐标 · {activeRatio}</span>
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
          <div className="quickLocalRatioGroup" role="group" aria-label="局部区域比例">
            {BATCH_LOCAL_EDIT_RATIOS.map((itemRatio) => (
              <button
                key={itemRatio}
                className={activeRatio === itemRatio ? "active" : ""}
                type="button"
                onClick={() => chooseRatio(itemRatio)}
              >
                {itemRatio}
              </button>
            ))}
          </div>
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
          {cropRect && <small>{isMaskMode ? "上下文 " : ""}{Math.round(cropRect.width)} × {Math.round(cropRect.height)} px</small>}
        </div>
        <footer>
          <span>{isMaskMode ? "涂抹需要 AI 修改的区域，生成后只把涂抹部分羽化贴回原图。" : "拖动选区调整位置，生成后会用羽化边缘贴回原图。"}</span>
          <div>
            {savedEdit && (
              <button className="smallButton" type="button" onClick={isMaskMode ? clearMask : () => onClear(item.id)}>
                {isMaskMode ? <Brush size={15} /> : <RefreshCw size={15} />}
                <span>{isMaskMode ? "清除涂抹" : "取消局部回贴"}</span>
              </button>
            )}
            <button className="smallButton" type="button" onClick={onClose}>取消</button>
            <button className="generateButton quickLocalApplyButton" type="button" onClick={applyLocalEdit} disabled={applyDisabled}>
              {working ? <Loader2 size={16} className="spin" /> : isMaskMode ? <Brush size={16} /> : <Scissors size={16} />}
              <span>{isMaskMode ? "应用蒙版回贴" : "应用局部回贴"}</span>
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}

function resizeSettingsFingerprint(settings, cropSignature = "") {
  const normalized = normalizeResizeSettings(settings);
  return [
    normalized.ratio,
    resolveResizeLongEdge(normalized),
    normalized.fitMode,
    normalized.fillColor,
    normalized.cropMode,
    cropSignature
  ].join("|");
}

function BatchResizePanel({
  saveDirectory,
  onChooseDirectory,
  onOpenSaveDirectory,
  onSaveImage,
  onAddEvent
}) {
  const fileInputRef = useRef(null);
  const folderInputRef = useRef(null);
  const [items, setItems] = useState([]);
  const [settings, setSettings] = useState(readResizeSettings);
  const [longEdgeDraft, setLongEdgeDraft] = useState(() => String(settings.longEdge));
  const [dragging, setDragging] = useState(false);
  const [working, setWorking] = useState(false);
  const [status, setStatus] = useState("");
  const [cropTarget, setCropTarget] = useState(null);
  const [batchCropTarget, setBatchCropTarget] = useState(null);
  const [batchCropTemplate, setBatchCropTemplate] = useState(() => readJsonStorage(RESIZE_BATCH_CROP_KEY, null));

  const isOriginalSizeMode = settings.fitMode === "original-size";
  const targetSize = isOriginalSizeMode ? null : outputSizeForRatio(settings.ratio, resolveResizeLongEdge(settings));
  const batchCropSignature = useMemo(() => JSON.stringify(batchCropTemplate || null), [batchCropTemplate]);
  const currentSettingsKey = resizeSettingsFingerprint(settings, batchCropSignature);

  useEffect(() => {
    writeJsonStorage(RESIZE_SETTINGS_KEY, settings);
  }, [settings]);

  useEffect(() => {
    setLongEdgeDraft(String(settings.longEdge));
  }, [settings.longEdge]);

  useEffect(() => {
    if (batchCropTemplate) {
      writeJsonStorage(RESIZE_BATCH_CROP_KEY, batchCropTemplate);
    } else {
      localStorage.removeItem(RESIZE_BATCH_CROP_KEY);
    }
  }, [batchCropTemplate]);

  useEffect(() => {
    folderInputRef.current?.setAttribute("webkitdirectory", "");
    folderInputRef.current?.setAttribute("directory", "");
  }, []);

  function updateResizeSetting(key, value) {
    setSettings((current) => normalizeResizeSettings({ ...current, [key]: value }));
  }

  function updateResolution(value) {
    const edge = RESIZE_RESOLUTION_MAP[value] || settings.longEdge;
    setSettings((current) => normalizeResizeSettings({
      ...current,
      resolution: value,
      longEdge: value === "custom" ? current.longEdge : edge
    }));
  }

  function changeLongEdgeDraft(value) {
    const cleaned = String(value || "").replace(/[^\d]/g, "").slice(0, 4);
    setLongEdgeDraft(cleaned);
    const number = Number.parseInt(cleaned, 10);
    if (Number.isFinite(number) && number >= 256 && number <= 8192) {
      setSettings((current) => normalizeResizeSettings({
        ...current,
        longEdge: number,
        resolution: "custom"
      }));
    } else {
      setSettings((current) => current.resolution === "custom" ? current : { ...current, resolution: "custom" });
    }
  }

  function commitLongEdgeDraft() {
    const number = Number.parseInt(longEdgeDraft, 10);
    const longEdge = clampResizeEdge(number);
    setSettings((current) => normalizeResizeSettings({
      ...current,
      longEdge,
      resolution: "custom"
    }));
    setLongEdgeDraft(String(longEdge));
  }

  function revokeResizeItem(item) {
    const urls = new Set([item?.originalUrl, item?.previewUrl].filter(Boolean));
    urls.forEach((url) => URL.revokeObjectURL(url));
  }

  function addFiles(fileList) {
    const files = Array.from(fileList || [])
      .filter(isImageFile)
      .sort((a, b) => String(a.webkitRelativePath || a.name).localeCompare(String(b.webkitRelativePath || b.name), "zh-CN", { numeric: true }));

    if (!files.length) {
      setStatus("没有读取到图片文件");
      return;
    }

    const nextItems = files.map((file) => {
      const url = URL.createObjectURL(file);
      return {
        id: makeId("resize"),
        name: file.webkitRelativePath || file.name,
        originalFile: file,
        file,
        originalUrl: url,
        previewUrl: url,
        mode: "original",
        customized: false,
        settingsKey: "",
        createdAt: Date.now()
      };
    });

    setItems((current) => [...current, ...nextItems]);
    setStatus(`已导入 ${nextItems.length} 张图片`);
    onAddEvent?.("批量改尺寸", `已导入 ${nextItems.length} 张图片`);
  }

  function removeItem(id) {
    setItems((current) => {
      const target = current.find((item) => item.id === id);
      revokeResizeItem(target);
      return current.filter((item) => item.id !== id);
    });
  }

  function clearItems() {
    setItems((current) => {
      current.forEach(revokeResizeItem);
      return [];
    });
    setStatus("已清空待处理图片");
  }

  function openBatchCropEditor() {
    if (!items.length) {
      setStatus("请先导入图片，再设置批量裁剪区域");
      return;
    }
    setBatchCropTarget({
      ...items[0],
      mode: "crop"
    });
  }

  function applyBatchCropTemplate(crop) {
    if (!crop) {
      setStatus("没有读取到有效裁剪区域，请重新设置");
      setBatchCropTarget(null);
      return;
    }
    setBatchCropTemplate(crop);
    setBatchCropTarget(null);
    setStatus("已设置批量裁剪区域，导出时会按这个区域处理未单独裁剪的图片");
    onAddEvent?.("批量改尺寸", "已设置统一裁剪区域");
  }

  function clearBatchCropTemplate() {
    setBatchCropTemplate(null);
    setStatus("已清除批量裁剪区域，将恢复默认中心裁剪");
  }

  function applyCropItem(item) {
    setItems((current) => current.map((currentItem) => {
      if (currentItem.id !== item.id) return currentItem;
      if (currentItem.previewUrl && currentItem.previewUrl !== currentItem.originalUrl) URL.revokeObjectURL(currentItem.previewUrl);
      return {
        ...currentItem,
        file: item.file,
        previewUrl: item.previewUrl,
        mode: item.mode,
        customized: true,
        settingsKey: currentSettingsKey
      };
    }));
    setCropTarget(null);
  }

  async function exportItems() {
    if (working) return;
    if (!items.length) {
      setStatus("请先导入需要改尺寸的图片");
      return;
    }
    if (!saveDirectory) {
      setStatus("请先指定保存文件夹");
      onChooseDirectory?.();
      return;
    }

    setWorking(true);
    let finished = 0;
    try {
      for (const item of items) {
        setStatus(`正在导出 ${finished + 1}/${items.length}`);
        const useCustom = settings.fitMode !== "original-size" && item.customized && item.settingsKey === currentSettingsKey;
        const sharedCrop = settings.fitMode === "crop" && settings.cropMode === "batch" ? batchCropTemplate : null;
        const file = useCustom
          ? item.file
          : await resizeImageFile(item.originalFile, settings, sharedCrop);
        await onSaveImage(file, RESIZE_OUTPUT_FOLDER);
        finished += 1;
      }
      setStatus(`已导出 ${finished} 张到「${RESIZE_OUTPUT_FOLDER}」`);
      onAddEvent?.("批量改尺寸", `已导出 ${finished} 张`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(`导出失败：${message}`);
      onAddEvent?.("批量改尺寸失败", message);
    } finally {
      setWorking(false);
    }
  }

  function openCropEditor(item) {
    setCropTarget({
      ...item,
      mode: "crop"
    });
  }

  return (
    <section
      className={`batchResizePanel ${dragging ? "dragging" : ""}`}
      id="batch-resize-section"
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={async (event) => {
        event.preventDefault();
        setDragging(false);
        try {
          addFiles(await imageFilesFromDataTransfer(event.dataTransfer));
        } catch (error) {
          setStatus(`文件夹读取失败：${error instanceof Error ? error.message : String(error)}`);
        }
      }}
      onPaste={(event) => {
        const pastedImages = imageFilesFromClipboard(event.clipboardData);
        if (!pastedImages.length) return;
        event.preventDefault();
        event.stopPropagation();
        addFiles(pastedImages);
      }}
    >
      <header className="batchResizeHeader">
        <div>
          <h3>批量改尺寸</h3>
          <span>本地缩放、补边、裁剪和原图导尺寸，不消费 API；导出到指定文件夹下的「{RESIZE_OUTPUT_FOLDER}」。</span>
        </div>
        <div className="batchResizeActions">
          <button className="smallButton" type="button" onClick={() => folderInputRef.current?.click()}>
            <FolderOpen size={15} />
            <span>选择文件夹</span>
          </button>
          <button className="smallButton" type="button" onClick={() => fileInputRef.current?.click()}>
            <Upload size={15} />
            <span>选择图片</span>
          </button>
          <button className="toolbarButton" type="button" onClick={onChooseDirectory}>
            <FolderOpen size={15} />
            <span>指定文件夹</span>
          </button>
          <button className="toolbarButton" type="button" onClick={onOpenSaveDirectory}>
            <FolderOpen size={15} />
            <span>打开目录</span>
          </button>
          <button className="primaryButton" type="button" onClick={exportItems} disabled={working || items.length === 0}>
            {working ? <Loader2 className="spin" size={16} /> : <Save size={16} />}
            <span>{working ? "导出中" : "导出"}</span>
          </button>
        </div>
      </header>

      <div className="resizeControlGrid">
        {!isOriginalSizeMode && (
          <>
            <label className="field">
              <span>分辨率</span>
              <select value={settings.resolution} onChange={(event) => updateResolution(event.target.value)}>
                {RESIZE_RESOLUTION_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>最长边(px)</span>
              <input
                type="number"
                min="256"
                max="8192"
                step="64"
                value={longEdgeDraft}
                onChange={(event) => changeLongEdgeDraft(event.target.value)}
                onBlur={commitLongEdgeDraft}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.currentTarget.blur();
                  }
                }}
              />
            </label>
            <label className="field">
              <span>输出比例</span>
              <select value={settings.ratio} onChange={(event) => updateResizeSetting("ratio", event.target.value)}>
                {BATCH_RATIO_OPTIONS.map((ratio) => (
                  <option key={ratio} value={ratio}>{ratio}</option>
                ))}
              </select>
            </label>
          </>
        )}
        <div className="resizeSegment">
          <span>适配方式</span>
          <div>
            <button className={settings.fitMode === "pad" ? "active" : ""} type="button" onClick={() => updateResizeSetting("fitMode", "pad")}>补边</button>
            <button className={settings.fitMode === "crop" ? "active" : ""} type="button" onClick={() => updateResizeSetting("fitMode", "crop")}>裁剪</button>
            <button className={settings.fitMode === "original-size" ? "active" : ""} type="button" onClick={() => updateResizeSetting("fitMode", "original-size")}>原图导尺寸</button>
          </div>
        </div>
        {!isOriginalSizeMode && (
          <>
            <div className={`resizeSwatches ${settings.fitMode !== "pad" ? "muted" : ""}`}>
              <span>填充色</span>
              <div>
                {RESIZE_FILL_OPTIONS.map((option) => (
                  <button
                    className={settings.fillColor === option.value ? "active" : ""}
                    key={option.value}
                    style={{ "--swatch": option.value }}
                    type="button"
                    disabled={settings.fitMode !== "pad"}
                    onClick={() => updateResizeSetting("fillColor", option.value)}
                    title={option.label}
                  >
                    <i />
                    <span>{option.label}</span>
                  </button>
                ))}
              </div>
            </div>
            <div className={`resizeSegment ${settings.fitMode !== "crop" ? "muted" : ""}`}>
              <span>裁剪方式</span>
              <div>
                <button className={settings.cropMode === "batch" ? "active" : ""} type="button" onClick={() => updateResizeSetting("cropMode", "batch")} disabled={settings.fitMode !== "crop"}>批量裁剪</button>
                <button className={settings.cropMode === "individual" ? "active" : ""} type="button" onClick={() => updateResizeSetting("cropMode", "individual")} disabled={settings.fitMode !== "crop"}>每张裁剪</button>
              </div>
            </div>
            <div className={`resizeCropTemplate ${settings.fitMode !== "crop" || settings.cropMode !== "batch" ? "muted" : ""}`}>
              <span>批量裁剪区域</span>
              <div>
                <button
                  type="button"
                  disabled={settings.fitMode !== "crop" || settings.cropMode !== "batch" || items.length === 0}
                  onClick={openBatchCropEditor}
                >
                  <Crop size={14} />
                  <span>{batchCropTemplate ? "重新设置" : "设置区域"}</span>
                </button>
                <button
                  type="button"
                  disabled={!batchCropTemplate || settings.fitMode !== "crop" || settings.cropMode !== "batch"}
                  onClick={clearBatchCropTemplate}
                >
                  <X size={14} />
                  <span>清除</span>
                </button>
              </div>
              <small>{batchCropTemplate ? "已设置：未单独裁剪的图片会沿用这个区域" : "未设置时默认中心裁剪"}</small>
            </div>
          </>
        )}
        <div className="resizeSummary">
          <strong>{isOriginalSizeMode ? "原像素 72DPI" : `${targetSize.width} × ${targetSize.height}`}</strong>
          <span>{isOriginalSizeMode ? "像素不改，只重写分辨率" : "当前导出尺寸"}</span>
        </div>
      </div>

      <div className="resizeDropHint">
        <Images size={24} />
        <span>拖入批量图片，或使用上方“选择文件夹”读取整文件夹图片。</span>
        <em>{saveDirectory ? `指定文件夹：${saveDirectory}` : "尚未指定保存文件夹"}</em>
      </div>

      <div className="resizeImageGrid">
        {items.map((item, index) => {
          const freshCustom = item.customized && item.settingsKey === currentSettingsKey;
          return (
            <article className={`resizeImageCard ${freshCustom ? "customized" : ""}`} key={item.id}>
              <button className="resizeThumb" type="button" onClick={() => settings.fitMode === "crop" && settings.cropMode === "individual" && openCropEditor(item)}>
                <img src={item.previewUrl} alt="" draggable={false} />
                <i>{index + 1}</i>
              </button>
              <div className="resizeMeta">
                <strong title={item.name}>{item.name}</strong>
                <span>{fileSize(item.originalFile.size)} · {freshCustom ? "已单张调整" : settings.fitMode === "original-size" ? "原像素 72DPI" : settings.fitMode === "crop" ? "中心裁剪" : "补边缩放"}</span>
              </div>
              <div className="resizeCardActions">
                <button
                  type="button"
                  onClick={() => openCropEditor(item)}
                  disabled={settings.fitMode !== "crop" || settings.cropMode !== "individual"}
                  title="每张裁剪模式下可单独调整"
                >
                  <Crop size={14} />
                </button>
                <button type="button" onClick={() => removeItem(item.id)} title="删除">
                  <Trash2 size={14} />
                </button>
              </div>
            </article>
          );
        })}
        {items.length === 0 && (
          <button className="resizeEmpty" type="button" onClick={() => fileInputRef.current?.click()}>
            <Images size={28} />
            <span>还没有图片，点击选择图片或直接拖拽进来</span>
          </button>
        )}
      </div>

      <footer className="batchResizeFooter">
        <span>{status || `已导入 ${items.length} 张，目标文件夹：${RESIZE_OUTPUT_FOLDER}`}</span>
        <button className="dangerButton" type="button" onClick={clearItems} disabled={items.length === 0 || working}>
          <Trash2 size={15} />
          <span>清空图片</span>
        </button>
      </footer>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        onChange={(event) => {
          addFiles(event.target.files);
          event.target.value = "";
        }}
      />
      <input
        ref={folderInputRef}
        type="file"
        accept="image/*"
        multiple
        onChange={(event) => {
          addFiles(event.target.files);
          event.target.value = "";
        }}
      />

      {batchCropTarget && (
        <CropModal
          item={batchCropTarget}
          ratio={settings.ratio}
          initialMode="crop"
          title="批量裁剪区域"
          subtitle={`${batchCropTarget.name} · ${targetSize.width} × ${targetSize.height}`}
          footerText="拖动画面选择统一裁剪区域，滚轮缩放；确认后会应用到批量裁剪模式下的未单独裁剪图片。"
          modeOptions={[["crop", "裁剪区域"]]}
          collectOnly
          onCollectCrop={applyBatchCropTemplate}
          onClose={() => setBatchCropTarget(null)}
          onApply={() => {}}
        />
      )}

      {cropTarget && (
        <CropModal
          item={cropTarget}
          ratio={settings.ratio}
          initialMode="crop"
          title="单张裁剪 / 改尺寸"
          subtitle={`${cropTarget.name} · ${targetSize.width} × ${targetSize.height}`}
          footerText="拖动画面选择裁剪位置，滚轮缩放；确认后只更新当前图片，不消费 API。"
          modeOptions={[["crop", "裁剪"], ["pad", "补边"]]}
          processor={(file, ratio, mode, crop) => resizeImageFile(file, { ...settings, ratio, fitMode: mode === "crop" ? "crop" : "pad" }, crop)}
          onClose={() => setCropTarget(null)}
          onApply={applyCropItem}
        />
      )}
    </section>
  );
}

function LocalDetailPanel({
  saveDirectory,
  onChooseDirectory,
  onOpenSaveDirectory,
  onSaveImage,
  onAddEvent,
  onPreview,
  defaultRatio = "3:4"
}) {
  const [baseImages, setBaseImages] = useState([]);
  const [referenceImages, setReferenceImages] = useState([]);
  const [ratio, setRatio] = useState(BATCH_RATIO_OPTIONS.includes(defaultRatio) ? defaultRatio : "3:4");
  const [cropTarget, setCropTarget] = useState(null);
  const [cropTemplate, setCropTemplate] = useState(null);
  const [working, setWorking] = useState(false);
  const [status, setStatus] = useState("局部细节修改已独立成栏目；首版先保留区域选择和局部截图导出，后续可接蒙版生成贴回。");
  const baseImagesRef = useRef([]);
  const referenceImagesRef = useRef([]);

  const selectedBase = baseImages.find((item) => item.selected) || baseImages[0] || null;
  const targetSize = outputSizeForRatio(ratio, 2048);

  useEffect(() => {
    baseImagesRef.current = baseImages;
  }, [baseImages]);

  useEffect(() => {
    referenceImagesRef.current = referenceImages;
  }, [referenceImages]);

  useEffect(() => () => {
    baseImagesRef.current.forEach(revokeImageUrls);
    referenceImagesRef.current.forEach(revokeImageUrls);
  }, []);

  async function addLocalImages(group, files) {
    const currentItems = group === "base" ? baseImages : referenceImages;
    const allowed = Math.max(0, MAX_UPLOAD_IMAGES - currentItems.length);
    if (allowed <= 0) {
      setStatus(`每个区域最多上传 ${MAX_UPLOAD_IMAGES} 张图片`);
      return;
    }
    const acceptedFiles = Array.from(files || []).filter(isImageFile).slice(0, allowed);
    if (!acceptedFiles.length) return;

    const items = [];
    for (const file of acceptedFiles) {
      try {
        items.push(await createImageItem(file, ratio, "original"));
      } catch (error) {
        setStatus(`${file.name} 读取失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (!items.length) return;

    if (group === "base") setBaseImages((current) => [...current, ...items]);
    else setReferenceImages((current) => [...current, ...items]);

    const label = group === "base" ? "主图" : "参考图";
    setStatus(`已加入 ${items.length} 张${label}`);
    onAddEvent?.("局部细节修改", `已加入 ${items.length} 张${label}`);
  }

  function removeLocalImage(group, id) {
    const update = (items) => {
      const target = items.find((item) => item.id === id);
      revokeImageUrls(target);
      return items.filter((item) => item.id !== id);
    };
    if (group === "base") setBaseImages(update);
    else setReferenceImages(update);
    if (cropTarget?.id === id) setCropTarget(null);
    if (cropTemplate?.sourceId === id) setCropTemplate(null);
  }

  function toggleLocalImage(group, id) {
    const update = (items) => items.map((item) => item.id === id ? { ...item, selected: !item.selected } : item);
    if (group === "base") setBaseImages(update);
    else setReferenceImages(update);
  }

  function reorderLocalImage(group, fromId, toId, placement) {
    const update = (items) => moveItemByDrop(items, fromId, toId, placement);
    if (group === "base") setBaseImages(update);
    else setReferenceImages(update);
  }

  function applyLocalCropTemplate(crop) {
    if (!crop || !cropTarget) {
      setStatus("没有读取到有效局部区域，请重新选择");
      setCropTarget(null);
      return;
    }
    setCropTemplate({ ...crop, sourceId: cropTarget.id });
    setCropTarget(null);
    setStatus("已记录局部区域；后续生成贴回会优先围绕这个区域处理");
  }

  async function exportLocalCrop() {
    if (working) return;
    if (!selectedBase) {
      setStatus("请先上传并选中一张主图");
      return;
    }
    if (!saveDirectory) {
      setStatus("请先指定保存文件夹");
      onChooseDirectory?.();
      return;
    }
    setWorking(true);
    try {
      const file = await resizeImageFile(selectedBase.originalFile, {
        ratio,
        longEdge: 2048,
        resolution: "2K",
        fitMode: "crop",
        fillColor: "#ffffff",
        cropMode: "individual"
      }, cropTemplate);
      const payload = await onSaveImage(file, LOCAL_DETAIL_OUTPUT_FOLDER);
      setStatus(`已导出局部截图：${payload?.filename || "完成"}`);
      onAddEvent?.("局部细节修改", `已导出到 ${LOCAL_DETAIL_OUTPUT_FOLDER}`);
    } catch (error) {
      setStatus(`导出失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setWorking(false);
    }
  }

  return (
    <section className="localDetailPanel">
      <header className="moduleHeader">
        <div>
          <h2>局部细节修改</h2>
          <span>独立栏目，不和 AI换装、批量改尺寸混用状态。</span>
        </div>
        <div className="moduleHeaderActions">
          <button className="toolbarButton" type="button" onClick={onChooseDirectory}>
            <FolderOpen size={15} />
            <span>指定文件夹</span>
          </button>
          <button className="toolbarButton" type="button" onClick={onOpenSaveDirectory}>
            <FolderOpen size={15} />
            <span>打开保存目录</span>
          </button>
        </div>
      </header>

      <div className="localDetailLayout">
        <UploadZone
          primary
          title="主图 / 待修区域"
          hint="上传需要局部修改的原图；可点剪刀选择局部区域。"
          items={baseImages}
          onPick={(files) => addLocalImages("base", files)}
          onRemove={(id) => removeLocalImage("base", id)}
          onToggle={(id) => toggleLocalImage("base", id)}
          onReorder={(fromId, toId, placement) => reorderLocalImage("base", fromId, toId, placement)}
          onPreview={(item) => onPreview?.({ title: item.name, src: item.previewUrl })}
          onOpenCrop={(item) => setCropTarget({ ...item, mode: "crop" })}
          maxCount={MAX_UPLOAD_IMAGES}
          onLimit={(message) => setStatus(message)}
          showBulkControl={false}
        />

        <section className="localDetailSide">
          <UploadZone
            compact
            title="局部参考图"
            hint="可选；后续用于细节纹理、材质、五金、图案等参考。"
            items={referenceImages}
            onPick={(files) => addLocalImages("reference", files)}
            onRemove={(id) => removeLocalImage("reference", id)}
            onToggle={(id) => toggleLocalImage("reference", id)}
            onReorder={(fromId, toId, placement) => reorderLocalImage("reference", fromId, toId, placement)}
            onPreview={(item) => onPreview?.({ title: item.name, src: item.previewUrl })}
            onOpenCrop={(item) => setCropTarget({ ...item, mode: "crop" })}
            maxCount={MAX_UPLOAD_IMAGES}
            onLimit={(message) => setStatus(message)}
            showBulkControl={false}
          />

          <section className="localActionPanel">
            <header>
              <div>
                <h3>区域处理</h3>
                <span>当前先做局部区域整理，后续接入蒙版生成和贴回导出。</span>
              </div>
            </header>
            <label className="field">
              <span>局部输出比例</span>
              <select value={ratio} onChange={(event) => setRatio(event.target.value)}>
                {BATCH_RATIO_OPTIONS.map((option) => (
                  <option key={option} value={option}>{option}</option>
                ))}
              </select>
            </label>
            <div className="localMetric">
              <strong>{targetSize.width} × {targetSize.height}</strong>
              <span>{cropTemplate ? "已选择局部区域" : "未选择时默认中心裁剪"}</span>
            </div>
            <div className="localActionButtons">
              <button className="smallButton" type="button" onClick={() => selectedBase && setCropTarget({ ...selectedBase, mode: "crop" })} disabled={!selectedBase}>
                <Crop size={15} />
                <span>选择局部区域</span>
              </button>
              <button className="primaryButton" type="button" onClick={exportLocalCrop} disabled={working || !selectedBase}>
                {working ? <Loader2 className="spin" size={16} /> : <Save size={16} />}
                <span>{working ? "导出中" : "导出局部截图"}</span>
              </button>
            </div>
            <p>{status}</p>
          </section>
        </section>
      </div>

      {cropTarget && (
        <CropModal
          item={cropTarget}
          ratio={ratio}
          initialMode="crop"
          title="局部区域选择"
          subtitle={`${cropTarget.name} · ${targetSize.width} × ${targetSize.height}`}
          footerText="拖动画面选择要局部生成的区域，滚轮缩放；确认后会记录这个局部区域。"
          modeOptions={[["crop", "局部区域"]]}
          collectOnly
          onCollectCrop={applyLocalCropTemplate}
          onClose={() => setCropTarget(null)}
          onApply={() => {}}
        />
      )}
    </section>
  );
}

function LegacyModulePanel({ title, subtitle, icon, children }) {
  return (
    <section className="legacyPanel">
      <header className="moduleHeader">
        <div>
          <h2>{title}</h2>
          <span>{subtitle}</span>
        </div>
        <div className="legacyPanelIcon">{icon}</div>
      </header>
      {children}
    </section>
  );
}

export default function OutfitWorkflow({
  view = "outfit",
  hostTheme = "dark",
  hostApiKey = "",
  onOpenHostSettings = null
}) {
  const [config, setConfig] = useState({ models: DEFAULT_MODELS });
  const [activeView, setActiveView] = useState("outfit");
  const [outfitPages, setOutfitPages] = useState(readOutfitPages);
  const initialOutfitPage = pickInitialOutfitPage(outfitPages);
  const [activeOutfitPageId, setActiveOutfitPageId] = useState(() => initialOutfitPage.id || "");
  const [settings, setSettings] = useState(() => mergeOutfitPageSettings(initialOutfitPage.settings, readSettings()));
  const [modelImages, setModelImages] = useState(() => initialOutfitPage.modelImages || []);
  const [clothingImages, setClothingImages] = useState(() => initialOutfitPage.clothingImages || []);
  const [referenceImages, setReferenceImages] = useState(() => initialOutfitPage.referenceImages || []);
  const [fixedClothingId, setFixedClothingId] = useState(() => initialOutfitPage.fixedClothingId || "");
  const [tasks, setTasks] = useState(() => initialOutfitPage.tasks?.length ? initialOutfitPage.tasks : readTaskHistory());
  const [selectedTaskIds, setSelectedTaskIds] = useState(() => new Set());
  const [galleryZoom, setGalleryZoom] = useState(1);
  const [resultFilter, setResultFilter] = useState("all");
  const [saveDirectory, setSaveDirectory] = useState("");
  const [directoryDraft, setDirectoryDraft] = useState("");
  const [isDirectoryModalOpen, setIsDirectoryModalOpen] = useState(false);
  const [isPickingDirectory, setIsPickingDirectory] = useState(false);
  const [downloadFeedbackIds, setDownloadFeedbackIds] = useState(() => new Set());
  const [activeUploadGroup, setActiveUploadGroup] = useState(() => initialOutfitPage.activeUploadGroup || "model");
  const [originalLibrary, setOriginalLibrary] = useState(() => initialOutfitPage.originalLibrary || []);
  const [imageLightbox, setImageLightbox] = useState(null);
  const [running, setRunning] = useState(false);
  const [inlineMessage, setInlineMessage] = useState("");
  const [events, setEvents] = useState([]);
  const [clockNow, setClockNow] = useState(Date.now());
  const [cropTarget, setCropTarget] = useState(null);
  const [localEditTarget, setLocalEditTarget] = useState(null);
  const [preview, setPreview] = useState(null);
  const [referenceContextMenu, setReferenceContextMenu] = useState(null);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [apiKeyDraft, setApiKeyDraft] = useState(settings.apiKey || "");
  const [apiSaveStatus, setApiSaveStatus] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [isPromptAssistantOpen, setIsPromptAssistantOpen] = useState(false);
  const [promptPresets, setPromptPresets] = useState(loadPromptPresets);
  const [promptCategories, setPromptCategories] = useState(loadPromptCategories);
  const [editingPrompt, setEditingPrompt] = useState(null);
  const [promptCategory, setPromptCategory] = useState("全部");
  const [promptSearch, setPromptSearch] = useState("");
  const [draggedPromptId, setDraggedPromptId] = useState(null);
  const [promptDropCategory, setPromptDropCategory] = useState("");
  const [draggedPageId, setDraggedPageId] = useState("");
  const [pageDropTarget, setPageDropTarget] = useState(null);
  const [previewZoom, setPreviewZoom] = useState(1);
  const [previewPan, setPreviewPan] = useState({ x: 0, y: 0 });
  const [uploadLabels, setUploadLabels] = useState(() => normalizeUploadLabels(initialOutfitPage.uploadLabels || {}, initialOutfitPage.name));
  const previewDragRef = useRef(null);
  const promptClickTimerRef = useRef(null);
  const workspaceRef = useRef(null);
  const taskGridRef = useRef(null);
  const tasksRef = useRef(tasks);
  const runningGenerationCountRef = useRef(0);
  const draftHydratingRef = useRef(false);
  const historyHydratingRef = useRef(false);
  const [draftReady, setDraftReady] = useState(false);
  const [historyReady, setHistoryReady] = useState(false);

  const activeOutfitPage = outfitPages.find((page) => page.id === activeOutfitPageId) || outfitPages[0] || {
    id: activeOutfitPageId,
    name: DEFAULT_OUTFIT_PAGE_NAME,
    deleteLocked: false,
    settings: stripOutfitPageGlobalSettings(settings),
    uploadLabels
  };
  const workflowMode = inferOutfitWorkflowMode(activeOutfitPage.name, uploadLabels);
  const isDesignDraftWorkflow = workflowMode === "design-draft";
  const isBackgroundChangeWorkflow = workflowMode === "background-change";
  const isFaceSwapWorkflow = workflowMode === "face-swap";
  const isCustomWorkflow = workflowMode === "custom";
  const isOutfitWorkflow = workflowMode === "outfit";
  const canAppendWhileRunning = true;
  const activePageDeleteLocked = Boolean(activeOutfitPage.deleteLocked);
  const models = config.models?.length ? config.models : DEFAULT_MODELS;
  const activeModel = models.find((model) => model.value === settings.model) || models[0];
  const ratios = activeModel.ratios || ["3:4"];
  const activeModels = modelImages.filter((item) => item.selected);
  const activeClothes = clothingImages.filter((item) => item.selected);
  const selectedFixedClothing = clothingImages.find((item) => item.id === fixedClothingId) || activeClothes[0] || clothingImages[0];
  const selectedGarmentParts = normalizeGarmentParts(settings.garmentParts);
  const activeGarmentLengths = normalizeGarmentLengths(settings.garmentLengths, selectedGarmentParts);
  const upperLengthEnabled = selectedGarmentParts.includes("upper");
  const lowerLengthEnabled = selectedGarmentParts.includes("lower");
  const completedCount = tasks.filter((task) => task.status === "success").length;
  const failedCount = tasks.filter((task) => task.status === "failed").length;
  const runningCount = tasks.filter((task) => task.status === "running").length;
  const imageCount = completedCount;
  const visibleTasks = resultFilter === "video" ? [] : resultFilter === "image" ? tasks.filter((task) => task.result) : tasks;
  const resultPreviewTasks = visibleTasks.filter((task) => task.result);
  const selectedCount = tasks.reduce((count, task) => count + (selectedTaskIds.has(task.id) ? 1 : 0), 0);
  const selectedCompletedCount = tasks.reduce((count, task) => count + (selectedTaskIds.has(task.id) && task.result ? 1 : 0), 0);
  const galleryZoomPercent = Math.round(galleryZoom * 100);
  const galleryCardMin = Math.round(176 * galleryZoom);
  const generationCount = normalizeGenerationCount(settings.generationCount);
  const plannedGenerationCount = generationCount === "auto"
    ? Math.min(isDesignDraftWorkflow ? Math.max(1, activeClothes.length) : activeModels.length, MAX_UPLOAD_IMAGES)
    : generationCount;
  const topbarStatus = runningCount > 0 ? "running" : failedCount > 0 ? "failed" : completedCount > 0 ? "success" : "idle";
  const topbarStatusText = runningCount > 0
    ? `生成中 ${runningCount}/${tasks.length}`
    : tasks.length > 0
      ? `完成 ${completedCount}/${tasks.length}`
      : "等待生成";
  const promptFieldTitle = isDesignDraftWorkflow
    ? "通用设计稿提示词"
    : isBackgroundChangeWorkflow
      ? "通用换背景提示词"
      : isFaceSwapWorkflow
        ? "通用换脸提示词"
        : isCustomWorkflow
          ? "本次临时提示词"
        : "通用换装提示词";
  const promptFieldPlaceholder = isDesignDraftWorkflow
    ? "长期复用的设计稿规则，例如笔触压感、手稿风格、服装结构和辅助短线。"
    : isBackgroundChangeWorkflow
      ? "长期复用的换背景规则，例如锁定人物位置姿势服装、统一场景光影色调。"
      : isFaceSwapWorkflow
        ? "长期复用的换脸规则，例如只换脸、锁定头部坐标、保留身体服装和背景。"
        : isCustomWorkflow
          ? "这个页面不会自动套用后台 SKILL；按你当前临时需求直接写。"
        : "长期复用的换装规则，例如保留人物、锁定服装版型、真实贴合、批量一致。";
  const effectiveTheme = normalizeTheme(hostTheme || settings.theme);
  const effectiveApiKey = normalizeApiKeyInput(hostApiKey || settings.apiKey);
  const embeddedMode = typeof onOpenHostSettings === "function";
  const themePalette = useMemo(() => themeToVars(effectiveTheme), [effectiveTheme]);
  const themeStyle = useMemo(() => ({
    "--app-bg": themePalette.appBg,
    "--shell-bg": themePalette.shellBg,
    "--sidebar-bg": themePalette.sidebarBg,
    "--topbar-bg": themePalette.topbarBg,
    "--panel-bg": themePalette.panelBg,
    "--panel-strong-bg": themePalette.panelStrongBg,
    "--input-bg": themePalette.inputBg,
    "--button-bg": themePalette.buttonBg,
    "--border": themePalette.border,
    "--text": themePalette.text,
    "--text-soft": themePalette.textSoft,
    "--accent": themePalette.accent,
    "--accent-text": themePalette.accentText,
    "--accent-border": themePalette.accentBorder,
    "--danger": themePalette.danger,
    "--option-bg": themePalette.optionBg
  }), [themePalette]);
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
  const modelBulkMode = groupPreprocessValue(modelImages, settings.preprocessMode);
  const clothingBulkMode = groupPreprocessValue(clothingImages, settings.preprocessMode);
  const referenceBulkMode = groupPreprocessValue(referenceImages, settings.preprocessMode);
  const allUploadImages = [...modelImages, ...clothingImages, ...referenceImages];
  const globalBulkMode = groupPreprocessValue(allUploadImages, settings.preprocessMode);

  useEffect(() => {
    if (view === "outfit" || view === "resize") {
      setActiveView(view);
    }
  }, [view]);

  useEffect(() => {
    tasksRef.current = tasks;
  }, [tasks]);

  useEffect(() => () => {
    revokeTaskResultRuntimeCaches(tasksRef.current);
  }, []);

  useEffect(() => {
    setSettings((current) => {
      const nextTheme = normalizeTheme(hostTheme || current.theme);
      const nextApiKey = hostApiKey ? normalizeApiKeyInput(hostApiKey) : current.apiKey;
      if (current.theme === nextTheme && current.apiKey === nextApiKey) return current;
      return { ...current, theme: nextTheme, apiKey: nextApiKey };
    });
  }, [hostTheme, hostApiKey]);

  useEffect(() => {
    fetch("/api/config")
      .then((response) => response.json())
      .then((payload) => {
        if (payload?.models?.length) setConfig(payload);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    historyHydratingRef.current = true;
    readTaskHistoryAsync()
      .then((history) => {
        if (cancelled || !history.length) return;
        setTasks((current) => {
          const runningItems = current.filter(isLiveGenerationTask);
          const hasLiveResults = current.some((task) => task.status === "success" && imageSource(task.result));
          return hasLiveResults ? current : [...history, ...runningItems];
        });
      })
      .finally(() => {
        if (!cancelled) {
          historyHydratingRef.current = false;
          setHistoryReady(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    draftHydratingRef.current = true;
    loadOutfitDraftState()
      .then((draft) => {
        if (cancelled || !draft?.pages?.length) return;
        const pages = ensureWorkflowPages(draft.pages, readSettings());
        const activePage = pages.find((page) => page.id === draft.activeId) || pages[0];
        setOutfitPages(pages);
        setActiveOutfitPageId(activePage.id);
        loadOutfitPage(activePage);
      })
      .finally(() => {
        if (!cancelled) {
          draftHydratingRef.current = false;
          setDraftReady(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!historyReady || historyHydratingRef.current) return;
    const persisted = tasks
      .filter((task) => task.status === "success" && imageSource(task.result))
      .map(sanitizeTaskHistoryItem)
      .filter(Boolean)
      .slice(-500);
    void persistTaskHistory(persisted);
  }, [tasks, historyReady]);

  useEffect(() => {
    if (!historyReady) return undefined;
    const targets = tasks.filter((task) => (
      task.status === "success"
      && task.result
      && cacheableResultImageSource(task.result)
      && !task.result.cachedUrl
    ));
    if (targets.length === 0) return undefined;

    let cancelled = false;
    Promise.all(targets.map(async (task) => ({
      id: task.id,
      result: await cacheResultImageBlob(task.result)
    }))).then((cachedItems) => {
      if (cancelled) return;
      const resultById = new Map(cachedItems
        .filter((item) => item.result?.cachedUrl)
        .map((item) => [item.id, item.result]));
      if (resultById.size === 0) return;
      setTasks((current) => current.map((task) => {
        if (task.result?.cachedUrl) return task;
        const result = resultById.get(task.id);
        return result ? { ...task, result } : task;
      }));
    });

    return () => {
      cancelled = true;
    };
  }, [tasks, historyReady]);

  useEffect(() => {
    void refreshSaveDirectory();
  }, []);

  useEffect(() => {
    writeJsonStorage(STORAGE_KEY, settings);
  }, [settings]);

  useEffect(() => {
    if (!outfitPages.length) return;
    if (outfitPages.some((page) => page.id === activeOutfitPageId)) return;
    setActiveOutfitPageId(outfitPages[0].id);
  }, [outfitPages, activeOutfitPageId]);

  useEffect(() => {
    const nextPages = outfitPages.map((page) => (
      page.id === activeOutfitPageId
        ? {
            ...page,
            settings,
            uploadLabels
          }
        : page
    ));
    writeJsonStorage(OUTFIT_PAGES_KEY, nextPages.map(serializeOutfitPage));
  }, [
    outfitPages,
    activeOutfitPageId,
    settings,
    uploadLabels
  ]);

  useEffect(() => {
    if (!draftReady || draftHydratingRef.current) return undefined;
    const currentSnapshot = buildCurrentOutfitPageSnapshot(activeOutfitPage);
    const pages = ensureWorkflowPages(outfitPages.map((page) => (
      page.id === activeOutfitPageId ? currentSnapshot : page
    )), settings);
    const timer = window.setTimeout(() => {
      void persistOutfitDraftState(pages, activeOutfitPageId);
    }, 350);
    return () => window.clearTimeout(timer);
  }, [
    draftReady,
    outfitPages,
    activeOutfitPageId,
    settings,
    uploadLabels,
    modelImages,
    clothingImages,
    referenceImages,
    fixedClothingId,
    tasks,
    originalLibrary,
    activeUploadGroup
  ]);

  useEffect(() => {
    writeJsonStorage(PROMPT_PRESETS_KEY, promptPresets);
  }, [promptPresets]);

  useEffect(() => {
    writeJsonStorage(PROMPT_CATEGORIES_KEY, promptCategories.filter((category) => category !== "全部"));
  }, [promptCategories]);

  useEffect(() => {
    if (!running) return undefined;
    setClockNow(Date.now());
    const timer = window.setInterval(() => setClockNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [running]);

  useEffect(() => {
    if (!ratios.includes(settings.aspectRatio)) {
      setSettings((current) => ({ ...current, aspectRatio: ratios[0] || "3:4" }));
    }
  }, [ratios, settings.aspectRatio]);

  useEffect(() => {
    if (isSettingsOpen) {
      setApiKeyDraft(settings.apiKey || "");
      setApiSaveStatus("");
    }
  }, [isSettingsOpen, settings.apiKey]);

  useEffect(() => {
    if (!preview && !imageLightbox) return;
    setPreviewZoom(1);
    setPreviewPan({ x: 0, y: 0 });
    previewDragRef.current = null;
  }, [preview, imageLightbox]);

  useEffect(() => {
    const closeReferenceMenu = () => setReferenceContextMenu(null);
    const handleReferenceMenuKey = (event) => {
      if (event.key === "Escape") setReferenceContextMenu(null);
    };
    window.addEventListener("click", closeReferenceMenu);
    window.addEventListener("resize", closeReferenceMenu);
    window.addEventListener("keydown", handleReferenceMenuKey);
    return () => {
      window.removeEventListener("click", closeReferenceMenu);
      window.removeEventListener("resize", closeReferenceMenu);
      window.removeEventListener("keydown", handleReferenceMenuKey);
    };
  }, []);

  useEffect(() => {
    if (activeView !== "outfit") return;
    window.requestAnimationFrame(() => {
      const grid = taskGridRef.current;
      if (grid) grid.scrollTop = grid.scrollHeight;
    });
  }, [activeView, visibleTasks.length, tasks.length, galleryCardMin]);

  useEffect(() => {
    if (!preview) return undefined;
    function handleKeyDown(event) {
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        navigatePreview(-1);
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        navigatePreview(1);
      }
      if (event.key === "Escape") {
        event.preventDefault();
        closePreviewModal();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [preview, resultPreviewTasks]);

  function updateSetting(key, value) {
    setSettings((current) => ({
      ...current,
      [key]: key === "generationCount"
        ? normalizeGenerationCount(value)
        : key === "smartIntervention"
          ? normalizeSmartIntervention(value)
        : key === "garmentParts"
          ? normalizeGarmentParts(value)
          : key === "garmentLengths"
            ? normalizeGarmentLengths(value, current.garmentParts)
          : value
    }));
  }

  function toggleGarmentPart(part) {
    const currentParts = normalizeGarmentParts(settings.garmentParts);
    const nextParts = currentParts.includes(part)
      ? currentParts.filter((item) => item !== part)
      : [...currentParts, part];
    if (nextParts.length === 0) {
      addEvent("图2部位", "至少保留一个换装部位");
      return;
    }
    setSettings((current) => ({
      ...current,
      garmentParts: nextParts,
      garmentLengths: normalizeGarmentLengths(current.garmentLengths, nextParts)
    }));
  }

  function updateGarmentLength(kind, value) {
    setSettings((current) => {
      const currentParts = normalizeGarmentParts(current.garmentParts);
      if ((kind === "upper" && !currentParts.includes("upper")) || (kind === "lower" && !currentParts.includes("lower"))) {
        return {
          ...current,
          garmentLengths: normalizeGarmentLengths(current.garmentLengths, currentParts)
        };
      }
      return {
        ...current,
        garmentLengths: normalizeGarmentLengths({
          ...current.garmentLengths,
          [kind]: value
        }, currentParts)
      };
    });
  }

  function openSettings() {
    if (embeddedMode) {
      onOpenHostSettings();
      return;
    }
    setApiKeyDraft(settings.apiKey || "");
    setApiSaveStatus("");
    setIsSettingsOpen(true);
  }

  function saveSettings() {
    const nextKey = normalizeApiKeyInput(apiKeyDraft);
    setApiKeyDraft(nextKey);
    updateSetting("apiKey", nextKey);
    setApiSaveStatus("已保存");
    window.setTimeout(() => setApiSaveStatus(""), 1200);
  }

  function applyPromptPreset(preset) {
    updateSetting("prompt", preset.content);
    setIsPromptAssistantOpen(false);
    addEvent("提示词", `已应用「${preset.title}」`);
  }

  function promptFallbackCategory() {
    return promptCategories.find((category) => category !== "全部") || "常用";
  }

  function schedulePromptPresetApply(preset) {
    if (promptClickTimerRef.current) window.clearTimeout(promptClickTimerRef.current);
    promptClickTimerRef.current = window.setTimeout(() => {
      promptClickTimerRef.current = null;
      applyPromptPreset(preset);
    }, 180);
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

  function editPromptPreset(preset) {
    setEditingPrompt({ ...preset });
  }

  function renamePromptPresetTitle(preset) {
    if (promptClickTimerRef.current) {
      window.clearTimeout(promptClickTimerRef.current);
      promptClickTimerRef.current = null;
    }
    const input = window.prompt("修改提示词标题", preset.title);
    const title = String(input || "").trim();
    if (!title || title === preset.title) return;
    setPromptPresets((current) => current.map((item) => (
      item.id === preset.id ? { ...item, title } : item
    )));
    addEvent("提示词", `标题已改为「${title}」`);
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
    setPromptDropCategory("");
    addEvent("提示词", "顺序已更新");
  }

  function openNewPromptEditor() {
    const category = promptCategory === "全部" ? promptFallbackCategory() : promptCategory;
    setEditingPrompt({
      id: "",
      title: "",
      category,
      content: settings.prompt.trim(),
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
      id: editingPrompt.id || makeId("prompt"),
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

  function handlePromptKeyDown(event) {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      void startBatch();
    }
  }

  function addEvent(title, detail) {
    const time = Date.now();
    const text = detail ? `${title}：${detail}` : title;
    setInlineMessage(text);
    setEvents((current) => [{ id: makeId("event"), title, detail: detail || "", time }, ...current].slice(0, 6));
  }

  function beginGenerationRun() {
    runningGenerationCountRef.current += 1;
    if (runningGenerationCountRef.current === 1) {
      setRunning(true);
    }
  }

  function endGenerationRun() {
    runningGenerationCountRef.current = Math.max(0, runningGenerationCountRef.current - 1);
    if (runningGenerationCountRef.current === 0) {
      setRunning(false);
    }
  }

  function buildCurrentOutfitPageSnapshot(basePage = activeOutfitPage) {
    const snapshotUploadLabels = uploadLabels;
    const snapshotWorkflowMode = inferOutfitWorkflowMode(basePage.name, snapshotUploadLabels);
    return {
      ...basePage,
      id: basePage.id || activeOutfitPageId,
      name: normalizeOutfitPageName(basePage.name, DEFAULT_OUTFIT_PAGE_NAME),
      deleteLocked: Boolean(basePage.deleteLocked),
      settings: stripOutfitPageGlobalSettings(settings, { allowEmptyPrompt: snapshotWorkflowMode === "custom" }),
      modelImages,
      clothingImages,
      referenceImages,
      fixedClothingId,
      tasks,
      originalLibrary,
      activeUploadGroup,
      uploadLabels: snapshotUploadLabels
    };
  }

  function resetOutfitPageTransients() {
    clearSelection();
    setResultFilter("all");
    setPreview(null);
    setImageLightbox(null);
    setCropTarget(null);
    setLocalEditTarget(null);
    setDownloadFeedbackIds(() => new Set());
    setInlineMessage("");
    setIsPromptAssistantOpen(false);
    setEditingPrompt(null);
  }

  function loadOutfitPage(page) {
    const pageWorkflowMode = inferOutfitWorkflowMode(page.name, page.uploadLabels);
    setSettings(mergeOutfitPageSettings(page.settings, settings, { allowEmptyPrompt: pageWorkflowMode === "custom" }));
    setModelImages(Array.isArray(page.modelImages) ? page.modelImages : []);
    setClothingImages(Array.isArray(page.clothingImages) ? page.clothingImages : []);
    setReferenceImages(Array.isArray(page.referenceImages) ? page.referenceImages : []);
    setFixedClothingId(page.fixedClothingId || "");
    setTasks(Array.isArray(page.tasks) ? page.tasks : []);
    setOriginalLibrary(Array.isArray(page.originalLibrary) ? page.originalLibrary : []);
    setActiveUploadGroup(page.activeUploadGroup || "model");
    setUploadLabels(normalizeUploadLabels(page.uploadLabels || {}, page.name));
    resetOutfitPageTransients();
  }

  function switchOutfitPage(pageId) {
    if (!pageId || pageId === activeOutfitPageId) return;
    const hasLiveGeneration = tasks.some(isLiveGenerationTask);
    if (running && hasLiveGeneration) {
      addEvent("页面切换", "当前正在生成，完成后再切换页面");
      return;
    }
    if (running && !hasLiveGeneration) {
      runningGenerationCountRef.current = 0;
      setRunning(false);
    }
    const target = outfitPages.find((page) => page.id === pageId);
    if (!target) return;
    const currentSnapshot = buildCurrentOutfitPageSnapshot(activeOutfitPage);
    setOutfitPages((current) => current.map((page) => (
      page.id === activeOutfitPageId ? currentSnapshot : page
    )));
    setActiveOutfitPageId(pageId);
    loadOutfitPage(target);
    addEvent("页面切换", `已切换到「${target.name}」`);
  }

  function createOutfitPageFromCurrent() {
    if (running) {
      addEvent("新建页面", "当前正在生成，完成后再新建页面");
      return;
    }
    const page = makeOutfitPage(`${DEFAULT_CUSTOM_PAGE_NAME} ${outfitPages.length + 1}`, {
      settings: {
        ...settings,
        prompt: "",
        productNote: "",
        smartIntervention: false
      },
      uploadLabels: CUSTOM_UPLOAD_LABELS,
      activeUploadGroup: "model",
      allowEmptyPrompt: true
    });
    const currentSnapshot = buildCurrentOutfitPageSnapshot(activeOutfitPage);
    setOutfitPages((current) => [
      ...current.map((item) => (item.id === activeOutfitPageId ? currentSnapshot : item)),
      page
    ]);
    setActiveOutfitPageId(page.id);
    loadOutfitPage(page);
    addEvent("新建页面", `已创建「${page.name}」`);
  }

  function beginOutfitPageDrag(event, pageId) {
    setDraggedPageId(pageId);
    setPageDropTarget(null);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", pageId);
  }

  function updateOutfitPageDropTarget(event, pageId) {
    const sourceId = draggedPageId || event.dataTransfer.getData("text/plain");
    if (!sourceId || sourceId === pageId) return;
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    const placement = event.clientX > rect.left + rect.width / 2 ? "after" : "before";
    setPageDropTarget({ id: pageId, placement });
  }

  function endOutfitPageDrag() {
    setDraggedPageId("");
    setPageDropTarget(null);
  }

  function dropOutfitPage(event, targetId) {
    const sourceId = draggedPageId || event.dataTransfer.getData("text/plain");
    if (!sourceId || !targetId || sourceId === targetId) {
      endOutfitPageDrag();
      return;
    }
    event.preventDefault();
    const placement = pageDropTarget?.id === targetId ? pageDropTarget.placement : "before";
    const currentSnapshot = buildCurrentOutfitPageSnapshot(activeOutfitPage);
    setOutfitPages((current) => {
      const pages = current.map((page) => (
        page.id === activeOutfitPageId ? currentSnapshot : page
      ));
      return moveItemByDrop(pages, sourceId, targetId, placement);
    });
    endOutfitPageDrag();
    addEvent("页面排序", "顺序已更新");
  }

  function renameOutfitPage(pageId = activeOutfitPageId) {
    const page = outfitPages.find((item) => item.id === pageId) || activeOutfitPage;
    if (!page) return;
    const input = window.prompt("修改页面名称", page.name || DEFAULT_OUTFIT_PAGE_NAME);
    const name = normalizeOutfitPageName(input, page.name || DEFAULT_OUTFIT_PAGE_NAME);
    if (!name || name === page.name) return;
    const oldDefaultLabels = defaultUploadLabelsForPage(page.name);
    const shouldApplyNewDefaults = sameUploadLabels(
      page.id === activeOutfitPageId ? uploadLabels : page.uploadLabels,
      oldDefaultLabels
    );
    const nextUploadLabels = shouldApplyNewDefaults
      ? normalizeUploadLabels(defaultUploadLabelsForPage(name), name)
      : normalizeUploadLabels(page.id === activeOutfitPageId ? uploadLabels : page.uploadLabels, name);
    const oldMode = inferOutfitWorkflowMode(page.name, page.id === activeOutfitPageId ? uploadLabels : page.uploadLabels);
    const nextMode = inferOutfitWorkflowMode(name, nextUploadLabels);
    const pageSettings = page.id === activeOutfitPageId ? settings : mergeOutfitPageSettings(page.settings, settings);
    const currentPrompt = String(pageSettings.prompt || "");
    const shouldApplyPromptDefault = shouldApplyNewDefaults
      && oldMode !== nextMode
      && [
        defaultPromptForWorkflowMode(oldMode),
        OUTFIT_DEFAULT_PROMPT,
        BACKGROUND_CHANGE_DEFAULT_PROMPT,
        FACE_SWAP_DEFAULT_PROMPT,
        DESIGN_DRAFT_DEFAULT_PROMPT
      ].includes(currentPrompt);
    const nextSettings = shouldApplyPromptDefault
      ? {
          ...pageSettings,
          prompt: defaultPromptForWorkflowMode(nextMode),
          productNote: ""
        }
      : pageSettings;
    setOutfitPages((current) => current.map((item) => (
      item.id === pageId ? { ...item, name, uploadLabels: nextUploadLabels, settings: stripOutfitPageGlobalSettings(nextSettings) } : item
    )));
    if (pageId === activeOutfitPageId) {
      setUploadLabels(nextUploadLabels);
      if (shouldApplyPromptDefault) setSettings(nextSettings);
    }
    addEvent("页面名称", `已改为「${name}」`);
  }

  function revokeOutfitPageAssets(page) {
    [page?.modelImages, page?.clothingImages, page?.referenceImages].forEach((list) => {
      if (Array.isArray(list)) list.forEach(revokeImageUrls);
    });
    if (Array.isArray(page?.originalLibrary)) {
      page.originalLibrary.forEach((item) => {
        if (item?.url) URL.revokeObjectURL(item.url);
      });
    }
  }

  function toggleOutfitPageDeleteLock(pageId = activeOutfitPageId) {
    const page = outfitPages.find((item) => item.id === pageId) || activeOutfitPage;
    if (!page) return;
    const nextLocked = !page.deleteLocked;
    setOutfitPages((current) => current.map((item) => (
      item.id === pageId ? { ...item, deleteLocked: nextLocked } : item
    )));
    addEvent("页面防误删", nextLocked ? "已锁定当前页删除" : "已解除当前页删除锁");
  }

  function deleteOutfitPage(pageId = activeOutfitPageId) {
    if (running) {
      addEvent("删除页面", "当前正在生成，完成后再删除页面");
      return;
    }
    const currentSnapshot = buildCurrentOutfitPageSnapshot(activeOutfitPage);
    const pagesWithCurrent = outfitPages.map((page) => (
      page.id === activeOutfitPageId ? currentSnapshot : page
    ));
    if (pagesWithCurrent.length <= 1) {
      addEvent("删除页面", "至少保留一个页面");
      return;
    }
    const targetIndex = pagesWithCurrent.findIndex((page) => page.id === pageId);
    if (targetIndex < 0) return;
    const target = pagesWithCurrent[targetIndex];
    if (target.deleteLocked) {
      addEvent("删除页面", "页面已锁定，先解锁再删除");
      return;
    }
    const confirmed = window.confirm(`确定删除「${target.name || DEFAULT_OUTFIT_PAGE_NAME}」吗？该页面里的上传图和生成队列会一起移除。`);
    if (!confirmed) return;
    const remaining = pagesWithCurrent.filter((page) => page.id !== pageId);
    const nextPage = remaining[Math.min(targetIndex, remaining.length - 1)] || remaining[0];
    revokeOutfitPageAssets(target);
    setOutfitPages(remaining);
    if (pageId === activeOutfitPageId && nextPage) {
      setActiveOutfitPageId(nextPage.id);
      loadOutfitPage(nextPage);
    }
    addEvent("删除页面", `已删除「${target.name || DEFAULT_OUTFIT_PAGE_NAME}」`);
  }

  function editUploadLabel(group, field) {
    const groupIndex = group === "model" ? 1 : group === "clothing" ? 2 : 3;
    const defaults = defaultUploadLabelsForPage(activeOutfitPage.name);
    const current = uploadLabels[group]?.[field] || defaults[group]?.[field] || "";
    const label = field === "title" ? `图${groupIndex}标题` : `图${groupIndex}说明`;
    const input = window.prompt(`修改${label}`, current);
    if (input == null) return;
    const nextText = normalizeUploadLabelText(input, current, field === "title" ? 36 : 140);
    if (!nextText || nextText === current) return;
    setUploadLabels((labels) => normalizeUploadLabels({
      ...labels,
      [group]: {
        ...labels[group],
        [field]: nextText
      }
    }, activeOutfitPage.name));
    addEvent("上传说明", `已修改${label}`);
  }

  async function addImages(group, files) {
    const currentCount = group === "model" ? modelImages.length : group === "clothing" ? clothingImages.length : referenceImages.length;
    const allowed = Math.max(0, MAX_UPLOAD_IMAGES - currentCount);
    if (allowed <= 0) {
      addEvent("上传限制", "每个图片区最多 10 张");
      return;
    }
    const acceptedFiles = Array.from(files || []).slice(0, allowed);
    if (acceptedFiles.length < Array.from(files || []).length) {
      addEvent("上传限制", `已保留前 ${MAX_UPLOAD_IMAGES} 张，超出的图片未加入`);
    }

    const items = [];
    const originals = [];
    for (const file of acceptedFiles) {
      try {
        const item = await createImageItem(file, settings.aspectRatio, settings.preprocessMode);
        items.push(item);
        originals.push({
          id: makeId("origin"),
          group,
          sourceId: item.id,
          name: file.name,
          url: URL.createObjectURL(file),
          size: file.size,
          createdAt: Date.now()
        });
      } catch (error) {
        addEvent("图片整理失败", `${file.name}：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (group === "model") setModelImages((current) => [...current, ...items]);
    if (group === "clothing") {
      setClothingImages((current) => {
        const next = [...current, ...items];
        if (!fixedClothingId && next[0]) setFixedClothingId(next[0].id);
        return next;
      });
    }
    if (group === "reference") setReferenceImages((current) => [...current, ...items]);
    if (originals.length) setOriginalLibrary((current) => [...current, ...originals].slice(-80));
  }

  function openReferenceContextMenu(event, reference, index, items) {
    event.preventDefault();
    event.stopPropagation();
    const menuWidth = 188;
    const menuHeight = 52;
    setReferenceContextMenu({
      reference,
      index,
      count: Array.isArray(items) ? items.length : 0,
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - menuWidth - 8)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - menuHeight - 8))
    });
  }

  async function sendReferenceThumbToModelUpload(reference) {
    const src = referenceSource(reference);
    setReferenceContextMenu(null);
    if (!src) {
      addEvent("参考图", "这张缩略图没有可读取的图片地址");
      return;
    }
    try {
      const file = await imageFileFromDropUrl(src, reference?.name || reference?.label || "reference");
      await addImages("model", [file]);
      addEvent("参考图", "已发送到图1上传区");
    } catch (error) {
      addEvent("参考图失败", error instanceof Error ? error.message : String(error));
    }
  }

  function removeImage(group, id, options = {}) {
    const { unlinkOriginal = true } = options;
    const remove = (items) => {
      const target = items.find((item) => item.id === id);
      revokeImageUrls(target);
      return items.filter((item) => item.id !== id);
    };
    if (group === "model") setModelImages(remove);
    if (group === "clothing") {
      setClothingImages((items) => {
        const next = remove(items);
        if (fixedClothingId === id) setFixedClothingId(next[0]?.id || "");
        return next;
      });
    }
    if (group === "reference") setReferenceImages(remove);
    if (localEditTarget?.group === group && localEditTarget?.item?.id === id) setLocalEditTarget(null);
    if (unlinkOriginal) {
      setOriginalLibrary((current) => current.filter((item) => {
        const linked = item.group === group && item.sourceId === id;
        if (linked && item.url) URL.revokeObjectURL(item.url);
        return !linked;
      }));
    }
  }

  async function replaceImage(group, id, file) {
    if (!isImageFile(file)) {
      addEvent("替换失败", "只能替换为图片文件");
      return;
    }
    try {
      const nextItem = await createImageItem(file, settings.aspectRatio, settings.preprocessMode);
      const replace = (items) => items.map((current) => {
        if (current.id !== id) return current;
        revokeImageUrls(current);
        return {
          ...nextItem,
          id,
          selected: current.selected,
          localEdit: null,
          createdAt: current.createdAt || nextItem.createdAt
        };
      });
      if (group === "model") setModelImages(replace);
      if (group === "clothing") setClothingImages(replace);
      if (group === "reference") setReferenceImages(replace);
      setOriginalLibrary((current) => {
        let matched = false;
        const next = current.map((item) => {
          if (item.group !== group || item.sourceId !== id) return item;
          if (item.url) URL.revokeObjectURL(item.url);
          matched = true;
          return {
            ...item,
            name: file.name,
            url: URL.createObjectURL(file),
            size: file.size,
            createdAt: Date.now()
          };
        });
        if (matched) return next;
        return [...next, {
          id: makeId("origin"),
          group,
          sourceId: id,
          name: file.name,
          url: URL.createObjectURL(file),
          size: file.size,
          createdAt: Date.now()
        }].slice(-80);
      });
      addEvent("图片替换", `${file.name} 已替换`);
    } catch (error) {
      addEvent("替换失败", `${file.name}：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function clearImageGroup(group) {
    const clear = (items) => {
      items.forEach(revokeImageUrls);
      return [];
    };
    if (group === "model") setModelImages(clear);
    if (group === "clothing") {
      setClothingImages(clear);
      setFixedClothingId("");
    }
    if (group === "reference") setReferenceImages(clear);
    setOriginalLibrary((current) => current.filter((item) => {
      const matched = item.group === group;
      if (matched && item.url) URL.revokeObjectURL(item.url);
      return !matched;
    }));
    if (cropTarget?.group === group) setCropTarget(null);
    if (localEditTarget?.group === group) setLocalEditTarget(null);
    addEvent("清除图片", group === "model" ? "图1已清空" : group === "clothing" ? "图2已清空" : "图3已清空");
  }

  function toggleImage(group, id) {
    const toggle = (items) => items.map((item) => item.id === id ? { ...item, selected: !item.selected } : item);
    if (group === "model") setModelImages(toggle);
    if (group === "clothing") setClothingImages(toggle);
    if (group === "reference") setReferenceImages(toggle);
  }

  function reorderImage(group, fromId, toId, placement) {
    const reorder = (items) => moveItemByDrop(items, fromId, toId, placement);
    if (group === "model") setModelImages(reorder);
    if (group === "clothing") setClothingImages(reorder);
    if (group === "reference") setReferenceImages(reorder);
  }

  function applyCropItem(group, item) {
    const replace = (items) => items.map((current) => {
      if (current.id !== item.id) return current;
      revokePreviewUrl(current);
      return item;
    });
    if (group === "model") setModelImages(replace);
    if (group === "clothing") setClothingImages(replace);
    if (group === "reference") setReferenceImages(replace);
    setCropTarget(null);
  }

  function openLocalEdit(group, item) {
    if (group !== "model") {
      addEvent("局部回贴", "只有图1支持局部回贴；图2和图3只作为参考图使用普通裁剪。");
      return;
    }
    const nextRatio = BATCH_LOCAL_EDIT_RATIOS.includes(settings.aspectRatio)
      ? settings.aspectRatio
      : BATCH_LOCAL_EDIT_RATIOS[0];
    if (nextRatio !== settings.aspectRatio) updateSetting("aspectRatio", nextRatio);
    setLocalEditTarget({ group, item });
  }

  function applyLocalEditItem(group, itemId, cropped) {
    if (group !== "model") {
      setLocalEditTarget(null);
      addEvent("局部回贴", "已忽略非图1的局部回贴设置。");
      return;
    }
    const localEdit = {
      cropFile: cropped.file,
      cropRect: cropped.cropRect,
      contextRect: cropped.contextRect || null,
      sourceWidth: cropped.sourceWidth,
      sourceHeight: cropped.sourceHeight,
      previewUrl: URL.createObjectURL(cropped.file),
      aspectRatio: BATCH_LOCAL_EDIT_RATIOS.includes(cropped.aspectRatio) ? cropped.aspectRatio : BATCH_LOCAL_EDIT_RATIOS[0],
      editMode: cropped.editMode || LOCAL_EDIT_RECT_MODE,
      maskDataUrl: cropped.maskDataUrl || "",
      maskBounds: cropped.maskBounds || null,
      brushSize: cropped.brushSize || LOCAL_EDIT_BRUSH_DEFAULT,
      maskOpacity: cropped.maskOpacity || LOCAL_EDIT_MASK_OPACITY_DEFAULT,
      appliedAt: Date.now()
    };
    const replace = (items) => items.map((current) => {
      if (current.id !== itemId) return current;
      if (current.localEdit?.previewUrl) URL.revokeObjectURL(current.localEdit.previewUrl);
      return { ...current, localEdit };
    });
    setModelImages(replace);
    updateSetting("aspectRatio", localEdit.aspectRatio);
    setLocalEditTarget(null);
    addEvent("局部回贴", `${uploadGroupLabel(group)} 已启用 ${localEdit.aspectRatio} ${localEdit.editMode === LOCAL_EDIT_MASK_MODE ? "涂抹蒙版" : "局部区域"}`);
  }

  function clearLocalEditItem(group, itemId) {
    if (group !== "model") {
      setLocalEditTarget(null);
      return;
    }
    const replace = (items) => items.map((current) => {
      if (current.id !== itemId) return current;
      if (current.localEdit?.previewUrl) URL.revokeObjectURL(current.localEdit.previewUrl);
      return { ...current, localEdit: null };
    });
    setModelImages(replace);
    setLocalEditTarget(null);
    addEvent("局部回贴", `${uploadGroupLabel(group)} 已取消局部回贴`);
  }

  async function applyGroupPreprocess(group, mode) {
    if (mode === "mixed") return;
    if (mode === "crop") {
      addEvent("手动裁剪", "请点单张图片的裁剪按钮调整裁剪区域");
      return;
    }
    updateSetting("preprocessMode", mode);
    const sourceItems = group === "model" ? modelImages : group === "clothing" ? clothingImages : referenceImages;
    if (!sourceItems.length) return;

    const nextItems = await Promise.all(sourceItems.map(async (item) => {
      try {
        const nextFile = await processImageFile(item.originalFile, settings.aspectRatio, mode);
        revokePreviewUrl(item);
        const nextItem = {
          ...item,
          file: nextFile,
          previewUrl: URL.createObjectURL(nextFile),
          mode
        };
        return nextItem;
      } catch (error) {
        addEvent("批量统一失败", `${item.name}：${error instanceof Error ? error.message : String(error)}`);
        return item;
      }
    }));

    if (group === "model") setModelImages(nextItems);
    if (group === "clothing") setClothingImages(nextItems);
    if (group === "reference") setReferenceImages(nextItems);
  }

  async function applyGlobalPreprocess(mode) {
    if (mode === "mixed") return;
    if (mode === "crop") {
      addEvent("手动裁剪", "请点单张图片的裁剪按钮调整裁剪区域");
      return;
    }
    if (allUploadImages.length === 0) {
      updateSetting("preprocessMode", mode);
      return;
    }
    await Promise.all([
      applyGroupPreprocess("model", mode),
      applyGroupPreprocess("clothing", mode),
      applyGroupPreprocess("reference", mode)
    ]);
    addEvent("统一处理", `已统一为${preprocessModeLabel(mode)}`);
  }

  function uploadGroupLabel(group) {
    if (group === "model") return "图1";
    if (group === "clothing") return "图2";
    return "图3";
  }

  function handleWorkspacePaste(event) {
    const pastedImages = imageFilesFromClipboard(event.clipboardData);
    if (pastedImages.length === 0) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest("textarea,input,select")) return;
    event.preventDefault();
    void addImages(activeUploadGroup, pastedImages);
    addEvent("粘贴上传", `已加入${uploadGroupLabel(activeUploadGroup)}`);
  }

  function removeOriginalImage(id) {
    const target = originalLibrary.find((item) => item.id === id);
    if (target?.group && target?.sourceId) {
      removeImage(target.group, target.sourceId, { unlinkOriginal: false });
    }
    if (target?.url) URL.revokeObjectURL(target.url);
    setOriginalLibrary((current) => {
      return current.filter((item) => item.id !== id);
    });
  }

  function toggleTaskSelected(id) {
    setSelectedTaskIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function clearSelection() {
    setSelectedTaskIds(new Set());
  }

  function deleteSelected() {
    if (selectedTaskIds.size === 0) return;
    const ids = new Set(selectedTaskIds);
    setTasks((current) => current.filter((task) => !ids.has(task.id)));
    clearSelection();
    addEvent("删除", `已删除 ${selectedTaskIds.size} 个队列项`);
  }

  function clearAll() {
    if (tasks.length === 0) return;
    const confirmed = window.confirm("确定清空当前换装生成记录吗？上传图片和原图库不会被清空。");
    if (!confirmed) return;
    revokeTaskResultRuntimeCaches(tasks);
    setTasks([]);
    clearSelection();
    localStorage.removeItem(TASK_HISTORY_KEY);
    void persistTaskHistory([]);
    addEvent("清空", "生成队列已清空");
  }

  async function clearNonResultImageCache() {
    if (running) {
      addEvent("清理缓存", "当前正在生成，完成后再清理缓存");
      return;
    }
    const confirmed = window.confirm("清理上传图、缩略图和临时草稿缓存？生成结果图和指定文件夹里的图片不会删除。");
    if (!confirmed) return;

    const activeSnapshot = buildCurrentOutfitPageSnapshot(activeOutfitPage);
    const nextPages = ensureWorkflowPages(outfitPages.map((page) => {
      const sourcePage = page.id === activeOutfitPageId ? activeSnapshot : page;
      revokePageNonResultImageUrls(sourcePage);
      return stripPageNonResultImages(sourcePage);
    }), settings);

    setOutfitPages(nextPages);
    setModelImages([]);
    setClothingImages([]);
    setReferenceImages([]);
    setFixedClothingId("");
    setOriginalLibrary([]);
    setTasks((current) => current.map(stripTaskUploadImageCache));
    setCropTarget(null);
    setLocalEditTarget(null);
    setImageLightbox(null);
    setActiveUploadGroup("model");
    clearSelection();

    await outfitLocalSet(OUTFIT_DRAFT_DB_KEY, {
      activeId: activeOutfitPageId,
      pages: nextPages.map(serializeDraftPage),
      updatedAt: Date.now()
    });
    const deletedTempCacheCount = await outfitLocalDeleteByPrefix(OUTFIT_TEMP_IMAGE_CACHE_PREFIX);
    addEvent("清理缓存", `已清理上传图和临时缓存，结果图保留${deletedTempCacheCount ? `（临时缓存 ${deletedTempCacheCount} 项）` : ""}`);
  }

  async function refreshHistory() {
    const history = await readTaskHistoryAsync();
    setTasks((current) => {
      const runningItems = current.filter(isLiveGenerationTask);
      return [...history, ...runningItems];
    });
    clearSelection();
    addEvent("刷新", `已载入 ${history.length} 张历史图片`);
  }

  async function refreshSaveDirectory() {
    try {
      const response = await fetch("/api/save-directory");
      const payload = await response.json();
      if (!response.ok || !payload?.ok) throw new Error(payload?.message || "读取保存目录失败");
      setSaveDirectory(payload.directory);
      setDirectoryDraft(payload.directory);
      return payload.directory;
    } catch (error) {
      addEvent("保存目录", error instanceof Error ? error.message : String(error));
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
    } catch (error) {
      addEvent("保存目录失败", error instanceof Error ? error.message : String(error));
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
    } catch (error) {
      addEvent("目录选择失败", error instanceof Error ? error.message : String(error));
    } finally {
      setIsPickingDirectory(false);
    }
  }

  function openSaveDirectory() {
    const directory = saveDirectory || directoryDraft;
    fetch("/api/open-save-directory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ directory })
    }).then(async (response) => {
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.ok) throw new Error(payload?.message || "打开保存目录失败");
      setSaveDirectory(payload.directory);
      setDirectoryDraft((current) => current || payload.directory);
      addEvent("保存目录", "已打开");
    }).catch((error) => {
      addEvent("打开失败", error instanceof Error ? error.message : String(error));
    });
  }

  async function saveProcessedImageToFolder(file, subfolder = "") {
    const directory = saveDirectory || await refreshSaveDirectory();
    if (!directory) throw new Error("未找到指定文件夹");
    const form = new FormData();
    form.append("directory", directory);
    if (subfolder) form.append("subfolder", subfolder);
    form.append("image", file, file.name || "processed.jpg");
    const response = await fetch("/api/save-processed-image", {
      method: "POST",
      body: form
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) {
      throw new Error(payload?.message || "保存整理后图片失败");
    }
    setSaveDirectory(payload.directory);
    setDirectoryDraft(payload.directory);
    return payload;
  }

  async function saveExportedImageToFolder(file, subfolder = RESIZE_OUTPUT_FOLDER) {
    return saveProcessedImageToFolder(file, subfolder);
  }

  function taskToDownloadItem(task, imageOverride = null) {
    return {
      id: task.id,
      image: imageOverride || task.result,
      prompt: task.prompt || "",
      modelLabel: task.modelLabel || settings.model,
      imageSize: task.imageSize || settings.imageSize,
      aspectRatio: task.aspectRatio || settings.aspectRatio,
      createdAt: task.finishedAt || task.createdAt || Date.now()
    };
  }

  function taskHasLocalEditResult(task) {
    return Boolean(task?.localEdit?.cropFile || task?.result?.localEdit?.enabled);
  }

  function flashDownloadFeedback(id) {
    if (!id) return;
    setDownloadFeedbackIds((current) => {
      const next = new Set(current);
      next.add(id);
      return next;
    });
    window.setTimeout(() => {
      setDownloadFeedbackIds((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    }, 1100);
  }

  async function saveTaskImageToDirectory(task, imageOverride = null) {
    const image = imageOverride || task?.result;
    if (!task || !image) return null;
    const directory = saveDirectory || await refreshSaveDirectory();
    const response = await fetch("/api/save-image", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ directory, item: taskToDownloadItem(task, image) })
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) throw new Error(payload?.message || "保存图片失败");
    setSaveDirectory(payload.directory);
    setDirectoryDraft(payload.directory);
    return payload;
  }

  function markTaskSaved(taskId, payload, options = {}) {
    setTasks((current) => current.map((item) => item.id === taskId ? {
      ...item,
      savedFilename: payload?.filename || item.savedFilename || "",
      savedPath: payload?.path || item.savedPath || "",
      autoSaveFailed: false
    } : item));
    if (options.flash !== false) flashDownloadFeedback(taskId);
  }

  async function autoSaveTask(task, image) {
    try {
      const payload = await saveTaskImageToDirectory(task, image);
      markTaskSaved(task.id, payload, { flash: true });
    } catch (error) {
      setTasks((current) => current.map((item) => item.id === task.id ? { ...item, autoSaveFailed: true } : item));
      addEvent("自动保存失败", error instanceof Error ? error.message : String(error));
    }
  }

  async function downloadTask(task) {
    if (!task?.result) return;
    if ((task.savedFilename || task.savedPath) && !taskHasLocalEditResult(task)) {
      flashDownloadFeedback(task.id);
      addEvent("下载", task.savedFilename ? `已保存为 ${task.savedFilename}` : "图片已在指定文件夹");
      return;
    }
    try {
      const payload = await saveTaskImageToDirectory(task);
      markTaskSaved(task.id, payload, { flash: true });
      addEvent("下载", `已保存为 ${payload.filename}`);
    } catch (error) {
      addEvent("下载失败", error instanceof Error ? error.message : String(error));
    }
  }

  function downloadSelected() {
    const targets = tasks.filter((task) => selectedTaskIds.has(task.id) && task.result);
    targets.forEach((task) => void downloadTask(task));
    if (targets.length > 0) addEvent("下载选中", `已提交 ${targets.length} 张保存任务`);
  }

  function downloadAll() {
    const targets = tasks.filter((task) => task.result);
    targets.forEach((task) => void downloadTask(task));
    if (targets.length > 0) addEvent("下载全部", `已提交 ${targets.length} 张保存任务`);
  }

  function changeGalleryZoom(delta) {
    setGalleryZoom((current) => Math.max(0.75, Math.min(1.45, Number((current + delta).toFixed(2)))));
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

  function closePreviewModal() {
    setPreview(null);
    setImageLightbox(null);
  }

  function navigatePreview(direction) {
    if (!preview || resultPreviewTasks.length <= 1) return;
    const currentIndex = resultPreviewTasks.findIndex((task) => task.id === preview.id);
    if (currentIndex < 0) return;
    const nextIndex = (currentIndex + direction + resultPreviewTasks.length) % resultPreviewTasks.length;
    setPreview(resultPreviewTasks[nextIndex]);
  }

  function zoomPreviewByWheel(event) {
    event.preventDefault();
    const delta = event.deltaY > 0 ? -0.12 : 0.12;
    setPreviewZoom((current) => Math.max(0.35, Math.min(5, Number((current + delta).toFixed(2)))));
  }

  function startPreviewDrag(event) {
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
    if (!drag.moved) closePreviewModal();
  }

  function clothingForIndex(index) {
    if (settings.pairingMode === "fixed") return selectedFixedClothing;
    if (settings.pairingMode === "sequence") return activeClothes[index] || null;
    if (settings.pairingMode === "cycle") return activeClothes.length ? activeClothes[index % activeClothes.length] : null;
    return selectedFixedClothing;
  }

  function modelForIndex(index) {
    if (!activeModels.length) return null;
    if (generationCount === "auto") return activeModels[index] || null;
    return activeModels[index] || activeModels[index % activeModels.length];
  }

  function buildTasks(countOverride = plannedGenerationCount) {
    const count = Math.min(countOverride, MAX_UPLOAD_IMAGES);
    const selectedReferences = referenceImages.filter((item) => item.selected);
    return Array.from({ length: count }, (_, index) => {
      const modelItem = isDesignDraftWorkflow ? activeModels[0] : modelForIndex(index);
      const extraModelItems = isDesignDraftWorkflow ? activeModels.slice(1) : [];
      const clothingItem = clothingForIndex(index);
      const localEdit = !isDesignDraftWorkflow && modelItem?.localEdit?.cropFile && modelItem?.localEdit?.cropRect ? modelItem.localEdit : null;
      return {
        id: makeId(`task_${index + 1}`),
        sessionId: OUTFIT_SESSION_ID,
        order: index + 1,
        modelItem,
        extraModelItems,
        clothingItem,
        referenceItems: selectedReferences,
        localEdit,
        workflowMode,
        pageName: activeOutfitPage.name,
        uploadLabels,
        modelImageCount: isDesignDraftWorkflow ? activeModels.length : 1,
        status: "queued",
        error: "",
        result: null,
        prompt: "",
        timingMs: null,
        createdAt: Date.now() + index,
        imageSize: settings.imageSize,
        aspectRatio: localEdit?.aspectRatio || settings.aspectRatio,
        modelLabel: activeModel.label,
        modelName: modelItem?.name || "",
        clothingName: clothingItem?.name || "",
        referenceNames: [
          ...extraModelItems.map((item) => item.name),
          ...selectedReferences.map((item) => item.name)
        ].filter(Boolean)
      };
    }).filter((task) => task.modelItem && task.clothingItem);
  }

  async function runSingleTask(task) {
    const startedAt = Date.now();
    const taskWorkflowMode = task.workflowMode || workflowMode;
    let localEdit = task.localEdit?.cropFile && task.localEdit?.cropRect
      ? task.localEdit
      : task.modelItem?.localEdit?.cropFile && task.modelItem?.localEdit?.cropRect
        ? task.modelItem.localEdit
        : null;
    if (shouldUseExactBanana2LocalCrop(settings.model, localEdit)) {
      const exactCropped = await cropOutfitLocalEditFile(task.modelItem, localEdit.cropRect, "banana2_local_edit", { withContext: false });
      localEdit = {
        ...localEdit,
        cropFile: exactCropped.file,
        contextRect: null
      };
    }
    const taskAspectRatio = localEdit?.aspectRatio || task.aspectRatio || settings.aspectRatio;
    const modelUploadFile = localEdit?.cropFile || task.modelItem.file;
    setClockNow(startedAt);
    setTasks((current) => current.map((item) => item.id === task.id ? { ...item, sessionId: OUTFIT_SESSION_ID, status: "running", startedAt, error: "", errorDetail: "" } : item));
    const form = new FormData();
    form.append("payload", JSON.stringify({
      taskId: task.id,
      apiKey: effectiveApiKey,
      model: settings.model,
      imageSize: settings.imageSize,
      aspectRatio: taskAspectRatio,
      prompt: settings.prompt,
      productNote: settings.productNote,
      smartIntervention: settings.smartIntervention,
      garmentParts: isOutfitWorkflow ? normalizeGarmentParts(settings.garmentParts) : undefined,
      garmentLengths: isOutfitWorkflow ? normalizeGarmentLengths(settings.garmentLengths, settings.garmentParts) : undefined,
      workflowMode: taskWorkflowMode,
      pageName: task.pageName || activeOutfitPage.name,
      uploadLabels: task.uploadLabels || uploadLabels,
      modelImageCount: task.modelImageCount || 1,
      referenceCount: (task.referenceItems || []).length,
      pairingMode: settings.pairingMode,
      preprocessMode: settings.preprocessMode,
      deferAutoSave: Boolean(localEdit),
      localEdit: localEdit ? {
        enabled: true,
        editMode: localEdit.editMode || LOCAL_EDIT_RECT_MODE,
        aspectRatio: taskAspectRatio,
        cropRect: localEdit.cropRect,
        contextRect: localEdit.contextRect || null,
        sourceWidth: localEdit.sourceWidth,
        sourceHeight: localEdit.sourceHeight,
        maskBounds: localEdit.maskBounds || null
      } : null
    }));
    form.append("image", modelUploadFile, `model_${task.order}_${task.modelItem.name}`);
    if (taskWorkflowMode === "design-draft") {
      (task.extraModelItems || []).forEach((item, index) => form.append("image", item.file, `model_ref_${index + 2}_${item.name}`));
    }
    form.append("image", task.clothingItem.file, `clothing_${task.order}_${task.clothingItem.name}`);
    (task.referenceItems || []).forEach((item, index) => form.append("image", item.file, `ref_${index + 1}_${item.name}`));

    const response = await fetch("/api/generate-outfit", { method: "POST", body: form });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) {
      const errorParts = [payload?.message, ...(Array.isArray(payload?.errors) ? payload.errors : [])]
        .filter(Boolean);
      const error = new Error(payload?.message || `HTTP ${response.status}`);
      error.detail = [...new Set(errorParts)].join("\n") || error.message;
      throw error;
    }
    const finishedAt = Date.now();
    const timingMs = Number.isFinite(payload.timingMs) && payload.timingMs > 0
      ? payload.timingMs
      : Math.max(1, finishedAt - startedAt);
    let resultImage = payload.image;
    let displayImage = null;
    if (localEdit) {
      const originalFile = task.modelItem?.originalFile || task.modelItem?.file;
      const generatedBlob = await blobFromOutfitImage(payload.image);
      const preciseGptLocalComposite = /^gpt-image$/i.test(String(settings.model || ""));
      const composedBlob = await composeOutfitLocalEditBlob(originalFile, generatedBlob, localEdit.cropRect, localEdit, preciseGptLocalComposite ? {
        autoAlign: true,
        maxShift: 7,
        rectFeatherRatio: 0.045,
        rectFeatherMax: 48
      } : {});
      const dataUrl = await dataUrlFromBlob(composedBlob);
      const cachedUrl = URL.createObjectURL(composedBlob);
      await preloadImageUrl(cachedUrl);
      resultImage = {
        type: "b64_json",
        value: dataUrl,
        mimeType: "image/jpeg",
        cachedUrl,
        localEdit: {
          enabled: true,
          editMode: localEdit.editMode || LOCAL_EDIT_RECT_MODE,
          sourceName: task.modelItem?.name || "",
          cropRect: localEdit.cropRect,
          contextRect: localEdit.contextRect || null,
          sourceWidth: localEdit.sourceWidth,
          sourceHeight: localEdit.sourceHeight,
          maskBounds: localEdit.maskBounds || null
        }
      };
      displayImage = resultImage;
    } else {
      displayImage = await cacheResultImageBlob(resultImage);
    }
    setClockNow(finishedAt);
    setTasks((current) => current.map((item) => {
      if (item.id !== task.id) return item;
      if (item.result?.cachedUrl && item.result.cachedUrl !== displayImage?.cachedUrl) {
        revokeResultImageRuntimeCache(item.result);
      }
      return {
        ...item,
        status: "success",
        result: displayImage,
        prompt: payload.prompt,
        timingMs,
        error: "",
        errorDetail: "",
        autoSaveFailed: false,
        finishedAt,
        aspectRatio: taskAspectRatio
      };
    }));
    void autoSaveTask({ ...task, result: resultImage, prompt: payload.prompt, aspectRatio: taskAspectRatio }, resultImage);
  }

  async function startBatch() {
    if (running && !canAppendWhileRunning) return;
    if (!effectiveApiKey) {
      addEvent("缺少 Key", "请先填写 API Key");
      openSettings();
      return;
    }
    const taskCount = isDesignDraftWorkflow ? 1 : Math.min(plannedGenerationCount, MAX_UPLOAD_IMAGES);
    const baseOrder = tasks.length;
    const taskDrafts = buildTasks(taskCount).map((task, index) => ({
      ...task,
      order: baseOrder + index + 1
    }));
    const nextTasks = await Promise.all(taskDrafts.map((task) => attachTaskReferenceThumbs(task).catch(() => task)));
    if (!nextTasks.length) {
      addEvent("无法开始", isDesignDraftWorkflow
        ? "至少上传 1 张图1实拍参考和 1 张图2设计稿参考"
        : isBackgroundChangeWorkflow
          ? "至少上传 1 张图1人物图和 1 张图2场景图"
          : isFaceSwapWorkflow
            ? "至少上传 1 张图1目标人物图和 1 张图2人脸参考图"
            : "至少选择 1 张模特图和 1 张服装图");
      return;
    }
    if (!isDesignDraftWorkflow && nextTasks.length < plannedGenerationCount) {
      addEvent(isBackgroundChangeWorkflow ? "批量换背景" : isFaceSwapWorkflow ? "批量换脸" : "批量换装", `按当前配对规则只能创建 ${nextTasks.length}/${plannedGenerationCount} 个任务`);
    }

    setTasks((current) => [...current, ...nextTasks]);
    beginGenerationRun();
    addEvent(
      isDesignDraftWorkflow ? "设计稿" : isBackgroundChangeWorkflow ? "批量换背景" : isFaceSwapWorkflow ? "批量换脸" : "批量换装",
      `已创建 ${nextTasks.length} 个任务，${isDesignDraftWorkflow ? "设计稿SKILL" : isBackgroundChangeWorkflow ? settings.smartIntervention ? "换背景智能文本" : "换背景常规文本" : isFaceSwapWorkflow ? settings.smartIntervention ? "换脸智能文本" : "换脸常规文本" : settings.smartIntervention ? "智能介入" : "常规模式"}`
    );

    let cursor = 0;
    const workerCount = Math.min(Math.max(1, isDesignDraftWorkflow ? 1 : settings.concurrency), nextTasks.length);
    async function worker() {
      while (cursor < nextTasks.length) {
        const index = cursor;
        cursor += 1;
        const task = nextTasks[index];
        try {
          await runSingleTask(task);
        } catch (error) {
          const errorDetail = error?.detail || (error instanceof Error ? error.message : String(error));
          const errorSummary = error instanceof Error ? error.message : String(error);
          setTasks((current) => current.map((item) => item.id === task.id ? {
            ...item,
            status: "failed",
            error: summarizeGenerationError(errorSummary),
            errorDetail,
            finishedAt: Date.now()
          } : item));
        }
      }
    }

    try {
      await Promise.all(Array.from({ length: workerCount }, () => worker()));
    } finally {
      endGenerationRun();
    }
    addEvent(isDesignDraftWorkflow ? "设计稿" : isBackgroundChangeWorkflow ? "批量换背景" : isFaceSwapWorkflow ? "批量换脸" : "批量换装", "任务队列已完成");
  }

  async function retryTask(task) {
    if (running && !canAppendWhileRunning) return;
    beginGenerationRun();
    try {
      await runSingleTask({ ...task, status: "queued", error: "", result: null });
    } catch (error) {
      const errorDetail = error instanceof Error ? error.message : String(error);
      setTasks((current) => current.map((item) => item.id === task.id ? {
        ...item,
        status: "failed",
        error: summarizeGenerationError(errorDetail),
        errorDetail
      } : item));
    } finally {
      endGenerationRun();
    }
  }

  function scrollWorkspaceToTop() {
    workspaceRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  }

  function scrollToSection(id) {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function switchView(view) {
    setActiveView(view);
    if (view === "outfit") {
      const target = outfitPages.find((page) => inferOutfitWorkflowMode(page.name, page.uploadLabels) === "outfit");
      if (target && target.id !== activeOutfitPageId) {
        switchOutfitPage(target.id);
      }
    }
    window.requestAnimationFrame(() => {
      workspaceRef.current?.scrollTo({ top: 0, behavior: "auto" });
    });
  }

  function renderResultQueue() {
    return (
      <section className="resultPanel queuePanel" id="result-archive-section">
        <div className="taskGrid" ref={taskGridRef} style={{ "--asset-card-min": `${galleryCardMin}px` }}>
          {visibleTasks.map((task) => {
            const selected = selectedTaskIds.has(task.id);
            const durationMs = taskDurationMs(task, clockNow);
            const fallbackReferences = taskReferencePreviewItems(task);
            const storedReferences = sanitizeTaskReferenceThumbs(task.referenceThumbs);
            const references = storedReferences.length ? storedReferences : fallbackReferences;
            const referenceCount = Math.max(
              Number(task.referenceCount || 0),
              references.length,
              fallbackReferences.length
            );

            if (task.status !== "success") {
              const failed = task.status === "failed";
              const runningTask = task.status === "running";
              return (
                <article className={`assetCard loadingCard outfitAssetCard ${task.status} ${selected ? "selected" : ""}`} key={task.id}>
                  <button
                    className="selectBox"
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      toggleTaskSelected(task.id);
                    }}
                    aria-label={selected ? "取消选中" : "选择图片"}
                  >
                    {selected ? <CheckSquare size={24} /> : <Square size={24} />}
                  </button>
                  {runningTask ? <Loader2 className="spin" size={28} /> : <Sparkles size={28} />}
                  <span>{taskStatusLabel(task.status)}</span>
                  <strong>{runningTask ? formatMs(Math.max(durationMs || 0, 1000)) : `${task.imageSize || settings.imageSize} · ${task.aspectRatio || settings.aspectRatio}`}</strong>
                  <em>{task.modelLabel || settings.model}</em>
                  {failed && (
                    <button className="assetRetryButton" type="button" onClick={() => retryTask(task)}>
                      重试
                    </button>
                  )}
                  {task.error && <p className="assetError" title={task.errorDetail || task.error}>{task.error}</p>}
                </article>
              );
            }

            const promptText = task.prompt || settings.prompt;
            const src = imageSource(task.result);
            return (
              <article
                className={`assetCard outfitAssetCard success ${selected ? "selected" : ""}`}
                key={task.id}
                onClick={() => setPreview(task)}
              >
                <button
                  className="selectBox"
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    toggleTaskSelected(task.id);
                  }}
                  aria-label={selected ? "取消选中" : "选择图片"}
                >
                  {selected ? <CheckSquare size={24} /> : <Square size={24} />}
                </button>
                <button
                  className={`assetDownloadButton ${downloadFeedbackIds.has(task.id) ? "downloaded" : ""}`}
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    void downloadTask(task);
                  }}
                  title="下载到指定文件夹"
                  aria-label="下载到指定文件夹"
                >
                  {downloadFeedbackIds.has(task.id) ? <Check size={16} /> : <Download size={16} />}
                </button>
                {Number.isFinite(durationMs) && durationMs > 0 && <div className="assetTimeBadge">用时 {formatMs(durationMs)}</div>}
                <img src={src} alt={`AI换装结果 ${task.order || ""}`} decoding="async" loading="eager" />
                <ReferenceThumbTray
                  references={references}
                  count={referenceCount}
                  className="assetReferenceTray"
                  onOpen={(reference) => setImageLightbox({ title: reference.name || reference.label || "参考图", src: referenceSource(reference) })}
                  onContextMenu={openReferenceContextMenu}
                />
                {promptText && (
                  <button
                    className="assetPrompt"
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      void copyText(promptText, "提示词已复制");
                    }}
                    title={promptText}
                  >
                    {promptText}
                  </button>
                )}
                <div className="assetMeta">
                  <span>{task.modelLabel || settings.model}</span>
                  <strong>{task.imageSize || settings.imageSize} · {task.aspectRatio || settings.aspectRatio}</strong>
                </div>
              </article>
            );
          })}
          {visibleTasks.length === 0 && (
            <div className="emptyTasks">
              <Sparkles size={28} />
              <span>{resultFilter === "video" ? "视频模块暂未接入。" : "上传模特图和服装图后，点击生成。"}</span>
            </div>
          )}
        </div>
      </section>
    );
  }

  return (
    <main className="appShell outfitWorkflowEmbedded" style={themeStyle}>
      <aside className="sidebar">
        <div className="brand">
          <img src="/app-avatar.webp" alt="" />
          <div>
            <h1>静音AI换装</h1>
            <span>批量换装流水线</span>
          </div>
        </div>
        <nav>
          <button className={activeView === "quick" ? "active" : ""} type="button" onClick={() => switchView("quick")}><Sparkles size={18} /> 快捷生成</button>
          <button className={activeView === "outfit" ? "active" : ""} type="button" onClick={() => switchView("outfit")}><Wand2 size={18} /> 批量生成</button>
          <button className={activeView === "resize" ? "active" : ""} type="button" onClick={() => switchView("resize")}><Crop size={18} /> 批量改尺寸</button>
          <button className={activeView === "reference" ? "active" : ""} type="button" onClick={() => switchView("reference")}><Images size={18} /> 参考生图</button>
          <button className={activeView === "detail" ? "active" : ""} type="button" onClick={() => switchView("detail")}><BookOpen size={18} /> 一键详情/主图</button>
          <button className={activeView === "prompt" ? "active" : ""} type="button" onClick={() => switchView("prompt")}><BookOpen size={18} /> 提示词助手</button>
          <button className={activeView === "local" ? "active" : ""} type="button" onClick={() => switchView("local")}><Sparkles size={18} /> 局部细节修改</button>
        </nav>
        <button className="settingsEntry" type="button" onClick={openSettings}>
          <Settings size={18} />
          <span>设置</span>
        </button>
        <div className="statusBox">
          <strong>{completedCount}/{tasks.length || 0}</strong>
          <span>完成任务</span>
          {failedCount > 0 && <em>{failedCount} 个失败</em>}
        </div>
      </aside>

      <section className="workspace" ref={workspaceRef} onPaste={activeView === "outfit" ? handleWorkspacePaste : undefined}>
        <section className={`viewPanel ${activeView === "quick" ? "active" : ""}`}>
          <LegacyModulePanel
            title="快捷生成"
            subtitle="独立栏目，保留老版本入口；不读取 AI换装的上传图和任务队列。"
            icon={<Sparkles size={22} />}
          >
            <div className="legacyGrid">
              <button className="legacyAction" type="button" onClick={() => switchView("outfit")}>
                <Images size={18} />
                <span>去 AI换装生成</span>
              </button>
              <button className="legacyAction" type="button" onClick={openSettings}>
                <Lock size={18} />
                <span>设置 Key</span>
              </button>
            </div>
          </LegacyModulePanel>
        </section>

        <section className={`viewPanel ${activeView === "reference" ? "active" : ""}`}>
          <LegacyModulePanel
            title="参考生图"
            subtitle="独立栏目，后续迁移参考生图时会使用独立上传区和独立历史。"
            icon={<Images size={22} />}
          >
            <div className="legacyGrid">
              <button className="legacyAction" type="button" onClick={() => switchView("outfit")}>
                <Upload size={18} />
                <span>使用当前换装上传区</span>
              </button>
              <button className="legacyAction" type="button" onClick={() => setIsPromptAssistantOpen(true)}>
                <BookOpen size={18} />
                <span>打开提示词</span>
              </button>
            </div>
          </LegacyModulePanel>
        </section>

        <section className={`viewPanel ${activeView === "detail" ? "active" : ""}`}>
          <LegacyModulePanel
            title="一键详情/主图"
            subtitle="独立栏目，保留老版本入口；不和 AI换装生成结果互相写入。"
            icon={<BookOpen size={22} />}
          >
            <div className="legacyGrid">
              <button className="legacyAction" type="button" onClick={() => void openSaveDirectory()}>
                <FolderOpen size={18} />
                <span>打开保存目录</span>
              </button>
              <button className="legacyAction" type="button" onClick={() => switchView("outfit")}>
                <Wand2 size={18} />
                <span>返回 AI换装</span>
              </button>
            </div>
          </LegacyModulePanel>
        </section>

        <section className={`viewPanel ${activeView === "prompt" ? "active" : ""}`}>
          <LegacyModulePanel
            title="提示词助手"
            subtitle="提示词库独立管理，可拖拽分类、编辑、搜索和应用到当前 AI换装提示词。"
            icon={<BookOpen size={22} />}
          >
            <div className="promptAssistantDock">
              <div className="promptTabs">
                {promptCategories.map((category) => (
                  <button
                    className={`promptTab ${promptCategory === category ? "active" : ""} ${promptDropCategory === category ? "dropTarget" : ""}`}
                    key={category}
                    type="button"
                    onClick={() => setPromptCategory(category)}
                    onDoubleClick={(event) => {
                      if (category === "全部") return;
                      event.preventDefault();
                      event.stopPropagation();
                      renamePromptCategory(category);
                    }}
                    onDragOver={(event) => {
                      if (category === "全部") return;
                      event.preventDefault();
                      setPromptDropCategory(category);
                    }}
                    onDragLeave={() => setPromptDropCategory("")}
                    onDrop={(event) => dropPromptOnCategory(event, category)}
                  >
                    {category}
                  </button>
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
                      onClick={() => schedulePromptPresetApply(preset)}
                      onDoubleClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        renamePromptPresetTitle(preset);
                      }}
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
          </LegacyModulePanel>
        </section>

        <section className={`viewPanel ${activeView === "outfit" ? "active" : ""}`}>
        <header className="topbar">
          <div className="resultTabs">
            <button className={`tabButton ${resultFilter === "all" ? "active" : ""}`} type="button" onClick={() => setResultFilter("all")}>
              全部({tasks.length})
            </button>
            <button className={`tabButton ${resultFilter === "image" ? "active" : ""}`} type="button" onClick={() => setResultFilter("image")}>
              <Images size={14} />
              <span>图片({imageCount})</span>
            </button>
            <button className="tabButton" type="button" onClick={() => setResultFilter("video")}>
              <Video size={14} />
              <span>视频(0)</span>
            </button>
            <button
              className="outfitPageNameChip"
              type="button"
              onDoubleClick={() => renameOutfitPage(activeOutfitPageId)}
              title="双击修改页面名称"
            >
              <Pencil size={13} />
              <span>{activeOutfitPage.name}</span>
            </button>
          </div>
          <div className="topActions">
            <button className="toolbarButton" type="button" onClick={() => void refreshHistory()}>
              <RefreshCw size={15} />
              <span>刷新</span>
            </button>
            <button className="toolbarButton" type="button" onClick={openDirectoryModal}>
              <FolderOpen size={15} />
              <span>指定文件夹</span>
            </button>
            <button className="toolbarButton" type="button" onClick={() => void openSaveDirectory()}>
              <FolderOpen size={15} />
              <span>打开保存目录</span>
            </button>
            <span className={`taskBadge task-${topbarStatus}`}>{topbarStatusText}</span>
            <button className="toolbarButton" type="button" onClick={downloadSelected} disabled={selectedCompletedCount === 0}>
              <Download size={15} />
              <span>下载选中</span>
            </button>
            <button className="toolbarButton" type="button" onClick={downloadAll} disabled={imageCount === 0}>
              <Download size={15} />
              <span>下载全部</span>
            </button>
            <button className="dangerButton" type="button" onClick={deleteSelected} disabled={selectedCount === 0}>
              <Trash2 size={15} />
              <span>删除选中</span>
            </button>
            <button className="dangerButton" type="button" onClick={clearAll}>
              <Trash2 size={15} />
              <span>清空全部</span>
            </button>
            <button className="toolbarButton" type="button" onClick={() => void clearNonResultImageCache()}>
              <RefreshCw size={15} />
              <span>清缓存</span>
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
          </div>
        </header>

        {renderResultQueue()}

        <section className="assetGrid">
          <UploadZone
            primary
            title={`图1：${uploadLabels.model.title}`}
            hint={uploadLabels.model.hint}
            slotPrefix="图1："
            titleText={uploadLabels.model.title}
            hintText={uploadLabels.model.hint}
            onEditTitle={() => editUploadLabel("model", "title")}
            onEditHint={() => editUploadLabel("model", "hint")}
            items={modelImages}
            onPick={(files) => addImages("model", files)}
            onRemove={(id) => removeImage("model", id)}
            onToggle={(id) => toggleImage("model", id)}
            onReorder={(fromId, toId, placement) => reorderImage("model", fromId, toId, placement)}
            onReplace={(id, file) => void replaceImage("model", id, file)}
            onClear={() => clearImageGroup("model")}
            onPreview={(item) => setImageLightbox({ title: item.name, src: item.previewUrl })}
            onOpenCrop={(item) => setCropTarget({ group: "model", item })}
            onOpenLocalEdit={(item) => openLocalEdit("model", item)}
            localEditEnabled={!isDesignDraftWorkflow}
            maxCount={MAX_UPLOAD_IMAGES}
            onLimit={(message) => addEvent("图1上传", message)}
            onActivate={() => setActiveUploadGroup("model")}
            bulkMode={modelBulkMode}
            onBulkModeChange={(mode) => void applyGroupPreprocess("model", mode)}
          />
          <div className="assetSide">
            <UploadZone
              compact
              title={`图2：${uploadLabels.clothing.title}`}
              hint={uploadLabels.clothing.hint}
              slotPrefix="图2："
              titleText={uploadLabels.clothing.title}
              hintText={uploadLabels.clothing.hint}
              onEditTitle={() => editUploadLabel("clothing", "title")}
              onEditHint={() => editUploadLabel("clothing", "hint")}
              items={clothingImages}
              onPick={(files) => addImages("clothing", files)}
              onRemove={(id) => removeImage("clothing", id)}
              onToggle={(id) => toggleImage("clothing", id)}
              onReorder={(fromId, toId, placement) => reorderImage("clothing", fromId, toId, placement)}
              onReplace={(id, file) => void replaceImage("clothing", id, file)}
              onClear={() => clearImageGroup("clothing")}
              onSetFixed={setFixedClothingId}
              fixedId={fixedClothingId}
              onPreview={(item) => setImageLightbox({ title: item.name, src: item.previewUrl })}
              onOpenCrop={(item) => setCropTarget({ group: "clothing", item })}
              maxCount={MAX_UPLOAD_IMAGES}
              onLimit={(message) => addEvent("图2上传", message)}
              onActivate={() => setActiveUploadGroup("clothing")}
              bulkMode={clothingBulkMode}
              onBulkModeChange={(mode) => void applyGroupPreprocess("clothing", mode)}
              footerControls={isOutfitWorkflow ? (
                <div className="garmentTransferControls" aria-label="图2服装迁移设置">
                  <div className="garmentPartPicker" aria-label="图2换装部位">
                    {GARMENT_PART_OPTIONS.map((part) => {
                      const active = selectedGarmentParts.includes(part.value);
                      return (
                        <button
                          className={active ? "active" : ""}
                          key={part.value}
                          type="button"
                          onClick={() => toggleGarmentPart(part.value)}
                          aria-pressed={active}
                          title={`图2迁移${part.label}`}
                        >
                          <Check size={13} />
                          <span>{part.label}</span>
                        </button>
                      );
                    })}
                  </div>
                  <div className="garmentLengthControls" aria-label="图2服装长度">
                    <label className={!upperLengthEnabled ? "disabled" : ""}>
                      <span>上装长度</span>
                      <select
                        value={activeGarmentLengths.upper}
                        disabled={!upperLengthEnabled}
                        onChange={(event) => updateGarmentLength("upper", event.target.value)}
                      >
                        {GARMENT_LENGTH_OPTIONS.map((option) => (
                          <option key={option.value || "none"} value={option.value}>{option.label}</option>
                        ))}
                      </select>
                    </label>
                    <label className={!lowerLengthEnabled ? "disabled" : ""}>
                      <span>下装长度</span>
                      <select
                        value={activeGarmentLengths.lower}
                        disabled={!lowerLengthEnabled}
                        onChange={(event) => updateGarmentLength("lower", event.target.value)}
                      >
                        {GARMENT_LENGTH_OPTIONS.map((option) => (
                          <option key={option.value || "none"} value={option.value}>{option.label}</option>
                        ))}
                      </select>
                    </label>
                  </div>
                </div>
              ) : null}
            />
            <UploadZone
              compact
              title={`图3：${uploadLabels.reference.title}`}
              hint={uploadLabels.reference.hint}
              slotPrefix="图3："
              titleText={uploadLabels.reference.title}
              hintText={uploadLabels.reference.hint}
              onEditTitle={() => editUploadLabel("reference", "title")}
              onEditHint={() => editUploadLabel("reference", "hint")}
              items={referenceImages}
              onPick={(files) => addImages("reference", files)}
              onRemove={(id) => removeImage("reference", id)}
              onToggle={(id) => toggleImage("reference", id)}
              onReorder={(fromId, toId, placement) => reorderImage("reference", fromId, toId, placement)}
              onReplace={(id, file) => void replaceImage("reference", id, file)}
              onClear={() => clearImageGroup("reference")}
              onPreview={(item) => setImageLightbox({ title: item.name, src: item.previewUrl })}
              onOpenCrop={(item) => setCropTarget({ group: "reference", item })}
              maxCount={MAX_UPLOAD_IMAGES}
              onLimit={(message) => addEvent("图3上传", message)}
              onActivate={() => setActiveUploadGroup("reference")}
              bulkMode={referenceBulkMode}
              onBulkModeChange={(mode) => void applyGroupPreprocess("reference", mode)}
            />
          </div>
        </section>

        <section className="originalLibraryPanel">
          <header>
            <div>
              <h3>原图库</h3>
              <span>保留你上传的原始图片，方便后续重新取细节。</span>
            </div>
            <span>{originalLibrary.length} 张</span>
          </header>
          <div className="originalLibraryGrid">
            {originalLibrary.map((item) => (
              <article className="originalLibraryCard" key={item.id}>
                <button type="button" onClick={() => setImageLightbox({ title: item.name, src: item.url })}>
                  <img src={item.url} alt="" />
                </button>
                <div>
                  <strong title={item.name}>{item.name}</strong>
                  <span>{fileSize(item.size)}</span>
                </div>
                <button type="button" onClick={() => removeOriginalImage(item.id)}>
                  <Trash2 size={13} />
                </button>
              </article>
            ))}
            {originalLibrary.length === 0 && (
              <div className="emptyOriginal">
                <Crop size={22} />
                <span>上传后会自动保留原图副本</span>
              </div>
            )}
          </div>
        </section>

        <section className="composerPanel">
          <div className="composerHeader">
            <div className="composerTabs">
              <button className="active" type="button">图片换装</button>
            </div>
          </div>

          <label className="composerField">
            <span>{promptFieldTitle}</span>
            <textarea
              value={settings.prompt}
              onChange={(event) => updateSetting("prompt", event.target.value)}
              onKeyDown={handlePromptKeyDown}
              placeholder={promptFieldPlaceholder}
            />
          </label>

          <label className="composerField composerNote">
            <span>本次需求 / 商品补充信息</span>
            <textarea
              value={settings.productNote}
              onChange={(event) => updateSetting("productNote", event.target.value)}
              onKeyDown={handlePromptKeyDown}
              placeholder="只写这次要额外控制的内容，例如袖长、裙长、SKU颜色、背景、鞋包是否保留。"
            />
          </label>

          <div className="composerStickyControls">
            <div className="composerFooter">
              <div className="composerPageRow">
                <div className="leftTools">
                  <button className="smallButton" type="button" onClick={() => setIsPromptAssistantOpen(true)}>
                    <BookOpen size={16} />
                    <span>词</span>
                  </button>
                </div>

                <div className="outfitPageDock" role="tablist" aria-label="批量生成页面">
                  {outfitPages.map((page) => (
                    <button
                      className={`outfitPageTab ${page.id === activeOutfitPageId ? "active" : ""} ${draggedPageId === page.id ? "dragging" : ""} ${pageDropTarget?.id === page.id ? `drop-${pageDropTarget.placement}` : ""}`}
                      type="button"
                      key={page.id}
                      role="tab"
                      aria-selected={page.id === activeOutfitPageId}
                      onClick={() => switchOutfitPage(page.id)}
                      onDoubleClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        renameOutfitPage(page.id);
                      }}
                      onDragOver={(event) => updateOutfitPageDropTarget(event, page.id)}
                      onDragLeave={() => setPageDropTarget((current) => current?.id === page.id ? null : current)}
                      onDrop={(event) => dropOutfitPage(event, page.id)}
                      onDragEnd={endOutfitPageDrag}
                      title="单击切换，双击改名，拖拽排序"
                    >
                      <span
                        className="outfitPageDragHandle"
                        draggable
                        onClick={(event) => event.stopPropagation()}
                        onDoubleClick={(event) => event.stopPropagation()}
                        onDragStart={(event) => beginOutfitPageDrag(event, page.id)}
                        title="拖拽排序"
                      >
                        <Move size={12} />
                      </span>
                      <span>{page.name}</span>
                    </button>
                  ))}
                  <button className="outfitPageAdd" type="button" onClick={createOutfitPageFromCurrent} title="新建批量生成页面">
                    <Plus size={16} />
                  </button>
                  <button
                    className={`outfitPageLock ${activePageDeleteLocked ? "locked" : ""}`}
                    type="button"
                    onClick={() => toggleOutfitPageDeleteLock(activeOutfitPageId)}
                    aria-pressed={activePageDeleteLocked}
                    title={activePageDeleteLocked ? "当前页已防误删，点击解除" : "锁定当前页删除，防止误删"}
                  >
                    {activePageDeleteLocked ? <Lock size={15} /> : <Unlock size={15} />}
                  </button>
                  <button
                    className="outfitPageDelete"
                    type="button"
                    onClick={() => deleteOutfitPage(activeOutfitPageId)}
                    title="删除当前页面"
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
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
                <select className={globalBulkMode === "mixed" ? "mixed" : ""} value={globalBulkMode} onChange={(event) => void applyGlobalPreprocess(event.target.value)}>
                  <option value="mixed" disabled>混合状态</option>
                  {globalBulkMode === "crop" && <option value="crop" disabled>{preprocessModeLabel("crop")}</option>}
                  {PREPROCESS_OPTIONS.filter((option) => option.value !== "crop").map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
                <select value={settings.pairingMode} onChange={(event) => updateSetting("pairingMode", event.target.value)}>
                  <option value="fixed">{isBackgroundChangeWorkflow ? "固定场景" : isFaceSwapWorkflow ? "固定人脸" : "固定服装"}</option>
                  <option value="sequence">{isBackgroundChangeWorkflow ? "人物场景一一对应" : isFaceSwapWorkflow ? "人物人脸一一对应" : "按顺序一一对应"}</option>
                  <option value="cycle">{isBackgroundChangeWorkflow ? "场景循环配对" : isFaceSwapWorkflow ? "人脸循环配对" : "服装循环配对"}</option>
                </select>
                <select value={generationCount} onChange={(event) => updateSetting("generationCount", event.target.value)}>
                  {GENERATION_COUNT_OPTIONS.map((count) => (
                    <option key={count} value={count}>{count === "auto" ? `数量(${plannedGenerationCount})` : `数量 ${count}`}</option>
                  ))}
                </select>
                <button
                  className={`smartInterventionSwitch ${settings.smartIntervention ? "on" : ""}`}
                  type="button"
                  onClick={() => updateSetting("smartIntervention", !settings.smartIntervention)}
                  aria-pressed={settings.smartIntervention}
                  title="切换文本模型介入"
                >
                  <span>{settings.smartIntervention ? "智能文本" : "常规文本"}</span>
                  <i aria-hidden="true"><b /></i>
                </button>
                <button className="generateButton" type="button" onClick={() => void startBatch()} disabled={running && !canAppendWhileRunning}>
                  {running ? <Loader2 className="spin" size={17} /> : <Play size={17} />}
                  <span>生成</span>
                </button>
              </div>
            </div>
            {inlineMessage && <div className="composerStatus">{inlineMessage}</div>}
          </div>
        </section>

        </section>

        <section className={`viewPanel ${activeView === "resize" ? "active" : ""}`}>
          <header className="moduleHeader">
            <div>
              <h2>批量改尺寸</h2>
              <span>独立本地处理栏目，只负责批量缩放、补边、裁剪和导出。</span>
            </div>
          </header>
          <BatchResizePanel
            saveDirectory={saveDirectory}
            onChooseDirectory={openDirectoryModal}
            onOpenSaveDirectory={() => void openSaveDirectory()}
            onSaveImage={saveExportedImageToFolder}
            onAddEvent={addEvent}
          />
        </section>

        <section className={`viewPanel ${activeView === "local" ? "active" : ""}`}>
          <LocalDetailPanel
            saveDirectory={saveDirectory}
            onChooseDirectory={openDirectoryModal}
            onOpenSaveDirectory={() => void openSaveDirectory()}
            onSaveImage={saveExportedImageToFolder}
            onAddEvent={addEvent}
            onPreview={setImageLightbox}
            defaultRatio={settings.aspectRatio}
          />
        </section>

      </section>

      {isSettingsOpen && !embeddedMode && (
        <div className="modalLayer" onMouseDown={() => setIsSettingsOpen(false)}>
          <section className="settingsModal" onMouseDown={(event) => event.stopPropagation()}>
            <header>
              <div>
                <h2>设置</h2>
                <span>API Key 与界面皮肤</span>
              </div>
              <button className="iconButton" type="button" onClick={() => setIsSettingsOpen(false)}>
                <X size={18} />
              </button>
            </header>

            <label className="modalField">
              <span><Lock size={15} /> API Key</span>
              <div className="apiKeyRow">
                <input
                  type={showKey ? "text" : "password"}
                  value={apiKeyDraft}
                  placeholder="sk-..."
                  onChange={(event) => setApiKeyDraft(event.target.value)}
                />
                <button className="iconButton" type="button" onClick={() => setShowKey((value) => !value)} title={showKey ? "隐藏 API Key" : "显示 API Key"}>
                  {showKey ? <EyeOff size={17} /> : <Eye size={17} />}
                </button>
                <button className="smallButton saveKeyButton" type="button" onClick={saveSettings}>
                  <Save size={15} />
                  <span>保存</span>
                </button>
              </div>
              {apiSaveStatus && <small>{apiSaveStatus}</small>}
            </label>

            <div className="skinBlock">
              <span><Palette size={15} /> 皮肤</span>
              <div className="themeGrid">
                {THEME_OPTIONS.map((theme) => (
                  <button
                    className={`themeButton ${effectiveTheme === theme.value ? "selected" : ""}`}
                    key={theme.value}
                    type="button"
                    onClick={() => updateSetting("theme", theme.value)}
                  >
                    <i>{theme.colors.map((color) => <b key={color} style={{ backgroundColor: color }} />)}</i>
                    <span>{theme.label}</span>
                  </button>
                ))}
              </div>
            </div>
          </section>
        </div>
      )}

      {isDirectoryModalOpen && (
        <div className="modalLayer" onMouseDown={() => setIsDirectoryModalOpen(false)}>
          <section className="saveDirectoryModal" onMouseDown={(event) => event.stopPropagation()}>
            <header>
              <div>
                <h2>指定文件夹</h2>
                <span>下载图片会保存到这个目录</span>
              </div>
              <button className="iconButton" type="button" onClick={() => setIsDirectoryModalOpen(false)}>
                <X size={18} />
              </button>
            </header>
            <label className="modalField">
              <span><FolderOpen size={15} /> 保存目录</span>
              <input
                value={directoryDraft}
                readOnly
                onClick={() => void pickSaveDirectory()}
                placeholder="点击选择保存目录"
                title="点击选择保存目录"
              />
              <small>{isPickingDirectory ? "正在等待目录选择..." : "点击输入框选择目录，点确定后生效"}</small>
            </label>
            <footer className="directoryModalActions">
              <button className="secondaryButton" type="button" onClick={() => setIsDirectoryModalOpen(false)}>取消</button>
              <button className="primaryButton" type="button" onClick={() => void confirmSaveDirectory()}>
                <Save size={16} />
                <span>确定</span>
              </button>
            </footer>
          </section>
        </div>
      )}

      {isPromptAssistantOpen && (
        <div className="modalLayer promptLayer" onMouseDown={() => setIsPromptAssistantOpen(false)}>
          <section className="promptAssistantModal" onMouseDown={(event) => event.stopPropagation()}>
            <header>
              <h2>提示词助手</h2>
              <button className="iconButton" type="button" onClick={() => setIsPromptAssistantOpen(false)}>
                <X size={18} />
              </button>
            </header>
            <div className="promptAssistantBody">
              <div className="promptTabs">
                {promptCategories.map((category) => (
                  <button
                    className={`promptTab ${promptCategory === category ? "active" : ""} ${promptDropCategory === category ? "dropTarget" : ""}`}
                    key={category}
                    type="button"
                    onClick={() => setPromptCategory(category)}
                    onDoubleClick={(event) => {
                      if (category === "全部") return;
                      event.preventDefault();
                      event.stopPropagation();
                      renamePromptCategory(category);
                    }}
                    onDragOver={(event) => {
                      if (category === "全部") return;
                      event.preventDefault();
                      setPromptDropCategory(category);
                    }}
                    onDragLeave={() => setPromptDropCategory("")}
                    onDrop={(event) => dropPromptOnCategory(event, category)}
                  >
                    {category}
                  </button>
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
                      onClick={() => schedulePromptPresetApply(preset)}
                      onDoubleClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        renamePromptPresetTitle(preset);
                      }}
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
              <button className="iconButton" type="button" onClick={() => setEditingPrompt(null)}>
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
              <button className="secondaryButton" type="button" onClick={() => setEditingPrompt(null)}>取消</button>
              <button className="primaryButton" type="button" onClick={saveEditingPrompt}>
                <Save size={16} />
                <span>保存</span>
              </button>
            </footer>
          </section>
        </div>
      )}

      {cropTarget && (
        <CropModal
          item={cropTarget.item}
          ratio={settings.aspectRatio}
          onClose={() => setCropTarget(null)}
          onApply={(item) => applyCropItem(cropTarget.group, item)}
        />
      )}

      {localEditTarget && (
        <OutfitLocalEditModal
          item={localEditTarget.item}
          ratio={settings.aspectRatio}
          onRatioChange={(ratio) => updateSetting("aspectRatio", ratio)}
          onClose={() => setLocalEditTarget(null)}
          onApply={(itemId, cropped) => applyLocalEditItem(localEditTarget.group, itemId, cropped)}
          onClear={(itemId) => clearLocalEditItem(localEditTarget.group, itemId)}
        />
      )}

      {referenceContextMenu?.reference && (
        <div
          className="imageContextMenu outfitReferenceContextMenu"
          style={{ left: referenceContextMenu.x, top: referenceContextMenu.y }}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
          <button type="button" onClick={() => void sendReferenceThumbToModelUpload(referenceContextMenu.reference)}>
            <Upload size={15} />
            <span>发送到图1上传区</span>
          </button>
        </div>
      )}

      {preview && (
        <div className="modalLayer" onMouseDown={() => setPreview(null)}>
          <section className="previewModal" onMouseDown={(event) => event.stopPropagation()}>
            <header>
              <div>
                <h2>结果预览 #{preview.order}</h2>
                <span>{preview.timingMs ? formatMs(preview.timingMs) : ""}</span>
              </div>
              <button className="iconButton" type="button" onClick={() => setPreview(null)}><X size={18} /></button>
            </header>
            <div
              className="previewImageFrame outfitPreviewImageFrame"
              onWheel={zoomPreviewByWheel}
              onPointerDown={startPreviewDrag}
              onPointerMove={movePreviewDrag}
              onPointerUp={endPreviewDrag}
              onPointerCancel={endPreviewDrag}
            >
              {resultPreviewTasks.length > 1 && (
                <button className="previewArrow previewArrowLeft" type="button" onClick={(event) => {
                  event.stopPropagation();
                  navigatePreview(-1);
                }} aria-label="上一张">
                  ‹
                </button>
              )}
              <img
                src={imageSource(preview.result)}
                alt=""
                draggable={false}
                style={{ transform: `translate(${previewPan.x}px, ${previewPan.y}px) scale(${previewZoom})` }}
              />
              {resultPreviewTasks.length > 1 && (
                <button className="previewArrow previewArrowRight" type="button" onClick={(event) => {
                  event.stopPropagation();
                  navigatePreview(1);
                }} aria-label="下一张">
                  ›
                </button>
              )}
            </div>
            {preview.prompt && (
              <button className="previewPrompt" type="button" onClick={() => void copyText(preview.prompt, "提示词已复制")}>
                {preview.prompt}
              </button>
            )}
            <footer>
              <button className="primaryButton" type="button" onClick={() => void downloadTask(preview)}>
                <Download size={16} />
                <span>{preview.savedFilename || preview.savedPath ? "已保存" : "保存结果"}</span>
              </button>
              <button className="secondaryButton" type="button" onClick={() => window.open(imageSource(preview.result), "_blank")}>
                <Maximize2 size={16} />
                <span>新窗口打开</span>
              </button>
            </footer>
          </section>
        </div>
      )}

      {imageLightbox && (
        <div className="modalLayer" onMouseDown={() => setImageLightbox(null)}>
          <section className="previewModal" onMouseDown={(event) => event.stopPropagation()}>
            <header>
              <div>
                <h2>{imageLightbox.title}</h2>
                <span>原图预览</span>
              </div>
              <button className="iconButton" type="button" onClick={() => setImageLightbox(null)}><X size={18} /></button>
            </header>
            <div
              className="previewImageFrame outfitPreviewImageFrame"
              onWheel={zoomPreviewByWheel}
              onPointerDown={startPreviewDrag}
              onPointerMove={movePreviewDrag}
              onPointerUp={endPreviewDrag}
              onPointerCancel={endPreviewDrag}
            >
              <img
                src={imageLightbox.src}
                alt=""
                draggable={false}
                style={{ transform: `translate(${previewPan.x}px, ${previewPan.y}px) scale(${previewZoom})` }}
              />
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
