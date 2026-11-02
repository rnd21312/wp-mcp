import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { php } from '@codemirror/lang-php';
import CodeMirror from '@uiw/react-codemirror';
import { useTheme } from 'next-themes';

const language = (name: string) => {
  if (name === 'php') return [php({ plain: false })];
  if (name === 'css') return [css()];
  if (name === 'js') return [javascript({ jsx: true, typescript: true })];
  if (name === 'json') return [json()];

  return [html()];
};

/** Code editor (CodeMirror 6). Lazy-loaded so the panel's first paint stays small. */
export default function CodeBox({ value, onChange, lang, height }: { value: string; onChange: (v: string) => void; lang: string; height: string }) {
  const { resolvedTheme } = useTheme();

  return <CodeMirror value={value} height={height} theme={resolvedTheme === 'dark' ? 'dark' : 'light'} extensions={language(lang)} onChange={onChange} basicSetup={{ lineNumbers: true, foldGutter: false }} dir="ltr" className="overflow-hidden rounded-lg border text-sm" />;
}
