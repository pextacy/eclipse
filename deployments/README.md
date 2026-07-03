# deployments/

`deploy` writes the live Coston2 deployment here as `coston2.json`:

```json
{
  "network": "coston2",
  "chainId": 114,
  "eclipseRegistry": "0x…",
  "eclipseSettlement": "0x…",
  "fxrp": "0x…",
  "usdt0": "0x…",
  "assetManager": "0x…",
  "bandBps": 50,
  "feedId": "0x015852502f55534400000000000000000000000000",
  "deployer": "0x…",
  "blockNumber": 12345678,
  "txHashes": { "registry": "0x…", "settlement": "0x…" }
}
```

- `coston2.json` is **git-ignored** (it's a per-deployment artifact); this README
  and `.gitkeep` are tracked.
- The web app and the `scripts` package read this file to find the deployed
  addresses. The frontend can also be pointed at addresses via `VITE_*` env vars.
- Never commit private keys here — only public addresses and tx hashes.
