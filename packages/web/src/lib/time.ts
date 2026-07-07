/** Compact relative time: "2m ago", "3h ago", "Yesterday", "Mon", "Mar 12". */
export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "never";
  const then = new Date(iso).getTime();
  const minutes = Math.floor((Date.now() - then) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "Yesterday";
  if (days < 7) {
    return new Date(iso).toLocaleDateString(undefined, { weekday: "short" });
  }
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** "1 tool" / "3 tools" — a count with a correctly pluralized noun. */
export function count(n: number, singular: string, plural = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

export const AGENT_COLORS: Record<string, string> = {
  blue: "var(--blue)",
  green: "var(--green)",
  purple: "var(--purple)",
  amber: "var(--amber)",
};

export const AGENT_GLYPHS = ["◈", "⬢", "◎", "◇", "◉", "⬡", "✦", "⚒"];
