// ESLint 扁平配置（ESLint 9）。
//
// 阶段定位：**第 4 步先只做报告模式**。
// 这份配置目前只负责"把问题照出来"，**没有接进 `npm run check`**，
// 也就是说它红了不会拦住任何流程。等清零（或定好基线）之后再上门禁。
//
// 规则只挑"真能抓到 bug"的那一类，先不碰代码风格（缩进/引号/分号一律不管）：
// 风格问题一次性糊满屏幕，反而会把真问题淹掉。
//
// 用法：
//   npm run lint          人读（stylish）
//   npm run lint:json     机器可读（JSON）

import globals from "globals";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";

/**
 * 不参与检查的内容，以及**为什么**：
 *   生成物 / 依赖 / 运行时 / 快照 / 测试产物 → 不是人写的代码，照出来也没法改
 *   server/static-assets.generated.js        → 由 scripts/generate-static-assets.mjs 生成（1.3 MB）
 *   server/skill-baselines/**                → 历史版本快照，只作对照，不维护、不改
 *   API/**                                   → 中转站接入样例与模板（含 .ts），不属于本应用
 */
const IGNORES = [
  "node_modules/**",
  "dist/**",
  "runtime/**",
  "baselines/**",
  ".codex-artifacts/**",
  ".secure-build/**",
  ".release-temp/**",
  "data/**",
  "logs/**",
  "tmp/**",
  "server/static-assets.generated.js",
  "server/skill-baselines/**",
  "API/**"
];

/** 只开"能抓到 bug"的规则；规范类（缩进、引号、分号）一律不开。 */
const CORRECTNESS_RULES = {
  // —— 未定义 / 未使用：最常抓出真实打字错误与死代码
  "no-undef": "error",
  "no-unused-vars": ["warn", {
    args: "after-used",
    argsIgnorePattern: "^_",
    varsIgnorePattern: "^_",
    caughtErrors: "none",
    ignoreRestSiblings: true
  }],
  "no-redeclare": "error",
  "no-dupe-keys": "error",
  "no-dupe-args": "error",
  "no-dupe-class-members": "error",
  "no-duplicate-case": "error",

  // —— 控制流：写错的判断、走不到的分支、漏掉的 break
  "no-cond-assign": ["error", "except-parens"],
  "no-constant-condition": ["error", { checkLoops: false }],
  "no-unreachable": "error",
  "no-fallthrough": "error",
  "no-unmodified-loop-condition": "warn",
  "no-unsafe-negation": "error",
  "no-unsafe-optional-chaining": "error",

  // —— 明显写错但不会报错、只会行为诡异
  "no-self-assign": "error",
  "no-self-compare": "error",
  "no-sparse-arrays": "error",
  "no-template-curly-in-string": "warn",
  "no-async-promise-executor": "error",
  "no-prototype-builtins": "warn",
  "no-extra-boolean-cast": "warn",
  // 空块几乎都是漏写；但 `catch { /* 忽略 */ }` 是本项目的既定写法，放行
  "no-empty": ["warn", { allowEmptyCatch: true }],
  // `console` 是本项目的日志/诊断手段，不控；`debugger` 是漏删
  "no-console": "off",
  "no-debugger": "error",

  // —— React Hooks：这个项目里最容易出真 bug 的一类
  // 只显式开这两条经典规则，不铺 react-hooks 的整套 recommended（避免一上来就糊屏）
  "react-hooks/rules-of-hooks": "error",
  "react-hooks/exhaustive-deps": "warn",

  // —— 关键的一条：让 JSX 里用到的组件算"被使用"
  // 没有它，`<App />` 这种用法不算引用，整个报告会被"组件未使用"的假警报淹掉
  // （实测：加上之前 main.jsx 报 63 条，绝大多数是假的）。
  "react/jsx-uses-vars": "error"
};

export default [
  { ignores: IGNORES },

  // 浏览器侧：React 前端源码
  {
    files: ["src/**/*.js", "src/**/*.jsx"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser }
    }
  },

  // 服务端与脚本：Node 侧（含根目录的构建配置，它们跑在 Node 里，用得到 process 等）
  {
    files: [
      "server/**/*.js",
      "scripts/**/*.js",
      "scripts/**/*.mjs",
      "prompts/server/**/*.js",
      "*.config.js",
      "*.config.mjs",
      // 根目录下的直接脚本（本仓库目前没有，留个口子：根级脚本一定跑在 Node 里）
      "*.mjs",
      "*.js"
    ],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.node }
    }
  },

  // 浏览器探针：scripts/verify 里被 Vite 载入页面的模块，需要浏览器全局。
  // 放在 Node 那组之后，两组 global 合并（宽松，不会误报）。
  {
    files: ["scripts/verify/*-page.js", "scripts/verify/*-page.jsx"],
    languageOptions: {
      globals: { ...globals.browser }
    }
  },

  // 规则对上面所有文件生效
  {
    files: ["**/*.js", "**/*.jsx", "**/*.mjs"],
    linterOptions: {
      // 没用上的 eslint-disable 注释也要报出来，避免"以为关掉了其实早就不需要"
      reportUnusedDisableDirectives: "warn"
    },
    plugins: { react, "react-hooks": reactHooks },
    rules: CORRECTNESS_RULES
  }
];
