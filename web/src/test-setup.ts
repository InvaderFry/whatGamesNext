import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// jsdom implements layout as a no-op and omits scrollIntoView entirely, but it
// exists in every browser we target.
Element.prototype.scrollIntoView ??= () => {};

afterEach(() => {
  cleanup();
});
