// @ts-check
import { defineConfig } from 'astro/config'
import tailwindcss from '@tailwindcss/vite'

// Static output, no adapter. The site is two pages of HTML plus a handful of
// assets; anything that needs a server at request time would be a claim we
// cannot keep on a host somebody else runs.
export default defineConfig({
  site: 'https://telium.chat',
  output: 'static',
  build: { inlineStylesheets: 'auto' },
  vite: {
    plugins: [tailwindcss()],
    // `global.css` imports the client's palette, motion and focus files
    // directly out of `web/src` rather than keeping a second copy of them.
    // Vite's dev server refuses to read outside the project root unless the
    // repo root is named here; the production build resolves them fine either
    // way, so without this line `bun run dev` and `bun run build` disagree,
    // which is the worst of the three possible outcomes.
    server: { fs: { allow: ['..'] } },
  },
})
