import { useCallback, useEffect, useState } from "react";

/**
 * Client-side user settings (localStorage). Small, synchronous, and readable
 * outside React (getSettings) so plain fetch helpers like relayUrl() can consult
 * it. Nothing here is secret or shared.
 */

export interface Settings {
  /** Runtime relay URL override; empty → fall back to env/default. */
  relayUrl: string;
  /** Trader's own max tolerated deviation from the FTSO mid, in bps. A softer,
   *  configurable guard layered on top of the hard on-chain fairness band. */
  slippageBps: number;
}

export const DEFAULT_SETTINGS: Settings = {
  relayUrl: "",
  slippageBps: 30,
};

const KEY = "eclipse.settings.v1";
const EVENT = "eclipse-settings-changed";

export function getSettings(): Settings {
  if (typeof window === "undefined") return DEFAULT_SETTINGS;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return {
      relayUrl: typeof parsed.relayUrl === "string" ? parsed.relayUrl : DEFAULT_SETTINGS.relayUrl,
      slippageBps:
        typeof parsed.slippageBps === "number" && parsed.slippageBps >= 0
          ? parsed.slippageBps
          : DEFAULT_SETTINGS.slippageBps,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function persist(s: Settings) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage disabled — settings stay at defaults */
  }
  window.dispatchEvent(new Event(EVENT));
}

export function useSettings(): {
  settings: Settings;
  update: (patch: Partial<Settings>) => void;
  reset: () => void;
} {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);

  const refresh = useCallback(() => setSettings(getSettings()), []);

  useEffect(() => {
    refresh();
    const onChange = () => refresh();
    window.addEventListener(EVENT, onChange);
    window.addEventListener("storage", onChange);
    return () => {
      window.removeEventListener(EVENT, onChange);
      window.removeEventListener("storage", onChange);
    };
  }, [refresh]);

  const update = useCallback((patch: Partial<Settings>) => {
    persist({ ...getSettings(), ...patch });
  }, []);

  const reset = useCallback(() => persist(DEFAULT_SETTINGS), []);

  return { settings, update, reset };
}
