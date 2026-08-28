signalk-plotterext-bus 0.11.0, vendored as static browser assets (no npm
dependency, no build tooling — same policy as vendor/leaflet). Fetched via
`npm pack signalk-plotterext-bus@0.11.0`, dist files only:

- extension.js (the /extension entry, re-exports the client)
- chunk-7XRFPDQL.js (ExtensionClient + connectExtension)
- chunk-4W6N34SD.js (bus protocol core: envelope, JSON-RPC, wildcard events)
- LICENSE (MIT, Copyright (c) 2026 Joel Kozikowski)

Only the extension side is vendored; the host side runs inside the chart
plotter (Freeboard-SK), not here. The documented wire format is the contract —
see freeboard-sk docs/api/plotter-extensions-api.md.
