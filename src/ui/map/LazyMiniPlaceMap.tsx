import { lazy, Suspense, type ComponentProps } from "react";
import { ErrorBoundary } from "../ErrorBoundary";

const MiniPlaceMap = lazy(() => import("./MiniPlaceMap"));

/** Shared lazy wrapper for MiniPlaceMap with a local ErrorBoundary so a failed
 *  chunk load isolates to the map widget instead of tripping the parent view. */
export function LazyMiniPlaceMap(props: ComponentProps<typeof MiniPlaceMap>) {
  return (
    <ErrorBoundary fallback={() => null}>
      <Suspense fallback={null}>
        <MiniPlaceMap {...props} />
      </Suspense>
    </ErrorBoundary>
  );
}
