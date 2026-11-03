# Source of protocol.json

`protocol.json` is a pinned copy of the obs-websocket protocol description.

| Item | Value |
| --- | --- |
| Project | obs-websocket, https://github.com/obsproject/obs-websocket |
| Tag | 5.7.6 |
| Commit | e28f84975984340e84fc4879cfc05741cc0afde1 |
| File | `docs/generated/protocol.json` |
| SHA-256 | 042e8c42da2dfd6d78fa0f695b2b59495d8254d5fe718b0f20d0e2e6f58a6993 |
| Licence | GPL-2.0, as part of obs-websocket. This file is data that describes the protocol. |

To check a newer protocol, run `node scripts/catalogue.mjs --check <path to protocol.json>`. It fails on each request with no row in `catalogue/classes.json`.
