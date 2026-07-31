/**
 * Placeholder cards for a grid that is still loading. Every page used to render
 * null while fetching, so switching tabs flashed an empty screen.
 *
 * Marked aria-hidden and announced separately: a screen reader wants "loading",
 * not a description of eight fake cards.
 */
export default function SkeletonGrid({ count = 8 }: { count?: number }) {
  return (
    <>
      <p className="sr-only" role="status">
        Loading…
      </p>
      <div className="grid" aria-hidden="true">
        {Array.from({ length: count }, (_, i) => (
          <div className="skeleton-card" key={i}>
            <div className="cover" />
            <div className="body">
              <div className="skeleton-line" style={{ width: "70%" }} />
              <div className="skeleton-line" style={{ width: "45%" }} />
              <div className="skeleton-line" style={{ width: "85%" }} />
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
