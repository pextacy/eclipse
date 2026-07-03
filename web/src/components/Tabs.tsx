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
      <div className="flex items-stretch">
        {tabs.map((t) => {
          const on = t.id === active;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => onChange(t.id)}
              className={[
                "relative px-4 py-3 text-sm transition-colors",
                on ? "text-eclipse" : "text-muted hover:text-ink",
              ].join(" ")}
            >
              <span className="font-semibold">{t.label}</span>
              {t.hint && (
                <span className="ml-2 hidden text-2xs text-muted md:inline">{t.hint}</span>
              )}
              {on && <span className="absolute inset-x-0 bottom-0 h-0.5 bg-eclipse" />}
            </button>
          );
        })}
      </div>
      {right && <div className="flex items-center pr-3">{right}</div>}
    </nav>
  );
}
