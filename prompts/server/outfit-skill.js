export function primaryOutfitGenerationError(errors) {
  const list = Array.isArray(errors) ? errors.filter(Boolean) : [];
  const nonAuthError = list.find((error) => !/HTTP\s*401|invalid token|unauthorized|api key/i.test(error));
  return nonAuthError || list[list.length - 1] || list[0] || "换装生成失败";
}

export function isBananaOutfitModel(model) {
  return /^nano-banana/i.test(String(model || ""));
}

const GARMENT_PART_OPTIONS = [
  { value: "upper", label: "上装/外套/内搭" },
  { value: "lower", label: "下装" },
  { value: "shoes", label: "鞋子" }
];
const DEFAULT_GARMENT_PARTS = ["upper"];
const GARMENT_LENGTH_OPTIONS = [
  { value: "", label: "" },
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

function normalizeGarmentParts(value) {
  const raw = Array.isArray(value) ? value : String(value || "").split(/[,\s|，、]+/);
  const next = GARMENT_PART_OPTIONS
    .map((option) => option.value)
    .filter((part) => raw.includes(part));
  return next.length > 0 ? next : DEFAULT_GARMENT_PARTS;
}

function garmentPartLabel(part) {
  return GARMENT_PART_OPTIONS.find((option) => option.value === part)?.label || part;
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

function garmentLengthLabel(value) {
  return GARMENT_LENGTH_OPTIONS.find((option) => option.value === value)?.label || "";
}

function buildGarmentLengthSkill(parts, lengths) {
  const selected = normalizeGarmentParts(parts);
  const normalized = normalizeGarmentLengths(lengths, selected);
  const lines = [];
  const addLine = (key, label) => {
    const value = normalized[key];
    if (!value) return;
    if (value === "reference") {
      lines.push(`${label}长度按图2原服装在人体上的相对落点迁移，不按模型审美改短或加长。`);
      return;
    }
    lines.push(`${label}下摆/落点控制为${garmentLengthLabel(value)}，按图1人体比例落到对应位置。`);
  };
  addLine("upper", "上装");
  addLine("lower", "下装");
  if (["ankle", "floor"].includes(normalized.upper) || ["ankle", "floor"].includes(normalized.lower)) {
    lines.push("到脚踝或拖地时，长裙、礼服、长外套的下摆可以自然遮住鞋靴；鞋靴只露出真实可见部分，不要为了展示完整鞋靴而抬高下摆、开叉或缩短衣长。");
  }
  return lines;
}

// 中文注释：规范化前端保存的母版规格，限制长度并保持换行，避免用户输入无限膨胀提示词。
function normalizeMasterFitSpec(value) {
  return String(value || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim()
    .slice(0, 2600);
}

function garmentScope(parts) {
  const selected = normalizeGarmentParts(parts);
  return {
    selected,
    upper: selected.includes("upper"),
    lower: selected.includes("lower"),
    shoes: selected.includes("shoes"),
    labels: selected.map(garmentPartLabel).join("、")
  };
}

function recolorScopeLockRules(scope) {
  const lines = [
    "改色前先按图1真实服装边界建立颜色蒙版：只在选中的服装实际像素内换色；边界、遮挡、缝线、褶皱、阴影、透明薄纱和五金周围必须沿用图1。"
  ];
  if (scope.lower && !scope.upper && !scope.shoes) {
    lines.push(
      "当前只选择下装：只允许改变图1真实裤子/裙子/短裤/半裙/长裙等下装区域的颜色；上衣、外套、内搭、鞋子、包、配饰、皮肤、腿部、头发、背景和道具全部保持图1原样。",
      "下装结构硬锁：裤型或裙型、腰头高度、裤腰/裙腰、裤脚/裙摆、开叉、褶裥、口袋、纽扣、拉链、腰带、压线、刺绣、印花、水洗、磨白、破洞、面料纹理、原有褶皱走向和垂感都必须保留图1，不得重绘或替换。",
      "图2只提供下装目标颜色和材质色感；如果图2里出现不同裤型、裙型、衣摆、模特姿势或其它服装细节，一律不能迁移到图1。"
    );
    return lines;
  }
  if (scope.upper && !scope.lower && !scope.shoes) {
    lines.push(
      "当前只选择上装/外套/内搭：只允许改变图1真实上装区域的颜色；下装、鞋子、皮肤、头发、背景和配饰保持图1原样。",
      "上装结构硬锁：领口、肩线、袖型、袖口、门襟、扣子、拉链、衣摆、口袋、刺绣、印花、压线、面料纹理、褶皱和穿法都保留图1，不得按图2重绘。"
    );
    return lines;
  }
  if (scope.shoes && !scope.upper && !scope.lower) {
    lines.push(
      "当前只选择鞋子：只允许改变图1真实鞋靴区域的颜色；服装、皮肤、背景和地面保持图1原样。",
      "鞋靴结构硬锁：鞋型、鞋底厚度、鞋带、扣件、材质纹理、磨损、阴影和脚底接触关系都保留图1，不得按图2重绘。"
    );
    return lines;
  }
  lines.push(
    "多部位同时改色时，每个部位仍按图1真实边界分别换色；不能因为多个部位同时选中就重绘整套服装、改版型或统一涂成平面色块。"
  );
  return lines;
}

function removeClauses(text, pattern) {
  return String(text || "")
    .split(/[；;。\n]/)
    .map((part) => part.trim())
    .filter((part) => part && !pattern.test(part))
    .join("；");
}

function scopeMasterFitSpec(spec, parts) {
  const source = normalizeMasterFitSpec(spec);
  if (!source) return "";
  const scope = garmentScope(parts);
  const lowerPattern = /(下装|下半身|裙|裤|裙摆|裤脚|裤腰|裙腰|腿部|大腿|小腿|袜靴|鞋靴)/;
  const shoePattern = /(鞋|靴|脚踝|脚部)/;
  const lines = [];
  for (const rawLine of source.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    if (!scope.lower) {
      if (/^下装\/裙摆[:：]/.test(line)) continue;
      if (/^生图硬约束[:：]/.test(line)) continue;
      if (/^服装类别[:：]/.test(line)) {
        lines.push(removeClauses(line, lowerPattern) || "服装类别：只锁定图2已选上装/外套/内搭；图2下装不迁移。");
        continue;
      }
      if (/^衣摆扎法\/上下装关系[:：]/.test(line)) {
        lines.push("衣摆扎法/上下装关系：只锁定已选上装自身的外穿、扎入、半扎、开襟、内搭外露和下摆落点；图2下装的裙裤类型、颜色和长度不迁移，结果下装以图1原图为准。");
        continue;
      }
      if (/^拉链腰带[:：]/.test(line)) {
        lines.push(removeClauses(line, lowerPattern) || "拉链腰带：只锁定已选上装相关拉链、门襟、扣合或系带位置；图2下装腰头不迁移。");
        continue;
      }
      if (lowerPattern.test(line) && !/(上装|上衣|外套|内搭|袖|领口|门襟|拉链|扣|衣摆|衣长|肩线|面料|工艺|细节)/.test(line)) {
        continue;
      }
    }
    if (!scope.shoes && shoePattern.test(line) && !/(上装|上衣|外套|内搭|衣摆|衣长|面料|细节)/.test(line)) {
      continue;
    }
    lines.push(line);
  }

  const scopeLines = [
    `迁移范围净化：本次只迁移图2已选范围【${scope.labels}】；图2未选中的人物脸、下巴、脖子、身体姿态、背景和道具不参与生成。`,
    !scope.lower ? "未选择下装：图2裙子、裤子、腿部、袜靴、下摆层次、下装颜色和下装长度全部不迁移；结果必须保留图1原有下装和腿部关系。" : "",
    !scope.shoes ? "未选择鞋子：图2鞋靴、脚踝和脚部姿态不迁移；结果必须保留图1原有鞋脚关系。" : ""
  ].filter(Boolean);
  return normalizeMasterFitSpec([...scopeLines, ...lines].join("\n"));
}

// 中文注释：把母版中的穿法当作独立硬约束，避免同一件衣服在不同图1里随机变成卷袖、敞开、半扎或错误下装名称。
function masterWearingLockLines(parts = DEFAULT_GARMENT_PARTS) {
  const scope = garmentScope(parts);
  return [
    "【母版穿法锁定】",
    "先读取图2母版里的实际穿法，再迁移到当前图1人物：袖子自然放下就必须保持放下，卷起/挽起就保持同样卷袖高度、层数、折边宽度和褶皱状态；袖口落在掌根、腕骨、手背或前臂哪个位置，就按同一人体相对落点执行。",
    "如果图1人物抬手、扶头、叉腰或手臂弯曲，袖长仍按图2的人体相对落点锁定：图2到手腕就到手腕，图2到掌根或掌心附近就到同等位置；不能因为露出前臂或肘部弯曲而自动生成九分袖、七分袖或把袖口上提。",
    "扣合状态必须跟随图2：全扣、半扣、敞开、只扣中间、上几颗未扣、下摆开口、拉链高度、内搭外露范围都不能被图1原衣服或模型审美改写。",
    "衣摆穿法必须跟随图2：完全外穿、完全扎入、前中扎入、半扎、只扎一侧、两侧露出、衣摆敞开或被腰头遮住，都按母版同一穿法保持。",
    scope.lower
      ? "如果母版规格里写到扎入裙子/裤子，不要机械输出错误下装名称；必须先识别当前图1实际保留的下装类型，再把同样的扎入位置、露出边界和松量关系适配到图1真实下装上，例如图1是裤子就写扎入裤腰，图1是裙子就写扎入裙腰。"
      : "本次未选择下装时，只保留上装衣摆的外穿、扎入、半扎或开襟状态；不要把图2的裙子/裤子名称、颜色、长度或腰头带入结果，下装以图1原图为准。",
    "穿法优先级高于图1原服装：图1只提供身体姿势、遮挡和下装事实，不允许把图1原来的袖长、卷袖、扣子开合或衣摆扎法带到图2服装上。",
    "图1原服装零参考：图1身上原衣服的袖长、袖口位置、袖筒宽窄、衣身松量、衣长、领口、肩线、门襟、扣子、扎法、颜色、面料和褶皱都不能成为图2服装参考；只允许用来判断身体轮廓、手臂遮挡和真实穿着空间。"
  ];
}

function outfitClothingFactLockLines(parts = DEFAULT_GARMENT_PARTS) {
  const scope = garmentScope(parts);
  return [
    "【图2服装事实锁定清单】",
    "图2不是风格参考，而是服装事实来源；同批所有图1都必须穿同一件衣服，不能生成相似款、不同尺码感或另一种穿法。",
    "图1原服装零参考：图1人物原来穿的衣服不能参与服装设计判断，尤其不能影响图2袖长、袖口落点、袖筒松量、衣身宽松度、衣长、领口、肩线、门襟、扣子、衣摆扎法、颜色和面料；图1只用于人物姿势、身体比例、手臂位置、遮挡关系、场景光影和下装保留事实。",
    scope.lower
      ? "版型一致：肩线、领口、袖型、袖筒松量、衣身宽松/修身程度、腰身松量、上装衣长、裙长/裤长、下摆宽度、开衩位置和整体轮廓按图2保持；不同图1姿势只允许产生真实褶皱和遮挡。"
      : "版型一致：肩线、领口、袖型、袖筒松量、衣身宽松/修身程度、腰身松量、上装衣长、下摆落点和整体轮廓按图2已选上装保持；图2下装不迁移，图1原下装保持原样。",
    "袖口一致：袖子放下/卷起/挽起/堆褶状态、袖口相对落点、袖克夫长度和宽度、卷袖高度、卷袖层数、折边宽度和褶皱状态按图2保持；禁止长袖变九分袖、袖口从腕骨漂到手掌或反向上提。",
    "抬手袖长一致：图1出现抬手、手贴脸、手扶头、手插袋、手臂前伸或肘部弯曲时，仍以图2袖口到腕骨、掌根、手背或前臂的相对落点为准；只能产生真实弯折和遮挡，不能把长袖缩成九分袖或露出不该露出的前臂。",
    scope.lower
      ? "穿法一致：衣摆完全外穿、完全扎入、前中扎入、半扎、只扎一侧、两侧露出、被裙腰/裤腰/腰带遮住等关系按图2保持；如果图2衣摆扎入，结果不能变成未扎或随意外翻。"
      : "穿法一致：只锁定已选上装自身的外穿、扎入、半扎、开襟、内搭外露和下摆落点；未选择下装时不得把图2裙裤类型、颜色、长度或腰头关系带入结果。",
    "扣合一致：扣子总数、可见扣子位置、已扣/未扣数量、从上到下开合顺序、门襟张开程度、拉链高度、腰带系法和领口开口程度按图2保持；禁止随机全扣、全开、多扣、少扣或改变领口深度。",
    "细节一致：面料厚薄、垂感、光泽、纹理方向、拼接线、压线、口袋、五金、装饰、扣子颜色和结构位置按图2保持；不要为了美化而简化、重画或新增设计。",
    "颜色校准以图2原服装为准：图2服装原始色深、明度、饱和度、白位、黑位、高光强度和阴影深浅都要保持；不要增加饱和度、对比度、油润感、高光或商业滤镜。",
    "亮度一致：同一批结果里服装主色、明度、饱和度、高光强度和阴影深浅要与图2母版保持一致；不变浅、不变深、不变艳、不发油、不发灰，不能一张偏亮、一张偏暗、一张发灰，也不能为了商业感自动提亮、改色或增加曝光。",
    "电商平整度：在不改变服装款式、版型线、袖口、扣子、口袋、珍珠钻饰、钻扣、拼接线和面料针织肌理的前提下，消除杂乱压痕、多余自然褶皱和凌乱皱团；衣身保持平整垂顺，只保留轻微自然松弛垂感和真实穿着必要折痕。",
    "如果用户补充文字与图2可见事实冲突，优先保持图2；只有用户明确要求改穿法或改结构时，才按用户文字覆盖对应局部。"
  ];
}

function conciseMasterFitLockLines(scope, spec) {
  return [
    "【图2母版版型提示】",
    `以下内容是图2已选范围【${scope.labels}】的服装描述补充，只用于统一同批版型和穿法，不复制图2人物脸、下巴、脖子、姿势或背景。`,
    spec,
    scope.lower
      ? "执行重点：同批保持同一尺码感；袖口/袖克夫、领口门襟、扣子/拉链开合、衣摆扎法、上装衣长和下装长度都按图2描述稳定迁移；图1只提供姿势、遮挡和光影。"
      : "执行重点：同批保持同一上装尺码感；袖口/袖克夫、领口门襟、扣子/拉链开合、衣摆穿法和上装衣长都按图2描述稳定迁移；图2下装不迁移，图1只提供姿势、遮挡、原下装和光影。"
  ];
}

// 中文注释：只有明确开启且规格来自固定图2时，才注入母版版型硬约束。
function buildMasterFitLockSkill(payload) {
  const enabled = String(payload?.pairingMode || "fixed") === "fixed"
    && (payload?.masterFitLock === true
      || ["1", "true", "on", "lock", "母版", "锁版型", "开启"].includes(String(payload?.masterFitLock || "").trim().toLowerCase()));
  // 中文注释：顺序或循环配对可能对应多张图2，不能把一份规格误套到所有服装。
  const garmentParts = normalizeGarmentParts(payload?.garmentParts);
  const scope = garmentScope(garmentParts);
  const spec = scopeMasterFitSpec(payload?.masterFitSpec, garmentParts);
  if (!enabled || !spec) return [];
  return conciseMasterFitLockLines(scope, spec);
}

function buildGarmentPartSkill(parts) {
  const selected = normalizeGarmentParts(parts);
  const skipped = GARMENT_PART_OPTIONS
    .map((option) => option.value)
    .filter((part) => !selected.includes(part));
  const selectedText = selected.map(garmentPartLabel).join("、");
  const skippedText = skipped.map(garmentPartLabel).join("、");
  const lines = [
    `本次只从图2迁移这些服装部位：${selectedText}。模型自行判断上衣具体是外套/衬衫/短袖等，下装具体是裙子/裤子等，不需要用户再细分。`,
    "选中部位必须以图2为事实来源，保持真实类别、版型、长度、宽松程度、颜色、材质、穿法和可见结构。"
  ];
  if (selected.includes("upper")) {
    lines.push("如果图2袖子自然放下，袖长和袖口按图2相对落点自然垂落，不上提、不缩短、不变卷袖；如果图2袖子卷起或挽起，则保持同样卷袖高度、层数和折边状态。");
  }
  if (skippedText) {
    lines.push(`未选中的图1原有部位保持不变：${skippedText}。例如只换上衣时，图1原裙子/裤子/鞋子继续保留；不要因为图2里出现这些部位就顺手替换。`);
    lines.push(`图2里未选中的${skippedText}只当作无效背景信息，不得作为补全素材、姿势参考、身体参考或构图参考带入结果。`);
  }
  if (skipped.includes("lower")) {
    lines.push("本次未选择下装时，图2裙子、裤子、腰头、腿部、袜靴、下摆层次和下半身姿势全部忽略；图1原下半身的裙裤类型、长度、腿部位置和鞋靴保持原样。");
    lines.push("如果母版分析、图2画面或用户提示词里出现图2裙子/裤子/黑裙/高腰裙等描述，只能用于理解上装衣摆是外穿、扎入还是遮挡边界；不得把这些下装描述生成为结果。");
  }
  if (skipped.includes("shoes")) {
    lines.push("本次未选择鞋子时，图2鞋子、袜靴、脚踝和脚部姿势全部忽略；图1原鞋脚关系保持原样。");
  }
  if (skipped.includes("upper")) {
    lines.push("本次未选择上衣时，图2上衣、外套、袖子、领口和肩线全部忽略；图1原上半身服装保持原样。");
  }
  lines.push("如果图2没有清楚出现某个已选部位，不要凭空设计；优先保持图1对应部位，除非用户补充信息明确指定。");
  return lines;
}

function bananaPoseLockLines(modelName) {
  return [
    `${modelName}：把图1当作姿态和坐标模板。`,
    "头部、肩颈、重心、手臂、手腕、手指、腿脚、脚底接触和人物在画面中的位置保持原样。",
    "如果图2服装和图1姿态有冲突，优先保留图1姿态，让服装做真实穿着适配。"
  ];
}

function modelPromptSkill(model, options = {}) {
  const localEditLine = options.localEditEnabled
    ? "本次有图1局部编辑区域，只处理该区域内的指定变化，区域外画面关系保持稳定。"
    : "本次是整图换装，保持图1画面结构稳定，只替换服装。";
  if (model === "gpt-image") {
    return [
      "GPT：按图层逻辑执行，先锁图1人物与画面，再读取图2服装事实，最后做真实穿着适配。",
      localEditLine,
      "重点防止模型审美漂移：不把图2服装改短、收腰、修身、瘦身或简化细节。"
    ];
  }

  if (model === "nano-banana-pro") {
    return [
      "Nano Banana Pro：商品细节优先，图2服装的版型、长度、松量、材质和层次不要漂。",
      ...bananaPoseLockLines("Nano Banana Pro"),
      localEditLine
    ];
  }

  if (model === "nano-banana2") {
    return [
      "Nano Banana 2：短句硬锁，避免主动重构人物。",
      ...bananaPoseLockLines("Nano Banana 2"),
      "图2只供服装，不把图3或后续参考混成新衣服。",
      localEditLine
    ];
  }

  return [
    "Nano Banana：使用短句图号约束。",
    ...bananaPoseLockLines("Nano Banana"),
    "图2提供唯一服装，图3及以后只做弱参考。",
    localEditLine
  ];
}

function localEditMaterialContinuityRules(localEditIsMask) {
  return [
    "【局部材质延续】",
    localEditIsMask
      ? "本次是涂抹蒙版局部编辑：只处理被涂抹且被用户点名的内容，未涂抹区域用于保持同一画面的透视、光影和材质连续。"
      : "本次是框选局部编辑：只处理选区内被用户明确要求改变的内容，未点名的裙子、衣服和面料事实沿用原图。", 
    "材质事实包括颜色、织纹方向、颗粒大小、帆布/棉麻/皮革/雪纺/网纱等面料类别、厚薄、垂感、光泽、高光位置、褶皱密度、缝线方向和边缘磨损程度。",
    "用户没有明确要求改变面料时，不要把裙子或衣服重新生成成更光滑、更亮、更粗糙、更网格、更皮革、更塑料或更写实的材质；只修指定内容，未指定区域保持原图观感。",
    "选区边缘附近参考原图连续纹理、明暗和光泽，让材质和光影自然衔接，避免面料跳变、色块断层、新增花纹或裙摆材质不一致。"
  ];
}

const QUICK_STYLE_LOCAL_EDIT_LINES = [
  "局部编辑任务：当前图1是从原图中裁剪出的局部区域。",
  "局部选区只是 AI 工作画布，不代表选区内全部内容都可以改变；只重绘用户提示词明确点名的目标内容。",
  "保持原图透视、光源、色调、清晰度、材质衔接和边缘连续。",
  "如果用户没有明确要求改脸、改头发、改五官、改表情、改妆容或改头颈，脸部、头发、脖子、皮肤、肩颈关系都必须当作保护区，不能生成第二张脸、重复五官或移动下巴。",
  "如果局部里包含裙子、衣服或面料，未被用户明确要求改变的材质事实必须沿用原图：颜色、织纹方向、颗粒大小、厚薄、垂感、光泽、高光位置、褶皱密度和缝线方向都要和周围原图连续。",
  "不要把原图面料重新设计成更光滑、更亮、更粗糙、更网格、更皮革或更写实；选区边缘附近参考原图纹理和光影，避免面料跳变、色块断层或新增花纹。",
  "如果本次使用涂抹蒙版，只处理被涂抹且被用户点名的区域，未涂抹区域用于保持同一画面的连续观感。",
  "保持当前局部图的构图、角度和画布边界，不要增加边框、文字、水印或白边。"
];

const QUICK_STYLE_LOCAL_OUTFIT_LINES = [
  "【图1局部换装】",
  "图1已指定局部编辑区域，本次按局部换装理解：图1是人物、姿态、坐标和原画面事实，图2是服装事实来源。",
  "只在当前局部选区内把图2服装真实穿到图1人物身上，不输出整张重构图，不扩展画布，不重新摆拍。",
  "保持图1人物身份、原脸质感、发型、头部位置、身体比例、姿态、肩颈关系、手脚、背景光影和选区边缘连续；不磨皮、不变脸。",
  "如果局部选区为了贴回包含半张脸、头发、脖子、手、腿或背景，这些内容只作为坐标、肤色、清晰度和边缘融合参考，不是换装目标；除非用户点名，不能重画、磨皮、替换或改变清晰度。",
  "如果局部选区包含腿部、裤管、裙摆下缘、脚踝或地面，必须锁定图1双腿左右间距、膝盖高度、脚踝位置、裤脚/裙摆落点、脚底接触点和地面线；只能让图2服装贴合原腿部轮廓，不能重排双腿、拉长/缩短腿或改变站姿。",
  "图1模特身上的原服装不作为图2服装的款式、版型、大小、松量或长度参考；未被点名替换的图1服装部位保持原图不变。",
  "只迁移前端【图2迁移范围】选中的图2服装部位；图2中未选中的上衣、下装、鞋子、配饰、人物身体或背景不得顺手带入当前局部结果。",
  "如果本次只选上衣或只改上装，图2下半身、裙子、裤子、鞋靴、腿部姿势、手持道具和母图下身构图全部忽略；结果必须保留图1原下半身，不得把图2母图下半身生成进来。",
  "图2服装的类别、版型、长度、松量、领口、袖口、袖子穿法、扣合状态、衣摆扎法、扣子、拼接线、颜色、材质和可见结构是换装标准；只做真实穿着适配，不按模型审美改短、收腰、修身、瘦身或简化细节。",
  "袖子状态按图2实际穿法执行：放下就放下，卷起就卷起，挽起就挽起；袖口落点、袖克夫长度、卷袖高度和层数不要上提、缩短或随机变化。",
  "图1人物抬手、扶头或弯曲手臂时，长袖仍按图2袖口相对落点覆盖到对应手腕/掌根/掌心附近；不能因为手臂抬起就自动变九分袖或露出更多前臂。",
  "同批局部结果服装亮度和颜色按图2保持一致；适配图1边缘光影时不要提亮、改色、变浅、泛白、降饱和、发灰或让同一件服装出现不同曝光版本。",
  "局部换装可以整理衣身杂乱压痕和多余褶皱，让服装更平整垂顺；但必须保留图2针织肌理、珍珠钻饰、钻扣、口袋、扣子、拼接线和版型结构，不要抹平成无纹理平面。",
  "正面、侧身、半侧身都按图1原坐标执行；不要加入额外噪点、麻点、斑点或脏颗粒。"
];

function quickStyleLocalOutfitModelAnchor(model) {
  if (model === "gpt-image") {
    return [
      "GPT 局部编辑：按图层逻辑执行，先锁定图1局部坐标和人物结构，再处理用户要求，未指定区域延续原图。"
    ];
  }
  if (model === "nano-banana2") {
    return [
      "Nano Banana 2 局部编辑：短句硬锁，避免主动重构人物；无论正面、侧身还是半侧身，都不要重新摆拍、移动脖子、改变下巴位置、重画肩颈连接、重排骨架或让上下身体错位。"
    ];
  }
  if (/^nano-banana/i.test(String(model || ""))) {
    return [
      "Nano Banana 局部编辑：把图1当作姿态和坐标模板，头部、肩颈、重心、手臂、手腕、手指、腿脚、脚底接触和人物位置保持原样。"
    ];
  }
  return [
    "局部编辑：先锁定图1局部坐标和人物结构，再处理用户要求，未指定区域延续原图。"
  ];
}

function buildQuickStyleOutfitLocalEditPrompt(payload) {
  const customPrompt = String(payload.prompt || "").trim();
  const productNote = String(payload.productNote || "").trim();
  const poseAnchorPrompt = String(payload.poseAnchorPrompt || "").trim();
  const ratio = String(payload.aspectRatio || "3:4");
  const imageSize = String(payload.imageSize || "2K");
  const referenceCount = Number.parseInt(payload.referenceCount || "0", 10) || 0;
  const referenceMentioned = mentionsOptionalReference(payload);
  const localEditIsMask = String(payload.localEdit?.editMode || "") === "mask";
  const localEditHasContext = Boolean(payload.localEdit?.contextRect);
  const garmentParts = normalizeGarmentParts(payload.garmentParts);
  const garmentLengthLines = buildGarmentLengthSkill(garmentParts, payload.garmentLengths);
  const parts = [];

  parts.push(customPrompt || "让图1人物在局部区域内穿着图2服装，保持图1人物姿势、坐标、脸部质感和原图光影不变。");

  if (productNote) {
    parts.push("", "【本次补充】", productNote);
  }
  parts.push("", ...explicitDeletionRequestLines(payload));

  parts.push(
    "",
    "【批量换装图片分工】",
    "图1：当前这一张模特局部图，是人物姿态、坐标、脸部质感、背景光影和回贴边缘的唯一标准。",
    "图2：服装事实来源；如果图2在前端做过普通裁剪，裁剪后的图2就是服装参考图，不代表局部回贴坐标，也不会触发贴回逻辑。",
    referenceCount > 0 && referenceMentioned
      ? `图3及后续 ${referenceCount} 张只按用户文字说明弱参考，不能替代图2服装。`
      : "图3默认不介入；只有用户文字明确说明图3用途时才弱参考。"
  );

  parts.push("", ...QUICK_STYLE_LOCAL_EDIT_LINES);
  parts.push("局部结果必须保持高清原片质感：不要输出柔焦、低清、重采样、磨皮、压缩感、油画感或整体发糊的局部图；毛发边缘、五官质感、服装针织纹理和背景细节都要延续图1清晰度。");
  if (localEditHasContext) {
    parts.push("当前局部图可能包含比实际修改范围更大的周边画面；外围只用于对齐头脸、发丝、肩颈、背景线条、光影和透视，不要重新构图、移动头部或改变人物坐标。");
  }
  if (localEditIsMask) {
    parts.push("本次是涂抹蒙版局部换装：只处理被涂抹且被用户点名的服装区域，未涂抹区域保持原图观感。");
  }
  parts.push("", ...QUICK_STYLE_LOCAL_OUTFIT_LINES);

  parts.push("", ...outfitClothingFactLockLines(garmentParts));
  parts.push("", "【图2迁移范围】", ...buildGarmentPartSkill(garmentParts));
  if (garmentLengthLines.length > 0) {
    parts.push("", "【服装长度落点】", ...garmentLengthLines);
  }
  parts.push("", ...buildMasterFitLockSkill(payload));

  parts.push("", "【模型锚点】", ...quickStyleLocalOutfitModelAnchor(payload.model));

  if (poseAnchorPrompt) {
    parts.push("", "【智能文本锚点】", poseAnchorPrompt);
  }

  parts.push("", `输出比例：${ratio}；输出清晰度：${imageSize}。`);
  return parts.filter((item) => item !== "").join("\n");
}

function faceSwapHairStyleRules() {
  return [
    "【脸型发型头饰迁移边界】",
    "批量换脸时，图2母图负责脸型、五官、发型整体轮廓、发量体积、发顶高度、发色、刘海、发缝、卷直程度、贴脸发丝、头饰、发饰和耳饰；图1原脸型、原发型、原发饰和头饰不作为结果参考。",
    "图1只提供头部坐标、头部大小、脸部朝向、头颈连接、头身比、肩颈位置、服装边界、背景边界和现场光影过渡。",
    "允许用图2发型轮廓覆盖图1原发型和头饰干扰，但必须贴合图1原头部坐标、脸部朝向、下巴、脖子肩线和画面裁切；不能移动头部、放大头部、拉长脖子、改变肩线、重绘衣领或重绘背景。",
    "如果图2发型/头饰和图1差异很大，优先保持图1坐标与身体服装背景稳定，同时让可见脸型、发型轮廓、刘海、发色和头饰像图2母图；不能因为图1原发型更显眼就保留图1发型。"
  ];
}

function faceSwapBatchToneRules() {
  return [
    "【同批脸部色彩标准】",
    "同一批换脸结果必须像同一场景、同一人物、同一妆造连续拍出来：所有结果都以图2脸母图的肤色明暗、妆容浓淡、口红色相和饱和度、面部对比度、磨皮程度、脸部清晰度作为统一标准。",
    "图1只提供现场光方向、边缘阴影、脸颈交界和画面噪点的自然过渡；不同图1之间不能随机漂移成一张口红更鲜艳、一张脸低饱和、一张皮肤更白皙、一张像另一个光源下拍摄。",
    "脸部色调统一只作用于脸部身份融合，不能带动图1衣服、背景、肩颈、身体肤色或整张图重新调色；脸边缘要自然承接图1，脸主体要保持图2统一妆容色彩。"
  ];
}

function sanitizeFaceSwapCustomPrompt(value) {
  const raw = String(value || "").replace(/\r\n?/g, "\n").trim();
  if (!raw) return "";
  const oldPoseMotherPattern = /(图1.{0,24}(批量)?(姿态|姿势|参考图)|只提取姿势|图2.{0,36}(固定母图|母版成片|母图|服装|场景|光影).*为准|把图2母图|固定母图|母版成片|图2母图)/i;
  if (!oldPoseMotherPattern.test(raw)) return raw;
  const blockedLinePattern = /(图1.{0,24}(批量)?(姿态|姿势|参考图)|只提取姿势|图2.{0,36}(固定母图|母版成片|母图|服装|场景|光影|衣服|背景)|把图2母图|固定母图|母版成片|图2母图|重拍|重新拍摄)/i;
  const keptLines = raw
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line && !blockedLinePattern.test(line))
    .slice(0, 4);
  return [
    "已忽略旧版“图1姿态参考、图2固定母图/场景服装为准”的换脸说法；当前批量换脸固定按图1做唯一底图。",
    ...keptLines,
    "只把图2脸部身份、脸部肤色妆容色调、脸型、发型整体轮廓、头饰和发饰融合到图1原头部坐标；图1身体、服装、姿势、背景、头部位置、脖子肩线和头身比不变。"
  ].join("\n").slice(0, 900);
}

function sanitizeOutfitCustomPrompt(value) {
  const raw = String(value || "").replace(/\r\n?/g, "\n").trim();
  if (!raw) return "";
  const badGeometryDefault = /(唯一人物底图和几何基准|图1人物几何锁定|肩胯角度|姿势幅度|鞋脚接地点)/;
  const outfitDefaultContext = /(让图1当前人物穿着图2服装|图2服装|唯一服装标准|批量生成换装)/;
  if (badGeometryDefault.test(raw) && outfitDefaultContext.test(raw)) {
    return "";
  }
  return raw;
}

function isDesignDraftWorkflow(payload) {
  const text = [
    payload?.workflowMode,
    payload?.pageName,
    payload?.uploadLabels?.model?.title,
    payload?.uploadLabels?.clothing?.title,
    payload?.uploadLabels?.reference?.title
  ].join(" ");
  return String(payload?.workflowMode || "") === "design-draft"
    || /设计稿|設計稿|design|实拍服装|真人实拍|细节补充/i.test(text);
}

function isBackgroundChangeWorkflow(payload) {
  if (isRandomBackgroundWorkflow(payload)) return false;
  const pageName = String(payload?.pageName || "");
  const modelTitle = String(payload?.uploadLabels?.model?.title || "");
  const clothingTitle = String(payload?.uploadLabels?.clothing?.title || "");
  const referenceTitle = String(payload?.uploadLabels?.reference?.title || "");
  const text = [payload?.workflowMode, pageName, modelTitle, clothingTitle, referenceTitle].join(" ");
  const explicitBackgroundPage = /换固定背景|固定背景|换背景|換背景|背景更换|背景替换|换场景|換場景/i.test(pageName)
    || /固定背景|统一场景|场景图|目标场景|背景图|换背景|背景/i.test(clothingTitle);
  const backgroundLabelPair = /人物图|人物照|人物|模特图|模特/i.test(modelTitle)
    && /固定背景|统一场景|场景图|目标场景|背景图|换背景|背景/i.test(clothingTitle);
  return String(payload?.workflowMode || "") === "background-change"
    || explicitBackgroundPage
    || backgroundLabelPair
    || /PS贴回/i.test(text);
}

function isRandomBackgroundWorkflow(payload) {
  const pageName = String(payload?.pageName || "");
  return String(payload?.workflowMode || "") === "random-background"
    || /随机背景|随机场景|随机实景|random\s*background/i.test(pageName);
}

function isOutpaintWorkflow(payload) {
  const text = [
    payload?.workflowMode,
    payload?.pageName,
    payload?.uploadLabels?.model?.title,
    payload?.uploadLabels?.clothing?.title,
    payload?.uploadLabels?.reference?.title
  ].join(" ");
  return String(payload?.workflowMode || "") === "outpaint"
    || /批量扩图|扩图|扩画布|向下扩|下半身扩图|补全下半身|outpaint|expand/i.test(text)
    || /待扩图原图|扩图参考图/i.test(text);
}

function isRecolorWorkflow(payload) {
  const pageName = String(payload?.pageName || "");
  const modelTitle = String(payload?.uploadLabels?.model?.title || "");
  const clothingTitle = String(payload?.uploadLabels?.clothing?.title || "");
  const referenceTitle = String(payload?.uploadLabels?.reference?.title || "");
  const text = [payload?.workflowMode, pageName, modelTitle, clothingTitle, referenceTitle].join(" ");
  return String(payload?.workflowMode || "") === "recolor"
    || /批量改色|改色|换色|服装改色|颜色替换|颜色参考|recolor/i.test(pageName)
    || /改色服装参考图|目标颜色|颜色参考|颜色替换|换色/i.test(clothingTitle)
    || /改色服装参考图|目标颜色|颜色替换/i.test(text);
}

function isWhiteRefineWorkflow(payload) {
  const pageName = String(payload?.pageName || "");
  const modelTitle = String(payload?.uploadLabels?.model?.title || "");
  const clothingTitle = String(payload?.uploadLabels?.clothing?.title || "");
  const referenceTitle = String(payload?.uploadLabels?.reference?.title || "");
  const text = [payload?.workflowMode, pageName, modelTitle, clothingTitle, referenceTitle].join(" ");
  return String(payload?.workflowMode || "") === "white-refine"
    || /批量白底精修|白底精修|白底图精修|服装精修|平铺精修|挂拍精修|去衣架|去掉衣架|white\s*refine/i.test(pageName)
    || /批量平铺图|挂拍图|可选参考.*细节图|白底商品图|衣架去除/i.test(text);
}

function isPoseRemixWorkflow(payload) {
  if (isFaceSwapWorkflow(payload)) return false;
  const pageName = String(payload?.pageName || "");
  const modelTitle = String(payload?.uploadLabels?.model?.title || "");
  const clothingTitle = String(payload?.uploadLabels?.clothing?.title || "");
  const referenceTitle = String(payload?.uploadLabels?.reference?.title || "");
  const text = [payload?.workflowMode, pageName, modelTitle, clothingTitle, referenceTitle].join(" ");
  return String(payload?.workflowMode || "") === "pose-remix"
    || /批量姿态|批量姿态图|姿态参考图|固定模特换姿势|固定模特|固定人物|固定成片|批量姿势|换姿势|姿势生成|姿势参考|pose/i.test(text)
    || /固定母版成片|批量姿势参考图|只提取姿势/i.test(text);
}

function isFaceSwapWorkflow(payload) {
  const pageName = String(payload?.pageName || "");
  const modelTitle = String(payload?.uploadLabels?.model?.title || "");
  const clothingTitle = String(payload?.uploadLabels?.clothing?.title || "");
  const referenceTitle = String(payload?.uploadLabels?.reference?.title || "");
  const text = [payload?.workflowMode, pageName, modelTitle, clothingTitle, referenceTitle].join(" ");
  return String(payload?.workflowMode || "") === "face-swap"
    || /批量换脸|换脸|人脸|脸部|face\s*swap/i.test(pageName)
    || /人脸参考|脸部参考|人脸身份|脸部身份/i.test(text)
    || (/目标人物图|人物图|模特图|原图/i.test(modelTitle) && /人脸参考|脸部参考|人脸身份|换脸|脸/i.test(clothingTitle));
}

function isLocalDetailWorkflow(payload) {
  const text = [
    payload?.workflowMode,
    payload?.pageName,
    payload?.uploadLabels?.model?.title,
    payload?.uploadLabels?.clothing?.title,
    payload?.uploadLabels?.reference?.title
  ].join(" ");
  return String(payload?.workflowMode || "") === "local-detail"
    || /局部回贴|局部贴回|局部细节|局部精修|local\s*detail/i.test(text);
}

function mentionsOptionalReference(payload) {
  const text = [
    payload?.prompt,
    payload?.productNote
  ].join("\n");
  return /图\s*3|图三|第三张|第三个|补充图|补充参考|参考图\s*3|reference\s*3/i.test(String(text || ""));
}

function explicitDeletionRequestLines(payload) {
  const text = String([
    payload?.prompt,
    payload?.productNote
  ].filter(Boolean).join("\n")).trim();
  if (!text) return [];
  const hasDeleteVerb = /去掉|去除|删除|移除|拿掉|删掉|去除掉|不要保留|不要出现|擦掉|清除|去掉模特/i.test(text);
  const hasTargetObject = /发圈|头饰|发饰|蝴蝶结|夹子|发夹|皮筋|头花|饰品|配饰|项链|耳环|耳饰|手链|戒指|道具|水印|文字|logo|标志|标签|吊牌|粉色/i.test(text);
  if (!hasDeleteVerb || !hasTargetObject) return [];
  return [
    "【用户显式删除优先】",
    "用户本次补充里出现了明确的删除/去掉/移除对象要求；这个要求优先于普通的人物保持、发型保持或画面保护。必须把被点名对象完整删除，不能只删一部分、留下残影、换成同色阴影、换成别的饰品或让它继续隐约可见。",
    "删除发圈、头饰、发饰、夹子、配饰或道具时，只删除被点名对象，并用周围头发、背景或原有画面纹理自然补齐；不改变头部坐标、脸、五官、发型主体、服装、姿势和背景结构。",
    "如果删除对象位于局部回贴选区边缘，也要保证整块目标被删除干净，边缘自然晕开，不出现半截残留。"
  ];
}

function isCustomWorkflow(payload) {
  return String(payload?.workflowMode || "") === "custom"
    || /临时需求|自定义需求|批量需求|custom/i.test(String(payload?.pageName || ""));
}

function buildCustomPrompt(payload) {
  const customPrompt = String(payload.prompt || "").trim();
  const productNote = String(payload.productNote || "").trim();
  const parts = [];
  if (customPrompt) parts.push(customPrompt);
  if (productNote) parts.push(productNote);
  return parts.join("\n\n") || "根据用户上传的参考图片和当前页面需求生成图片。";
}

function designDraftModelSkill(model) {
  if (model === "gpt-image") {
    return [
      "模型适配：GPT 图片模型按“实物服装转设计师手稿款式图”理解，不生成真人图、不生成写实照片、不生成商业摄影成片。",
      "先从图1区域读取实物服装事实：正反面、版型、领口、袖型、袖口、下摆、衣长比例、主要结构、颜色和可识别面料特点。",
      "再读取图2区域的手稿/设计稿风格参考；如果用户文字明确说图3风格，或图3上传了手稿风格图，则图3也作为风格参考，但不能覆盖实物服装事实。",
      "输出必须是服装设计师手稿款式图：纯白背景、无人体、无模特、无场景、无衣架、无摄影质感，只保留服装正反面左右并排。",
      "线条必须有压感：外轮廓黑线两头尖、中间略粗、起笔轻、收笔轻、中段压力重，有自然手绘板笔触；禁止粗细一致、儿童涂抹式、反复描粗的线。"
    ];
  }

  return [
    "模型适配：当前模型容易把参考图混成写实图，必须强制输出服装设计师手稿，不输出真人、不输出照片。",
    "图1区域是实物服装事实，图2/图3只提供手稿风格或细节补充；不要互相替代。",
    "黑色外轮廓要像画笔压感线：两端细、中间粗、干净稳定，不要均匀粗线，不要来回涂抹。",
    "面料只用简化材质符号和少量浅淡铅笔排线暗示，不要真实照片级织物细节。",
    "所有转角、袖口四角、下摆边角、接缝拐点外侧点缀浅灰短定位线，短、小、淡、零散，不画成长贯穿辅助线。"
  ];
}

function buildDesignDraftPrompt(payload) {
  const customPrompt = String(payload.prompt || "").trim();
  const productNote = String(payload.productNote || "").trim();
  const ratio = String(payload.aspectRatio || "3:4");
  const imageSize = String(payload.imageSize || "2K");
  const modelImageCount = Math.max(1, Number.parseInt(payload.modelImageCount || "1", 10) || 1);
  const referenceCount = Number.parseInt(payload.referenceCount || "0", 10) || 0;
  const modelTitle = String(payload?.uploadLabels?.model?.title || "实拍服装图/真人实拍图").trim();
  const clothingTitle = String(payload?.uploadLabels?.clothing?.title || "设计稿风格参考").trim();
  const referenceTitle = String(payload?.uploadLabels?.reference?.title || "细节补充图").trim();
  const designImageIndex = modelImageCount + 1;
  const detailStartIndex = designImageIndex + 1;
  const parts = [
    "【服装设计师手稿款式图 Skill】",
    "目标：参考实物服装正反面，把服装转换为干净的服装设计师手稿风格款式图。",
    "核心原则：图1区域负责实物服装事实，图2区域负责设计稿/手稿风格参考，图3区域可作为细节或风格补充；服装事实优先于风格化，不允许混淆角色。",
    "",
    "【你验证过的成功模板】",
    "参考图1和图2正反面实物服装，转换为图3风格干净的服装设计师手稿风格，纯白背景，无人体、无模特、无场景、无衣架，画面只保留服装正反面左右并排款式图。",
    "服装颜色参考原图实物颜色，保留原服装的版型、领口、袖型、袖口、下摆、长度比例和主要结构。",
    "整体以黑色线稿为主，搭配极浅的米杏色淡填色，不要真实照片质感，不要复杂面料纹理，不要写实细节。",
    "",
    `当前页面图1标题：${modelTitle}`,
    `当前页面图2标题：${clothingTitle}`,
    `当前页面图3标题：${referenceTitle}`,
    "",
    "【图片编号规则】",
    modelImageCount > 1
      ? `第1到第${modelImageCount}张都属于图1区域：实物服装正反面/侧面/局部/真人实拍参考，必须合并理解为同一件服装或同一组服装事实，不要生成多件无关衣服。`
      : "第1张属于图1区域：实物服装或真人实拍参考。提取真实服装事实、版型、面料、颜色、结构和比例。",
    `第${designImageIndex}张属于图2区域：设计稿/手稿风格参考。只提取线稿风格、笔触质感、款式图表达方式和辅助短线感觉，不复制纸张、文字、标注线、人体模板、背景和无关装饰。`,
    referenceCount > 0
      ? `第${detailStartIndex}张及后续属于图3区域：可选细节/风格补充，可用于补充面料、袖口、裙摆、衣领、拼接、里衬、网纱、印花、颜色或手稿辅助线风格。`
      : "当前没有图3补充图时，不要凭空添加复杂结构；以图1实物服装事实和图2手稿风格为主。",
    "",
    "【成功提示词核心要求】",
    "参考图1区域的实物服装，转换为图2/图3参考中的干净服装设计师手稿风格，纯白背景，无人体、无模特、无场景、无衣架。",
    "画面只保留服装正反面左右并排款式图；如果只有单面参考，也要尽量按款式逻辑补出正反面，但不能虚构复杂细节。",
    "服装颜色参考图1实物服装颜色，保留原服装的版型、领口、袖型、袖口、下摆、长度比例和主要结构。",
    "整体以黑色线稿为主，搭配极浅的米杏色或接近实物颜色的淡填色；不要真实照片质感，不要复杂面料纹理，不要写实细节。",
    "",
    "【线条与笔触硬约束】",
    "线条必须像手绘板画笔线：外轮廓线清晰干净，起笔轻、收笔轻、中间压力重，线条两头细、中间粗，有轻微压杆变化和自然手绘笔触。",
    "内部结构线、领口线、袖口线、下摆线、衣身分割线使用更细的线，线条稳定、准确、克制。",
    "禁止粗细一致的机械线；禁止像小孩来回涂抹形成的均匀粗黑边；禁止毛糙乱线、过多重影线、脏污笔刷。",
    "",
    "【拐点定位短线/起稿标记】",
    "服装所有轮廓转角、袖口四角、下摆边角、接缝拐点位置，都要点缀极短的浅灰色纤细定位短线。",
    "这些短线只停留在拐点外侧，短小零散、浅淡、明度远低于黑色衣身轮廓线，是手绘起稿标记拐点残留短线。",
    "辅助短线要比参考图更明显一点点，但不能杂乱、不能延伸、不能变成长贯穿线条、不能抢过主轮廓。",
    "",
    "【面料与填色】",
    "面料填充不要太真实，只抓住面料特点：用非常少量的简化材质符号和浅淡铅笔排线暗示，不出现真实照片级织物细节，不出现复杂编织纹理，不出现杂乱涂抹线。",
    "服装颜色根据图1实物服装来，颜色只做设计手稿淡填色，不做厚重写实上色。",
    "整体像服装打版师、设计师用手绘板画出来的产品工艺手稿：结构清楚、比例准确、线条干净、有轻微手写压感但不凌乱。",
    "",
    "【禁止内容】",
    "不要人体、不要模特、不要脸、不要手脚、不要场景、不要衣架、不要摄影棚、不要真实照片质感、不要商品拍摄阴影、不要品牌 Logo、不要文字说明、不要标注箭头、不要对比拼贴。",
    `输出比例：${ratio}；输出清晰度：${imageSize}。`
  ];

  parts.push("", "【模型提示词适配】", ...designDraftModelSkill(payload.model));

  if (productNote) {
    parts.push(
      "",
      "【服装细节/商品补充信息】",
      "以下内容优先作为服装细节事实执行：",
      productNote
    );
  }

  if (customPrompt) {
    parts.push(
      "",
      "【用户本次提示词】",
      "以下文字只用于补充本次画面目标；如果和图1实拍事实、图2设计稿角色、图3细节补充冲突，按上方优先级处理。",
      customPrompt
    );
  }

  parts.push(
    "",
    "【最终检查】",
    "检查服装是否同时保留了图1真实事实、图2设计风格和图3细节补充；检查是否误把设计稿文字/纸张/标注线带入；检查是否生成了多件衣服或把不同参考图混成不稳定款式。"
  );

  return parts.join("\n");
}

function backgroundChangeModelSkill(model) {
  if (model === "gpt-image") {
    return [
      "模型适配：GPT 图片编辑模型按“人物前景放入固定目标背景并做真实重光照融合”理解，不做换装、不重绘人物主体。",
      "把图1人物当作不可改变的前景图层：人物坐标、主体比例、头身大小、姿势、手脚位置、发型、脸部朝向、服装款式、服装颜色和服装细节都锁定。",
      "把图2当作唯一固定背景图层：学习图2空间透视、地面材质、背景层次、相机高度、主光方向、色温、对比度和阴影强度，让图1人物自然融入图2场景。",
      "允许对图1人物做自然整体重光照、色温统一、边缘环境反光和脚底接触阴影；这些调整不能改变人物轮廓、衣服款式、脸部位置、手脚姿势、人物大小和服装关键事实。",
      "如果图1是半身或特殊裁切，保持原裁切，不补腿、不补脚、不扩画布；如果图1有原背景，删除原背景并保留人物完整边缘。"
    ];
  }

  if (model === "nano-banana2") {
    return [
      "模型适配：Nano Banana 2 容易重新摆拍人物，必须把图1人物锁成不可移动主体模板。",
      "不要重新生成一个相似人物；必须保留图1人物原坐标、原站姿、原手势、原服装、原头身比例和原主体占比。",
      "图2只负责统一场景，不能从图2复制人物、衣服、道具遮挡或新的动作到图1人物身上。",
      "人物光影要向图2固定背景自然融合，但人物不能被换脸、换衣、瘦身、增高、转身、移动、缩放、裁脚、补腿、改手、改头或重设计服装颜色。",
      "所有批量结果要像同一场景同一摄影方案：背景方案、光源方向、色温、接触阴影和整体白平衡统一；人物结构事实仍来自各自图1。"
    ];
  }

  if (model === "nano-banana-pro") {
    return [
      "模型适配：Nano Banana Pro 适合写实商业成片，但要限制它不要重新设计人物。",
      "图1人物是原样保留主体，图2是统一商业场景；保持人物完整、服装真实、边缘干净、站位不变。",
      "图2提供背景空间、主光方向、色温、阴影和商业氛围；人物允许做自然重光照与色温统一，只为融入图2场景，不改变服装款式和人物结构。",
      "禁止把图1人物改成图2场景里的新模特，禁止换衣、换脸、换姿势、换比例、移动人物坐标、补全下半身或改变原裁切。"
    ];
  }

  return [
    "模型适配：当前模型使用短句硬约束执行换背景。",
    "图1人物保持原样：位置、比例、姿势、脸、发型、服装、手脚、鞋子和裁切全部不变。",
    "图2提供固定背景场景：统一空间、透视、主光方向、色温、地面接触阴影和整体白平衡。",
    "人物可以自然重光照融入图2背景，但不能换脸、换衣、移动、缩放、补腿或重设计。",
    "图3可选补充，不上传时不要编造复杂道具或新场景元素。",
    "不要换衣服、不要换脸、不要移动人物、不要补全下半身、不要扩画布、不要重新构图、不要输出拼贴对比图。"
  ];
}

// 中文注释：批量姿态专用模型适配；图1只给姿态，图2才是固定母版成片。
function poseRemixModelSkill(model) {
  if (model === "gpt-image") {
    return [
      "模型适配：GPT 图片编辑模型按“图1给姿态骨架，图2给固定成片母版”理解。",
      "先读取图1的人脸朝向、肩膀、手臂、手腕手掌、下半身、重心和构图动势；禁止读取图1服装、穿法、背景和人物身份作为结果事实。",
      "再锁定图2人物身份、脸、发型、服装版型、穿法、场景、光影和镜头质感；最终只把图2母版自然重拍成图1姿态。",
      "姿态必须明显像图1，不要只把图2母版原动作轻微变形；如果图1姿态会导致图2服装事实漂移，尽量保留图1动作相似度，同时用自然褶皱、遮挡和透视适配图2服装。"
    ];
  }

  if (model === "nano-banana2") {
    return [
      "Nano Banana 2：短句硬锁，图1只给姿态。",
      "图1只要脸朝向、肩膀、手臂、手腕、手掌、腿脚、重心、动作；动作相似度要高。",
      "图2锁定同一个人、同一张脸、同一发型、同一套衣服、同一穿法、同一场景、同一光影。",
      "禁止复制图1衣服和背景；只把图2母版换成图1姿态，半身/全身裁切也跟图1。"
    ];
  }

  if (model === "nano-banana-pro") {
    return [
      "Nano Banana Pro：保持图2商业成片质感，把图1姿态尽量准确迁移到同一模特和同一套服装上。",
      "服装细节优先级高于姿态参考：袖口、扣子、扎法、腰身、裙长/裤长、面料纹理不能随图1变化。",
      "抬手高度、手腕手掌方向、重心、腿脚和半身/全身裁切要跟图1接近；姿态变化只产生真实穿着下的褶皱、遮挡和肢体透视，不复制图1服装，不重新设计人物或服装。"
    ];
  }

  return [
    "当前模型使用短句硬约束执行批量姿态。",
    "图1只参考姿态和手脚动作；动作相似度要高。",
    "图2锁定人物、脸、发型、衣服、穿法、场景、光影。",
    "生成图2同款人物服装场景，但姿态跟图1，半身/全身裁切跟图1；禁止复制图1衣服、背景和身份。"
  ];
}

// 中文注释：批量姿态提示词角色反转；图1批量姿态图，图2固定母版成片。
function buildPoseRemixPrompt(payload) {
  const customPrompt = sanitizeOutfitCustomPrompt(payload.prompt);
  const productNote = String(payload.productNote || "").trim();
  const poseAnchorPrompt = String(payload.poseAnchorPrompt || "").trim();
  const ratio = String(payload.aspectRatio || "3:4");
  const imageSize = String(payload.imageSize || "2K");
  const referenceCount = Number.parseInt(payload.referenceCount || "0", 10) || 0;
  const referenceMentioned = mentionsOptionalReference(payload);
  const poseTitle = String(payload?.uploadLabels?.model?.title || "批量姿态图").trim();
  const masterTitle = String(payload?.uploadLabels?.clothing?.title || "固定母版成片").trim();
  const referenceTitle = String(payload?.uploadLabels?.reference?.title || "补充约束图").trim();
  const parts = [
    "【批量姿态 Skill】",
    "目标：图1上传区提供批量姿态参考，图2上传区提供固定母版成片；根据每张图1姿态，生成同一个图2母版人物、同一套服装、同一穿法、同一场景、同一商业摄影质感的不同姿态成片。",
    "核心原则：图1只提供姿态骨架和构图动势，图2锁定所有成片事实。这个任务不是换装、不是换脸、不是换背景、不是复制图1衣服，而是把图2母版重拍成图1姿态。",
    "",
    `当前页面图1标题：${poseTitle}`,
    `当前页面图2标题：${masterTitle}`,
    `当前页面图3标题：${referenceTitle}`,
    "",
    "【图片编号规则】",
    "图1：姿态参考图。只提取身体姿态、脸部朝向、头颈方向、肩膀角度、肩宽透视、手臂位置、手肘弯曲、手腕角度、手掌朝向、手指动作、腰胯扭转、腿脚姿态、膝盖弯曲、脚尖方向、站坐走关系、身体重心、遮挡关系和构图动势。",
    "禁止复制图1的人物身份、脸、发型、服装款式、服装颜色、服装纹理、袖口、扣子、衣摆扎法、裙裤类型、背景、道具、光影、镜头风格、画面色调和任何与姿态无关的内容。",
    "图2：固定母版成片。人物身份、脸部五官、脸型、年龄感、皮肤质感、发型轮廓、发色、妆容气质、服装类别、服装版型、修身/宽松程度、颜色、面料、纹理、领口、袖型、袖口、袖克夫、扣子、拉链、门襟、衣摆扎法、裙长/裤长、下摆轮廓、配饰、场景、光影、镜头距离、商业摄影风格和整体调色都以图2为准。",
    referenceCount > 0 && referenceMentioned
      ? `图3及后续 ${referenceCount} 张：用户已明确说明图3用途，只能作为弱补充约束，例如禁忌、局部边界、客户文字要求或细节核对；不能覆盖图2母版事实，也不能改变图1姿态来源。`
      : "当前没有明确启用图3时，不参考图3；不要凭空添加额外道具、文字、水印、品牌 Logo 或新场景元素。",
    "",
    "【图2母版硬锁定】",
    "生成结果必须保持图2是同一个人：同一张脸、同一头部大小、同一脸部比例、同一发型外轮廓、同一发量、同一发色、同一妆容气质、同一皮肤质感。不要换脸、不要改变年龄、不要换发型、不要改变人物身份。",
    "生成结果必须保持图2是同一套衣服：服装版型、修身/宽松程度、肩线、领口、袖长、袖口落点、袖克夫长度、卷袖/放下状态、扣合状态、拉链高度、门襟开合、衣摆扎法、腰身松量、上装衣长、裙/裤长度、下摆宽度、开衩、口袋、拼接线、面料厚薄、垂坠、光泽、纹理和可见工艺细节都不能漂移。",
    "图2袖子放下，所有结果袖子都按图2放下；图2袖子卷起，所有结果都按图2卷起；图2扣几颗、敞开几颗、衣摆是否扎入、半扎还是外穿，都必须按图2母版执行。",
    "生成结果必须保持图2同一场景：背景结构、地面/墙面关系、光源方向、色温、对比度、景深、镜头距离、商业摄影质感保持一致；不要把图1背景或拍摄风格带进来。",
    "",
    "【图1姿态迁移范围】",
    "只把图1姿态迁移到图2母版人物身上：脸部朝向、头颈角度、肩膀高低、肩线角度、脊柱倾斜、重心、站立/坐姿/行走状态、手臂抬放、手肘弯曲、手腕角度、手掌朝向、手指自然状态、腿部前后关系、膝盖弯曲、脚尖方向、下半身方向和肢体遮挡关系。",
    "姿态相似度必须作为本任务主要目标之一：结果要一眼看出是在模仿当前图1动作，抬手高度、手臂伸展幅度、手腕手掌方向、肩膀高低、腰胯转向、身体重心、膝盖弯曲、脚尖方向和半身/全身裁切尽量贴近图1；不能只把图2母版姿势轻微变形。",
    "人脸方向、肩膀、手臂和下半身必须跟随图1，不要只固定图2的头肩手臂后轻微变形；图1侧脸就生成侧脸方向，图1手臂抬起就让图2同一人物自然抬臂，图1下半身转向也要对上。",
    "姿态迁移必须服务图2母版服装事实：如果图1手臂抬起或身体转向，会产生合理褶皱和遮挡，但不能把图2袖口长度、袖子穿法、扣子开合、衣摆扎法、裙长/裤长、腰身松量改掉。",
    "如果图1姿态和图2服装穿法冲突，先尽量保持图1动作相似度，再让图2服装做真实穿着褶皱和遮挡适配；只有物理上无法同时满足时才轻微折中，不要因为图2母版原姿势更容易就放弃图1参考动作。",
    "",
    "【批量一致性】",
    "同一批每张图必须像同一个模特、同一套衣服、同一场景、同一摄影方案，只换动作。不要一张脸变成熟、一张服装变宽、一张袖口变短、一张衣摆扎法改变、一张背景光线改变。",
    "生成前后检查图2母版与当前结果：脸、发型、服装颜色、版型、袖口、扣子、扎法、腰身、衣长、裙/裤长度、面料纹理、场景光影是否一致；发现漂移时优先纠正母版事实。",
    "",
    "【禁止内容】",
    "不要换装、不要换脸、不要换发型、不要换背景、不要复制图1衣服、不要复制图1人物、不要复制图1场景、不要把图1裙裤类型当作服装事实、不要改变图2服装长度、不要重新设计衣服、不要添加无关道具、不要文字说明、不要水印、不要品牌 Logo、不要输出拼贴或对比图。",
    `输出比例：${ratio}；输出清晰度：${imageSize}。`
  ];

  parts.push("", "【模型适配】", ...poseRemixModelSkill(payload.model));

  if (poseAnchorPrompt) {
    parts.push(
      "",
      "【智能文本锚点】",
      "以下锚点只用于帮助识别图2母版的人物坐标和服装边界；不能覆盖图1姿态参考，也不能改变图2母版服装事实。",
      poseAnchorPrompt
    );
  }

  if (productNote) {
    parts.push(
      "",
      "【本次补充信息】",
      "以下内容只能补充图2母版锁定、图1姿态迁移或客户禁忌；如果和图2成片事实冲突，必须以图2为准。",
      productNote
    );
  }

  if (customPrompt) {
    parts.push(
      "",
      "【用户本次提示词】",
      "以下文字用于补充批量姿态需求；如果与图2母版锁定或图1只取姿态冲突，必须以硬规则为准。",
      customPrompt
    );
  }

  parts.push(
    "",
    "【最终检查】",
    "确认结果的姿态、人脸方向、肩膀、手臂和下半身跟随图1；确认人物身份、脸、发型、服装版型、服装穿法、面料细节、场景光影和商业摄影质感都与图2母版一致。"
  );

  return parts.join("\n");
}

function buildBackgroundChangePrompt(payload) {
  const customPrompt = String(payload.prompt || "").trim();
  const productNote = String(payload.productNote || "").trim();
  const poseAnchorPrompt = String(payload.poseAnchorPrompt || "").trim();
  const ratio = String(payload.aspectRatio || "3:4");
  const imageSize = String(payload.imageSize || "2K");
  const referenceCount = Number.parseInt(payload.referenceCount || "0", 10) || 0;
  const referenceMentioned = mentionsOptionalReference(payload);
  const localEditEnabled = Boolean(payload.localEdit?.enabled || payload.localEdit === true);
  const localEditIsMask = localEditEnabled && String(payload.localEdit?.editMode || "") === "mask";
  const modelTitle = String(payload?.uploadLabels?.model?.title || "人物图/模特图").trim();
  const sceneTitle = String(payload?.uploadLabels?.clothing?.title || "固定背景图").trim();
  const referenceTitle = String(payload?.uploadLabels?.reference?.title || "补充参考图").trim();
  const parts = [
    "【电商批量固定背景 Skill】",
    "目标：把图1人物批量放入图2固定目标背景中，生成像同一场景真实拍出来的电商成片。这个任务是固定背景，不是换装、不是重绘人物、不是重新拍一张相似图。",
    "核心原则：人物结构事实以图1为绝对标准，背景和光影环境以图2为绝对标准；图3只做可选补充。人物坐标、姿势、比例、裁切和服装不能漂移，不补全身体、不扩出下半身。",
    "",
    `当前页面图1标题：${modelTitle}`,
    `当前页面图2标题：${sceneTitle}`,
    `当前页面图3标题：${referenceTitle}`,
    "",
    "【图片编号规则】",
    "图1：当前要换背景的人物图。可能带原背景，也可能是透明底、白底或干净底。无论图1是否带背景，只保留人物主体和人物身上的服装事实，不保留图1原背景。",
    "图2：固定目标背景图。图2是场景、空间、地面、背景层次、镜头高度、主光方向、色温、阴影强度、整体白平衡和商业氛围的唯一标准；图1人物需要自然融入图2光影环境。",
    referenceCount > 0
      ? `图3及后续 ${referenceCount} 张：可选补充参考，只能用于补充场景氛围、光线色调、道具边界、地面接触、客户要求或局部细节，不允许改变图1人物。`
      : "当前没有图3补充图时，不要凭空增加复杂道具、文字、水印、品牌标识或额外人物。",
    "",
    "【图1人物硬锁定】",
    "必须完全保持图1人物在画面中的位置、主体大小、头身比例、肩颈方向、身体姿势、重心、手臂位置、手腕角度、手掌朝向、手指数量和弯曲、腿脚姿势、脚尖方向、鞋子形状、头部大小、脸部朝向、发型轮廓、服装款式、服装颜色、服装纹理、服装长度、褶皱、配饰和当前画面裁切。",
    "人物不能移动、不能缩放、不能重新居中、不能改成更合适场景的站姿、不能换脸、不能换发型、不能换衣服、不能瘦身增高、不能拉腿、不能裁掉脚、不能补腿补脚、不能把手脚改成新的动作。",
    "图1半身就保持半身，不要想象或生成下半身；图1全身就保持全身；如果图1人物靠左、靠右、偏上、偏下或有特殊裁切，也要保持这个坐标关系，不要让模型自动重新构图或扩展画布。",
    "",
    "【图2固定背景融合】",
    "把图1人物放进图2固定背景里，场景必须来自图2：空间透视、地面/墙面/背景结构、镜头高度、背景虚实、主光方向、色温、阴影强度和商业氛围都要向图2统一。",
    "固定背景是最终光影标准：允许对图1人物做自然的整体重光照、色温统一、边缘环境光、服装/皮肤明暗过渡和白平衡校正，让人物像真实处于图2场景中，而不是简单贴在背景上。",
    "人物与场景之间必须补足边缘融合、脚底/身体接触阴影、轻微环境反光、地面遮挡关系和远近虚实衔接；这些处理不能改变人物轮廓、服装款式、脸部坐标、手脚姿态、人物比例、人物位置和关键服装事实。",
    "",
    "【图1局部编辑】",
    localEditEnabled
      ? localEditIsMask
        ? "图1已指定涂抹区域：只处理被涂抹区域的背景/边缘融合和场景光影匹配，未涂抹区域只用于理解透视、光影、色调和主体轮廓。保持当前输入图的画布边界，不扩展画面。"
        : "图1已指定局部选区：只处理选区内的背景/边缘融合和场景光影匹配，保持当前输入图的画布边界，不扩展画面；选区边缘承接主体轮廓并贴合图2背景光影。"
      : "未指定图1局部区域时，按整图换背景生成；仍要保持人物坐标、姿势和主体比例不漂移。",
    "",
    "【批量一致性】",
    "批量生成时，每张图只处理当前图1人物，但图2固定背景方案、主光方向、色温、对比度、接触阴影和整体白平衡保持一致。不同人物之间可以因为身高和姿势不同产生自然阴影差异，但不能一张像棚拍、一张像街拍。",
    "不要背景一张偏暖一张偏冷；不要人物一张亮、一张灰、一张像贴纸；不要为了统一光影而改变人物结构、服装款式或脸部身份。统一的是同一摄影场景里的真实融合效果。",
    "",
    "【禁止内容】",
    "不要换装、不要换脸、不要换发型、不要改变人物服装颜色和款式、不要移动人物、不要缩放人物、不要补全下半身、不要扩出腿脚、不要扩展画布、不要重新摆拍、不要生成新人物、不要添加无关人物、不要输出对比图、不要拼贴、不要文字说明、不要水印、不要品牌 Logo。",
    `输出比例：${ratio}；输出清晰度：${imageSize}。`
  ];

  if (localEditEnabled) {
    parts.push("", ...localEditMaterialContinuityRules(localEditIsMask));
  }

  parts.push("", "【模型提示词适配】", ...backgroundChangeModelSkill(payload.model));

  if (poseAnchorPrompt) {
    parts.push(
      "",
      "【智能介入：图1人物坐标与姿势锚点】",
      "以下锚点来自文本/视觉模型对图1的预分析，优先级高于用户补充信息；用于让当前生图模型保持图1人物坐标、头部大小、姿势、服装和主体占比。",
      poseAnchorPrompt
    );
  }

  if (productNote) {
    parts.push(
      "",
      "【本次补充信息】",
      "以下内容只能补充场景融合或客户要求；如果和图1人物硬锁定冲突，必须以图1人物不变为准。",
      productNote
    );
  }

  if (customPrompt) {
    parts.push(
      "",
      "【用户本次提示词】",
      "以下文字只用于补充固定背景目标；如果与图1人物锁定或图2场景光影标准冲突，必须以图1和图2硬规则为准。",
      customPrompt
    );
  }

  parts.push(
    "",
    "【最终检查】",
    "检查人物位置、比例、姿势、脸、发型、服装、手脚和鞋子是否与图1一致；检查主光方向、色温、阴影、白平衡、透视、边缘融合和地面接触是否像图2固定背景里的真实拍摄。"
  );

  return parts.join("\n");
}

function randomBackgroundModelSkill(model) {
  if (model === "gpt-image") {
    return [
      "模型适配：GPT 图片编辑模型按“保留主体事实、原生重建场景并统一重光照”理解本任务，不要按生硬抠图贴背景执行。",
      "先锁定图1人物、脸、发型、服装和构图，再按场景补充生成新环境；人物面部和服装不要被重新绘制成另一张相似图。",
      "背景可以变化机位、远近层次和景深，但人物坐标、头身比、画面占比和服装展示重点不变。",
      "光照按目标新场景统一，不按图1原片背光、阴天或室内暖黄光生成；图1人物身上的偏黄、偏橙、暗沉只当作旧光源污染，可自然校正到目标日光白平衡。",
      "人物不是贴图层：要按目标场景重新匹配人物整体亮度、色温、环境反光、面部补光、服装受光和脚底接触阴影，让人物像现场拍摄。",
      "边缘必须重新融合为真实拍摄感：保留发丝轮廓但有自然半透明过渡、环境反光和脚底接触阴影，禁止白边、黑边、锯齿边、旧背景光晕和贴纸感。"
    ];
  }

  if (/^nano-banana/i.test(String(model || ""))) {
    return [
      "Nano Banana：短句硬锁，换背景并统一重光照。",
      "图1人物、脸、发型、姿势、服装、配饰和构图不变。",
      "按场景补充生成真实背景，同批像同一场景不同角度拍摄。",
      "目标场景光照优先；图1室内暖黄、偏橙、暗沉不是标准，要校正人物到统一柔和白天光照和中性白平衡。",
      "人物要接受新场景光：整体亮度、脸部补光、服装受光、边缘环境色和脚底阴影都跟新背景一致。",
      "自然融合发丝边缘、衣服边缘和脚底接触阴影，不要硬抠边、白边、黑边、旧背景光晕或贴图感。",
      "不要换衣、不要换脸、不要移动人物、不要补腿、不要扩图。"
    ];
  }

  return [
    "当前模型按批量随机背景执行：图1人物和服装事实不变，原生生成新背景并统一重光照。",
    "场景来自场景补充，同批保持同一真实场景体系但机位不要完全重复。",
    "光照由新场景统一决定，人物自然适配场景；不要让图1背光、室内暖黄、偏橙或暗沉影响整批背景亮度和白平衡。",
    "人物、服装和背景必须共用同一曝光、白平衡、环境反光和接触阴影，不能像抠图贴上去。",
    "边缘、发丝和脚底阴影要像真实拍摄，禁止硬抠边、白边、黑边和贴纸感。"
  ];
}

function normalizeRandomBackgroundFocus(value) {
  const text = String(value || "default").trim().toLowerCase();
  if (["upper", "top", "上衣", "上装"].includes(text)) return "upper";
  if (["lower", "bottom", "下衣", "下装"].includes(text)) return "lower";
  if (["set", "suit", "full", "套装", "整套"].includes(text)) return "set";
  return "default";
}

function randomBackgroundFocusRule(value) {
  const focus = normalizeRandomBackgroundFocus(value);
  if (focus === "upper") {
    return "视觉重点：上衣。背景干净度、景深、留白和光线优先服务上半身、领口、肩袖、胸腰和上衣面料细节；不要让背景杂物抢上衣。";
  }
  if (focus === "lower") {
    return "视觉重点：下装。背景、地面、脚底接触阴影和景深优先服务腰线、裙摆/裤腿、腿部、鞋子和下装面料细节；不要裁掉或弱化下装。";
  }
  if (focus === "set") {
    return "视觉重点：套装。上衣、下装、鞋包和整套穿搭要均衡清晰，背景和光线服务整套服装展示；不要只突出上半身或只突出下半身。";
  }
  return "视觉重点：默认。不额外偏向上衣、下装或套装，按人物和整套服装自然展示。";
}

function buildRandomBackgroundPrompt(payload) {
  const customPrompt = String(payload.prompt || "").trim();
  const sceneNote = String(payload.productNote || "").trim();
  const poseAnchorPrompt = String(payload.poseAnchorPrompt || "").trim();
  const ratio = String(payload.aspectRatio || "3:4");
  const imageSize = String(payload.imageSize || "2K");
  const visualFocusRule = randomBackgroundFocusRule(payload.randomBackgroundFocus);
  const modelTitle = String(payload?.uploadLabels?.model?.title || "批量人物图").trim();
  const parts = [
    "【电商批量随机背景 Skill】",
    "目标：把图1人物放入场景补充里描述的大概场景，生成真实电商女装实拍成片。这个任务不是换装、换脸、扩图、重新拍一张相似图，也不是把人物生硬抠出来贴到背景上。",
    "核心原则：图1人物、脸、发型、姿势、服装和构图是绝对事实；场景补充决定新背景的大方向、季节氛围、空间类型、道具边界和镜头氛围。光照、曝光和白平衡由目标场景先固定，再把图1人物自然校正进去；不跟随图1原片背光、阴天、暗沉或室内黄光漂移。",
    "",
    `当前页面图1标题：${modelTitle}`,
    "",
    "【图片编号规则】",
    "图1：当前要替换背景的人物原图。只保留图1人物主体和穿搭事实，不保留图1原背景、原背景边缘光晕或原室内暖黄光。",
    "当前输入以图1人物原图和场景补充为准；人物、服装、姿势、构图来自图1，背景方向来自场景补充。",
    "",
    "【图1人物硬锁定】",
    "严格保留图1模特五官妆容、脸部清晰度、发型轮廓、头饰/发饰、全部身体姿态、重心、手臂手掌、腿脚姿势、人物构图、画面占比和当前裁切。",
    "完整保留图1整套服装版型、衣长、袖长、领口、门襟、腰线、裤裙/鞋包、配饰、面料纹理、材质质感、褶皱和全部细节；不换衣、不重绘服装结构、不改变服装展示重点。服装本来是什么颜色仍是什么颜色，但图1室内暖光造成的偏黄、偏橙、暗沉可以被校正到目标场景白平衡。",
    "人物面部拒绝重绘：不能换脸、改妆、改五官、改脸型、改头身比、移动头部、改变下巴脖子连接或让脸变糊。",
    "图1半身就保持半身，图1全身就保持全身；不能补全下半身、扩出腿脚、拉长身体、缩放人物、重新居中或改变人物站位。",
    "",
    "【随机背景生成】",
    "背景以场景补充为准：生成原生写实实拍环境，拒绝虚假 AI 场景、文字、水印、品牌 Logo、无关人物和多余道具；不要把图1人物当作独立贴图层放到背景上。",
    "同一批结果要像同一场景体系、同一拍摄主题、同一时间段的白天光线下拍摄，但每张可以是不同机位、不同角度、不同远近层次和自然景深变化；不要像固定相机重复复制同一张背景。",
    "机位默认平视，禁止俯拍；背景适配服装风格，画面干净，焦点集中人物和服装。",
    visualFocusRule,
    "",
    "【光影画质】",
    "场景光照优先级高于图1原片光照：不要让图1背光、阴天、低曝光、暗沉或室内黄光把新背景拖暗或染黄。先建立同一时间段的柔和明亮白天自然光，再对人物、皮肤、头发和服装做整体重光照、曝光统一和白平衡统一。",
    "整批亮度标准：背景、地面、人物面部和服装应像同一场景同一时段拍摄，保持中性干净日光白平衡、柔和均匀照明和中低对比；不能一张明亮、一张背光阴天、一张灰暗低曝光或像不同天气；人物不能明显比背景暗、黄、灰或像旧图贴上去。",
    "禁止暖黄、偏橙、咖啡暖滤镜、复古黄调、室内暗沉、假白提亮、强直射阳光、硬阴影、背光剪影、夕阳感、地面大面积太阳光斑或强烈高光。",
    "允许并要求对图1人物做自然整体补光、白平衡统一、色温校正、环境色反射、边缘光、脚底/身体接触阴影和轻微空气透视；这些调整只服务场景融合，不能改变人物身份、五官、妆容、肤色关系、头发轮廓、服装颜色款式和面料细节，不能把服装改成另一种颜色。同批人物肤色明度、脸部明暗关系、发色和服装白位/黑位保持同一调性。",
    "人物与背景必须像同一现场拍摄：发丝、衣服轮廓、手脚边缘要有自然过渡和环境色反射，脚底/身体接触阴影要落在新地面上，人物脚底不能漂浮；禁止硬抠边、白边、黑边、锯齿边、发丝断裂、旧背景残边、人物像贴纸或背景被原图暖光反向污染。",
    `输出比例：${ratio}；输出清晰度：${imageSize}。`
  ];

  parts.push("", "【模型适配】", ...randomBackgroundModelSkill(payload.model));

  if (poseAnchorPrompt) {
    parts.push(
      "",
      "【智能介入：图1人物坐标与姿势锚点】",
      "以下锚点只用于保持图1人物位置、姿势、头身比、服装和主体占比，不能改变场景补充的背景方向。",
      poseAnchorPrompt
    );
  }

  parts.push(
    "",
    "【场景补充】",
    sceneNote || "用户未填写具体场景时，生成干净真实的电商女装实景背景，场景简洁、自然、不过度抢服装。"
  );

  if (customPrompt) {
    parts.push(
      "",
      "【通用提示词】",
      "以下文字是随机背景页的长期规则，只能补充人物锁定、服装锁定、背景写实和批量一致性，不能覆盖场景补充。",
      customPrompt
    );
  }

  parts.push(
    "",
    "【最终检查】",
    "确认人物脸、发型、姿势、头身比、构图、服装颜色事实和细节都与图1一致；确认背景符合场景补充，且同批像同一场景体系下不同机位的真实电商实拍；确认人物和背景共用同一曝光、白平衡、主光方向、环境反光和接触阴影，没有硬抠边贴图感，整批不是有的明亮、有的背光阴天、有的暖黄、有的地面大太阳斑。"
  );

  return parts.join("\n");
}

function outpaintModelSkill(model) {
  if (model === "gpt-image") {
    return [
      "模型适配：GPT 图片编辑模型按“image + mask 扩图编辑”理解，本任务只有图1，不存在服装母版、参考图或补充图。",
      "前端已提供与上传图同尺寸的透明蒙版：不透明区域是保护区，透明区域是原图底部过渡带和下方新增画布；只在透明区域补腿、脚、鞋子、地面和背景延展。",
      "原图上方保护区不要重新绘制成另一张相似图；透明重叠带只用于自然承接腰胯/腿脚和背景纹理，不能改脸、头发、上衣、手臂、身体重心和已有背景。"
    ];
  }

  if (/^nano-banana/i.test(String(model || ""))) {
    return [
      "Nano Banana：短句硬锁执行向下扩图。",
      "图1上方原图区域保持不变。",
      "只在下方空白区域补全腿、脚、鞋子和原场景延展。",
      "不要换装、不要换脸、不要改变原图裁切内已有内容。"
    ];
  }

  return [
    "当前模型使用扩图任务短句约束。",
    "图1已有内容不变，只向下补全下半身、鞋子和场景延展。",
    "不要寻找或假设任何参考图、补充图、服装母版或额外人物。"
  ];
}

function buildOutpaintPrompt(payload) {
  const customPrompt = String(payload.prompt || "").trim();
  const productNote = String(payload.productNote || "").trim();
  const ratio = String(payload.aspectRatio || "9:16");
  const imageSize = String(payload.imageSize || "2K");
  const modelTitle = String(payload?.uploadLabels?.model?.title || "待扩图原图").trim();
  const parts = [
    "【电商批量扩图 Skill】",
    "目标：以图1为唯一原图和结构事实，把半身照或局部人物图向下扩成更完整的人物成片，补出自然下半身、腿脚和可见鞋子。这个任务是扩图，不是换装、不是换脸、不是换背景、不是重新生成一张相似图。",
    "核心原则：本任务只有图1，没有图2参考图、没有图3补充图；图1已有区域保持不变，只允许在图1下方新增画布区域继续生成；扩出来的内容要像原图同一人物、同一镜头、同一场景向下继续拍到脚。",
    "",
    `当前页面图1标题：${modelTitle}`,
    "",
    "【图片编号规则】",
    "图1：当前待扩图原图。前端已把原图放在扩图画布上方，下方留白是主要生成区域；图1已有内容是绝对事实。",
    "本次请求同时包含同尺寸编辑蒙版：不透明区域表示保护原图，透明区域表示允许编辑的原图底部过渡带和下方空白扩展区。模型只补全透明区域，保护区不重绘。",
    "不要读取、假设或复制任何其他图片；如果模型上下文里出现额外图片，也必须忽略，不能把额外图片的人物、姿势、服装、鞋子、场景或颜色带进结果。",
    "",
    "【图1原有内容硬锁定】",
    "必须保持图1原有区域完全不变：人物身份、脸、发型、肤色、头部大小、脸部朝向、上半身、手臂手掌、服装款式、服装颜色、服装细节、姿势重心、背景、光影、清晰度、相机角度和已有构图都不移动、不缩放、不重绘、不换脸、不换衣。",
    "原图上半身不能被模型重新画成一张相似照片；不能改变衣领、袖口、门襟、扣子、拉链、头发边缘、手指、身体轮廓和已有背景纹理。",
    "",
    "【下方扩展规则】",
    "只在图1下方留白区域补全：自然延续腰胯、腿部、脚踝、鞋子、脚底接触阴影、地面和背景下方空间。鞋子必须可见，不能只补到小腿或脚踝。",
    "腿脚方向、脚尖朝向、站姿重心、透视比例、人物高度和镜头距离要从图1已有身体动作推导；不要拉长腿、缩小头、改变头身比或把人物重排到画面中心。",
    "下方新增服装、腿、鞋、地面和背景要服从原图光源方向、色温、景深、清晰度和颗粒质感，边缘不能断层、错位、糊成一片或像拼接。",
    "",
    "【禁止内容】",
    "不要换装、不要换脸、不要换发型、不要改变图1已有衣服颜色和款式、不要移动人物、不要缩放人物、不要换背景、不要复制任何参考人物、不要输出对比图、不要拼贴、不要文字说明、不要水印。",
    `输出比例：${ratio}；输出清晰度：${imageSize}。`
  ];

  parts.push("", "【模型适配】", ...outpaintModelSkill(payload.model));

  if (productNote) {
    parts.push(
      "",
      "【本次补充信息】",
      "以下内容只能补充扩图方向、鞋子、地面、背景延展或客户要求；如果与图1已有内容不变冲突，必须以图1不变为准。",
      productNote
    );
  }

  if (customPrompt) {
    parts.push(
      "",
      "【用户本次提示词】",
      "以下文字只用于补充扩图目标；如果与图1原有内容硬锁定冲突，必须以图1不变为准。",
      customPrompt
    );
  }

  parts.push(
    "",
    "【最终检查】",
    "检查图1原有上方内容是否没有漂移、重绘、变脸或换衣；检查下方是否自然补出完整腿脚、可见鞋子、脚底接触阴影和同场景延展。"
  );

  return parts.join("\n");
}

// 中文注释：白底精修只读取图1服装事实，图2可选参考只补足清理边界，不迁移新款式。
function buildWhiteRefinePrompt(payload) {
  const customPrompt = String(payload.prompt || "").trim();
  const productNote = String(payload.productNote || "").trim();
  const ratio = String(payload.aspectRatio || "3:4");
  const imageSize = String(payload.imageSize || "2K");
  const referenceCount = Math.max(0, Number.parseInt(payload.whiteRefineReferenceCount || "0", 10) || 0);
  const modelTitle = String(payload?.uploadLabels?.model?.title || "批量平铺图/挂拍图").trim();
  const referenceTitle = String(payload?.uploadLabels?.clothing?.title || "可选参考/细节图").trim();
  const parts = [
    "【电商批量白底精修 Skill】",
    "目标：把图1的单件服装平铺图或挂拍图整理成干净、高清、纯白背景的电商商品图。这个任务不是换装、不是换脸、不是模特图生成，也不需要人物图。",
    "核心原则：图1是唯一服装事实和唯一款式来源。只能去背景、去衣架挂钩夹子图钉别针固定针支撑物、清理脏点杂影、修净边缘、整理压痕与杂乱褶皱；不能重设计、换颜色、换面料、换版型、商业调色或新增细节。",
    "",
    `当前页面图1标题：${modelTitle}`,
    `当前页面图2标题：${referenceTitle}`,
    "",
    "【图片编号规则】",
    "图1：当前要精修的服装平铺图/挂拍图。图1的颜色深浅、明度、饱和度、灰度、白位黑位、版型、衣长、领口、袖型、袖口、袖克夫、下摆、扣子、拉链、腰带、口袋、刺绣、印花、压线、拼接、面料纹理和真实设计细节都以图1为准。",
    referenceCount > 0
      ? `图2至图${referenceCount + 1}：可选参考/细节图，只用于确认衣架去除后的自然补齐、平铺摆放、袖口、腰带、扣子或面料细节；不得把图2的款式、颜色、图案、比例、背景或任何新结构迁移到图1。`
      : "当前没有图2参考图，只根据图1完成白底和精修；不要假设缺失的服装结构。",
    "",
    "【允许处理】",
    "背景统一为干净纯白电商白底；完整去掉衣架、挂钩、夹子、图钉、别针、固定针、支撑杆、挂拍道具、杂乱背景、脏点、杂物和不必要阴影。",
    "让服装自然平整、边缘干净、摆放端正；去掉运输压痕、固定衣服造成的尖锐折痕、凌乱皱团和干扰性褶皱，只保留符合原面料的结构褶、轻微自然松弛和合理垂感。",
    "衣架、夹子、图钉、别针、固定针或支撑物遮挡处只能用图1附近同一件服装的结构、同一面料纹理、同一颜色和同一光影自然补齐。",
    "",
    "【绝对保持】",
    "不改变图1服装的颜色、亮度、饱和度、版型、长短、松量、领口、门襟、袖长、袖口、袖克夫、扣子数量与状态、拉链、腰带长度、口袋、刺绣、印花、压线、拼接、材质、织纹和全部可见设计细节。",
    "颜色校准只以图1原服装为准：白底清理不能附带商业调色、滤镜美化、增加饱和度、增加对比度、增加油润感、加深颜色、提高高光、自动锐化或自动美化。牛仔、水洗、针织、皮革、雪纺、毛呢等面料保持图1原始色阶和自然灰度，不变深、不变艳、不发油、不发灰。",
    "牛仔专门规则：保持图1原始靛蓝深浅、水洗分布、泛白灰度、磨白位置、缝线颜色和旧感；禁止提蓝、提饱和、压暗成深蓝、新增洗水纹、新增硬褶皱纹理或把旧牛仔修成全新牛仔。",
    "不生成模特、人体、人台、手、脸、场景、文字、尺码标注、品牌 Logo、水印、吊牌说明、拼贴对比图或第二件服装。",
    "不要把服装改成虚假的过度顺滑材质；针织、皮革、牛仔、雪纺、毛呢和蕾丝等原有纹理必须保留。",
    `输出比例：${ratio}；输出清晰度：${imageSize}。`
  ];

  if (productNote) {
    parts.push("", "【本次补充信息】", "以下内容只补充白底清理或点名细节；与图1服装事实冲突时，以图1不变为准。", productNote);
  }

  if (customPrompt) {
    parts.push("", "【用户本次提示词】", "以下文字只能补充白底精修目标，不能覆盖图1款式、颜色或细节。", customPrompt);
  }

  parts.push("", "【最终检查】", "确认输出是同一件图1服装：背景纯白，衣架、夹子、图钉、别针、固定针和杂物已完整去除，边缘干净，干扰褶皱更规整；最终颜色不能比原图更艳、更深、更蓝、更高对比，版型、面料、水洗分布和全部服装细节没有变化。");
  return parts.join("\n");
}

function recolorModelSkill(model, localEditEnabled) {
  const localEditLine = localEditEnabled
    ? "本次有图1局部区域，只在选区或蒙版内做颜色替换；不要输出整张重构图，不扩展画布。"
    : "本次是整图服装改色，只改变被指定服装部位的颜色，不重绘人物和场景。";

  if (model === "gpt-image") {
    return [
      "模型适配：GPT 图片编辑模型按“保留图1原图结构的局部/整图调色”执行，不按图2重新换装。",
      "先锁定图1人物、服装款式、面料纹理、褶皱和场景，再把图2颜色自然映射到指定服装部位。",
      localEditLine,
      "重点防止颜色外溢：皮肤、头发、背景、未选服装部位和阴影边缘不能被染色。"
    ];
  }

  if (model === "nano-banana2") {
    return [
      "Nano Banana 2：短句硬锁，只做服装颜色替换。",
      "图1人物、姿势、服装款式、细节、背景全部不变。",
      "图2只给目标颜色和材质色感，不给款式。",
      localEditLine,
      "不要换衣服，不要换脸，不要换背景，不要移动人物，不要把图2服装穿到图1。"
    ];
  }

  if (model === "nano-banana-pro") {
    return [
      "Nano Banana Pro：电商质感优先，改色后仍像图1原片里的同一件衣服。",
      "保留图1原有布料纹理、扣子、拉链、腰带、刺绣、口袋、压线、褶皱和边缘阴影。",
      localEditLine,
      "图2只提供颜色标准，不能提供服装结构、人物、背景或拍摄角度。"
    ];
  }

  return [
    "当前模型使用短句硬约束执行批量改色。",
    "图1保留人物、姿势、衣服结构、场景和光影。",
    "图2只参考目标颜色、明暗、饱和度和材质色感。",
    localEditLine,
    "不要换装、不要换脸、不要换背景、不要改款式。"
  ];
}

function buildRecolorPrompt(payload) {
  const customPrompt = sanitizeOutfitCustomPrompt(payload.prompt);
  const productNote = String(payload.productNote || "").trim();
  const poseAnchorPrompt = String(payload.poseAnchorPrompt || "").trim();
  const ratio = String(payload.aspectRatio || "3:4");
  const imageSize = String(payload.imageSize || "2K");
  const garmentParts = normalizeGarmentParts(payload.garmentParts);
  const scope = garmentScope(garmentParts);
  const skipped = GARMENT_PART_OPTIONS
    .map((option) => option.value)
    .filter((part) => !garmentParts.includes(part));
  const skippedText = skipped.map(garmentPartLabel).join("、");
  const colorReferenceCount = Number.parseInt(payload.colorReferenceCount || "0", 10) || 0;
  const referenceCount = Number.parseInt(payload.referenceCount || "0", 10) || 0;
  const localEditEnabled = Boolean(payload.localEdit?.enabled || payload.localEdit === true);
  const localEditIsMask = localEditEnabled && String(payload.localEdit?.editMode || "") === "mask";
  const localEditHasContext = localEditEnabled && Boolean(payload.localEdit?.contextRect);
  const modelTitle = String(payload?.uploadLabels?.model?.title || "批量原图/模特图").trim();
  const colorTitle = String(payload?.uploadLabels?.clothing?.title || "改色服装参考图").trim();
  const referenceTitle = String(payload?.uploadLabels?.reference?.title || "补充参考图").trim();
  const colorEndIndex = 2 + colorReferenceCount;
  const referenceStartIndex = 3 + colorReferenceCount;
  const parts = [
    "【电商批量服装改色 Skill】",
    "目标：只把图1当前人物里指定服装部位的颜色改成图2颜色参考的效果，生成自然真实的电商成片。这个任务是服装改色，不是换装、不是换脸、不是换背景、不是重新拍一张相似图。",
    "核心原则：图1是唯一底图和结构来源；图2只提供目标颜色、明暗关系、饱和度和材质色感。图1除指定服装颜色外，其它内容都保持原样。",
    "",
    `当前页面图1标题：${modelTitle}`,
    `当前页面图2标题：${colorTitle}`,
    `当前页面图3标题：${referenceTitle}`,
    "",
    "【图片编号规则】",
    "图1：当前要改色的人物原图。人物身份、脸、发型、肤色、身体姿势、手脚动作、场景、背景、构图、镜头、光影、服装款式、版型、长度、穿法、褶皱、纹理和全部细节都以图1为准。",
    "图2：主颜色参考图。只读取目标颜色、明暗深浅、饱和度、材质色感、高光和阴影色彩倾向；不能读取图2人物、服装款式、服装版型、穿法、姿势、背景或拍摄光影结构。",
    colorReferenceCount > 0
      ? `图3至图${colorEndIndex}：图2上传区的额外颜色参考图，只作为同一目标颜色或局部材质色感补充；不能升级为新服装母版，也不能改变图1服装结构。`
      : "当前没有额外颜色参考图时，只以图2主颜色参考为准，不凭空增加第二种配色。",
    referenceCount > 0
      ? `模型输入中的图${referenceStartIndex}及后续 ${referenceCount} 张：来自前端图3补充区，只能按用户文字补充颜色边界、禁忌或局部说明；不能改变图1人物和服装结构。`
      : "当前没有图3补充图时，不要凭空添加图案、道具、文字、水印、品牌 Logo 或新设计。",
    "",
    "【改色范围】",
    `本次只允许改变图1这些服装部位的颜色：${scope.labels}。`,
    "指定部位的服装款式、版型、衣长、袖长、袖口、袖克夫、扣子、拉链、腰带、口袋、刺绣、印花、压线、结构线、面料纹理、厚薄、垂感、褶皱和边缘阴影全部保留图1原样。",
    skippedText
      ? `未选中的图1部位必须保持原样：${skippedText}；不要因为图2里出现这些部位就顺手改色、换款或重绘。`
      : "当前选择了全部服装部位，也只允许改颜色，不允许改款式、版型、穿法或场景。",
    ...recolorScopeLockRules(scope),
    "如果图1同一件衣服跨过手臂、头发、皮肤或背景边缘，颜色只贴合服装真实区域；不要染到皮肤、头发、脸、脖子、手、腿、鞋底、背景或道具。",
    "",
    "【颜色迁移规则】",
    "目标颜色要来自图2：色相、明暗、饱和度、高光颜色、阴影颜色和材质色感按图2参考；但光影形状、褶皱走向、纹理方向、边缘阴影和衣服结构仍按图1。",
    "颜色校准以图2主颜色参考为准：不要增加饱和度、对比度、油润感、高光或商业滤镜；同批保持同一目标色阶，不变深、不变艳、不发油、不发灰。",
    "同批结果颜色必须统一稳定：不能一张偏浅、一张偏深、一张偏灰、一张高饱和；不能为了商业感自动提亮、泛白、降饱和或把目标色改成更好看的相近色。",
    "改色方式要像真实布料/皮革/针织在原光影下自然呈现，不是平铺色块；保留图1原有明暗层次、材质颗粒、织纹、压线、金属件反光和自然褶皱。",
    "禁止出现颜色断层、边缘光圈、涂抹感、局部漏色、旧颜色残留、皮肤染色、背景染色、全图偏色、图2款式迁移或把图1服装重新设计成另一件衣服。",
    "",
    "【图1局部编辑】",
    localEditEnabled
      ? localEditIsMask
        ? "图1已指定涂抹区域：只处理被涂抹区域内的目标服装颜色，未涂抹区域只作为原图连续光影、纹理和边缘参考；输出画布必须和输入局部一致。"
        : "图1已指定框选区域：只处理选区内的目标服装颜色，保持当前选区构图、角度、画布边界和边缘连续，不输出整张重构图。"
      : "未指定图1局部区域时，按整图改色生成；仍只改变被指定服装部位颜色，不重绘人物和场景。",
    localEditHasContext
      ? "图1局部可能包含比实际修改范围更大的周边画面；外围只用于对齐光影、纹理、皮肤、背景和服装边缘，不要重构外围内容。"
      : "",
    "",
    "【批量一致性】",
    "批量生成时，每张图只处理当前图1；图2颜色标准在整批中保持一致。不同图1因原光影不同可以有自然明暗变化，但目标颜色的色相、深浅和材质色感要像同一批商品拍摄。",
    "不要让同一批出现不同颜色版本、不同款式版本、不同尺码感或不同场景调色；统一的是服装目标颜色，不是重拍人物或重做背景。",
    "",
    "【禁止内容】",
    "不要换脸、不要换发型、不要改肤色、不要移动人物、不要换姿势、不要换背景、不要换衣服款式、不要改服装版型、不要改扣子拉链腰带口袋刺绣、不要新增图案、不要删除原有细节、不要输出对比图、不要拼贴、不要文字说明、不要水印。"
  ];

  parts.push("", "【模型提示词适配】", ...recolorModelSkill(payload.model, localEditEnabled));

  if (localEditEnabled) {
    parts.push("", ...localEditMaterialContinuityRules(localEditIsMask));
  }

  if (poseAnchorPrompt) {
    parts.push(
      "",
      "【智能文本锚点】",
      "以下锚点只能帮助识别图1服装边界和人物坐标；不能扩大改色范围，也不能改变图1人物、场景或服装结构。",
      poseAnchorPrompt
    );
  }

  if (productNote) {
    parts.push(
      "",
      "【本次补充信息】",
      "以下内容只能补充目标颜色、色深、饱和度、材质色感或禁忌边界；如果要求改变人物、场景、款式、版型或细节，必须忽略对应部分。",
      productNote
    );
  }

  if (customPrompt) {
    parts.push(
      "",
      "【用户本次提示词】",
      "以下文字用于补充改色目标；如果与图1结构锁定或图2只提供颜色冲突，必须以硬规则为准。",
      customPrompt
    );
  }

  parts.push(
    "",
    "【最终检查】",
    "检查人物脸、发型、肤色、姿势、场景、构图和服装款式细节是否仍与图1一致；检查指定服装部位颜色是否按图2统一自然改变，同批没有明显色差，并且没有染到皮肤、背景或未选服装部位。",
    `输出比例：${ratio}；输出清晰度：${imageSize}。`
  );

  return parts.filter((line) => line !== "").join("\n");
}

function faceSwapModelSkill(model) {
  if (model === "gpt-image") {
    return [
      "模型适配：GPT 图片编辑模型按“同图局部换脸”执行，不按图2重拍整个人。",
      "图1是唯一底图：身体、服装、衣领、肩膀、姿势、背景、光影、裁切、头部坐标、头部大小、脸部朝向、下巴、脖子肩线和头身比都保持图1。",
      "图2主导头脸妆造：脸型、五官、肤色妆容色调、发型整体轮廓、发量、发顶、发色、刘海、发缝、贴脸发丝、头饰、发饰和耳饰都以图2母图为准；不要被图1原脸型、原发型、原头饰干扰。",
      "图2脖子以下全部无效，不复制图2头部姿态、衣服、衣领、肩膀、身体、背景、镜头或场景；如果开启局部回贴，只生成当前脸部/头发选区，不输出整张图，不扩展画布，不添加边框。"
    ];
  }

  if (model === "nano-banana2") {
    return [
      "模型适配：Nano Banana 2 容易移动头脸，必须使用短句硬锁。",
      "图1头部坐标不变，脸中心不变，头大小不变，脸朝向不变，下巴不变，脖子肩线不变，头身比不变。",
      "脸型、五官、脸部肤色妆容、发型轮廓、发量、发色、刘海、发缝、头饰和发饰来自图2母图；不要保留图1原脸型、原发型或原头饰。",
      "不换身体，不换衣服，不换背景，不重新摆拍；图2脖子以下全部无效，不复制图2头部姿态、姿势、镜头、光线、衣服、衣领、肩膀或背景。",
      "局部回贴时只输出选区内的脸部结果，脸部主体接近图2脸母图肤色妆容，边缘保持图1同角度、同光影、同皮肤明暗过渡。"
    ];
  }

  if (model === "nano-banana-pro") {
    return [
      "模型适配：Nano Banana Pro 偏写实商业图，重点让换脸后仍像图1原片自然拍摄。",
      "保留图1构图、头脸位置、头部外接框、下巴脖子接口、头身比、身体服装、衣领肩膀和背景；图2提供身份、五官、脸型、发型整体轮廓、发色、刘海、头饰/发饰和脸部妆容色调。",
      "融合图2脸型发型头饰时，边缘承接图1光影和清晰度；图2脖子以下和头部姿态无效，不能换衣服、带入图2衣领肩膀、图2身体或图2背景。"
    ];
  }

  return [
    "模型适配：当前模型使用短句硬约束执行换脸。",
    "图1保持位置、头部大小、脸朝向、下巴、脖子肩线、头身比、身体、衣服、衣领、肩膀、背景。",
    "图2提供人脸身份、五官、脸型、脸部肤色妆容色调、发型整体轮廓、发色、头饰和发饰；图1原脸型发型头饰不作为参考，图2脖子以下和头部姿态无效。",
    "只换脸，不换身体，不换装，不移动人物，不输出拼贴对比图。"
  ];
}

function buildFaceSwapPrompt(payload) {
  const customPrompt = sanitizeFaceSwapCustomPrompt(payload.prompt);
  const productNote = String(payload.productNote || "").trim();
  const poseAnchorPrompt = String(payload.poseAnchorPrompt || "").trim();
  const ratio = String(payload.aspectRatio || "1:1");
  const imageSize = String(payload.imageSize || "2K");
  const referenceCount = Number.parseInt(payload.referenceCount || "0", 10) || 0;
  const localEditEnabled = Boolean(payload.localEdit?.enabled || payload.localEdit === true);
  const localEditIsMask = localEditEnabled && String(payload.localEdit?.editMode || "") === "mask";
  const modelTitle = String(payload?.uploadLabels?.model?.title || "目标人物图").trim();
  const faceTitle = String(payload?.uploadLabels?.clothing?.title || "人脸参考图").trim();
  const referenceTitle = String(payload?.uploadLabels?.reference?.title || "妆容/表情补充图").trim();
  const parts = [
    "【电商批量换脸 Skill】",
    "目标：以图1为唯一底图，把图2母图的脸部身份、脸部肤色妆容色调、脸型、发型整体轮廓、头饰和发饰自然融合到图1原头部坐标。这个任务是同图换脸，不换衣、不换场景、不是按图2重拍人物。",
    "核心原则：图1负责画面事实、坐标、身体服装背景和头颈几何；图2负责脸型、五官、发型、头饰/发饰、耳饰和脸部妆容色调。图1原脸型、原发型、原头饰不作为结果参考；图2脖子以下和图2头部姿态全部无效。",
    "",
    `当前页面图1标题：${modelTitle}`,
    `当前页面图2标题：${faceTitle}`,
    `当前页面图3标题：${referenceTitle}`,
    "",
    "【图片编号规则】",
    "图1：唯一底图和画面事实来源。必须保留图1人物身体、服装、衣领、肩膀、姿势、场景、背景、构图、镜头距离、头部位置、头部大小、脸部朝向、下巴位置、脖子肩线、头身比和原始光影；图1原脸型、原发型、原头饰只视为要被图2覆盖的干扰来源。",
    "图2：头脸妆造母图。提取脸部身份、五官比例、脸型轮廓、肤色明暗、妆容质感、口红色相、发型整体轮廓、发量体积、发顶高度、发色趋势、刘海、发缝、卷直程度、贴脸发丝方向、头饰、发饰和耳饰；图2衣服、衣领、肩膀、身体和背景全部忽略。",
    referenceCount > 0
      ? `图3及后续 ${referenceCount} 张：可选补充参考，只能用于补充妆容、表情、年龄感、肤色细节、客户要求或禁忌，不允许改变图1身体服装和背景。`
      : "当前没有图3补充图时，不要凭空添加图2没有的额外妆容、头饰、发饰、文字、水印或新背景。",
    "",
    "【图1硬锁定】",
    "必须保持图1人物头部中心坐标、脸部朝向、脸部倾斜、头部大小、头颈关系、肩颈方向、身体比例、服装款式、服装颜色、衣领肩膀、手脚姿势、背景和画面裁切不变。",
    "以图1头颈几何为不可移动模板：脸中心、双眼连线倾斜、下巴、下颌角、脖子上缘、锁骨/衣领交界、双肩基线、头身比和人物主体占比都不能变。发型轮廓、发量、发顶和头饰可以按图2母图替换，但必须落在图1头部坐标附近并自然遮挡原背景。",
    "禁止把头摆正、把脸重新居中、移动头部、缩放头部、改变脖子长度或粗细、改变下巴到锁骨/衣领距离、改变肩线、改变身体、换衣服、换衣领、换背景、改变光源方向或重构画面；同时禁止继续保留图1原脸型、原发型或原头饰导致不像图2母图。",
    "",
    "【图2身份迁移】",
    "迁移图2头脸妆造：五官结构、脸型轮廓、肤色明暗、妆容质感、口红色相、发型整体轮廓、发量体积、发顶高度、发色、刘海方向、发缝趋势、贴脸发丝方向、头饰、发饰和耳饰。脸部主体色调以图2脸母图为主，边缘过渡适配图1原有脸部角度、头部倾斜、光影方向和清晰度。",
    "图2脖子以下全部无效：图2服装、衣领、肩膀、身体比例、姿势、背景、拍摄角度和整体穿搭不能进入结果；图2头部姿态、低头/歪头/仰头角度、下巴位置和头身比例也不能覆盖图1。",
    "如果图2与图1角度不同，只把图2脸型发型头饰适配到图1原脸部朝向和头部坐标；不能让图1头部跟着转向图2，不能把图1头身比改成图2母图头身比。发型/头饰迁移时可以覆盖图1原头发与原头饰，但不能重绘图1服装、肩颈、背景或场景。",
    "",
    ...faceSwapBatchToneRules(),
    "",
    "【局部回贴模式】",
    localEditEnabled
      ? localEditIsMask
        ? "本次已开启涂抹蒙版局部回贴：图1发送给模型的是包含涂抹脸部/头发/局部细节周边上下文的选区。未涂抹区域只作为头部坐标、脸部朝向、背景边界和光影参考，重点处理被涂抹的人脸身份、脸型、发型或头饰区域；画布比例和选区一致，不要输出整张人物图，不要添加边框，不要扩展画布；系统会只把涂抹区域羽化贴回原图同一坐标。"
        : "本次已开启局部回贴：图1发送给模型的是原图脸部附近选区。只输出这个选区内的换脸/换发型/换头饰结果，画布比例和选区一致，不要输出整张人物图，不要添加边框，不要扩展画布；系统会把结果贴回原图同一坐标。选区边缘要保持原图背景、衣领肩膀和光影连续。"
      : "如未开启局部回贴，也必须只改变脸部身份、脸型、发型和头饰，不要改变图1身体、服装、衣领、肩膀、背景、头部位置、头部大小、脖子肩线、头身比和构图。",
    "",
    "【真实融合】",
    "换脸后要像图1现场真实拍摄出来的人，但头脸妆造像图2母图：脸部身份、脸型、发型、头饰、肤色明暗、妆容质感、唇色饱和度和面部清晰度接近同一张图2脸母图，边缘曝光、阴影、噪点、镜头质感和周围背景边界自然承接图1。不能出现面具感、贴纸感、边缘硬切、双脸、错位五官、过度磨皮、脸部漂移或头发背景被大片重绘。",
    "",
    "【禁止内容】",
    "不要换衣、不要复制图2服装、不要复制图2衣领肩膀、不要复制图2头部姿态、不要换身体、不要换背景、不要复制图2场景、不要移动人物、不要改变头部大小、不要改变脖子、不要改变头身比、不要保留图1原脸型/原发型/原头饰干扰图2母图、不要新增人物、不要输出对比图、拼贴图、文字、水印、标注框或步骤图。",
    `输出比例：${ratio}；输出清晰度：${imageSize}。`
  ];

  parts.push("", ...faceSwapHairStyleRules());
  if (localEditEnabled) {
    parts.push("", ...localEditMaterialContinuityRules(localEditIsMask));
  }

  parts.push("", "【模型提示词适配】", ...faceSwapModelSkill(payload.model));

  if (poseAnchorPrompt) {
    parts.push(
      "",
      "【智能介入：图1头脸坐标锚点】",
      "以下锚点来自文本/视觉模型对图1的预分析，优先级高于用户补充信息；用于让当前生图模型保持图1头部坐标、脸部朝向、下巴脖子接口、头身比和人物站位。注意：锚点里的图1原发型、发饰或头饰只用于定位与边界，不能覆盖图2母图发型头饰。",
      poseAnchorPrompt
    );
  }

  if (productNote) {
    parts.push(
      "",
      "【本次补充信息】",
      "以下内容只能补充换脸目标、妆容表情或客户要求；如果和图1硬锁定冲突，必须以图1头脸坐标和身体背景不变为准。",
      productNote
    );
  }

  if (customPrompt) {
    parts.push(
      "",
      "【用户本次提示词】",
      "以下文字只用于补充本次换脸目标；如果与图1头部坐标、身体服装背景不变冲突，必须以上方硬规则为准。",
      customPrompt
    );
  }

  parts.push(
    "",
      "【最终检查】",
    "检查脸部身份、脸型、脸部色调、发型整体轮廓、发色、刘海、头饰和发饰是否来自图2；检查是否被图1原脸型、原发型或原头饰干扰；检查同批结果的口红色相和饱和度、肤色明暗、妆容浓淡、面部对比度、磨皮程度和清晰度是否统一；检查图1头部坐标、脸部角度、头部大小、下巴、脖子肩线、头身比、身体、服装、衣领、肩膀、背景和画面裁切是否未变化；检查是否完全没有图2衣服、图2身体、图2背景、图2拍摄角度和图2头部姿态。"
  );

  return parts.join("\n");
}

function localDetailModelSkill(model, localEditEnabled) {
  const localLine = localEditEnabled
    ? "只输出图1选区内的局部结果，保持选区坐标、角度、边缘光影和纹理连续。"
    : "未指定图1局部区域时，不执行整图换装；请先选择图1局部区域。";

  if (model === "gpt-image") {
    return [
      "GPT：按图层修补逻辑执行，先读图1原衣服的颜色、材质、明暗和边缘，再把图2的点名结构融入同一件衣服。",
      localLine
    ];
  }

  if (model === "nano-banana2") {
    return [
      "Nano Banana 2：短句硬锁，局部结果必须贴合图1原坐标。",
      "不要重排人物、头颈、肩线、手脚或整件服装；不要把图2颜色带入图1。",
      localLine
    ];
  }

  return [
    "Nano Banana：只做局部细节替换，不做整件换装或重新设计。",
    "图2只给结构，颜色和基础材质跟图1。",
    localLine
  ];
}

function buildLocalDetailOutfitPrompt(payload) {
  const customPrompt = String(payload.prompt || "").trim();
  const productNote = String(payload.productNote || "").trim();
  const poseAnchorPrompt = String(payload.poseAnchorPrompt || "").trim();
  const ratio = String(payload.aspectRatio || "3:4");
  const imageSize = String(payload.imageSize || "2K");
  const referenceCount = Number.parseInt(payload.referenceCount || "0", 10) || 0;
  const localEditEnabled = Boolean(payload.localEdit?.enabled || payload.localEdit === true);
  const localEditIsMask = localEditEnabled && String(payload.localEdit?.editMode || "") === "mask";
  const localEditHasContext = localEditEnabled && Boolean(payload.localEdit?.contextRect);
  const parts = [
    "【局部服装细节 Skill】",
    "任务：在图1指定局部区域内修改用户点名的服装细节，生成局部结果；这不是整图换装。",
    "图1是唯一画面底图：颜色、基础材质、明暗、光影、纹理尺度、人物位置和周边衔接都以图1为准。",
    "图2只参考被点名细节的结构、形状、五金、缝线、褶位、纹理走势或工艺位置；不参考图2颜色、色温、曝光、背景，也不把图2当整件服装来源。",
    "只修改用户点名的衣领、袖口、口袋、扣子、拉链、局部纹理、局部瑕疵或服装细节；选区外和未点名区域保持图1原样。",
    "新细节必须像原本长在图1这件衣服上，不能出现突兀色块、材质断层、边缘错位或人物位置变化。"
  ];

  if (referenceCount > 0) {
    parts.push(`图3及后续 ${referenceCount} 张只做可选补充：用于补充局部结构、客户要求或禁忌，不覆盖图1颜色材质，也不替代图2结构参考。`);
  }

  if (localEditEnabled) {
    parts.push(
      "",
      "【图1局部区域触发】",
      localEditIsMask
        ? "图1已指定涂抹区域：重点处理被涂抹区域，未涂抹区域只作为同一衣服的颜色、纹理、褶皱、光影和边缘参考。"
        : "图1已指定框选区域：只生成这个选区内的局部细节结果，输出画布必须和选区一致。",
      localEditHasContext
        ? "图1可能包含比实际修改范围更大的周边画面；外围只用于对齐纹理、衣缝、皮肤、背景、光影和透视，不要重构外围内容。"
        : "",
      ...localEditMaterialContinuityRules(localEditIsMask)
    );
  } else {
    parts.push("", "【图1局部区域触发】", "当前没有图1局部区域，不要执行整图换装；请先选择图1局部区域。");
  }

  parts.push("", "【模型适配】", ...localDetailModelSkill(payload.model, localEditEnabled));

  if (poseAnchorPrompt) {
    parts.push("", "【智能文本锚点】", poseAnchorPrompt);
  }

  if (productNote) {
    parts.push("", "【本次补充】", productNote);
  }
  parts.push("", ...explicitDeletionRequestLines(payload));

  if (customPrompt) {
    parts.push("", "【前端提示词】", customPrompt);
  }

  parts.push("", `输出比例：${ratio}；输出清晰度：${imageSize}。`);
  return parts.join("\n");
}

/**
 * 批量生成是否自动追加 SKILL / 服装规则的**临时开关**。
 *
 * 2026-09-25 本轮默认**关闭**：方便用户先看模型的原生效果（不追加批量换装、
 * 图1/图2关系、服装类别、成衣比例/长度等自动规则）。
 *
 * 恢复办法（二选一，都不需要改回下面的任何规则代码）：
 *   1. 把这个常量改成 true；
 *   2. 或者让前端在 `/api/generate-outfit` 的 payload 里传 `batchSkillRules: true`
 *      （批量页的开关就是这个字段，见 src/outfit-workflow.jsx）。
 *
 * 所有规则常量与 `build*Prompt` 实现全部保留，本轮没有删除任何一条规则。
 */
export const BATCH_SKILL_ENABLED_BY_DEFAULT = false;

/** 解析当前请求是否要追加批量 SKILL 规则（请求字段优先于默认值）。 */
export function batchSkillRulesEnabled(payload) {
  const raw = payload?.batchSkillRules ?? payload?.batch_skill_rules;
  if (raw === true || raw === 1 || raw === "1" || raw === "true") return true;
  if (raw === false || raw === 0 || raw === "0" || raw === "false") return false;
  return BATCH_SKILL_ENABLED_BY_DEFAULT;
}

/**
 * SKILL 关闭时的最终提示词：**只有用户自己输入的文字**。
 * 不含任何自动追加的规则块，也不动模型/渠道/图片等其它请求字段。
 */
export function buildUserPromptOnly(payload) {
  const lines = [];
  const customPrompt = String(payload?.prompt || "").trim();
  const poseAnchorPrompt = String(payload?.poseAnchorPrompt || "").trim();
  const productNote = String(payload?.productNote || "").trim();
  if (customPrompt) lines.push(customPrompt);
  if (poseAnchorPrompt) lines.push(poseAnchorPrompt);
  if (productNote) lines.push(productNote);
  return lines.join("\n\n");
}

export function buildOutfitPrompt(payload) {
  // 临时开关：关闭时只发用户原始提示词，不做任何自动追加（本轮默认关闭）。
  if (!batchSkillRulesEnabled(payload)) {
    return buildUserPromptOnly(payload);
  }

  if (isCustomWorkflow(payload)) {
    return buildCustomPrompt(payload);
  }

  if (isWhiteRefineWorkflow(payload)) {
    return buildWhiteRefinePrompt(payload);
  }

  if (isLocalDetailWorkflow(payload)) {
    return buildLocalDetailOutfitPrompt(payload);
  }

  if (isFaceSwapWorkflow(payload)) {
    return buildFaceSwapPrompt(payload);
  }

  if (isPoseRemixWorkflow(payload)) {
    return buildPoseRemixPrompt(payload);
  }

  if (isRandomBackgroundWorkflow(payload)) {
    return buildRandomBackgroundPrompt(payload);
  }

  if (isOutpaintWorkflow(payload)) {
    return buildOutpaintPrompt(payload);
  }

  if (isRecolorWorkflow(payload)) {
    return buildRecolorPrompt(payload);
  }

  if (isBackgroundChangeWorkflow(payload)) {
    return buildBackgroundChangePrompt(payload);
  }

  if (isDesignDraftWorkflow(payload)) {
    return buildDesignDraftPrompt(payload);
  }

  const customPrompt = String(payload.prompt || "").trim();
  const productNote = String(payload.productNote || "").trim();
  const poseAnchorPrompt = String(payload.poseAnchorPrompt || "").trim();
  const ratio = String(payload.aspectRatio || "3:4");
  const imageSize = String(payload.imageSize || "2K");
  const referenceCount = Number.parseInt(payload.referenceCount || "0", 10) || 0;
  const localEditEnabled = Boolean(payload.localEdit?.enabled || payload.localEdit === true);
  const localEditIsMask = localEditEnabled && String(payload.localEdit?.editMode || "") === "mask";
  const localEditHasContext = localEditEnabled && Boolean(payload.localEdit?.contextRect);
  const localEditBanana2 = localEditEnabled && /^nano-banana2$/i.test(String(payload.model || ""));
  const referenceMentioned = mentionsOptionalReference(payload);
  const garmentParts = normalizeGarmentParts(payload.garmentParts);
  const garmentLengthLines = buildGarmentLengthSkill(garmentParts, payload.garmentLengths);
  if (localEditEnabled) {
    return buildQuickStyleOutfitLocalEditPrompt(payload);
  }
  const parts = [
    "【批量生成换装 Skill】",
    "任务：让图1当前人物穿着图2服装，生成自然干净的电商成片。批量时每次只处理当前这张图1，图2在整批中保持同一服装标准。",
    "以图1为人物姿势和构图基准：身份、发型、原脸质感、身材比例、姿态、手部姿势、手脚动作、镜头、背景、光影和画面位置都保持；不磨皮、不变脸。",
    "图1模特身上的原服装不作为图2服装的款式、版型、大小、松量或长度参考；图1的服装不做任何款式参考，只用于理解身体遮挡、姿态和原图光影。",
    "图2负责服装事实：只提取服装本身，不复制图2人物、姿势、背景或无关道具。",
    "只做真实穿着适配和自然褶皱；不要按模型审美把图2服装改短、收腰、修身、瘦身、变顺滑、变完美或简化细节。",
    "袖子状态按图2实际穿法执行：放下就放下，卷起就卷起，挽起就挽起；袖口落点、袖克夫长度、卷袖高度和层数不要上提、缩短、放下或随机变化。",
    "遇到图1抬手、手贴脸、扶头、叉腰、手插袋或肘部弯曲动作时，长袖仍必须按图2的相对袖长落到手腕、掌根或掌心附近；不能为了适配姿势把长袖自动变九分袖。",
    "扣子、拉链、门襟开合和衣摆扎法按图2保持；如果涉及扎入下装，先识别当前图1真实下装类型，再把图2同样的扎入位置和露出边界适配过去，避免把图1裤子误写成裙子或把裙子误写成裤子。",
    "服装颜色校准以图2原服装为准：原本亮度、颜色、饱和度、面料光泽、高光强度和阴影深浅按图2保持；适配图1环境时只做自然融合，不增加饱和度、对比度、油润感、高光或商业滤镜；同批保持同一服装色阶，不变浅、不变深、不变艳、不发油、不发灰，也不要因图1环境自动改色。",
    "电商成片需要服装干净平整：消除衣服全部杂乱压痕、多余自然褶皱和凌乱皱团，衣身平整垂顺，只保留轻微自然松弛垂感；不抹平面料原有针织肌理，珍珠钻饰、钻扣、口袋、扣子、拼接线和版型线条完整无改动。",
    "不要给场景或人物加入额外噪点、麻点、斑点、脏颗粒或压缩痕迹；保持图1原片的干净质感。"
  ];

  parts.push("", ...outfitClothingFactLockLines(garmentParts));
  parts.push("", "【图2迁移范围】", ...buildGarmentPartSkill(garmentParts));
  if (garmentLengthLines.length > 0) {
    parts.push("", "【服装长度落点】", ...garmentLengthLines);
  }
  parts.push("", ...buildMasterFitLockSkill(payload));

  if (referenceCount > 0 && referenceMentioned) {
    parts.push(`用户文字已明确说明图3用途；图3及后续 ${referenceCount} 张只按用户说明弱参考，不能替代图2服装。`);
  }

  if (localEditEnabled) {
    parts.push(
      "",
      "【图1局部区域】",
      localEditIsMask
        ? "图1已指定涂抹区域：只处理被涂抹区域，未涂抹区域用于理解姿态、光影、肤色、背景和衣纹；输出画布必须和选区一致。"
        : "图1已指定框选区域：只生成这个选区内的换装/细节修正结果，输出画布必须和选区一致。",
      localEditHasContext
        ? "图1可能包含比实际修改范围更大的周边画面；外围只用于对齐头脸、发丝、肩颈、背景线条、光影和透视，不要重构人物坐标。"
        : "",
      localEditBanana2
        ? "Nano Banana 2 局部区域：把图1局部当成固定坐标画面，只处理换装目标，不重新摆拍或重构人物。"
        : "",
      "选区边缘延续原图光影、肤色、背景和服装纹理；未被用户要求改变的面料事实保持原图观感。"
    );
  }

  parts.push("", "【模型适配】", ...modelPromptSkill(payload.model, { localEditEnabled }));

  if (poseAnchorPrompt) {
    parts.push("", "【智能文本锚点】", poseAnchorPrompt);
  }

  if (productNote) {
    parts.push("", "【本次补充】", productNote);
  }
  parts.push("", ...explicitDeletionRequestLines(payload));

  if (customPrompt) {
    parts.push("", "【前端提示词】", customPrompt);
  }

  parts.push("", `输出比例：${ratio}；输出清晰度：${imageSize}。`);

  return parts.join("\n");
}
