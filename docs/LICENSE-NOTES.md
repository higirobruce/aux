# License notes

Per `docs/implementation.html` §15.1, the repo uses a split license.

| Path                            | License           | Why                                                                 |
| ------------------------------- | ----------------- | ------------------------------------------------------------------- |
| `apps/*`                        | MIT               | Low friction for contributors; the app shell is not a business moat |
| `packages/design-system`        | MIT               | Reusable; we *want* others to take the tokens                       |
| `packages/ui`                   | MIT               | shadcn-installed components carry MIT upstream                      |
| `packages/audio-engine`         | MIT               | Host code; the proprietary value is in the DSP, not the host        |
| `packages/session-doc`          | MIT               | Schema is a documented contract                                     |
| `packages/db`                   | MIT               | Schema; not the moat                                                |
| `packages/shared`               | MIT               | Utilities                                                           |
| `packages/plugins/*`            | **AGPL-3.0-only** | Keeps the DSP open and resistant to closed forks                    |
| `docs/*`                        | CC BY 4.0         | Brainstorm + implementation; share with attribution                 |

> **Note:** explicit `LICENSE` files inside each package will be added once the
> entity is incorporated and the IP-assignment is in place (Month 0 — see
> `docs/implementation.html` §15.1).
