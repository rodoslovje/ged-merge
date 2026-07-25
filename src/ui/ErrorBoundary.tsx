import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  /**
   * Rendered in place of the children when one of them throws during render.
   * Gets the error and a `reset` that clears the caught state and re-renders
   * the children (useful when the throw was transient).
   */
  fallback: (error: Error, reset: () => void) => ReactNode;
  /** Optional hook for logging/telemetry beyond the console.error below. */
  onError?: (error: Error, info: ErrorInfo) => void;
  /**
   * When this value changes while an error is showing, the boundary
   * auto-resets — e.g. a new file loaded, so the failing view is gone.
   */
  resetKey?: unknown;
}

interface State {
  error: Error | null;
}

/**
 * Catches render-time errors from its subtree so a single misbehaving view
 * (a Tools panel, a chart, an Edit form on odd data) degrades to a recoverable
 * in-place message instead of tearing down the whole React tree and dumping the
 * user back to a blank page. The app has no server state to lose — the loaded
 * file and review progress live in memory (and optionally IndexedDB) — so a
 * "Try again" or a full reload both recover cleanly.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidUpdate(prev: Props) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Keep the stack in the console so a "throws me out" report leaves a trace
    // to diagnose from, even though the UI no longer crashes to a blank page.
    console.error("[ged-merge] UI error boundary caught:", error, info.componentStack);
    this.props.onError?.(error, info);
  }

  reset = () => this.setState({ error: null });

  render() {
    if (this.state.error) return this.props.fallback(this.state.error, this.reset);
    return this.props.children;
  }
}
