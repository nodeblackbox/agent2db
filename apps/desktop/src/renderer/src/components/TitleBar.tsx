import { Copy, Minus, Square, X } from 'lucide-react';
import type { WindowState } from '../../../shared/types';

/**
 * Custom chrome for the frameless window. Replaces the native title bar, so the unfocused state
 * is drawn here (deliberately subtle instead of the native dark flash).
 */
export function TitleBar({ win, title }: { win: WindowState; title: string }) {
  const api = window.agent2db;
  const btn = `no-drag w-11 h-full flex items-center justify-center transition-colors ${win.focused ? 'text-zinc-400' : 'text-zinc-700'}`;
  return (
    <div className="drag-region h-9 shrink-0 flex items-center border-b border-zinc-800/60 select-none" onDoubleClick={() => void api.windowMaximize()}>
      <div className="flex items-center gap-2 px-3">
        <span className="h-4 w-4 rounded-md bg-[var(--accent)]/20 border border-[var(--accent)]/40 flex items-center justify-center text-[9px] text-indigo-200 font-semibold">A2</span>
        <span className={`text-[12px] ${win.focused ? 'text-zinc-400' : 'text-zinc-600'}`}>Agent2DB</span>
        {title && (
          <>
            <span className="text-zinc-700">/</span>
            <span className={`text-[12px] truncate max-w-[360px] ${win.focused ? 'text-zinc-300' : 'text-zinc-600'}`}>{title}</span>
          </>
        )}
      </div>
      <div className="flex-1" />
      <div className="flex items-stretch h-full">
        <button onClick={() => void api.windowMinimize()} title="Minimize" className={`${btn} hover:bg-zinc-800/70 hover:text-zinc-100`}>
          <Minus size={14} />
        </button>
        <button onClick={() => void api.windowMaximize()} title={win.maximized ? 'Restore' : 'Maximize'} className={`${btn} hover:bg-zinc-800/70 hover:text-zinc-100`}>
          {win.maximized ? <Copy size={12} /> : <Square size={11} />}
        </button>
        <button onClick={() => void api.windowClose()} title="Close" className={`${btn} hover:bg-rose-600 hover:text-white`}>
          <X size={15} />
        </button>
      </div>
    </div>
  );
}
