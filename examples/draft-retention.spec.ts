// DSL 版 draft-retention spec（FR-01）。examples/draft-retention.spec.json と同じ意味を
// 型付き DSL で記述する。
// 使い方: node src/cli.ts examples/draft-retention.spec.ts --targets model
import {
  defineSpec,
  eq,
  literal,
  ne,
  ref,
} from "../src/dsl.ts";

const isDraft = (v: string) => eq(ref("draft"), literal(v));

export const specification = defineSpec({
  states: [{ id: "draft", domain: ["empty", "dirty", "saved"] }],
  initialState: { values: [{ variable: "draft", value: "empty" }] },
  events: [
    { id: "edit", kind: "user" },
    { id: "save", kind: "user" },
    { id: "discard", kind: "user" },
    { id: "reload", kind: "browser" },
  ],
  transitions: [
    {
      id: "t_edit",
      event: "edit",
      set: { draft: literal("dirty") },
    },
    {
      id: "t_save",
      event: "save",
      when: isDraft("dirty"),
      set: { draft: literal("saved") },
    },
    {
      id: "t_discard",
      event: "discard",
      when: ne(ref("draft"), literal("empty")),
      set: { draft: literal("empty") },
    },
    // set: {} — 有効だが抽象状態を変えない（FR-04）
    { id: "t_reload", event: "reload", set: {} },
  ],
  properties: [
    {
      id: "no_implicit_discard",
      kind: "neverTransition",
      from: isDraft("dirty"),
      to: isDraft("empty"),
      unless: "discard",
    },
    {
      id: "empty_can_be_saved",
      kind: "canReach",
      from: isDraft("empty"),
      to: isDraft("saved"),
    },
    {
      id: "dirty_is_escapable_by_user",
      kind: "escapable",
      from: isDraft("dirty"),
      by: "user",
    },
  ],
  analysis: { maxStates: 100, maxDepth: 10, maxTransitions: 10000 },
});
