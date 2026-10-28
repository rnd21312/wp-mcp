/**
 * Project templates that need a build step. Each returns plain files; nothing is installed until the person presses Build.
 * Versions are caret ranges of current majors; `npm install` writes the lock file on first build.
 */

export interface FrameworkTemplate {
  label: string;
  framework: string;
  /** Site type on the host. */
  kind: 'static' | 'spa' | 'node';
  /** Folder that goes live after the build. */
  publish: string;
  note: string;
  /** Node apps: the file the host starts. */
  startup?: string;
  files: (title: string, rtl: boolean) => Record<string, string>;
}

import { NODE_TEMPLATES } from './templates-node.ts';

const json = (v: unknown): string => JSON.stringify(v, null, 2) + '\n';
const esc = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'site';

const css = (rtl: boolean): string => `:root{--accent:#2563eb;--fg:#14213d}*{box-sizing:border-box}body{margin:0;font-family:system-ui,Tahoma,sans-serif;color:var(--fg);line-height:1.7${rtl ? ';direction:rtl' : ''}}
main{max-width:720px;margin:0 auto;padding:4rem 1.5rem;text-align:center}h1{font-size:clamp(2rem,6vw,3rem);margin:0 0 .5rem}
button{padding:.6rem 1.2rem;border:0;border-radius:.6rem;background:var(--accent);color:#fff;font:inherit;cursor:pointer}
`;

const hello = (rtl: boolean) => ({ lead: rtl ? 'سایت شما با موفقیت ساخته شد.' : 'Your site is up and running.', count: rtl ? 'شمارش' : 'Count' });

const viteIndex = (title: string, rtl: boolean, entry: string): string => `<!doctype html>
<html lang="${rtl ? 'fa' : 'en'}" dir="${rtl ? 'rtl' : 'ltr'}">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${esc(title)}</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="${entry}"></script>
  </body>
</html>
`;

// base './' keeps asset links relative, so the build works in a sub-folder of the host as well as at the root.
const viteConfig = (import_: string, plugin: string): string => `import { defineConfig } from 'vite';\n${import_}\n\nexport default defineConfig({ base: './', plugins: [${plugin}] });\n`;

export const FRAMEWORKS: Record<string, FrameworkTemplate> = {
  ...NODE_TEMPLATES,
  'vite-react': {
    label: 'React (Vite)',
    framework: 'vite-react',
    kind: 'spa',
    publish: 'dist',
    note: 'Single-page app. Relative asset paths, so it works in a sub-folder too.',
    files: (title, rtl) => ({
      'package.json': json({ name: slug(title), private: true, version: '0.0.0', type: 'module', scripts: { dev: 'vite', build: 'vite build', preview: 'vite preview' }, dependencies: { react: '^19.0.0', 'react-dom': '^19.0.0' }, devDependencies: { '@vitejs/plugin-react': '^4.3.4', vite: '^6.0.0' } }),
      'vite.config.js': viteConfig("import react from '@vitejs/plugin-react';", 'react()'),
      'index.html': viteIndex(title, rtl, '/src/main.jsx'),
      'src/main.jsx': `import { createRoot } from 'react-dom/client';\nimport App from './App.jsx';\nimport './style.css';\n\ncreateRoot(document.getElementById('app')).render(<App />);\n`,
      'src/App.jsx': `import { useState } from 'react';\n\nexport default function App() {\n  const [n, setN] = useState(0);\n  return (\n    <main>\n      <h1>${esc(title)}</h1>\n      <p>${hello(rtl).lead}</p>\n      <button onClick={() => setN(n + 1)}>${hello(rtl).count}: {n}</button>\n    </main>\n  );\n}\n`,
      'src/style.css': css(rtl),
    }),
  },
  'vite-vue': {
    label: 'Vue (Vite)',
    framework: 'vite-vue',
    kind: 'spa',
    publish: 'dist',
    note: 'Single-page app with Vue 3.',
    files: (title, rtl) => ({
      'package.json': json({ name: slug(title), private: true, version: '0.0.0', type: 'module', scripts: { dev: 'vite', build: 'vite build', preview: 'vite preview' }, dependencies: { vue: '^3.5.0' }, devDependencies: { '@vitejs/plugin-vue': '^5.2.0', vite: '^6.0.0' } }),
      'vite.config.js': viteConfig("import vue from '@vitejs/plugin-vue';", 'vue()'),
      'index.html': viteIndex(title, rtl, '/src/main.js'),
      'src/main.js': `import { createApp } from 'vue';\nimport App from './App.vue';\nimport './style.css';\n\ncreateApp(App).mount('#app');\n`,
      'src/App.vue': `<script setup>\nimport { ref } from 'vue';\nconst n = ref(0);\n</script>\n\n<template>\n  <main>\n    <h1>${esc(title)}</h1>\n    <p>${hello(rtl).lead}</p>\n    <button @click="n++">${hello(rtl).count}: {{ n }}</button>\n  </main>\n</template>\n`,
      'src/style.css': css(rtl),
    }),
  },
  'vite-svelte': {
    label: 'Svelte (Vite)',
    framework: 'vite-svelte',
    kind: 'spa',
    publish: 'dist',
    note: 'Single-page app with Svelte 5.',
    files: (title, rtl) => ({
      'package.json': json({ name: slug(title), private: true, version: '0.0.0', type: 'module', scripts: { dev: 'vite', build: 'vite build', preview: 'vite preview' }, dependencies: { svelte: '^5.0.0' }, devDependencies: { '@sveltejs/vite-plugin-svelte': '^5.0.0', vite: '^6.0.0' } }),
      'vite.config.js': viteConfig("import { svelte } from '@sveltejs/vite-plugin-svelte';", 'svelte()'),
      'svelte.config.js': `import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';\n\nexport default { preprocess: vitePreprocess() };\n`,
      'index.html': viteIndex(title, rtl, '/src/main.js'),
      'src/main.js': `import { mount } from 'svelte';\nimport App from './App.svelte';\nimport './style.css';\n\nmount(App, { target: document.getElementById('app') });\n`,
      'src/App.svelte': `<script>\n  let n = $state(0);\n</script>\n\n<main>\n  <h1>${esc(title)}</h1>\n  <p>${hello(rtl).lead}</p>\n  <button onclick={() => n++}>${hello(rtl).count}: {n}</button>\n</main>\n`,
      'src/style.css': css(rtl),
    }),
  },
  astro: {
    label: 'Astro',
    framework: 'astro',
    kind: 'static',
    publish: 'dist',
    note: 'Multi-page static site. To publish in a sub-folder, set `base` in astro.config.mjs to that folder.',
    files: (title, rtl) => ({
      'package.json': json({ name: slug(title), private: true, version: '0.0.0', type: 'module', scripts: { dev: 'astro dev', build: 'astro build', preview: 'astro preview' }, dependencies: { astro: '^5.0.0' } }),
      'astro.config.mjs': `import { defineConfig } from 'astro/config';\n\nexport default defineConfig({});\n`,
      'src/pages/index.astro': `---\nconst title = ${JSON.stringify(title)};\n---\n<html lang="${rtl ? 'fa' : 'en'}" dir="${rtl ? 'rtl' : 'ltr'}">\n  <head>\n    <meta charset="utf-8" />\n    <meta name="viewport" content="width=device-width" />\n    <title>{title}</title>\n    <style is:global>${css(rtl).replace(/\n/g, ' ')}</style>\n  </head>\n  <body>\n    <main>\n      <h1>{title}</h1>\n      <p>${hello(rtl).lead}</p>\n    </main>\n  </body>\n</html>\n`,
    }),
  },
  'next-export': {
    label: 'Next.js (static export)',
    framework: 'next-export',
    kind: 'static',
    publish: 'out',
    note: 'Static export only (no server rendering). To publish in a sub-folder, set `basePath` in next.config.mjs.',
    files: (title, rtl) => ({
      'package.json': json({ name: slug(title), private: true, version: '0.0.0', scripts: { dev: 'next dev', build: 'next build' }, dependencies: { next: '^15.0.0', react: '^19.0.0', 'react-dom': '^19.0.0' } }),
      'next.config.mjs': `/** @type {import('next').NextConfig} */\nconst config = { output: 'export', trailingSlash: true, images: { unoptimized: true } };\n\nexport default config;\n`,
      'app/layout.jsx': `import './globals.css';\n\nexport const metadata = { title: ${JSON.stringify(title)} };\n\nexport default function RootLayout({ children }) {\n  return (\n    <html lang="${rtl ? 'fa' : 'en'}" dir="${rtl ? 'rtl' : 'ltr'}">\n      <body>{children}</body>\n    </html>\n  );\n}\n`,
      'app/page.jsx': `export default function Page() {\n  return (\n    <main>\n      <h1>${esc(title)}</h1>\n      <p>${hello(rtl).lead}</p>\n    </main>\n  );\n}\n`,
      'app/globals.css': css(rtl),
    }),
  },
};
