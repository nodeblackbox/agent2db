import { useState, type ReactNode } from 'react';
import { Check, ChevronDown, Copy } from 'lucide-react';

export type Tone = 'default' | 'error' | 'success' | 'pending' | 'info';

export function Card({ children, tone = 'default', className = '' }: { children: ReactNode; tone?: Tone; className?: string }) {
  const border = {
    default: 'border-zinc-800',
    error: 'border-rose-900/60',
    success: 'border-emerald-900/50',
    pending: 'border-amber-900/60',
    info: 'border-indigo-900/50',
  }[tone];
  return <div className={`rounded-xl border ${border} bg-zinc-900/50 overflow-hidden ${className}`}>{children}</div>;
}

export function CardHead({
  icon,
  title,
  meta,
  right,
  onClick,
  open,
}: {
  icon: ReactNode;
  title: ReactNode;
  meta?: ReactNode;
  right?: ReactNode;
  onClick?: () => void;
  open?: boolean;
}) {
  return (
    <div
      className={`flex items-center justify-between gap-3 px-4 py-2.5 ${onClick ? 'cursor-pointer select-none hover:bg-zinc-800/30' : ''}`}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      aria-expanded={onClick ? open : undefined}
    >
      <div className="flex items-center gap-2 text-[13px] text-zinc-200 min-w-0">
        {onClick && <ChevronDown size={13} className={`text-zinc-600 shrink-0 transition-transform ${open ? '' : '-rotate-90'}`} />}
        {icon}
        <span className="shrink-0">{title}</span>
        {meta && <span className="text-[11.5px] text-zinc-500 mono truncate">{meta}</span>}
      </div>
      <div className="flex items-center gap-2 shrink-0">{right}</div>
    </div>
  );
}

export function Btn({
  children,
  variant = 'ghost',
  size = 'sm',
  onClick,
  className = '',
  disabled,
  title,
  type = 'button',
}: {
  children: ReactNode;
  variant?: 'primary' | 'ghost' | 'outline' | 'danger';
  size?: 'sm' | 'xs' | 'icon';
  onClick?: () => void;
  className?: string;
  disabled?: boolean;
  title?: string;
  type?: 'button' | 'submit';
}) {
  const base = 'inline-flex items-center gap-1.5 rounded-lg font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed';
  const sizes = { sm: 'text-[12px] px-2.5 py-1.5', xs: 'text-[11.5px] px-2 py-1', icon: 'p-1.5' };
  const variants = {
    primary: 'bg-zinc-100 text-zinc-950 hover:bg-white',
    ghost: 'text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800/70',
    outline: 'border border-zinc-800 text-zinc-300 hover:bg-zinc-800/60',
    danger: 'bg-rose-500/10 border border-rose-900/50 text-rose-300 hover:bg-rose-500/15',
  };
  return (
    <button type={type} onClick={onClick} disabled={disabled} title={title} className={`${base} ${sizes[size]} ${variants[variant]} ${className}`}>
      {children}
    </button>
  );
}

export function Tag({ children, tone = 'default' }: { children: ReactNode; tone?: 'default' | 'warn' | 'danger' | 'ok' | 'info' }) {
  const cls = {
    default: 'bg-zinc-800 text-zinc-400',
    warn: 'bg-amber-500/10 text-amber-300',
    danger: 'bg-rose-500/10 text-rose-300',
    ok: 'bg-emerald-500/10 text-emerald-300',
    info: 'bg-indigo-500/10 text-indigo-300',
  }[tone];
  return <span className={`text-[10.5px] rounded-md px-1.5 py-0.5 mono whitespace-nowrap ${cls}`}>{children}</span>;
}

export function StatusDot({ status }: { status: 'running' | 'waiting' | 'idle' | 'ok' | 'error' | 'off' }) {
  const map = {
    running: 'bg-[var(--accent)]',
    waiting: 'bg-amber-300',
    idle: 'bg-zinc-600',
    ok: 'bg-emerald-400',
    error: 'bg-rose-400',
    off: 'bg-zinc-700',
  };
  return (
    <span className="relative inline-flex h-2 w-2 shrink-0">
      {status === 'running' && <span className="absolute inline-flex h-full w-full rounded-full bg-[var(--accent)] opacity-60 animate-ping" />}
      <span className={`relative inline-flex h-2 w-2 rounded-full ${map[status]}`} />
    </span>
  );
}

export function Collapsible({ title, defaultOpen = false, children, right }: { title: ReactNode; defaultOpen?: boolean; children: ReactNode; right?: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button onClick={() => setOpen((o) => !o)} className="w-full flex items-center justify-between px-4 py-2 text-left text-[12px] text-zinc-500 hover:text-zinc-300">
        <span className="flex items-center gap-2">
          <ChevronDown size={13} className={`transition-transform ${open ? '' : '-rotate-90'}`} />
          {title}
        </span>
        {right}
      </button>
      {open && children}
    </div>
  );
}

/** Copies text to the clipboard and shows a brief check mark. */
export function CopyButton({ text, label, className = '' }: { text: string; label?: string; className?: string }) {
  const [done, setDone] = useState(false);
  const copy = (): void => {
    void navigator.clipboard
      .writeText(text)
      .then(() => {
        setDone(true);
        setTimeout(() => setDone(false), 1200);
      })
      .catch(() => undefined);
  };
  return (
    <button onClick={copy} title={label ? `Copy ${label}` : 'Copy'} className={`inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800/70 ${className}`}>
      {done ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
      {label && <span>{done ? 'Copied' : label}</span>}
    </button>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="text-[12.5px] text-zinc-600 py-8 text-center">{children}</div>;
}

export function fmtUsd(n: number): string {
  if (n <= 0) return '$0';
  return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

export function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : String(n);
}

export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

export function fmtRows(n: number | null | undefined): string {
  if (n === null || n === undefined) return '';
  if (n >= 1_000_000) return `~${(n / 1_000_000).toFixed(1)}M rows`;
  if (n >= 1_000) return `~${(n / 1_000).toFixed(1)}k rows`;
  return `~${n} rows`;
}

export function fmtWhen(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const diff = Date.now() - d.getTime();
  const m = Math.floor(diff / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.floor(h / 24);
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString();
}
