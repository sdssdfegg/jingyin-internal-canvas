import { useEffect, useMemo, useRef, useState } from "react";
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
  ImageOff,
  Minus,
  Move,
  Palette,
  Pencil,
  Play,
  PlugZap,
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
} from "./shared/local-edit-mask.js";
import DebouncedTextarea from "./shared/DebouncedTextarea.jsx";
import { Modal, ModalHeader } from "./shared/ui/Modal.jsx";
import { DEFAULT_MODELS } from "./shared/models.js";
import {
  canonicalModel,
  channelsForModel,
  convergeSettingsForModel,
  isBanana2Model,
  modelCapabilities,
  routingFields
} from "./shared/routing.js";
import {
  composeLocalPasteBlob,
  constrainCropRect as sharedConstrainCropRect,
  cropRectToBlob,
  fitRectToRatioLocked,
  formatPixelSize,
  localPasteSizeReport,
  resizeRectFromCenterLocked,
  resizeRectFromCornerLocked,
  resolveLocalEditBaseFile,
  scaleRectLocked,
  snapSizeToRatio
} from "./shared/local-edit-geometry.js";
import { getAppConfig } from "./api/config.js";
import { formatConnectionResult, testConnection } from "./api/connection.js";
import { describeEmptyResult, formatGenerationError, sanitizeErrorText } from "./shared/generation-errors.js";
import { brokenImageReason, resultImageCardState } from "./shared/result-image.js";
import {
  getSaveDirectory,
  openSaveDirectoryRequest,
  pickSaveDirectory as pickSaveDirectoryRequest,
  setSaveDirectory as setSaveDirectoryRequest
} from "./api/save.js";
import { generateImages } from "./api/images.js";
import { analyzeOutfitMasterFit, checkOutfitQuality, generateOutfit } from "./api/outfit.js";
import { displayImageRequestUrl, fetchImageBlob } from "./api/assets.js";
import { emitClientDiagnosticEvent } from "./api/client.js";
import { generateVideo, getVideoStatus } from "./api/videos.js";
import { normalizeApiKeyInput } from "./features/auth/api-key.js";
import { fileSize, formatWholeSecondMs as formatMs } from "./lib/format/index.js";
import { readJsonStorage, removeStorageItem, writeJsonStorage } from "./lib/storage/json-storage.js";
import "./outfit-workflow.css";

const STORAGE_KEY = "jingyin-outfit-workflow-settings-v1";
const BATCH_CONCURRENCY_DEFAULT_MIGRATION_KEY = "batchConcurrencyDefaultV5Applied";
const GENERATION_COUNT_AUTOLINK_MIGRATION_KEY = "generationCountAutoLinkV11Applied";
const TASK_HISTORY_KEY = "jingyin-outfit-workflow-task-history-v1";
const OUTFIT_PAGES_KEY = "jingyin-outfit-workflow-pages-v1";
const OUTFIT_LOCAL_DB_NAME = "jingyin-outfit-workflow-local-v1";
const OUTFIT_LOCAL_STORE = "state";
const OUTFIT_TASK_HISTORY_DB_KEY = "task-history";
const OUTFIT_DRAFT_DB_KEY = "page-draft";
const OUTFIT_RESULT_IMAGE_CACHE_PREFIX = "result-image-cache:";
const OUTFIT_TEMP_IMAGE_CACHE_PREFIX = "temp-image-cache:";
const OUTFIT_SESSION_ID = `outfit_session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const RESULT_IMAGE_PRELOAD_TIMEOUT_MS = 20000;
const VIDEO_STATUS_POLL_INTERVAL_MS = 4000;
const VIDEO_STATUS_MAX_POLLS = 180;
const VIDEO_REFERENCE_MAX_BYTES = 10 * 1024 * 1024;
const PROMPT_LIBRARY_VERSION = "v2-20260802";
const PROMPT_PRESETS_KEY = `jingyin-outfit-workflow-prompt-library-${PROMPT_LIBRARY_VERSION}`;
const PROMPT_CATEGORIES_KEY = `jingyin-outfit-workflow-prompt-categories-${PROMPT_LIBRARY_VERSION}`;
const DEFAULT_OUTFIT_PAGE_NAME = "批量换装";
const DEFAULT_POSE_REMIX_PAGE_NAME = "批量姿态";
const DEFAULT_LOCAL_DETAIL_PAGE_NAME = "局部回贴";
const DEFAULT_BACKGROUND_CHANGE_PAGE_NAME = "固定背景";
const DEFAULT_RANDOM_BACKGROUND_PAGE_NAME = "随机背景";
const DEFAULT_OUTPAINT_PAGE_NAME = "批量扩图";
const DEFAULT_RECOLOR_PAGE_NAME = "批量改色";
const DEFAULT_WHITE_REFINE_PAGE_NAME = "批量白底精修";
const DEFAULT_FACE_SWAP_PAGE_NAME = "批量换脸";
const DEFAULT_DESIGN_DRAFT_PAGE_NAME = "设计稿";
const DEFAULT_CUSTOM_PAGE_NAME = "临时需求";
const SINGLETON_WORKFLOW_MODES = new Set(["pose-remix", "local-detail", "background-change", "random-background", "recolor", "white-refine", "face-swap", "design-draft"]);
const POSE_REMIX_DEFAULT_PROMPT = [
  "批量姿态任务：图1上传区是批量姿态参考图，每张图1只提取脸部朝向、头颈方向、肩膀角度、手臂手腕手掌、下半身、重心、站坐走关系和构图动势；不要复制图1人物身份、脸、发型、服装、穿法、背景、镜头风格或颜色。",
  "图2上传区是固定母版成片，人物身份、脸、发型、服装、穿法、场景、光影、镜头和画面风格都作为锁定标准。图2最多上传2张，默认用固定母版。",
  "生成时保持图2同一个模特、同一套衣服、同一穿法、同一场景和同一商业摄影质感，只把图2人物自然调整为当前图1姿态。",
  "姿态相似度要高：结果必须一眼看出是在模仿当前图1动作，抬手高度、手肘弯曲、手腕手掌方向、肩膀高低、身体重心、胯部转向、膝盖弯曲、脚尖方向和半身/全身裁切尽量贴近图1，不要只做轻微动作变化。",
  "服装版型和穿法必须跟图2母版一致：袖子放下/卷起、袖口落点、袖克夫长度、扣子开合、拉链高度、衣摆扎法、裙长/裤长、腰身松量、下摆轮廓、面料纹理和可见细节不要随机漂移。",
  "如果图1姿态与图2服装穿法冲突，先尽量保持图1动作相似度，再让图2服装做真实穿着褶皱和遮挡适配；只有物理上无法同时满足时才轻微折中。不要让图1衣服、裙裤类型或背景影响结果，不要输出对比图、拼贴图、文字、水印或标注。"
].join("\n");
const POSE_MOTHER_FACE_SWAP_DEFAULT_PROMPT = [
  "批量换脸任务：图1上传区是批量姿态参考图，只提取姿势、身体动作、镜头距离、半身/全身裁切和构图动势；图2上传区是固定母图/母版成片，人物身份、脸、发型、服装、场景、光影和商业摄影质感都以图2为准；图3上传区是可选补充信息。",
  "生成时必须把图2母图里的同一个人物自然调整成图1姿态。图1半身就输出半身，图1全身就输出全身；图1侧身、抬手、坐姿、肩膀角度、手臂手腕手掌、腿脚和重心都要跟随，但不能复制图1的人脸身份、服装、发型、背景、颜色或拍摄风格。",
  "人物脸部身份只能来自图2母图：五官结构、脸型、年龄感、妆容、皮肤质感、发型外轮廓和发色趋势都要像图2，不允许把图1参考图的人脸特征混入结果，不要生成图1和图2混合脸。",
  "场景背景、光影方向、色温、镜头质感和服装事实保留图2母图；如果图1姿态和图2母图场景有冲突，只按图1姿态调整人物动作，不重建新场景、不换背景、不复制图1环境。",
  "最终结果必须像图2母图同一人物在图2场景里按图1姿态重新拍摄出来的真实电商成片，不要输出对比图、拼贴图、文字、水印或标注。"
].join("\n");
const FACE_SWAP_SHORT_DEFAULT_PROMPT = [
  "批量换脸任务：图1上传区是需要保留身体、服装、姿势、背景和构图的目标人物图，图2上传区是要迁移的人脸身份参考，图3上传区是可选补充信息。",
  "图1是唯一底图和画面来源：人物身体、服装、衣领、肩膀、姿势、场景、背景、构图、镜头距离、光影、画面裁切、头身比、头部外接框、下巴位置和脖子肩线全部保持图1，不换衣、不换场景、不重拍。",
  "图2只读取脸部身份、五官、脸型、肤色妆容、发色、刘海方向和发缝趋势。图2不提供头部姿态、头部大小、头发整体外轮廓、脖子长度、肩颈关系或头身比例；图2脖子以下全部无效。",
  "只在图1原脸部角度和原头颈连接里融合图2身份，头部位置、脸部朝向、头部大小、头颈关系、下巴到锁骨/衣领的距离不变；如果发型迁移会影响图1服装、肩颈或背景，优先保留图1，只迁移脸部身份。",
  "结果出现图2服装、图2衣领肩膀、图2背景或图2拍摄场景就是失败；不要输出对比图、拼贴图、文字、水印或标注。"
].join("\n");
const FACE_SWAP_BATCH_TONE_LEGACY_DEFAULT_PROMPT = [
  "批量换脸任务：图1上传区是需要保留身体、服装、姿势、背景和构图的目标人物图，图2上传区是要迁移的人脸身份参考，图3上传区是可选补充信息。",
  "图1是唯一底图和画面来源：人物身体、服装、衣领、肩膀、姿势、场景、背景、构图、镜头距离、光影、画面裁切、头身比、头部外接框、下巴位置、脖子长度和肩颈连接全部保持图1，不换衣、不换场景、不重拍。",
  "图2只读取脸部身份、脸部肤色妆容色调和小范围发型特征：五官、脸型、肤色明暗、妆容质感、发色、刘海方向、发缝趋势和贴脸发丝方向。脸部色调以图2脸母图为主，但只作用在脸部身份融合上。",
  "图2不提供头部姿态、低头/歪头/仰头角度、头部大小、头发整体外轮廓、脖子长度、肩颈关系、头身比例、衣领肩膀、身体、背景、场景、镜头和整体穿搭；图2脖子以下全部无效。",
  "只在图1原脸部角度和原头颈连接里融合图2身份；发顶、脸中心、双眼连线倾斜、下巴、下颌角、脖子上缘、锁骨/衣领交界、双肩基线和人物头身比必须跟图1一致。结果出现图2服装、图2衣领肩膀、图2背景、图2拍摄场景或图2头部姿态就是失败。"
].join("\n");
const FACE_SWAP_HEAD_LOCK_LEGACY_DEFAULT_PROMPT = [
  "批量换脸任务：图1上传区是需要保留身体、服装、姿势、背景和构图的目标人物图，图2上传区是要迁移的人脸身份参考，图3上传区是可选补充信息。",
  "图1是唯一底图和画面来源：人物身体、服装、衣领、肩膀、姿势、场景、背景、构图、镜头距离、光影、画面裁切、头身比、头部外接框、下巴位置、脖子长度和肩颈连接全部保持图1，不换衣、不换场景、不重拍。",
  "图2只读取脸部身份、脸部肤色妆容色调和小范围发型特征：五官、脸型、肤色明暗、妆容质感、发色、刘海方向、发缝趋势和贴脸发丝方向。脸部色调以图2脸母图为主，但只作用在脸部身份融合上。",
  "同批统一脸部色彩标准：所有结果都以同一张图2脸母图的肤色明暗、妆容浓淡、口红色相和饱和度、面部对比度、磨皮程度、清晰度作为统一标准；不同图1只允许在脸部边缘做轻微现场光过渡，不能一张口红更鲜艳、一张低饱和、一张更白皙或像不同光源下拍摄。",
  "图2不提供头部姿态、低头/歪头/仰头角度、头部大小、头发整体外轮廓、脖子长度、肩颈关系、头身比例、衣领肩膀、身体、背景、场景、镜头和整体穿搭；图2脖子以下全部无效。",
  "只在图1原脸部角度和原头颈连接里融合图2身份；发顶、脸中心、双眼连线倾斜、下巴、下颌角、脖子上缘、锁骨/衣领交界、双肩基线和人物头身比必须跟图1一致。结果出现图2服装、图2衣领肩膀、图2背景、图2拍摄场景或图2头部姿态就是失败。"
].join("\n");
const FACE_SWAP_DEFAULT_PROMPT = [
  "批量换脸任务：图1上传区是需要保留身体、服装、姿势、背景和构图的目标人物图；图2上传区是脸部身份、脸型、发型和头饰母图；图3上传区是可选补充信息。",
  "图1只作为底图和坐标来源：人物身体、服装、衣领、肩膀、姿势、场景、背景、构图、镜头距离、光影、画面裁切、头身比、头部位置、头部大小、脸部朝向、下巴位置、脖子长度和肩颈连接保持图1，不换衣、不换场景、不重拍。",
  "图2作为头脸妆造标准：五官结构、脸型轮廓、年龄感、肤色明暗、妆容质感、口红色相、发型整体轮廓、发量体积、发顶高度、发色、刘海、发缝、卷直程度、贴脸发丝、头饰、发饰、耳饰都以图2母图为准；图1原脸型、原发型、原发饰和头饰不作为结果参考。",
  "同批统一头脸色彩标准：所有结果都以同一张图2母图的肤色明暗、妆容浓淡、口红色相和饱和度、面部对比度、磨皮程度、清晰度作为统一标准；不同图1只允许在脸颈边缘做轻微现场光过渡，不能一张口红更鲜艳、一张低饱和、一张更白皙或像不同光源下拍摄。",
  "迁移图2发型和头饰时，只适配图1原头部坐标、脸部朝向、头颈连接和画面裁切；允许用图2发型轮廓覆盖图1原发型/头饰干扰，但不能移动头部、放大头身比例、改变肩颈、重绘衣领、换身体、换背景或复制图2衣服。",
  "图2脖子以下全部无效：不能复制图2服装、衣领、肩膀、身体、姿势、背景、拍摄角度、场景和整体穿搭；图2头部姿态也不能覆盖图1脸部朝向。结果保留图1原脸型、原发型或原头饰导致不像图2母图，或出现图2衣服/背景/场景，都是失败。"
].join("\n");
const FACE_SWAP_PRE_HEAD_LOCK_SHORT_DEFAULT_PROMPT = [
  "批量换脸任务：图1上传区是需要保留身体、服装、姿势、背景和构图的目标人物图，图2上传区是要迁移的人脸身份参考，图3上传区是可选补充信息。",
  "图1是唯一底图和画面来源：人物身体、服装、衣领、肩膀、姿势、场景、背景、构图、镜头距离、光影和画面裁切全部保持图1，不换衣、不换场景、不重拍。",
  "图2只读取脸部身份和可融合发型：五官、脸型、肤色妆容、刘海、发缝、发色和头发轮廓。图2脖子以下全部无效，不能读取图2衣服、衣领、肩膀、身体、姿势、背景、场景、镜头和整体穿搭。",
  "只在图1原头脸位置融合图2身份和发型，头部位置、脸部朝向、头部大小、头颈关系不变；如果发型迁移会影响图1服装、肩颈或背景，优先保留图1，只迁移脸部身份。",
  "结果出现图2服装、图2衣领肩膀、图2背景或图2拍摄场景就是失败；不要输出对比图、拼贴图、文字、水印或标注。"
].join("\n");
const FACE_SWAP_PRE_HEAD_LOCK_DEFAULT_PROMPT = [
  "批量换脸任务：图1上传区是需要保留身体、服装、姿势、背景和构图的目标人物图，图2上传区是要迁移的人脸身份参考，图3上传区是可选补充信息。",
  "图1是唯一底图和画面来源：人物身体、服装、衣领、肩膀、姿势、场景、背景、构图、镜头距离、光影和画面裁切全部保持图1，不换衣、不换场景、不重拍。",
  "图2只读取脸部身份、脸部肤色妆容色调和可融合发型：五官、脸型、肤色明暗、妆容质感、刘海、发缝、发色和头发轮廓。脸部色调以图2脸母图为主，但只作用在脸部身份融合上。",
  "图2脖子以下全部无效，不能读取图2衣服、衣领、肩膀、身体、姿势、背景、场景、镜头和整体穿搭；只在图1原头脸位置融合图2身份和发型，头部位置、脸部朝向、头部大小、头颈关系不变。",
  "如果发型或肤色融合会影响图1服装、肩颈或背景，优先保留图1边界，只让脸部自然过渡；结果出现图2服装、图2衣领肩膀、图2背景或图2拍摄场景就是失败。"
].join("\n");
const LEGACY_FACE_SWAP_DEFAULT_PROMPT = [
  "批量换脸任务：图1上传区是需要保留身体、服装、姿势、背景和构图的目标人物图，图2上传区是要迁移的人脸身份参考，图3上传区是可选补充信息。",
  "替换图1人物的脸部身份特征，并参考图2的人脸、发型气质、刘海方向、发缝、卷直程度和发色趋势；图1的人物身体、服装、衣领、肩膀、姿势、场景、背景、光影和画面裁切必须保持。图2不是服装参考、不是身体参考、不是场景参考，不能把图2衣服、衣领、肩膀、背景或拍摄风格带到结果里。",
  "必须保留图1的头部位置、头部大小、脸部朝向、头颈关系、身体比例、衣服、手脚、背景、光影和画面裁切。发型只能在图1原有头部轮廓和发量范围内自然融合，不能导致头部偏移、头变大、脸中心改变或背景被大片重绘。",
  "如果图1已设置局部编辑区域，本次只生成这个局部区域，输出必须和局部区域同构图、同角度、同光影，不要输出整张图、不要扩展画布、不要添加边框。",
  "图2可以是一张或多张脸部/发型参考图，用于身份、五官、妆容气质和发型方向参考；不要复制图2的衣服、背景、拍摄角度、饰品或画面风格。图3不是必填，只在上传时补充妆容、表情、发型细节、年龄感、皮肤质感、客户要求或禁忌。",
  "最终结果必须像原图里真实拍出来的人物，只换脸，不换衣、不换身体、不换背景、不移动人物，不要输出对比图、拼贴图、文字、水印或标注。"
].join("\n");
const FACE_SWAP_LOOSE_DEFAULT_PROMPT = [
  "批量换脸任务：图1上传区是需要保留身体、服装、姿势、背景和构图的目标人物图，图2上传区是要迁移的人脸身份参考，图3上传区是可选补充信息。",
  "替换图1人物的脸部身份特征，并在用户需要时参考图2的发型气质、刘海方向、发缝、卷直程度和发色趋势；必须保留图1的头部位置、头部大小、脸部朝向、头颈关系、身体比例、衣服、手脚、背景、光影和画面裁切。发型只能在图1原有头部轮廓和发量范围内自然融合，不能导致头部偏移、头变大、脸中心改变或背景被大片重绘。",
  "如果图1已设置局部编辑区域，本次只生成这个局部区域，输出必须和局部区域同构图、同角度、同光影，不要输出整张图、不要扩展画布、不要添加边框。",
  "图2可以是一张或多张脸部/发型参考图，用于身份、五官、妆容气质和发型方向参考；不要复制图2的衣服、背景、拍摄角度、饰品或画面风格。图3不是必填，只在上传时补充妆容、表情、发型细节、年龄感、皮肤质感、客户要求或禁忌。",
  "最终结果必须像原图里真实拍出来的人物，只换脸，不换衣、不换身体、不换背景、不移动人物，不要输出对比图、拼贴图、文字、水印或标注。"
].join("\n");
const BACKGROUND_CHANGE_LEGACY_DEFAULT_PROMPT = [
  "批量换背景任务：图1上传区是要保留的人物图，图2上传区是统一场景图，图3上传区是可选补充信息。",
  "必须完全保持图1人物的位置、姿势、身体比例、头部大小、脸部朝向、发型、服装款式、服装颜色、服装细节、手脚姿态和人物在画面中的占比不变。",
  "只把图1人物自然放入图2场景中，让每一张结果都像同一场景里的统一摆拍，光影方向、色温、对比度、地面接触阴影、透视和整体色调必须一致。",
  "如果图1原本有背景或是透明/白底图，只提取人物主体和原服装事实，不保留图1原背景；不能改变人物衣服、姿态或重新摆拍。",
  "图3不是必填，只在上传时用于补充场景氛围、光线、色调、道具边界或客户额外要求；没有图3时不要凭空添加复杂道具、文字、水印或品牌元素。"
].join("\n");
const BACKGROUND_CHANGE_PERSON_LIGHT_LEGACY_DEFAULT_PROMPT = [
  "批量换背景任务：图1上传区是要保留的人物图，图2上传区是统一场景图，图3上传区是可选补充信息。",
  "图1人物必须原样保留：位置、姿势、身体比例、头部大小、脸部朝向、发型、服装款式、服装颜色、服装细节、手脚姿态、人物占比和当前裁切都不变。",
  "图1是半身就保持半身，图1是全身就保持全身；禁止补全半身下半身、扩出腿脚、拉长身体、重排站位、扩展画布或为了适配背景重新构图。",
  "只替换人物后方场景：背景结构、地面、空间透视和商业氛围来自图2，但人物身上的光源方向、曝光、肤色、服装色和明暗关系以图1为主，背景去适配人物。",
  "只允许做人物边缘融合、脚底接触阴影和背景局部光影衔接，不能把图2色调强行套到人物身上；图3只在上传时补充场景要求，没有图3时不要添加文字、水印、品牌或复杂道具。"
].join("\n");
const BACKGROUND_CHANGE_DEFAULT_PROMPT = [
  "批量固定背景任务：图1上传区是要保留的人物图，图2上传区是固定目标背景/场景图，图3上传区是可选补充信息。",
  "图1人物结构必须原样保留：位置、姿势、身体比例、头部大小、脸部朝向、发型、服装款式、服装细节、手脚姿态、人物占比和当前裁切都不变。",
  "图1是半身就保持半身，图1是全身就保持全身；禁止补全半身下半身、扩出腿脚、拉长身体、重排站位、扩展画布或为了适配背景重新构图。",
  "固定背景是最终光影标准：背景结构、地面、空间透视、主光方向、色温、对比度、阴影强度和商业氛围来自图2；允许对图1人物做自然的整体重光照、色温统一和边缘环境光融合，让人物像真实站在图2场景里。",
  "重光照只服务融合，不改变人物身份、脸、发型、服装颜色款式、服装细节、身体轮廓和手脚位置；必须补足脚底/身体接触阴影、边缘反光、远近虚实和白平衡一致性，避免贴图感、断层、假边和明显 P 图感。图3只在上传时补充场景要求，没有图3时不要添加文字、水印、品牌或复杂道具。"
].join("\n");
const RANDOM_BACKGROUND_LIGHT_LEGACY_DEFAULT_PROMPT = [
  "批量随机背景任务：图1上传区是要保留的人物原图；想要的大概场景直接写在场景补充里。",
  "人物锁定：严格保留图1模特五官妆容、脸部清晰度、发型、全部身体姿态、人物构图、画面占比和整套服装版型配饰；人物面部拒绝重绘。",
  "服装锁定：完整保留图1服装款式、颜色、亮度、面料纹理、质感、褶皱、配饰和细节，不换衣、不改色、不提亮、不重绘服装结构。",
  "背景按场景补充生成真实电商实拍环境，可以是同一场景体系里的不同机位、不同角度和轻微景深变化；不要像固定相机重复拍同一张背景，也不要生成虚假 AI 场景。",
  "光影以真实融合为目标：柔和自然光，背景光影匹配图1人物明暗和服装展示需求，不要强行打亮人物，不要让脸、肤色、服装色发生明显漂移；无文字、无水印、无多余人物。"
].join("\n");
const RANDOM_BACKGROUND_NEUTRAL_DAYLIGHT_LEGACY_DEFAULT_PROMPT = [
  "批量随机背景任务：图1上传区是要保留的人物原图；想要的大概场景直接写在场景补充里。",
  "人物锁定：严格保留图1模特五官妆容、脸部清晰度、发型、全部身体姿态、人物构图、画面占比和整套服装版型配饰；人物面部拒绝重绘。",
  "服装锁定：完整保留图1服装款式、颜色、亮度、面料纹理、质感、褶皱、配饰和细节，不换衣、不改色、不重绘服装结构。",
  "背景按场景补充生成真实电商实拍环境，可以是同一场景体系里的不同机位、不同角度和轻微景深变化；不要像固定相机重复拍同一张背景，也不要生成虚假 AI 场景。",
  "光照标准由目标场景先决定，不由图1原片背光、阴天、暗沉或室内黄光决定；整批要像同一时间段、同一场景体系拍摄的柔和明亮白天自然光。场景主动带动人物做自然补光、白平衡统一、边缘环境光和脚底接触阴影，不要让人物原本背光把新背景压暗。",
  "白平衡必须中性干净、清爽日光感：禁止暖黄、偏橙、咖啡暖滤镜、复古黄调、室内暗沉、假白提亮、强直射阳光、硬阴影、背光剪影、地面大面积太阳光斑或高反差午后强光。同批肤色、脸部明暗、口红、发色、服装白位/黑位保持同一亮度层级，不能一张明亮一张像背光阴天；无文字、无水印、无多余人物。"
].join("\n");
const RANDOM_BACKGROUND_RELIGHT_LEGACY_DEFAULT_PROMPT = [
  "批量随机背景任务：图1上传区是要保留的人物原图；想要的大概场景直接写在场景补充里。",
  "人物锁定：严格保留图1模特五官妆容、脸部清晰度、发型轮廓、全部身体姿态、人物构图、画面占比和整套服装版型配饰；人物面部拒绝重绘，不做生硬抠图贴背景。",
  "服装锁定：完整保留图1服装款式、版型、面料纹理、质感、褶皱、配饰和细节，不换衣、不重绘服装结构；但允许在不改色相和材质事实的前提下，把图1室内暖光造成的偏黄、偏橙、暗沉人物色温校正到目标场景的统一日光白平衡。",
  "背景按场景补充生成真实电商实拍环境，可以是同一场景体系里的不同机位、不同角度和轻微景深变化；不要像固定相机重复拍同一张背景，也不要生成虚假 AI 场景。",
  "光照标准由目标场景先决定，不由图1原片背光、阴天、暗沉或室内黄光决定；先固定整批统一的柔和明亮白天自然光，再让人物、皮肤、头发和服装做自然重光照与色温统一。",
  "融合方式必须像真实换到同一场景重新拍摄：人物边缘有自然环境光、半透明发丝过渡和脚底接触阴影，不能出现硬抠边、白边、黑边、锯齿边、发丝断裂、人物像贴纸或背景被人物原暖光反向染黄。",
  "白平衡必须中性干净、清爽日光感：禁止暖黄、偏橙、咖啡暖滤镜、复古黄调、室内暗沉、假白提亮、强直射阳光、硬阴影、背光剪影、地面大面积太阳光斑或高反差午后强光。同批肤色、脸部明暗、口红、发色、服装白位/黑位保持同一亮度层级，不能一张明亮一张像背光阴天。"
].join("\n");
const RANDOM_BACKGROUND_DEFAULT_PROMPT = [
  "批量随机背景任务：图1上传区是要保留的人物原图；想要的大概场景直接写在场景补充里。",
  "人物锁定：严格保留图1模特五官妆容、脸部清晰度、发型轮廓、全部身体姿态、人物构图、画面占比和整套服装版型配饰；人物面部拒绝重绘，不能像把人物抠出来贴到背景上。",
  "服装锁定：完整保留图1服装款式、版型、面料纹理、质感、褶皱、配饰和细节，不换衣、不重绘服装结构；允许在不改色相和材质事实的前提下，把图1室内暖光、偏黄、偏橙、暗沉校正到目标场景白平衡。",
  "背景按场景补充生成真实电商实拍环境，可以是同一场景体系里的不同机位、不同角度和轻微景深变化；不要像固定相机重复拍同一张背景，也不要生成虚假 AI 场景。",
  "目标场景先决定整张图的亮度、色温、曝光、主光方向和环境反光；再让人物、皮肤、头发和服装做自然重光照、补光和白平衡统一，人物不能明显比背景暗、黄、灰或像旧图贴上去。",
  "融合方式必须像真实换到同一场景重新拍摄：人物边缘有自然环境光、半透明发丝过渡、服装边缘环境色和脚底接触阴影，不能出现硬抠边、白边、黑边、锯齿边、发丝断裂、人物漂浮或背景被人物原暖光反向染黄。",
  "白平衡必须中性干净、清爽日光感：禁止暖黄、偏橙、咖啡暖滤镜、复古黄调、室内暗沉、假白提亮、强直射阳光、硬阴影、背光剪影、地面大面积太阳光斑或高反差午后强光。同批肤色、脸部明暗、口红、发色、服装白位/黑位保持同一亮度层级。"
].join("\n");
const RANDOM_BACKGROUND_LEGACY_DEFAULT_PROMPT = [
  "批量随机背景任务：图1上传区是要保留的人物原图；本页不需要图2和图3，想要的大概场景直接写在场景补充里。",
  "人物锁定：严格保留图1模特五官妆容、脸部清晰度、发型、全部身体姿态、人物构图、画面占比和整套服装版型配饰；人物面部拒绝重绘。",
  "服装锁定：完整保留图1服装款式、颜色、亮度、面料纹理、质感、褶皱、配饰和细节，不换衣、不改色、不提亮、不重绘服装结构。",
  "背景按场景补充生成真实电商实拍环境，可以是同一场景体系里的不同机位、不同角度和轻微景深变化；不要像固定相机重复拍同一张背景，也不要生成虚假 AI 场景。",
  "光影以真实融合为目标：柔和自然光，背景光影匹配图1人物明暗和服装展示需求，不要强行打亮人物，不要让脸、肤色、服装色发生明显漂移；无文字、无水印、无多余人物。"
].join("\n");
const OUTPAINT_DEFAULT_PROMPT = [
  "批量扩图任务：只有图1上传区参与生成，图1是要向下扩图的唯一原图，优先把半身照扩成能看到鞋子的全身图；本页没有参考图、没有补充图。",
  "必须保持图1原有内容完全不变：人物身份、脸、发型、肤色、上半身、服装款式、服装颜色、姿势、重心、手臂、背景、光影、清晰度、构图中已有区域都不移动、不缩放、不重绘、不换脸、不换衣。",
  "只在图1画布下方新增内容：自然补全模特下半身、腿部、脚踝、鞋子和脚底接触阴影；鞋子必须可见，腿脚方向、重心、站姿和透视要延续图1已有身体动作。",
  "扩出来的下半身服装、腿部、鞋子、地面和背景必须像原图同一场景继续拍摄，不要像拼接，不要改变原图上半身，不要新增无关人物、道具、文字、水印或品牌标志。",
  "系统会在生成完成后把图1原有区域本地覆盖回结果图，模型只负责下方留白扩展；生成时也必须避免重绘原图上半部分。"
].join("\n");
const RECOLOR_COLOR_LEGACY_DEFAULT_PROMPT = [
  "批量改色任务：图1上传区是要保留的人物原图，图2上传区是目标颜色/服装颜色参考图，图3上传区是可选补充信息。",
  "只改变图1中被图2选项指定的服装部位颜色；人物脸、发型、肤色、身体姿势、手脚、场景、背景、镜头、构图、服装款式、版型、衣长、袖长、扣子、拉链、腰带、图案、刺绣、口袋、面料纹理和褶皱结构都保持图1原样。",
  "图2只提供目标颜色、明暗关系、饱和度、材质色感和局部颜色参考；不能把图2人物、服装款式、穿法、版型、场景、背景、姿势或光影结构带入图1。",
  "同一批结果颜色要统一稳定，目标部位颜色要自然贴合图1原有光影、褶皱、材质纹理和边缘阴影；不要出现断层、涂抹感、边缘溢色、皮肤染色、场景变色或整张图偏色。",
  "如果图1开启局部回贴，只处理选区或蒙版范围内的目标服装颜色，输出必须和选区同构图、同角度、同光影，方便系统贴回原图。"
].join("\n");
const RECOLOR_DEFAULT_PROMPT = [
  "批量改色任务：图1上传区是要保留的人物原图，图2上传区是目标颜色/服装颜色参考图，图3上传区是可选补充信息。",
  "只改变图1中被图2选项指定的服装部位颜色；人物脸、发型、肤色、身体姿势、手脚、场景、背景、镜头、构图、服装款式、版型、衣长、袖长、扣子、拉链、腰带、图案、刺绣、口袋、面料纹理和褶皱结构都保持图1原样。",
  "图2只提供目标颜色、明暗关系、饱和度、材质色感和局部颜色参考；不能把图2人物、服装款式、穿法、版型、场景、背景、姿势或光影结构带入图1。",
  "颜色校准以图2主颜色参考为准：不要增加饱和度、对比度、油润感、高光或商业滤镜；同批保持同一目标色阶，不变深、不变艳、不发油、不发灰。",
  "同一批结果颜色要统一稳定，目标部位颜色要自然贴合图1原有光影、褶皱、材质纹理和边缘阴影；不要出现断层、涂抹感、边缘溢色、皮肤染色、场景变色、整张图偏色或一批里明显色差。",
  "如果图1开启局部回贴，只处理选区或蒙版范围内的目标服装颜色，输出必须和选区同构图、同角度、同光影，方便系统贴回原图。"
].join("\n");
const WHITE_REFINE_COLOR_LOCK_LEGACY_DEFAULT_PROMPT = [
  "批量白底精修服装任务：图1上传区是批量要处理的服装平铺图/挂拍图，图2上传区是可选参考/细节图，本页不使用图3。",
  "目标是把图1处理成干净白底电商商品图：去掉原背景、衣架、挂钩、夹子、支撑物、杂乱阴影、脏点和多余道具，让服装平铺/挂拍形态更规整自然。",
  "只允许做白底清理、衣架去除、边缘修净、轻度版面摆正、压痕和杂乱褶皱整理；保留轻微自然松弛垂感，不要抹平面料原有纹理和针织/皮革/牛仔/雪纺等材质特征。",
  "图1服装是唯一主事实：颜色深浅、饱和度、版型、长度、领口、袖口、袖克夫、扣子、拉链、腰带、口袋、刺绣、印花、压线、拼接、面料材质和全部可见细节都不能改变。",
  "颜色校准以图1原服装为准：不要增加饱和度、对比度、油润感、高光或商业滤镜；牛仔、针织、皮革、雪纺等面料保持原始色阶，不变深、不变艳、不发油、不发灰。",
  "图2如果上传，只作为参考池：可以帮助理解标准平铺形态、袖口/腰带/扣子/面料细节或衣架去除后的自然补齐方式；不能把图2款式、颜色、图案、背景或新结构迁移到图1。",
  "最终输出高清白底服装商品图，无模特、无人台、无衣架、无文字、水印、标签说明或拼贴对比图。"
].join("\n");
const WHITE_REFINE_DEFAULT_PROMPT = [
  "批量白底精修服装任务：图1上传区是批量要处理的服装平铺图/挂拍图，图2上传区是可选参考/细节图，本页不使用图3。",
  "目标是把图1处理成干净白底电商商品图：去掉原背景、衣架、挂钩、夹子、图钉、别针、固定针、支撑物、杂乱阴影、脏点和多余道具，让服装平铺/挂拍形态更规整自然。",
  "只允许做白底清理、衣架去除、边缘修净、轻度版面摆正、压痕和杂乱褶皱整理；去掉运输压痕、固定造成的尖锐折痕和多余皱团，但保留服装结构需要的自然垂感、缝线边缘和面料纹理。",
  "图1服装是唯一主事实：颜色深浅、明度、饱和度、灰度、白位黑位、版型、长度、领口、袖口、袖克夫、扣子、拉链、腰带、口袋、刺绣、印花、压线、拼接、面料材质和全部可见细节都不能改变。",
  "颜色校准以图1原服装为准，尤其牛仔、水洗、做旧、针织、皮革、雪纺等面料必须保持原始色阶：不要提蓝、提饱和、加深颜色、提高对比度、增加油润感、高光、锐化、商业滤镜或自动美化；右图不能比原图更艳、更深、更蓝、更硬。",
  "白底可以变干净，但服装本体不能被重新渲染成新商品图；只能用同一件服装附近纹理补齐被衣架、夹子、图钉、别针遮挡的位置，不能新增口袋、压线、洗水纹、褶皱纹理或改变原本水洗分布。",
  "图2如果上传，只作为参考池：可以帮助理解标准平铺形态、袖口/腰带/扣子等局部细节或衣架去除后的自然补齐方式；不能把图2款式、颜色、图案、背景或新结构迁移到图1。",
  "最终输出高清白底服装商品图，无模特、无人台、无衣架、无挂钩、无夹子、无图钉、无别针、无固定针、无文字、水印、标签说明或拼贴对比图。"
].join("\n");
const DESIGN_DRAFT_DEFAULT_PROMPT = [
  "参考图1上传区的实拍服装图或真人实拍服装图，将服装转换为图2上传区所参考的干净服装设计师手稿风格。图1上传区可能只有一张图，也可能有多张正面、背面、侧面或细节图；请把图1上传区的所有图片当作同一件服装的参考，综合识别服装颜色、版型、领口、袖型、袖口、下摆、长度比例、结构线、拼接方式和主要面料特点。图3上传区是可选的细节补充图，只有上传时才作为面料、袖口、裙摆、衣领、纹理或辅助线效果的补充参考；如果图3没有上传，不要强行假设图3内容。",
  "输出纯白背景的服装设计师手稿图，无人体、无模特、无场景、无衣架，画面只保留服装款式图。能从参考图中判断正反面时，优先输出服装正反面左右并排款式图；如果只有单面参考且背面信息不足，背面只能做保守、简洁、符合服装结构逻辑的合理补全，不要编造复杂设计。服装颜色以图1实拍服装为准，保留原服装的版型、廓形、领口、袖型、袖口、下摆、长度比例和主要结构。整体以黑色线稿为主，搭配极浅的米杏色淡填色，不要真实照片质感，不要复杂面料纹理，不要写实细节。",
  "线条使用手绘板绘制的服装款式图线条，外轮廓线清晰干净，起笔轻、收笔轻、中间压力重，线条两头尖、中间略粗，有自然的笔压变化和克制的手绘笔触；不要像儿童涂抹一样粗细一致、反复描边或杂乱涂抹。内部结构线、领口线、袖口线、下摆线、衣身分割线使用更细的线，线条稳定、准确、干净。",
  "服装所有轮廓转角、袖口四角、下摆边角、接缝拐点位置，点缀极短的浅灰色纤细定位短线。短线只停留在拐点外侧，短小零散，不要长贯穿线条；线条浅淡但要比普通起稿痕迹略明显，明度低于黑色衣身轮廓线，是设计师手稿里的拐点定位辅助短线，不杂乱、不延伸。",
  "面料质感只用非常少量的简化材质符号和浅淡铅笔排线暗示，抓住面料特点即可，不出现真实照片级织物细节，不出现复杂编织纹理，不出现杂乱涂抹线。整体像服装打版师、设计师用手绘板画出来的产品工艺手稿，结构清楚、比例准确、线条干净、有轻微手写压感但不凌乱。"
].join("\n");
const MAX_UPLOAD_IMAGES = 10;
const GENERATION_COUNT_OPTIONS = ["auto", ...Array.from({ length: MAX_UPLOAD_IMAGES }, (_, index) => index + 1)];
const CHANNEL_UPLOAD_LIMIT_BYTES = 4 * 1024 * 1024;
const CHANNEL_UPLOAD_TARGET_BYTES = 3.75 * 1024 * 1024;
const CHANNEL_UPLOAD_MAX_SIDE = 3072;
const LOCAL_EDIT_CROP_UPLOAD_TARGET_BYTES = 16 * 1024 * 1024;
const LOCAL_EDIT_CROP_JPEG_QUALITIES = [0.98, 0.96, 0.94, 0.92];
const LOCAL_EDIT_OUTPUT_TARGET_BYTES = 64 * 1024 * 1024;
const LOCAL_EDIT_OUTPUT_JPEG_QUALITIES = [0.985, 0.975, 0.965, 0.95, 0.94];
const LOCAL_EDIT_SHARPEN_MAX_PIXELS = 9_000_000;
const DEFAULT_BATCH_CONCURRENCY = 5;
const LOCAL_EDIT_BATCH_CONCURRENCY = 5;
const LOCAL_EDIT_BATCH_PREPARE_CONCURRENCY = 2;
const LOCAL_EDIT_BATCH_REQUEST_GAP_MS = 250;
const CROP_RETURN_OUTPUT_TARGET_BYTES = 64 * 1024 * 1024;
const CROP_RETURN_OUTPUT_JPEG_QUALITIES = [0.985, 0.975, 0.965, 0.95, 0.94];
const OUTFIT_RERUN_DRAG_MIME = "application/x-jingyin-outfit-task";
const PREPROCESS_OPTIONS = [
  { value: "crop", label: "手动裁剪" },
  { value: "pad", label: "白底补边" },
  { value: "soft", label: "柔和补边" },
  { value: "original", label: "原图" }
];
const DEFAULT_PREPROCESS_MODE = "original";
const CROP_RETURN_RATIOS = ["1:1", "3:4", "4:3", "16:9", "9:16"];
// 2026-09-25：局部回贴选框要能锁定 2:3（竖版服装图常用），但**不改**裁剪回流
// 用的 CROP_RETURN_RATIOS（那是另一条产品语义），所以这里单独一份列表。
const BATCH_LOCAL_EDIT_RATIOS = ["1:1", "2:3", "3:4", "4:3", "16:9", "9:16"];
const GARMENT_PART_OPTIONS = [
  { value: "upper", label: "上装" },
  { value: "lower", label: "下装" },
  { value: "shoes", label: "鞋子" }
];
const GARMENT_COMPOSITION_OPTIONS = [
  { value: "single-upper", label: "单件上衣", parts: ["upper"] },
  { value: "upper-layer", label: "外套+内搭", parts: ["upper"] },
  { value: "outfit-set", label: "套装", parts: ["upper", "lower"] },
  { value: "custom", label: "自定义范围", parts: [] }
];
const GARMENT_PART_PRESET_OPTIONS = [
  { value: "single-upper", label: "单件上衣", parts: ["upper"], composition: "single-upper" },
  { value: "upper-layer", label: "外套+内搭", parts: ["upper"], composition: "upper-layer" },
  { value: "outfit-set", label: "套装", parts: ["upper", "lower"], composition: "outfit-set" }
];
const DEFAULT_GARMENT_PARTS = ["upper"];
const DEFAULT_GARMENT_COMPOSITION = "single-upper";
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
const RESIZE_FORMAT_OPTIONS = [
  { value: "jpg", label: "JPG" },
  { value: "png", label: "PNG" },
  { value: "webp", label: "WEBP" }
];
// 2026-09-25：批量尺寸导出的「自动裁剪」功能已整体移除（UI / 状态 / 持久化 / 专用逻辑）。
// 与它无关的导出设置（格式、DPI、最长边、适配方式、填充色、裁剪方式、批量裁剪区域）全部保留。
const RESIZE_SETTINGS_KEY = "jingyin-outfit-workflow-resize-settings-v4";
const RESIZE_BATCH_CROP_KEY = "jingyin-outfit-workflow-resize-batch-crop-v1";
const RESIZE_OUTPUT_FOLDER = "批量尺寸导出";
const LOCAL_DETAIL_OUTPUT_FOLDER = "局部回贴";
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
    hint: "可选；默认不参与换装，只有在补充提示词里明确说明图3用途时才参考。"
  }
};
const POSE_REMIX_UPLOAD_LABELS = {
  model: {
    title: "批量姿态图",
    hint: "批量上传姿态参考；每张只提取脸部朝向、肩膀、手臂、手腕手掌、下半身、重心和构图动势，不参考衣服和背景。"
  },
  clothing: {
    title: "固定母版成片",
    hint: "上传已满意的模特服装场景成片；固定人物身份、脸、发型、服装、穿法、场景和光影，默认最多2张。"
  },
  reference: {
    title: "补充约束图",
    hint: "可选；只有在提示词里明确说明图3用途时才参考，用于补充禁忌、细节边界或客户要求。"
  }
};
const LEGACY_POSE_REMIX_UPLOAD_LABELS = {
  model: {
    title: "固定母版成片",
    hint: "上传 1 张已满意的模特服装场景成片；批量任务固定人物、服装、穿法、场景和光影。"
  },
  clothing: {
    title: "批量姿势参考图",
    hint: "批量上传姿势参考；每张只提取身体姿态、手脚动作、朝向和重心，不参考衣服和背景。"
  },
  reference: {
    title: "补充约束图",
    hint: "可选；只有在提示词里明确说明图3用途时才参考，用于补充禁忌、细节边界或客户要求。"
  }
};
const LOCAL_DETAIL_UPLOAD_LABELS = {
  model: {
    title: "原图/待回贴图",
    hint: "上传需要局部修改的大图；在图1缩略图下方点局部回贴，框选或涂抹要修改的服装细节。"
  },
  clothing: {
    title: "细节结构参考图",
    hint: "上传要参考的局部结构、形状、五金、缝线或纹理走势；不参考图2颜色。"
  },
  reference: {
    title: "补充说明图",
    hint: "可选；补充局部结构或客户要求，颜色、材质、光影仍以图1原产品为准。"
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
    title: "固定背景图",
    hint: "上传固定目标背景；批量人物都放进同一场景，人物光影要自然贴合背景。"
  },
  reference: {
    title: "补充参考图",
    hint: "可选；补充场景氛围、光线、色调、道具边界或本次客户要求。"
  }
};
const RANDOM_BACKGROUND_UPLOAD_LABELS = {
  model: {
    title: "批量人物图",
    hint: "批量上传要换随机背景的人物原图；脸、姿势、服装、构图和人物占比都要锁定不变。"
  },
  clothing: {
    title: "不参与",
    hint: "随机背景不使用图2，场景需求请写在场景补充。"
  },
  reference: {
    title: "不参与",
    hint: "随机背景不使用图3，避免参考图干扰人物和服装。"
  }
};
const RECOLOR_UPLOAD_LABELS = {
  model: {
    title: "批量原图/模特图",
    hint: "批量上传要改色的原图；人物、姿势、场景、肤色、服装款式和细节都要锁定不变。"
  },
  clothing: {
    title: "改色服装参考图",
    hint: "上传目标颜色参考，可上传多张；只读取图2选中服装范围的颜色、明暗和材质色感。"
  },
  reference: {
    title: "补充参考图",
    hint: "可选；补充颜色禁忌、局部材质、客户要求或要避免的效果，不上传时不强行添加。"
  }
};
const WHITE_REFINE_UPLOAD_LABELS = {
  model: {
    title: "批量平铺图/挂拍图",
    hint: "批量上传要变白底并精修的服装图；图1款式、颜色、面料和全部细节是唯一主事实。"
  },
  clothing: {
    title: "可选参考/细节图",
    hint: "可选上传标准平铺、袖口腰带扣子等细节或衣架去除参考；只辅助精修，不覆盖图1款式颜色。"
  },
  reference: {
    title: "不参与",
    hint: "白底精修不使用图3，补充要求请写在文字里。"
  }
};
const OUTPAINT_UPLOAD_LABELS = {
  model: {
    title: "待扩图原图",
    hint: "批量上传要向下扩图的半身照或局部人物图；只用图1生成，原有画面会本地覆盖保护。"
  },
  clothing: {
    title: "不参与",
    hint: "批量扩图不使用图2。"
  },
  reference: {
    title: "不参与",
    hint: "批量扩图不使用图3。"
  }
};
const POSE_MOTHER_FACE_SWAP_UPLOAD_LABELS = {
  model: {
    title: "批量姿态图",
    hint: "批量上传姿态参考图；只提取姿势、半身/全身裁切、镜头距离和构图动势，不提取人物身份、服装或背景。"
  },
  clothing: {
    title: "固定母图",
    hint: "上传要保留的人物母图；脸、发型、服装、场景、光影和商业摄影质感都以母图为准。"
  },
  reference: {
    title: "补充参考图",
    hint: "可选；补充本次姿态、表情、妆造、客户要求或禁忌，不上传时不强行添加。"
  }
};
const FACE_SWAP_UPLOAD_LABELS = {
  model: {
    title: "目标人物图",
    hint: "批量上传要换脸的原图；身体、衣服、姿势、背景、构图和头部坐标要保留，原脸型发型头饰不作为结果参考。"
  },
  clothing: {
    title: "脸型发型母图",
    hint: "上传要替换进去的母图；脸型、五官、发型、头饰/发饰、妆容和脸部色调都以这里为准。"
  },
  reference: {
    title: "妆容/表情补充图",
    hint: "可选；补充妆容、表情、年龄感、皮肤质感、客户要求或禁忌，不上传时不强行添加。"
  }
};
const LEGACY_FACE_SWAP_UPLOAD_LABELS = FACE_SWAP_UPLOAD_LABELS;
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
  // 2026-09-25：批量尺寸导出的「最长边」默认值由 3000 调整为 3500。
  // 老存档里存着 3000 的用户（= 从没改过，存的只是当时的默认值）由
  // normalizeResizeSettings 迁移到新默认值；真正自定义过的值原样保留。
  longEdge: 3500,
  resolution: "custom",
  fitMode: "original",
  outputFormat: "jpg",
  dpi: 72,
  fillColor: "#ffffff",
  cropMode: "batch"
};
// 旧默认值：用于把"当年没改过、存的只是默认值"的存档迁到 3500。
// 只对这一个值做迁移，其余自定义值（2000/4000/…）不动。
const LEGACY_RESIZE_LONG_EDGE_DEFAULT = 3000;

const OUTFIT_DEFAULT_PROMPT = [
  "让图1当前人物穿着图2服装，生成自然干净的电商成片。",
  "以图1为人物姿势和构图基准，不改变图1模特的姿势、位置、身体比例、手部姿势和画面构图；保留身份、发型、原脸质感、镜头、背景和原图光影，不磨皮、不变脸。",
  "图1模特身上的原服装不作为图2服装的款式、版型、大小、松量或长度参考；图1的服装不做任何款式参考，尤其不能影响图2袖长、袖口落点、袖筒松量、衣长、领口、扣子、衣摆扎法、颜色和面料。",
  "图2是唯一服装标准：保留款式、版型、长度、松量、颜色、面料、领口、袖口、袖子穿法、扣合状态、衣摆扎法、下摆、扣子、拉链、拼接、里衬/网纱层次等关键细节。",
  "图2服装颜色校准必须保持：不要增加饱和度、对比度、油润感、高光或商业滤镜；同批保持同一服装色阶，不变浅、不变深、不变艳、不发油、不发灰，也不要因图1环境自动改色。",
  "用户补充文字里明确点名的删除、移除、去掉类要求必须完整执行，不能只处理一部分或留下残影。",
  "只做真实穿着适配，不按模型审美把图2改短、收腰、修身、瘦身、重设计或简化细节。",
  "袖子状态按图2实际穿法执行：放下就放下，卷起就卷起，挽起就挽起；袖口落点、袖克夫长度、卷袖高度和层数不要上提、缩短或随机变化。",
  "扣子、拉链、门襟开合和衣摆扎法按图2保持；如果涉及扎入下装，先识别图1真实下装类型，再把图2同样的扎入位置和露出边界适配过去。",
  "服装细节保持自然真实，面料垂坠、褶皱、光影和原图环境一致，保留清新干净的商业摄影质感。"
].join("\n");
const LOCAL_DETAIL_DEFAULT_PROMPT = [
  "局部服装细节任务：在图1指定局部区域内，只修改用户点名的服装细节。",
  "图1是颜色、基础材质、明暗、光影、纹理尺度和周边衔接的标准；选区外和未点名区域保持图1原样。",
  "图2只参考被点名细节的结构、形状、五金、缝线、纹理走势或工艺位置；不参考图2颜色、色温、曝光、背景，也不要把图2当整件服装来源。",
  "局部结果必须像原本长在图1这件衣服上，边缘自然连续，不出现突兀色块、材质断层或人物位置变化。"
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
      "局部换装任务：图1是原图，已框选局部编辑区域；图2是本次要换上的服装唯一来源。",
      "请先在内部分析图2服装的面料类别和可见材质事实，例如棉麻、帆布、牛仔、雪纺、皮革、蕾丝、网纱、针织等，以及织纹方向、颗粒大小、厚薄、垂感、光泽、高光位置、透明度、褶皱逻辑、缝线方向和边缘结构；不要输出分析文字，只把分析结果用于生成。",
      "把图2服装真实穿到图1人物局部区域内，严格保持图2的服装类别、版型、廓形、宽松/修身程度、腰身松量、肩线、领口形状、袖型、袖长、袖口、袖子穿法、扣合状态、衣摆扎法、衣长、裙长、下摆宽度、开衩、扣子、拉链、口袋、拼接线、颜色、面料纹理、厚薄、垂感、反光和光泽。",
      "图1原服装只用于判断身体轮廓和遮挡，不参考它的袖长、袖口位置、松量、衣长、领口、门襟、扣子、颜色、面料或褶皱。",
      "图2颜色深浅、明度、饱和度和面料光泽必须保持，不要把服装变浅、泛白、发灰、降饱和、加柔光或提亮成浅一号。",
      "只允许做符合图1姿态和身体角度的真实穿着适配与自然褶皱，不能按模型审美自动美化版型；禁止把图2服装改成更收腰、更细腰、更短、更紧身、更修身、更顺滑、更亮、更薄、更厚或更完美状态。",
      "图1人物的脸、发型、头部位置、身体比例、姿势、手臂手腕手指、腿脚、背景光影和选区边缘必须保持稳定；不要输出整张重构图、对比图、文字、水印或边框。"
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
  if (/(唯一人物底图和几何基准|图1人物几何锁定|肩胯角度|姿势幅度|鞋脚接地点)/.test(text)
    && /(让图1当前人物穿着图2服装|图2服装|唯一服装标准)/.test(text)) return true;
  if (/补齐画布|背景从原图氛围自然延展|不要引入新的主体元素/.test(text)) return true;
  if (/让图1模特穿着图2服装，图1模特的样貌[\s\S]*不优化图2服装款式/.test(text)) return true;
  if (/必须让图1人物穿着图2服装。保持图1模特[\s\S]*手脚位置[\s\S]*不优化、重设计/.test(text)) return true;
  if (/批量换装任务：图1是当前模特图[\s\S]*图2服装是唯一换装标准[\s\S]*不优化、重设计或简化图2服装款式/.test(text)) return true;
  if (/图3只做可选补充，不替代图2/.test(text)) return true;
  if (/让图1当前人物穿着图2服装，生成自然干净的电商成片。[\s\S]*图1模特身上的原服装不作为图2服装/.test(text)
    && !/以图1为人物姿势和构图基准/.test(text)) return true;
  return false;
}

function normalizeSmartIntervention(value) {
  if (value === true) return true;
  if (value === false) return false;
  const text = String(value ?? "false").trim().toLowerCase();
  return ["1", "true", "on", "smart", "智能", "开启"].includes(text);
}

// 中文注释：AI质检只作为生成后标记和返修提示，不写入或暴露 API Key。
function normalizeQualityCheck(value) {
  if (value === true) return true;
  if (value === false) return false;
  const text = String(value ?? "false").trim().toLowerCase();
  return ["1", "true", "on", "quality", "qc", "质检", "开启"].includes(text);
}

function normalizeQualityCheckResult(value) {
  if (!value || typeof value !== "object") return null;
  const statusText = String(value.status || "").trim().toLowerCase();
  const status = ["pending", "checking", "passed", "failed", "error", "skipped"].includes(statusText)
    ? statusText
    : value.pass === true
      ? "passed"
      : value.pass === false
        ? "failed"
        : "pending";
  const scoreRaw = Number(value.score);
  const score = Number.isFinite(scoreRaw) ? Math.max(0, Math.min(100, Math.round(scoreRaw))) : null;
  const issues = Array.isArray(value.issues)
    ? value.issues.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 6)
    : [];
  return {
    status,
    pass: typeof value.pass === "boolean" ? value.pass : status === "passed" ? true : status === "failed" ? false : null,
    score,
    summary: String(value.summary || "").trim().slice(0, 220),
    issues,
    repairPrompt: String(value.repairPrompt || "").trim().slice(0, 520),
    faceQuality: String(value.faceQuality || "").trim().slice(0, 120),
    poseMatch: String(value.poseMatch || "").trim().slice(0, 160),
    outfitMatch: String(value.outfitMatch || "").trim().slice(0, 180),
    checkedAt: Number(value.checkedAt || 0) || null,
    model: String(value.model || "").trim().slice(0, 80)
  };
}

function normalizeGarmentParts(value) {
  const raw = Array.isArray(value) ? value : String(value || "").split(/[,\s|，、]+/);
  const next = GARMENT_PART_OPTIONS
    .map((option) => option.value)
    .filter((part) => raw.includes(part));
  return next.length > 0 ? next : DEFAULT_GARMENT_PARTS;
}

function sameGarmentParts(left, right) {
  const leftParts = normalizeGarmentParts(left).slice().sort();
  const rightParts = normalizeGarmentParts(right).slice().sort();
  return leftParts.length === rightParts.length && leftParts.every((part, index) => part === rightParts[index]);
}

function normalizeGarmentComposition(value, garmentParts = DEFAULT_GARMENT_PARTS) {
  const allowed = new Set(GARMENT_COMPOSITION_OPTIONS.map((option) => option.value));
  const parts = normalizeGarmentParts(garmentParts);
  const next = allowed.has(String(value || "")) ? String(value) : DEFAULT_GARMENT_COMPOSITION;
  const upperOnly = parts.length === 1 && parts.includes("upper");
  const upperLowerOnly = parts.length === 2 && parts.includes("upper") && parts.includes("lower");
  if (["single-upper", "upper-layer"].includes(next)) return upperOnly ? next : "custom";
  if (next === "outfit-set") return upperLowerOnly ? next : "custom";
  return "custom";
}

function garmentCompositionLabel(value) {
  return GARMENT_COMPOSITION_OPTIONS.find((option) => option.value === value)?.label || "自定义范围";
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

function normalizeMasterFitLock(value) {
  if (value === true) return true;
  if (value === false) return false;
  const text = String(value ?? "false").trim().toLowerCase();
  return ["1", "true", "on", "lock", "母版", "锁版型", "开启"].includes(text);
}

function normalizeMasterFitSpec(value) {
  return String(value || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim()
    .slice(0, 2600);
}

// 中文注释：记录规格对应的图2图片 ID，避免更换固定服装后继续误用旧母版规格。
function normalizeMasterFitSourceId(value) {
  return String(value || "").trim().slice(0, 120);
}

const RANDOM_BACKGROUND_FOCUS_OPTIONS = [
  { value: "default", label: "默认" },
  { value: "upper", label: "上衣" },
  { value: "lower", label: "下装" },
  { value: "set", label: "套装" }
];

function normalizeRandomBackgroundFocus(value) {
  const text = String(value || "default").trim().toLowerCase();
  if (["upper", "top", "上衣", "上装"].includes(text)) return "upper";
  if (["lower", "bottom", "下衣", "下装"].includes(text)) return "lower";
  if (["set", "suit", "full", "套装", "整套"].includes(text)) return "set";
  return "default";
}

const defaultSettings = {
  apiKey: "",
  // canonical ID：旧存档里的 gpt-image / nano-banana2 会由 canonicalModel 在读取时映射。
  model: "tt-image-2",
  channelId: "",
  dispatchMode: "manual",
  aspectRatio: "3:4",
  imageSize: "2K",
  concurrency: DEFAULT_BATCH_CONCURRENCY,
  generationCount: "auto",
  smartIntervention: false,
  // 2026-09-25 临时开关：批量生成是否自动追加 SKILL / 服装规则。
  // 本轮默认关闭，方便用户先看模型原生效果；打开即恢复原来的批量换装规则。
  // 服务端对应 prompts/server/outfit-skill.js 的 BATCH_SKILL_ENABLED_BY_DEFAULT。
  batchSkillRulesEnabled: false,
  qualityCheck: false,
  garmentParts: DEFAULT_GARMENT_PARTS,
  garmentComposition: DEFAULT_GARMENT_COMPOSITION,
  garmentLengths: DEFAULT_GARMENT_LENGTHS,
  masterFitLock: false,
  masterFitSpec: "",
  masterFitSourceId: "",
  pairingMode: "fixed",
  preprocessMode: DEFAULT_PREPROCESS_MODE,
  randomBackgroundFocus: "default",
  theme: "dark",
  prompt: OUTFIT_DEFAULT_PROMPT,
  productNote: ""
};

function readSettings() {
  try {
    const stored = readJsonStorage(STORAGE_KEY, {});
    const settings = { ...defaultSettings, ...stored };
    if (shouldUpgradeLegacyBatchConcurrency(settings)) {
      settings.concurrency = DEFAULT_BATCH_CONCURRENCY;
      settings[BATCH_CONCURRENCY_DEFAULT_MIGRATION_KEY] = true;
    }
    if (settings.generationCount === 10 && settings[GENERATION_COUNT_AUTOLINK_MIGRATION_KEY] !== true) {
      settings.generationCount = "auto";
      settings[GENERATION_COUNT_AUTOLINK_MIGRATION_KEY] = true;
    }
    if (shouldRepairOutfitPrompt(settings.prompt)) settings.prompt = OUTFIT_DEFAULT_PROMPT;
    settings.generationCount = normalizeGenerationCount(settings.generationCount);
    settings.smartIntervention = normalizeSmartIntervention(settings.smartIntervention);
    settings.batchSkillRulesEnabled = settings.batchSkillRulesEnabled === true;
    settings.qualityCheck = normalizeQualityCheck(settings.qualityCheck);
    settings.garmentParts = normalizeGarmentParts(settings.garmentParts);
    settings.garmentComposition = normalizeGarmentComposition(settings.garmentComposition, settings.garmentParts);
    settings.garmentLengths = normalizeGarmentLengths(settings.garmentLengths, settings.garmentParts);
    settings.masterFitLock = normalizeMasterFitLock(settings.masterFitLock);
    settings.masterFitSpec = normalizeMasterFitSpec(settings.masterFitSpec);
    settings.masterFitSourceId = normalizeMasterFitSourceId(settings.masterFitSourceId);
    settings.randomBackgroundFocus = normalizeRandomBackgroundFocus(settings.randomBackgroundFocus);
    settings.concurrency = normalizeBatchConcurrency(settings.concurrency);
    settings.preprocessMode = DEFAULT_PREPROCESS_MODE;
    // 旧存档模型 ID 归一化到 3.0 canonical ID；目录加载完成后还会再收敛一次能力参数。
    settings.model = canonicalModel(settings.model);
    settings.dispatchMode = "manual";
    settings.channelId = String(settings.channelId || "");
    return settings;
  } catch {
    return defaultSettings;
  }
}

function normalizeOutfitPageName(value, fallback = DEFAULT_OUTFIT_PAGE_NAME) {
  const name = String(value || "").replace(/\s+/g, " ").trim();
  if (name === "批量AI换装" || name === "批量生成") return DEFAULT_OUTFIT_PAGE_NAME;
  if (/批量姿态|批量姿态图|姿态参考图|固定模特换姿势|固定模特|固定人物|批量姿势|换姿势|姿势生成|姿势参考|pose/i.test(name)) return DEFAULT_POSE_REMIX_PAGE_NAME;
  if (/局部细节|局部精修|局部贴回|local\s*detail/i.test(name)) return DEFAULT_LOCAL_DETAIL_PAGE_NAME;
  if (/随机背景|随机场景|随机实景|random\s*background/i.test(name)) return DEFAULT_RANDOM_BACKGROUND_PAGE_NAME;
  if (/换固定背景|固定背景|换背景|換背景|背景更换|背景替换|换场景|換場景/i.test(name)) return DEFAULT_BACKGROUND_CHANGE_PAGE_NAME;
  if (/批量扩图|扩图|扩画布|向下扩|下半身扩图|补全下半身|outpaint|expand/i.test(name)) return DEFAULT_OUTPAINT_PAGE_NAME;
  if (/批量改色|改色|换色|服装改色|颜色替换|颜色参考|recolor/i.test(name)) return DEFAULT_RECOLOR_PAGE_NAME;
  if (/批量白底精修|白底精修|白底图精修|服装精修|平铺精修|挂拍精修|去衣架|去掉衣架|white\s*refine/i.test(name)) return DEFAULT_WHITE_REFINE_PAGE_NAME;
  return (name || fallback).slice(0, 18);
}

function isPoseRemixPageName(value) {
  return /批量姿态|批量姿态图|姿态参考图|固定模特换姿势|固定模特|固定人物|固定成片|批量姿势|换姿势|姿势生成|姿势参考|pose/i.test(String(value || ""));
}

function isLocalDetailPageName(value) {
  return /局部回贴|局部贴回|局部细节|局部精修|local\s*detail/i.test(String(value || ""));
}

function isBackgroundChangePageName(value) {
  return /换固定背景|固定背景|换背景|換背景|背景更换|背景替换|换场景|換場景|场景图|统一场景/i.test(String(value || ""));
}

function isRandomBackgroundPageName(value) {
  return /随机背景|随机场景|随机实景|random\s*background/i.test(String(value || ""));
}

function isOutpaintPageName(value) {
  return /批量扩图|扩图|扩画布|向下扩|下半身扩图|补全下半身|outpaint|expand/i.test(String(value || ""));
}

function isRecolorPageName(value) {
  return /批量改色|改色|换色|服装改色|颜色替换|颜色参考|recolor/i.test(String(value || ""));
}

function isWhiteRefinePageName(value) {
  return /批量白底精修|白底精修|白底图精修|服装精修|平铺精修|挂拍精修|去衣架|去掉衣架|white\s*refine/i.test(String(value || ""));
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

function mentionsOptionalReferenceImage(prompt, productNote) {
  const text = [prompt, productNote].join("\n");
  return /图\s*3|图三|第三张|第三个|补充图|补充参考|参考图\s*3|reference\s*3/i.test(String(text || ""));
}

function defaultUploadLabelsForPage(name) {
  if (isPoseRemixPageName(name)) return POSE_REMIX_UPLOAD_LABELS;
  if (isLocalDetailPageName(name)) return LOCAL_DETAIL_UPLOAD_LABELS;
  if (isDesignDraftPageName(name)) return DESIGN_DRAFT_UPLOAD_LABELS;
  if (isFaceSwapPageName(name)) return FACE_SWAP_UPLOAD_LABELS;
  if (isRandomBackgroundPageName(name)) return RANDOM_BACKGROUND_UPLOAD_LABELS;
  if (isBackgroundChangePageName(name)) return BACKGROUND_CHANGE_UPLOAD_LABELS;
  if (isOutpaintPageName(name)) return OUTPAINT_UPLOAD_LABELS;
  if (isRecolorPageName(name)) return RECOLOR_UPLOAD_LABELS;
  if (isWhiteRefinePageName(name)) return WHITE_REFINE_UPLOAD_LABELS;
  if (isCustomWorkflowPageName(name)) return CUSTOM_UPLOAD_LABELS;
  return DEFAULT_UPLOAD_LABELS;
}

function defaultPromptForWorkflowMode(mode) {
  if (mode === "pose-remix") return POSE_REMIX_DEFAULT_PROMPT;
  if (mode === "design-draft") return DESIGN_DRAFT_DEFAULT_PROMPT;
  if (mode === "face-swap") return FACE_SWAP_DEFAULT_PROMPT;
  if (mode === "random-background") return RANDOM_BACKGROUND_DEFAULT_PROMPT;
  if (mode === "background-change") return BACKGROUND_CHANGE_DEFAULT_PROMPT;
  if (mode === "outpaint") return OUTPAINT_DEFAULT_PROMPT;
  if (mode === "recolor") return RECOLOR_DEFAULT_PROMPT;
  if (mode === "white-refine") return WHITE_REFINE_DEFAULT_PROMPT;
  if (mode === "local-detail") return LOCAL_DETAIL_DEFAULT_PROMPT;
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
  if (isLocalDetailPageName(pageName)) {
    return "local-detail";
  }
  if (isFaceSwapPageName(pageName)) {
    return "face-swap";
  }
  if (isRandomBackgroundPageName(pageName) || isRandomBackgroundPageName(text)) {
    return "random-background";
  }
  if (isOutpaintPageName(pageName) || isOutpaintPageName(text) || /待扩图原图|扩图参考图|向下扩图|补全下半身/.test(text)) {
    return "outpaint";
  }
  if (isWhiteRefinePageName(pageName) || isWhiteRefinePageName(text) || /平铺图|挂拍图|衣架去除|可选参考\/细节图|白底商品图/.test(text)) {
    return "white-refine";
  }
  if (isRecolorPageName(pageName) || isRecolorPageName(text) || /改色服装参考图|目标颜色|颜色替换/.test(text)) {
    return "recolor";
  }
  if (isPoseRemixPageName(text) || /固定母版成片|批量姿势参考图|批量姿态图|姿态参考图|只提取姿势|固定成片/i.test(text)) {
    return "pose-remix";
  }
  if (isFaceSwapPageName(text) || /目标人物图|人脸参考图|妆容|表情|脸部身份/.test(text)) {
    return "face-swap";
  }
  if (isDesignDraftPageName(text) || /设计稿|設計稿|design|实拍服装|真人实拍|细节补充/.test(text)) {
    return "design-draft";
  }
  const explicitBackgroundPage = isBackgroundChangePageName(pageName) || isBackgroundChangePageName(clothingTitle);
  const backgroundLabelPair = /人物图|人物照|人物|模特图|模特/i.test(modelTitle)
    && /固定背景|统一场景|场景图|目标场景|背景图|换背景|背景/i.test(clothingTitle);
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

function uploadLabelsMatchPreset(value, preset) {
  return ["model", "clothing", "reference"].every((key) => (
    String(value?.[key]?.title || "") === String(preset?.[key]?.title || "")
    && String(value?.[key]?.hint || "") === String(preset?.[key]?.hint || "")
  ));
}

function isLegacyPoseRemixUploadLabels(value = {}) {
  const modelTitle = String(value?.model?.title || "");
  const clothingTitle = String(value?.clothing?.title || "");
  return /固定母版|固定成片|固定模特/i.test(modelTitle)
    && /姿势|姿态|pose/i.test(clothingTitle);
}

function inferOutfitWorkflowMode(pageName, uploadLabels) {
  return workflowModeFromPage(pageName, uploadLabels);
}

function isSingletonWorkflowMode(mode) {
  return SINGLETON_WORKFLOW_MODES.has(String(mode || ""));
}

function outfitPageContentScore(page = {}) {
  const imageCount = (Array.isArray(page.modelImages) ? page.modelImages.length : 0)
    + (Array.isArray(page.clothingImages) ? page.clothingImages.length : 0)
    + (Array.isArray(page.referenceImages) ? page.referenceImages.length : 0);
  const taskCount = Array.isArray(page.tasks) ? page.tasks.length : 0;
  const libraryCount = Array.isArray(page.originalLibrary) ? page.originalLibrary.length : 0;
  return imageCount * 10
    + taskCount * 4
    + libraryCount * 2
    + (page.fixedClothingId ? 3 : 0)
    + (String(page.settings?.productNote || "").trim() ? 1 : 0);
}

function dedupeSingletonWorkflowPages(pages = []) {
  const output = [];
  const singletonIndexByMode = new Map();
  for (const page of Array.isArray(pages) ? pages : []) {
    if (!page) continue;
    const mode = inferOutfitWorkflowMode(page.name, page.uploadLabels);
    if (!isSingletonWorkflowMode(mode)) {
      output.push(page);
      continue;
    }
    const existingIndex = singletonIndexByMode.get(mode);
    if (existingIndex === undefined) {
      singletonIndexByMode.set(mode, output.length);
      output.push(page);
      continue;
    }
    if (outfitPageContentScore(page) > outfitPageContentScore(output[existingIndex])) {
      output[existingIndex] = page;
    }
  }
  return output;
}

function normalizeOutfitPageSettings(value = {}, options = {}) {
  const settings = { ...defaultSettings, ...(value || {}) };
  if (shouldUpgradeLegacyBatchConcurrency(settings)) {
    settings.concurrency = DEFAULT_BATCH_CONCURRENCY;
    settings[BATCH_CONCURRENCY_DEFAULT_MIGRATION_KEY] = true;
  }
  if (settings.generationCount === 10 && settings[GENERATION_COUNT_AUTOLINK_MIGRATION_KEY] !== true) {
    settings.generationCount = "auto";
    settings[GENERATION_COUNT_AUTOLINK_MIGRATION_KEY] = true;
  }
  if (!(options.allowEmptyPrompt && !String(settings.prompt || "").trim()) && shouldRepairOutfitPrompt(settings.prompt)) {
    settings.prompt = OUTFIT_DEFAULT_PROMPT;
  }
  settings.generationCount = normalizeGenerationCount(settings.generationCount);
  settings.smartIntervention = normalizeSmartIntervention(settings.smartIntervention);
  settings.batchSkillRulesEnabled = settings.batchSkillRulesEnabled === true;
  settings.qualityCheck = normalizeQualityCheck(settings.qualityCheck);
  settings.garmentParts = normalizeGarmentParts(settings.garmentParts);
  settings.garmentComposition = normalizeGarmentComposition(settings.garmentComposition, settings.garmentParts);
  settings.garmentLengths = normalizeGarmentLengths(settings.garmentLengths, settings.garmentParts);
  settings.masterFitLock = normalizeMasterFitLock(settings.masterFitLock);
  settings.masterFitSpec = normalizeMasterFitSpec(settings.masterFitSpec);
  settings.masterFitSourceId = normalizeMasterFitSourceId(settings.masterFitSourceId);
  settings.randomBackgroundFocus = normalizeRandomBackgroundFocus(settings.randomBackgroundFocus);
  settings.concurrency = normalizeBatchConcurrency(settings.concurrency);
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
  const pageMode = inferOutfitWorkflowMode(pageName, patch.uploadLabels || {});
  const allowEmptyPrompt = patch.allowEmptyPrompt || pageMode === "custom" || pageMode === "local-detail";
  const sourceSettings = patch.settings || readSettings();
  const sourcePrompt = String(sourceSettings.prompt || "");
  const migratedSettings = pageMode === "face-swap" && (
    !sourcePrompt.trim()
    || sourcePrompt === FACE_SWAP_SHORT_DEFAULT_PROMPT
    || sourcePrompt === FACE_SWAP_BATCH_TONE_LEGACY_DEFAULT_PROMPT
    || sourcePrompt === FACE_SWAP_HEAD_LOCK_LEGACY_DEFAULT_PROMPT
    || sourcePrompt === LEGACY_FACE_SWAP_DEFAULT_PROMPT
    || sourcePrompt === FACE_SWAP_LOOSE_DEFAULT_PROMPT
    || sourcePrompt === POSE_MOTHER_FACE_SWAP_DEFAULT_PROMPT
    || sourcePrompt === FACE_SWAP_PRE_HEAD_LOCK_SHORT_DEFAULT_PROMPT
    || sourcePrompt === FACE_SWAP_PRE_HEAD_LOCK_DEFAULT_PROMPT
  )
    ? { ...sourceSettings, prompt: FACE_SWAP_DEFAULT_PROMPT, productNote: "", pairingMode: "fixed" }
    : pageMode === "random-background" && (
      !sourcePrompt.trim()
      || sourcePrompt === OUTFIT_DEFAULT_PROMPT
      || sourcePrompt === BACKGROUND_CHANGE_DEFAULT_PROMPT
      || sourcePrompt === BACKGROUND_CHANGE_LEGACY_DEFAULT_PROMPT
      || sourcePrompt === BACKGROUND_CHANGE_PERSON_LIGHT_LEGACY_DEFAULT_PROMPT
      || sourcePrompt === RANDOM_BACKGROUND_LIGHT_LEGACY_DEFAULT_PROMPT
      || sourcePrompt === RANDOM_BACKGROUND_NEUTRAL_DAYLIGHT_LEGACY_DEFAULT_PROMPT
      || sourcePrompt === RANDOM_BACKGROUND_RELIGHT_LEGACY_DEFAULT_PROMPT
      || sourcePrompt === RANDOM_BACKGROUND_LEGACY_DEFAULT_PROMPT
    )
      ? { ...sourceSettings, prompt: RANDOM_BACKGROUND_DEFAULT_PROMPT, productNote: "", smartIntervention: false, pairingMode: "fixed", randomBackgroundFocus: "default" }
    : pageMode === "background-change" && (
      !sourcePrompt.trim()
      || sourcePrompt === BACKGROUND_CHANGE_LEGACY_DEFAULT_PROMPT
      || sourcePrompt === BACKGROUND_CHANGE_PERSON_LIGHT_LEGACY_DEFAULT_PROMPT
    )
      ? { ...sourceSettings, prompt: BACKGROUND_CHANGE_DEFAULT_PROMPT, productNote: "" }
    : pageMode === "outpaint" && (
      !sourcePrompt.trim()
      || sourcePrompt === OUTFIT_DEFAULT_PROMPT
      || sourcePrompt === BACKGROUND_CHANGE_DEFAULT_PROMPT
    )
      ? { ...sourceSettings, prompt: OUTPAINT_DEFAULT_PROMPT, productNote: "", smartIntervention: false, pairingMode: "fixed", aspectRatio: "9:16" }
    : pageMode === "recolor" && (
      !sourcePrompt.trim()
      || sourcePrompt === OUTFIT_DEFAULT_PROMPT
      || sourcePrompt === BACKGROUND_CHANGE_DEFAULT_PROMPT
      || sourcePrompt === RECOLOR_COLOR_LEGACY_DEFAULT_PROMPT
    )
      ? { ...sourceSettings, prompt: RECOLOR_DEFAULT_PROMPT, productNote: "", smartIntervention: false, pairingMode: "fixed" }
    : pageMode === "white-refine" && (
      !sourcePrompt.trim()
      || sourcePrompt === OUTFIT_DEFAULT_PROMPT
      || sourcePrompt === RECOLOR_DEFAULT_PROMPT
      || sourcePrompt === BACKGROUND_CHANGE_DEFAULT_PROMPT
      || sourcePrompt === WHITE_REFINE_COLOR_LOCK_LEGACY_DEFAULT_PROMPT
    )
      ? { ...sourceSettings, prompt: WHITE_REFINE_DEFAULT_PROMPT, productNote: "", smartIntervention: false, pairingMode: "fixed" }
    : pageMode === "pose-remix"
      ? { ...sourceSettings, pairingMode: "fixed" }
      : pageMode === "local-detail" && !String(sourceSettings.prompt || "").trim()
        ? { ...sourceSettings, prompt: LOCAL_DETAIL_DEFAULT_PROMPT, productNote: "" }
        : sourceSettings;
  const sourceUploadLabels = patch.uploadLabels || {};
  const migratedUploadLabels = pageMode === "face-swap" && (
    !patch.uploadLabels
    || uploadLabelsMatchPreset(sourceUploadLabels, LEGACY_FACE_SWAP_UPLOAD_LABELS)
    || uploadLabelsMatchPreset(sourceUploadLabels, POSE_MOTHER_FACE_SWAP_UPLOAD_LABELS)
  )
    ? FACE_SWAP_UPLOAD_LABELS
    : pageMode === "pose-remix" && (
      !patch.uploadLabels
      || uploadLabelsMatchPreset(sourceUploadLabels, LEGACY_POSE_REMIX_UPLOAD_LABELS)
      || isLegacyPoseRemixUploadLabels(sourceUploadLabels)
    )
      ? POSE_REMIX_UPLOAD_LABELS
      : pageMode === "random-background" && (
        !patch.uploadLabels
        || uploadLabelsMatchPreset(sourceUploadLabels, DEFAULT_UPLOAD_LABELS)
        || uploadLabelsMatchPreset(sourceUploadLabels, BACKGROUND_CHANGE_UPLOAD_LABELS)
      )
        ? RANDOM_BACKGROUND_UPLOAD_LABELS
      : pageMode === "background-change" && (
        !patch.uploadLabels
        || String(sourceUploadLabels?.clothing?.title || "").trim() === "统一场景图"
      )
        ? BACKGROUND_CHANGE_UPLOAD_LABELS
      : pageMode === "outpaint" && (
        !patch.uploadLabels
        || uploadLabelsMatchPreset(sourceUploadLabels, DEFAULT_UPLOAD_LABELS)
        || uploadLabelsMatchPreset(sourceUploadLabels, BACKGROUND_CHANGE_UPLOAD_LABELS)
      )
        ? OUTPAINT_UPLOAD_LABELS
      : pageMode === "recolor" && (
        !patch.uploadLabels
        || uploadLabelsMatchPreset(sourceUploadLabels, DEFAULT_UPLOAD_LABELS)
        || uploadLabelsMatchPreset(sourceUploadLabels, BACKGROUND_CHANGE_UPLOAD_LABELS)
      )
        ? RECOLOR_UPLOAD_LABELS
      : pageMode === "local-detail" && (
        !patch.uploadLabels
        || uploadLabelsMatchPreset(sourceUploadLabels, CUSTOM_UPLOAD_LABELS)
      )
        ? LOCAL_DETAIL_UPLOAD_LABELS
        : sourceUploadLabels;
  return {
    id: String(patch.id || makeId("outfit_page")),
    name: pageName,
    deleteLocked: Boolean(patch.deleteLocked),
    settings: stripOutfitPageGlobalSettings(migratedSettings, { allowEmptyPrompt }),
    modelImages: Array.isArray(patch.modelImages) ? patch.modelImages : [],
    clothingImages: Array.isArray(patch.clothingImages) ? patch.clothingImages : [],
    referenceImages: Array.isArray(patch.referenceImages) ? patch.referenceImages : [],
    fixedClothingId: String(patch.fixedClothingId || ""),
    tasks: Array.isArray(patch.tasks) ? patch.tasks : [],
    originalLibrary: Array.isArray(patch.originalLibrary) ? patch.originalLibrary : [],
    activeUploadGroup: patch.activeUploadGroup || "model",
    uploadLabels: normalizeUploadLabels(migratedUploadLabels, pageName)
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

function makePoseRemixPage(baseSettings = readSettings(), patch = {}) {
  return makeOutfitPage(DEFAULT_POSE_REMIX_PAGE_NAME, {
    deleteLocked: true,
    ...patch,
    settings: {
      ...baseSettings,
      prompt: POSE_REMIX_DEFAULT_PROMPT,
      productNote: "",
      smartIntervention: false,
      pairingMode: "fixed",
      ...(patch.settings || {})
    },
    uploadLabels: patch.uploadLabels || POSE_REMIX_UPLOAD_LABELS
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

function makeRandomBackgroundPage(baseSettings = readSettings(), patch = {}) {
  return makeOutfitPage(DEFAULT_RANDOM_BACKGROUND_PAGE_NAME, {
    deleteLocked: true,
    ...patch,
    settings: {
      ...baseSettings,
      prompt: RANDOM_BACKGROUND_DEFAULT_PROMPT,
      productNote: "",
      smartIntervention: false,
      pairingMode: "fixed",
      randomBackgroundFocus: "default",
      ...(patch.settings || {})
    },
    uploadLabels: patch.uploadLabels || RANDOM_BACKGROUND_UPLOAD_LABELS
  });
}

function makeRecolorPage(baseSettings = readSettings(), patch = {}) {
  return makeOutfitPage(DEFAULT_RECOLOR_PAGE_NAME, {
    deleteLocked: true,
    ...patch,
    settings: {
      ...baseSettings,
      prompt: RECOLOR_DEFAULT_PROMPT,
      productNote: "",
      smartIntervention: false,
      pairingMode: "fixed",
      garmentParts: DEFAULT_GARMENT_PARTS,
      garmentComposition: DEFAULT_GARMENT_COMPOSITION,
      garmentLengths: DEFAULT_GARMENT_LENGTHS,
      ...(patch.settings || {})
    },
    uploadLabels: patch.uploadLabels || RECOLOR_UPLOAD_LABELS
  });
}

function makeWhiteRefinePage(baseSettings = readSettings(), patch = {}) {
  return makeOutfitPage(DEFAULT_WHITE_REFINE_PAGE_NAME, {
    deleteLocked: true,
    ...patch,
    settings: {
      ...baseSettings,
      prompt: WHITE_REFINE_DEFAULT_PROMPT,
      productNote: "",
      smartIntervention: false,
      pairingMode: "fixed",
      ...(patch.settings || {})
    },
    uploadLabels: patch.uploadLabels || WHITE_REFINE_UPLOAD_LABELS
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
  let output = dedupeSingletonWorkflowPages(Array.isArray(pages) ? pages.filter(Boolean) : [])
    .filter((page) => {
      const mode = inferOutfitWorkflowMode(page.name, page.uploadLabels);
      return mode !== "local-detail" && mode !== "outpaint";
    });
  const hasPoseRemixPage = output.some((page) => inferOutfitWorkflowMode(page.name, page.uploadLabels) === "pose-remix");
  const hasBackgroundChangePage = output.some((page) => inferOutfitWorkflowMode(page.name, page.uploadLabels) === "background-change");
  const hasRandomBackgroundPage = output.some((page) => inferOutfitWorkflowMode(page.name, page.uploadLabels) === "random-background");
  const hasRecolorPage = output.some((page) => inferOutfitWorkflowMode(page.name, page.uploadLabels) === "recolor");
  const hasWhiteRefinePage = output.some((page) => inferOutfitWorkflowMode(page.name, page.uploadLabels) === "white-refine");
  const hasFaceSwapPage = output.some((page) => inferOutfitWorkflowMode(page.name, page.uploadLabels) === "face-swap");
  const hasDesignDraftPage = output.some((page) => inferOutfitWorkflowMode(page.name, page.uploadLabels) === "design-draft");

  if (!hasPoseRemixPage) {
    const outfitIndex = output.findIndex((page) => inferOutfitWorkflowMode(page.name, page.uploadLabels) === "outfit");
    const poseRemixPage = makePoseRemixPage(baseSettings);
    output = outfitIndex >= 0
      ? [...output.slice(0, outfitIndex + 1), poseRemixPage, ...output.slice(outfitIndex + 1)]
      : [poseRemixPage, ...output];
  }

  if (!hasBackgroundChangePage) {
    const designIndex = output.findIndex((page) => ["face-swap", "design-draft"].includes(inferOutfitWorkflowMode(page.name, page.uploadLabels)));
    const backgroundPage = makeBackgroundChangePage(baseSettings);
    output = designIndex >= 0
      ? [...output.slice(0, designIndex), backgroundPage, ...output.slice(designIndex)]
      : [...output, backgroundPage];
  }

  if (!hasRandomBackgroundPage) {
    const backgroundIndex = output.findIndex((page) => inferOutfitWorkflowMode(page.name, page.uploadLabels) === "background-change");
    const recolorIndex = output.findIndex((page) => inferOutfitWorkflowMode(page.name, page.uploadLabels) === "recolor");
    const designIndex = output.findIndex((page) => ["face-swap", "design-draft"].includes(inferOutfitWorkflowMode(page.name, page.uploadLabels)));
    const randomBackgroundPage = makeRandomBackgroundPage(baseSettings);
    output = backgroundIndex >= 0
      ? [...output.slice(0, backgroundIndex + 1), randomBackgroundPage, ...output.slice(backgroundIndex + 1)]
      : recolorIndex >= 0
        ? [...output.slice(0, recolorIndex), randomBackgroundPage, ...output.slice(recolorIndex)]
        : designIndex >= 0
          ? [...output.slice(0, designIndex), randomBackgroundPage, ...output.slice(designIndex)]
          : [...output, randomBackgroundPage];
  }

  if (!hasRecolorPage) {
    const randomBackgroundIndex = output.findIndex((page) => inferOutfitWorkflowMode(page.name, page.uploadLabels) === "random-background");
    const backgroundIndex = output.findIndex((page) => inferOutfitWorkflowMode(page.name, page.uploadLabels) === "background-change");
    const designIndex = output.findIndex((page) => ["face-swap", "design-draft"].includes(inferOutfitWorkflowMode(page.name, page.uploadLabels)));
    const recolorPage = makeRecolorPage(baseSettings);
    output = randomBackgroundIndex >= 0
      ? [...output.slice(0, randomBackgroundIndex + 1), recolorPage, ...output.slice(randomBackgroundIndex + 1)]
      : backgroundIndex >= 0
        ? [...output.slice(0, backgroundIndex + 1), recolorPage, ...output.slice(backgroundIndex + 1)]
      : designIndex >= 0
        ? [...output.slice(0, designIndex), recolorPage, ...output.slice(designIndex)]
        : [...output, recolorPage];
  }

  if (!hasWhiteRefinePage) {
    const recolorIndex = output.findIndex((page) => inferOutfitWorkflowMode(page.name, page.uploadLabels) === "recolor");
    const designIndex = output.findIndex((page) => ["face-swap", "design-draft"].includes(inferOutfitWorkflowMode(page.name, page.uploadLabels)));
    const whiteRefinePage = makeWhiteRefinePage(baseSettings);
    output = recolorIndex >= 0
      ? [...output.slice(0, recolorIndex + 1), whiteRefinePage, ...output.slice(recolorIndex + 1)]
      : designIndex >= 0
        ? [...output.slice(0, designIndex), whiteRefinePage, ...output.slice(designIndex)]
        : [...output, whiteRefinePage];
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

  const faceSwapIndex = output.findIndex((page) => inferOutfitWorkflowMode(page.name, page.uploadLabels) === "face-swap");
  const poseRemixIndex = output.findIndex((page) => inferOutfitWorkflowMode(page.name, page.uploadLabels) === "pose-remix");
  if (faceSwapIndex >= 0 && poseRemixIndex >= 0 && faceSwapIndex !== poseRemixIndex + 1) {
    const faceSwapPage = output[faceSwapIndex];
    const withoutFaceSwap = output.filter((_, index) => index !== faceSwapIndex);
    const nextPoseRemixIndex = withoutFaceSwap.findIndex((page) => inferOutfitWorkflowMode(page.name, page.uploadLabels) === "pose-remix");
    output = [
      ...withoutFaceSwap.slice(0, nextPoseRemixIndex + 1),
      faceSwapPage,
      ...withoutFaceSwap.slice(nextPoseRemixIndex + 1)
    ];
  }

  return dedupeSingletonWorkflowPages(output);
}

function serializeOutfitPage(page) {
  const pageName = normalizeOutfitPageName(page?.name, DEFAULT_OUTFIT_PAGE_NAME);
  const pageMode = inferOutfitWorkflowMode(pageName, page?.uploadLabels || {});
  const allowEmptyPrompt = pageMode === "custom" || pageMode === "local-detail";
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
  // 2026-09-25：把旧默认值 3000 迁移到新默认值 3500。
  // 旧存档里 3000 几乎都是"从没改过"（当年就是默认值），所以跟着新默认走；
  // 用户真正改过的其它值不受影响。迁移只在读取时生效，下次保存即写回 3500。
  if (Number.parseInt(next.longEdge, 10) === LEGACY_RESIZE_LONG_EDGE_DEFAULT) {
    next.longEdge = DEFAULT_RESIZE_SETTINGS.longEdge;
  }
  next.longEdge = clampResizeEdge(next.longEdge);
  next.fitMode = ["original", "pad", "crop", "original-size"].includes(next.fitMode) ? next.fitMode : DEFAULT_RESIZE_SETTINGS.fitMode;
  next.outputFormat = RESIZE_FORMAT_OPTIONS.some((option) => option.value === next.outputFormat) ? next.outputFormat : DEFAULT_RESIZE_SETTINGS.outputFormat;
  next.dpi = Math.max(1, Math.min(1200, Number.parseInt(next.dpi, 10) || DEFAULT_RESIZE_SETTINGS.dpi));
  next.fillColor = RESIZE_FILL_OPTIONS.some((option) => option.value === next.fillColor) ? next.fillColor : "#ffffff";
  next.cropMode = next.cropMode === "individual" ? "individual" : "batch";
  // 2026-09-25：自动裁剪已移除；把旧存档里遗留的持久化字段清掉，
  // 避免 localStorage 里继续留着一组永远不会被读取的无效状态。
  delete next.autoCropEnabled;
  delete next.autoCropMode;
  delete next.autoCropTopMarginPx;
  delete next.autoCropBottomMarginPx;
  delete next.autoCropHalfMode;
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
  if (status === "detached") return "待确认";
  if (status === "failed") return "失败";
  return status || "--";
}

function qualityStatusClass(check) {
  const status = normalizeQualityCheckResult(check)?.status || "";
  if (status === "passed") return "pass";
  if (status === "failed") return "fail";
  if (status === "checking" || status === "pending") return "checking";
  if (status === "skipped") return "skipped";
  return status ? "error" : "";
}

function qualityStatusLabel(check) {
  const item = normalizeQualityCheckResult(check);
  if (!item) return "";
  const score = Number.isFinite(item.score) ? ` ${item.score}` : "";
  if (item.status === "passed") return `质检合格${score}`;
  if (item.status === "failed") return `质检不合格${score}`;
  if (item.status === "checking") return "AI质检中";
  if (item.status === "pending") return "等待质检";
  if (item.status === "skipped") return "未质检";
  return "质检异常";
}

function qualityBadgeTitle(check) {
  const item = normalizeQualityCheckResult(check);
  if (!item) return "";
  return [
    qualityStatusLabel(item),
    item.summary,
    item.faceQuality ? `脸部：${item.faceQuality}` : "",
    item.poseMatch ? `姿态：${item.poseMatch}` : "",
    item.outfitMatch ? `服装：${item.outfitMatch}` : "",
    item.issues.length ? `问题：${item.issues.join("；")}` : "",
    item.repairPrompt ? `返修：${item.repairPrompt}` : ""
  ].filter(Boolean).join("\n");
}

function taskRuntimeStageLabel(task) {
  const stage = String(task?.runtimeStage || "").trim();
  const detail = String(task?.runtimeDetail || "").trim();
  if (!stage && !detail) return "";
  return [stage, detail].filter(Boolean).join("：");
}

function localPasteDiagnosticSummary(image) {
  const diagnostics = image?.localEdit?.diagnostics;
  if (!diagnostics) return null;
  const align = diagnostics.align || {};
  const color = diagnostics.colorMatchDetail || {};
  const neutral = diagnostics.neutralToneMatchDetail || {};
  const paste = diagnostics.pasteRect || {};
  const binding = diagnostics.taskBinding || {};
  const sharpen = diagnostics.sharpen || {};
  const output = diagnostics.output || {};
  const items = [
    diagnostics.strategy ? `策略 ${diagnostics.strategy}` : "",
    binding.modelName ? `图1 ${binding.modelName}` : "",
    binding.batchMode ? `批量 ${binding.batchMode}` : "",
    Number.isFinite(binding.cropQuality) && binding.cropQuality > 0 ? `裁剪 Q${binding.cropQuality}` : "",
    output.lossless ? "输出 PNG无损" : output.quality ? `输出 Q${output.quality}` : "",
    diagnostics.autoAlign
      ? `对齐 ${align.applied ? `${align.dx || 0},${align.dy || 0}` : align.reason || "未偏移"}`
      : "对齐 关闭",
    diagnostics.colorMatch
      ? `色彩 ${color.applied ? `${color.deltaR ?? 0}/${color.deltaG ?? 0}/${color.deltaB ?? 0}` : color.reason || "未调整"}`
      : "色彩 关闭",
    diagnostics.neutralToneMatch
      ? `中性色偏 ${neutral.applied ? `${neutral.deltaR ?? 0}/${neutral.deltaG ?? 0}/${neutral.deltaB ?? 0}` : neutral.reason || "未调整"}`
      : "",
    diagnostics.sharpenPatch
      ? `清晰 ${sharpen.applied ? "补偿" : sharpen.reason || "未补偿"}`
      : "",
    Number.isFinite(diagnostics.feather) ? `羽化 ${diagnostics.feather}px` : "",
    paste.width && paste.height ? `贴回 ${paste.width}x${paste.height}` : ""
  ].filter(Boolean);
  if (!items.length) return null;
  return {
    title: diagnostics.hasMask ? "局部回贴诊断 · 蒙版" : "局部回贴诊断",
    items
  };
}

function LocalPasteDiagnosticsPanel({ image }) {
  const summary = localPasteDiagnosticSummary(image);
  if (!summary) return null;
  return (
    <section className="previewLocalPastePanel">
      <header>
        <strong>{summary.title}</strong>
      </header>
      <div className="previewQualityFacts">
        {summary.items.map((item) => <span key={item}>{item}</span>)}
      </div>
    </section>
  );
}

function cropReturnDiagnosticSummary(image) {
  const cropReturn = normalizeCropReturnMeta(image?.cropReturn);
  if (!cropReturn?.cropRect) return null;
  const diagnostics = image?.cropReturn?.diagnostics || {};
  const output = diagnostics.output || {};
  const items = [
    diagnostics.strategy ? `策略 ${diagnostics.strategy}` : "",
    cropReturn.sourceWidth && cropReturn.sourceHeight ? `原图 ${cropReturn.sourceWidth}x${cropReturn.sourceHeight}` : "",
    cropReturn.cropRect.width && cropReturn.cropRect.height ? `裁剪 ${cropReturn.cropRect.width}x${cropReturn.cropRect.height}` : "",
    cropReturn.outputWidth && cropReturn.outputHeight ? `大图 ${cropReturn.outputWidth}x${cropReturn.outputHeight}` : "",
    diagnostics.generatedWidth && diagnostics.generatedHeight ? `生成 ${diagnostics.generatedWidth}x${diagnostics.generatedHeight}` : "",
    output.quality ? `输出 Q${output.quality}` : "",
    output.bytes ? `文件 ${fileSize(output.bytes)}` : ""
  ].filter(Boolean);
  if (!items.length) return null;
  return {
    title: "裁剪回流诊断",
    items
  };
}

function CropReturnDiagnosticsPanel({ image }) {
  const summary = cropReturnDiagnosticSummary(image);
  if (!summary) return null;
  return (
    <section className="previewCropReturnPanel">
      <header>
        <strong>{summary.title}</strong>
      </header>
      <div className="previewQualityFacts">
        {summary.items.map((item) => <span key={item}>{item}</span>)}
      </div>
    </section>
  );
}

function hasGenerationPendingStatus(task) {
  return task?.status === "running" || task?.status === "queued";
}

function isRefreshInterruptedTask(task) {
  const text = [task?.error, task?.errorDetail].filter(Boolean).join("\n");
  return /页面刷新后任务已中断|页面刷新会中断当前浏览器里的批量生成 worker/.test(text);
}

function detachPersistedTask(task) {
  const finishedAt = Date.now();
  const startedAt = Number(task.startedAt || task.createdAt || finishedAt);
  return {
    ...task,
    status: "detached",
    error: "页面已刷新，结果请到保存目录确认",
    errorDetail: "这不是模型失败。页面刷新会断开浏览器当前任务响应；如果后台或上游已经完成，结果图可能已经保存到指定文件夹。没有看到结果时再重新生成。",
    runtimeStage: "刷新后待确认",
    runtimeDetail: task.runtimeStage ? `刷新前：${taskRuntimeStageLabel(task)}` : "原任务可能仍在后台或上游继续完成",
    runtimeUpdatedAt: finishedAt,
    timingMs: Math.max(1, finishedAt - startedAt),
    finishedAt,
    autoSaveFailed: false
  };
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

function cacheableResultImageSource(image) {
  if (!image) return "";
  const localUrl = String(image.localUrl || "");
  if (/^https?:\/\//i.test(localUrl)) return localUrl;
  const value = String(image.type === "url" ? image.value || "" : "");
  if (/^https?:\/\//i.test(value)) return value;
  return "";
}

function resultImageCacheKey(image) {
  const source = cacheableResultImageSource(image);
  return source ? `${OUTFIT_RESULT_IMAGE_CACHE_PREFIX}${source}` : "";
}

function stripRuntimeResultImageCache(image) {
  if (!image || typeof image !== "object") return image;
  const {
    cachedUrl,
    cachedBlob,
    cachedFile,
    cachedFrom,
    cachedAt,
    ...rest
  } = image;
  if (image.type === "local_blob") {
    if (!image.localUrl) return null;
    return {
      ...rest,
      type: "url",
      value: image.localUrl
    };
  }
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

function taskHasCropReturnResult(task) {
  return Boolean(task?.cropReturn?.cropRect || task?.result?.cropReturn?.enabled);
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
    outpaintReferenceItems: [],
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
      return {
        ...image,
        cachedUrl,
        cachedBlob,
        cachedFrom: source,
        cachedAt: Number(cached?.createdAt || cached?.updatedAt || Date.now())
      };
    }
  } catch {}

  try {
    const blob = await fetchBlobWithTimeout(displayImageRequestUrl(source));
    if (!blob || blob.size <= 0) return image;
    const createdAt = Date.now();
    const cachedUrl = URL.createObjectURL(blob);
    await outfitLocalSet(key, {
      blob,
      mimeType: blob.type || image.archiveMime || image.mimeType || "image/png",
      source,
      createdAt
    });
    return {
      ...image,
      cachedUrl,
      cachedBlob: blob,
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

function displayResultImageSource(image) {
  const src = imageSource(image);
  return displayImageRequestUrl(src);
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

function PreparedResultImage({ src, diagnostic, ...props }) {
  const [displaySrc, setDisplaySrc] = useState(() => {
    if (!src || src.startsWith("data:") || src.startsWith("blob:")) return src || "";
    return "";
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
      const displayMs = Math.round((typeof performance !== "undefined" ? performance.now() : Date.now()) - startedAt);
      emitClientDiagnosticEvent({
        requestId,
        stage: "client-result-display-ready",
        endpoint: diagnostic?.endpoint || "/api/generate-outfit",
        method: "DISPLAY",
        ok: true,
        durationMs: displayMs,
        detail: {
          taskId: requestId,
          placement: diagnostic?.placement || "",
          module: diagnostic?.module || "",
          workflowMode: diagnostic?.workflowMode || "",
          sourceType: diagnosticImageSourceType(shownSrc || src),
          displayMs
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
    setDisplaySrc("");
    preloadImageUrl(src, RESULT_IMAGE_PRELOAD_TIMEOUT_MS).then(() => {
      if (!cancelled) {
        setDisplaySrc(src);
        emitDisplayReady(src);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [src]);

  return <img {...props} src={displaySrc || undefined} />;
}

function imageItemPreviewFile(item) {
  return item?.localEdit?.cropFile || item?.file || item?.originalFile || null;
}

function imageItemUploadFile(item) {
  return item?.file || item?.originalFile || null;
}

function imageItemDisplayName(item) {
  return String(item?.name || item?.originalFile?.name || item?.file?.name || "").trim();
}

function hasImageItemUploadFile(item) {
  const file = imageItemUploadFile(item);
  if (!file) return false;
  if (typeof Blob === "undefined") return true;
  return file instanceof Blob;
}

function resolveUploadImageItem(items = [], id = "", name = "", usedIds = new Set()) {
  const list = (Array.isArray(items) ? items : []).filter(hasImageItemUploadFile);
  const normalizedId = String(id || "");
  if (normalizedId) {
    const match = list.find((item) => String(item?.id || "") === normalizedId);
    if (match) return match;
  }
  const normalizedName = String(name || "").trim();
  if (!normalizedName) return null;
  return list.find((item) => !usedIds.has(String(item?.id || "")) && imageItemDisplayName(item) === normalizedName) || null;
}

function resolveUploadImageItems(items = [], ids = [], fallbackNames = [], usedIds = new Set()) {
  const resolved = [];
  const append = (item) => {
    if (!item) return;
    const id = String(item.id || "");
    if (id && usedIds.has(id)) return;
    if (id) usedIds.add(id);
    resolved.push(item);
  };
  (Array.isArray(ids) ? ids : []).forEach((id) => append(resolveUploadImageItem(items, id, "", usedIds)));
  (Array.isArray(fallbackNames) ? fallbackNames : []).forEach((name) => append(resolveUploadImageItem(items, "", name, usedIds)));
  return resolved;
}

function hydrateTaskUploadReferences(task, sources = {}) {
  if (!task || typeof task !== "object") return task;
  const modelImages = Array.isArray(sources.modelImages) ? sources.modelImages : [];
  const clothingImages = Array.isArray(sources.clothingImages) ? sources.clothingImages : [];
  const referenceImages = Array.isArray(sources.referenceImages) ? sources.referenceImages : [];
  const workflow = task.workflowMode || "";
  const referenceNames = Array.isArray(task.referenceNames) ? task.referenceNames : [];
  const usedModelIds = new Set();
  const usedClothingIds = new Set();
  const usedReferenceIds = new Set();

  const modelItem = hasImageItemUploadFile(task.modelItem)
    ? task.modelItem
    : resolveUploadImageItem(modelImages, task.modelImageId, task.modelName, usedModelIds);
  if (modelItem?.id) usedModelIds.add(String(modelItem.id));

  const clothingItem = hasImageItemUploadFile(task.clothingItem)
    ? task.clothingItem
    : resolveUploadImageItem(clothingImages, task.clothingImageId, task.clothingName, usedClothingIds);
  if (clothingItem?.id) usedClothingIds.add(String(clothingItem.id));

  const extraModelItems = Array.isArray(task.extraModelItems) && task.extraModelItems.some(hasImageItemUploadFile)
    ? task.extraModelItems.filter(hasImageItemUploadFile)
    : resolveUploadImageItems(
        modelImages,
        task.extraModelImageIds,
        workflow === "design-draft" ? referenceNames : [],
        usedModelIds
      );

  const extraClothingItems = Array.isArray(task.extraClothingItems) && task.extraClothingItems.some(hasImageItemUploadFile)
    ? task.extraClothingItems.filter(hasImageItemUploadFile)
    : resolveUploadImageItems(
        clothingImages,
        task.extraClothingImageIds,
        ["recolor", "white-refine"].includes(workflow) ? referenceNames : [],
        usedClothingIds
      );

  const outpaintReferenceItems = Array.isArray(task.outpaintReferenceItems) && task.outpaintReferenceItems.some(hasImageItemUploadFile)
    ? task.outpaintReferenceItems.filter(hasImageItemUploadFile)
    : resolveUploadImageItems(referenceImages, task.outpaintReferenceImageIds, [], usedReferenceIds);

  const referenceItems = Array.isArray(task.referenceItems) && task.referenceItems.some(hasImageItemUploadFile)
    ? task.referenceItems.filter(hasImageItemUploadFile)
    : resolveUploadImageItems(
        referenceImages,
        task.referenceImageIds,
        ["outfit", "pose-remix", "face-swap", "background-change", "local-detail", "custom"].includes(workflow) ? referenceNames : [],
        usedReferenceIds
      );

  return {
    ...task,
    ...(modelItem ? { modelItem } : {}),
    extraModelItems,
    ...(clothingItem ? { clothingItem } : {}),
    extraClothingItems,
    outpaintReferenceItems,
    referenceItems
  };
}

function hydrateTasksWithUploadReferences(tasks = [], sources = {}) {
  return (Array.isArray(tasks) ? tasks : []).map((task) => hydrateTaskUploadReferences(task, sources));
}

function taskReferencePreviewItems(task) {
  const extraModelItems = Array.isArray(task?.extraModelItems) ? task.extraModelItems : [];
  const outpaintReferenceItems = Array.isArray(task?.outpaintReferenceItems) ? task.outpaintReferenceItems : [];
  const referenceItems = Array.isArray(task?.referenceItems) ? task.referenceItems : [];
  const fallbackReferenceNames = referenceItems.length || outpaintReferenceItems.length
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
    ...(task?.clothingItem || task?.clothingName ? [{
      label: "图2",
      name: task?.clothingItem?.name || task?.clothingName || "图2",
      url: imageItemPreviewSource(task?.clothingItem),
      item: task?.clothingItem
    }] : []),
    ...outpaintReferenceItems.map((item, index) => ({
      label: outpaintReferenceItems.length > 1 ? `图2-${index + 1}` : "图2",
      name: item?.name || `图2-${index + 1}`,
      url: imageItemPreviewSource(item),
      item
    })),
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

function ReferenceThumbTray({ references, count = 0, className = "", max = 5, onOpen, onContextMenu, onImageDragStart }) {
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
                draggable={Boolean(onImageDragStart)}
                onDragStart={onImageDragStart ? (event) => onImageDragStart(event, reference, index, items) : undefined}
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

function fileFromBlob(blob, name, fallbackMimeType = "image/png") {
  const mimeType = blob?.type || fallbackMimeType;
  const extension = imageExtensionFromMime(mimeType);
  return new File([blob], `${fileBaseName(name || "image")}.${extension}`, {
    type: mimeType,
    lastModified: Date.now()
  });
}

async function imageFileFromDropUrl(url, name = `drag-${Date.now()}`) {
  const blob = await fetchImageBlob(url, "图片读取失败");
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

function preprocessModeLabel(mode) {
  return PREPROCESS_OPTIONS.find((option) => option.value === mode)?.label
    || PREPROCESS_OPTIONS.find((option) => option.value === DEFAULT_PREPROCESS_MODE)?.label
    || "白底补边";
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

function normalizeBatchConcurrency(value) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return DEFAULT_BATCH_CONCURRENCY;
  return Math.max(1, Math.min(DEFAULT_BATCH_CONCURRENCY, number));
}

function shouldUpgradeLegacyBatchConcurrency(value = {}) {
  const number = Number.parseInt(value?.concurrency, 10);
  return number === 3 && value?.[BATCH_CONCURRENCY_DEFAULT_MIGRATION_KEY] !== true;
}

/**
 * 批量生成错误的用户可读文案。
 *
 * 2026-09-25：统一走 src/shared/generation-errors.js 的分类器，
 * 只在批量独有的"额度明细"上做增强，其余 10 类错误与快捷生成保持同一套说法。
 * 传入 Error 对象时能带出服务端返回的 requestId 便于查日志。
 */
function summarizeGenerationError(error) {
  const text = (error instanceof Error ? error.message : String(error || "")).trim();
  if (!text) return "";
  const quotaMatch = text.match(/token quota is not enough[\s\S]*?remain quota:\s*[＄$]?([\d.]+)[\s\S]*?need quota:\s*[＄$]?([\d.]+)/i);
  if (quotaMatch) {
    return `额度不足：剩余 $${quotaMatch[1]} / 需要 $${quotaMatch[2]}`;
  }
  return formatGenerationError(error instanceof Error ? error : new Error(text));
}

function sanitizeTaskHistoryItem(task) {
  if (!task) return null;
  return {
    id: task.id,
    order: task.order,
    status: task.status,
    error: task.error || "",
    errorDetail: task.errorDetail || "",
    runtimeStage: task.runtimeStage || "",
    runtimeDetail: task.runtimeDetail || "",
    runtimeUpdatedAt: task.runtimeUpdatedAt ?? null,
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
    randomBackgroundFocus: task.workflowMode === "random-background" ? normalizeRandomBackgroundFocus(task.randomBackgroundFocus) : "",
    modelImageId: task.modelItem?.id || task.modelImageId || "",
    clothingImageId: task.clothingItem?.id || task.clothingImageId || "",
    extraModelImageIds: Array.isArray(task.extraModelItems)
      ? task.extraModelItems.map((item) => item?.id).filter(Boolean)
      : Array.isArray(task.extraModelImageIds) ? task.extraModelImageIds : [],
    extraClothingImageIds: Array.isArray(task.extraClothingItems)
      ? task.extraClothingItems.map((item) => item?.id).filter(Boolean)
      : Array.isArray(task.extraClothingImageIds) ? task.extraClothingImageIds : [],
    outpaintReferenceImageIds: Array.isArray(task.outpaintReferenceItems)
      ? task.outpaintReferenceItems.map((item) => item?.id).filter(Boolean)
      : Array.isArray(task.outpaintReferenceImageIds) ? task.outpaintReferenceImageIds : [],
    referenceImageIds: Array.isArray(task.referenceItems)
      ? task.referenceItems.map((item) => item?.id).filter(Boolean)
      : Array.isArray(task.referenceImageIds) ? task.referenceImageIds : [],
    modelName: task.modelItem?.name || task.modelName || "",
    clothingName: task.clothingItem?.name || task.clothingName || "",
    referenceNames: Array.isArray(task.referenceItems)
      ? task.referenceItems.map((item) => item?.name).filter(Boolean)
      : Array.isArray(task.referenceNames) ? task.referenceNames : [],
    referenceThumbs: sanitizeTaskReferenceThumbs(task.referenceThumbs),
    referenceCount: Number(task.referenceCount || task.referenceThumbs?.length || 0),
    qualityCheckEnabled: Boolean(task.qualityCheckEnabled),
    qualityCheck: normalizeQualityCheckResult(task.qualityCheck),
    cropReturn: normalizeCropReturnMeta(task.cropReturn || task.result?.cropReturn),
    rerunOf: task.rerunOf || "",
    rerunCandidate: Boolean(task.rerunCandidate),
    result: stripRuntimeResultImageCache(task.result) || null,
    // P1 缺图自愈：把"结果图已失效"持久化下来，下次打开就不再重复请求那个坏地址。
    // 只记地址指纹 + 原因，不删任何东西；结果图恢复后地址变了会自动失效。
    resultMissing: task.resultMissing && typeof task.resultMissing === "object"
      ? { src: String(task.resultMissing.src || ""), reason: String(task.resultMissing.reason || "") }
      : null,
    savedFilename: task.savedFilename || "",
    savedPath: task.savedPath || "",
    autoSaveFailed: Boolean(task.autoSaveFailed),
    source: task.source || "outfit"
  };
}

function recoverPersistedTask(task) {
  const item = sanitizeTaskHistoryItem(task);
  if (!item) return null;
  if (isRefreshInterruptedTask(item)) return detachPersistedTask(item);
  if (!hasGenerationPendingStatus(item)) return item;
  return detachPersistedTask(item);
}

function recoverPersistedTasks(tasks = []) {
  return (Array.isArray(tasks) ? tasks : []).map(recoverPersistedTask).filter(Boolean);
}

function readTaskHistory() {
  return recoverPersistedTasks(readJsonStorage(TASK_HISTORY_KEY, []));
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
  removeStorageItem(TASK_HISTORY_KEY);
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

function delay(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function createAsyncLimiter(limit) {
  const max = Math.max(1, Number(limit) || 1);
  let active = 0;
  const queue = [];
  const release = () => {
    active = Math.max(0, active - 1);
    const next = queue.shift();
    if (next) next();
  };
  return async function runLimited(task) {
    if (active >= max) {
      await new Promise((resolve) => queue.push(resolve));
    }
    active += 1;
    try {
      return await task();
    } finally {
      release();
    }
  };
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

async function canvasToLosslessPngBlob(canvas) {
  const blob = await canvasToBlob(canvas, "image/png");
  return { blob, quality: 1 };
}

async function canvasToCropReturnBlob(canvas, options = {}) {
  return canvasToHighQualityJpegBlob(canvas, {
    targetBytes: Number(options.targetBytes || CROP_RETURN_OUTPUT_TARGET_BYTES),
    qualities: CROP_RETURN_OUTPUT_JPEG_QUALITIES
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

function resizeMimeForFormat(format) {
  if (format === "png") return "image/png";
  if (format === "webp") return "image/webp";
  return "image/jpeg";
}

function fileNameWithImageExtension(name, mimeType) {
  return `${fileBaseName(name || "image")}.${imageExtensionFromMime(mimeType)}`;
}

async function canvasToFile(canvas, name, type = "image/jpeg", quality = 0.92, dpi = 72) {
  const blob = await canvasToBlob(canvas, type, quality);
  const outputBlob = type === "image/jpeg" ? await patchJpegDensity(blob, dpi) : blob;
  return new File([outputBlob], fileNameWithImageExtension(name, type), { type, lastModified: Date.now() });
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

// 选框几何统一走 src/shared/local-edit-geometry.js（快捷生成 src/main.jsx 用同一份），
// 这里保留同名局部引用，调用点不用改。
const constrainLocalEditRect = sharedConstrainCropRect;

function localEditRectSnapshot(rect) {
  if (!rect) return null;
  return {
    x: Math.round(Number(rect.x || 0)),
    y: Math.round(Number(rect.y || 0)),
    width: Math.round(Number(rect.width || 0)),
    height: Math.round(Number(rect.height || 0))
  };
}

function cropReturnRectSnapshot(rect) {
  return localEditRectSnapshot(rect);
}

function normalizeCropReturnMeta(meta) {
  if (!meta?.cropRect) return null;
  const sourceWidth = Number(meta.sourceWidth || 0);
  const sourceHeight = Number(meta.sourceHeight || 0);
  const cropRect = cropReturnRectSnapshot(meta.cropRect);
  if (!sourceWidth || !sourceHeight || !cropRect?.width || !cropRect?.height) return null;
  return {
    enabled: true,
    mode: meta.mode || "crop-return",
    cropRect,
    sourceWidth,
    sourceHeight,
    aspectRatio: meta.aspectRatio || "",
    cropWidth: Number(meta.cropWidth || cropRect.width),
    cropHeight: Number(meta.cropHeight || cropRect.height),
    outputWidth: Number(meta.outputWidth || sourceWidth),
    outputHeight: Number(meta.outputHeight || sourceHeight),
    createdAt: Number(meta.createdAt || Date.now())
  };
}

function localEditFileSnapshot(file) {
  if (typeof File === "undefined" || !(file instanceof File)) return null;
  return {
    name: file.name || "",
    size: Number(file.size || 0),
    type: file.type || ""
  };
}

function roundLocalEditMetric(value, digits = 3) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function localEditTaskBindingSnapshot(task, localEdit, taskAspectRatio, uploadFile) {
  return {
    taskId: task?.id || "",
    order: Number(task?.order || 0),
    batchMode: localEdit?.batchMode || task?.localEditBatchMode || "",
    modelImageId: task?.modelItem?.id || "",
    modelName: task?.modelItem?.name || task?.modelName || "",
    sourceImageId: localEdit?.sourceImageId || task?.modelItem?.id || "",
    sourceName: localEdit?.sourceName || task?.modelItem?.name || "",
    aspectRatio: taskAspectRatio || localEdit?.aspectRatio || task?.aspectRatio || "",
    recroppedAt: Number(localEdit?.recroppedAt || 0) || null,
    originalFile: localEditFileSnapshot(resolveLocalEditBaseFile(task?.modelItem)),
    cropFile: localEditFileSnapshot(localEdit?.cropFile),
    uploadFile: localEditFileSnapshot(uploadFile),
    cropRect: localEditRectSnapshot(localEdit?.cropRect),
    contextRect: localEditRectSnapshot(localEdit?.contextRect),
    cropQuality: roundLocalEditMetric(Number(localEdit?.cropQuality || 0)),
    cropBytes: Number(localEdit?.cropBytes || 0) || null
  };
}

/**
 * 裁剪选框区域，产出送模型（或作为普通裁剪结果）的局部图。
 *
 * 2026-09-25 对齐 3.0 新源码：canvas 尺寸严格等于选框尺寸，不补白、不按比例外扩、
 * 不再返回 `contextRect`。见 src/main.jsx 同名函数的说明。
 */
async function cropOutfitLocalEditFile(imageItem, cropRect, suffix = "local_edit", _options = {}) {
  const originalFile = resolveLocalEditBaseFile(imageItem);
  if (!originalFile) throw new Error("缺少原图，无法创建局部回贴区域");
  const image = await imageBitmapFromFile(originalFile);
  try {
    // 实际裁剪在 src/shared/local-edit-geometry.js（与快捷生成侧同一份实现）。
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

async function prepareOutfitTaskLocalEdit(task, localEdit, model, batchMode = "") {
  if (!localEdit?.cropRect || !task?.modelItem) return localEdit || null;
  const editMode = localEdit.editMode || LOCAL_EDIT_RECT_MODE;
  const isMaskEdit = editMode === LOCAL_EDIT_MASK_MODE;
  // 2026-09-25：所有模型都上传精确选框，不再区分"香蕉2 精确 / 其它带上下文"。
  const cropped = await cropOutfitLocalEditFile(
    task.modelItem,
    localEdit.cropRect,
    isMaskEdit ? "mask_edit_run" : "local_edit_run"
  );
  void model;
  return {
    ...localEdit,
    cropFile: cropped.file,
    cropRect: cropped.cropRect,
    contextRect: null,
    sourceWidth: cropped.sourceWidth,
    sourceHeight: cropped.sourceHeight,
    sourceImageId: task.modelItem?.id || localEdit.sourceImageId || "",
    sourceName: task.modelItem?.name || localEdit.sourceName || "",
    sourceOriginalName: task.modelItem?.originalFile?.name || task.modelItem?.file?.name || "",
    batchMode,
    cropQuality: cropped.cropQuality,
    cropBytes: cropped.cropBytes,
    recroppedAt: Date.now()
  };
}

/**
 * 把模型返回的局部结果**按原图坐标**贴回底图（批量侧）。
 *
 * 2026-09-25 对齐 3.0 新源码 `frontend/ecommerce/src/shared/image/localPaste.ts:128-202`：
 *   1. 画布 = 底图完整尺寸，先把底图画满；
 *   2. 唯一一次写入 = `drawImage(generated, rect.x, rect.y, rect.width, rect.height)`
 *      （返回图尺寸不一致时按选框尺寸拉伸，不做 cover 裁切）；
 *   3. 不做羽化 / 自动对齐 / 颜色匹配 / 中性色调匹配 / 锐化 / 护脸护身；
 *   4. 选框外像素保持底图。
 *
 * 因此删除的 V11 专有后处理：alignLocalEditPatchCanvas、colorMatchLocalEditPatchCanvas、
 * neutralToneMatchLocalEditPatchCanvas、sharpenLocalEditPatchCanvas、
 * protectSkinAndFaceFromLocalOutfitPatch、createFeatherMask，以及 `frameFit:"cover"` 裁切。
 *
 * 涂抹蒙版（用户自己画的选区）保留，按硬边裁剪。
 * `diagnostics` 字段保留（调用方读 `taskBinding` 等），只是不再有后处理相关项。
 */
/**
 * 把模型返回的局部结果**按原图坐标**贴回底图（批量侧）。
 *
 * 2026-09-25 对齐 3.0 新源码 `frontend/ecommerce/src/shared/image/localPaste.ts:128-202`：
 *   1. 画布 = 底图完整尺寸，先把底图画满；
 *   2. 唯一一次写入 = `drawImage(generated, rect.x, rect.y, rect.width, rect.height)`
 *      （返回图尺寸不一致时按选框尺寸拉伸，不做 cover 裁切）；
 *   3. 不做羽化 / 自动对齐 / 颜色匹配 / 中性色调匹配 / 锐化 / 护脸护身；
 *   4. 选框外像素保持底图。
 *
 * 实际合成在 src/shared/local-edit-geometry.js（与快捷生成侧同一份实现）。
 * `diagnostics` 字段保留，调用方读 `taskBinding`；后处理相关项恒为 false/0。
 */
async function composeOutfitLocalEditBlob(originalFile, generatedBlob, cropRect, localEdit = null, options = {}) {
  const original = await imageBitmapFromFile(originalFile);
  const generated = await imageBitmapFromBlob(generatedBlob);
  let maskImage = null;
  let blendMask = null;
  try {
    const sourceWidth = original.width || original.naturalWidth;
    const sourceHeight = original.height || original.naturalHeight;
    const pasteRect = constrainLocalEditRect(localEdit?.cropRect || cropRect, sourceWidth, sourceHeight);

    const diagnostics = {
      strategy: String(options.strategy || "local-paste"),
      editMode: localEdit?.editMode || LOCAL_EDIT_RECT_MODE,
      sourceWidth,
      sourceHeight,
      generatedWidth: generated.width || generated.naturalWidth || 0,
      generatedHeight: generated.height || generated.naturalHeight || 0,
      frameFit: "stretch",
      pasteRect: localEditRectSnapshot(pasteRect),
      contextRect: null,
      hasContext: false,
      hasMask: Boolean(localEdit?.editMode === LOCAL_EDIT_MASK_MODE && localEdit?.maskDataUrl),
      autoAlign: false,
      maxShift: 0,
      colorMatch: false,
      neutralToneMatch: false,
      sharpenPatch: false,
      protectSkinAndFace: false,
      feather: 0,
      patchRect: { x: pasteRect.x, y: pasteRect.y, width: pasteRect.width, height: pasteRect.height },
      composedAt: Date.now()
    };

    if (localEdit?.editMode === LOCAL_EDIT_MASK_MODE && localEdit?.maskDataUrl) {
      maskImage = await imageBitmapFromDataUrl(localEdit.maskDataUrl);
      blendMask = createLocalEditAlphaMask(maskImage, pasteRect, 0);
    }

    const useLosslessOutput = options.losslessOutput !== false;
    const composed = await composeLocalPasteBlob(original, generated, pasteRect, {
      maskImage: blendMask,
      mimeType: useLosslessOutput ? "image/png" : "image/jpeg",
      targetBytes: Number(options.outputTargetBytes || LOCAL_EDIT_OUTPUT_TARGET_BYTES),
      qualities: LOCAL_EDIT_OUTPUT_JPEG_QUALITIES
    });
    diagnostics.output = {
      mimeType: composed.blob.type || (useLosslessOutput ? "image/png" : "image/jpeg"),
      quality: composed.quality,
      bytes: composed.blob.size,
      lossless: useLosslessOutput,
      targetBytes: Number(options.outputTargetBytes || LOCAL_EDIT_OUTPUT_TARGET_BYTES)
    };
    return options.returnDiagnostics ? { blob: composed.blob, diagnostics } : composed.blob;
  } finally {
    original.close?.();
    generated.close?.();
    maskImage?.close?.();
  }
}

async function composeCropReturnBlob(originalFile, generatedBlob, cropReturn, options = {}) {
  if (!originalFile) throw new Error("缺少原图，无法回流到大图画布");
  const original = await imageBitmapFromFile(originalFile);
  const generated = await imageBitmapFromBlob(generatedBlob);
  try {
    const rect = normalizeCropReturnMeta(cropReturn);
    if (!rect?.cropRect) throw new Error("缺少裁剪回流尺寸，无法回流到大图画布");
    const sourceWidth = Math.max(1, Math.round(original.width || original.naturalWidth || rect.sourceWidth));
    const sourceHeight = Math.max(1, Math.round(original.height || original.naturalHeight || rect.sourceHeight));
    const pasteRect = constrainLocalEditRect(rect.cropRect, sourceWidth, sourceHeight);
    const canvas = document.createElement("canvas");
    canvas.width = sourceWidth;
    canvas.height = sourceHeight;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("无法创建裁剪回流画布");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, sourceWidth, sourceHeight);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(original, 0, 0, sourceWidth, sourceHeight);
    ctx.drawImage(generated, pasteRect.x, pasteRect.y, pasteRect.width, pasteRect.height);
    const { blob, quality } = await canvasToCropReturnBlob(canvas, options);
    return {
      blob,
      diagnostics: {
        strategy: "crop-return-full-canvas-v1",
        sourceWidth,
        sourceHeight,
        cropRect: cropReturnRectSnapshot(pasteRect),
        outputWidth: sourceWidth,
        outputHeight: sourceHeight,
        generatedWidth: generated.width || generated.naturalWidth || 0,
        generatedHeight: generated.height || generated.naturalHeight || 0,
        output: {
          mimeType: "image/jpeg",
          quality,
          bytes: blob.size,
          targetBytes: Number(options.targetBytes || CROP_RETURN_OUTPUT_TARGET_BYTES)
        },
        composedAt: Date.now()
      }
    };
  } finally {
    original.close?.();
    generated.close?.();
  }
}

async function composeOutpaintOriginalRegionBlob(originalFile, generatedBlob, outpaintMeta, options = {}) {
  if (!originalFile) throw new Error("缺少原图，无法保护扩图原有区域");
  const original = await imageBitmapFromFile(originalFile);
  const generated = await imageBitmapFromBlob(generatedBlob);
  try {
    const outputWidth = Math.max(1, Math.round(generated.width || generated.naturalWidth || outpaintMeta?.outputWidth || 1));
    const outputHeight = Math.max(1, Math.round(generated.height || generated.naturalHeight || outpaintMeta?.outputHeight || 1));
    const sourceWidth = Math.max(1, Math.round(original.width || original.naturalWidth || outpaintMeta?.sourceWidth || 1));
    const sourceHeight = Math.max(1, Math.round(original.height || original.naturalHeight || outpaintMeta?.sourceHeight || 1));
    const preparedWidth = Math.max(1, Number(outpaintMeta?.outputWidth) || outputWidth);
    const preparedHeight = Math.max(1, Number(outpaintMeta?.outputHeight) || outputHeight);
    const sourceRect = outpaintMeta?.originalRect || {
      x: 0,
      y: 0,
      width: preparedWidth,
      height: Math.min(preparedHeight, Math.round(preparedWidth * (sourceHeight / sourceWidth)))
    };
    const protectedRect = constrainLocalEditRect({
      x: Math.round(Number(sourceRect.x || 0) * outputWidth / preparedWidth),
      y: Math.round(Number(sourceRect.y || 0) * outputHeight / preparedHeight),
      width: Math.round(Number(sourceRect.width || preparedWidth) * outputWidth / preparedWidth),
      height: Math.round(Number(sourceRect.height || preparedHeight) * outputHeight / preparedHeight)
    }, outputWidth, outputHeight);
    const canvas = document.createElement("canvas");
    canvas.width = outputWidth;
    canvas.height = outputHeight;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("无法创建扩图原图保护画布");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, outputWidth, outputHeight);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(generated, 0, 0, outputWidth, outputHeight);
    const featherHeight = Math.max(0, Math.min(
      Math.max(24, Math.round(protectedRect.height * 0.08)),
      160,
      Math.max(0, protectedRect.height - 4)
    ));
    const lockedHeight = Math.max(0, protectedRect.height - featherHeight);
    if (lockedHeight > 0) {
      const lockedSourceHeight = Math.max(1, Math.round(sourceHeight * lockedHeight / protectedRect.height));
      ctx.drawImage(
        original,
        0,
        0,
        sourceWidth,
        lockedSourceHeight,
        protectedRect.x,
        protectedRect.y,
        protectedRect.width,
        lockedHeight
      );
    }
    if (featherHeight > 0) {
      const featherCanvas = document.createElement("canvas");
      featherCanvas.width = protectedRect.width;
      featherCanvas.height = featherHeight;
      const featherCtx = featherCanvas.getContext("2d");
      if (featherCtx) {
        const sourceFeatherHeight = Math.max(1, Math.round(sourceHeight * featherHeight / protectedRect.height));
        featherCtx.imageSmoothingEnabled = true;
        featherCtx.imageSmoothingQuality = "high";
        featherCtx.drawImage(
          original,
          0,
          Math.max(0, sourceHeight - sourceFeatherHeight),
          sourceWidth,
          sourceFeatherHeight,
          0,
          0,
          protectedRect.width,
          featherHeight
        );
        featherCtx.globalCompositeOperation = "destination-in";
        const gradient = featherCtx.createLinearGradient(0, 0, 0, featherHeight);
        gradient.addColorStop(0, "rgba(0,0,0,1)");
        gradient.addColorStop(0.58, "rgba(0,0,0,0.78)");
        gradient.addColorStop(1, "rgba(0,0,0,0)");
        featherCtx.fillStyle = gradient;
        featherCtx.fillRect(0, 0, protectedRect.width, featherHeight);
        ctx.drawImage(featherCanvas, protectedRect.x, protectedRect.y + lockedHeight);
      }
    } else {
      ctx.drawImage(original, 0, 0, sourceWidth, sourceHeight, protectedRect.x, protectedRect.y, protectedRect.width, protectedRect.height);
    }
    const { blob, quality } = await canvasToLosslessPngBlob(canvas);
    const diagnostics = {
      strategy: "outpaint-original-region-lock-v2-feather",
      sourceWidth,
      sourceHeight,
      preparedWidth,
      preparedHeight,
      generatedWidth: outputWidth,
      generatedHeight: outputHeight,
      originalRect: cropReturnRectSnapshot(sourceRect),
      protectedRect: cropReturnRectSnapshot(protectedRect),
      featherHeight,
      blankRect: outpaintMeta?.blankRect ? cropReturnRectSnapshot(outpaintMeta.blankRect) : null,
      output: {
        mimeType: blob.type || "image/png",
        quality,
        bytes: blob.size,
        lossless: true
      },
      composedAt: Date.now()
    };
    return options.returnDiagnostics ? { blob, diagnostics } : blob;
  } finally {
    original.close?.();
    generated.close?.();
  }
}

async function blobFromOutfitImage(image) {
  const src = imageSource(image);
  if (!src) throw new Error("图片地址无效");
  return fetchImageBlob(src, "图片下载失败");
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

async function processImageFileWithMeta(file, ratio, mode = "pad", crop = null) {
  const outputFile = await processImageFile(file, ratio, mode, crop);
  if (mode !== "crop" || !crop) return { file: outputFile, cropReturn: null };
  const originalUrl = URL.createObjectURL(file);
  try {
    const image = await loadImageFromUrl(originalUrl);
    const sourceWidth = image.naturalWidth || image.width || 0;
    const sourceHeight = image.naturalHeight || image.height || 0;
    const cropRect = resolveCropSourceRect(image, ratio, crop);
    return {
      file: outputFile,
      cropReturn: {
        enabled: true,
        mode: "crop-return",
        cropRect,
        sourceWidth,
        sourceHeight,
        aspectRatio: ratio,
        cropWidth: cropRect.width,
        cropHeight: cropRect.height,
        outputWidth: sourceWidth,
        outputHeight: sourceHeight,
        createdAt: Date.now()
      }
    };
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

async function ensureOutfitUploadCanvasRatio(file, ratio) {
  if (!(file instanceof File)) return file;
  const targetRatio = ratioParts(ratio).value;
  const originalUrl = URL.createObjectURL(file);
  try {
    const image = await loadImageFromUrl(originalUrl);
    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;
    if (!width || !height) return await compressOriginalImageFile(file);
    const sourceRatio = width / height;
    if (Math.abs(sourceRatio - targetRatio) <= 0.015) {
      return await compressOriginalImageFile(file);
    }
    return await padImageFile(file, image, ratio, false);
  } finally {
    URL.revokeObjectURL(originalUrl);
  }
}

async function prepareOutpaintUploadCanvas(file, ratio) {
  const emptyMeta = async (nextFile = file, sourceWidth = 0, sourceHeight = 0) => ({
    file: nextFile,
    maskFile: null,
    originalRect: null,
    blankRect: null,
    maskRect: null,
    outputWidth: 0,
    outputHeight: 0,
    sourceWidth,
    sourceHeight
  });
  if (!(file instanceof File)) {
    return emptyMeta(file, 0, 0);
  }
  const targetRatio = ratioParts(ratio || "9:16").value;
  const originalUrl = URL.createObjectURL(file);
  try {
    const image = await loadImageFromUrl(originalUrl);
    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;
    if (!width || !height) {
      return emptyMeta(await compressOriginalImageFile(file), 0, 0);
    }

    const ratioHeight = Math.round(width / targetRatio);
    const minExtensionHeight = Math.round(height * 0.42);
    const targetHeight = Math.max(ratioHeight, height + minExtensionHeight);
    const baseScale = Math.min(1, CHANNEL_UPLOAD_MAX_SIDE / Math.max(width, targetHeight));
    const qualities = [0.92, 0.88, 0.84, 0.78, 0.72, 0.66, 0.6, 0.54, 0.48];
    let scaleFactor = 1;
    let lastAttempt = null;

    function renderPair(scaleDown) {
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(width * scaleDown));
      canvas.height = Math.max(1, Math.round(targetHeight * scaleDown));
      const ctx = canvas.getContext("2d", { alpha: false });
      if (!ctx) throw new Error("无法创建扩图上传画布");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      const drawWidth = Math.max(1, Math.round(width * scaleDown));
      const drawHeight = Math.max(1, Math.round(height * scaleDown));
      const drawX = Math.round((canvas.width - drawWidth) / 2);
      ctx.drawImage(image, drawX, 0, drawWidth, drawHeight);

      const blankStartY = drawHeight;
      if (blankStartY < canvas.height) {
        const stripHeight = Math.max(2, Math.round(drawHeight * 0.035));
        const bleedHeight = Math.min(canvas.height - blankStartY, Math.max(8, stripHeight * 5));
        ctx.save();
        ctx.globalAlpha = 0.16;
        ctx.filter = "blur(10px)";
        ctx.drawImage(
          image,
          0,
          Math.max(0, height - Math.round(height * 0.05)),
          width,
          Math.max(1, Math.round(height * 0.05)),
          drawX,
          blankStartY - Math.round(stripHeight / 2),
          drawWidth,
          bleedHeight
        );
        ctx.restore();
      }

      const overlapHeight = Math.max(0, Math.min(
        Math.max(24, Math.round(drawHeight * 0.08)),
        192,
        Math.max(0, drawHeight - 4),
        Math.max(0, canvas.height - 1)
      ));
      const editableStartY = Math.max(0, drawHeight - overlapHeight);
      const maskCanvas = document.createElement("canvas");
      maskCanvas.width = canvas.width;
      maskCanvas.height = canvas.height;
      const maskCtx = maskCanvas.getContext("2d");
      if (!maskCtx) throw new Error("无法创建扩图蒙版");
      maskCtx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
      maskCtx.fillStyle = "rgba(255,255,255,1)";
      maskCtx.fillRect(0, 0, maskCanvas.width, editableStartY);

      return {
        canvas,
        maskCanvas,
        scaleDown,
        drawX,
        drawWidth,
        drawHeight,
        blankStartY,
        overlapHeight,
        editableStartY
      };
    }

    for (let attempt = 0; attempt < 7; attempt += 1) {
      const rendered = renderPair(baseScale * scaleFactor);
      const maskBlob = await canvasToBlob(rendered.maskCanvas, "image/png");
      for (const quality of qualities) {
        const imageBlob = await canvasToBlob(rendered.canvas, "image/jpeg", quality);
        lastAttempt = { rendered, imageBlob, maskBlob, quality };
        if (imageBlob.size <= CHANNEL_UPLOAD_TARGET_BYTES && maskBlob.size <= CHANNEL_UPLOAD_LIMIT_BYTES) {
          return {
            file: fileFromBlob(imageBlob, `${fileBaseName(file.name)}_outpaint_upload`, "image/jpeg"),
            maskFile: fileFromBlob(maskBlob, `${fileBaseName(file.name)}_outpaint_mask`, "image/png"),
            originalRect: {
              x: rendered.drawX,
              y: 0,
              width: rendered.drawWidth,
              height: rendered.drawHeight
            },
            blankRect: {
              x: rendered.drawX,
              y: rendered.drawHeight,
              width: rendered.drawWidth,
              height: Math.max(0, rendered.canvas.height - rendered.drawHeight)
            },
            maskRect: {
              x: 0,
              y: rendered.editableStartY,
              width: rendered.canvas.width,
              height: Math.max(0, rendered.canvas.height - rendered.editableStartY)
            },
            outputWidth: rendered.canvas.width,
            outputHeight: rendered.canvas.height,
            sourceWidth: width,
            sourceHeight: height,
            scale: rendered.scaleDown,
            maskOverlapHeight: rendered.overlapHeight,
            imageQuality: quality,
            createdAt: Date.now()
          };
        }
      }
      scaleFactor *= 0.84;
    }

    if (lastAttempt?.imageBlob?.size <= CHANNEL_UPLOAD_LIMIT_BYTES && lastAttempt?.maskBlob?.size <= CHANNEL_UPLOAD_LIMIT_BYTES) {
      const { rendered, imageBlob, maskBlob, quality } = lastAttempt;
      return {
        file: fileFromBlob(imageBlob, `${fileBaseName(file.name)}_outpaint_upload`, "image/jpeg"),
        maskFile: fileFromBlob(maskBlob, `${fileBaseName(file.name)}_outpaint_mask`, "image/png"),
        originalRect: {
          x: rendered.drawX,
          y: 0,
          width: rendered.drawWidth,
          height: rendered.drawHeight
        },
        blankRect: {
          x: rendered.drawX,
          y: rendered.drawHeight,
          width: rendered.drawWidth,
          height: Math.max(0, rendered.canvas.height - rendered.drawHeight)
        },
        maskRect: {
          x: 0,
          y: rendered.editableStartY,
          width: rendered.canvas.width,
          height: Math.max(0, rendered.canvas.height - rendered.editableStartY)
        },
        outputWidth: rendered.canvas.width,
        outputHeight: rendered.canvas.height,
        sourceWidth: width,
        sourceHeight: height,
        scale: rendered.scaleDown,
        maskOverlapHeight: rendered.overlapHeight,
        imageQuality: quality,
        createdAt: Date.now()
      };
    }

    throw new Error("扩图上传图和蒙版压缩后仍超过 4MB，请换一张更轻的素材再试");
  } finally {
    URL.revokeObjectURL(originalUrl);
  }
}

function resolveCropSourceRect(image, ratio, crop) {
  const naturalWidth = image.naturalWidth || image.width || 1;
  const naturalHeight = image.naturalHeight || image.height || 1;
  const stageWidth = Math.max(1, Number(crop?.stageWidth) || 1);
  const stageHeight = Math.max(1, Number(crop?.stageHeight) || 1);
  const baseScale = Math.min(stageWidth / naturalWidth, stageHeight / naturalHeight);
  const drawScale = baseScale * Math.max(0.05, Number(crop?.scale) || 1);
  const drawWidth = naturalWidth * drawScale;
  const drawHeight = naturalHeight * drawScale;
  const left = stageWidth / 2 - drawWidth / 2 + (Number(crop?.x) || 0);
  const top = stageHeight / 2 - drawHeight / 2 + (Number(crop?.y) || 0);
  const viewLeft = (0 - left) / drawScale;
  const viewTop = (0 - top) / drawScale;
  const viewRight = (stageWidth - left) / drawScale;
  const viewBottom = (stageHeight - top) / drawScale;
  let sourceX = Math.max(0, Math.min(naturalWidth, viewLeft));
  let sourceY = Math.max(0, Math.min(naturalHeight, viewTop));
  let sourceRight = Math.max(0, Math.min(naturalWidth, viewRight));
  let sourceBottom = Math.max(0, Math.min(naturalHeight, viewBottom));

  if (sourceRight - sourceX < 2 || sourceBottom - sourceY < 2) {
    // 2026-09-25：原来这里会按 ratio 重算一个等比源矩形（横图/竖图取中间一块），
    // 属于"因为比例设置自动扩展选区"。现在只把可见范围夹进图片范围，不做比例重算。
    sourceX = Math.max(0, Math.min(naturalWidth - 1, viewLeft));
    sourceY = Math.max(0, Math.min(naturalHeight - 1, viewTop));
    sourceRight = Math.max(sourceX + 1, Math.min(naturalWidth, viewRight));
    sourceBottom = Math.max(sourceY + 1, Math.min(naturalHeight, viewBottom));
  }

  return constrainLocalEditRect({
    x: sourceX,
    y: sourceY,
    width: Math.max(1, sourceRight - sourceX),
    height: Math.max(1, sourceBottom - sourceY)
  }, naturalWidth, naturalHeight);
}

async function cropImageFile(file, image, ratio, crop) {
  const sourceRect = resolveCropSourceRect(image, ratio, crop);
  const sourceWidth = Math.max(1, sourceRect.width);
  const sourceHeight = Math.max(1, sourceRect.height);
  const scaleDown = Math.min(1, CHANNEL_UPLOAD_MAX_SIDE / Math.max(sourceWidth, sourceHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(sourceWidth * scaleDown));
  canvas.height = Math.max(1, Math.round(sourceHeight * scaleDown));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("无法创建裁剪画布");

  ctx.drawImage(
    image,
    sourceRect.x,
    sourceRect.y,
    sourceWidth,
    sourceHeight,
    0,
    0,
    canvas.width,
    canvas.height
  );
  return canvasToChannelFile(canvas, file.name);
}

async function resizeImageFile(file, settings, crop = null) {
  const normalized = normalizeResizeSettings(settings);
  const outputMime = resizeMimeForFormat(normalized.outputFormat);
  const outputQuality = outputMime === "image/png" ? undefined : 0.92;
  const sourceUrl = URL.createObjectURL(file);
  try {
    const image = await loadImageFromUrl(sourceUrl);
    if (normalized.fitMode === "original") {
      const edge = resolveResizeLongEdge(normalized);
      const scale = edge / Math.max(1, image.naturalWidth, image.naturalHeight);
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      const ctx = canvas.getContext("2d", { alpha: outputMime !== "image/jpeg" });
      if (!ctx) throw new Error("无法创建画布");
      if (outputMime === "image/jpeg") {
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      return canvasToFile(canvas, file.name, outputMime, outputQuality, normalized.dpi);
    }

    if (normalized.fitMode === "original-size") {
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const ctx = canvas.getContext("2d", { alpha: outputMime !== "image/jpeg" });
      if (!ctx) throw new Error("无法创建画布");
      if (outputMime === "image/jpeg") {
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
      ctx.drawImage(image, 0, 0, image.naturalWidth, image.naturalHeight);
      return canvasToFile(canvas, file.name, outputMime, outputQuality, normalized.dpi);
    }

    const edge = resolveResizeLongEdge(normalized);
    const { width, height } = outputSizeForRatio(normalized.ratio, edge);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { alpha: outputMime !== "image/jpeg" });
    if (!ctx) throw new Error("无法创建画布");

    if (normalized.fitMode === "crop") {
      ctx.fillStyle = outputMime === "image/jpeg" ? normalized.fillColor : "rgba(0,0,0,0)";
      ctx.fillRect(0, 0, width, height);
      if (!crop) {
        const scale = Math.max(width / image.naturalWidth, height / image.naturalHeight);
        const drawWidth = image.naturalWidth * scale;
        const drawHeight = image.naturalHeight * scale;
        ctx.drawImage(image, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);
        return canvasToFile(canvas, file.name, outputMime, outputQuality, normalized.dpi);
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
      return canvasToFile(canvas, file.name, outputMime, outputQuality, normalized.dpi);
    }

    ctx.fillStyle = normalized.fillColor === "#000000" ? "#000000" : "#ffffff";
    ctx.fillRect(0, 0, width, height);
    const scale = Math.min(width / image.naturalWidth, height / image.naturalHeight);
    const drawWidth = image.naturalWidth * scale;
    const drawHeight = image.naturalHeight * scale;
    ctx.drawImage(image, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);
    return canvasToFile(canvas, file.name, outputMime, outputQuality, normalized.dpi);
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
    cropReturn: null,
    localEdit: null,
    selected: true,
    createdAt: Date.now()
  };
}

function serializeDraftImageItem(item) {
  if (!item?.originalFile && !item?.file) return null;
  const cropReturn = normalizeCropReturnMeta(item.cropReturn);
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
    cropReturn,
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
    cropReturn: normalizeCropReturnMeta(item.cropReturn),
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
  const modelImages = (page?.modelImages || []).map(hydrateDraftImageItem).filter(Boolean);
  const clothingImages = (page?.clothingImages || []).map(hydrateDraftImageItem).filter(Boolean);
  const referenceImages = (page?.referenceImages || []).map(hydrateDraftImageItem).filter(Boolean);
  const tasks = hydrateTasksWithUploadReferences(recoverPersistedTasks(page?.tasks), {
    modelImages,
    clothingImages,
    referenceImages
  });
  return makeOutfitPage(pageName, {
    ...page,
    modelImages,
    clothingImages,
    referenceImages,
    originalLibrary: (page?.originalLibrary || []).map(hydrateOriginalDraftItem).filter(Boolean),
    uploadLabels: normalizeUploadLabels(page?.uploadLabels || {}, pageName),
    tasks
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
  fixedTitle = "设为固定服装",
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
  footerControls = null,
  sideControls = null
}) {
  const inputRef = useRef(null);
  const pointerSortRef = useRef(null);
  const suppressOpenRef = useRef(false);
  const [dragging, setDragging] = useState(false);
  const [draggingImageId, setDraggingImageId] = useState("");
  const [dropTarget, setDropTarget] = useState(null);
  const [replaceTargetId, setReplaceTargetId] = useState("");
  // 缩略图 meta 要显示像素尺寸：直接读已渲染 <img> 的 naturalWidth/Height（零额外解码）。
  const thumbSizeRef = useRef(new Map());
  const [, bumpThumbSizeRevision] = useState(0);
  function rememberThumbSize(itemId, image) {
    const width = image?.naturalWidth || 0;
    const height = image?.naturalHeight || 0;
    if (!itemId || !width || !height) return;
    const previous = thumbSizeRef.current.get(itemId);
    if (previous && previous.width === width && previous.height === height) return;
    thumbSizeRef.current.set(itemId, { width, height });
    bumpThumbSizeRevision((value) => value + 1);
  }
  const columnCount = primary ? 10 : 2;
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

  function openLocalEdit(item) {
    if (suppressOpenRef.current) return;
    onOpenLocalEdit?.(item);
  }

  return (
    <section
      tabIndex={0}
      className={`uploadZone ${compact ? "compact" : ""} ${primary ? "primary" : ""} ${sideControls ? "hasSideControls" : ""} ${dragging ? "dragging" : ""}`}
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
      <div className="uploadZoneBody">
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
                <img src={thumbPreviewUrl} alt="" draggable={false} onLoad={(event) => rememberThumbSize(item.id, event.currentTarget)} />
                <i>{index + 1}</i>
                <em>{item.mode === "crop" ? "裁" : item.mode === "soft" ? "柔" : item.mode === "original" ? "原" : "白"}</em>
                {items.length > 1 && <span className="dragHandle" title="拖拽调整顺序"><Move size={13} /></span>}
              </button>
              <div className="thumbMeta">
                <strong title={item.name}>{item.name}</strong>
                <span>
                  {item.mode === "crop" ? "手动裁剪" : item.mode === "soft" ? "柔和补边" : item.mode === "original" ? "原图" : "白底补边"} · {fileSize(item.file.size)}
                  {item.localEdit?.cropRect
                    ? ` · 局部 ${formatPixelSize(item.localEdit.cropRect.width, item.localEdit.cropRect.height)} · 底图 ${formatPixelSize(item.localEdit.sourceWidth, item.localEdit.sourceHeight)}`
                    : thumbSizeRef.current.get(item.id)
                      ? ` · 上传 ${formatPixelSize(thumbSizeRef.current.get(item.id).width, thumbSizeRef.current.get(item.id).height)}`
                      : ""}
                </span>
              </div>
              <div className="thumbActions">
                <button type="button" onClick={() => onToggle(item.id)} title="参与本次批量">
                  {item.selected ? <Check size={14} /> : <X size={14} />}
                </button>
                {onSetFixed && (
                  <button type="button" onClick={() => onSetFixed(item.id)} title={fixedTitle}>
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
        {sideControls && <div className="uploadZoneSideControls">{sideControls}</div>}
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

function CropModal({
  item,
  ratio,
  onRatioChange = null,
  ratioOptions = null,
  ratioLabel = "输出比例",
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
  const [imageSize, setImageSize] = useState({ width: 0, height: 0 });
  const [localRatio, setLocalRatio] = useState(ratio);
  const [working, setWorking] = useState(false);

  const ratioChoices = Array.isArray(ratioOptions)
    ? ratioOptions.filter((itemRatio) => typeof itemRatio === "string" && itemRatio.trim())
    : [];
  const activeRatio = ratioChoices.includes(localRatio) ? localRatio : ratio;
  const ratioValue = ratioParts(activeRatio).value;

  function minCropScale() {
    const frame = stageRef.current?.getBoundingClientRect();
    if (!frame?.width || !frame?.height || !imageSize.width || !imageSize.height) return 1;
    const containScale = Math.min(frame.width / imageSize.width, frame.height / imageSize.height);
    const coverScale = Math.max(frame.width / imageSize.width, frame.height / imageSize.height);
    return Math.max(1, coverScale / containScale);
  }

  function clampCropTransform(next) {
    const frame = stageRef.current?.getBoundingClientRect();
    if (mode !== "crop" || !frame?.width || !frame?.height || !imageSize.width || !imageSize.height) return next;
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

  function resetCropTransform() {
    if (mode !== "crop") return;
    setTransform({ x: 0, y: 0, scale: minCropScale() });
  }

  useEffect(() => {
    if (mode !== "crop") return undefined;
    const frame = window.requestAnimationFrame(resetCropTransform);
    return () => window.cancelAnimationFrame(frame);
  }, [imageSize.height, imageSize.width, item?.id, mode, activeRatio]);

  useEffect(() => {
    setLocalRatio(ratio);
  }, [item?.id, ratio]);

  function changeLocalRatio(nextRatio) {
    if (!ratioChoices.includes(nextRatio)) return;
    setLocalRatio(nextRatio);
    onRatioChange?.(nextRatio);
  }

  function onPointerDown(event) {
    if (mode !== "crop") return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { x: event.clientX, y: event.clientY, start: transform };
  }

  function onPointerMove(event) {
    if (!dragRef.current || mode !== "crop") return;
    const deltaX = event.clientX - dragRef.current.x;
    const deltaY = event.clientY - dragRef.current.y;
    setTransform(clampCropTransform({
      ...dragRef.current.start,
      x: dragRef.current.start.x + deltaX,
      y: dragRef.current.start.y + deltaY
    }));
  }

  function onWheel(event) {
    if (mode !== "crop") return;
    event.preventDefault();
    setTransform((current) => clampCropTransform({
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
      const processed = await processor(item.originalFile, activeRatio, mode, crop);
      const nextFile = processed?.file instanceof File ? processed.file : processed;
      const nextUrl = URL.createObjectURL(nextFile);
      onApply({
        ...item,
        file: nextFile,
        previewUrl: nextUrl,
        mode,
        cropReturn: normalizeCropReturnMeta(processed?.cropReturn)
      });
    } finally {
      setWorking(false);
    }
  }

  return (
    <Modal layerClassName="modalLayer" panelClassName="cropModal" onClose={onClose}>
      <ModalHeader
        title={title}
        subtitle={subtitle || `${item.name} · 输出 ${activeRatio}`}
        onClose={onClose}
      />
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
        {ratioChoices.length > 0 && (
          <div className="cropRatioPresetGroup" role="group" aria-label={ratioLabel}>
            {ratioChoices.map((itemRatio) => (
              <button
                className={activeRatio === itemRatio ? "active" : ""}
                key={itemRatio}
                type="button"
                onClick={() => changeLocalRatio(itemRatio)}
              >
                {itemRatio}
              </button>
            ))}
          </div>
        )}
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
              onLoad={(event) => {
                setImageSize({
                  width: event.currentTarget.naturalWidth || 0,
                  height: event.currentTarget.naturalHeight || 0
                });
              }}
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
    </Modal>
  );
}

function defaultLocalEditCrop(width, height, ratio) {
  // 2026-09-25：默认选框就是上次/当前选定的比例（居中、约占 62%），
  // 因为局部回贴选框必须"始终"等于所选比例。
  return fitRectToRatioLocked(null, ratio, width, height);
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
  const originalFile = resolveLocalEditBaseFile(item);
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
      // 旧会话存下来的选框也按当前比例重新整形（中心不动）。
      ? fitRectToRatioLocked(savedEdit.cropRect, activeRatio, width, height)
      : defaultLocalEditCrop(width, height, activeRatio);
    setCropRect(initial);
    window.requestAnimationFrame(measureImage);
  }

  function fitRectToRatio(rect, nextRatio) {
    if (!imageSize.width || !imageSize.height) return rect;
    // 局部回贴：锁定比例，围绕原选框中心整形，且留在原图范围内。
    return fitRectToRatioLocked(rect, nextRatio, imageSize.width, imageSize.height);
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
      // 局部回贴：任何写入路径都再吸附一次比例，保证选框"始终"等于所选比例；
      // 涂抹蒙版模式的上下文框由涂抹轨迹决定，不锁比例。
      if (!isMaskMode) {
        const size = snapSizeToRatio(source.width, source.height, activeRatio, imageSize.width, imageSize.height);
        return constrainLocalEditRect({ ...source, ...size }, imageSize.width, imageSize.height);
      }
      return constrainLocalEditRect(source, imageSize.width, imageSize.height);
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

  // 2026-09-25 对齐要求（本轮）：局部回贴选框锁定所选比例。
  //   - 角柄缩放 / Alt 中心缩放 / 区域大小滑杆都锁定 activeRatio，宽高始终精确满足比例；
  //   - 涂抹蒙版模式的上下文框不锁比例（由涂抹轨迹决定）。
  const CROP_MIN_PIXEL_SIZE = 1;

  function resizeCropRectFromCorner(sourceRect, handle, deltaX, deltaY) {
    if (!isMaskMode) {
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
    if (!isMaskMode) {
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
    // 局部回贴：按目标宽度等比缩放，宽高比例不变。
    if (!isMaskMode) {
      updateCropRect(scaleRectLocked(cropRect, imageSize.width * percent, activeRatio, imageSize.width, imageSize.height));
      return;
    }
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
        const cropped = await cropOutfitLocalEditFile(item, cropRect, "local_edit");
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

  // 尺寸口径：底图 = 用户放进图1的那张文件（= 贴回底图），输出与它同尺寸。
  // 图片还没 onLoad 时先用上次选框记录的 sourceWidth/Height，避免标题一闪是空的。
  const baseSizeText = formatPixelSize(imageSize.width, imageSize.height)
    || formatPixelSize(savedEdit?.sourceWidth, savedEdit?.sourceHeight);
  // 选框是在另一张不同尺寸的图上框的 → 坐标会错位，必须提醒重新框选（"不能出现偏移"）。
  const staleRect = Boolean(
    savedEdit?.sourceWidth
    && imageSize.width
    && (Math.round(savedEdit.sourceWidth) !== Math.round(imageSize.width)
      || Math.round(savedEdit.sourceHeight || 0) !== Math.round(imageSize.height))
  );

  return (
    <Modal
      layerClassName="modalLayer previewLayer"
      panelClassName="quickLocalEditModal"
      onClose={onClose}
    >
      <ModalHeader
        title="局部回贴"
        subtitle={<>{originalFile?.name || "上传图片"} · 底图 {baseSizeText || "读取中…"} · 生成后贴回同一坐标，输出同尺寸 · {activeRatio}</>}
        onClose={onClose}
        closeLabel="关闭"
      />
      {staleRect && (
        <p className="quickLocalEditWarning" role="alert">
          已保存的选框是在 {formatPixelSize(savedEdit?.sourceWidth, savedEdit?.sourceHeight)} 的图上框的，
          当前底图是 {baseSizeText}：坐标对不上，请重新框选后再应用（否则会贴偏移）。
        </p>
      )}
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
    </Modal>
  );
}

function resizeSettingsFingerprint(settings, cropSignature = "") {
  const normalized = normalizeResizeSettings(settings);
  return [
    normalized.ratio,
    resolveResizeLongEdge(normalized),
    normalized.fitMode,
    normalized.outputFormat,
    normalized.dpi,
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
  const isOriginalRatioMode = settings.fitMode === "original";
  const fixedOutputRatioMode = settings.fitMode === "pad" || settings.fitMode === "crop";
  const targetSize = isOriginalSizeMode || isOriginalRatioMode ? null : outputSizeForRatio(settings.ratio, resolveResizeLongEdge(settings));
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
      removeStorageItem(RESIZE_BATCH_CROP_KEY);
    }
  }, [batchCropTemplate]);

  useEffect(() => {
    const input = folderInputRef.current;
    if (!input) return;
    input.setAttribute("webkitdirectory", "");
    input.setAttribute("directory", "");
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
    onAddEvent?.("批量尺寸导出", `已导入 ${nextItems.length} 张图片`);
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
    onAddEvent?.("批量尺寸导出", "已设置统一裁剪区域");
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
        const useCustom = !["original-size", "original"].includes(settings.fitMode) && item.customized && item.settingsKey === currentSettingsKey;
        const sharedCrop = settings.fitMode === "crop" && settings.cropMode === "batch" ? batchCropTemplate : null;
        const file = useCustom
          ? item.file
          : await resizeImageFile(item.originalFile, settings, sharedCrop);
        await onSaveImage(file, RESIZE_OUTPUT_FOLDER);
        finished += 1;
      }
      setStatus(`已导出 ${finished} 张到「${RESIZE_OUTPUT_FOLDER}」`);
      onAddEvent?.("批量尺寸导出", `已导出 ${finished} 张`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(`导出失败：${message}`);
      onAddEvent?.("批量尺寸导出失败", message);
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
          <h3>批量尺寸导出</h3>
          <span>本地批量改尺寸和转格式，不消费 API；默认 JPG、最长边 3500、72DPI，导出到「{RESIZE_OUTPUT_FOLDER}」。</span>
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
              <span>尺寸档</span>
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
              <span>导出格式</span>
              <select value={settings.outputFormat} onChange={(event) => updateResizeSetting("outputFormat", event.target.value)}>
                {RESIZE_FORMAT_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>DPI</span>
              <input
                type="number"
                min="1"
                max="1200"
                step="1"
                value={settings.dpi}
                onChange={(event) => updateResizeSetting("dpi", event.target.value)}
              />
            </label>
            <label className={`field ${fixedOutputRatioMode ? "" : "muted"}`}>
              <span>输出比例</span>
              <select
                value={settings.ratio}
                onChange={(event) => updateResizeSetting("ratio", event.target.value)}
                disabled={!fixedOutputRatioMode}
                title={fixedOutputRatioMode ? "固定画幅输出比例" : "原图等比缩放时不使用输出比例"}
              >
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
            <button className={settings.fitMode === "original" ? "active" : ""} type="button" onClick={() => updateResizeSetting("fitMode", "original")}>原图</button>
            <button className={settings.fitMode === "pad" ? "active" : ""} type="button" onClick={() => updateResizeSetting("fitMode", "pad")}>补边</button>
            <button className={settings.fitMode === "crop" ? "active" : ""} type="button" onClick={() => updateResizeSetting("fitMode", "crop")}>裁剪</button>
          </div>
        </div>
        {!isOriginalSizeMode && !isOriginalRatioMode && (
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
          <strong>{isOriginalSizeMode ? `原像素 ${settings.dpi}DPI` : isOriginalRatioMode ? `原图比例 · 最长边 ${resolveResizeLongEdge(settings)}` : `${targetSize.width} × ${targetSize.height}`}</strong>
          <span>{isOriginalSizeMode ? "像素不改，只重写 DPI" : isOriginalRatioMode ? `${settings.outputFormat.toUpperCase()} · ${settings.dpi}DPI · 等比缩放` : `${settings.outputFormat.toUpperCase()} · 当前导出尺寸`}</span>
        </div>
      </div>

      <div className="resizeDropHint">
        <Images size={24} />
        <span>拖入批量图片，或使用上方“选择文件夹”读取整文件夹图片。</span>
        <em>{saveDirectory ? `指定文件夹：${saveDirectory}` : "尚未指定保存文件夹"} · {RESIZE_OUTPUT_FOLDER}</em>
      </div>

      <div className="resizeImageGrid">
        {items.map((item, index) => {
          const freshCustom = item.customized && item.settingsKey === currentSettingsKey;
          const canEditIndividually = settings.fitMode === "crop" && settings.cropMode === "individual";
          return (
            <article className={`resizeImageCard ${freshCustom ? "customized" : ""}`} key={item.id}>
              <div
                className="resizeThumb"
                role={canEditIndividually ? "button" : undefined}
                tabIndex={canEditIndividually ? 0 : undefined}
                onClick={() => canEditIndividually && openCropEditor(item)}
                onKeyDown={(event) => {
                  if (canEditIndividually && (event.key === "Enter" || event.key === " ")) {
                    event.preventDefault();
                    openCropEditor(item);
                  }
                }}
              >
                <img src={item.previewUrl} alt="" draggable={false} />
                <i>{index + 1}</i>
              </div>
              <div className="resizeMeta">
                <strong title={item.name}>{item.name}</strong>
                <span>{fileSize(item.originalFile.size)} · {freshCustom ? "已单张调整" : settings.fitMode === "original-size" ? `原像素 ${settings.dpi}DPI` : settings.fitMode === "original" ? "原图等比缩放" : settings.fitMode === "crop" ? "中心裁剪" : "补边缩放"}</span>
              </div>
              <div className="resizeCardActions">
                <button
                  type="button"
                  onClick={() => openCropEditor(item)}
                  disabled={!canEditIndividually}
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
          title="单张裁剪 / 尺寸导出"
          subtitle={`${cropTarget.name} · ${targetSize?.width || resolveResizeLongEdge(settings)} × ${targetSize?.height || "原图比例"}`}
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

function buildLocalDetailPrompt(userPrompt, referenceCount = 0, model = "") {
  const request = String(userPrompt || "").trim() || "在图1选区内按文字或图2结构参考修改局部服装细节。";
  const isBanana2 = isBanana2Model(model);
  return [
    "【局部服装细节 Skill】",
    "任务：只修改图1局部选区内用户点名的服装面料或服装细节，例如衣领、袖口、荷包、口袋、扣子、拉链、拼接线、局部纹理、局部瑕疵。",
    "图1局部来自原图固定坐标；主体位置、人物姿态、脸、头颈、身体比例、手脚、背景、光影和选区外内容不改变。",
    "只处理用户点名目标；未点名的衣身、裤子、裙子、皮肤、背景和其它服装区域保持图1原图观感。",
    "图1是颜色、基础材质、明暗、纹理方向、清晰度和光影关系的唯一事实来源；新细节必须像原本就长在图1这件衣服上。",
    referenceCount > 0
      ? `本次有 ${referenceCount} 张图2参考图：只参考被点名局部细节的形状、结构、位置关系、五金样式、缝线方式或纹理走势；不要参考图2的颜色、色温、曝光、整体材质颜色或背景，不要把图2扩展成整件换装。`
      : "没有图2参考时，不要凭空大改版型或新增复杂装饰，只按文字做保守局部调整。",
    "选区边缘必须延续图1原图颜色、材质、明暗、纹理方向和清晰度，避免突兀色块、断层、错位或新增花纹。",
    isBanana2
      ? "Nano Banana 2：短句硬锁，局部结果必须保持原坐标关系，不要重新摆拍、移动头颈、改变肩线或重排身体。"
      : "输出画布比例和局部选区一致，保持原构图、原角度和原光影。",
    "【用户局部需求】",
    request
  ].join("\n");
}

function LocalDetailPanel({
  saveDirectory,
  onChooseDirectory,
  onOpenSaveDirectory,
  onSaveImage,
  onAddEvent,
  onPreview,
  apiKey = "",
  defaultModel = "tt-image-2",
  defaultImageSize = "2K",
  defaultRatio = "3:4"
}) {
  const [baseImages, setBaseImages] = useState([]);
  const [referenceImages, setReferenceImages] = useState([]);
  const [ratio, setRatio] = useState(BATCH_RATIO_OPTIONS.includes(defaultRatio) ? defaultRatio : "3:4");
  const [model, setModel] = useState(canonicalModel(defaultModel || "tt-image-2"));
  const [imageSize, setImageSize] = useState(defaultImageSize || "2K");
  const [prompt, setPrompt] = useState("在图1选区内修改点名的服装细节，颜色和整体材质以图1原产品为主。");
  const [generatedResult, setGeneratedResult] = useState(null);
  const [cropTarget, setCropTarget] = useState(null);
  const [cropTemplate, setCropTemplate] = useState(null);
  const [working, setWorking] = useState(false);
  const [status, setStatus] = useState("上传图1原图并框选需要修改的服装区域，生成后会自动贴回原图同一坐标。");
  const baseImagesRef = useRef([]);
  const referenceImagesRef = useRef([]);
  const generatedResultRef = useRef(null);

  const selectedBase = baseImages.find((item) => item.selected) || baseImages[0] || null;
  const selectedReferences = referenceImages.filter((item) => item.selected);
  const targetSize = outputSizeForRatio(ratio, 2048);

  useEffect(() => {
    baseImagesRef.current = baseImages;
  }, [baseImages]);

  useEffect(() => {
    referenceImagesRef.current = referenceImages;
  }, [referenceImages]);

  useEffect(() => {
    generatedResultRef.current = generatedResult;
  }, [generatedResult]);

  useEffect(() => () => {
    baseImagesRef.current.forEach(revokeImageUrls);
    referenceImagesRef.current.forEach(revokeImageUrls);
    if (generatedResultRef.current?.url) URL.revokeObjectURL(generatedResultRef.current.url);
  }, []);

  useEffect(() => {
    if (defaultModel) setModel(defaultModel);
  }, [defaultModel]);

  useEffect(() => {
    if (defaultImageSize) setImageSize(defaultImageSize);
  }, [defaultImageSize]);

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
    onAddEvent?.("局部回贴", `已加入 ${items.length} 张${label}`);
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

  async function saveGeneratedResult() {
    if (!generatedResult?.file) return;
    if (!saveDirectory) {
      setStatus("请先指定保存文件夹，再保存贴回结果");
      onChooseDirectory?.();
      return;
    }
    try {
      const payload = await onSaveImage(generatedResult.file, LOCAL_DETAIL_OUTPUT_FOLDER);
      setStatus(`已保存贴回图：${payload?.filename || generatedResult.file.name}`);
      onAddEvent?.("局部回贴", `已保存到 ${LOCAL_DETAIL_OUTPUT_FOLDER}`);
    } catch (error) {
      setStatus(`保存失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function generateLocalDetail() {
    if (working) return;
    if (!apiKey) {
      setStatus("请先在设置里填写 API Key");
      return;
    }
    if (!selectedBase) {
      setStatus("请先上传并选中一张主图");
      return;
    }
    if (!cropTemplate) {
      setStatus("请先选择要局部修改的区域");
      return;
    }
    setWorking(true);
    setStatus("正在生成局部补丁并贴回原图...");
    try {
      const localEdit = await cropOutfitLocalEditFile(selectedBase, cropTemplate, "local_detail");
      const form = new FormData();
      form.set("apiKey", apiKey);
      // 局部回贴也走 /api/images，同样必须带 canonical 路由字段。
      const localRoute = routingFields(model, "", null);
      form.set("model", localRoute.model);
      form.set("channelId", localRoute.channelId);
      form.set("dispatchMode", localRoute.dispatchMode);
      form.set("imageSize", imageSize);
      form.set("aspectRatio", localEdit.aspectRatio || ratio);
      form.set("n", "1");
      form.set("source", "local-detail");
      form.set("deferAutoSave", "1");
      form.set("prompt", buildLocalDetailPrompt(prompt, selectedReferences.length, model));
      form.append("image", localEdit.cropFile, `local_${selectedBase.name}`);
      selectedReferences.forEach((item, index) => {
        const file = item.file || item.originalFile;
        if (file instanceof File) form.append("image", file, `ref_${index + 1}_${item.name}`);
      });

      const payload = await generateImages(form);
      if (!payload.images?.[0]) throw new Error("接口返回成功，但没有解析到图片");

      const generatedBlob = await blobFromOutfitImage(payload.images[0]);
      // 2026-09-25 对齐 3.0：局部回贴不做自动对齐 / 颜色匹配 / 中性色调匹配 / 羽化。
      const composedBlob = await composeOutfitLocalEditBlob(
        resolveLocalEditBaseFile(selectedBase),
        generatedBlob,
        localEdit.cropRect,
        localEdit
      );
      const resultFile = fileFromBlob(composedBlob, `${fileBaseName(selectedBase.name || "local-detail")}_局部贴回`, "image/png");
      const url = URL.createObjectURL(composedBlob);
      await preloadImageUrl(url);
      setGeneratedResult((current) => {
        if (current?.url) URL.revokeObjectURL(current.url);
        return { file: resultFile, url, timingMs: payload.timing?.totalMs || 0 };
      });
      onAddEvent?.("局部回贴", "局部补丁已生成并贴回原图");

      if (saveDirectory) {
        const saved = await onSaveImage(resultFile, LOCAL_DETAIL_OUTPUT_FOLDER);
        setStatus(`生成完成并已保存：${saved?.filename || resultFile.name}`);
      } else {
        setStatus("生成完成；未指定保存文件夹，点击保存贴回图可保存。");
      }
    } catch (error) {
      setStatus(`生成失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setWorking(false);
    }
  }

  return (
    <section className="localDetailPanel">
      <header className="moduleHeader">
        <div>
          <h2>局部回贴</h2>
          <span>在图1大图里框选服装局部，按需求生成补丁后自动贴回原图同一坐标。</span>
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
          title="图1：原图 / 待回贴区域"
          hint="上传需要局部修改的大图；先框选服装区域，生成结果会贴回这张原图。"
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
            title="图2：细节结构参考"
            hint="可选；只参考细节形状、结构、五金样式或纹理走势，不参考颜色。"
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
                <h3>回贴生成</h3>
                <span>修改衣领、袖口、荷包、面料纹理等细节，颜色和光影跟图1一致。</span>
              </div>
            </header>
            <label className="field localPromptField">
              <span>局部回贴提示词</span>
              <textarea
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                placeholder="例如：把袖口改成图2这种收口结构，颜色和材质跟图1衣服保持一致。"
              />
            </label>
            <div className="localOptionGrid">
              <label className="field">
                <span>模型</span>
                <select value={model} onChange={(event) => setModel(event.target.value)}>
                  {DEFAULT_MODELS.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>清晰度</span>
                <select value={imageSize} onChange={(event) => setImageSize(event.target.value)}>
                  {modelCapabilities(model).sizes.map((option) => (
                    <option key={option} value={option}>{option}</option>
                  ))}
                </select>
              </label>
            </div>
            <label className="field">
              <span>局部输出比例</span>
              <select value={ratio} onChange={(event) => setRatio(event.target.value)}>
                {BATCH_LOCAL_EDIT_RATIOS.map((option) => (
                  <option key={option} value={option}>{option}</option>
                ))}
              </select>
            </label>
            <div className="localMetric">
              <strong>{targetSize.width} × {targetSize.height}</strong>
              <span>{cropTemplate ? "已选择局部回贴区域" : "请先选择局部回贴区域"}</span>
            </div>
            <div className="localActionButtons">
              <button className="smallButton" type="button" onClick={() => selectedBase && setCropTarget({ ...selectedBase, mode: "crop" })} disabled={!selectedBase}>
                <Scissors size={15} />
                <span>选择回贴区域</span>
              </button>
              <button className="generateButton" type="button" onClick={generateLocalDetail} disabled={working || !selectedBase || !cropTemplate}>
                {working ? <Loader2 className="spin" size={16} /> : <Play size={16} />}
                <span>{working ? "生成中" : "生成贴回"}</span>
              </button>
              <button className="secondaryButton" type="button" onClick={saveGeneratedResult} disabled={!generatedResult?.file}>
                <Save size={15} />
                <span>保存贴回图</span>
              </button>
            </div>
            {generatedResult?.url && (
              <button
                className="localResultPreview"
                type="button"
                onClick={() => onPreview?.({ title: "局部回贴结果", src: generatedResult.url })}
              >
                <img src={generatedResult.url} alt="" />
                <span>点击预览贴回结果</span>
              </button>
            )}
            <p>{status}</p>
          </section>
        </section>
      </div>

      {cropTarget && (
        <CropModal
          item={cropTarget}
          ratio={ratio}
          initialMode="crop"
          title="局部回贴区域"
          subtitle={`${cropTarget.name} · ${targetSize.width} × ${targetSize.height}`}
          footerText="拖动画面选择要重绘并回贴的服装区域，滚轮缩放；确认后生成结果会贴回原图同一坐标。"
          modeOptions={[["crop", "回贴区域"]]}
          collectOnly
          onCollectCrop={applyLocalCropTemplate}
          onClose={() => setCropTarget(null)}
          onApply={() => {}}
        />
      )}
    </section>
  );
}

const QUICK_VIDEO_DEFAULTS = {
  model: "seedance-2.0",
  prompt: "",
  duration: 5,
  resolution: "720p",
  aspectRatio: "9:16",
  outputAudio: false,
  imageUrl: ""
};

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

function videoDurationOptions(model = {}) {
  if (Array.isArray(model.durations) && model.durations.length > 0) return model.durations;
  const min = Math.max(1, Number(model.minDuration || QUICK_VIDEO_DEFAULTS.duration));
  const max = Math.max(min, Number(model.maxDuration || min));
  const options = [];
  for (let value = min; value <= max; value += 5) options.push(value);
  if (!options.includes(max)) options.push(max);
  return options;
}

function quickVideoPromptPlaceholder(model = {}) {
  return String(model.promptPlaceholder || "输入视频画面、镜头运动、人物动作、服装展示和氛围要求").trim();
}

function quickVideoPricePerSecond(model = {}, resolution = "") {
  const price = Number(model.customerPricePerSecond?.[resolution]);
  return Number.isFinite(price) ? price : null;
}

function quickVideoPriceLabel(model = {}, resolution = "") {
  const price = quickVideoPricePerSecond(model, resolution);
  return price === null ? "" : `算力 ${price.toFixed(3)}/秒`;
}

function normalizeQuickVideoSettings(current = {}, model = {}) {
  const durations = videoDurationOptions(model);
  const resolutions = Array.isArray(model.resolutions) && model.resolutions.length ? model.resolutions : ["720p"];
  const ratios = Array.isArray(model.aspectRatios) && model.aspectRatios.length ? model.aspectRatios : ["9:16"];
  const defaultDuration = Number(model.defaultDuration || durations[0] || QUICK_VIDEO_DEFAULTS.duration);
  const requestedDuration = Number.parseInt(current.duration ?? defaultDuration, 10);
  return {
    ...current,
    model: model.value || current.model || QUICK_VIDEO_DEFAULTS.model,
    duration: durations.includes(requestedDuration) ? requestedDuration : defaultDuration,
    resolution: resolutions.includes(current.resolution) ? current.resolution : (model.defaultResolution || resolutions[0]),
    aspectRatio: ratios.includes(current.aspectRatio) ? current.aspectRatio : (model.defaultAspectRatio || ratios[0])
  };
}

function WorkflowQuickVideoPanel({
  config,
  apiKey,
  onOpenSettings,
  onAddEvent
}) {
  const videoModels = Array.isArray(config?.videoModels) && config.videoModels.length ? config.videoModels : [];
  const [settings, setSettings] = useState(QUICK_VIDEO_DEFAULTS);
  const [referenceFile, setReferenceFile] = useState(null);
  const [results, setResults] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [status, setStatus] = useState("idle");
  const [error, setError] = useState("");
  const inputRef = useRef(null);

  const activeModel = videoModels.find((model) => model.value === settings.model) || videoModels[0] || null;
  const ratios = activeModel?.aspectRatios?.length ? activeModel.aspectRatios : ["9:16", "16:9", "1:1"];
  const resolutions = activeModel?.resolutions?.length ? activeModel.resolutions : ["720p"];
  const durations = activeModel ? videoDurationOptions(activeModel) : [5];
  const promptHint = activeModel ? quickVideoPromptPlaceholder(activeModel) : "输入视频画面、镜头运动、人物动作、服装展示和氛围要求";
  const priceText = activeModel ? quickVideoPriceLabel(activeModel, settings.resolution) : "";
  const channelEnabled = Boolean(config?.videoPolicy?.enabled);
  const billingEnabled = Boolean(config?.billingGatewayPolicy?.enabled);
  const billingRequired = Boolean(config?.billingGatewayPolicy?.videoRequired);
  const referencePreview = useMemo(() => (
    referenceFile ? { file: referenceFile, url: URL.createObjectURL(referenceFile) } : null
  ), [referenceFile]);

  useEffect(() => {
    if (!videoModels.length) return;
    setSettings((current) => normalizeQuickVideoSettings(current, videoModels.find((item) => item.value === current.model) || videoModels[0]));
  }, [config?.videoModels]);

  useEffect(() => () => {
    if (referencePreview?.url) URL.revokeObjectURL(referencePreview.url);
  }, [referencePreview]);

  function updateSetting(key, value) {
    setSettings((current) => {
      if (key === "model") {
        const model = videoModels.find((item) => item.value === value) || activeModel || videoModels[0] || {};
        return normalizeQuickVideoSettings({ ...current, model: value }, model);
      }
      if (key === "duration") return { ...current, duration: Number.parseInt(value, 10) || QUICK_VIDEO_DEFAULTS.duration };
      if (key === "outputAudio") return { ...current, outputAudio: Boolean(value) };
      return { ...current, [key]: value };
    });
  }

  function pickReference(event) {
    const file = Array.from(event.target.files || []).find(isImageFile);
    event.target.value = "";
    if (!file) return;
    if (file.size > VIDEO_REFERENCE_MAX_BYTES) {
      setError("参考图超过 10MB，请先压缩后再上传");
      onAddEvent?.("视频参考图", "参考图超过 10MB");
      return;
    }
    setReferenceFile(file);
    setError("");
    onAddEvent?.("视频参考图", `已添加 ${file.name}`);
  }

  async function referencePayload() {
    const url = String(settings.imageUrl || "").trim();
    if (url) return url;
    if (!referenceFile) return "";
    return dataUrlFromBlob(referenceFile);
  }

  async function waitVideoTask(initialTask, requestId, runSettings, startedAt) {
    let task = initialTask || {};
    if (!task.taskId && !task.id && !videoResultUrl(task)) {
      throw new Error("视频任务没有返回任务 ID");
    }
    for (let attempt = 0; attempt < VIDEO_STATUS_MAX_POLLS; attempt += 1) {
      if (isVideoTaskCompleted(task)) return task;
      if (isVideoTaskFailed(task)) throw new Error(task.error?.message || task.error || "视频生成失败");
      setTasks((current) => current.map((item) => item.id === requestId ? {
        ...item,
        statusText: videoTaskStatusText(task),
        progress: task.progress,
        elapsedMs: Date.now() - startedAt
      } : item));
      await new Promise((resolve) => setTimeout(resolve, VIDEO_STATUS_POLL_INTERVAL_MS));
      const previousTaskId = task.taskId || task.id;
      const payload = await getVideoStatus({
        apiKey,
        taskId: previousTaskId
      });
      const nextTask = payload.task || {};
      task = {
        ...nextTask,
        taskId: nextTask.taskId || nextTask.id || previousTaskId,
        id: nextTask.id || nextTask.taskId || previousTaskId
      };
    }
    throw new Error("视频生成等待超时，请稍后到上游任务记录中查看。");
  }

  async function startVideoGeneration() {
    const normalizedApiKey = normalizeApiKeyInput(apiKey);
    const model = activeModel || videoModels[0];
    const runSettings = normalizeQuickVideoSettings(settings, model || {});
    const modelLabel = model?.label || runSettings.model || "Seedance";
    if (!normalizedApiKey) {
      setError("请先在设置里填写 API Key");
      setStatus("failed");
      onOpenSettings?.();
      onAddEvent?.("无法生成视频", "请先填写 API Key");
      return;
    }
    if (!videoModels.length) {
      setError("视频模型配置未加载");
      setStatus("failed");
      return;
    }
    if (!channelEnabled) {
      setError("视频通道未配置，请先配置兰兰达视频 KEY 或静音签发路由");
      setStatus("failed");
      onAddEvent?.("无法生成视频", "视频通道未配置");
      return;
    }
    if (billingRequired && !billingEnabled) {
      setError("视频计费网关未启用，请先接入静音中转站计费后再生成。");
      setStatus("failed");
      onAddEvent?.("无法生成视频", "视频计费网关未启用");
      return;
    }
    if (!String(runSettings.prompt || "").trim()) {
      setError("请输入视频提示词");
      setStatus("failed");
      return;
    }

    const requestId = `workflow_video_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const startedAt = Date.now();
    setStatus("running");
    setError("");
    setTasks((current) => [...current, {
      id: requestId,
      startedAt,
      statusText: "提交中",
      modelLabel,
      resolution: runSettings.resolution,
      aspectRatio: runSettings.aspectRatio,
      duration: runSettings.duration,
      prompt: runSettings.prompt
    }]);
    onAddEvent?.("视频提交", `${modelLabel} / ${runSettings.resolution} / ${runSettings.aspectRatio} / ${runSettings.duration}s`);

    try {
      const image = await referencePayload();
      const payload = await generateVideo({
        apiKey: normalizedApiKey,
        model: runSettings.model,
        prompt: runSettings.prompt,
        duration: runSettings.duration,
        resolution: runSettings.resolution,
        aspectRatio: runSettings.aspectRatio,
        image,
        outputAudio: runSettings.outputAudio,
        metadata: {
          source: "workflow-quick-video",
          clientSessionId: OUTFIT_SESSION_ID
        }
      });
      const finalTask = await waitVideoTask(payload.task || {}, requestId, runSettings, startedAt);
      const url = videoResultUrl(finalTask);
      if (!url) throw new Error("视频任务已完成，但没有返回视频地址");
      const totalMs = Date.now() - startedAt;
      setResults((current) => [{
        id: requestId,
        url,
        prompt: runSettings.prompt,
        modelLabel,
        resolution: runSettings.resolution,
        aspectRatio: runSettings.aspectRatio,
        duration: runSettings.duration,
        generationMs: totalMs,
        createdAt: Date.now()
      }, ...current]);
      setStatus("success");
      onAddEvent?.("视频完成", `生成 1 条视频，用时 ${formatMs(totalMs)}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      setStatus("failed");
      onAddEvent?.("视频失败", message);
    } finally {
      setTasks((current) => current.filter((item) => item.id !== requestId));
    }
  }

  function downloadVideo(item) {
    if (!item?.url) return;
    const link = document.createElement("a");
    link.href = item.url;
    link.download = `静音AI视频-${new Date(item.createdAt || Date.now()).toISOString().replace(/[:.]/g, "-")}.mp4`;
    link.rel = "noreferrer";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    onAddEvent?.("视频下载", "已开始下载视频");
  }

  const statusText = tasks.length
    ? `视频生成中 ${tasks.length}`
    : status === "failed"
      ? error || "视频任务失败"
      : status === "success"
        ? "视频已完成"
        : "等待视频生成";

  return (
    <section className="workflowVideoPanel">
      <header className="moduleHeader">
        <div>
          <h2>快捷视频生成</h2>
          <span>参考图、提示词和视频参数独立管理，不读取批量换装上传区。</span>
        </div>
        <div className="moduleHeaderActions">
          <span className={`taskBadge task-${status === "running" || tasks.length ? "running" : status}`}>{statusText}</span>
          <button className="toolbarButton" type="button" onClick={() => results[0] && downloadVideo(results[0])} disabled={!results.length}>
            <Download size={15} />
            <span>下载最新</span>
          </button>
          <button className="dangerButton" type="button" onClick={() => { setResults([]); setTasks([]); setStatus("idle"); setError(""); }} disabled={!results.length && !tasks.length}>
            <Trash2 size={15} />
            <span>清空视频</span>
          </button>
        </div>
      </header>

      <div className="workflowVideoLayout">
        <section className="workflowVideoResults">
          {tasks.map((task) => (
            <article className="workflowVideoCard loadingCard" key={task.id}>
              <Loader2 className="spin" size={28} />
              <span>{task.statusText || "视频生成中"}</span>
              <strong>{formatMs(Date.now() - task.startedAt)}</strong>
              <em>{task.modelLabel} · {task.resolution} · {task.aspectRatio} · {task.duration}s</em>
            </article>
          ))}
          {results.map((item) => (
            <article className="workflowVideoCard" key={item.id}>
              <button className="assetDownloadButton" type="button" onClick={() => downloadVideo(item)} title="下载视频" aria-label="下载视频">
                <Download size={16} />
              </button>
              {item.generationMs && <div className="assetTimeBadge">用时 {formatMs(item.generationMs)}</div>}
              <video src={item.url} controls preload="metadata" />
              <button className="assetPrompt" type="button" title={item.prompt} onClick={() => void navigator.clipboard?.writeText(item.prompt || "")}>
                {item.prompt}
              </button>
              <div className="assetMeta">
                <span>{item.modelLabel}</span>
                <strong>{item.resolution} · {item.aspectRatio} · {item.duration}s</strong>
              </div>
            </article>
          ))}
          {!tasks.length && !results.length && (
            <div className="workflowVideoEmpty">
              <Video size={34} />
              <span>{error || "暂无视频"}</span>
            </div>
          )}
        </section>

        <section className="workflowVideoComposer">
          {priceText && <span className="workflowVideoPriceBadge">{priceText}</span>}
          <div className="videoReferenceLine">
            <input ref={inputRef} type="file" accept="image/*" onChange={pickReference} />
            <button className="videoReferenceTile" type="button" onClick={() => inputRef.current?.click()}>
              {referencePreview ? (
                <>
                  <img src={referencePreview.url} alt={referencePreview.file.name} />
                  <span>{referencePreview.file.name}</span>
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
              value={settings.imageUrl}
              onChange={(event) => updateSetting("imageUrl", event.target.value)}
              placeholder="图片参考 URL，可留空"
            />
            {(referenceFile || settings.imageUrl) && (
              <button className="smallButton" type="button" onClick={() => { setReferenceFile(null); updateSetting("imageUrl", ""); }}>
                <Trash2 size={15} />
                <span>清空参考</span>
              </button>
            )}
          </div>

          <label className="composerField">
            <span>视频提示词</span>
            <textarea
              value={settings.prompt}
              onChange={(event) => updateSetting("prompt", event.target.value)}
              placeholder={promptHint}
            />
          </label>

          <div className="workflowVideoControls">
            <select value={settings.model} onChange={(event) => updateSetting("model", event.target.value)}>
              {videoModels.map((model) => <option key={model.value} value={model.value}>{model.label}</option>)}
            </select>
            <select value={settings.aspectRatio} onChange={(event) => updateSetting("aspectRatio", event.target.value)}>
              {ratios.map((ratio) => <option key={ratio} value={ratio}>{ratio}</option>)}
            </select>
            <select value={settings.resolution} onChange={(event) => updateSetting("resolution", event.target.value)}>
              {resolutions.map((resolution) => <option key={resolution} value={resolution}>{resolution}</option>)}
            </select>
            <select value={settings.duration} onChange={(event) => updateSetting("duration", event.target.value)}>
              {durations.map((duration) => <option key={duration} value={duration}>{duration}s</option>)}
            </select>
            <button className={`smallButton ${settings.outputAudio ? "active" : ""}`} type="button" onClick={() => updateSetting("outputAudio", !settings.outputAudio)}>
              <Video size={15} />
              <span>{settings.outputAudio ? "音频开" : "音频关"}</span>
            </button>
            {billingRequired && !billingEnabled && <span className="workflowVideoBadge">计费未接入</span>}
            <button className="generateButton" type="button" onClick={() => void startVideoGeneration()} disabled={tasks.length > 0}>
              {tasks.length ? <Loader2 className="spin" size={17} /> : <Play size={17} />}
              <span>生成视频</span>
            </button>
          </div>
        </section>
      </div>
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
  // P1 缺图自愈：记录"结果图确实加载失败"的任务 id → { src, reason }。
  // 只存在内存里；服务端另有"归档文件丢失"的持久标记（走 /api/history）。
  const [brokenTaskImages, setBrokenTaskImages] = useState(() => ({}));
  const [resultReplaceTargetId, setResultReplaceTargetId] = useState("");
  const [activeUploadGroup, setActiveUploadGroup] = useState(() => initialOutfitPage.activeUploadGroup || "model");
  const [originalLibrary, setOriginalLibrary] = useState(() => initialOutfitPage.originalLibrary || []);
  const [imageLightbox, setImageLightbox] = useState(null);
  const [running, setRunning] = useState(false);
  const [masterFitAnalyzing, setMasterFitAnalyzing] = useState(false);
  const [masterFitPromptOpen, setMasterFitPromptOpen] = useState(false);
  const [masterFitPromptDraft, setMasterFitPromptDraft] = useState("");
  const [inlineMessage, setInlineMessage] = useState("");
  const [, setEvents] = useState([]);
  const [clockNow, setClockNow] = useState(Date.now());
  const [cropTarget, setCropTarget] = useState(null);
  const [localEditTarget, setLocalEditTarget] = useState(null);
  const [preview, setPreview] = useState(null);
  const [referenceContextMenu, setReferenceContextMenu] = useState(null);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [apiKeyDraft, setApiKeyDraft] = useState(settings.apiKey || "");
  const [apiSaveStatus, setApiSaveStatus] = useState("");
  const [showKey, setShowKey] = useState(false);
  // 2026-09-25：设置里原有的「开发诊断」区域（含传参自检按钮）已整体替换为「连接测试」。
  const [isConnectionTesting, setIsConnectionTesting] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState("");
  const [connectionState, setConnectionState] = useState("idle");
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
  const resultDragTaskIdRef = useRef("");
  const resultDragPayloadRef = useRef(null);
  const runningGenerationCountRef = useRef(0);
  const localEditPrepareLimiterRef = useRef(createAsyncLimiter(LOCAL_EDIT_BATCH_PREPARE_CONCURRENCY));
  const resultImageCacheInFlightRef = useRef(new Set());
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
  const isRandomBackgroundWorkflow = workflowMode === "random-background";
  const isOutpaintWorkflow = workflowMode === "outpaint";
  const isRecolorWorkflow = workflowMode === "recolor";
  const isWhiteRefineWorkflow = workflowMode === "white-refine";
  const isFaceSwapWorkflow = workflowMode === "face-swap";
  const isLocalDetailWorkflow = workflowMode === "local-detail";
  const isCustomWorkflow = workflowMode === "custom";
  const isPoseRemixWorkflow = workflowMode === "pose-remix";
  const isOutfitWorkflow = workflowMode === "outfit";
  const usesGarmentScopeControls = isOutfitWorkflow || isRecolorWorkflow;
  const canAppendWhileRunning = true;
  const activePageDeleteLocked = Boolean(activeOutfitPage.deleteLocked);
  const models = config.models?.length ? config.models : DEFAULT_MODELS;
  const activeModel = models.find((model) => model.value === settings.model) || models[0];
  // 能力限制唯一来源：routing catalog 的 capabilities（见 src/shared/routing.js）。
  const outfitCapabilities = modelCapabilities(settings.model, config.routing || config);
  const ratios = outfitCapabilities.ratios;
  const outfitSizes = outfitCapabilities.sizes;
  // 每个模型的单次请求图片数量上限（tt-image-2.5 = 8，其余 = 14）。
  const outfitMaxImages = Math.max(1, Math.min(MAX_UPLOAD_IMAGES, outfitCapabilities.maxInputImages));
  const outfitChannels = channelsForModel(settings.model, config.routing || config);
  const activeModels = modelImages.filter((item) => item.selected);
  const activeClothes = clothingImages.filter((item) => item.selected);
  const selectedFixedClothing = clothingImages.find((item) => item.id === fixedClothingId) || activeClothes[0] || clothingImages[0];
  const masterFitLockReady = isOutfitWorkflow
    && settings.pairingMode === "fixed"
    && Boolean(selectedFixedClothing?.id)
    && normalizeMasterFitLock(settings.masterFitLock)
    && Boolean(normalizeMasterFitSpec(settings.masterFitSpec))
    && normalizeMasterFitSourceId(settings.masterFitSourceId) === selectedFixedClothing.id;
  const selectedGarmentParts = normalizeGarmentParts(settings.garmentParts);
  const selectedGarmentComposition = normalizeGarmentComposition(settings.garmentComposition, selectedGarmentParts);
  const activeGarmentLengths = normalizeGarmentLengths(settings.garmentLengths, selectedGarmentParts);
  const upperLengthEnabled = selectedGarmentParts.includes("upper");
  const lowerLengthEnabled = selectedGarmentParts.includes("lower");
  const completedCount = tasks.filter((task) => task.status === "success").length;
  const failedCount = tasks.filter((task) => task.status === "failed").length;
  const runningCount = tasks.filter((task) => task.status === "running").length;
  const detachedCount = tasks.filter((task) => task.status === "detached").length;
  const imageCount = completedCount;
  const visibleTasks = resultFilter === "video" ? [] : resultFilter === "image" ? tasks.filter((task) => task.result) : tasks;
  const resultPreviewTasks = visibleTasks.filter((task) => task.result);
  const selectedCount = tasks.reduce((count, task) => count + (selectedTaskIds.has(task.id) ? 1 : 0), 0);
  const selectedCompletedCount = tasks.reduce((count, task) => count + (selectedTaskIds.has(task.id) && task.result ? 1 : 0), 0);
  const galleryZoomPercent = Math.round(galleryZoom * 100);
  const galleryCardMin = Math.round(176 * galleryZoom);
  const generationCount = normalizeGenerationCount(settings.generationCount);
  const plannedGenerationCount = generationCount === "auto"
    ? Math.min(
        isDesignDraftWorkflow
          ? Math.max(1, activeClothes.length)
          : isPoseRemixWorkflow
            ? Math.max(1, activeModels.length)
            : activeModels.length,
        outfitMaxImages
      )
    : generationCount;
  const topbarStatus = runningCount > 0 ? "running" : failedCount > 0 ? "failed" : detachedCount > 0 ? "detached" : completedCount > 0 ? "success" : "idle";
  const topbarStatusText = runningCount > 0
    ? `生成中 ${runningCount}/${tasks.length}`
    : tasks.length > 0
      ? detachedCount > 0
        ? `待确认 ${detachedCount} 个`
        : `完成 ${completedCount}/${tasks.length}`
      : "等待生成";
  const workflowEventTitle = isDesignDraftWorkflow
    ? "设计稿"
    : isPoseRemixWorkflow
      ? "批量姿态"
      : isRandomBackgroundWorkflow
        ? "随机背景"
        : isBackgroundChangeWorkflow
          ? "固定背景"
        : isOutpaintWorkflow
          ? "批量扩图"
          : isRecolorWorkflow
            ? "批量改色"
            : isWhiteRefineWorkflow
              ? "批量白底精修"
              : isFaceSwapWorkflow
                ? "批量换脸"
                : isLocalDetailWorkflow
                  ? "局部回贴"
                  : "批量换装";
  const promptFieldTitle = isDesignDraftWorkflow
    ? "通用设计稿提示词"
    : isPoseRemixWorkflow
      ? "通用批量姿态提示词"
      : isRandomBackgroundWorkflow
        ? "通用随机背景提示词"
        : isBackgroundChangeWorkflow
          ? "通用固定背景提示词"
        : isOutpaintWorkflow
          ? "通用批量扩图提示词"
          : isRecolorWorkflow
            ? "通用改色提示词"
            : isWhiteRefineWorkflow
              ? "通用白底精修提示词"
              : isFaceSwapWorkflow
                ? "通用换脸提示词"
                : isLocalDetailWorkflow
                  ? "通用局部回贴提示词"
                  : isCustomWorkflow
                    ? "本次临时提示词"
                    : "通用换装提示词";
  const promptFieldPlaceholder = isDesignDraftWorkflow
    ? "长期复用的设计稿规则，例如笔触压感、手稿风格、服装结构和辅助短线。"
    : isPoseRemixWorkflow
      ? "长期复用的批量姿态规则，例如图1只取姿态，图2锁定人物、服装穿法和场景。"
      : isRandomBackgroundWorkflow
        ? "长期复用的随机背景规则，例如锁定人物和服装，只按场景补充生成同一场景体系的不同机位。"
        : isBackgroundChangeWorkflow
          ? "长期复用的固定背景规则，例如锁定人物结构、统一目标背景光影和整体色温。"
        : isOutpaintWorkflow
          ? "长期复用的批量扩图规则，例如锁定图1已有内容，只向下补出下半身、鞋子和原场景延展。"
          : isRecolorWorkflow
            ? "长期复用的改色规则，例如只改指定服装颜色，人物、场景、款式和材质细节不变。"
            : isWhiteRefineWorkflow
              ? "长期复用的白底精修规则，例如去衣架、换白底、整理压痕和褶皱，但不改服装细节颜色。"
              : isFaceSwapWorkflow
                ? "长期复用的换脸规则，例如图1锁定身体衣服姿势背景，图2只提供脸部身份和可融合发型方向。"
                : isLocalDetailWorkflow
                  ? "长期复用的局部服装细节规则，例如只改点名细节、图2只取结构、颜色材质跟图1。"
                  : isCustomWorkflow
                    ? "这个页面不会自动套用后台 SKILL；按你当前临时需求直接写。"
                    : "长期复用的换装规则，例如保留人物、锁定服装版型、真实贴合、批量一致。";
  const productNoteFieldTitle = isRandomBackgroundWorkflow ? "场景补充" : "本次需求 / 商品补充信息";
  const productNotePlaceholder = isRandomBackgroundWorkflow
    ? "写你想要的大概场景需求，例如：早秋休闲度假实景街景，少量斑马线，适度景深虚化，平视机位，画面干净。"
    : "只写这次要额外控制的内容，例如袖长、裙长、SKU颜色、背景、鞋包是否保留。";
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
    getAppConfig()
      .then((payload) => {
        if (payload?.models?.length) {
          setConfig(payload);
          // 目录加载完成后再按 capabilities 归一化一次；目录没回来之前不动用户存档。
          const routingCatalog = payload.routing || payload;
          setSettings((current) => convergeSettingsForModel(current, routingCatalog));
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    historyHydratingRef.current = true;
    readTaskHistoryAsync()
      .then((history) => {
        if (cancelled || !history.length) return;
        const hydratedHistory = hydrateTasksWithUploadReferences(history, {
          modelImages,
          clothingImages,
          referenceImages
        });
        setTasks((current) => {
          const runningItems = current.filter(isLiveGenerationTask);
          const hasLiveResults = current.some((task) => task.status === "success" && imageSource(task.result));
          return hasLiveResults ? current : [...hydratedHistory, ...runningItems];
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
    if (!historyReady || !draftReady || historyHydratingRef.current || draftHydratingRef.current) return;
    const persisted = tasks
      .filter((task) => task.status === "success" && imageSource(task.result))
      .map(sanitizeTaskHistoryItem)
      .filter(Boolean)
      .slice(-500);
    void persistTaskHistory(persisted);
  }, [tasks, historyReady, draftReady]);

  useEffect(() => {
    if (!historyReady) return undefined;
    const inFlight = resultImageCacheInFlightRef.current;
    const targets = tasks
      .map((task) => ({ task, key: resultImageCacheKey(task.result) || task.id }))
      .filter(({ task, key }) => (
        task.status === "success"
        && task.result
        && cacheableResultImageSource(task.result)
        && !task.result.cachedUrl
        && key
        && !inFlight.has(key)
      ))
      .slice(0, 2);
    if (targets.length === 0) return undefined;

    let cancelled = false;
    targets.forEach(({ key }) => inFlight.add(key));
    Promise.all(targets.map(async ({ task, key }) => {
      try {
        return {
          id: task.id,
          result: await cacheResultImageBlob(task.result)
        };
      } finally {
        inFlight.delete(key);
      }
    })).then((cachedItems) => {
      if (cancelled) return;
      const resultById = new Map(cachedItems
        .filter((item) => item.result?.cachedUrl)
        .map((item) => [item.id, item.result]));
      if (resultById.size === 0) return;
      setTasks((current) => current.map((task) => {
        const result = resultById.get(task.id);
        if (!result || task.result?.cachedUrl) return task;
        return { ...task, result };
      }));
    }).catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [tasks, historyReady]);

  useEffect(() => {
    void refreshSaveDirectory();
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      writeJsonStorage(STORAGE_KEY, settings);
    }, 260);
    return () => window.clearTimeout(timer);
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
    if (!preview?.id) return;
    const latestPreview = tasks.find((task) => task.id === preview.id);
    if (latestPreview && latestPreview !== preview) {
      setPreview(latestPreview);
    } else if (!latestPreview) {
      setPreview(null);
    }
  }, [tasks, preview]);

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
    if (key === "pairingMode" && value !== "fixed" && (settings.masterFitLock || settings.masterFitSpec)) {
      invalidateMasterFitLock("切换为一一对应或循环配对，母版锁定已关闭");
    }
    if (key === "model") {
      // 切换模型时按新模型的 capabilities 重新收敛比例 / 尺寸 / 生成数量 / 线路。
      setSettings((current) => convergeSettingsForModel(
        { ...current, model: value },
        config.routing || config
      ));
      return;
    }
    if (key === "channelId") {
      const channels = channelsForModel(settings.model, config.routing || config);
      setSettings((current) => ({
        ...current,
        channelId: channels.some((channel) => channel.id === value) ? value : (channels[0]?.id || "")
      }));
      return;
    }
    const normalizeValue = (current) => {
      if (key === "generationCount") return normalizeGenerationCount(value);
      if (key === "smartIntervention") return normalizeSmartIntervention(value);
      if (key === "qualityCheck") return normalizeQualityCheck(value);
      if (key === "garmentParts") return normalizeGarmentParts(value);
      if (key === "garmentComposition") return normalizeGarmentComposition(value, current.garmentParts);
      if (key === "garmentLengths") return normalizeGarmentLengths(value, current.garmentParts);
      if (key === "masterFitLock") return normalizeMasterFitLock(value);
      if (key === "masterFitSpec") return normalizeMasterFitSpec(value);
      if (key === "masterFitSourceId") return normalizeMasterFitSourceId(value);
      return value;
    };
    setSettings((current) => {
      const next = {
        ...current,
        [key]: normalizeValue(current)
      };
      if (key === "generationCount") next[GENERATION_COUNT_AUTOLINK_MIGRATION_KEY] = true;
      return next;
    });
  }

  function enableGenerationCountAutoLink() {
    if (isDesignDraftWorkflow) return;
    setSettings((current) => current.generationCount === "auto"
      ? current
      : {
          ...current,
          generationCount: "auto",
          [GENERATION_COUNT_AUTOLINK_MIGRATION_KEY]: true
        });
  }

  // 中文注释：清除母版规格只用于删除/清空母版图；替换图2时保留用户已调好的提示词。
  function invalidateMasterFitLock(detail = "") {
    setSettings((current) => ({
      ...current,
      masterFitLock: false,
      masterFitSpec: "",
      masterFitSourceId: ""
    }));
    if (detail) addEvent("母版版型", detail);
  }

  function pauseMasterFitLock(detail = "") {
    setSettings((current) => ({
      ...current,
      masterFitLock: false
    }));
    if (detail) addEvent("母版版型", detail);
  }

  // 中文注释：只有固定服装且已有当前图2规格时，才允许把母版版型作为硬约束发送给后端。
  function toggleMasterFitLock() {
    if (settings.masterFitLock) {
      updateSetting("masterFitLock", false);
      addEvent("母版版型", "已关闭母版锁定");
      return;
    }
    if (!selectedFixedClothing) {
      addEvent("母版版型", "请先上传并设定一张固定图2");
      return;
    }
    if (settings.pairingMode !== "fixed") {
      addEvent("母版版型", "母版锁定只用于固定服装配对");
      return;
    }
    if (!settings.masterFitSpec || settings.masterFitSourceId !== selectedFixedClothing.id) {
      addEvent("母版版型", "请先分析当前固定图2母版");
      return;
    }
    updateSetting("masterFitLock", true);
    addEvent("母版版型", "已锁定当前图2版型");
  }

  // 中文注释：调用服务端视觉分析当前固定图2，把一次性分析结果写入当前页面设置。
  async function analyzeMasterFit() {
    if (masterFitAnalyzing) return;
    if (!effectiveApiKey) {
      addEvent("母版分析", "请先填写 API Key");
      openSettings();
      return;
    }
    if (!selectedFixedClothing?.file) {
      addEvent("母版分析", "请先上传并设定一张固定图2");
      return;
    }
    if (settings.pairingMode !== "fixed") {
      addEvent("母版分析", "请先切换为固定服装配对");
      return;
    }

    const source = selectedFixedClothing;
    setMasterFitAnalyzing(true);
    addEvent("母版分析", "正在读取当前图2的版型、袖口、腰身和长度规格");
    try {
      const form = new FormData();
      form.append("payload", JSON.stringify({
        apiKey: effectiveApiKey,
        model: settings.model,
        imageSize: settings.imageSize,
        aspectRatio: settings.aspectRatio,
        garmentParts: normalizeGarmentParts(settings.garmentParts),
        garmentComposition: normalizeGarmentComposition(settings.garmentComposition, settings.garmentParts),
        garmentLengths: normalizeGarmentLengths(settings.garmentLengths, settings.garmentParts),
        prompt: settings.prompt,
        productNote: settings.productNote
      }));
      form.append("image", source.file, `master_${source.name || "clothing.jpg"}`);
      const payload = await analyzeOutfitMasterFit(form);
      const spec = normalizeMasterFitSpec(payload.spec || payload.promptBlock);
      if (!spec) throw new Error("服务端没有返回有效母版规格");
      updateSetting("masterFitSpec", spec);
      updateSetting("masterFitSourceId", source.id);
      updateSetting("masterFitLock", true);
      addEvent("母版分析", `已锁定「${source.name}」的版型规格`);
    } catch (error) {
      addEvent("母版分析失败", error instanceof Error ? error.message : String(error));
    } finally {
      setMasterFitAnalyzing(false);
    }
  }

  function openMasterFitPromptModal() {
    setMasterFitPromptDraft(settings.masterFitSpec || "");
    setMasterFitPromptOpen(true);
  }

  function applyMasterFitPromptDraft() {
    const nextSpec = normalizeMasterFitSpec(masterFitPromptDraft);
    setSettings((current) => ({
      ...current,
      masterFitSpec: nextSpec,
      masterFitLock: false,
      masterFitSourceId: nextSpec && selectedFixedClothing?.id ? selectedFixedClothing.id : ""
    }));
    setMasterFitPromptOpen(false);
    addEvent("母版版型", nextSpec ? "已修改母版提示词，请重新开启锁定" : "已清空母版提示词");
  }

  // 中文注释：切换固定图2只关闭锁定，不清空用户手写的母版提示词，方便继续复用或手动确认。
  function setMasterClothing(id) {
    if (id === fixedClothingId) return;
    setFixedClothingId(id);
    if (settings.masterFitSpec || settings.masterFitLock) {
      pauseMasterFitLock("固定图2已更换，母版提示词已保留，请确认后重新开启锁定");
    }
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
      garmentComposition: normalizeGarmentComposition(current.garmentComposition, nextParts),
      garmentLengths: normalizeGarmentLengths(current.garmentLengths, nextParts)
    }));
  }

  function applyGarmentPartPreset(preset) {
    const nextParts = normalizeGarmentParts(preset?.parts);
    const nextComposition = normalizeGarmentComposition(preset?.composition || preset?.value, nextParts);
    setSettings((current) => ({
      ...current,
      garmentParts: nextParts,
      garmentComposition: nextComposition,
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

  function openSettings() {
    if (embeddedMode) {
      // 批量页嵌在快捷生成里时，设置面板由宿主页面渲染；连接测试也在宿主面板里。
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

  function updateTaskRuntime(taskId, runtimeStage, runtimeDetail = "") {
    if (!taskId) return;
    setTasks((current) => current.map((item) => item.id === taskId ? {
      ...item,
      runtimeStage,
      runtimeDetail,
      runtimeUpdatedAt: Date.now()
    } : item));
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
    const snapshotAllowsEmptyPrompt = snapshotWorkflowMode === "custom" || snapshotWorkflowMode === "local-detail";
    return {
      ...basePage,
      id: basePage.id || activeOutfitPageId,
      name: normalizeOutfitPageName(basePage.name, DEFAULT_OUTFIT_PAGE_NAME),
      deleteLocked: Boolean(basePage.deleteLocked),
      settings: stripOutfitPageGlobalSettings(settings, { allowEmptyPrompt: snapshotAllowsEmptyPrompt }),
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
    const pageAllowsEmptyPrompt = pageWorkflowMode === "custom" || pageWorkflowMode === "local-detail";
    const pageModelImages = Array.isArray(page.modelImages) ? page.modelImages : [];
    const pageClothingImages = Array.isArray(page.clothingImages) ? page.clothingImages : [];
    const pageReferenceImages = Array.isArray(page.referenceImages) ? page.referenceImages : [];
    setSettings(mergeOutfitPageSettings(page.settings, settings, { allowEmptyPrompt: pageAllowsEmptyPrompt }));
    setModelImages(pageModelImages);
    setClothingImages(pageClothingImages);
    setReferenceImages(pageReferenceImages);
    setFixedClothingId(page.fixedClothingId || "");
    setTasks(hydrateTasksWithUploadReferences(page.tasks, {
      modelImages: pageModelImages,
      clothingImages: pageClothingImages,
      referenceImages: pageReferenceImages
    }));
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
        LOCAL_DETAIL_DEFAULT_PROMPT,
        POSE_REMIX_DEFAULT_PROMPT,
        BACKGROUND_CHANGE_LEGACY_DEFAULT_PROMPT,
        BACKGROUND_CHANGE_PERSON_LIGHT_LEGACY_DEFAULT_PROMPT,
        BACKGROUND_CHANGE_DEFAULT_PROMPT,
        RANDOM_BACKGROUND_LIGHT_LEGACY_DEFAULT_PROMPT,
        RANDOM_BACKGROUND_NEUTRAL_DAYLIGHT_LEGACY_DEFAULT_PROMPT,
        RANDOM_BACKGROUND_LEGACY_DEFAULT_PROMPT,
        RANDOM_BACKGROUND_DEFAULT_PROMPT,
        WHITE_REFINE_COLOR_LOCK_LEGACY_DEFAULT_PROMPT,
        WHITE_REFINE_DEFAULT_PROMPT,
        FACE_SWAP_SHORT_DEFAULT_PROMPT,
        FACE_SWAP_BATCH_TONE_LEGACY_DEFAULT_PROMPT,
        FACE_SWAP_HEAD_LOCK_LEGACY_DEFAULT_PROMPT,
        FACE_SWAP_DEFAULT_PROMPT,
        FACE_SWAP_PRE_HEAD_LOCK_SHORT_DEFAULT_PROMPT,
        FACE_SWAP_PRE_HEAD_LOCK_DEFAULT_PROMPT,
        LEGACY_FACE_SWAP_DEFAULT_PROMPT,
        FACE_SWAP_LOOSE_DEFAULT_PROMPT,
        POSE_MOTHER_FACE_SWAP_DEFAULT_PROMPT,
        DESIGN_DRAFT_DEFAULT_PROMPT
      ].includes(currentPrompt);
    const nextSettings = shouldApplyPromptDefault
      ? {
          ...pageSettings,
          prompt: defaultPromptForWorkflowMode(nextMode),
          productNote: ""
        }
      : pageSettings;
    const nextAllowsEmptyPrompt = nextMode === "custom" || nextMode === "local-detail";
    setOutfitPages((current) => current.map((item) => (
      item.id === pageId ? { ...item, name, uploadLabels: nextUploadLabels, settings: stripOutfitPageGlobalSettings(nextSettings, { allowEmptyPrompt: nextAllowsEmptyPrompt }) } : item
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
    // 中文注释：批量姿态页图1承载多张姿态，图2只保留固定母版和备用母版。
    const uploadLimit = group === "clothing" && (isOutfitWorkflow || isPoseRemixWorkflow || isFaceSwapWorkflow)
      ? 2
      : outfitMaxImages;
    const allowed = Math.max(0, uploadLimit - currentCount);
    if (allowed <= 0) {
      addEvent("上传限制", `当前图片区最多 ${uploadLimit} 张`);
      return;
    }
    const acceptedFiles = Array.from(files || []).slice(0, allowed);
    if (acceptedFiles.length < Array.from(files || []).length) {
      addEvent("上传限制", `已保留前 ${uploadLimit} 张，超出的图片未加入`);
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
    if (group === "model") {
      setModelImages((current) => [...current, ...items]);
      if (items.length) enableGenerationCountAutoLink();
    }
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
    if (group === "model") {
      setModelImages(remove);
      enableGenerationCountAutoLink();
    }
    if (group === "clothing") {
      if (fixedClothingId === id && (settings.masterFitSpec || settings.masterFitLock)) {
        invalidateMasterFitLock("固定图2已移除，请重新设定母版");
      }
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
      if (group === "clothing") {
        if (fixedClothingId === id && (settings.masterFitSpec || settings.masterFitLock)) {
          pauseMasterFitLock("固定图2已替换，母版提示词已保留，请确认后重新开启锁定");
        }
        setClothingImages(replace);
      }
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
    if (group === "model") {
      setModelImages(clear);
      enableGenerationCountAutoLink();
    }
    if (group === "clothing") {
      if (settings.masterFitSpec || settings.masterFitLock) {
        invalidateMasterFitLock("图2已清空，母版版型规格已移除");
      }
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
    if (group === "model") {
      setModelImages(toggle);
      enableGenerationCountAutoLink();
    }
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
      return {
        ...item,
        cropReturn: group === "model" ? normalizeCropReturnMeta(item.cropReturn) : null
      };
    });
    if (group === "model") setModelImages(replace);
    if (group === "clothing") {
      if (item.id === fixedClothingId && (settings.masterFitSpec || settings.masterFitLock)) {
        pauseMasterFitLock("固定图2已重新裁剪，母版提示词已保留，请确认后重新开启锁定");
      }
      setClothingImages(replace);
    }
    if (group === "reference") setReferenceImages(replace);
    setCropTarget(null);
    if (group === "model" && item.cropReturn?.cropRect) {
      addEvent("裁剪生成回流", `图1已记录 ${item.cropReturn.cropWidth || item.cropReturn.cropRect.width}×${item.cropReturn.cropHeight || item.cropReturn.cropRect.height} 裁剪框，生成后回流到 ${item.cropReturn.outputWidth}×${item.cropReturn.outputHeight} 大图`);
    }
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
    if (group === "clothing") {
      if (settings.masterFitSpec || settings.masterFitLock) {
        pauseMasterFitLock("图2处理方式已变化，母版提示词已保留，请确认后重新开启锁定");
      }
      setClothingImages(nextItems);
    }
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
    setTasks((current) => {
      const removed = current.filter((task) => ids.has(task.id));
      revokeTaskResultRuntimeCaches(removed);
      return current.filter((task) => !ids.has(task.id));
    });
    clearSelection();
    addEvent("删除", `已删除 ${selectedTaskIds.size} 个队列项`);
  }

  function deleteResultTask(taskId) {
    const target = tasksRef.current.find((task) => task.id === taskId);
    if (!target) return;
    revokeTaskResultRuntimeCaches([target]);
    setTasks((current) => current.filter((task) => task.id !== taskId));
    setSelectedTaskIds((current) => {
      if (!current.has(taskId)) return current;
      const next = new Set(current);
      next.delete(taskId);
      return next;
    });
    setBrokenTaskImages((current) => {
      if (!current[taskId]) return current;
      const next = { ...current };
      delete next[taskId];
      return next;
    });
    if (preview?.id === taskId) setPreview(null);
    addEvent("删除", `已删除 #${target.order || ""} 结果图`);
  }

  /**
   * P1 缺图自愈：结果图真的加载失败时记下来，卡片改为显示可读原因，
   * 并且不再对同一个地址重复请求（避免每次打开页面都刷 404/502）。
   * 记录带失败时的地址，重刷换图后自动失效；同时写进任务记录，重载后依然生效。
   */
  function markTaskImageBroken(task) {
    const src = displayResultImageSource(task?.result);
    if (!task?.id || !src) return;
    const mark = { src, reason: brokenImageReason() };
    setBrokenTaskImages((current) => (
      current[task.id]?.src === src ? current : { ...current, [task.id]: mark }
    ));
    setTasks((current) => current.map((item) => (
      item.id === task.id && item.resultMissing?.src !== src ? { ...item, resultMissing: mark } : item
    )));
  }

  function clearAll() {
    if (tasks.length === 0) return;
    const confirmed = window.confirm("确定清空当前换装生成记录吗？上传图片和原图库不会被清空。");
    if (!confirmed) return;
    revokeTaskResultRuntimeCaches(tasks);
    setTasks([]);
    clearSelection();
    removeStorageItem(TASK_HISTORY_KEY);
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
    const clearedActiveSnapshot = {
      ...activeSnapshot,
      settings: stripOutfitPageGlobalSettings({
        ...settings,
        masterFitLock: false,
        masterFitSpec: "",
        masterFitSourceId: ""
      })
    };
    const nextPages = ensureWorkflowPages(outfitPages.map((page) => {
      const sourcePage = page.id === activeOutfitPageId ? clearedActiveSnapshot : page;
      revokePageNonResultImageUrls(sourcePage);
      return stripPageNonResultImages(sourcePage);
    }), settings);

    setOutfitPages(nextPages);
    setModelImages([]);
    setClothingImages([]);
    setReferenceImages([]);
    setFixedClothingId("");
    invalidateMasterFitLock("上传缓存已清理，母版版型规格已移除");
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
    const hydratedHistory = hydrateTasksWithUploadReferences(history, {
      modelImages,
      clothingImages,
      referenceImages
    });
    setTasks((current) => {
      const runningItems = current.filter(isLiveGenerationTask);
      return [...hydratedHistory, ...runningItems];
    });
    clearSelection();
    addEvent("刷新", `已载入 ${history.length} 张历史图片`);
  }

  async function refreshSaveDirectory() {
    try {
      const payload = await getSaveDirectory();
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
      const payload = await setSaveDirectoryRequest(directoryDraft);
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
      const payload = await pickSaveDirectoryRequest(directoryDraft || saveDirectory);
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
    openSaveDirectoryRequest(directory).then((payload) => {
      setSaveDirectory(payload.directory);
      setDirectoryDraft((current) => current || payload.directory);
      addEvent("保存目录", "已打开");
    }).catch((error) => {
      addEvent("打开失败", error instanceof Error ? error.message : String(error));
    });
  }

  async function saveProcessedImageToFolder(file, subfolder = "", directoryOverride = "") {
    const directory = directoryOverride || saveDirectory || await refreshSaveDirectory();
    if (!directory) throw new Error("未找到指定文件夹");
    const form = new FormData();
    form.append("directory", directory);
    form.append("subfolder", String(subfolder ?? ""));
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

  async function cacheTaskResultImageFile(file, taskId) {
    if (!(file instanceof File)) return null;
    const form = new FormData();
    form.append("taskId", taskId || "");
    form.append("image", file, file.name || "result.png");
    const response = await fetch("/api/cache-result-image", {
      method: "POST",
      body: form
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok) {
      throw new Error(payload?.message || "缓存结果图片失败");
    }
    return payload;
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

  function taskDragDownloadName(task, fallbackIndex = null) {
    if (task?.savedFilename) return task.savedFilename;
    // 拖拽下载不经过服务端保存目录，使用生成日期时间+任务序号避免模型名反复重名。
    const createdAt = Number(task?.finishedAt || task?.createdAt || task?.startedAt || Date.now());
    const taskOrder = Number(task?.order);
    const sequence = Number.isFinite(taskOrder) && taskOrder > 0
      ? taskOrder
      : Number.isFinite(fallbackIndex)
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

  function beginTaskImageDrag(event, task, fallbackIndex = null) {
    const src = imageSource(task?.result);
    beginImageDownloadDrag(event, src, taskDragDownloadName(task, fallbackIndex), task?.result);
    if (!src || !task?.id) return;
    const payload = { taskId: task.id, order: task.order || fallbackIndex || 0 };
    event.dataTransfer.setData(OUTFIT_RERUN_DRAG_MIME, JSON.stringify(payload));
    event.dataTransfer.effectAllowed = "copyMove";
    resultDragTaskIdRef.current = task.id;
    resultDragPayloadRef.current = payload;
  }

  function beginReferenceImageDrag(event, reference, index = 0) {
    const src = referenceSource(reference);
    beginImageDownloadDrag(event, src, reference?.name || reference?.label || `参考图-${index + 1}`);
  }

  function clearResultDragState() {
    resultDragTaskIdRef.current = "";
    resultDragPayloadRef.current = null;
    setResultReplaceTargetId("");
  }

  function canRerunTask(task) {
    return Boolean(
      imageItemUploadFile(task?.modelItem)
      && (
        task?.workflowMode === "outpaint"
        || task?.workflowMode === "white-refine"
        || task?.workflowMode === "random-background"
        || imageItemUploadFile(task?.clothingItem)
      )
    );
  }

  function buildRerunReplacementTask(task) {
    const createdAt = Date.now();
    return {
      ...task,
      sessionId: OUTFIT_SESSION_ID,
      status: "queued",
      error: "",
      errorDetail: "",
      result: null,
      savedFilename: "",
      savedPath: "",
      autoSaveFailed: false,
      qualityCheck: task.qualityCheckEnabled
        ? { status: "pending", summary: "等待重刷后 AI质检" }
        : null,
      prompt: "",
      timingMs: null,
      startedAt: null,
      finishedAt: null,
      createdAt,
      rerunOf: task.rerunOf || task.id,
      rerunCandidate: false
    };
  }

  function resultDragTaskId(event) {
    try {
      const raw = event.dataTransfer?.getData?.(OUTFIT_RERUN_DRAG_MIME);
      if (!raw) return resultDragTaskIdRef.current || resultDragPayloadRef.current?.taskId || "";
      const payload = JSON.parse(raw);
      return String(payload?.taskId || resultDragPayloadRef.current?.taskId || "");
    } catch {
      return resultDragTaskIdRef.current || resultDragPayloadRef.current?.taskId || "";
    }
  }

  function canReplaceTaskResult(sourceTask, targetTask) {
    return Boolean(
      sourceTask?.id
      && targetTask?.id
      && sourceTask.id !== targetTask.id
      && sourceTask.status === "success"
      && targetTask.status === "success"
      && imageSource(sourceTask.result)
      && imageSource(targetTask.result)
    );
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
    if (image.cachedFile instanceof File) {
      const payload = await saveProcessedImageToFolder(image.cachedFile, "", directory);
      return payload;
    }
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

  async function saveTaskImageToDirectoryViaBlob(task, imageOverride = null) {
    const image = imageOverride || task?.result;
    const src = imageSource(image);
    if (!task || !src) throw new Error("图片地址无效");
    const directory = saveDirectory || await refreshSaveDirectory();
    const blob = await fetchImageBlob(src, "图片下载失败");
    const file = fileFromBlob(blob, taskDragDownloadName(task), image?.mimeType || image?.archiveMime || "image/png");
    return saveProcessedImageToFolder(file, "", directory);
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
      try {
        const payload = await saveTaskImageToDirectoryViaBlob(task, image);
        markTaskSaved(task.id, payload, { flash: true });
        addEvent("自动保存兜底", "已通过本地代理重新保存结果图");
      } catch (fallbackError) {
        setTasks((current) => current.map((item) => item.id === task.id ? { ...item, autoSaveFailed: true } : item));
        addEvent("自动保存失败", fallbackError instanceof Error ? fallbackError.message : (error instanceof Error ? error.message : String(error)));
      }
    }
  }

  async function downloadTask(task) {
    if (!task?.result) return;
    try {
      const payload = await saveTaskImageToDirectory(task);
      markTaskSaved(task.id, payload, { flash: true });
      addEvent("下载", `已保存为 ${payload.filename}`);
    } catch (error) {
      try {
        const payload = await saveTaskImageToDirectoryViaBlob(task);
        markTaskSaved(task.id, payload, { flash: true });
        addEvent("下载兜底", `已保存为 ${payload.filename}`);
      } catch (fallbackError) {
        addEvent("下载失败", fallbackError instanceof Error ? fallbackError.message : (error instanceof Error ? error.message : String(error)));
      }
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
    const count = Math.min(countOverride, outfitMaxImages);
    const referenceMentioned = mentionsOptionalReferenceImage(settings.prompt, settings.productNote);
    const selectedReferences = isOutpaintWorkflow || isWhiteRefineWorkflow || isRandomBackgroundWorkflow
      ? []
      : (!isOutfitWorkflow && !isPoseRemixWorkflow) || referenceMentioned
        ? referenceImages.filter((item) => item.selected)
        : [];
    const outpaintReferenceItems = [];
    return Array.from({ length: count }, (_, index) => {
      const modelItem = isDesignDraftWorkflow ? activeModels[0] : modelForIndex(index);
      const extraModelItems = isDesignDraftWorkflow ? activeModels.slice(1) : [];
      const clothingItem = isOutpaintWorkflow || isRandomBackgroundWorkflow ? null : clothingForIndex(index);
      const extraClothingItems = isRecolorWorkflow || isWhiteRefineWorkflow
        ? activeClothes.filter((item) => item.id !== clothingItem?.id)
        : [];
      const localEdit = !isDesignDraftWorkflow && !isPoseRemixWorkflow && !isOutpaintWorkflow && !isWhiteRefineWorkflow && !isRandomBackgroundWorkflow && modelItem?.localEdit?.cropFile && modelItem?.localEdit?.cropRect ? modelItem.localEdit : null;
      const cropReturn = !localEdit && !isDesignDraftWorkflow && !isPoseRemixWorkflow && !isOutpaintWorkflow && !isWhiteRefineWorkflow && !isRandomBackgroundWorkflow && modelItem?.cropReturn?.cropRect
        ? normalizeCropReturnMeta(modelItem.cropReturn)
        : null;
      const qualityCheckEnabled = !isOutpaintWorkflow && !isWhiteRefineWorkflow && !isRandomBackgroundWorkflow && normalizeQualityCheck(settings.qualityCheck);
      return {
        id: makeId(`task_${index + 1}`),
        sessionId: OUTFIT_SESSION_ID,
        order: index + 1,
        modelItem,
        extraModelItems,
        clothingItem,
        extraClothingItems,
        outpaintReferenceItems,
        referenceItems: selectedReferences,
        localEdit,
        cropReturn,
        workflowMode,
        pageName: activeOutfitPage.name,
        uploadLabels,
        modelImageCount: isDesignDraftWorkflow ? activeModels.length : 1,
        status: "queued",
        error: "",
        result: null,
        runtimeStage: "等待调度",
        runtimeDetail: "",
        runtimeUpdatedAt: Date.now(),
        qualityCheckEnabled,
        qualityCheck: qualityCheckEnabled
          ? { status: "pending", summary: "等待生成后 AI质检" }
          : null,
        prompt: "",
        timingMs: null,
        createdAt: Date.now() + index,
        imageSize: settings.imageSize,
        aspectRatio: localEdit?.aspectRatio || cropReturn?.aspectRatio || settings.aspectRatio,
        garmentParts: usesGarmentScopeControls ? normalizeGarmentParts(settings.garmentParts) : undefined,
        garmentComposition: usesGarmentScopeControls ? normalizeGarmentComposition(settings.garmentComposition, settings.garmentParts) : undefined,
        garmentLengths: isOutfitWorkflow ? normalizeGarmentLengths(settings.garmentLengths, settings.garmentParts) : undefined,
        randomBackgroundFocus: isRandomBackgroundWorkflow ? normalizeRandomBackgroundFocus(settings.randomBackgroundFocus) : undefined,
        // 中文注释：把本轮母版规格冻结在任务快照中，避免生成期间修改页面设置导致同批次串版。
        masterFitLock: masterFitLockReady,
        masterFitSpec: masterFitLockReady ? normalizeMasterFitSpec(settings.masterFitSpec) : "",
        masterFitSourceId: masterFitLockReady ? normalizeMasterFitSourceId(settings.masterFitSourceId) : "",
        pairingMode: settings.pairingMode,
        modelLabel: activeModel.label,
        modelName: modelItem?.name || "",
        clothingName: clothingItem?.name || "",
        referenceNames: [
          ...extraModelItems.map((item) => item.name),
          ...extraClothingItems.map((item) => item.name),
          ...selectedReferences.map((item) => item.name)
        ].filter(Boolean)
      };
    }).filter((task) => task.modelItem && (isOutpaintWorkflow || isWhiteRefineWorkflow || isRandomBackgroundWorkflow || task.clothingItem));
  }

  // 中文注释：生成结果先显示，AI质检后台补标记，避免质检耗时拖慢图片接收。
  async function runTaskQualityCheck(task, modelUploadFile, resultImage, taskAspectRatio, prompt) {
    if (!task?.qualityCheckEnabled) return;
    if (["outpaint", "white-refine", "random-background"].includes(task.workflowMode || workflowMode)) return;
    setTasks((current) => current.map((item) => item.id === task.id ? {
      ...item,
      qualityCheck: {
        status: "checking",
        summary: "AI质检员正在检查脸部、姿态和服装一致性"
      }
    } : item));

    try {
      const resultBlob = await blobFromOutfitImage(resultImage);
      const resultType = resultBlob.type || resultImage?.mimeType || "image/png";
      const resultFile = new File([resultBlob], `result_${task.order}.${imageExtensionFromMime(resultType)}`, {
        type: resultType,
        lastModified: Date.now()
      });
      const form = new FormData();
      const qualityClothingFile = imageItemUploadFile(task.clothingItem);
      form.append("payload", JSON.stringify({
        apiKey: effectiveApiKey,
        workflowMode: task.workflowMode || workflowMode,
        pageName: task.pageName || activeOutfitPage.name,
        prompt: prompt || task.prompt || settings.prompt,
        productNote: settings.productNote,
        model: settings.model,
        imageSize: task.imageSize || settings.imageSize,
        aspectRatio: taskAspectRatio || task.aspectRatio || settings.aspectRatio,
        masterFitLock: Boolean(task.masterFitLock),
        masterFitSpec: task.masterFitLock ? normalizeMasterFitSpec(task.masterFitSpec) : "",
        uploadLabels: task.uploadLabels || uploadLabels
      }));
      form.append("image1", modelUploadFile, `image1_${task.order}_${task.modelItem.name || "pose"}`);
      if (qualityClothingFile instanceof Blob) {
        form.append("image2", qualityClothingFile, `image2_${task.order}_${task.clothingItem.name || "master"}`);
      }
      form.append("result", resultFile, resultFile.name);
      (task.referenceItems || []).forEach((item, index) => {
        const file = imageItemUploadFile(item);
        if (file instanceof Blob) form.append("reference", file, `reference_${index + 1}_${item.name || "ref"}`);
      });

      const payload = await checkOutfitQuality(form);
      const qualityCheck = normalizeQualityCheckResult({
        ...payload,
        status: payload.pass ? "passed" : "failed",
        checkedAt: Date.now()
      });
      setTasks((current) => current.map((item) => item.id === task.id ? { ...item, qualityCheck } : item));
    } catch (error) {
      const summary = error instanceof Error ? error.message : String(error);
      setTasks((current) => current.map((item) => item.id === task.id ? {
        ...item,
        qualityCheck: normalizeQualityCheckResult({
          status: "error",
          summary: `AI质检失败：${summary}`,
          checkedAt: Date.now()
        })
      } : item));
      addEvent("AI质检失败", summary);
    }
  }

  async function runSingleTask(task) {
    const startedAt = Date.now();
    const taskWorkflowMode = task.workflowMode || workflowMode;
    const taskIsOutpaint = taskWorkflowMode === "outpaint";
    const taskIsWhiteRefine = taskWorkflowMode === "white-refine";
    const taskIsRandomBackground = taskWorkflowMode === "random-background";
    const taskUsesGarmentScope = taskWorkflowMode === "outfit" || taskWorkflowMode === "recolor";
    const taskModelFile = imageItemUploadFile(task.modelItem);
    const taskClothingFile = imageItemUploadFile(task.clothingItem);
    let localEdit = taskIsOutpaint || taskIsWhiteRefine || taskIsRandomBackground
      ? null
      : task.localEdit?.cropFile && task.localEdit?.cropRect
        ? task.localEdit
        : task.modelItem?.localEdit?.cropFile && task.modelItem?.localEdit?.cropRect
          ? task.modelItem.localEdit
          : null;
    setClockNow(startedAt);
    setTasks((current) => current.map((item) => item.id === task.id ? {
      ...item,
      sessionId: OUTFIT_SESSION_ID,
      status: "running",
      startedAt,
      error: "",
      errorDetail: "",
      runtimeStage: "准备任务",
      runtimeDetail: task.modelItem?.name ? `图1 ${task.modelItem.name}` : "",
      runtimeUpdatedAt: startedAt
    } : item));
    if (localEdit) {
      updateTaskRuntime(task.id, "本地预处理", "重新裁剪局部回贴区域");
      localEdit = await localEditPrepareLimiterRef.current(() => prepareOutfitTaskLocalEdit(task, localEdit, settings.model, task.localEditBatchMode || ""));
      updateTaskRuntime(task.id, "本地预处理完成", `局部图 ${fileSize(localEdit.cropFile?.size || 0)}`);
    }
    if (!taskModelFile) {
      throw new Error("缺少图1原始上传图，无法生成");
    }
    if (!taskIsOutpaint && !taskIsWhiteRefine && !taskIsRandomBackground && !taskClothingFile) {
      throw new Error("缺少图2原始上传图，无法生成");
    }
    const taskAspectRatio = localEdit?.aspectRatio || task.aspectRatio || settings.aspectRatio;
    if (!localEdit) {
      updateTaskRuntime(task.id, "图片比例处理", `${taskAspectRatio} 上传准备`);
    }
    const outpaintUploadMeta = !localEdit && taskIsOutpaint
      ? await prepareOutpaintUploadCanvas(taskModelFile, taskAspectRatio)
      : null;
    const modelUploadFile = localEdit?.cropFile || (taskIsOutpaint
      ? outpaintUploadMeta?.file
      : await ensureOutfitUploadCanvasRatio(taskModelFile, taskAspectRatio));
    const localEditTaskBinding = localEdit
      ? localEditTaskBindingSnapshot(task, localEdit, taskAspectRatio, modelUploadFile)
      : null;
    updateTaskRuntime(
      task.id,
      "等待中转站返回",
      taskIsOutpaint
        ? `图1 ${fileSize(modelUploadFile?.size || 0)} · 蒙版 ${fileSize(outpaintUploadMeta?.maskFile?.size || 0)}`
        : taskIsWhiteRefine
          ? `图1 ${fileSize(modelUploadFile?.size || 0)} · 参考图 ${(taskClothingFile ? 1 : 0) + (task.extraClothingItems || []).length} 张`
          : taskIsRandomBackground
            ? `图1 ${fileSize(modelUploadFile?.size || 0)} · 场景补充`
            : `图1 ${fileSize(modelUploadFile?.size || 0)} · 图2 ${fileSize(taskClothingFile?.size || 0)}`
    );

    const form = new FormData();
    form.append("payload", JSON.stringify({
      taskId: task.id,
      apiKey: effectiveApiKey,
      // canonical 路由字段：批量换装同样必须带 model / channelId / dispatchMode。
      ...routingFields(settings.model, settings.channelId, config.routing || config),
      imageSize: settings.imageSize,
      aspectRatio: taskAspectRatio,
      prompt: settings.prompt,
      productNote: settings.productNote,
      smartIntervention: settings.smartIntervention,
      // 临时开关：批量 SKILL / 服装规则。默认 false（本轮默认关闭），
      // 关闭时服务端只回用户原始提示词，不追加任何自动规则。
      batchSkillRules: settings.batchSkillRulesEnabled === true,
      garmentParts: taskUsesGarmentScope ? normalizeGarmentParts(task.garmentParts || settings.garmentParts) : undefined,
      garmentComposition: taskUsesGarmentScope ? normalizeGarmentComposition(task.garmentComposition || settings.garmentComposition, task.garmentParts || settings.garmentParts) : undefined,
      garmentLengths: taskWorkflowMode === "outfit" ? normalizeGarmentLengths(task.garmentLengths || settings.garmentLengths, task.garmentParts || settings.garmentParts) : undefined,
      randomBackgroundFocus: taskIsRandomBackground ? normalizeRandomBackgroundFocus(task.randomBackgroundFocus || settings.randomBackgroundFocus) : undefined,
      masterFitLock: isOutfitWorkflow ? Boolean(task.masterFitLock) : undefined,
      masterFitSpec: isOutfitWorkflow && task.masterFitLock ? normalizeMasterFitSpec(task.masterFitSpec) : undefined,
      workflowMode: taskWorkflowMode,
      pageName: task.pageName || activeOutfitPage.name,
      uploadLabels: task.uploadLabels || uploadLabels,
      modelImageCount: task.modelImageCount || 1,
      colorReferenceCount: taskWorkflowMode === "recolor" ? (task.extraClothingItems || []).length : 0,
      whiteRefineReferenceCount: taskIsWhiteRefine ? (taskClothingFile ? 1 : 0) + (task.extraClothingItems || []).length : 0,
      outpaintReferenceCount: 0,
      referenceCount: taskIsOutpaint || taskIsWhiteRefine || taskIsRandomBackground ? 0 : (task.referenceItems || []).length,
      pairingMode: task.pairingMode || settings.pairingMode,
      preprocessMode: settings.preprocessMode,
      deferAutoSave: Boolean(localEdit || taskIsOutpaint),
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
    if (taskIsOutpaint && outpaintUploadMeta?.maskFile instanceof File) {
      form.append("mask", outpaintUploadMeta.maskFile, `mask_${task.order}_${task.modelItem.name}`);
    }
    if (taskWorkflowMode === "design-draft") {
      (task.extraModelItems || []).forEach((item, index) => {
        const file = imageItemUploadFile(item);
        if (file instanceof Blob) form.append("image", file, `model_ref_${index + 2}_${item.name}`);
      });
    }
    if (!taskIsOutpaint && taskClothingFile instanceof Blob) {
      form.append("image", taskClothingFile, `clothing_${task.order}_${task.clothingItem.name}`);
    }
    if (!taskIsOutpaint && (taskWorkflowMode === "recolor" || taskIsWhiteRefine)) {
      (task.extraClothingItems || []).forEach((item, index) => {
        const file = imageItemUploadFile(item);
        if (file instanceof Blob) form.append("image", file, `${taskIsWhiteRefine ? "white_refine_ref" : "color_ref"}_${index + 2}_${item.name}`);
      });
    }
    (taskIsOutpaint || taskIsWhiteRefine || taskIsRandomBackground ? [] : (task.referenceItems || [])).forEach((item, index) => {
      const file = imageItemUploadFile(item);
      if (file instanceof Blob) form.append("image", file, `ref_${index + 1}_${item.name}`);
    });

    const payload = await generateOutfit(form);
    const finishedAt = Date.now();
    const timingMs = Number.isFinite(payload.timingMs) && payload.timingMs > 0
      ? payload.timingMs
      : Math.max(1, finishedAt - startedAt);
    updateTaskRuntime(task.id, "模型已返回", `接口耗时 ${formatMs(timingMs)}`);
    // 上游 200 但没有图片：明确报"响应缺少图片"，而不是走到后面才炸成未知错误。
    if (!payload?.image) {
      throw Object.assign(
        new Error(formatGenerationError(describeEmptyResult({ requestId: payload?.requestId || payload?.taskId || task.id, status: 200 }))),
        { generationErrorInfo: describeEmptyResult({ requestId: payload?.requestId || payload?.taskId || task.id, status: 200 }) }
      );
    }
    let resultImage = payload.image;
    let displayImage = null;
    if (localEdit) {
      updateTaskRuntime(task.id, "本地贴回合成", "下载模型结果并贴回原图");
      // 贴回底图必须与选框坐标同一张图：选框/裁剪都是按 originalFile（原图）算的。
      // 不能用 imageItemUploadFile()（那是"上传副本优先"，>4MB 的原图会被压到长边 3072）。
      // 用错会在 3072 画布上贴 3500 坐标的选框：输出尺寸掉到 3072、补丁放大并偏移。
      const originalFile = resolveLocalEditBaseFile(task.modelItem);
      if (!originalFile) throw new Error("缺少图1原图，无法把局部结果贴回");
      const generatedBlob = await blobFromOutfitImage(payload.image);
      // 2026-09-25 对齐 3.0：贴回不再做任何后处理（自动对齐 / 颜色匹配 /
      // 中性色调匹配 / 羽化 / 护脸护身）。3.0 localPaste.ts 的契约是"贴回就是贴回"。
      const localCompositeOptions = {};
      const { blob: composedBlob, diagnostics: localEditDiagnostics } = await composeOutfitLocalEditBlob(originalFile, generatedBlob, localEdit.cropRect, localEdit, {
        ...localCompositeOptions,
        returnDiagnostics: true
      });
      localEditDiagnostics.taskBinding = localEditTaskBinding;
      // 尺寸对账单：底图（我给的图）/ 选框 / 上传副本 / 贴回输出。
      // 用户口径是"我给的图多少尺寸，返回的就是多少尺寸"，这里把四个数写进任务日志，
      // 以后出现"尺寸不对/偏移"的争议可以直接拿日志核对，不用靠肉眼判断。
      const localPasteSizes = localPasteSizeReport({
        base: { width: localEditDiagnostics.sourceWidth, height: localEditDiagnostics.sourceHeight },
        rect: localEditDiagnostics.pasteRect,
        output: { width: localEditDiagnostics.sourceWidth, height: localEditDiagnostics.sourceHeight }
      });
      emitClientDiagnosticEvent({
        requestId: task.id,
        stage: "client-generation-local-paste-composed",
        endpoint: "/api/generate-outfit",
        method: "COMPOSE",
        ok: true,
        detail: {
          taskId: task.id,
          baseName: task.modelItem?.name || "",
          localPaste: localPasteSizes
        }
      });
      if (!localPasteSizes.matches) {
        addEvent("贴回尺寸异常", `底图 ${localPasteSizes.base || "?"} → 输出 ${localPasteSizes.output || "?"}`);
      }
      const cachedUrl = URL.createObjectURL(composedBlob);
      const composedFile = fileFromBlob(
        composedBlob,
        `${fileBaseName(task.modelItem?.name || `task_${task.order}`)}_局部贴回`,
        "image/png"
      );
      const localCache = await cacheTaskResultImageFile(composedFile, task.id).catch((error) => {
        addEvent("结果缓存失败", error instanceof Error ? error.message : String(error));
        return null;
      });
      updateTaskRuntime(task.id, "本地贴回完成", `输出 ${fileSize(composedBlob.size || 0)}`);
      resultImage = {
        type: localCache?.localUrl ? "url" : "local_blob",
        value: localCache?.localUrl || cachedUrl,
        localUrl: localCache?.localUrl || "",
        archiveMime: localCache?.mimeType || composedBlob.type || "image/png",
        mimeType: localCache?.mimeType || composedBlob.type || "image/png",
        cachedUrl,
        cachedBlob: composedBlob,
        cachedFile: composedFile,
        localEdit: {
          enabled: true,
          editMode: localEdit.editMode || LOCAL_EDIT_RECT_MODE,
          sourceName: task.modelItem?.name || "",
          cropRect: localEdit.cropRect,
          contextRect: localEdit.contextRect || null,
          sourceWidth: localEdit.sourceWidth,
          sourceHeight: localEdit.sourceHeight,
          maskBounds: localEdit.maskBounds || null,
          diagnostics: localEditDiagnostics
        }
      };
      displayImage = resultImage;
    } else if (taskIsOutpaint && outpaintUploadMeta?.originalRect) {
      updateTaskRuntime(task.id, "本地原图保护", "下载扩图结果并覆盖回图1原有区域");
      const originalFile = imageItemUploadFile(task.modelItem);
      const generatedBlob = await blobFromOutfitImage(payload.image);
      const { blob: outpaintBlob, diagnostics: outpaintDiagnostics } = await composeOutpaintOriginalRegionBlob(
        originalFile,
        generatedBlob,
        outpaintUploadMeta,
        { returnDiagnostics: true }
      );
      const cachedUrl = URL.createObjectURL(outpaintBlob);
      const outpaintFile = fileFromBlob(
        outpaintBlob,
        `${fileBaseName(task.modelItem?.name || `task_${task.order}`)}_扩图原图保护`,
        "image/png"
      );
      const localCache = await cacheTaskResultImageFile(outpaintFile, task.id).catch((error) => {
        addEvent("结果缓存失败", error instanceof Error ? error.message : String(error));
        return null;
      });
      updateTaskRuntime(task.id, "原图保护完成", `输出 ${fileSize(outpaintBlob.size || 0)}`);
      resultImage = {
        type: localCache?.localUrl ? "url" : "local_blob",
        value: localCache?.localUrl || cachedUrl,
        localUrl: localCache?.localUrl || "",
        archiveMime: localCache?.mimeType || outpaintBlob.type || "image/png",
        mimeType: localCache?.mimeType || outpaintBlob.type || "image/png",
        cachedUrl,
        cachedBlob: outpaintBlob,
        cachedFile: outpaintFile,
        outpaint: {
          originalLocked: true,
          sourceName: task.modelItem?.name || "",
          originalRect: outpaintUploadMeta.originalRect,
          blankRect: outpaintUploadMeta.blankRect || null,
          maskRect: outpaintUploadMeta.maskRect || null,
          maskOverlapHeight: outpaintUploadMeta.maskOverlapHeight || 0,
          sourceWidth: outpaintUploadMeta.sourceWidth,
          sourceHeight: outpaintUploadMeta.sourceHeight,
          diagnostics: outpaintDiagnostics
        }
      };
      displayImage = resultImage;
    } else if (task.cropReturn?.cropRect) {
      updateTaskRuntime(task.id, "裁剪回流合成", "回填到原图裁剪坐标");
      const originalFile = imageItemUploadFile(task.modelItem);
      const generatedBlob = await blobFromOutfitImage(payload.image);
      const { blob: cropReturnBlob, diagnostics: cropReturnDiagnostics } = await composeCropReturnBlob(originalFile, generatedBlob, task.cropReturn);
      const dataUrl = await dataUrlFromBlob(cropReturnBlob);
      const cachedUrl = URL.createObjectURL(cropReturnBlob);
      const cropReturnMeta = normalizeCropReturnMeta({
        ...task.cropReturn,
        diagnostics: cropReturnDiagnostics
      });
      resultImage = {
        type: "b64_json",
        value: dataUrl,
        mimeType: "image/jpeg",
        cachedUrl,
        cropReturn: {
          ...cropReturnMeta,
          diagnostics: cropReturnDiagnostics
        }
      };
      displayImage = resultImage;
    } else {
      // 中文注释：普通结果先用接口返回地址显示，二次下载和 IndexedDB 缓存交给后台 effect，减少“生成完成后还要等一下”的体感。
      displayImage = resultImage;
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
        runtimeStage: "完成",
        runtimeDetail: `总耗时 ${formatMs(timingMs)}`,
        runtimeUpdatedAt: finishedAt,
        autoSaveFailed: false,
        qualityCheck: item.qualityCheckEnabled
          ? { ...(item.qualityCheck || {}), status: "checking", summary: "生成完成，AI质检员正在检查" }
          : null,
        finishedAt,
        cropReturn: normalizeCropReturnMeta(task.cropReturn),
        aspectRatio: taskAspectRatio
      };
    }));
    void autoSaveTask({ ...task, result: resultImage, prompt: payload.prompt, cropReturn: normalizeCropReturnMeta(task.cropReturn), aspectRatio: taskAspectRatio }, resultImage);
    if (task.qualityCheckEnabled) {
      void runTaskQualityCheck({ ...task, prompt: payload.prompt, result: resultImage }, modelUploadFile, resultImage, taskAspectRatio, payload.prompt);
    }
  }

  async function startBatch() {
    if (running && !canAppendWhileRunning) return;
    if (!effectiveApiKey) {
      addEvent("缺少 Key", "请先填写 API Key");
      openSettings();
      return;
    }
    if (isRandomBackgroundWorkflow && !String(settings.productNote || "").trim()) {
      addEvent("随机背景", "未填写场景补充，本轮先按干净真实电商实景背景生成；想指定风格时再补场景需求。");
    }
    const taskCount = isDesignDraftWorkflow ? 1 : Math.min(plannedGenerationCount, outfitMaxImages);
    const baseOrder = tasks.length;
    const taskDrafts = buildTasks(taskCount).map((task, index) => ({
      ...task,
      order: baseOrder + index + 1
    }));
    const nextTasks = await Promise.all(taskDrafts.map((task) => attachTaskReferenceThumbs(task).catch(() => task)));
    if ((isOutfitWorkflow || isPoseRemixWorkflow) && referenceImages.some((item) => item.selected) && !mentionsOptionalReferenceImage(settings.prompt, settings.productNote)) {
      addEvent("图3未参与", isPoseRemixWorkflow
        ? "补充提示词未说明图3用途，本轮不上传图3，避免影响图1姿态和图2母版。"
        : "补充提示词未说明图3用途，本轮不上传图3，避免影响图2服装。");
    }
    if (!nextTasks.length) {
      addEvent("无法开始", isDesignDraftWorkflow
        ? "至少上传 1 张图1实拍参考和 1 张图2设计稿参考"
        : isPoseRemixWorkflow
          ? "至少上传 1 张图1姿态参考图和 1 张图2固定母版成片"
            : isRandomBackgroundWorkflow
              ? "至少上传 1 张图1人物图"
              : isBackgroundChangeWorkflow
                ? "至少上传 1 张图1人物图和 1 张图2场景图"
        : isOutpaintWorkflow
          ? "至少上传 1 张图1待扩图原图"
          : isWhiteRefineWorkflow
            ? "至少上传 1 张图1平铺图/挂拍图；图2参考图可选"
          : isRecolorWorkflow
                  ? "至少上传 1 张图1原图和 1 张图2颜色参考图"
                  : isFaceSwapWorkflow
                    ? "至少上传 1 张图1目标人物图和 1 张图2人脸参考图"
                    : isLocalDetailWorkflow
                      ? "至少上传 1 张图1待回贴图和 1 张图2细节结构参考图"
                      : "至少选择 1 张模特图和 1 张服装图");
      return;
    }
    if (isLocalDetailWorkflow && nextTasks.some((task) => !task.localEdit)) {
      addEvent("局部回贴", "请先在图1缩略图下方点“局部回贴”，框选或涂抹要修改的服装细节区域");
      return;
    }
    if (!isDesignDraftWorkflow && nextTasks.length < plannedGenerationCount) {
      addEvent(workflowEventTitle, `按当前配对规则只能创建 ${nextTasks.length}/${plannedGenerationCount} 个任务`);
    }

    const hasLocalEditBatch = nextTasks.some((task) => task.localEdit?.cropFile && task.localEdit?.cropRect);
    const configuredWorkerCount = Math.max(1, Math.min(normalizeBatchConcurrency(settings.concurrency), nextTasks.length));
    const localEditWorkerCount = Math.max(1, Math.min(LOCAL_EDIT_BATCH_CONCURRENCY, configuredWorkerCount, nextTasks.length));
    const runMode = hasLocalEditBatch ? `controlled-${localEditWorkerCount}` : "parallel";
    const runnableTasks = nextTasks.map((task) => ({
      ...task,
      localEditBatchMode: runMode
    }));
    setTasks((current) => [...current, ...runnableTasks]);
    beginGenerationRun();
    addEvent(
      workflowEventTitle,
      `已创建 ${nextTasks.length} 个任务，${isDesignDraftWorkflow ? "设计稿SKILL" : isPoseRemixWorkflow ? "批量姿态常规文本" : isRandomBackgroundWorkflow ? settings.smartIntervention ? "随机背景智能文本" : "随机背景常规文本" : isBackgroundChangeWorkflow ? settings.smartIntervention ? "固定背景智能文本" : "固定背景常规文本" : isOutpaintWorkflow ? "批量扩图常规文本" : isRecolorWorkflow ? "改色常规文本" : isFaceSwapWorkflow ? settings.smartIntervention ? "换脸智能文本" : "换脸常规文本" : isLocalDetailWorkflow ? settings.smartIntervention ? "局部回贴智能文本" : "局部回贴常规文本" : settings.smartIntervention ? "智能介入" : "常规模式"}；并发 ${hasLocalEditBatch ? localEditWorkerCount : configuredWorkerCount}`
    );

    let cursor = 0;
    // 中文注释：所有批量生成都走受控并发，避免几十个请求在同一台电脑上瞬时冲向中转站。
    const workerCount = hasLocalEditBatch ? localEditWorkerCount : configuredWorkerCount;
    async function worker() {
      while (cursor < runnableTasks.length) {
        const index = cursor;
        cursor += 1;
        const task = runnableTasks[index];
        try {
          if (hasLocalEditBatch && index > 0) {
            await delay(Math.min(LOCAL_EDIT_BATCH_REQUEST_GAP_MS * index, LOCAL_EDIT_BATCH_REQUEST_GAP_MS * 4));
          }
          await runSingleTask(task);
        } catch (error) {
          const latestTask = tasksRef.current.find((item) => item.id === task.id);
          const stageDetail = taskRuntimeStageLabel(latestTask);
          const errorDetail = [
            stageDetail ? `失败阶段：${stageDetail}` : "",
            sanitizeErrorText(error?.detail || (error instanceof Error ? error.message : String(error)))
          ].filter(Boolean).join("\n");
          // 传 Error 对象（不是只有 message），这样服务端给的 requestId 能显示出来。
          setTasks((current) => current.map((item) => item.id === task.id ? {
            ...item,
            status: "failed",
            error: summarizeGenerationError(error),
            errorDetail,
            runtimeStage: "失败",
            runtimeDetail: stageDetail || "",
            runtimeUpdatedAt: Date.now(),
            qualityCheck: item.qualityCheckEnabled
              ? { status: "skipped", summary: "生成失败，未质检" }
              : null,
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
    addEvent(workflowEventTitle, "任务队列已完成");
  }

  async function retryTask(task) {
    if (running && !canAppendWhileRunning) return;
    beginGenerationRun();
    try {
      await runSingleTask({ ...task, status: "queued", error: "", result: null });
    } catch (error) {
      const latestTask = tasksRef.current.find((item) => item.id === task.id);
      const stageDetail = taskRuntimeStageLabel(latestTask);
      const errorDetail = [
        stageDetail ? `失败阶段：${stageDetail}` : "",
        sanitizeErrorText(error instanceof Error ? error.message : String(error))
      ].filter(Boolean).join("\n");
      setTasks((current) => current.map((item) => item.id === task.id ? {
        ...item,
        status: "failed",
        error: summarizeGenerationError(error),
        errorDetail,
        runtimeStage: "失败",
        runtimeDetail: stageDetail || "",
        runtimeUpdatedAt: Date.now(),
        qualityCheck: item.qualityCheckEnabled
          ? { status: "skipped", summary: "生成失败，未质检" }
          : null
      } : item));
    } finally {
      endGenerationRun();
    }
  }

  async function rerunResultTask(task) {
    if (!task?.result || task.status !== "success") return;
    if (!canRerunTask(task)) {
      addEvent("重刷", "这张历史结果缺少原始上传图，请重新上传后再生成");
      return;
    }
    const previousTask = task;
    const runnableTask = {
      ...buildRerunReplacementTask(task),
      localEditBatchMode: task.localEdit?.cropFile && task.localEdit?.cropRect ? "rerun-controlled-1" : "rerun"
    };
    setTasks((current) => current.map((item) => item.id === task.id ? runnableTask : item));
    beginGenerationRun();
    addEvent("重刷", `#${task.order || ""} 已开始原位重刷`);
    try {
      await runSingleTask(runnableTask);
      revokeResultImageRuntimeCache(previousTask.result);
      addEvent("重刷完成", `#${task.order || ""} 已用新结果覆盖原图`);
    } catch (error) {
      const latestTask = tasksRef.current.find((item) => item.id === runnableTask.id);
      const stageDetail = taskRuntimeStageLabel(latestTask);
      const errorDetail = [
        stageDetail ? `失败阶段：${stageDetail}` : "",
        sanitizeErrorText(error?.detail || (error instanceof Error ? error.message : String(error)))
      ].filter(Boolean).join("\n");
      setTasks((current) => current.map((item) => item.id === runnableTask.id ? {
        ...previousTask,
        error: "",
        errorDetail: "",
        runtimeStage: "重刷失败",
        runtimeDetail: summarizeGenerationError(error),
        runtimeUpdatedAt: Date.now(),
        rerunCandidate: false
      } : item));
      addEvent("重刷失败", `${summarizeGenerationError(error)}；已保留原结果图`);
    } finally {
      endGenerationRun();
    }
  }

  function handleResultReplaceDragOver(event, targetTask) {
    const sourceId = resultDragTaskId(event);
    const sourceTask = tasksRef.current.find((item) => item.id === sourceId);
    if (!canReplaceTaskResult(sourceTask, targetTask)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    if (resultReplaceTargetId !== targetTask.id) setResultReplaceTargetId(targetTask.id);
  }

  function handleResultReplaceDrop(event, targetTask) {
    const sourceId = resultDragTaskId(event);
    if (!sourceId || sourceId === targetTask?.id) {
      setResultReplaceTargetId("");
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    setResultReplaceTargetId("");
    const sourceTask = tasksRef.current.find((item) => item.id === sourceId);
    const latestTarget = tasksRef.current.find((item) => item.id === targetTask.id);
    if (!canReplaceTaskResult(sourceTask, latestTarget)) return;
    const movedResult = sourceTask.result;
    const targetOldResult = latestTarget.result;
    const nextTarget = {
      ...latestTarget,
      result: movedResult,
      prompt: sourceTask.prompt || latestTarget.prompt,
      timingMs: sourceTask.timingMs ?? latestTarget.timingMs,
      finishedAt: sourceTask.finishedAt || Date.now(),
      aspectRatio: sourceTask.aspectRatio || latestTarget.aspectRatio,
      imageSize: sourceTask.imageSize || latestTarget.imageSize,
      cropReturn: normalizeCropReturnMeta(sourceTask.cropReturn || movedResult?.cropReturn),
      savedFilename: sourceTask.savedFilename || "",
      savedPath: sourceTask.savedPath || "",
      autoSaveFailed: Boolean(sourceTask.autoSaveFailed),
      qualityCheck: sourceTask.qualityCheck || latestTarget.qualityCheck,
      rerunOf: latestTarget.rerunOf || "",
      rerunCandidate: false
    };
    setTasks((current) => {
      return current
        .map((item) => item.id === latestTarget.id ? nextTarget : item)
        .filter((item) => item.id !== sourceTask.id);
    });
    if (targetOldResult && targetOldResult !== movedResult) revokeResultImageRuntimeCache(targetOldResult);
    setSelectedTaskIds((current) => {
      if (!current.has(sourceId)) return current;
      const next = new Set(current);
      next.delete(sourceId);
      return next;
    });
    if (preview?.id === sourceId) setPreview(null);
    if (preview?.id === latestTarget.id) setPreview(nextTarget);
    clearResultDragState();
    addEvent("结果覆盖", `已用 #${sourceTask.order || ""} 覆盖 #${latestTarget.order || ""}，原位置已移除`);
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

  function renderOutfitPageRow({ showPromptButton = true } = {}) {
    return (
      <div className="composerPageRow">
        {showPromptButton && (
          <div className="leftTools">
            <button className="smallButton" type="button" onClick={() => setIsPromptAssistantOpen(true)}>
              <BookOpen size={16} />
              <span>词</span>
            </button>
          </div>
        )}

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
    );
  }

  function renderResultQueue() {
    return (
      <section className="resultPanel queuePanel" id="result-archive-section">
        <div className="taskGrid" ref={taskGridRef} style={{ "--asset-card-min": `${galleryCardMin}px` }}>
          {visibleTasks.map((task, taskIndex) => {
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
              const canRetry = failed && canRerunTask(task);
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
                  {taskRuntimeStageLabel(task) && (
                    <p className="assetError runtimeStage" title={taskRuntimeStageLabel(task)}>
                      {taskRuntimeStageLabel(task)}
                    </p>
                  )}
                  {canRetry && (
                    <button className="assetRetryButton" type="button" onClick={() => retryTask(task)}>
                      重试
                    </button>
                  )}
                  {task.error && <p className="assetError" title={task.errorDetail || task.error}>{task.error}</p>}
                </article>
              );
            }

            const promptText = task.prompt || settings.prompt;
            const src = displayResultImageSource(task.result);
            // P1 缺图自愈：已知失效或加载失败过 → 不再重复请求，直接显示可读原因。
            const cardState = resultImageCardState(task.result, displayResultImageSource);
            // 会话内的失败标记优先，其次用持久化在任务记录里的标记（重载后依然生效）。
            const brokenEntry = brokenTaskImages[task.id] || task.resultMissing;
            const brokenReason = cardState.missing
              ? cardState.reason
              : (brokenEntry && brokenEntry.src === src ? brokenEntry.reason : "");
            const hasCropReturn = taskHasCropReturnResult(task);
            return (
              <article
                className={`assetCard outfitAssetCard success ${selected ? "selected" : ""} ${task.rerunCandidate ? "rerunCandidate" : ""} ${hasCropReturn ? "cropReturnResult" : ""} ${resultReplaceTargetId === task.id ? "replaceTarget" : ""}`}
                key={task.id}
                onClick={() => setPreview(task)}
                onDragOver={(event) => handleResultReplaceDragOver(event, task)}
                onDragLeave={() => setResultReplaceTargetId((current) => current === task.id ? "" : current)}
                onDrop={(event) => handleResultReplaceDrop(event, task)}
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
                <button
                  className="assetRerunButton"
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    void rerunResultTask(task);
                  }}
                  disabled={!canRerunTask(task)}
                  title={canRerunTask(task) ? "重刷这张结果" : "历史结果缺少原始上传图，不能重刷"}
                  aria-label="重刷这张结果"
                >
                  <RefreshCw size={15} />
                </button>
                <button
                  className="assetDeleteButton"
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    deleteResultTask(task.id);
                  }}
                  title="删除这张结果"
                  aria-label="删除这张结果"
                >
                  <Trash2 size={15} />
                </button>
                {task.rerunCandidate && <div className="assetRerunBadge">重刷候选</div>}
                {hasCropReturn && <div className="assetCropReturnBadge">裁剪回流</div>}
                {Number.isFinite(durationMs) && durationMs > 0 && <div className="assetTimeBadge">用时 {formatMs(durationMs)}</div>}
                {task.qualityCheck && (
                  <div
                    className={`qualityBadge ${qualityStatusClass(task.qualityCheck)}`}
                    title={qualityBadgeTitle(task.qualityCheck)}
                  >
                    {qualityStatusLabel(task.qualityCheck)}
                  </div>
                )}
                {brokenReason ? (
                  <div className="assetImageFallback" title={brokenReason}>
                    <ImageOff size={26} />
                    <strong>原图已失效</strong>
                    <span>{brokenReason}</span>
                    <em>可点右上角删除按钮清理这条记录</em>
                  </div>
                ) : (
                  <PreparedResultImage
                    src={src}
                    alt={`AI换装结果 ${task.order || ""}`}
                    decoding="async"
                    loading={taskIndex < 6 ? "eager" : "lazy"}
                    fetchPriority={taskIndex < 4 ? "high" : "low"}
                    draggable
                    onDragStart={(event) => beginTaskImageDrag(event, task, taskIndex)}
                    onDragOver={(event) => handleResultReplaceDragOver(event, task)}
                    onDrop={(event) => handleResultReplaceDrop(event, task)}
                    onDragEnd={clearResultDragState}
                    onError={() => markTaskImageBroken(task)}
                    diagnostic={{ requestId: task.id, endpoint: "/api/generate-outfit", module: "批量生成", workflowMode: task.workflowMode || activeOutfitPage.workflowMode || "", placement: "outfit-card" }}
                  />
                )}
                <ReferenceThumbTray
                  references={references}
                  count={referenceCount}
                  className="assetReferenceTray"
                  onOpen={(reference) => setImageLightbox({ title: reference.name || reference.label || "参考图", src: referenceSource(reference) })}
                  onContextMenu={openReferenceContextMenu}
                  onImageDragStart={beginReferenceImageDrag}
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
              <span>{resultFilter === "video" ? "视频模块暂未接入。" : isPoseRemixWorkflow ? "上传图1姿态参考图和图2固定母版成片后，点击生成。" : isRandomBackgroundWorkflow ? "上传图1人物图，并在场景补充里写大概场景后，点击生成。" : isOutpaintWorkflow ? "上传图1半身照后，点击生成向下扩图。" : isRecolorWorkflow ? "上传图1原图和图2颜色参考图后，点击生成。" : isFaceSwapWorkflow ? "上传图1目标人物图和图2人脸参考图后，点击生成。" : "上传模特图和服装图后，点击生成。"}</span>
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
          <button className={activeView === "resize" ? "active" : ""} type="button" onClick={() => switchView("resize")}><Crop size={18} /> 批量尺寸导出</button>
          <button className={activeView === "reference" ? "active" : ""} type="button" onClick={() => switchView("reference")}><Images size={18} /> 参考生图</button>
          <button className={activeView === "detail" ? "active" : ""} type="button" onClick={() => switchView("detail")}><BookOpen size={18} /> 一键详情/主图</button>
          <button className={activeView === "prompt" ? "active" : ""} type="button" onClick={() => switchView("prompt")}><BookOpen size={18} /> 提示词助手</button>
        </nav>
        <button className="settingsEntry" type="button" onClick={openSettings}>
          <Settings size={18} />
          <span>设置</span>
        </button>
        <div className="statusBox">
          <strong>{completedCount}/{tasks.length || 0}</strong>
          <span>完成任务</span>
          {failedCount > 0 && <em>{failedCount} 个失败</em>}
          {failedCount === 0 && detachedCount > 0 && <em>{detachedCount} 个待确认</em>}
        </div>
      </aside>

      <section className="workspace" ref={workspaceRef} onPaste={activeView === "outfit" ? handleWorkspacePaste : undefined}>
        <section className={`viewPanel ${activeView === "quick" ? "active" : ""}`}>
          <WorkflowQuickVideoPanel
            config={config}
            apiKey={effectiveApiKey}
            onOpenSettings={openSettings}
            onAddEvent={addEvent}
          />
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

        <section className={`viewPanel outfitViewPanel ${activeView === "outfit" ? "active" : ""}`}>
        <header className="topbar">
          <div className="resultTabs">
            <button className={`tabButton ${resultFilter === "all" ? "active" : ""}`} type="button" onClick={() => setResultFilter("all")}>
              全部({tasks.length})
            </button>
            <button className={`tabButton ${resultFilter === "image" ? "active" : ""}`} type="button" onClick={() => setResultFilter("image")}>
              <Images size={14} />
              <span>图片({imageCount})</span>
            </button>
            <button className="tabButton" type="button" onClick={() => { setResultFilter("all"); switchView("quick"); addEvent("视频", "已打开快捷视频生成"); }}>
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

        <div className="outfitScrollArea">
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
            localEditEnabled={!isDesignDraftWorkflow && !isPoseRemixWorkflow && !isOutpaintWorkflow && !isWhiteRefineWorkflow && !isRandomBackgroundWorkflow}
            maxCount={MAX_UPLOAD_IMAGES}
            onLimit={(message) => addEvent("图1上传", message)}
            onActivate={() => setActiveUploadGroup("model")}
            bulkMode={modelBulkMode}
            onBulkModeChange={(mode) => void applyGroupPreprocess("model", mode)}
          />
          {!isOutpaintWorkflow && !isRandomBackgroundWorkflow && <div className="assetSide">
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
              onSetFixed={isWhiteRefineWorkflow ? null : isPoseRemixWorkflow ? settings.pairingMode === "fixed" ? setMasterClothing : null : setMasterClothing}
              fixedId={isWhiteRefineWorkflow || (isPoseRemixWorkflow && settings.pairingMode !== "fixed") ? "" : fixedClothingId}
              fixedTitle={isPoseRemixWorkflow ? "设为固定母版" : isFaceSwapWorkflow ? "设为固定人脸" : isBackgroundChangeWorkflow ? "设为固定场景" : isOutpaintWorkflow ? "设为主扩图参考" : isRecolorWorkflow ? "设为主颜色参考" : "设为固定服装"}
              onPreview={(item) => setImageLightbox({ title: item.name, src: item.previewUrl })}
              onOpenCrop={(item) => setCropTarget({ group: "clothing", item })}
              maxCount={(isOutfitWorkflow || isPoseRemixWorkflow || isFaceSwapWorkflow) ? 2 : MAX_UPLOAD_IMAGES}
              onLimit={(message) => addEvent("图2上传", message)}
              onActivate={() => setActiveUploadGroup("clothing")}
              bulkMode={clothingBulkMode}
              onBulkModeChange={(mode) => void applyGroupPreprocess("clothing", mode)}
              footerControls={usesGarmentScopeControls ? (
                <div className="garmentTransferControls" aria-label={isRecolorWorkflow ? "图2改色范围设置" : "图2服装迁移设置"}>
                  <div className="garmentPartPresetGroup" aria-label={isRecolorWorkflow ? "图2常用改色范围" : "图2常用迁移范围"}>
                    {GARMENT_PART_PRESET_OPTIONS.map((preset) => {
                      const active = sameGarmentParts(selectedGarmentParts, preset.parts)
                        && selectedGarmentComposition === normalizeGarmentComposition(preset.composition, preset.parts);
                      return (
                        <button
                          className={active ? "active" : ""}
                          key={preset.value}
                          type="button"
                          onClick={() => applyGarmentPartPreset(preset)}
                          aria-pressed={active}
                          title={`${isRecolorWorkflow ? "改色范围" : "迁移范围"}：${preset.label}；当前按${garmentCompositionLabel(preset.composition)}理解图2服装结构`}
                        >
                          <Check size={13} />
                          <span>{preset.label}</span>
                        </button>
                      );
                    })}
                  </div>
                  <div className="garmentPartPicker" aria-label={isRecolorWorkflow ? "图2改色部位" : "图2换装部位"}>
                    {GARMENT_PART_OPTIONS.map((part) => {
                      const active = selectedGarmentParts.includes(part.value);
                      return (
                        <button
                          className={active ? "active" : ""}
                          key={part.value}
                          type="button"
                          onClick={() => toggleGarmentPart(part.value)}
                          aria-pressed={active}
                          title={`图2${isRecolorWorkflow ? "改色" : "迁移"}${part.label}`}
                        >
                          <Check size={13} />
                          <span>{part.label}</span>
                        </button>
                      );
                    })}
                  </div>
                  {isOutfitWorkflow && <div className="garmentLengthControls" aria-label="图2服装长度">
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
                  </div>}
                </div>
              ) : null}
              sideControls={isOutfitWorkflow ? (
                <div className={`masterFitControls ${masterFitLockReady ? "ready" : ""}`}>
                  <div className="masterFitHeader">
                    <div>
                      <strong><Lock size={13} /> 母版锁版型</strong>
                      <span>
                        {settings.pairingMode === "fixed"
                          ? masterFitLockReady
                            ? "当前固定图2已锁定，批量任务共用这份版型规格"
                            : "固定图2建议先分析一次，锁定袖口、腰身、裙长和面料细节"
                          : "仅固定服装配对可用"}
                      </span>
                    </div>
                    <button
                      className={`masterFitSwitch ${masterFitLockReady ? "on" : ""}`}
                      type="button"
                      onClick={toggleMasterFitLock}
                      disabled={!selectedFixedClothing || settings.pairingMode !== "fixed" || masterFitAnalyzing}
                      aria-pressed={masterFitLockReady}
                      title={masterFitLockReady ? "关闭母版版型锁定" : "启用母版版型锁定"}
                    >
                      <i aria-hidden="true"><b /></i>
                    </button>
                  </div>
                  <div className="masterFitActions">
                    <button
                      className="smallButton"
                      type="button"
                      onClick={() => void analyzeMasterFit()}
                      disabled={!selectedFixedClothing || settings.pairingMode !== "fixed" || masterFitAnalyzing}
                      title="分析当前固定图2母版"
                    >
                      {masterFitAnalyzing ? <Loader2 className="spin" size={14} /> : <Sparkles size={14} />}
                      <span>{masterFitAnalyzing ? "分析中" : "分析当前图2"}</span>
                    </button>
                    <button
                      className="smallButton"
                      type="button"
                      onClick={openMasterFitPromptModal}
                      title="查看或修改母版提示词"
                    >
                      <Eye size={14} />
                      <span>查看母版提示词</span>
                    </button>
                    <span className="masterFitSource">
                      {selectedFixedClothing ? `母版：${selectedFixedClothing.name}` : "尚未选择固定图2"}
                    </span>
                  </div>
                  <p className="masterFitPromptPreview">
                    {settings.masterFitSpec || "分析后会生成母版版型提示词，也可以点按钮手动填写。"}
                  </p>
                </div>
              ) : null}
            />
            {!isWhiteRefineWorkflow && <UploadZone
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
            />}
          </div>}
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
        </div>

        <section className="composerPanel">
          <div className="composerHeader">
            <div className="composerTabs">
              <button className="active" type="button">图片换装</button>
            </div>
          </div>

          <label className="composerField">
            <span>{promptFieldTitle}</span>
            <DebouncedTextarea
              value={settings.prompt}
              onChange={(value) => updateSetting("prompt", value)}
              onKeyDown={handlePromptKeyDown}
              placeholder={promptFieldPlaceholder}
            />
          </label>

          <label className="composerField composerNote">
            <span>{productNoteFieldTitle}</span>
            <DebouncedTextarea
              value={settings.productNote}
              onChange={(value) => updateSetting("productNote", value)}
              onKeyDown={handlePromptKeyDown}
              placeholder={productNotePlaceholder}
            />
          </label>

          <div className="composerStickyControls">
            <div className="composerFooter">
              {renderOutfitPageRow()}

              <div className="rightTools">
                <select value={settings.model} onChange={(event) => updateSetting("model", event.target.value)}>
                  {models.map((model) => <option key={model.value} value={model.value}>{model.label}</option>)}
                </select>
                {/* 线路选择：请求必须带 canonical channelId；旧线路不会出现在这里，服务端也会拒绝。 */}
                <select
                  value={outfitChannels.some((channel) => channel.id === settings.channelId) ? settings.channelId : (outfitChannels[0]?.id || "")}
                  onChange={(event) => updateSetting("channelId", event.target.value)}
                  title="当前模型的可用线路"
                >
                  {outfitChannels.map((channel) => (
                    <option key={channel.id} value={channel.id}>
                      {channel.label}{Number(channel.price || 0) > 0 ? ` ¥${Number(channel.price).toFixed(2)}/张` : ""}
                    </option>
                  ))}
                </select>
                <select value={settings.aspectRatio} onChange={(event) => updateSetting("aspectRatio", event.target.value)}>
                  {ratios.map((ratio) => <option key={ratio} value={ratio}>{ratio}</option>)}
                </select>
                <select value={settings.imageSize} onChange={(event) => updateSetting("imageSize", event.target.value)}>
                  {outfitSizes.map((size) => <option key={size} value={size}>{size}</option>)}
                </select>
                <select className={globalBulkMode === "mixed" ? "mixed" : ""} value={globalBulkMode} onChange={(event) => void applyGlobalPreprocess(event.target.value)}>
                  <option value="mixed" disabled>混合状态</option>
                  {globalBulkMode === "crop" && <option value="crop" disabled>{preprocessModeLabel("crop")}</option>}
                  {PREPROCESS_OPTIONS.filter((option) => option.value !== "crop").map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
                {isOutpaintWorkflow || isRandomBackgroundWorkflow ? (
                  <select value="fixed" disabled>
                    <option value="fixed">{isRandomBackgroundWorkflow ? "按场景补充生成" : "图1向下扩图"}</option>
                  </select>
                ) : (
                  <select value={settings.pairingMode} onChange={(event) => updateSetting("pairingMode", event.target.value)}>
                    <option value="fixed">{isPoseRemixWorkflow ? "固定母版" : isFaceSwapWorkflow ? "固定人脸" : isBackgroundChangeWorkflow ? "固定场景" : "固定服装"}</option>
                    <option value="sequence">{isPoseRemixWorkflow ? "母版一一对应" : isFaceSwapWorkflow ? "人脸一一对应" : isBackgroundChangeWorkflow ? "人物场景一一对应" : "按顺序一一对应"}</option>
                    <option value="cycle">{isPoseRemixWorkflow ? "母版循环配对" : isFaceSwapWorkflow ? "人脸循环配对" : isBackgroundChangeWorkflow ? "场景循环配对" : "服装循环配对"}</option>
                  </select>
                )}
                {isRandomBackgroundWorkflow && (
                  <select
                    value={normalizeRandomBackgroundFocus(settings.randomBackgroundFocus)}
                    onChange={(event) => updateSetting("randomBackgroundFocus", event.target.value)}
                    title="随机背景视觉重点"
                  >
                    {RANDOM_BACKGROUND_FOCUS_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                )}
                <select value={generationCount} onChange={(event) => updateSetting("generationCount", event.target.value)}>
                  {GENERATION_COUNT_OPTIONS.map((count) => (
                    <option key={count} value={count}>{count === "auto" ? `数量(${plannedGenerationCount})` : `数量 ${count}`}</option>
                  ))}
                </select>
                <button
                  className={`smartInterventionSwitch ${!isPoseRemixWorkflow && !isOutpaintWorkflow && !isRandomBackgroundWorkflow && settings.smartIntervention ? "on" : ""}`}
                  type="button"
                  onClick={() => {
                    if (isPoseRemixWorkflow) {
                      addEvent("批量姿态", "该页按图1姿态和图2母版直接生成，暂不启用锁图1人物的智能文本");
                      return;
                    }
                    if (isOutpaintWorkflow) {
                      addEvent("批量扩图", "该页使用前端扩图画布和独立扩图 SKILL，不启用额外智能文本");
                      return;
                    }
                    if (isRandomBackgroundWorkflow) {
                      addEvent("随机背景", "该页按场景补充和随机背景 SKILL 直接生成，暂不启用额外智能文本");
                      return;
                    }
                    updateSetting("smartIntervention", !settings.smartIntervention);
                  }}
                  aria-pressed={!isPoseRemixWorkflow && !isOutpaintWorkflow && !isRandomBackgroundWorkflow && settings.smartIntervention}
                  title={isPoseRemixWorkflow ? "批量姿态页暂不启用锁图1人物的智能文本" : isOutpaintWorkflow ? "批量扩图页使用固定扩图文本" : isRandomBackgroundWorkflow ? "随机背景页使用场景补充和固定 SKILL" : "切换文本模型介入"}
                >
                  <span>{isPoseRemixWorkflow || isOutpaintWorkflow || isRandomBackgroundWorkflow ? "常规文本" : settings.smartIntervention ? "智能文本" : "常规文本"}</span>
                  <i aria-hidden="true"><b /></i>
                </button>
                <button
                  className={`qualityCheckSwitch ${settings.qualityCheck ? "on" : ""}`}
                  type="button"
                  onClick={() => updateSetting("qualityCheck", !settings.qualityCheck)}
                  aria-pressed={settings.qualityCheck}
                  title="生成完成后调用 AI质检员标记合格/不合格"
                >
                  <span>AI质检</span>
                  <i aria-hidden="true"><b /></i>
                </button>
                <button
                  className={`batchSkillRulesSwitch ${settings.batchSkillRulesEnabled ? "on" : ""}`}
                  type="button"
                  onClick={() => updateSetting("batchSkillRulesEnabled", !settings.batchSkillRulesEnabled)}
                  aria-pressed={settings.batchSkillRulesEnabled}
                  title="批量换装规则（临时开关）：开启时由服务端自动追加批量换装、图1/图2关系、服装类别、成衣比例/长度等规则；关闭时只发送你在提示词框里写的文字，不改模型、渠道、上传图片和其它请求字段。本轮默认关闭，方便先看模型原生效果。"
                >
                  <span>换装规则</span>
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
              <h2>批量尺寸导出</h2>
              <span>独立本地处理栏目，只负责批量缩放、转格式、补边、裁剪和导出。</span>
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

      {masterFitPromptOpen && (
        <div className="modalLayer masterFitPromptLayer" onMouseDown={() => setMasterFitPromptOpen(false)}>
          <section className="masterFitPromptModal" onMouseDown={(event) => event.stopPropagation()}>
            <header>
              <div>
                <h2>母版提示词</h2>
                <span>{selectedFixedClothing ? `当前图2：${selectedFixedClothing.name}` : "尚未选择固定图2"}</span>
              </div>
              <button className="iconButton" type="button" onClick={() => setMasterFitPromptOpen(false)}>
                <X size={18} />
              </button>
            </header>
            <textarea
              value={masterFitPromptDraft}
              onChange={(event) => setMasterFitPromptDraft(event.target.value)}
              placeholder="可手动填写或修改母版版型提示词：袖口落点、袖克夫长度、扣子开合、衣摆扎法、腰身松量、裙长/裤长、面料纹理、穿法边界等。"
              autoFocus
            />
            <footer>
              <span>{masterFitPromptDraft.trim().length}/2600</span>
              <button className="primaryButton" type="button" onClick={applyMasterFitPromptDraft}>
                <Save size={16} />
                <span>修改</span>
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
          ratio={cropTarget.group === "model"
            ? CROP_RETURN_RATIOS.includes(settings.aspectRatio) ? settings.aspectRatio : "3:4"
            : settings.aspectRatio}
          ratioOptions={cropTarget.group === "model" ? CROP_RETURN_RATIOS : null}
          ratioLabel={cropTarget.group === "model" ? "回流比例" : "裁剪比例"}
          processor={processImageFileWithMeta}
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
              <PreparedResultImage
                src={displayResultImageSource(preview.result)}
                alt=""
                draggable
                onDragStart={(event) => beginTaskImageDrag(event, preview)}
                onDragEnd={clearResultDragState}
                style={{ transform: `translate(${previewPan.x}px, ${previewPan.y}px) scale(${previewZoom})` }}
                diagnostic={{ requestId: preview.id, endpoint: "/api/generate-outfit", module: "批量生成", workflowMode: preview.workflowMode || activeOutfitPage.workflowMode || "", placement: "outfit-preview" }}
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
            <LocalPasteDiagnosticsPanel image={preview.result} />
            <CropReturnDiagnosticsPanel image={preview.result} />
            {preview.qualityCheck && (
              <section className={`previewQualityPanel ${qualityStatusClass(preview.qualityCheck)}`}>
                <header>
                  <strong>{qualityStatusLabel(preview.qualityCheck)}</strong>
                  {preview.qualityCheck.checkedAt && <span>{formatClock(preview.qualityCheck.checkedAt)}</span>}
                </header>
                {preview.qualityCheck.summary && <p>{preview.qualityCheck.summary}</p>}
                <div className="previewQualityFacts">
                  {preview.qualityCheck.faceQuality && <span>脸部：{preview.qualityCheck.faceQuality}</span>}
                  {preview.qualityCheck.poseMatch && <span>姿态：{preview.qualityCheck.poseMatch}</span>}
                  {preview.qualityCheck.outfitMatch && <span>服装：{preview.qualityCheck.outfitMatch}</span>}
                </div>
                {preview.qualityCheck.issues?.length > 0 && (
                  <ul>
                    {preview.qualityCheck.issues.map((issue, index) => <li key={`${issue}_${index}`}>{issue}</li>)}
                  </ul>
                )}
                {preview.qualityCheck.repairPrompt && (
                  <button className="previewQualityRepair" type="button" onClick={() => void copyText(preview.qualityCheck.repairPrompt, "返修提示已复制")}>
                    {preview.qualityCheck.repairPrompt}
                  </button>
                )}
              </section>
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
                draggable
                onDragStart={(event) => beginImageDownloadDrag(event, imageLightbox.src, imageLightbox.title || "参考图")}
                style={{ transform: `translate(${previewPan.x}px, ${previewPan.y}px) scale(${previewZoom})` }}
              />
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
