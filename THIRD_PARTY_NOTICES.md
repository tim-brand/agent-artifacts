# Third-party notices

Agent Artifacts is released under the MIT license (see `LICENSE`). This file lists what this repository and its Docker image include from others, with the notices their licenses require.

## Open Artifacts

The look of the web UI follows the "Studio" design of [Open Artifacts](https://github.com/open-artifacts-ai/open-artifacts) and uses its design tokens, in light and dark. The code in this repository is otherwise this project's own. The tokens are in `src/ui/static/app.css`.

Open Artifacts is licensed under the MIT license:

```
MIT License

Copyright (c) 2026 Open Artifacts contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Geist and Geist Mono

The fonts in `src/ui/static/fonts/` are Geist and Geist Mono, licensed under the SIL Open Font License, Version 1.1.

> Copyright (c) 2023 Vercel, in collaboration with basement.studio

The full license text is in `src/ui/static/fonts/OFL.txt`.

## Runtime dependencies

These are the packages listed under `dependencies` in `package.json`. They are installed into the Docker image. The license of each is the `license` field in its `package.json`.

| Package                     | License      | Project                               |
| --------------------------- | ------------ | ------------------------------------- |
| `@hono/node-server`         | MIT          | https://github.com/honojs/node-server |
| `@modelcontextprotocol/sdk` | MIT          | https://modelcontextprotocol.io       |
| `diff`                      | BSD-3-Clause | https://github.com/kpdecker/jsdiff    |
| `highlight.js`              | BSD-3-Clause | https://highlightjs.org/              |
| `hono`                      | MIT          | https://hono.dev                      |
| `marked`                    | MIT          | https://marked.js.org                 |
| `zod`                       | MIT          | https://zod.dev                       |

These packages pull in others. To list every package installed for production, with its license, run `pnpm licenses list --prod`.
