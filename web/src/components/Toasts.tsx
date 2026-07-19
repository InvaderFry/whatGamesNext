import { useEffect, useState } from "react";

/**
 * Minimal toast notifications for errors that would otherwise be swallowed
 * (background fetches with no natural place in the layout for an error).
 * Call toast("message") from anywhere; <Toasts /> renders them in App.
 */

type Listener = (message: string) => void;
let listener: Listener | null = null;

export function toast(message: string) {
  listener?.(message);
}

interface Entry {
  id: number;
  message: string;
}

let nextId = 1;

export default function Toasts() {
  const [entries, setEntries] = useState<Entry[]>([]);

  useEffect(() => {
    listener = (message) => {
      const id = nextId++;
      setEntries((e) => [...e, { id, message }]);
      setTimeout(() => setEntries((e) => e.filter((t) => t.id !== id)), 6000);
    };
    return () => {
      listener = null;
    };
  }, []);

  if (!entries.length) return null;
  return (
    <div className="toasts" role="status" aria-live="polite">
      {entries.map((t) => (
        <div key={t.id} className="toast">
          {t.message}
          <button
            aria-label="Dismiss notification"
            onClick={() => setEntries((e) => e.filter((x) => x.id !== t.id))}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
