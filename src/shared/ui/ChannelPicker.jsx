// 紧凑圆形「渠道（线路）」选择入口。
//
// 为什么抽它：`src/shared/ui/README.md` 的修改规则第 1 条要求「两个以上页面长得一样或
// 行为一样，先抽到 src/shared/ui/」，而参考生图与一键详情/主图这两个页面都要在各自的
// 参数区标题右边加一个同款圆形渠道入口（快捷生成右上角已经有一个同功能的「线路价格」）。
//
// 复用范围（刻意只共享"目录 + 选择 + 浮层样式"）：
//   - 渠道目录、按模型过滤、白名单/隐藏线路过滤、排序：全部走 `channelsForModel()`
//     （src/shared/routing.js，与快捷生成、批量生成同一份数据源，不新建第二套渠道数据）
//   - 价格文案：`channelPriceLabel()`
//   - 浮层样式：直接复用快捷生成已有的 `.quickChannelMenu / .quickChannelItem /
//     .quickChannelEmpty` 类，所以两个页面的浮层与快捷生成是同一套观感
//   - 只把选中的 channelId 交给调用方自己的设置容器（各页面渠道状态互相独立）
//
// 不做的事：
//   - 不请求接口、不做渠道连通测试
//   - 不写死任何渠道列表
//   - 不改请求字段；调用方原有的 routingFields() 逻辑照旧
//
// 参数：
//   model         当前页面选中的模型（用于 channelsForModel 过滤）
//   modelLabel    浮层标题里显示的模型名（缺省时回落到 model id）
//   channelId     当前选中的渠道 id（不在当前模型目录里时显示该模型的第一条合法渠道）
//   routing       目录数据（`config.routing || config`）
//   onChange      选中渠道后回调，参数是 channel.id
//   className     额外容器类名，由页面决定按钮在参数区里的定位

import { useEffect, useRef, useState } from "react";
import { channelPriceLabel, channelsForModel } from "../routing.js";

export default function ChannelPicker({
  model,
  modelLabel = "",
  channelId = "",
  routing = null,
  onChange,
  className = ""
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const channels = channelsForModel(model, routing);
  const current = channels.find((item) => item.id === channelId) || channels[0] || null;
  const triggerTitle = current
    ? `渠道：${current.label} ${channelPriceLabel(current)}`
    : "渠道：当前模型暂无可用线路";

  // 关闭方式沿用快捷生成渠道菜单的习惯：点浮层外面关闭、Esc 关闭。
  // 用 pointerdown(capture) 而不是 click，是为了"点页面其它区域只关浮层、不会顺带触发生成"——
  // 事件在捕获阶段就被消费掉，不会落到下面的按钮上，同时也没有 preventDefault，
  // 所以键盘/鼠标对已有参数不产生任何副作用。
  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event) => {
      if (rootRef.current && rootRef.current.contains(event.target)) return;
      setOpen(false);
    };
    const onKeyDown = (event) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className={`channelPicker ${className}`.trim()} ref={rootRef}>
      <button
        className={`channelPickerTrigger ${open ? "active" : ""}`}
        type="button"
        title={triggerTitle}
        aria-label="渠道选择"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="quickToolGlyph">¥</span>
      </button>
      <span className="channelPickerName" title={current ? current.label : ""}>
        {current ? current.label : "无可用渠道"}
      </span>

      {open && (
        <div className="quickChannelMenu channelPickerMenu" role="menu" aria-label="渠道选择菜单">
          <div className="quickChannelMenuTitle">{modelLabel || model} 可用渠道</div>
          {channels.map((channel) => (
            <button
              key={channel.id}
              className={`quickChannelItem ${current && current.id === channel.id ? "active" : ""}`}
              type="button"
              role="menuitem"
              onClick={() => {
                if (onChange) onChange(channel.id);
                setOpen(false);
              }}
            >
              <span>{channel.label}</span>
              <em>{channelPriceLabel(channel)}</em>
            </button>
          ))}
          {channels.length === 0 && (
            <p className="quickChannelEmpty">当前模型暂无可用线路，请检查渠道目录</p>
          )}
        </div>
      )}
    </div>
  );
}
