import { useEffect, useState } from "react";
import Library from "./pages/Library";
import Toasts from "./components/Toasts";
import Recommend from "./pages/Recommend";
import Stats from "./pages/Stats";
import Settings from "./pages/Settings";
import { readUrl, writeUrl } from "./urlState";

type Page = "recommend" | "library" | "stats" | "settings";

const PAGES: [Page, string][] = [
  ["recommend", "What next?"],
  ["library", "Library"],
  ["stats", "Stats"],
  ["settings", "Settings"],
];

const DEFAULT_PAGE: Page = "recommend";

function initialPage(): Page {
  const view = readUrl().get("view");
  return PAGES.some(([key]) => key === view) ? (view as Page) : DEFAULT_PAGE;
}

export default function App() {
  const [page, setPage] = useState<Page>(initialPage);

  // Without the tab in the URL, a bookmarked Library view would still open on
  // the Recommend page and drop its filters.
  useEffect(() => {
    writeUrl({ view: page === DEFAULT_PAGE ? null : page });
  }, [page]);

  return (
    <>
      <header className="app-header">
        <h1>
          whatGames<span>Next</span>
        </h1>
        <nav className="nav">
          {PAGES.map(([key, label]) => (
            <button key={key} className={page === key ? "active" : ""} onClick={() => setPage(key)}>
              {label}
            </button>
          ))}
        </nav>
      </header>
      <main>
        {page === "recommend" && <Recommend />}
        {page === "library" && <Library />}
        {page === "stats" && <Stats />}
        {page === "settings" && <Settings />}
      </main>
      <Toasts />
    </>
  );
}
