import { cn } from '../../lib/cn.js';
import { BackIcon, EmojiText, MembersIcon, MoreIcon } from '../../components/index.js';

export function MobileTopbarButton({ label, onClick, badge = null, className = '', children, disabled = false }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'mobile-touch-target relative flex size-11 shrink-0 items-center justify-center rounded-xl text-muted transition-colors active:bg-surface-tertiary',
        className,
      )}
    >
      {children}
      {badge ? (
        <span className="tnum pointer-events-none absolute -top-0.5 -end-0.5 flex min-h-[16px] min-w-[16px] items-center justify-center rounded-full bg-accent px-1 text-[0.59375rem] font-bold text-accent-foreground">
          {badge}
        </span>
      ) : null}
    </button>
  );
}

export function MobileTopbar({
  title,
  subtitle,
  onMenu,
  onBack,
  onMembers,
  onMore,
  actions = null,
}) {
  return (
    <header
      className="mobile-topbar flex min-h-14 shrink-0 items-center gap-1.5 border-b border-border bg-background px-2"
    >
      {onMenu ? (
        <MobileTopbarButton label="Open server and channel menu" onClick={onMenu}>
          <svg className="size-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="4" y1="6" x2="20" y2="6" />
            <line x1="4" y1="12" x2="20" y2="12" />
            <line x1="4" y1="18" x2="20" y2="18" />
          </svg>
        </MobileTopbarButton>
      ) : onBack ? (
        <MobileTopbarButton label="Back" onClick={onBack}>
          <BackIcon className="size-5" />
        </MobileTopbarButton>
      ) : null}

      <div className="min-w-0 flex-1 px-1">
        <h1 className="truncate text-lg font-semibold tracking-tight text-foreground"><EmojiText>{title}</EmojiText></h1>
        {subtitle ? <p className="truncate text-xs text-muted"><EmojiText>{subtitle}</EmojiText></p> : null}
      </div>

      {actions}

      {onMembers ? (
        <MobileTopbarButton label="Show server members" onClick={onMembers}>
          <MembersIcon className="size-5" />
        </MobileTopbarButton>
      ) : null}

      {onMore ? (
        <MobileTopbarButton label="More options" onClick={onMore}>
          <MoreIcon className="size-5" />
        </MobileTopbarButton>
      ) : null}
    </header>
  );
}
