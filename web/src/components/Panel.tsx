import type { ReactNode } from "react";

interface PanelProps {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}

/** Flat bordered surface. Solid fill, 1px hairline border — no gradients. */
export function Panel({ title, subtitle, actions, children, className }: PanelProps) {
  return (
    <section className={`panel ${className ?? ""}`}>
      {(title || actions) && (
        <header className="flex items-center justify-between border-b border-line px-4 py-2.5">
          <div>
            {title && (
              <h2 className="text-xs font-semibold uppercase tracking-wider text-subtle">
                {title}
              </h2>
            )}
            {subtitle && <p className="mt-0.5 text-2xs text-muted">{subtitle}</p>}
          </div>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}
