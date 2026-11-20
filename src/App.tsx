import { useEffect } from 'react';
import { ControlRail } from './ui/ControlRail';
import { CyberPage } from './ui/CyberPage';
import { OverviewPage } from './ui/OverviewPage';
import { DemoGuide, Welcome } from './ui/DemoGuide';
import { useRuntime, useUi } from './ui/context';
import { InspectorPanel } from './ui/InspectorPanel';
import { SceneViewport } from './ui/SceneViewport';
import { Timeline } from './ui/Timeline';
import { TopBar } from './ui/TopBar';

function ErrorBanner() {
  const runtime = useRuntime();
  const error = useUi((s) => s.error);
  if (!error) return null;
  return (
    <div className="error-banner" role="alert">
      <strong>System fault</strong>
      <span>{error}</span>
      <button type="button" className="btn" onClick={() => runtime.reset()}>
        Reset simulation
      </button>
    </div>
  );
}

export function App() {
  const runtime = useRuntime();
  const leftOpen = useUi((s) => s.leftOpen);
  const rightOpen = useUi((s) => s.rightOpen);
  const wide = useUi((s) => s.rightPanel === 'investigation');
  const timelineOpen = useUi((s) => s.timelineOpen);
  const demoActive = useUi((s) => s.demo.active);
  const view = useUi((s) => s.view);
  const spatial = view === 'spatial';

  // Tell the scene which part of the viewport the panels cover, so it can keep its
  // subject centred in what remains. Below 1100 px the rails are drawers, not columns.
  useEffect(() => {
    const measure = () => {
      const columns = window.innerWidth >= 1100;
      const rect = (selector: string) => document.querySelector(selector)?.getBoundingClientRect();
      const left = columns && leftOpen ? (rect('.rail--left')?.right ?? 0) : 0;
      const rightRect = columns && rightOpen ? rect('.rail--right') : undefined;
      const timeline = rect('.timeline');
      runtime.setInsets({
        left,
        right: rightRect ? window.innerWidth - rightRect.left : 0,
        top: rect('.topbar')?.bottom ?? 0,
        bottom: timeline ? window.innerHeight - timeline.top : 0,
      });
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [runtime, leftOpen, rightOpen, wide, timelineOpen]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const state = runtime.store.get();
      switch (e.key) {
        case '1':
          runtime.setView('overview');
          return;
        case '2':
          runtime.setView('spatial');
          return;
        case '3':
          runtime.setView('cyber');
          return;
        default:
      }
      if (state.view !== 'spatial') return;
      switch (e.key) {
        case ' ':
          // Space triggers a ping unless it is activating a focused control.
          if (target && (target.tagName === 'BUTTON' || target.tagName === 'SELECT')) return;
          e.preventDefault();
          runtime.ping();
          break;
        case 'r':
        case 'R':
          runtime.resetView();
          break;
        case 'f':
        case 'F':
          if (state.selectedAssetId) runtime.focusAsset(state.selectedAssetId);
          break;
        case 'p':
        case 'P':
          runtime.setRunning(!state.running);
          break;
        case 'g':
        case 'G':
          runtime.setLayer('relations', !state.layers.relations);
          break;
        case 'Escape':
          if (state.selectedAssetId) runtime.selectAsset(null);
          else if (state.rightPanel === 'investigation') runtime.selectIncident(null);
          break;
        default:
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [runtime]);

  return (
    <div className={`app view-${view}${spatial && leftOpen ? ' left-open' : ''}${spatial && rightOpen ? ' right-open' : ''}${wide ? ' right-wide' : ''}${demoActive ? ' demo-active' : ''}`}>
      {/* The scene stays mounted (one WebGL context) and is paused while a page covers it. */}
      <SceneViewport />
      <TopBar />
      {view === 'overview' ? <OverviewPage /> : null}
      {view === 'cyber' ? <CyberPage /> : null}
      {spatial ? (
        <>
          {/* Below 1100 px the rails are drawers; the scrim closes them. */}
          {leftOpen || rightOpen ? (
        <button
          type="button"
          className="scrim"
          aria-label="Close panels"
          onClick={() => {
            if (runtime.store.get().leftOpen) runtime.togglePanel('leftOpen');
            if (runtime.store.get().rightOpen) runtime.togglePanel('rightOpen');
          }}
        />
      ) : null}
      {!leftOpen ? (
        <button type="button" className="rail-handle rail-handle--left" onClick={() => runtime.togglePanel('leftOpen')} title="Show controls">
          Controls
        </button>
      ) : null}
      {!rightOpen ? (
        <button type="button" className="rail-handle rail-handle--right" onClick={() => runtime.togglePanel('rightOpen')} title="Show inspector">
          Inspector
        </button>
      ) : null}
          <ControlRail />
          <InspectorPanel />
          <Timeline />
        </>
      ) : null}
      <DemoGuide />
      <Welcome />
      <ErrorBanner />
    </div>
  );
}
