# AI site builder (M5)

Studio → **AI site builder**. You describe the site; the AI proposes; **you approve every step**. The server enforces the order, so neither the model nor a script can publish something nobody looked at.

```
brief → sitemap → design → pages → images → SEO → checks → publish
        (each step ends in "waiting for you": approve, ask for changes, or edit by hand)
```

| Step | The AI does | Code does | You do |
|---|---|---|---|
| Sitemap | proposes pages, purposes, section ideas, SEO titles and descriptions (JSON, validated; one retry with the reason if invalid) | slug rules, reserved names, limits | edit the JSON by hand, ask for changes, approve |
| Design | picks palette, fonts (system stacks only), radius, width | checks WCAG contrast (text 4.5:1) and re-asks if it fails; generates `style.css` from the tokens | same |
| Pages | writes the content of `<main>` for one page at a time, in the site's language | adds head, SEO tags, skip link, navigation (`aria-current`), footer, `lang`/`dir` (RTL for Persian/Arabic); rejects `<script>`, `<iframe>`, inline handlers, bad links, missing alt, wrong image names | preview each page (sandboxed frame), rewrite with feedback, edit the HTML, approve page by page |
| Images | writes alt text and a prompt for each picture | draws palette-based SVG placeholders, writes `images.json` | replace the files in `images/` with real pictures (same names) |
| SEO | — | canonical, Open Graph, JSON-LD, `sitemap.xml`, `robots.txt` (with a public address) | approve |
| Checks | — | audit: titles/descriptions, one `<h1>`, heading order, alt text, broken links and anchors, contrast, labels, language, viewport, placeholders left in, external scripts; **errors block publishing** | fix (rewrite pages with feedback), approve |
| Publish | — | the normal release deploy with rollback | choose host and folder |

Re-running an earlier step sends the later ones back to review. The AI never invents facts on purpose: unknown details become visible `[placeholders]` that the audit lists.

Where it runs: your description and the generated text go to the AI provider you chose in the AI assistant page (ChatGPT, Claude, Gemini, DeepSeek, OpenRouter, Ollama, any OpenAI-compatible URL); keys stay on this computer. The result is a plain static site in a normal project folder (`.wpm-builder/` holds the pipeline state and is never published).

Limits: the output is a multi-page static site with a shared stylesheet, no JavaScript framework. Real image generation is not built in; the placeholders and prompts are the hook for it. Quality depends on the model; a stronger model writes better pages.
