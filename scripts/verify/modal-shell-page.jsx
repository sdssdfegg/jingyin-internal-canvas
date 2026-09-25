// 共享弹窗外壳的浏览器探针（由 scripts/verify/modal-shell-check.mjs 载入真实页面执行）。
//
// 验证两件事：
//   1. 共享外壳 Modal/ModalHeader 的结构与通用交互：点遮罩关闭、点面板不关闭、
//      标题/副标题/关闭按钮、children 位置、aria-label 有/无两种情况
//   2. **不许新增行为**（纯重构承诺）：抽取前这四个弹窗都没有 Esc 关闭、没有 body 滚动锁，
//      所以外壳也不该有；这两个断言就是防止以后有人"顺手加"却当成重构
import React from "react";
import { createRoot } from "react-dom/client";
import { Modal, ModalHeader } from "/src/shared/ui/Modal.jsx";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function run() {
  const facts = {};
  const host = document.createElement("div");
  host.id = "verify-modal-shell";
  document.body.appendChild(host);
  const root = createRoot(host);

  let closeCount = 0;
  let applyCount = 0;
  const bodyOverflowBefore = document.body.style.overflow;

  const render = ({ noLabel = false, panelClassName = "probePanel" } = {}) => root.render(
    React.createElement(
      Modal,
      { layerClassName: "modalLayer previewLayer", panelClassName, onClose: () => { closeCount += 1; } },
      React.createElement(ModalHeader, {
        title: "探针标题",
        subtitle: "探针副标题",
        onClose: () => { closeCount += 1; },
        closeLabel: noLabel ? undefined : "关闭"
      }),
      React.createElement("div", { className: "probeBody" },
        React.createElement("button", { type: "button", className: "probeApply", onClick: () => { applyCount += 1; } }, "应用")
      )
    )
  );

  render();
  await wait(150);

  const layer = host.querySelector(".modalLayer.previewLayer");
  const panel = host.querySelector("section.probePanel");
  facts.rendered = Boolean(layer && panel);
  facts.panelHasHeader = Boolean(panel?.querySelector("header h2"));
  facts.titleText = panel?.querySelector("header h2")?.textContent || "";
  facts.subtitleText = panel?.querySelector("header span")?.textContent || "";
  facts.closeButtonAriaLabel = panel?.querySelector("button.iconButton")?.getAttribute("aria-label") ?? null;
  facts.closeButtonHasIcon = Boolean(panel?.querySelector("button.iconButton svg"));
  facts.childInsidePanel = Boolean(panel?.querySelector(".probeBody"));
  facts.childOutsideHeader = !panel?.querySelector("header .probeBody");
  facts.bodyOverflowUnchanged = document.body.style.overflow === bodyOverflowBefore;

  // 点面板内部：不应关闭
  panel.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  facts.panelClickDoesNotClose = closeCount === 0;

  // 点遮罩：应关闭
  layer.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  facts.backdropCloses = closeCount === 1;

  // Esc：不该关闭（与抽取前一致）
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  facts.escapeDoesNotClose = closeCount === 1;

  // 子内容里的按钮照常可用（应用）
  panel.querySelector(".probeApply")?.click();
  facts.applyClickReachesChild = applyCount === 1;

  // 不传 closeLabel → 不该有 aria-label（批量裁剪弹窗原本就没有）
  render({ noLabel: true });
  await wait(120);
  facts.ariaLabelOmittedWhenNotProvided =
    (host.querySelector("section.probePanel button.iconButton")?.getAttribute("aria-label") ?? null) === null;

  // 卸载后不应再响应任何点击（挂载时加的监听要清干净）
  const beforeUnmount = closeCount;
  root.unmount();
  host.remove();
  await wait(120);
  document.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  facts.noCloseAfterUnmount = closeCount === beforeUnmount;
  facts.hostRemoved = !document.querySelector("#verify-modal-shell");

  // 反复挂载/卸载不应留下会打架的监听器（再挂一次，只应记 1 次关闭）
  const host2 = document.createElement("div");
  document.body.appendChild(host2);
  const root2 = createRoot(host2);
  let close2 = 0;
  root2.render(
    React.createElement(Modal, { panelClassName: "probePanel2", onClose: () => { close2 += 1; } },
      React.createElement("div", null, "second"))
  );
  await wait(150);
  host2.querySelector(".modalLayer")?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
  facts.remountWorksOnce = close2 === 1;
  root2.unmount();
  host2.remove();

  return facts;
}

// ---------------------------------------------------------------------------
// 入口级验证：快捷入口 + 批量入口各走一遍「打开 → 取消 → 应用 → 资源释放」
// 在真实页面上做，所以可以看到真实状态变化；只操作这个测试实例自己的 origin。
// ---------------------------------------------------------------------------
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

export async function runEntrances() {
  const facts = { quick: {}, batch: {} };
  const counters = { created: 0, revoked: 0 };
  const originalCreate = URL.createObjectURL.bind(URL);
  const originalRevoke = URL.revokeObjectURL.bind(URL);
  URL.createObjectURL = (blob) => { counters.created += 1; return originalCreate(blob); };
  URL.revokeObjectURL = (url) => { counters.revoked += 1; return originalRevoke(url); };

  const bytes = Uint8Array.from(atob(PNG_BASE64), (ch) => ch.charCodeAt(0));
  const makeFile = (name) => new File([bytes], name, { type: "image/png" });
  const dropOn = (element, file) => {
    const dt = new DataTransfer();
    dt.items.add(file);
    element.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
  };
  const buttonByExactText = (root, text) => [...(root || document).querySelectorAll("button")]
    .find((button) => (button.textContent || "").replace(/\s+/g, "") === text) || null;
  const navTo = (label) => {
    const button = [...document.querySelectorAll("button.navItem")]
      .find((node) => (node.textContent || "").includes(label));
    if (!button) return false;
    button.click();
    return true;
  };

  try {
    // ============================== 快捷入口 ==============================
    const quick = facts.quick;
    quick.navSwitched = navTo("快捷生成");
    await wait(500);
    // 快捷页的参考图是拖到 composer 上（onComposerDrop → appendReferenceFiles）；
    // 上传位里的 referenceInsertZone 只有已经有参考图时才渲染，所以这里直接拖 composer。
    const composer = document.querySelector("section.composer");
    quick.foundReferenceBox = Boolean(composer);
    if (composer) {
      dropOn(composer, makeFile("verify-ref.png"));
      await wait(1200);
      const cropButton = composer.querySelector(".referenceToolRow button.referenceToolButton");
      quick.cropEntryFound = Boolean(cropButton);

      // 打开
      cropButton?.click();
      await wait(600);
      const modal1 = document.querySelector(".quickLocalEditModal.quickCropViewportModal");
      quick.opened = Boolean(modal1);
      quick.layerIsSharedShell = modal1?.parentElement?.classList.contains("modalLayer") === true
        && modal1?.parentElement?.classList.contains("previewLayer") === true;
      quick.title = modal1?.querySelector("header h2")?.textContent || "";
      quick.closeButtonPresent = Boolean(modal1?.querySelector("header button.iconButton"));
      const createdBefore = counters.created;
      const revokedBefore = counters.revoked;

      // 取消
      buttonByExactText(modal1, "取消")?.click();
      await wait(600);
      quick.closedOnCancel = !document.querySelector(".quickLocalEditModal.quickCropViewportModal");
      quick.refReleasedOnCancel = counters.revoked > revokedBefore;

      // 再打开 → 应用
      cropButton?.click();
      await wait(600);
      const modal2 = document.querySelector(".quickLocalEditModal.quickCropViewportModal");
      quick.reopened = Boolean(modal2);
      buttonByExactText(modal2, "应用裁剪")?.click();
      await wait(1600);
      quick.closedOnApply = !document.querySelector(".quickLocalEditModal.quickCropViewportModal");
      quick.cropStateApplied = Boolean(composer.querySelector(".referenceToolButton.active"));

      // 清理：取消裁剪 → 关闭 → 移除刚加入的参考图（不留残留状态）
      cropButton?.click();
      await wait(600);
      const modal3 = document.querySelector(".quickLocalEditModal.quickCropViewportModal");
      buttonByExactText(modal3, "取消裁剪")?.click();
      await wait(800);
      buttonByExactText(modal3, "取消")?.click();
      await wait(400);
      composer.querySelector(".referenceThumb button")?.click();
      await wait(600);
      quick.cleanedUp = composer.querySelectorAll(".referenceThumb").length === 0;
      quick.createdTotal = counters.created - createdBefore;
      quick.revokedTotal = counters.revoked - revokedBefore;
    }
  } catch (error) {
    facts.quick.error = error instanceof Error ? error.message : String(error);
  }

  try {
    // ============================== 批量入口 ==============================
    const batch = facts.batch;
    batch.navSwitched = navTo("批量生成");
    await wait(900);
    const zone = [".outfitUploadBox", ".outfitUploadZone", ".uploadZone", "section.uploadBox", "section.detailUploadBox"]
      .map((selector) => document.querySelector(selector))
      .find(Boolean) || null;
    batch.foundUploadZone = Boolean(zone);
    if (zone) {
      dropOn(zone, makeFile("verify-batch.png"));
      await wait(1200);
      const cropButton = zone.querySelector('button[title="裁剪/补边"]');
      batch.cropEntryFound = Boolean(cropButton);

      const revokedBefore = counters.revoked;
      cropButton?.click();
      await wait(700);
      const modal1 = document.querySelector(".cropModal");
      batch.opened = Boolean(modal1);
      batch.layerIsSharedShell = modal1?.parentElement?.classList.contains("modalLayer") === true;
      batch.closeButtonPresent = Boolean(modal1?.querySelector("header button.iconButton"));

      buttonByExactText(modal1, "取消")?.click();
      await wait(700);
      batch.closedOnCancel = !document.querySelector(".cropModal");
      batch.refReleasedOnCancel = counters.revoked > revokedBefore;

      cropButton?.click();
      await wait(700);
      const modal2 = document.querySelector(".cropModal");
      batch.reopened = Boolean(modal2);
      buttonByExactText(modal2, "应用")?.click();
      await wait(1600);
      batch.closedOnApply = !document.querySelector(".cropModal");
    }
  } catch (error) {
    facts.batch.error = error instanceof Error ? error.message : String(error);
  }

  facts.counters = { created: counters.created, revoked: counters.revoked };
  return facts;
}
