/** Overrides made in the visual editor: media key ('' or '@media (...)') -> selector -> property -> value. */
export type Overrides = Record<string, Record<string, Record<string, string>>>;

export const OVERRIDE_SECTION = 'visual-editor';

export const DEVICES: { key: 'desktop' | 'tablet' | 'mobile'; media: string; width: string }[] = [
  { key: 'desktop', media: '', width: '100%' },
  { key: 'tablet', media: '@media (max-width: 1024px)', width: '820px' },
  { key: 'mobile', media: '@media (max-width: 640px)', width: '390px' },
];

export function overridesToCss(ov: Overrides): string {
  const block = (r: Record<string, Record<string, string>>, pad: string): string => Object.entries(r).filter(([, d]) => Object.keys(d).length).map(([sel, d]) => `${pad}${sel}{${Object.entries(d).map(([k, v]) => `${k}:${v} !important`).join(';')}}`).join('\n');
  const parts = Object.entries(ov).map(([media, rules]) => { const body = block(rules, media ? '  ' : ''); return body ? (media ? `${media}{\n${body}\n}` : body) : ''; }).filter(Boolean);

  return `/* wpm-visual:${JSON.stringify(ov)} */\n${parts.join('\n')}`;
}

export function parseOverrides(css: string): Overrides {
  const m = /\/\* wpm-visual:(\{.*?\}) \*\//.exec(css);
  if (!m) return {};
  try {
    return JSON.parse(m[1]) as Overrides;
  } catch {
    return {};
  }
}
