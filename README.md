# Verbal Morality Ledger

> *"This is a violation of the Verbal Morality Statute."* — Demolition Man, 1993

A real-time swear jar for the blockchain age. Built for hackathons and parties — connect your XRPL wallet, deposit 5 XRP into the enforcement vault, and every time the microphone catches you swearing, 0.1 XRP is automatically fined and donated to **[Tourette Scotland](https://www.tourettescotland.org)** (SC021851) on the XRPL Testnet.

No manual approvals. No escape. Just consequence.

---

## How it works

1. **Connect** your XRPL wallet via Xaman
2. **Deposit** 5 XRP into the communal enforcement vault
3. **Talk** — the mic listens for swear words in English and French
4. **Get fined** — 0.1 XRP auto-deducted per infraction, logged on-chain
5. **Compete** — live leaderboard ranks players by violation count

Every fine triggers the Verbal Morality Statute audio from Demolition Man and opens an accusation modal so the group can agree on who said it.

---

## Tech stack

- **Frontend** — Vanilla JS, Web Speech API, single-page HTML
- **Backend** — Node.js, Express
- **Wallet auth** — [xrpl-connect](https://github.com/nice-xrpl/xrpl-connect) (Xaman / Crossmark / GemWallet)
- **Blockchain** — XRPL Testnet via [xrpl.js](https://github.com/XRPLF/xrpl.js)
- **Deployed on** — Vercel

---

## Setup

```bash
npm install
cp .env.example .env
# Fill in your XAMAN_API_KEY, XAMAN_API_SECRET, HOT_WALLET_SEED, CHARITY_ADDRESS
node server.js
```

For HTTPS locally (required for Web Speech API on some browsers):
```bash
openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -days 365 -nodes
```

---

## Environment variables

| Variable | Description |
|---|---|
| `XAMAN_API_KEY` | Xaman developer app key |
| `XAMAN_API_SECRET` | Xaman developer app secret |
| `HOT_WALLET_SEED` | XRPL hot wallet seed (holds the vault funds) |
| `CHARITY_ADDRESS` | XRPL address that receives the fines |

---

Built at [XRPL Commons](https://xrpl-commons.org) · XRPL Testnet only · Have a nice day
