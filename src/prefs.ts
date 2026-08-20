import { getMeta, setMeta } from "./db.js";

export const META_AUTO_APPLY_ALL = "auto_apply_all";

export function isAutoApplyAll(): boolean {
  return getMeta(META_AUTO_APPLY_ALL) === "1";
}

export function setAutoApplyAll(on: boolean): void {
  setMeta(META_AUTO_APPLY_ALL, on ? "1" : "0");
}

export function prefsStatus(): { autoApplyAll: boolean } {
  return { autoApplyAll: isAutoApplyAll() };
}
