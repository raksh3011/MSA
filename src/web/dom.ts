/**
 * Tiny DOM builder. All dynamic text goes through textContent — never innerHTML —
 * because vessel names and alert messages originate from untrusted AIS data.
 */
type Child = Node | string | number | null | undefined | false;
type Attrs = Record<string, string | number | boolean | EventListener | undefined>;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (typeof v === 'function') el.addEventListener(k.replace(/^on/, '').toLowerCase(), v);
    else if (k === 'class') el.className = String(v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === 'object' ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function clear(el: Element): void {
  el.replaceChildren();
}

export const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document): T => {
  const el = root.querySelector<T>(sel);
  if (!el) throw new Error(`Missing element: ${sel}`);
  return el;
};

export function fmtTime(ts: number): string {
  return new Date(ts).toISOString().slice(11, 16) + ' UTC';
}
export function fmtDateTime(ts: number): string {
  return new Date(ts).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}
