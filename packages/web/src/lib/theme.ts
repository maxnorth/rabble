/**
 * Theme switching. The inline script in index.html applies the initial
 * theme pre-paint (stored preference, else OS preference); this module is
 * the single writer afterwards. Components re-render off useTheme().
 */
import { useSyncExternalStore } from "react";

export type Theme = "dark" | "light";

const STORAGE_KEY = "rabble-theme";
const listeners = new Set<() => void>();

export function getTheme(): Theme {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

export function setTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Storage unavailable (private mode etc.) — theme still applies.
  }
  listeners.forEach((fn) => fn());
}

export function toggleTheme(): Theme {
  const next: Theme = getTheme() === "dark" ? "light" : "dark";
  setTheme(next);
  return next;
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Current theme as reactive state (updates any component using it). */
export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, getTheme);
}
