import { useState } from "react";

/**
 * A title that is visibly editable: hover reveals a pencil, clicking it
 * swaps to an input with Save/Cancel (Enter/Escape work too). The antidote
 * to one-way doors — anything renameable should LOOK renameable.
 */
export function EditableTitle({
  value,
  onSave,
  canEdit = true,
  className,
  inputWidth = 220,
}: {
  value: string;
  onSave: (next: string) => Promise<void> | void;
  canEdit?: boolean;
  className?: string;
  inputWidth?: number;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [busy, setBusy] = useState(false);

  const commit = async () => {
    const next = draft.trim();
    if (!next || next === value) {
      setEditing(false);
      setDraft(value);
      return;
    }
    setBusy(true);
    try {
      await onSave(next);
      setEditing(false);
    } finally {
      setBusy(false);
    }
  };

  if (!editing) {
    return (
      <span className={`editable-title ${className ?? ""}`}>
        {value}
        {canEdit && (
          <button
            type="button"
            className="rename-btn"
            title="Rename"
            aria-label={`Rename ${value}`}
            onClick={() => {
              setDraft(value);
              setEditing(true);
            }}
          >
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" />
            </svg>
          </button>
        )}
      </span>
    );
  }

  return (
    <span className="editable-title editing">
      <input
        autoFocus
        value={draft}
        disabled={busy}
        style={{ width: inputWidth }}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void commit();
          if (e.key === "Escape") {
            setEditing(false);
            setDraft(value);
          }
        }}
      />
      <button className="btn" disabled={busy} onClick={() => void commit()}>
        Save
      </button>
      <button
        className="btn"
        disabled={busy}
        onClick={() => {
          setEditing(false);
          setDraft(value);
        }}
      >
        Cancel
      </button>
    </span>
  );
}
