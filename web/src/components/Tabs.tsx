import type { ReactNode } from "react";

export interface TabDef {
  id: string;
  label: string;
  hint?: string;
}

interface TabsProps {
  tabs: TabDef[];
  active: string;
  onChange: (id: string) => void;
  right?: ReactNode;
}

/** Flat terminal tab bar. Active tab: solid accent underline, no gradient. */
export function Tabs({ tabs, active, onChange, right }: TabsProps) {
  return (
    <nav className="flex items-stretch justify-between border-b border-line bg-surface">
      {/* Scrolls horizontally on narrow screens instead of overflowing/wrapping. */}
      <div className="flex items-stretch overflow-x-auto">
        {tabs.map((t, i) => {
          const on = t.id === active;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => onChange(t.id)}
              className={[
                "relative shrink-0 whitespace-nowrap px-4 py-3 text-sm transition-colors",
                on ? "text-eclipse" : "text-muted hover:text-ink",
              ].join(" ")}
              title={`${t.label}${t.hint ? ` — ${t.hint}` : ""} (press ${i + 1})`}
            >
              <span className="mr-1.5 hidden text-2xs text-subtle sm:inline">{i + 1}</span>
              <span className="font-semibold">{t.label}</span>
              {t.hint && (
                <span className="ml-2 hidden text-2xs text-muted lg:inline">{t.hint}</span>
              )}
              {on && <span className="absolute inset-x-0 bottom-0 h-0.5 bg-eclipse" />}
            </button>
          );
        })}
      </div>
      {right && <div className="flex shrink-0 items-center pr-3">{right}</div>}
    </nav>
  );
}
