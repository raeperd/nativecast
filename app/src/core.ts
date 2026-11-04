// The launcher UI. The compiled core has no JSON.parse and no JS engine, so
// everything from the host arrives as tab-separated lines and is split here.
//
// Host stdout (Cmd.spawn, one stream for the app's lifetime):
//   READY <port> <token> | HOTKEY | LOADED <name> <ms> | ERROR <name> <message> | REMOVED <name>
// Search response (Cmd.fetch line stream, one per keystroke):
//   S <seq> | R <seq> <source> <title> <subtitle> <url|copy> <value> | D <seq>
//
// Streaming fetch rejects a live duplicate key, so searches carry no key at
// all. The host ends the previous stream when a new search arrives, and
// lines from older searches are dropped here by seq.

import { Cmd, asciiBytes, utf8Bytes } from "@native-sdk/core";
import { type StatusItemState } from "@native-sdk/core/events";
import { type ThemeDesignTokenOverrides } from "@native-sdk/core/theme";
import {
  applyTextInputEvent,
  clampedInsertEvent,
  type TextEditState,
  type TextInputEvent,
} from "@native-sdk/core/text";

export type Bytes = Uint8Array;

const MAX_QUERY_BYTES = 256;
const MAX_ROWS = 50;

const EMPTY_BYTES = asciiBytes("");
const TAB = asciiBytes("\t");

// The argv is fixed at compile time and a packaged app starts with cwd `/`, so
// sh derives the bundle path from its parent. NATIVECAST_HOST overrides it for
// development builds, which have no bundle.
const HOST_LAUNCHER = 'exec "${NATIVECAST_HOST:-$(dirname "$(ps -o comm= -p $PPID)")/nativecast-host}"';

export interface Row {
  readonly source: Bytes;
  readonly title: Bytes;
  readonly subtitle: Bytes;
  readonly action: Bytes;
  readonly value: Bytes;
}

export interface VisibleRow {
  readonly id: number;
  readonly source: Bytes;
  readonly title: Bytes;
  readonly subtitle: Bytes;
  readonly selected: boolean;
}

export interface SearchDraft {
  readonly bytes: Bytes;
  readonly anchor: number;
  readonly focus: number;
  readonly compStart: number; // -1 when no composition
  readonly compEnd: number;
}

export interface Model {
  readonly search: SearchDraft;
  readonly seq: number;
  readonly url: Bytes;
  readonly authorization: Bytes;
  readonly rows: readonly Row[];
  readonly rowCount: number;
  readonly selected: number;
  readonly status: Bytes;
  readonly visible: boolean;
}

export type Msg =
  | { readonly kind: "search_edit"; readonly edit: TextInputEvent }
  | { readonly kind: "activate" }
  | { readonly kind: "choose"; readonly id: number }
  | { readonly kind: "select_next" }
  | { readonly kind: "select_previous" }
  | { readonly kind: "toggle" }
  | { readonly kind: "hide" }
  | { readonly kind: "quit" }
  | { readonly kind: "host_line"; readonly line: Bytes }
  | { readonly kind: "host_exit"; readonly code: number }
  | { readonly kind: "host_failed"; readonly reason: Bytes }
  | { readonly kind: "search_line"; readonly line: Bytes }
  | { readonly kind: "search_ended"; readonly status: number }
  | { readonly kind: "search_failed"; readonly reason: Bytes };

export const viewUnbound = [
  "toggle", "hide", "quit", "select_next", "select_previous",
  "host_line", "host_exit", "host_failed", "search_line", "search_ended", "search_failed",
  "search", "seq", "url", "authorization", "rows", "rowCount", "selected",
] as const;

export function initialModel(): [Model, Cmd<Msg>] {
  return [
    {
      search: { bytes: EMPTY_BYTES, anchor: 0, focus: 0, compStart: -1, compEnd: -1 },
      seq: 0,
      url: EMPTY_BYTES,
      authorization: EMPTY_BYTES,
      rows: [],
      rowCount: 0,
      selected: 0,
      status: utf8Bytes("Starting host…"),
      visible: false,
    },
    Cmd.spawn([asciiBytes("/bin/sh"), asciiBytes("-c"), asciiBytes(HOST_LAUNCHER)], {
      key: "host",
      line: "host_line",
      exit: "host_exit",
      err: "host_failed",
    }),
  ];
}

export function update(model: Model, msg: Msg): Model | [Model, Cmd<Msg>] {
  switch (msg.kind) {
    case "search_edit": {
      const search = applyEdit(model.search, msg.edit);
      if (sameBytes(search.bytes, model.search.bytes)) return { ...model, search };
      const seq = model.seq < 1000000000 ? model.seq + 1 : 0;
      return [
        { ...model, search, seq },
        Cmd.fetch(
          {
            url: model.url,
            method: "POST",
            headers: { Authorization: model.authorization },
            body: searchBody(seq, search.bytes),
            timeoutMs: 30000,
            maxLineBytes: 8192,
          },
          { line: "search_line", ok: "search_ended", err: "search_failed" },
        ),
      ];
    }
    case "activate": {
      const row = model.rows[model.selected];
      if (row === undefined) return model;
      if (hasPrefix(row.action, asciiBytes("url"))) {
        return [{ ...model, visible: false }, Cmd.batch([Cmd.openExternalUrl(row.value), Cmd.hideWindow("main")])];
      }
      return [{ ...model, visible: false }, Cmd.batch([Cmd.clipboardWrite(row.value), Cmd.hideWindow("main"), Cmd.fetch(
          { url: joinBytes([model.url, asciiBytes("restore-focus")]), method: "POST", headers: { Authorization: model.authorization }, timeoutMs: 2000, maxLineBytes: 8192 },
          { line: "search_line", ok: "search_ended", err: "search_failed" },
        )])];
    }
    case "choose":
      return { ...model, selected: msg.id };
    case "select_next": {
      const next = model.selected < 1000 ? model.selected + 1 : model.selected;
      return { ...model, selected: next < model.rowCount ? next : model.selected };
    }
    case "select_previous":
      return { ...model, selected: model.selected > 0 ? model.selected - 1 : 0 };
    case "toggle":
      if (model.visible) return [{ ...model, visible: false }, Cmd.batch([Cmd.hideWindow("main"), Cmd.fetch(
          { url: joinBytes([model.url, asciiBytes("restore-focus")]), method: "POST", headers: { Authorization: model.authorization }, timeoutMs: 2000, maxLineBytes: 8192 },
          { line: "search_line", ok: "search_ended", err: "search_failed" },
        )])];
      return [{ ...model, visible: true }, Cmd.showWindow("main")];
    case "hide":
      return [{ ...model, visible: false }, Cmd.batch([Cmd.hideWindow("main"), Cmd.fetch(
          { url: joinBytes([model.url, asciiBytes("restore-focus")]), method: "POST", headers: { Authorization: model.authorization }, timeoutMs: 2000, maxLineBytes: 8192 },
          { line: "search_line", ok: "search_ended", err: "search_failed" },
        )])];
    case "quit":
      return [model, Cmd.quitApp()];
    case "host_line":
      if (!hasPrefix(msg.line, asciiBytes("HOTKEY"))) return onHostLine(model, msg.line);
      if (model.visible) return [{ ...model, visible: false }, Cmd.batch([Cmd.hideWindow("main"), Cmd.fetch(
          { url: joinBytes([model.url, asciiBytes("restore-focus")]), method: "POST", headers: { Authorization: model.authorization }, timeoutMs: 2000, maxLineBytes: 8192 },
          { line: "search_line", ok: "search_ended", err: "search_failed" },
        )])];
      return [{ ...model, visible: true }, Cmd.showWindow("main")];
    case "host_exit":
      return { ...model, status: utf8Bytes(`Host exited with code ${Math.trunc(msg.code)}`) };
    case "host_failed":
      return { ...model, status: joinBytes([utf8Bytes("Host failed: "), msg.reason]) };
    case "search_line":
      return onSearchLine(model, msg.line);
    case "search_ended":
      return model;
    case "search_failed":
      return { ...model, status: joinBytes([utf8Bytes("Search failed: "), msg.reason]) };
  }
}

function onHostLine(model: Model, line: Bytes): Model {
  const fields = splitFields(line);
  const event = fields[0];
  if (hasPrefix(event, asciiBytes("READY"))) {
    return {
      ...model,
      url: joinBytes([asciiBytes("http://127.0.0.1:"), fields[1], asciiBytes("/")]),
      authorization: joinBytes([asciiBytes("Bearer "), fields[2]]),
      status: utf8Bytes("Ready"),
    };
  }
  if (hasPrefix(event, asciiBytes("LOADED"))) {
    return { ...model, status: joinBytes([utf8Bytes("Loaded "), fields[1], utf8Bytes(" in "), fields[2], utf8Bytes(" ms")]) };
  }
  if (hasPrefix(event, asciiBytes("REMOVED"))) {
    return { ...model, status: joinBytes([utf8Bytes("Removed "), fields[1]]) };
  }
  if (hasPrefix(event, asciiBytes("ERROR"))) {
    return { ...model, status: joinBytes([utf8Bytes("Error in "), fields[1], utf8Bytes(": "), fields[2]]) };
  }
  return model;
}

function onSearchLine(model: Model, line: Bytes): Model {
  const fields = splitFields(line);
  if (fields.length < 2 || !sameBytes(fields[1], asciiBytes(`${model.seq}`))) return model;
  if (hasPrefix(fields[0], asciiBytes("S"))) return { ...model, rows: [], rowCount: 0, selected: 0 };
  if (!hasPrefix(fields[0], asciiBytes("R")) || fields.length < 7 || model.rowCount >= MAX_ROWS) return model;
  const row: Row = {
    source: fields[2],
    title: fields[3],
    subtitle: fields[4],
    action: fields[5],
    value: fields[6],
  };
  return { ...model, rows: [...model.rows, row], rowCount: model.rowCount < 1000 ? model.rowCount + 1 : model.rowCount };
}

function searchBody(seq: number, query: Bytes): Bytes {
  return joinBytes([asciiBytes(`${seq}`), TAB, query]);
}

function applyEdit(draft: SearchDraft, event: TextInputEvent): SearchDraft {
  const state: TextEditState = {
    text: draft.bytes,
    selection: { anchor: draft.anchor, focus: draft.focus },
    composition: draft.compStart >= 0 ? { start: draft.compStart, end: draft.compEnd } : null,
  };
  const clamped = clampedInsertEvent(state, event, MAX_QUERY_BYTES);
  const next = applyTextInputEvent(state, clamped ?? event, MAX_QUERY_BYTES);
  if (next === null) return draft;
  const compStart = next.composition !== null ? next.composition.start : -1;
  const compEnd = next.composition !== null ? next.composition.end : -1;
  return {
    bytes: next.text,
    anchor: Math.trunc(next.selection.anchor),
    focus: Math.trunc(next.selection.focus),
    compStart: compStart >= -1 && compStart <= 9007199254740991 ? Math.trunc(compStart) : -1,
    compEnd: compEnd >= -1 && compEnd <= 9007199254740991 ? Math.trunc(compEnd) : -1,
  };
}

function joinBytes(parts: readonly Bytes[]): Bytes {
  let length = 0;
  for (const part of parts) length += part.length;
  const out = new Uint8Array(length);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function sameBytes(a: Bytes, b: Bytes): boolean {
  return a.length === b.length && hasPrefix(a, b);
}

// The SDK docs list split/startsWith on bytes, but compiler 0.3.0 rejects them.
function hasPrefix(value: Bytes, prefix: Bytes): boolean {
  if (value.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (value[i] !== prefix[i]) return false;
  }
  return true;
}

function splitFields(line: Bytes): Bytes[] {
  const fields: Bytes[] = [];
  let start = 0;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === 9) {
      fields.push(line.subarray(start, i));
      start = i + 1;
    }
  }
  fields.push(line.subarray(start, line.length));
  return fields;
}

// ------------------------------------------------------------- view bindings

export function searchText(model: Model): Bytes {
  return model.search.bytes;
}

export function visibleRows(model: Model): readonly VisibleRow[] {
  return model.rows.map((row, index) => ({
    id: index >= 0 && index <= 9007199254740991 ? Math.trunc(index) : 0,
    source: row.source,
    title: row.title,
    subtitle: row.subtitle,
    selected: index === model.selected,
  }));
}

// ----------------------------------------------------------------- app shell

export function commandMsg(name: string): Msg | null {
  if (name === "app.toggle") return { kind: "toggle" };
  if (name === "app.quit") return { kind: "quit" };
  if (name === "window.hide") return { kind: "hide" };
  if (name === "list.next") return { kind: "select_next" };
  if (name === "list.previous") return { kind: "select_previous" };
  return null;
}

/// Font id 64 is Noto Sans KR from app.json; the stock faces have no Hangul.
export function tokenOverrides(_model: Model): ThemeDesignTokenOverrides {
  return { typography: { font_id: 64, button_font_id: 64 } };
}

export function statusItem(model: Model): StatusItemState {
  const noModifiers = { primary: false, command: false, control: false, option: false, shift: false };
  return {
    iconPath: EMPTY_BYTES,
    tooltip: utf8Bytes("nativecast"),
    activationCommand: EMPTY_BYTES,
    alternateActivationCommand: EMPTY_BYTES,
    openCommand: EMPTY_BYTES,
    presentation: { title: utf8Bytes("NC"), width: 0, tone: "normal", iconOpacity: 1, monospaced: false, fontSize: 0 },
    items: [
      { id: 1, label: model.visible ? utf8Bytes("Hide") : utf8Bytes("Show"), command: asciiBytes("app.toggle"), separator: false, enabled: true, detail: EMPTY_BYTES, role: "command", key: EMPTY_BYTES, modifiers: noModifiers },
      { id: 2, label: utf8Bytes("Quit"), command: asciiBytes("app.quit"), separator: false, enabled: true, detail: EMPTY_BYTES, role: "command", key: EMPTY_BYTES, modifiers: noModifiers },
    ],
  };
}
