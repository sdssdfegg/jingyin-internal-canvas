// 共享弹窗外壳 + 头部。
//
// 为什么抽它：`src/shared/ui/README.md` 的"必须优先共用的 UI"里就写着
// 「弹窗底层 | 设置、预览、提示词、裁剪都用 | Modal.jsx」，
// `V11维护文档/02-重复功能同步登记表.md` 也记着「蒙版规则已共享，Modal UI 仍重复」。
// 快捷与批量两侧的裁剪弹窗、局部回贴弹窗此前各自抄了一份
// `modalLayer + section + header + 关闭按钮`，改一处就会漏另一处。
//
// 抽取范围（刻意保守，纯结构重构）：
//   - 只共享"外壳 + 头部"：遮罩层、面板、点遮罩关闭、面板内阻止冒泡、标题/副标题/关闭按钮
//   - **不做**任何业务逻辑：裁剪几何、蒙版绘制、请求参数、保存行为全部留在各自弹窗里
//   - **不加**原来没有的行为：实测这四个弹窗都没有 Esc 关闭、没有 body 滚动锁，
//     所以这里也不加（加了就是改交互）。将来要统一加，就在这一处加。
//
// 参数：
//   Modal:       layerClassName / panelClassName / onClose / children
//   ModalHeader: title / subtitle / onClose / closeLabel（不传就不渲染 aria-label，
//                保持与抽取前完全一致的 DOM）

import { X } from "lucide-react";

export function Modal({ layerClassName = "modalLayer", panelClassName = "", onClose, children }) {
  return (
    <div className={layerClassName} onMouseDown={onClose}>
      <section className={panelClassName} onMouseDown={(event) => event.stopPropagation()}>
        {children}
      </section>
    </div>
  );
}

export function ModalHeader({ title, subtitle, onClose, closeLabel }) {
  return (
    <header>
      <div>
        <h2>{title}</h2>
        <span>{subtitle}</span>
      </div>
      <button className="iconButton" type="button" onClick={onClose} aria-label={closeLabel}>
        <X size={18} />
      </button>
    </header>
  );
}
