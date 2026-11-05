// Catches render errors so one broken view doesn't blank the whole app.
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { ApiError } from '../api.ts';
import { errorToast } from '../store.ts';

interface Props {
  children: ReactNode;
  /** Full-page fallback (root) vs. an inline panel (one screen). */
  page?: boolean;
  /** Changing it clears the error (e.g. the route path). */
  resetKey?: string;
}

export class ErrorBoundary extends Component<Props, { error: Error | null; key?: string }> {
  state: { error: Error | null; key?: string } = { error: null };

  static getDerivedStateFromProps(props: Props, state: { error: Error | null; key?: string }) {
    return props.resetKey !== state.key ? { error: null, key: props.resetKey } : null;
  }

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Render error', error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className={this.props.page ? 'auth' : 'empty-page'} role="alert">
        <div className={this.props.page ? 'auth-card' : undefined}>
          <h2>Something went wrong</h2>
          <p className="muted">This part of the app hit an error. Your notes are saved.</p>
          <div className="row gap-10" style={{ justifyContent: 'center', marginTop: 12 }}>
            {!this.props.page && (
              <button className="btn btn-secondary" onClick={() => this.setState({ error: null })}>
                Try again
              </button>
            )}
            <button className="btn btn-primary" onClick={() => window.location.reload()}>
              Reload
            </button>
          </div>
        </div>
      </div>
    );
  }
}

/** Per-screen boundary that resets when you navigate elsewhere. */
export function RouteBoundary({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  return <ErrorBoundary resetKey={pathname}>{children}</ErrorBoundary>;
}

/** Surface API errors from promises nobody handled (instead of failing silently). */
export function installGlobalErrorHandlers() {
  window.addEventListener('unhandledrejection', (e) => {
    if (e.reason instanceof ApiError && e.reason.status !== 401) {
      errorToast(e.reason);
      e.preventDefault();
    }
  });
}
