import { useCallback, useState, type ReactNode } from "react";
import { ConfirmDialog } from "./ConfirmDialog";

/** How a three-way question was answered (see `choiceDialog`). */
export type Choice = "confirm" | "alt" | "cancel";

interface PendingConfirm {
  message: string;
  confirmLabel: string;
  /** A third answer, shown left of Cancel (see `choiceDialog`). */
  altLabel?: string;
  resolve: (choice: Choice) => void;
  onConfirmAction?: () => void;
}

/**
 * App-styled confirmation dialog as a promise: `confirmDialog(...)` resolves
 * true/false on the user's choice, replacing native `window.confirm` so every
 * prompt shares the app's look. `choiceDialog(...)` asks the same with a third
 * answer beside the confirm, and resolves which one was taken. Render
 * `confirmDialogElement` once, anywhere in the tree. Both are stable, so they
 * are safe to capture in effects.
 */
export function useConfirmDialog(): {
  confirmDialog: (message: string, confirmLabel: string, onConfirmAction?: () => void) => Promise<boolean>;
  choiceDialog: (message: string, confirmLabel: string, altLabel: string) => Promise<Choice>;
  confirmDialogElement: ReactNode;
} {
  const [pending, setPending] = useState<PendingConfirm | null>(null);

  const confirmDialog = useCallback(
    (message: string, confirmLabel: string, onConfirmAction?: () => void) =>
      new Promise<boolean>((resolve) =>
        setPending({ message, confirmLabel, resolve: (choice) => resolve(choice === "confirm"), onConfirmAction }),
      ),
    [],
  );

  const choiceDialog = useCallback(
    (message: string, confirmLabel: string, altLabel: string) =>
      new Promise<Choice>((resolve) => setPending({ message, confirmLabel, altLabel, resolve })),
    [],
  );

  const confirmDialogElement = pending ? (
    <ConfirmDialog
      message={pending.message}
      confirmLabel={pending.confirmLabel}
      onConfirm={() => { pending.onConfirmAction?.(); pending.resolve("confirm"); setPending(null); }}
      onCancel={() => { pending.resolve("cancel"); setPending(null); }}
      altLabel={pending.altLabel}
      onAlt={pending.altLabel ? () => { pending.resolve("alt"); setPending(null); } : undefined}
    />
  ) : null;

  return { confirmDialog, choiceDialog, confirmDialogElement };
}
