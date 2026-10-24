import type { ReactNode } from "react";

/** One answer a notice offers. The first `primary` one is the offer itself. */
export interface NoticeAction {
  label: string;
  onClick: () => void;
  primary?: boolean;
}

/**
 * A question the app asks about the loaded file without stopping the work —
 * a strip under the header, in the page flow, so it covers nothing and stays
 * until it is answered. Several stand one under another (`notice-stack`):
 * the target format, the media folder, … Each is answered on its own.
 */
export function Notice({ message, actions, className }: { message: ReactNode; actions: NoticeAction[]; className?: string }) {
  return (
    <div className={className ? `notice ${className}` : "notice"} role="status">
      <span className="notice-message">{message}</span>
      <div className="notice-actions">
        {actions.map((a) => (
          <button key={a.label} type="button" className={a.primary ? "notice-primary" : "btn-secondary"} onClick={a.onClick}>
            {a.label}
          </button>
        ))}
      </div>
    </div>
  );
}
