const BASE_SKILL = {
  id: "jingyin-detail-base-v1",
  name: "通用底座",
  productAuthenticityLock: [
    "商品图是唯一商品事实来源，生成时不得擅自改变颜色、结构、材质、五金、logo、纹理、比例和关键细节。",
    "参考图只用于理解氛围、配色、构图、场景或版式，不得把参考图中的其它商品、品牌、人物身份、文字水印混入目标商品。",
    "多张人物图、多张商品图同时出现时，身份和商品必须分离，禁止把不同人物五官、身形、服装和商品结构互相融合。",
    "当提示词与商品图冲突时，以商品图为准；当提示词与平台规则冲突时，以合规和真实性为准。"
  ],
  outputJsonFormat: {
    description: "详情提示词规划接口必须返回结构化 JSON，便于前端确认、单屏重刷、批量并发和后续计费。",
    requiredGroupFields: ["id", "label", "createdAt", "status", "params", "analysis", "rounds", "prompts"],
    requiredPromptFields: [
      "screen",
      "title",
      "summary",
      "intervention",
      "referenceStrategy",
      "productFileIndexes",
      "referenceFileIndexes",
      "text",
      "enabled",
      "status"
    ]
  },
  screenCountRule: {
    min: 1,
    max: 12,
    defaultCount: 8,
    guidance: "分屏数量由用户选择。少屏强调主视觉和核心卖点，多屏补充材质、场景、参数、信任背书和转化收尾。"
  },
  imageNumberRules: [
    "每一屏提示词里的图1、图2、图3只代表本次提交给图片接口的附件顺序，不代表用户素材库的全局顺序。",
    "图1优先放目标商品主图，保证模型先锁定商品身份。",
    "需要模特或固定服装时，按本屏任务明确声明图1、图2的角色，避免模型错穿、混穿或换款。",
    "同一屏最多保留必要参考图，避免把所有素材同时送入造成主体漂移和风格割裂。"
  ],
  globalStyleConsistency: [
    "同一组详情页保持统一色彩体系、字体层级、光线方向、边距节奏和背景质感。",
    "首屏负责吸引，后续屏幕负责解释，收尾负责转化，不能每屏像不同店铺的独立海报。",
    "产品大小和透视要连贯，细节屏可以近景但不得改变商品结构。"
  ]
};

const INDUSTRY_SKILLS = {
  apparel: {
    id: "apparel",
    name: "服装鞋包",
    keywords: ["女装", "男装", "童装", "服装", "上衣", "衬衫", "毛衣", "裙", "裤", "外套", "鞋", "靴", "包", "箱包", "面料", "袖口", "领口", "版型", "穿搭", "模特", "假两件"],
    analyzeAttributes: ["款式结构", "版型轮廓", "面料肌理", "袖口/领口/纽扣/拉链", "穿着场景", "模特比例和姿态", "搭配关系"],
    sellingAngles: ["版型修饰身形", "面料肌理清晰", "袖口/领口/纽扣细节", "通勤与日常穿搭", "舒适亲肤体验", "多场景搭配"],
    recommendedScreens: ["首屏主视觉", "版型结构", "材质细节", "穿着体验", "使用场景", "痛点反转", "信任背书", "收尾转化"],
    visualAnchors: ["柔和四面光", "低反差", "真实面料纹理", "自然模特姿态", "干净浅色背景", "产品边缘清楚"],
    taboos: ["不要改款式结构", "不要改变袖口层次、纽扣颜色和领口形态", "不要让模特身份互相融合", "不要把参考图衣服穿到目标商品上"],
    qcRules: ["检查衣服结构是否变形", "检查左右袖口和纽扣是否一致", "检查面料纹理是否真实", "检查模特手脚是否畸形", "检查文案是否遮挡商品"]
  },
  beauty: {
    id: "beauty",
    name: "美妆护肤",
    keywords: ["护肤", "美妆", "口红", "粉底", "精华", "面霜", "乳液", "香水", "彩妆", "瓶身", "膏体", "妆容"],
    analyzeAttributes: ["瓶身形态", "包装材质", "标签文字", "膏体/液体质地", "肤感场景", "成分表达边界"],
    sellingAngles: ["质地肤感", "包装质感", "使用仪式感", "成分氛围", "便携与场景", "礼赠属性"],
    recommendedScreens: ["首屏主视觉", "核心卖点", "材质细节", "使用场景", "参数说明", "信任背书", "收尾转化"],
    visualAnchors: ["干净高光", "玻璃/亚克力台面", "液体质感", "局部特写", "柔焦但产品清晰"],
    taboos: ["不要生成医疗疗效承诺", "不要虚构成分认证", "不要改瓶型和标签", "不要生成前后对比的夸张效果"],
    qcRules: ["检查瓶身文字是否乱码", "检查包装形态是否一致", "检查功效文案是否合规", "检查高光是否过曝"]
  },
  food: {
    id: "food",
    name: "食品饮品",
    keywords: ["食品", "零食", "饮品", "茶", "咖啡", "饼干", "蛋糕", "牛奶", "水果", "坚果", "调味", "生鲜", "包装袋"],
    analyzeAttributes: ["包装规格", "口味线索", "食材状态", "食用场景", "保鲜和产地表达", "人群需求"],
    sellingAngles: ["口感联想", "真实食材", "独立包装", "分享场景", "早餐/下午茶/夜宵", "送礼或囤货"],
    recommendedScreens: ["首屏主视觉", "核心卖点", "使用场景", "参数说明", "信任背书", "收尾转化"],
    visualAnchors: ["自然食欲感", "包装清晰", "食材新鲜", "暖光不过黄", "干净餐桌"],
    taboos: ["不要虚构产地和认证", "不要夸大健康疗效", "不要让食物看起来变质", "不要改包装品牌文字"],
    qcRules: ["检查包装是否变形", "检查食材是否自然", "检查保质/产地文案是否虚假", "检查画面是否过度油腻"]
  },
  home: {
    id: "home",
    name: "家居百货",
    keywords: ["家居", "收纳", "床品", "杯", "灯", "餐具", "厨房", "居家", "清洁", "椅", "桌", "柜", "浴室"],
    analyzeAttributes: ["结构尺寸", "材质耐用性", "收纳容量", "空间适配", "使用动作", "清洁维护"],
    sellingAngles: ["空间适配", "材质耐用", "使用便利", "尺寸容量", "生活方式", "整洁氛围"],
    recommendedScreens: ["首屏主视觉", "核心卖点", "材质细节", "使用场景", "参数说明", "信任背书", "收尾转化"],
    visualAnchors: ["真实家居场景", "尺度参照", "干净光线", "空间留白", "产品结构清晰"],
    taboos: ["不要夸大承重和安全能力", "不要改变产品结构", "不要生成不合理尺寸比例", "不要混入无关家具品牌"],
    qcRules: ["检查结构是否可用", "检查尺寸表达是否可信", "检查场景比例是否合理", "检查使用动作是否自然"]
  },
  electronics: {
    id: "electronics",
    name: "数码家电",
    keywords: ["数码", "手机", "耳机", "充电", "电器", "家电", "键盘", "鼠标", "屏幕", "智能", "音箱", "摄像头", "电源"],
    analyzeAttributes: ["产品型号感", "接口位置", "屏幕/按键/指示灯", "核心功能", "参数可信度", "使用场景"],
    sellingAngles: ["核心功能", "参数可信", "接口细节", "使用效率", "安全保障", "兼容场景"],
    recommendedScreens: ["首屏主视觉", "核心卖点", "参数说明", "材质细节", "使用场景", "信任背书", "收尾转化"],
    visualAnchors: ["科技感但不浮夸", "结构化说明", "产品边缘清晰", "冷静光线", "信息层级明确"],
    taboos: ["不要虚构参数", "不要添加不存在的接口", "不要生成虚假的屏幕内容", "不要把竞品 logo 混入"],
    qcRules: ["检查接口数量和位置", "检查参数文案是否虚构", "检查屏幕内容是否合规", "检查产品边缘是否破碎"]
  },
  motherBaby: {
    id: "motherBaby",
    name: "母婴童装",
    keywords: ["母婴", "宝宝", "婴儿", "儿童", "童装", "奶瓶", "纸尿裤", "玩具", "儿童餐具", "亲子"],
    analyzeAttributes: ["安全材质", "年龄段", "柔软度", "清洁便利", "家庭使用场景", "亲子信任"],
    sellingAngles: ["安全安心", "柔软舒适", "适龄使用", "好清洗", "亲子场景", "家庭信任"],
    recommendedScreens: ["首屏主视觉", "核心卖点", "材质细节", "使用场景", "信任背书", "收尾转化"],
    visualAnchors: ["柔和明亮", "干净家庭场景", "亲和色彩", "产品安全感", "人物自然"],
    taboos: ["不要让儿童处于危险场景", "不要夸大医疗/发育效果", "不要虚构安全认证", "不要改变产品防护结构"],
    qcRules: ["检查儿童动作是否安全", "检查材质表述是否过度承诺", "检查产品细节是否完整", "检查画面是否过度商业化"]
  },
  pet: {
    id: "pet",
    name: "宠物用品",
    keywords: ["宠物", "猫", "狗", "猫砂", "狗粮", "猫粮", "牵引", "宠物窝", "宠物玩具"],
    analyzeAttributes: ["宠物体型", "材质耐用", "使用场景", "清洁便利", "安全边界", "容量规格"],
    sellingAngles: ["宠物舒适", "耐用好清洁", "安全材质", "空间适配", "互动场景", "容量清晰"],
    recommendedScreens: ["首屏主视觉", "核心卖点", "使用场景", "材质细节", "参数说明", "信任背书", "收尾转化"],
    visualAnchors: ["真实居家光线", "宠物自然动作", "产品尺度清楚", "温暖但不杂乱"],
    taboos: ["不要表现危险使用方式", "不要虚构兽医背书", "不要让宠物肢体异常", "不要改变产品承重结构"],
    qcRules: ["检查宠物比例是否自然", "检查使用方式是否安全", "检查产品是否被遮挡", "检查文案是否夸大功效"]
  },
  jewelry: {
    id: "jewelry",
    name: "珠宝饰品",
    keywords: ["珠宝", "饰品", "项链", "耳环", "戒指", "手链", "银饰", "黄金", "珍珠", "钻", "宝石"],
    analyzeAttributes: ["材质光泽", "镶嵌结构", "尺寸比例", "佩戴场景", "礼赠属性", "细节工艺"],
    sellingAngles: ["光泽质感", "精致工艺", "佩戴氛围", "礼赠仪式", "日常百搭", "细节特写"],
    recommendedScreens: ["首屏主视觉", "核心卖点", "材质细节", "使用场景", "信任背书", "收尾转化"],
    visualAnchors: ["高质感微距", "金属/宝石高光可控", "肤色自然", "背景高级克制"],
    taboos: ["不要虚构克重和证书", "不要改变镶嵌数量", "不要让首饰结构熔化", "不要过曝成一团白光"],
    qcRules: ["检查镶嵌和链条是否完整", "检查金属反光是否可辨", "检查证书文案是否虚构", "检查佩戴比例是否合理"]
  },
  sports: {
    id: "sports",
    name: "运动户外",
    keywords: ["运动", "户外", "瑜伽", "健身", "跑步", "骑行", "露营", "登山", "球鞋", "运动服"],
    analyzeAttributes: ["功能结构", "运动姿态", "防护/透气/支撑", "户外场景", "材质耐用", "人群强度"],
    sellingAngles: ["运动支撑", "透气舒适", "耐用户外", "动态场景", "细节防护", "轻量便携"],
    recommendedScreens: ["首屏主视觉", "痛点反转", "核心卖点", "使用场景", "材质细节", "参数说明", "信任背书", "收尾转化"],
    visualAnchors: ["动态清晰", "运动姿态可信", "自然户外光", "产品不变形", "力量感不过度"],
    taboos: ["不要出现危险动作", "不要夸大安全防护", "不要让人体姿态畸形", "不要改变产品功能结构"],
    qcRules: ["检查运动姿态是否自然", "检查产品是否拉伸变形", "检查安全承诺是否过度", "检查场景是否干净"]
  },
  generic: {
    id: "generic",
    name: "通用电商",
    keywords: [],
    analyzeAttributes: ["商品外观", "核心卖点", "材质细节", "使用场景", "信任要素", "转化理由"],
    sellingAngles: ["核心卖点", "材质细节", "使用场景", "品质信任", "转化收尾"],
    recommendedScreens: ["首屏主视觉", "核心卖点", "材质细节", "使用场景", "参数说明", "信任背书", "收尾转化"],
    visualAnchors: ["主体清晰", "光线统一", "版式稳定", "细节真实", "背景干净"],
    taboos: ["不要改变产品结构", "不要混入参考图里的其它商品", "不要生成虚假认证", "不要让文字乱码"],
    qcRules: ["检查主体是否清晰", "检查产品结构是否一致", "检查文案是否可信", "检查整体风格是否统一"]
  }
};

const PLATFORM_SKILLS = {
  "taobao-detail": {
    id: "taobao-detail",
    platform: "淘宝",
    pageType: "详情页",
    rhythm: ["首屏主视觉", "痛点反转", "核心卖点", "材质细节", "版型/结构", "使用场景", "信任背书", "收尾转化"],
    copyRule: "中文电商短句，卖点直接，留白明确，避免夸张极限词。",
    visualRule: "适合手机端长图阅读，单屏信息密度中等，节奏从吸引到解释再到转化。",
    imageNorms: ["商品清晰", "文案不遮挡主体", "适合无线端竖向浏览"],
    conversionTraits: ["第一眼点击承接", "卖点解释清楚", "最后给购买理由"]
  },
  "taobao-main": {
    id: "taobao-main",
    platform: "淘宝",
    pageType: "主图",
    rhythm: ["首屏主视觉", "核心卖点", "材质细节", "使用场景", "收尾转化"],
    copyRule: "主图文字少而醒目，避免遮挡产品主体。",
    visualRule: "主体占比高，第一眼清晰，背景干净，适合搜索流量点击。",
    imageNorms: ["主体突出", "噪音少", "缩略图也能看清"],
    conversionTraits: ["强点击", "强识别", "少信息但明确"]
  },
  "tmall-detail": {
    id: "tmall-detail",
    platform: "天猫",
    pageType: "详情页",
    rhythm: ["首屏主视觉", "核心卖点", "材质细节", "使用场景", "信任背书", "收尾转化"],
    copyRule: "文字更克制，强调品质、设计、材质和品牌感。",
    visualRule: "版式更高级，留白更足，避免廉价促销感。",
    imageNorms: ["质感优先", "品牌感稳定", "文案克制"],
    conversionTraits: ["价值感", "品质证明", "购买理由"]
  },
  "jd-detail": {
    id: "jd-detail",
    platform: "京东",
    pageType: "详情页",
    rhythm: ["首屏主视觉", "核心卖点", "参数说明", "材质细节", "使用场景", "信任背书", "收尾转化"],
    copyRule: "信息清晰，参数、功能、保障表达要可信。",
    visualRule: "结构化更强，适合快速扫描和理性决策。",
    imageNorms: ["信息层级清楚", "参数可读", "对比表达可信"],
    conversionTraits: ["理性判断", "功能说明", "服务保障"]
  },
  "douyin-detail": {
    id: "douyin-detail",
    platform: "抖音电商",
    pageType: "详情页",
    rhythm: ["首屏主视觉", "痛点反转", "核心卖点", "使用场景", "信任背书", "收尾转化"],
    copyRule: "口语化、种草感，但不要夸张虚假承诺。",
    visualRule: "动态感更强，镜头更近，画面要能承接短视频流量。",
    imageNorms: ["近景冲击", "动作感", "卖点一眼懂"],
    conversionTraits: ["情绪带入", "短句推动", "快速转化"]
  },
  "redbook-detail": {
    id: "redbook-detail",
    platform: "小红书",
    pageType: "种草图文",
    rhythm: ["首屏主视觉", "使用场景", "材质细节", "核心卖点", "信任背书", "收尾转化"],
    copyRule: "自然分享口吻，少硬广，多真实使用感。",
    visualRule: "生活方式、氛围、审美统一，避免过度商业海报感。",
    imageNorms: ["生活方式明显", "真实感强", "画面可收藏"],
    conversionTraits: ["审美种草", "体验表达", "轻转化"]
  },
  "pdd-detail": {
    id: "pdd-detail",
    platform: "拼多多",
    pageType: "详情页",
    rhythm: ["首屏主视觉", "核心卖点", "痛点反转", "参数说明", "使用场景", "信任背书", "收尾转化"],
    copyRule: "卖点要直白可读，强调实用价值，但不要做虚假低价、极限承诺或劣质促销风。",
    visualRule: "信息更直接，产品和利益点优先，画面仍保持干净可信。",
    imageNorms: ["卖点直观", "产品大而清楚", "文案不拥挤"],
    conversionTraits: ["高性价比表达", "快速理解", "强行动理由"]
  },
  "amazon-detail": {
    id: "amazon-detail",
    platform: "亚马逊",
    pageType: "详情页",
    rhythm: ["首屏主视觉", "核心卖点", "材质细节", "使用场景", "参数说明", "信任背书", "收尾转化"],
    copyRule: "英文短句，功能和利益点清晰，避免违规绝对化词汇。",
    visualRule: "更重清晰说明和合规展示，信息层级必须稳定。",
    imageNorms: ["功能清楚", "白底和生活方式用途分明", "避免无法验证的 claims"],
    conversionTraits: ["feature-benefit", "use case", "proof"]
  },
  "amazon-main": {
    id: "amazon-main",
    platform: "亚马逊",
    pageType: "主图",
    rhythm: ["首屏主视觉", "核心卖点", "使用场景", "参数说明", "收尾转化"],
    copyRule: "主图尽量少字，白底图避免文字和装饰。",
    visualRule: "产品真实可信，白底/生活方式图要区分用途。",
    imageNorms: ["白底主图干净", "产品不变形", "不要无关道具"],
    conversionTraits: ["清晰识别", "合规可信", "用途明确"]
  },
  "shein-detail": {
    id: "shein-detail",
    platform: "SHEIN",
    pageType: "详情页",
    rhythm: ["首屏主视觉", "版型/结构", "材质细节", "使用场景", "核心卖点", "收尾转化"],
    copyRule: "偏时尚、轻量、年轻化，文字简短。",
    visualRule: "服饰搭配感和模特表现更重要，但商品细节不能丢。",
    imageNorms: ["模特穿搭清楚", "风格年轻", "细节不丢"],
    conversionTraits: ["穿搭想象", "尺码/版型", "快速购买"]
  },
  "temu-detail": {
    id: "temu-detail",
    platform: "Temu",
    pageType: "详情页",
    rhythm: ["首屏主视觉", "核心卖点", "参数说明", "材质细节", "使用场景", "信任背书", "收尾转化"],
    copyRule: "卖点明确，信息密度略高，但避免低质促销感。",
    visualRule: "清晰、直接、转化导向，产品和功能优先。",
    imageNorms: ["功能明确", "说明直接", "场景真实"],
    conversionTraits: ["直接卖点", "快速比较", "低认知成本"]
  }
};

const SCREEN_MODULES = {
  hero: {
    id: "hero",
    name: "首屏主视觉",
    aliases: ["首屏", "主视觉", "开场", "Hero", "第一眼"],
    purpose: "承接主图点击，让用户第一眼确认商品、风格和购买兴趣。",
    composition: "商品主体清晰居中或略偏黄金分割，保留呼吸感，首屏标题区域不压住产品。",
    referenceNeed: "锁商品主图，可轻参考运营参考图的配色和氛围。",
    promptDirectives: ["强化第一眼质感", "产品轮廓完整", "背景干净", "标题层级明确"],
    qcRules: ["主商品是否完整", "第一眼是否清楚", "是否过曝", "文案是否压住商品"]
  },
  painReverse: {
    id: "painReverse",
    name: "痛点反转",
    aliases: ["痛点", "反转", "问题", "Before", "困扰"],
    purpose: "把用户常见顾虑转成购买理由，形成继续阅读的动力。",
    composition: "可以用左右对比、上下对比或场景前后变化，但不要制造虚假效果。",
    referenceNeed: "以商品图为主，参考图只辅助场景表达。",
    promptDirectives: ["痛点真实", "反转明确", "对比不过度", "产品解决方案清楚"],
    qcRules: ["是否夸大效果", "对比是否可信", "产品是否仍然真实", "文案是否绝对化"]
  },
  coreSellingPoint: {
    id: "coreSellingPoint",
    name: "核心卖点",
    aliases: ["核心", "卖点", "价值", "功能", "Benefit"],
    purpose: "解释最主要的购买理由，建立产品价值感。",
    composition: "一屏只讲一个主要卖点，标题、辅助说明和产品画面形成清楚层级。",
    referenceNeed: "锁商品图，可参考版式和信息层级。",
    promptDirectives: ["一屏一卖点", "文案短而清楚", "视觉和卖点一致", "保留产品细节"],
    qcRules: ["卖点是否对应商品", "信息是否拥挤", "是否出现虚假能力", "产品是否变形"]
  },
  materialDetail: {
    id: "materialDetail",
    name: "材质细节",
    aliases: ["材质", "面料", "细节", "工艺", "纹理", "近景"],
    purpose: "通过近景展示材质、工艺、边缘、接口、五金或纹理，增强可信度。",
    composition: "近景或局部特写，细节区域清晰，必要时搭配小面积整体商品作为识别锚点。",
    referenceNeed: "优先使用商品细节图，减少无关参考图。",
    promptDirectives: ["细节清晰", "纹理真实", "不要过度磨皮", "不要生成不存在的结构"],
    qcRules: ["材质是否像真实产品", "细节是否变形", "是否添加不存在部件", "是否过曝"]
  },
  useScenario: {
    id: "useScenario",
    name: "使用场景",
    aliases: ["场景", "生活", "种草", "穿着", "使用", "搭配", "氛围"],
    purpose: "让用户想象商品在真实生活里的使用效果。",
    composition: "产品与场景自然融合，场景服务商品，不喧宾夺主。",
    referenceNeed: "商品图锁主体，参考图可提供场景主题、构图和光线方向。",
    promptDirectives: ["真实生活场景", "产品仍是主角", "动作自然", "背景不过度复杂"],
    qcRules: ["场景是否抢主体", "产品比例是否合理", "人物动作是否自然", "风格是否统一"]
  },
  specInfo: {
    id: "specInfo",
    name: "参数说明",
    aliases: ["参数", "尺寸", "规格", "容量", "说明", "对比"],
    purpose: "用理性信息降低决策成本，但不虚构没有提供的参数。",
    composition: "结构化排版，留白清楚，产品和信息标注分区明确。",
    referenceNeed: "商品图锁主体，参考图最多参考版式。",
    promptDirectives: ["只写已提供或可泛化的信息", "参数位置可读", "避免密密麻麻", "信息框不遮挡产品"],
    qcRules: ["参数是否虚构", "文字是否可读", "排版是否整齐", "产品是否完整"]
  },
  trustProof: {
    id: "trustProof",
    name: "信任背书",
    aliases: ["信任", "背书", "品质", "认证", "服务", "保障"],
    purpose: "用真实可信的品质、服务、材质或工艺表达降低疑虑。",
    composition: "稳重干净，可用图标感信息块，但不能虚构认证、销量或机构。",
    referenceNeed: "商品图为主，参考图只参考信息布局。",
    promptDirectives: ["可信而克制", "不写无法验证的认证", "服务表达泛化", "质感稳定"],
    qcRules: ["是否虚构证书", "是否绝对化承诺", "文字是否清楚", "品牌信息是否混入"]
  },
  conversionClose: {
    id: "conversionClose",
    name: "收尾转化",
    aliases: ["收尾", "转化", "购买", "行动", "结束"],
    purpose: "总结核心理由，给出温和行动引导，形成详情页完整闭环。",
    composition: "画面简洁、有结束感，产品再次清楚出现，文案短促有力但不硬卖。",
    referenceNeed: "商品主图和首屏风格为主，可轻参考运营图氛围。",
    promptDirectives: ["总结卖点", "回到产品", "留出行动区域", "风格承接首屏"],
    qcRules: ["是否和首屏风格一致", "是否过度促销", "产品是否清楚", "文案是否合规"]
  },
  fitStructure: {
    id: "fitStructure",
    name: "版型/结构",
    aliases: ["版型", "结构", "轮廓", "剪裁", "线条"],
    purpose: "解释商品形体结构、剪裁轮廓或核心构造。",
    composition: "整体展示为主，必要时辅以局部放大，不改变真实结构。",
    referenceNeed: "优先商品图，参考图不参与结构判断。",
    promptDirectives: ["结构准确", "轮廓完整", "比例稳定", "细节不乱"],
    qcRules: ["结构是否改款", "比例是否异常", "线条是否破碎", "是否添加不存在部件"]
  }
};

const QUALITY_SKILL = {
  id: "jingyin-detail-quality-v1",
  name: "质检 Skill",
  globalChecks: [
    "商品是否变形、缺失、被错误替换或与原图不一致。",
    "文案是否出现错字、乱码、伪英文、伪品牌、水印或无法阅读的小字。",
    "是否出现虚假卖点、虚假认证、绝对化承诺、医疗疗效或无法证明的数据。",
    "一组详情页的颜色、光线、版式、字体层级和产品比例是否统一。",
    "输出是否符合所选平台的页面节奏、文案风格、图片规范和转化特点。"
  ],
  negativePrompt: [
    "不要低清晰度",
    "不要破碎拼贴",
    "不要过曝",
    "不要脏乱背景",
    "不要错误 logo",
    "不要错字乱码",
    "不要虚假认证",
    "不要多余肢体",
    "不要畸形手",
    "不要改变商品结构",
    "不要混入参考图商品"
  ]
};

function uniqueList(items) {
  return [...new Set((items || []).filter((item) => (
    item !== undefined && item !== null && item !== ""
  )))];
}

function getPlatformSkill(workflow) {
  const key = String(workflow || "taobao-detail").trim();
  if (PLATFORM_SKILLS[key]) return PLATFORM_SKILLS[key];
  if (key.includes("amazon")) return PLATFORM_SKILLS["amazon-detail"];
  if (key.includes("main")) return PLATFORM_SKILLS["taobao-main"];
  return PLATFORM_SKILLS["taobao-detail"];
}

function getIndustrySkillByText(text) {
  const source = String(text || "");
  const scored = Object.values(INDUSTRY_SKILLS)
    .filter((skill) => skill.id !== "generic")
    .map((skill) => ({
      skill,
      score: skill.keywords.reduce((sum, keyword) => sum + (source.includes(keyword) ? 1 : 0), 0)
    }))
    .sort((a, b) => b.score - a.score);
  return scored[0]?.score > 0 ? scored[0].skill : INDUSTRY_SKILLS.generic;
}

function getScreenModule(title, index = 0, count = 1) {
  const source = String(title || "");
  const direct = Object.values(SCREEN_MODULES).find((module) => (
    module.aliases.some((alias) => source.toLowerCase().includes(String(alias).toLowerCase()))
  ));
  if (direct) return direct;
  if (index === 0) return SCREEN_MODULES.hero;
  if (index === count - 1) return SCREEN_MODULES.conversionClose;
  return SCREEN_MODULES.coreSellingPoint;
}

function buildQualityChecklist(platformSkill, industrySkill, moduleSkill) {
  return uniqueList([
    ...QUALITY_SKILL.globalChecks,
    ...(platformSkill.imageNorms || []).map((rule) => `平台规范：${rule}`),
    ...(industrySkill.qcRules || []),
    ...(moduleSkill.qcRules || [])
  ]);
}

export {
  BASE_SKILL,
  INDUSTRY_SKILLS,
  PLATFORM_SKILLS,
  QUALITY_SKILL,
  SCREEN_MODULES,
  buildQualityChecklist,
  getIndustrySkillByText,
  getPlatformSkill,
  getScreenModule,
  uniqueList
};
