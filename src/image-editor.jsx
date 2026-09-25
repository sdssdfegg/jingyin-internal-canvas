import { useEffect, useMemo, useRef, useState } from "react";
import {
  Download,
  Eraser,
  Eye,
  EyeOff,
  FolderOpen,
  Image as ImageIcon,
  Layers,
  Maximize2,
  MousePointer2,
  RefreshCw,
  RotateCcw,
  Trash2,
  Upload
} from "lucide-react";
import { fileSize } from "./lib/format/index.js";

const EDITOR_DB_NAME = "jingyin-image-editor-v1";
const EDITOR_STORE_NAME = "project";
const EDITOR_PROJECT_KEY = "active";
const EDITOR_MAX_WORK_SIDE = 3000;
const EDITOR_HISTORY_LIMIT = 32;
const EDITOR_BRUSH_DEFAULTS_VERSION = 2;
const DEFAULT_TRANSFORM = { x: 0, y: 0, scale: 1, rotation: 0 };
const DEFAULT_BRUSH = { size: 72, hardness: 0, opacity: 100 };

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function fileBaseName(name) {
  return String(name || "image").replace(/\.[^.]+$/, "") || "image";
}

function isImageFile(file) {
  return file?.type?.startsWith("image/") || /\.(png|jpe?g|webp|gif|bmp)$/i.test(file?.name || "");
}

function canvasToBlob(canvas, type = "image/jpeg", quality = 0.94) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("图片导出失败"));
    }, type, quality);
  });
}

async function imageBitmapFromFile(file) {
  if (window.createImageBitmap) {
    try {
      return await window.createImageBitmap(file, { imageOrientation: "from-image" });
    } catch {
      // Fall back to HTMLImageElement below.
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

async function imageBitmapFromDataUrl(dataUrl) {
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  return imageBitmapFromFile(blob);
}

function openEditorDb() {
  if (!window.indexedDB) return Promise.resolve(null);
  return new Promise((resolve) => {
    const request = window.indexedDB.open(EDITOR_DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(EDITOR_STORE_NAME)) {
        db.createObjectStore(EDITOR_STORE_NAME, { keyPath: "key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
}

async function editorGet(key) {
  const db = await openEditorDb();
  if (!db) return null;
  return new Promise((resolve) => {
    const tx = db.transaction(EDITOR_STORE_NAME, "readonly");
    const req = tx.objectStore(EDITOR_STORE_NAME).get(key);
    req.onsuccess = () => resolve(req.result?.value || null);
    req.onerror = () => resolve(null);
    tx.oncomplete = () => db.close();
    tx.onerror = () => db.close();
  });
}

async function editorSet(key, value) {
  const db = await openEditorDb();
  if (!db) return;
  await new Promise((resolve) => {
    const tx = db.transaction(EDITOR_STORE_NAME, "readwrite");
    tx.objectStore(EDITOR_STORE_NAME).put({ key, value, updatedAt: Date.now() });
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
  db.close();
}

async function editorDelete(key) {
  const db = await openEditorDb();
  if (!db) return;
  await new Promise((resolve) => {
    const tx = db.transaction(EDITOR_STORE_NAME, "readwrite");
    tx.objectStore(EDITOR_STORE_NAME).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
  db.close();
}

function drawTransparentGrid(ctx, width, height) {
  ctx.fillStyle = "#0f1018";
  ctx.fillRect(0, 0, width, height);
  const size = 24;
  ctx.fillStyle = "rgba(255,255,255,0.035)";
  for (let y = 0; y < height; y += size) {
    for (let x = (y / size) % 2 ? 0 : size; x < width; x += size * 2) {
      ctx.fillRect(x, y, size, size);
    }
  }
}

function workSizeForBitmap(bitmap) {
  const width = bitmap.width || bitmap.naturalWidth || 1;
  const height = bitmap.height || bitmap.naturalHeight || 1;
  const scale = Math.min(1, EDITOR_MAX_WORK_SIDE / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    sourceWidth: width,
    sourceHeight: height,
    scale
  };
}

function resetMaskCanvas(maskCanvas, width, height) {
  if (!maskCanvas || !width || !height) return;
  maskCanvas.width = width;
  maskCanvas.height = height;
  const ctx = maskCanvas.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
}

function overlayFitScale(canvasSize, overlayBitmap) {
  const width = overlayBitmap?.width || overlayBitmap?.naturalWidth || 1;
  const height = overlayBitmap?.height || overlayBitmap?.naturalHeight || 1;
  return Math.min(canvasSize.width / width, canvasSize.height / height) || 1;
}

function drawOverlayToContext(ctx, overlayBitmap, canvasSize, transform) {
  if (!overlayBitmap) return;
  const width = overlayBitmap.width || overlayBitmap.naturalWidth || 1;
  const height = overlayBitmap.height || overlayBitmap.naturalHeight || 1;
  const fitScale = overlayFitScale(canvasSize, overlayBitmap);
  const scale = fitScale * clamp(transform.scale || 1, 0.05, 6);
  ctx.save();
  ctx.translate(canvasSize.width / 2 + (Number(transform.x) || 0), canvasSize.height / 2 + (Number(transform.y) || 0));
  ctx.rotate(((Number(transform.rotation) || 0) * Math.PI) / 180);
  ctx.scale(scale, scale);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(overlayBitmap, -width / 2, -height / 2, width, height);
  ctx.restore();
}

function createCompositionCanvas({ baseBitmap, overlayBitmap, maskCanvas, canvasSize, transform, overlayOpacity, differenceMode = false }) {
  const canvas = document.createElement("canvas");
  canvas.width = canvasSize.width;
  canvas.height = canvasSize.height;
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) return canvas;
  drawTransparentGrid(ctx, canvas.width, canvas.height);
  if (baseBitmap) {
    ctx.drawImage(baseBitmap, 0, 0, canvas.width, canvas.height);
  }
  if (overlayBitmap) {
    const overlayCanvas = document.createElement("canvas");
    overlayCanvas.width = canvas.width;
    overlayCanvas.height = canvas.height;
    const overlayCtx = overlayCanvas.getContext("2d");
    if (overlayCtx) {
      overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
      drawOverlayToContext(overlayCtx, overlayBitmap, canvasSize, transform);
      if (maskCanvas) {
        overlayCtx.globalCompositeOperation = "destination-in";
        overlayCtx.drawImage(maskCanvas, 0, 0, canvas.width, canvas.height);
        overlayCtx.globalCompositeOperation = "source-over";
      }
      ctx.save();
      ctx.globalAlpha = clamp(overlayOpacity, 0, 100) / 100;
      if (differenceMode) ctx.globalCompositeOperation = "difference";
      ctx.drawImage(overlayCanvas, 0, 0);
      ctx.restore();
    }
  }
  return canvas;
}

function maskSnapshot(maskCanvas, transform) {
  if (!maskCanvas) return null;
  return {
    maskDataUrl: maskCanvas.toDataURL("image/png"),
    transform: { ...transform }
  };
}

function ImageEditorSlot({ title, file, meta, onPick, onClear, resolveDroppedFiles, onDropFiles }) {
  const inputRef = useRef(null);

  function handleDragOver(event) {
    event.preventDefault();
    event.stopPropagation();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  }

  async function handleDrop(event) {
    event.preventDefault();
    event.stopPropagation();
    const files = resolveDroppedFiles
      ? await resolveDroppedFiles(event.dataTransfer)
      : Array.from(event.dataTransfer?.files || []).filter(isImageFile);
    if (files?.[0]) onDropFiles(files[0]);
  }

  return (
    <section
      className={`imageEditorSlot ${file ? "ready" : ""}`}
      onDragEnter={handleDragOver}
      onDragOver={handleDragOver}
      onDrop={(event) => void handleDrop(event)}
    >
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        onChange={(event) => {
          const nextFile = Array.from(event.target.files || []).find(isImageFile);
          if (nextFile) onPick(nextFile);
          event.target.value = "";
        }}
      />
      <header>
        <strong>{title}</strong>
        {file && <button type="button" onClick={onClear} title="清空"><Trash2 size={13} /></button>}
      </header>
      <button
        className="imageEditorSlotPick"
        type="button"
        onClick={() => inputRef.current?.click()}
        onDragEnter={handleDragOver}
        onDragOver={handleDragOver}
        onDrop={(event) => void handleDrop(event)}
      >
        {file ? <ImageIcon size={20} /> : <Upload size={20} />}
        <span>{file ? file.name : "上传图片"}</span>
        {meta && <small>{meta.width} × {meta.height} · {fileSize(file.size)}</small>}
      </button>
    </section>
  );
}

export default function ImageEditorPanel({
  incomingImage,
  onIncomingHandled,
  resolveDroppedFiles,
  saveDirectory,
  onChooseDirectory,
  onOpenSaveDirectory,
  onSaveMergedImage,
  onAddEvent
}) {
  const canvasRef = useRef(null);
  const stageRef = useRef(null);
  const maskCanvasRef = useRef(document.createElement("canvas"));
  const baseRef = useRef(null);
  const overlayRef = useRef(null);
  const baseFileRef = useRef(null);
  const overlayFileRef = useRef(null);
  const paintRef = useRef(null);
  const spacePressedRef = useRef(false);
  const rafRef = useRef(0);
  const saveTimerRef = useRef(0);
  const undoRef = useRef([]);
  const redoRef = useRef([]);
  const [baseFile, setBaseFile] = useState(null);
  const [overlayFile, setOverlayFile] = useState(null);
  const [baseMeta, setBaseMeta] = useState(null);
  const [overlayMeta, setOverlayMeta] = useState(null);
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });
  const [transform, setTransform] = useState(DEFAULT_TRANSFORM);
  const [overlayOpacity, setOverlayOpacity] = useState(100);
  const [tool, setTool] = useState("erase");
  const [brush, setBrush] = useState(DEFAULT_BRUSH);
  const [zoom, setZoom] = useState(1);
  const [differenceMode, setDifferenceMode] = useState(false);
  const [cursor, setCursor] = useState({ visible: false, x: 0, y: 0, size: 0 });
  const [spacePanReady, setSpacePanReady] = useState(false);
  const [isStagePanning, setIsStagePanning] = useState(false);
  const [undoDepth, setUndoDepth] = useState(0);
  const [redoDepth, setRedoDepth] = useState(0);
  const [status, setStatus] = useState("idle");

  const canEdit = Boolean(baseRef.current && overlayRef.current && canvasSize.width && canvasSize.height);
  const imageSummary = useMemo(() => {
    if (!baseMeta) return "等待底图";
    return overlayMeta ? `${baseMeta.width} × ${baseMeta.height}` : "等待上层图";
  }, [baseMeta, overlayMeta]);

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

  function requestDraw() {
    if (rafRef.current) return;
    rafRef.current = window.requestAnimationFrame(() => {
      rafRef.current = 0;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d", { alpha: false });
      if (!ctx) return;
      if (!canvasSize.width || !canvasSize.height) {
        canvas.width = 1;
        canvas.height = 1;
        ctx.fillStyle = "#11131d";
        ctx.fillRect(0, 0, 1, 1);
        return;
      }
      if (canvas.width !== canvasSize.width) canvas.width = canvasSize.width;
      if (canvas.height !== canvasSize.height) canvas.height = canvasSize.height;
      const composed = createCompositionCanvas({
        baseBitmap: baseRef.current,
        overlayBitmap: overlayRef.current,
        maskCanvas: maskCanvasRef.current,
        canvasSize,
        transform,
        overlayOpacity,
        differenceMode
      });
      ctx.drawImage(composed, 0, 0);
    });
  }

  function currentBrushScreenSize() {
    const canvas = canvasRef.current;
    if (!canvas?.width) return Math.max(8, brush.size);
    const rect = canvas.getBoundingClientRect();
    if (!rect.width) return Math.max(8, brush.size);
    return Math.max(8, brush.size * (rect.width / canvas.width) / zoom);
  }

  function refreshCursorBrushSize() {
    setCursor((current) => (
      current.visible ? { ...current, size: currentBrushScreenSize() } : current
    ));
  }

  function scheduleProjectSave() {
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      const base = baseFileRef.current;
      const overlay = overlayFileRef.current;
      const maskCanvas = maskCanvasRef.current;
      if (!base && !overlay) {
        void editorDelete(EDITOR_PROJECT_KEY);
        return;
      }
      void editorSet(EDITOR_PROJECT_KEY, {
        base,
        overlay,
        baseName: base?.name || "",
        overlayName: overlay?.name || "",
        baseMeta,
        overlayMeta,
        canvasSize,
        transform,
        overlayOpacity,
        tool,
        brush,
        brushDefaultsVersion: EDITOR_BRUSH_DEFAULTS_VERSION,
        zoom,
        differenceMode,
        maskDataUrl: maskCanvas?.width ? maskCanvas.toDataURL("image/png") : "",
        updatedAt: Date.now()
      });
    }, 450);
  }

  function updateUndoDepth() {
    setUndoDepth(undoRef.current.length);
    setRedoDepth(redoRef.current.length);
  }

  function pushUndo() {
    const snapshot = maskSnapshot(maskCanvasRef.current, transform);
    if (!snapshot) return;
    undoRef.current = [...undoRef.current.slice(-(EDITOR_HISTORY_LIMIT - 1)), snapshot];
    redoRef.current = [];
    updateUndoDepth();
  }

  async function restoreSnapshot(snapshot) {
    if (!snapshot) return;
    setTransform(snapshot.transform || DEFAULT_TRANSFORM);
    const maskCanvas = maskCanvasRef.current;
    if (snapshot.maskDataUrl && maskCanvas && canvasSize.width && canvasSize.height) {
      const maskImage = await imageBitmapFromDataUrl(snapshot.maskDataUrl);
      const ctx = maskCanvas.getContext("2d");
      maskCanvas.width = canvasSize.width;
      maskCanvas.height = canvasSize.height;
      ctx?.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
      ctx?.drawImage(maskImage, 0, 0, maskCanvas.width, maskCanvas.height);
      maskImage.close?.();
    }
    requestDraw();
    scheduleProjectSave();
  }

  function undo() {
    const previous = undoRef.current.pop();
    if (!previous) return;
    const current = maskSnapshot(maskCanvasRef.current, transform);
    if (current) redoRef.current.push(current);
    updateUndoDepth();
    void restoreSnapshot(previous);
  }

  function redo() {
    const next = redoRef.current.pop();
    if (!next) return;
    const current = maskSnapshot(maskCanvasRef.current, transform);
    if (current) undoRef.current.push(current);
    updateUndoDepth();
    void restoreSnapshot(next);
  }

  async function loadBaseFile(file, options = {}) {
    if (!isImageFile(file)) return;
    setStatus("loading");
    try {
      const bitmap = await imageBitmapFromFile(file);
      baseRef.current?.close?.();
      baseRef.current = bitmap;
      baseFileRef.current = file;
      const size = workSizeForBitmap(bitmap);
      setCanvasSize({ width: size.width, height: size.height });
      setBaseMeta({ width: size.width, height: size.height, sourceWidth: size.sourceWidth, sourceHeight: size.sourceHeight });
      setBaseFile(file);
      if (!options.keepOverlay) {
        resetMaskCanvas(maskCanvasRef.current, size.width, size.height);
        setTransform(DEFAULT_TRANSFORM);
        undoRef.current = [];
        redoRef.current = [];
        updateUndoDepth();
      } else if (maskCanvasRef.current.width !== size.width || maskCanvasRef.current.height !== size.height) {
        resetMaskCanvas(maskCanvasRef.current, size.width, size.height);
      }
      setStatus("ready");
      requestDraw();
      scheduleProjectSave();
      onAddEvent?.("图片编辑", "底图已载入");
    } catch (error) {
      setStatus("failed");
      onAddEvent?.("图片编辑失败", error instanceof Error ? error.message : String(error));
    }
  }

  async function loadOverlayFile(file, options = {}) {
    if (!isImageFile(file)) return;
    setStatus("loading");
    try {
      const bitmap = await imageBitmapFromFile(file);
      overlayRef.current?.close?.();
      overlayRef.current = bitmap;
      overlayFileRef.current = file;
      setOverlayMeta({ width: bitmap.width || bitmap.naturalWidth || 1, height: bitmap.height || bitmap.naturalHeight || 1 });
      setOverlayFile(file);
      if (!options.keepMask && canvasSize.width && canvasSize.height) {
        resetMaskCanvas(maskCanvasRef.current, canvasSize.width, canvasSize.height);
      }
      if (!options.keepTransform) setTransform(DEFAULT_TRANSFORM);
      undoRef.current = [];
      redoRef.current = [];
      updateUndoDepth();
      setStatus("ready");
      requestDraw();
      scheduleProjectSave();
      onAddEvent?.("图片编辑", "上层图已载入");
    } catch (error) {
      setStatus("failed");
      onAddEvent?.("图片编辑失败", error instanceof Error ? error.message : String(error));
    }
  }

  async function hydrateProject() {
    const project = await editorGet(EDITOR_PROJECT_KEY);
    if (!project) {
      requestDraw();
      return;
    }
    try {
      if (project.base) {
        const base = new File([project.base], project.baseName || "base.png", { type: project.base.type || "image/png" });
        const baseBitmap = await imageBitmapFromFile(base);
        baseRef.current = baseBitmap;
        baseFileRef.current = base;
        setBaseFile(base);
        const size = project.canvasSize?.width && project.canvasSize?.height
          ? project.canvasSize
          : workSizeForBitmap(baseBitmap);
        setCanvasSize({ width: size.width, height: size.height });
        setBaseMeta(project.baseMeta || { width: size.width, height: size.height });
        resetMaskCanvas(maskCanvasRef.current, size.width, size.height);
      }
      if (project.overlay) {
        const overlay = new File([project.overlay], project.overlayName || "overlay.png", { type: project.overlay.type || "image/png" });
        const overlayBitmap = await imageBitmapFromFile(overlay);
        overlayRef.current = overlayBitmap;
        overlayFileRef.current = overlay;
        setOverlayFile(overlay);
        setOverlayMeta(project.overlayMeta || { width: overlayBitmap.width || 1, height: overlayBitmap.height || 1 });
      }
      if (project.maskDataUrl && maskCanvasRef.current.width) {
        const maskImage = await imageBitmapFromDataUrl(project.maskDataUrl);
        const ctx = maskCanvasRef.current.getContext("2d");
        ctx?.clearRect(0, 0, maskCanvasRef.current.width, maskCanvasRef.current.height);
        ctx?.drawImage(maskImage, 0, 0, maskCanvasRef.current.width, maskCanvasRef.current.height);
        maskImage.close?.();
      }
      setTransform(project.transform || DEFAULT_TRANSFORM);
      setOverlayOpacity(clamp(project.overlayOpacity ?? 100, 0, 100));
      setTool(project.tool === "restore" ? "restore" : "erase");
      const shouldResetOldBrushHardness = project.brushDefaultsVersion !== EDITOR_BRUSH_DEFAULTS_VERSION;
      setBrush({
        size: clamp(project.brush?.size ?? DEFAULT_BRUSH.size, 2, 360),
        hardness: shouldResetOldBrushHardness ? DEFAULT_BRUSH.hardness : clamp(project.brush?.hardness ?? DEFAULT_BRUSH.hardness, 0, 100),
        opacity: clamp(project.brush?.opacity ?? DEFAULT_BRUSH.opacity, 1, 100)
      });
      setZoom(clamp(project.zoom ?? 1, 0.25, 3));
      setDifferenceMode(Boolean(project.differenceMode));
      setStatus("ready");
      window.requestAnimationFrame(requestDraw);
    } catch (error) {
      setStatus("failed");
      onAddEvent?.("图片编辑恢复失败", error instanceof Error ? error.message : String(error));
    }
  }

  useEffect(() => {
    void hydrateProject();
    return () => {
      if (rafRef.current) window.cancelAnimationFrame(rafRef.current);
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
      baseRef.current?.close?.();
      overlayRef.current?.close?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!incomingImage?.file) return;
    const file = incomingImage.file;
    if (incomingImage.slot === "overlay") {
      void loadOverlayFile(file);
    } else {
      void loadBaseFile(file, { keepOverlay: true });
    }
    onIncomingHandled?.(incomingImage.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incomingImage?.id]);

  useEffect(() => {
    requestDraw();
    scheduleProjectSave();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvasSize.width, canvasSize.height, transform, overlayOpacity, differenceMode, tool, brush.size, brush.hardness, brush.opacity]);

  useEffect(() => {
    refreshCursorBrushSize();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [brush.size, zoom, canvasSize.width, canvasSize.height]);

  useEffect(() => {
    function handleKeyDown(event) {
      if (event.target?.closest?.("input,textarea,select")) return;
      const key = event.key.toLowerCase();
      if (event.code === "Space") {
        event.preventDefault();
        spacePressedRef.current = true;
        setSpacePanReady(true);
        setCursor((current) => ({ ...current, visible: false }));
        return;
      }
      if ((event.ctrlKey || event.metaKey) && key === "z") {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && key === "y") {
        event.preventDefault();
        redo();
        return;
      }
      if (event.key === "[") {
        event.preventDefault();
        if (event.shiftKey) {
          setBrush((current) => ({ ...current, hardness: clamp(current.hardness - 10, 0, 100) }));
        } else {
          setBrush((current) => ({ ...current, size: clamp(current.size - 8, 2, 360) }));
        }
        return;
      }
      if (event.key === "]") {
        event.preventDefault();
        if (event.shiftKey) {
          setBrush((current) => ({ ...current, hardness: clamp(current.hardness + 10, 0, 100) }));
        } else {
          setBrush((current) => ({ ...current, size: clamp(current.size + 8, 2, 360) }));
        }
        return;
      }
      if (key === "x") {
        event.preventDefault();
        setTool((current) => current === "erase" ? "restore" : "erase");
        return;
      }
      if (key === "b") {
        event.preventDefault();
        setTool("restore");
        return;
      }
      if (key === "e") {
        event.preventDefault();
        setTool("erase");
      }
    }

    function releaseSpacePan() {
      spacePressedRef.current = false;
      setSpacePanReady(false);
      setIsStagePanning(false);
      if (paintRef.current?.type === "stage-pan") paintRef.current.cancelled = true;
    }

    function handleKeyUp(event) {
      if (event.code === "Space") {
        event.preventDefault();
        releaseSpacePan();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", releaseSpacePan);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", releaseSpacePan);
    };
  }, [transform, canvasSize.width, canvasSize.height]);

  function pointerToCanvas(event) {
    const canvas = canvasRef.current;
    if (!canvas || !canvasSize.width || !canvasSize.height) return null;
    const rect = canvas.getBoundingClientRect();
    return {
      x: clamp((event.clientX - rect.left) * (canvas.width / rect.width), 0, canvas.width),
      y: clamp((event.clientY - rect.top) * (canvas.height / rect.height), 0, canvas.height),
      screenX: (event.clientX - rect.left) / zoom,
      screenY: (event.clientY - rect.top) / zoom,
      screenSize: brush.size * (rect.width / canvas.width) / zoom
    };
  }

  function handleStageWheel(event) {
    if (!canvasSize.width || !canvasSize.height) return;
    event.preventDefault();
    const step = event.deltaY > 0 ? -0.1 : 0.1;
    setZoom((current) => clamp(Number((current + step).toFixed(2)), 0.25, 3));
  }

  function stampBrush(point) {
    const maskCanvas = maskCanvasRef.current;
    const ctx = maskCanvas?.getContext("2d");
    if (!ctx || !point) return;
    const radius = brush.size / 2;
    const hardness = clamp(brush.hardness, 0, 100) / 100;
    const inner = Math.max(0, Math.min(radius - 0.01, radius * Math.pow(hardness, 1.75) * 0.9));
    const softStop = Math.max(inner / radius, 0.58 + hardness * 0.18);
    const alpha = brush.opacity / 100;
    const gradient = ctx.createRadialGradient(point.x, point.y, Math.max(0, inner), point.x, point.y, radius);
    if (tool === "erase") {
      ctx.globalCompositeOperation = "destination-out";
      gradient.addColorStop(0, `rgba(0,0,0,${alpha})`);
      gradient.addColorStop(Math.min(0.92, softStop), `rgba(0,0,0,${alpha * (0.34 + hardness * 0.42)})`);
      gradient.addColorStop(1, "rgba(0,0,0,0)");
    } else {
      ctx.globalCompositeOperation = "source-over";
      gradient.addColorStop(0, `rgba(255,255,255,${alpha})`);
      gradient.addColorStop(Math.min(0.92, softStop), `rgba(255,255,255,${alpha * (0.34 + hardness * 0.42)})`);
      gradient.addColorStop(1, "rgba(255,255,255,0)");
    }
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalCompositeOperation = "source-over";
  }

  function paintLine(from, to) {
    if (!from || !to) {
      stampBrush(to || from);
      return;
    }
    const distance = Math.hypot(to.x - from.x, to.y - from.y);
    const step = Math.max(1, brush.size / 6);
    const count = Math.max(1, Math.ceil(distance / step));
    for (let index = 0; index <= count; index += 1) {
      const t = index / count;
      stampBrush({
        x: from.x + (to.x - from.x) * t,
        y: from.y + (to.y - from.y) * t
      });
    }
  }

  function handlePointerDown(event) {
    if (!canEdit && !(spacePressedRef.current && canvasSize.width && canvasSize.height)) return;
    event.preventDefault();
    if (event.button === 0 && spacePressedRef.current && stageRef.current) {
      paintRef.current = {
        type: "stage-pan",
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        scrollLeft: stageRef.current.scrollLeft,
        scrollTop: stageRef.current.scrollTop
      };
      setCursor((current) => ({ ...current, visible: false }));
      setIsStagePanning(true);
      event.currentTarget.setPointerCapture?.(event.pointerId);
      return;
    }
    if (!canEdit) return;
    if (event.button === 2) {
      paintRef.current = {
        type: "brush-size",
        pointerId: event.pointerId,
        startX: event.clientX,
        startSize: brush.size
      };
      event.currentTarget.setPointerCapture?.(event.pointerId);
      return;
    }
    if (event.button !== 0) return;
    const point = pointerToCanvas(event);
    if (!point) return;
    pushUndo();
    paintRef.current = { type: "paint", pointerId: event.pointerId, last: point };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    stampBrush(point);
    requestDraw();
  }

  function handlePointerMove(event) {
    const action = paintRef.current;
    if (action?.type === "stage-pan") {
      event.preventDefault();
      if (!action.cancelled && stageRef.current) {
        stageRef.current.scrollLeft = action.scrollLeft - (event.clientX - action.startX);
        stageRef.current.scrollTop = action.scrollTop - (event.clientY - action.startY);
      }
      return;
    }
    const point = pointerToCanvas(event);
    if (point && !spacePressedRef.current && !isStagePanning) {
      setCursor({ visible: true, x: point.screenX, y: point.screenY, size: Math.max(8, point.screenSize) });
    }
    if (!action) return;
    event.preventDefault();
    if (action.type === "brush-size") {
      const next = clamp(action.startSize + (event.clientX - action.startX), 2, 360);
      setBrush((current) => ({ ...current, size: Math.round(next) }));
      return;
    }
    if (action.type === "paint" && point) {
      paintLine(action.last, point);
      action.last = point;
      requestDraw();
    }
  }

  function handlePointerUp(event) {
    const action = paintRef.current;
    if (!action) return;
    event.currentTarget.releasePointerCapture?.(action.pointerId);
    paintRef.current = null;
    if (action.type === "stage-pan") {
      setIsStagePanning(false);
      return;
    }
    scheduleProjectSave();
  }

  function resetOverlay() {
    pushUndo();
    setTransform(DEFAULT_TRANSFORM);
    setOverlayOpacity(100);
  }

  function resetMask() {
    if (!canvasSize.width || !canvasSize.height) return;
    pushUndo();
    resetMaskCanvas(maskCanvasRef.current, canvasSize.width, canvasSize.height);
    requestDraw();
    scheduleProjectSave();
  }

  async function clearProject() {
    baseRef.current?.close?.();
    overlayRef.current?.close?.();
    baseRef.current = null;
    overlayRef.current = null;
    baseFileRef.current = null;
    overlayFileRef.current = null;
    setBaseFile(null);
    setOverlayFile(null);
    setBaseMeta(null);
    setOverlayMeta(null);
    setCanvasSize({ width: 0, height: 0 });
    setTransform(DEFAULT_TRANSFORM);
    setOverlayOpacity(100);
    setBrush(DEFAULT_BRUSH);
    setZoom(1);
    setDifferenceMode(false);
    resetMaskCanvas(maskCanvasRef.current, 1, 1);
    undoRef.current = [];
    redoRef.current = [];
    updateUndoDepth();
    await editorDelete(EDITOR_PROJECT_KEY);
    requestDraw();
    onAddEvent?.("图片编辑", "工程已清空");
  }

  async function exportMerged() {
    if (!baseRef.current) {
      onAddEvent?.("图片编辑", "请先放入底图");
      return;
    }
    try {
      setStatus("exporting");
      const canvas = createCompositionCanvas({
        baseBitmap: baseRef.current,
        overlayBitmap: overlayRef.current,
        maskCanvas: maskCanvasRef.current,
        canvasSize,
        transform,
        overlayOpacity: 100,
        differenceMode: false
      });
      const blob = await canvasToBlob(canvas, "image/jpeg", 0.94);
      const file = new File([blob], `${fileBaseName(baseFile?.name || "image")}_图片编辑.jpg`, {
        type: "image/jpeg",
        lastModified: Date.now()
      });
      const payload = await onSaveMergedImage?.(file, "");
      setStatus("ready");
      onAddEvent?.("图片编辑导出", payload?.filename ? `已导出 ${payload.filename}` : "已导出到指定目录");
    } catch (error) {
      setStatus("failed");
      onAddEvent?.("图片编辑导出失败", error instanceof Error ? error.message : String(error));
    }
  }

  const slotProps = { resolveDroppedFiles };

  return (
    <section className="imageEditorWorkbench">
      <aside className="imageEditorPanel">
        <div className="imageEditorPanelScroll">
          <header className="imageEditorSectionTitle">
            <Layers size={17} />
            <div>
              <strong>图层</strong>
              <span>{imageSummary}</span>
            </div>
          </header>
          <ImageEditorSlot
            {...slotProps}
            title="上层图"
            file={overlayFile}
            meta={overlayMeta}
            onPick={(file) => void loadOverlayFile(file)}
            onDropFiles={(file) => void loadOverlayFile(file)}
            onClear={() => {
              overlayRef.current?.close?.();
              overlayRef.current = null;
              overlayFileRef.current = null;
              setOverlayFile(null);
              setOverlayMeta(null);
              requestDraw();
              scheduleProjectSave();
            }}
          />
          <ImageEditorSlot
            {...slotProps}
            title="底图"
            file={baseFile}
            meta={baseMeta}
            onPick={(file) => void loadBaseFile(file, { keepOverlay: true })}
            onDropFiles={(file) => void loadBaseFile(file, { keepOverlay: true })}
            onClear={() => void clearProject()}
          />

          <section className="imageEditorToolGroup">
            <h3>蒙版</h3>
            <div className="imageEditorSegment">
              <button className={tool === "erase" ? "active" : ""} type="button" onClick={() => setTool("erase")} title="黑色画笔：隐藏上层">
                <span className="maskSwatch black" />
                <span>擦除</span>
              </button>
              <button className={tool === "restore" ? "active" : ""} type="button" onClick={() => setTool("restore")} title="白色画笔：恢复上层">
                <span className="maskSwatch white" />
                <span>恢复</span>
              </button>
            </div>
            <label>
              <span>大小</span>
              <input type="range" min="2" max="360" value={brush.size} onChange={(event) => setBrush((current) => ({ ...current, size: clamp(event.target.value, 2, 360) }))} />
              <em>{Math.round(brush.size)}</em>
            </label>
            <label>
              <span>硬度</span>
              <input type="range" min="0" max="100" value={brush.hardness} onChange={(event) => setBrush((current) => ({ ...current, hardness: clamp(event.target.value, 0, 100) }))} />
              <em>{Math.round(brush.hardness)}%</em>
            </label>
            <label>
              <span>透明</span>
              <input type="range" min="1" max="100" value={brush.opacity} onChange={(event) => setBrush((current) => ({ ...current, opacity: clamp(event.target.value, 1, 100) }))} />
              <em>{Math.round(brush.opacity)}%</em>
            </label>
            <div className="imageEditorActionRow">
              <button className="smallButton" type="button" onClick={undo} disabled={undoDepth === 0} title="撤销">
                <RotateCcw size={14} />
                <span>撤销</span>
              </button>
              <button className="smallButton" type="button" onClick={redo} disabled={redoDepth === 0} title="重做">
                <RefreshCw size={14} />
                <span>重做</span>
              </button>
              <button className="smallButton" type="button" onClick={resetMask} disabled={!canEdit} title="重置蒙版">
                <Eraser size={14} />
                <span>重置</span>
              </button>
            </div>
          </section>

          <section className="imageEditorToolGroup">
            <h3>上层</h3>
            <label>
              <span>不透明</span>
              <input type="range" min="0" max="100" value={overlayOpacity} onChange={(event) => setOverlayOpacity(clamp(event.target.value, 0, 100))} />
              <em>{Math.round(overlayOpacity)}%</em>
            </label>
            <label>
              <span>X</span>
              <input type="range" min="-900" max="900" value={transform.x} onChange={(event) => setTransform((current) => ({ ...current, x: clamp(event.target.value, -900, 900) }))} />
              <em>{Math.round(transform.x)}</em>
            </label>
            <label>
              <span>Y</span>
              <input type="range" min="-900" max="900" value={transform.y} onChange={(event) => setTransform((current) => ({ ...current, y: clamp(event.target.value, -900, 900) }))} />
              <em>{Math.round(transform.y)}</em>
            </label>
            <label>
              <span>缩放</span>
              <input type="range" min="25" max="240" value={Math.round(transform.scale * 100)} onChange={(event) => setTransform((current) => ({ ...current, scale: clamp(event.target.value, 25, 240) / 100 }))} />
              <em>{Math.round(transform.scale * 100)}%</em>
            </label>
            <label>
              <span>旋转</span>
              <input type="range" min="-12" max="12" value={transform.rotation} onChange={(event) => setTransform((current) => ({ ...current, rotation: clamp(event.target.value, -12, 12) }))} />
              <em>{Number(transform.rotation).toFixed(1)}°</em>
            </label>
            <div className="imageEditorActionRow">
              <button className="smallButton" type="button" onClick={resetOverlay} disabled={!overlayFile} title="上层居中">
                <Maximize2 size={14} />
                <span>居中</span>
              </button>
              <button className={`smallButton ${differenceMode ? "active" : ""}`} type="button" onClick={() => setDifferenceMode((value) => !value)} disabled={!canEdit} title="差异查看">
                {differenceMode ? <Eye size={14} /> : <EyeOff size={14} />}
                <span>差异</span>
              </button>
            </div>
          </section>
        </div>

        <footer className="imageEditorFooter">
          <button className="smallButton" type="button" onClick={onChooseDirectory}>
            <FolderOpen size={15} />
            <span>指定文件夹</span>
          </button>
          <button className="smallButton" type="button" onClick={onOpenSaveDirectory}>
            <FolderOpen size={15} />
            <span>打开目录</span>
          </button>
          <button className="generateButton" type="button" onClick={() => void exportMerged()} disabled={!baseFile || status === "exporting"}>
            {status === "exporting" ? <RefreshCw className="spin" size={16} /> : <Download size={16} />}
            <span>合并导出</span>
          </button>
        </footer>
      </aside>

      <section className="imageEditorStageWrap">
        <div className="imageEditorTopHint">
          <div>
            <MousePointer2 size={15} />
            <span>{saveDirectory ? `导出目录：${saveDirectory}` : "尚未指定保存目录"}</span>
          </div>
          <div className="imageEditorZoom">
            <button type="button" onClick={() => setZoom((value) => clamp(value - 0.1, 0.25, 3))}>-</button>
            <input type="range" min="25" max="300" value={Math.round(zoom * 100)} onChange={(event) => setZoom(clamp(event.target.value, 25, 300) / 100)} />
            <button type="button" onClick={() => setZoom((value) => clamp(value + 0.1, 0.25, 3))}>+</button>
            <strong>{Math.round(zoom * 100)}%</strong>
          </div>
        </div>
        <div
          ref={stageRef}
          className={`imageEditorStage ${spacePanReady ? "spacePanReady" : ""} ${isStagePanning ? "panning" : ""}`}
          onWheel={handleStageWheel}
        >
          <div className="imageEditorCanvasShell" style={{ transform: `scale(${zoom})` }}>
            <canvas
              ref={canvasRef}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerUp}
              onPointerLeave={() => setCursor((current) => ({ ...current, visible: false }))}
              onContextMenu={(event) => event.preventDefault()}
            />
            {cursor.visible && canEdit && !spacePanReady && !isStagePanning && (
              <span
                className={`imageEditorBrushCursor ${tool}`}
                style={{
                  left: cursor.x,
                  top: cursor.y,
                  width: cursor.size,
                  height: cursor.size
                }}
              />
            )}
          </div>
          {!baseFile && (
            <div className="imageEditorEmpty">
              <Layers size={36} />
              <span>放入底图和上层图</span>
            </div>
          )}
          {baseFile && !overlayFile && (
            <div className="imageEditorEmpty small">
              <ImageIcon size={28} />
              <span>继续放入上层图</span>
            </div>
          )}
        </div>
      </section>
    </section>
  );
}
