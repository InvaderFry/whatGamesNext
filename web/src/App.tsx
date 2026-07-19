import { useState } from "react";
import Library from "./pages/Library";
import Recommend from "./pages/Recommend";
import Stats from "./pages/Stats";
import Settings from "./pages/Settings";

type Page = "recommend" | "library" | "stats" | "settings";

export default function App() {
  const [page, setPage] = useState<Page>("recommend");

  return (
    <>
      <header className="app-header">
        <h1>
          whatGames<span>Next</span>
        </h1>
        <nav className="nav">
          {(
            [
              ["recommend", "What next?"],
              ["library", "Library"],
              ["stats", "Stats"],
              ["settings", "Settings"],
            ] as [Page, string][]
          ).map(([key, label]) => (
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
    </>
  );
}
