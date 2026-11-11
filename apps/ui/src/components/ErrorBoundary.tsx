import { Component, type ErrorInfo, type ReactNode } from "react";

import { Button } from "@mrog/ui-kit";

/** Catches a render that throws, so one bad message shows a way out instead of a blank window. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(error, info.componentStack);
  }

  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-bg px-6 text-center">
        <p className="text-base font-medium">Something went wrong</p>
        <Button variant="primary" onClick={() => window.location.reload()}>
          Reload
        </Button>
      </div>
    );
  }
}
