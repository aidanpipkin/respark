import { Component } from 'react';

// After a deploy, a browser holding the old page can fail to fetch a page chunk that no longer
// exists. Reload once to pick up the new version instead of showing a broken screen.
const CHUNK = /Loading chunk|dynamically imported module|Importing a module script failed|Failed to fetch dynamically/i;

export default class ErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) {
    console.error('[LeadRespark] screen error', error, info?.componentStack);
    if (CHUNK.test(String(error?.message || ''))) {
      let reloaded = false;
      try { reloaded = sessionStorage.getItem('lr-chunk-reload') === '1'; sessionStorage.setItem('lr-chunk-reload', '1'); } catch { /* storage blocked */ }
      if (!reloaded) window.location.reload();
    }
  }
  componentDidUpdate(prev) {
    // Navigating elsewhere clears a page-level error.
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="mx-auto my-16 max-w-md px-5 text-center">
        <div className="panel space-y-4 p-8">
          <h1 className="text-lg font-semibold">This page didn't load</h1>
          <p className="text-sm text-muted-foreground">Nothing was lost. Your texts, leads and appointments keep running in the background. Reload to try again.</p>
          <div className="flex flex-wrap justify-center gap-2">
            <button type="button" className="h-9 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90" onClick={() => window.location.reload()}>Reload</button>
            <a href="/dashboard" className="inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium hover:bg-muted">Go to Home</a>
          </div>
        </div>
      </div>
    );
  }
}
