/** Overrides made in the inspector: media key ('' or '@media (...)') -> selector -> property -> value. */
export type Overrides = Record<string, Record<string, Record<string, string>>>;

export const OVERRIDE_SECTION = 'visual-editor';

export function overridesToCss(ov: Overrides): string {
  const block = (r: Record<string, Record<string, string>>, pad: string): string => Object.entries(r).filter(([, d]) => Object.keys(d).length).map(([sel, d]) => `${pad}${sel}{${Object.entries(d).map(([k, v]) => `${k}:${v} !important`).join(';')}}`).join('\n');
  const parts = Object.entries(ov).map(([media, rules]) => { const body = block(rules, media ? '  ' : ''); return body ? (media ? `${media}{\n${body}\n}` : body) : ''; }).filter(Boolean);

  return `/* wpm-visual:${JSON.stringify(ov)} */\n${parts.join('\n')}`;
}

export function parseOverrides(css: string): Overrides {
  const m = /\/\* wpm-visual:(\{.*?\}) \*\//.exec(css);
  if (!m) return {};
  try {
    const data = JSON.parse(m[1]);
    // Older files used desktop/tablet/mobile buckets.
    if (data.desktop || data.tablet || data.mobile) return { '': data.desktop ?? {}, '@media (max-width: 1024px)': data.tablet ?? {}, '@media (max-width: 640px)': data.mobile ?? {} };

    return data;
  } catch {
    return {};
  }
}
