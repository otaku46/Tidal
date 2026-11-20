import { DraftApp, IgnoreFillApp, LocatorFailureApp, LosesSavedOnReloadApp, MockAdapter, OracleErrorApp, type MockApp } from "./adapter.ts";
import type { Binding } from "./binding.ts";

// FR-28: independent mock implementations for golden tests.
// Names map to fixture behaviors; each holds concrete values itself.
export function makeMockApp(name: string): MockApp {
  switch (name) {
    case "retains":
      return new DraftApp("retains", "never");
    case "loses-on-reload":
      return new DraftApp("loses-on-reload", "always");
    case "flaky":
      // loses draft on even attempts (incl. attempt 0) → replay mixes MATCH/MISMATCH
      return new DraftApp("flaky", (attempt) => attempt % 2 === 0);
    case "ignores-edit":
      return new IgnoreFillApp();
    case "loses-saved-on-reload":
      return new LosesSavedOnReloadApp();
    case "oracle-error":
      return new OracleErrorApp();
    case "locator-failure":
      return new LocatorFailureApp();
    default:
      throw new Error(`unknown fixture: ${name}`);
  }
}

export function makeMockAdapter(fixture: string, binding: Binding): MockAdapter {
  return new MockAdapter(makeMockApp(fixture), binding);
}
