# @aux/plugins

Native DSP plugins. Rust → WASM via `wasm-pack`.

This workspace is a placeholder until Rust is installed and the first plugin
(EQ-8) is implemented. Per `docs/implementation.html` §07, the v1 suite is:

| Plugin           | Type                                 | Status     |
| ---------------- | ------------------------------------ | ---------- |
| EQ-8             | 8-band dynamic + linear-phase EQ     | Must ship  |
| Comp-Clean       | VCA-style compressor                 | Must ship  |
| Comp-Color       | FET-style compressor                 | Must ship  |
| DeEss            | De-esser (split-band)                | Must ship  |
| MB-Comp          | Multiband compressor                 | Must ship  |
| Plate            | Plate reverb                         | Must ship  |
| Hall             | Hall reverb                          | Must ship  |
| Tape             | Tape saturation                      | Must ship  |
| Console          | Console saturation                   | Must ship  |
| Transient        | Transient designer                   | Must ship  |
| Limiter          | True-peak limiter                    | Must ship  |
| Imager           | M/S imager                           | Must ship  |

## Getting started (when Rust is installed)

```bash
rustup install stable
cargo install wasm-pack

# from this directory:
cargo new --lib eq-8
# add to [workspace] members in Cargo.toml
wasm-pack build eq-8 --target web
```

## Plugin contract

Every plugin implements the four-function WASM API defined in
`@aux/audio-engine` `PluginModule`:

- `init(sampleRate, maxBlock) -> ptr`
- `process(ptr, input, output, params, nFrames)`
- `setState(ptr, json)`
- `getState(ptr) -> json`
- `getSchema() -> json`
- `latencySamples(ptr) -> samples`

License: AGPL-3.0-only — keeps the DSP open and resistant to closed forks.
