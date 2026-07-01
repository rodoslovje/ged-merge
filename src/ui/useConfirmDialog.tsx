import { useCallback, useState, type ReactNode } from "react";
import { ConfirmDialog } from "./ConfirmDialog";

interface PendingConfirm {
  message: string;
  confirmLabel: string;
  resolve: (ok: boolean) => void;
  onConfirmAction?: () => void;
}

/**
 * App-styled confirmation dialog as a promise: `confirmDialog(...)` resolves
 * true/false on the user's choice, replacing native `window.confirm` so every
 * prompt shares the app's look. Render `confirmDialogElement` once, anywhere in
 * the tree. `confirmDialog` is stable, so it's safe to capture in effects.
 */
export function useConfirmDialog(): {
  confirmDialog: (message: string, confirmLabel: string, onConfirmAction?: () => void) => Promise<boolean>;
  confirmDialogElement: ReactNode;
} {
  const [pending, setPending] = useState<PendingConfirm | null>(null);

  const confirmDialog = useCallback(
    (message: string, confirmLabel: string, onConfirmAction?: () => void) =>
      new Promise<boolean>((resolve) => setPending({ message, confirmLabel, resolve, onConfirmAction })),
    [],
  );

  const confirmDialogElement = pending ? (
    <ConfirmDialog
      message={pending.message}
      confirmLabel={pending.confirmLabel}
      onConfirm={() => { pending.onConfirmAction?.(); pending.resolve(true); setPending(null); }}
      onCancel={() => { pending.resolve(false); setPending(null); }}
    />
  ) : null;

  return { confirmDialog, confirmDialogElement };
}
