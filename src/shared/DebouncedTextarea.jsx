import { useEffect, useRef, useState } from "react";

export default function DebouncedTextarea({
  value = "",
  onChange,
  commitDelay = 260,
  onBlur,
  onCompositionStart,
  onCompositionEnd,
  ...props
}) {
  const [draft, setDraft] = useState(String(value ?? ""));
  const timerRef = useRef(null);
  const composingRef = useRef(false);
  const latestCommittedRef = useRef(String(value ?? ""));

  useEffect(() => {
    const next = String(value ?? "");
    latestCommittedRef.current = next;
    setDraft((current) => (current === next ? current : next));
  }, [value]);

  useEffect(() => () => {
    if (timerRef.current) window.clearTimeout(timerRef.current);
  }, []);

  function clearTimer() {
    if (!timerRef.current) return;
    window.clearTimeout(timerRef.current);
    timerRef.current = null;
  }

  function commit(nextValue) {
    const next = String(nextValue ?? "");
    clearTimer();
    if (next === latestCommittedRef.current) return;
    latestCommittedRef.current = next;
    onChange?.(next);
  }

  function scheduleCommit(nextValue) {
    clearTimer();
    timerRef.current = window.setTimeout(() => commit(nextValue), commitDelay);
  }

  return (
    <textarea
      {...props}
      value={draft}
      onChange={(event) => {
        const next = event.target.value;
        setDraft(next);
        if (!composingRef.current) scheduleCommit(next);
      }}
      onCompositionStart={(event) => {
        composingRef.current = true;
        clearTimer();
        onCompositionStart?.(event);
      }}
      onCompositionEnd={(event) => {
        composingRef.current = false;
        const next = event.currentTarget.value;
        setDraft(next);
        scheduleCommit(next);
        onCompositionEnd?.(event);
      }}
      onBlur={(event) => {
        commit(event.currentTarget.value);
        onBlur?.(event);
      }}
    />
  );
}
