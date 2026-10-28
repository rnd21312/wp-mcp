import { loader } from '@monaco-editor/react';
import { emmetCSS, emmetHTML } from 'emmet-monaco-es';
import * as monaco from 'monaco-editor';
import cssWorker from 'monaco-editor/language/css/css.worker?worker';
import htmlWorker from 'monaco-editor/language/html/html.worker?worker';
import jsonWorker from 'monaco-editor/language/json/json.worker?worker';
import tsWorker from 'monaco-editor/language/typescript/ts.worker?worker';
import editorWorker from 'monaco-editor/editor/editor.worker?worker';

(self as any).MonacoEnvironment = {
  getWorker(_: unknown, label: string) {
    if (label === 'json') return new jsonWorker();
    if (label === 'css' || label === 'scss' || label === 'less') return new cssWorker();
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new htmlWorker();
    if (label === 'typescript' || label === 'javascript') return new tsWorker();
    return new editorWorker();
  },
};

loader.config({ monaco });
emmetHTML(monaco);
emmetCSS(monaco);

export { monaco };

export const languageOf = (path: string): string => {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';

  return ({ php: 'php', css: 'css', js: 'javascript', mjs: 'javascript', json: 'json', html: 'html', htm: 'html', twig: 'html', md: 'markdown', svg: 'xml', xml: 'xml', txt: 'plaintext', ini: 'ini', yml: 'yaml', yaml: 'yaml' } as Record<string, string>)[ext] ?? 'plaintext';
};
