# Paper Sniper

Paper-trading bot za pump.fun lansiranja. **Lažni novac**: bez privatnog ključa, bez pravih transakcija.

- 6 strategija trguje jedna protiv druge, po 50€ svaka, sa realnim fee-jevima i kašnjenjem od ~2s.
- `Nasumični` je kontrolna grupa. Strategija koja ne pobedi nasumično kupovanje imala je sreću.
- Narativ radar prati reči iz imena tokena koji su upravo prešli 45 SOL.
- Zaštita kapitala: posle 4 gubitka zaredom pauza 15 min, na −30% strategija se gasi.

Dashboard uživo: https://paper-sniper-lukascalezzz-2182.vercel.app

Lokalno: `node server.js` (Node 22+, bez paketa), pa http://localhost:4173.
Cloud: GitHub Actions (`.github/workflows/bot.yml`), smene od ~5h45m, stanje se prenosi kroz Actions keš.
