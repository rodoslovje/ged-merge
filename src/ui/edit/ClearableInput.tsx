import React, { forwardRef, useLayoutEffect, useRef } from "react";

/** Input with an × button at the right edge to clear its value.
 * The clear button only appears when the field is non-empty.
 * `wrapStyle` is applied to the wrapper div (e.g. to set a ch-based width). */
export const ClearableInput = forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement> & {
    onClear: () => void;
    wrapStyle?: React.CSSProperties;
    wrapClassName?: string;
  }
>(function ClearableInput({ value, onClear, wrapStyle, wrapClassName, className, ...rest }, ref) {
  return (
    <div
      className={`clearable-wrap${wrapClassName ? ` ${wrapClassName}` : ""}`}
      style={wrapStyle}
    >
      <input ref={ref} className={className} value={value} {...rest} />
      {value ? (
        <button
          type="button"
          className="input-clear"
          tabIndex={-1}
          title={rest.title ? `${rest.title ? "Clear " + rest.title.toLowerCase() : "Clear"}` : "Clear"}
          onMouseDown={(e) => {
            e.preventDefault(); // keep input focused so onBlur fires with the cleared value
            onClear();
          }}
        >
          ×
        </button>
      ) : null}
    </div>
  );
});

/** Multi-line counterpart to {@link ClearableInput}, for fields (e.g. event
 * notes) that may carry several lines of text, matching how the Compare panel
 * renders a multi-line value as stacked lines. */
export const ClearableTextarea = forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement> & {
    onClear: () => void;
    wrapStyle?: React.CSSProperties;
    wrapClassName?: string;
  }
>(function ClearableTextarea({ value, onClear, wrapStyle, wrapClassName, className, ...rest }, ref) {
  const innerRef = useRef<HTMLTextAreaElement | null>(null);

  // Grow the textarea to fit its content — one line tall when short, taller
  // as it wraps or gains lines — so editing reads like the multi-line text
  // the Compare panel renders, instead of scrolling inside a fixed box.
  //
  // A ResizeObserver (not just a `[value]` effect) because this row can
  // mount while its ancestor is the inactive Edit/Merge mode layer (both are
  // always mounted; the inactive one is hidden, not unmounted, to preserve
  // state across tab switches — see App.tsx). `scrollHeight` of anything
  // under `display: none` reads 0, so a mount-time-only measurement bakes in
  // a collapsed height that never gets recomputed once the tab becomes
  // visible, since `value` doesn't change again on its own. The observer
  // re-measures whenever the element's actual box appears/changes.
  useLayoutEffect(() => {
    const el = innerRef.current;
    if (!el) return;
    const resize = () => {
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight}px`;
    };
    resize();
    // Deferred via rAF: resize() itself changes the observed box, and
    // calling it straight from the observer callback (synchronously, in the
    // same notification cycle) is what trips the browser's "ResizeObserver
    // loop completed with undelivered notifications" warning.
    const ro = new ResizeObserver(() => requestAnimationFrame(resize));
    ro.observe(el);
    return () => ro.disconnect();
  }, [value]);

  return (
    <div
      className={`clearable-wrap clearable-wrap--textarea${wrapClassName ? ` ${wrapClassName}` : ""}`}
      style={wrapStyle}
    >
      <textarea
        ref={(el) => {
          innerRef.current = el;
          if (typeof ref === "function") ref(el);
          else if (ref) ref.current = el;
        }}
        className={className}
        value={value}
        {...rest}
      />
      {value ? (
        <button
          type="button"
          className="input-clear"
          tabIndex={-1}
          title={rest.title ? `${rest.title ? "Clear " + rest.title.toLowerCase() : "Clear"}` : "Clear"}
          onMouseDown={(e) => {
            e.preventDefault(); // keep textarea focused so onBlur fires with the cleared value
            onClear();
          }}
        >
          ×
        </button>
      ) : null}
    </div>
  );
});
