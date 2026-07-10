/**
 * Theme switching. The inline script in index.html applies the initial
 * theme pre-paint (stored preference, else OS preference); this module is
 * the single writer afterwards. Components re-render off useTheme() /
 * useThemePref().
 *
 * Preference model: "system" (default — follow the OS, live), or an
 * explicit "light" / "dark" override. The stored key holds "light" or
 * "dark" only for explicit overrides; "system" clears it, which is also
 * what the pre-paint script treats as follow-the-OS.
 */
import { useSyncExternalStore } from "react";

export type Theme = "dark" | "light";
export type ThemePref = Theme | "system";

const STORAGE_KEY = "rabble-theme";
const listeners = new Set<() => void>();

const osQuery = window.matchMedia("(prefers-color-scheme: light)");
// While on "system", track OS changes live.
osQuery.addEventListener("change", () => {
  if (getThemePref() === "system") {
    document.documentElement.dataset.theme = osQuery.matches ? "light" : "dark";
    notify();
  }
});

function notify() {
  listeners.forEach((fn) => fn());
}

export function getThemePref(): ThemePref {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === "light" || stored === "dark" ? stored : "system";
  } catch {
    return "system";
  }
}

export function getTheme(): Theme {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

export function setThemePref(pref: ThemePref): void {
  try {
    if (pref === "system") localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, pref);
  } catch {
    // Storage unavailable (private mode etc.) — theme still applies.
  }
  const effective: Theme =
    pref === "system" ? (osQuery.matches ? "light" : "dark") : pref;
  document.documentElement.dataset.theme = effective;
  notify();
}

/** Rail toggle: explicit flip to the opposite of what's on screen. */
export function toggleTheme(): Theme {
  const next: Theme = getTheme() === "dark" ? "light" : "dark";
  setThemePref(next);
  return next;
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Current effective theme as reactive state. */
export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, getTheme);
}

/** Current preference (system/light/dark) as reactive state. */
export function useThemePref(): ThemePref {
  return useSyncExternalStore(subscribe, getThemePref);
}
