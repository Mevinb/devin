# Six-state React/Vite fixture

The expected seeded states are Home, Product Catalog, Order Checkout, the VIP
promotion dialog, Contact details, and Check your details (invalid form input).
The offline agent should reach all six from ordinary controls within 30 steps.
The mobile navigation collapses behind a menu so desktop replay needs recovery.
All forms are local and never send data or make purchases.

Deliberate defects: `#productBeta` has a negative margin causing overlap, and
`#orderTable` has a fixed 750px width causing mobile overflow. The overlap rule
lives in `src/styles.css`; the table uses `src/orders.module.scss` with a Sass
variable and a generated CSS-module class. The Vite dev server exposes their
authored source lines through CSS source maps.

```bash
pnpm build
pnpm pixelsentinel explore fixtures/flows --devices chromium:desktop-1080p,chromium:desktop-1440p,android:pixel-8 --mock-agent --no-vision --max-steps 30 --max-states 6 --fail-on none
pnpm pixelsentinel scan fixtures/flows --start 'pnpm exec vite --host 127.0.0.1 --port {port}' --port 0 --explore --max-steps 30 --mock-agent --no-vision --propose-fixes --fail-on none
```

Static scans use the generated `dist/` directory; development scans use `--start`.
The previous static NovaStore fixture is retained in `fixtures/flows-legacy`.
