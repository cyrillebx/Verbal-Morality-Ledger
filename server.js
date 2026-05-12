import express from "express";
import cors from "cors";
import { Xumm } from "xumm";
import { Client, Wallet } from "xrpl";
import { createServer } from "http";
import { Server } from "socket.io";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: "*" } });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const xumm = new Xumm(process.env.XAMAN_API_KEY, process.env.XAMAN_API_SECRET);
const CHARITY = process.env.CHARITY_ADDRESS || "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh";
const XRPL_WS = "wss://s.altnet.rippletest.net:51233";
const DEPOSIT_AMOUNT = "5000000"; // 5 XRP in drops
const FINE_AMOUNT = 100000; // 0.1 XRP in drops

// Hot wallet (server-controlled)
let hotWallet = null;
let xrplClient = null;

async function initHotWallet() {
  try {
    xrplClient = new Client(XRPL_WS);
    await xrplClient.connect();
    hotWallet = Wallet.fromSeed(process.env.HOT_WALLET_SEED);
    const bal = await xrplClient.getXrpBalance(hotWallet.address);
    console.log("Hot wallet:", hotWallet.address, "Balance:", bal, "XRP");
  } catch (e) {
    console.error("Hot wallet init failed:", e.message);
  }
}
initHotWallet();

// Keep XRPL connection alive
setInterval(async () => {
  if (!xrplClient?.isConnected()) {
    try { await xrplClient.connect(); } catch(e) {}
  }
}, 30000);

// Sessions: address -> { username, balance (drops), swearCount, depositTx }
const sessions = new Map();
const sseClients = new Map();

// ── PING ─────────────────────────────────────────────────
app.get("/api/ping", async (req, res) => {
  try {
    const pong = await xumm.ping();
    res.json({ ok: true, app: pong.application.name });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── SIGN IN ───────────────────────────────────────────────
app.post("/api/signin", async (req, res) => {
  try {
    let created;
    const payload = await xumm.payload.createAndSubscribe(
      { TransactionType: "SignIn" },
      (event) => {
        const clients = sseClients.get(created?.uuid);
        if (!clients) return;
        if ("opened" in event.data) {
          clients.forEach(c => c.write(`data: ${JSON.stringify({ type: "opened" })}

`));
        }
        if ("signed" in event.data) {
          clients.forEach(c => c.write(`data: ${JSON.stringify({ type: "resolved", signed: event.data.signed })}

`));
          return event;
        }
      }
    );
    created = payload.created;
    res.json({ uuid: payload.created.uuid, qr: payload.created.refs.qr_png, deeplink: payload.created.next.always });
    payload.resolved.then(async (result) => {
      if (!result) return;
      const clients = sseClients.get(payload.created.uuid);
      if (!clients) return;
      const detail = await xumm.payload.get(payload.created.uuid);
      const address = detail?.response?.account;
      clients.forEach(c => {
        c.write(`data: ${JSON.stringify({ type: "signed", address, signed: result.signed })}

`);
        c.end();
      });
      sseClients.delete(payload.created.uuid);
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── SET USERNAME ──────────────────────────────────────────
app.post("/api/username", (req, res) => {
  const { address, username } = req.body;
  if (!address || !username) return res.status(400).json({ error: "Missing fields" });
  const taken = [...sessions.values()].some(s => s.username.toLowerCase() === username.toLowerCase());
  if (taken) return res.status(400).json({ error: "Username taken" });
  if (!sessions.has(address)) {
    sessions.set(address, { username, balance: 0, swearCount: 0, depositTx: null });
  } else {
    sessions.get(address).username = username;
  }
  broadcastLeaderboard();
  res.json({ ok: true });
});

// ── DEPOSIT ───────────────────────────────────────────────
// Creates a Xaman payment payload for user to deposit 5 XRP to hot wallet
app.post("/api/deposit", async (req, res) => {
  const { address } = req.body;
  if (!address) return res.status(400).json({ error: "Missing address" });
  if (!hotWallet) return res.status(500).json({ error: "Hot wallet not ready" });

  try {
    let created;
    const payload = await xumm.payload.createAndSubscribe({
      txjson: {
        TransactionType: "Payment",
        Destination: hotWallet.address,
        Amount: DEPOSIT_AMOUNT,
        Memos: [{ Memo: { MemoData: Buffer.from(`VML DEPOSIT: ${address}`, "utf8").toString("hex").toUpperCase() } }],
      },
      options: { force_network: "TESTNET" },
      custom_meta: {
        instruction: "Deposit 5 XRP into the Verbal Morality Ledger vault. Fines will be auto-deducted.",
        blob: { address }
      }
    }, (event) => {
      const clients = sseClients.get(created?.uuid);
      if (!clients) return;
      if ("opened" in event.data) {
        clients.forEach(c => c.write(`data: ${JSON.stringify({ type: "opened" })}

`));
      }
      if ("signed" in event.data) {
        clients.forEach(c => c.write(`data: ${JSON.stringify({ type: "resolved", signed: event.data.signed })}

`));
        return event;
      }
    });
    created = payload.created;
    res.json({ uuid: payload.created.uuid, qr: payload.created.refs.qr_png, deeplink: payload.created.next.always });

    payload.resolved.then(async (result) => {
      if (!result?.signed) return;
      const clients = sseClients.get(payload.created.uuid);
      const detail = await xumm.payload.get(payload.created.uuid);
      const txHash = detail?.response?.txid;

      // Credit user session
      if (!sessions.has(address)) {
        sessions.set(address, { username: address.slice(0,8), balance: 0, swearCount: 0 });
      }
      const session = sessions.get(address);
      session.balance += parseInt(DEPOSIT_AMOUNT);
      session.depositTx = txHash;

      if (clients) {
        clients.forEach(c => {
          c.write(`data: ${JSON.stringify({ type: "deposited", balance: session.balance, txHash })}

`);
          c.end();
        });
        sseClients.delete(payload.created.uuid);
      }
      broadcastLeaderboard();
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── FINE ──────────────────────────────────────────────────
// Auto-deduct 0.1 XRP from user vault, send to charity
app.post("/api/fine", async (req, res) => {
  const { address, word } = req.body;
  if (!address || !word) return res.status(400).json({ error: "Missing fields" });

  const session = sessions.get(address);
  if (!session) return res.status(404).json({ error: "User not found" });
  if (session.balance < FINE_AMOUNT) return res.status(400).json({ error: "Insufficient vault balance" });
  if (!hotWallet || !xrplClient) return res.status(500).json({ error: "Hot wallet not ready" });

  try {
    // Deduct from session balance immediately
    session.balance -= FINE_AMOUNT;
    session.swearCount += 1;

    // Fire transaction from hot wallet to charity
    const tx = {
      TransactionType: "Payment",
      Account: hotWallet.address,
      Destination: CHARITY,
      Amount: String(FINE_AMOUNT),
      Memos: [{ Memo: { MemoData: Buffer.from(`VML FINE [${session.username}]: ${word}`, "utf8").toString("hex").toUpperCase() } }],
    };
    const prepared = await xrplClient.autofill(tx);
    const signed = hotWallet.sign(prepared);
    const result = await xrplClient.submitAndWait(signed.tx_blob);
    const txHash = result.result.hash;

    broadcastLeaderboard();
    res.json({ ok: true, txHash, balance: session.balance, swearCount: session.swearCount });
  } catch (e) {
    // Refund balance on failure
    session.balance += FINE_AMOUNT;
    session.swearCount -= 1;
    res.status(500).json({ error: e.message });
  }
});

// ── WITHDRAW ──────────────────────────────────────────────
// Return remaining balance to user via Xaman
app.post("/api/withdraw", async (req, res) => {
  const { address } = req.body;
  const session = sessions.get(address);
  if (!session) return res.status(404).json({ error: "User not found" });
  if (session.balance < 1000000) return res.status(400).json({ error: "Balance too low to withdraw (min 1 XRP for fees)" });

  try {
    const withdrawAmount = session.balance - 100000; // keep 0.1 for fee
    const tx = {
      TransactionType: "Payment",
      Account: hotWallet.address,
      Destination: address,
      Amount: String(withdrawAmount),
    };
    const prepared = await xrplClient.autofill(tx);
    const signed = hotWallet.sign(prepared);
    const result = await xrplClient.submitAndWait(signed.tx_blob);
    session.balance = 0;
    sessions.delete(address);
    broadcastLeaderboard();
    res.json({ ok: true, txHash: result.result.hash, returned: withdrawAmount });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── LEADERBOARD ───────────────────────────────────────────

app.post("/api/deposit-confirm", (req, res) => {
  const { address, txHash } = req.body;
  console.log("deposit-confirm:", address);
  if (!address) return res.status(400).json({ error: "Missing address" });
  if (!sessions.has(address)) {
    sessions.set(address, { username: address.slice(0,8), balance: 0, swearCount: 0 });
  }
  const session = sessions.get(address);
  session.balance += parseInt(DEPOSIT_AMOUNT);
  session.depositTx = txHash;
  broadcastLeaderboard();
  res.json({ ok: true, balance: session.balance });
});

app.post("/api/fine-by-username", async (req, res) => {
  const { username, word } = req.body;
  const entry = [...sessions.entries()].find(([,s]) => s.username === username);
  if (!entry) return res.status(404).json({ error: "User not found" });
  const [address, session] = entry;
  if (session.balance < FINE_AMOUNT) return res.status(400).json({ error: "Insufficient vault balance" });
  if (!hotWallet || !xrplClient) return res.status(500).json({ error: "Hot wallet not ready" });
  try {
    session.balance -= FINE_AMOUNT;
    session.swearCount += 1;
    const tx = {
      TransactionType: "Payment",
      Account: hotWallet.address,
      Destination: CHARITY,
      Amount: String(FINE_AMOUNT),
      Memos: [{ Memo: { MemoData: Buffer.from("VML:" + username + ":" + word, "utf8").toString("hex").toUpperCase() } }],
    };
    const prepared = await xrplClient.autofill(tx);
    const signed = hotWallet.sign(prepared);
    const result = await xrplClient.submitAndWait(signed.tx_blob);
    broadcastLeaderboard();
    res.json({ ok: true, txHash: result.result.hash, balance: session.balance });
  } catch(e) {
    session.balance += FINE_AMOUNT;
    session.swearCount -= 1;
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/leaderboard", (req, res) => {
  res.json(getLeaderboard());
});

function getLeaderboard() {
  return [...sessions.entries()]
    .map(([address, s]) => ({
      username: s.username,
      swearCount: s.swearCount,
      balance: s.balance,
      address: address.slice(0,8) + "..."
    }))
    .sort((a, b) => b.swearCount - a.swearCount);
}

function broadcastLeaderboard() {
  io.emit("leaderboard", getLeaderboard());
}

// ── SSE ───────────────────────────────────────────────────
app.get("/api/subscribe/:uuid", (req, res) => {
  const { uuid } = req.params;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();
  if (!sseClients.has(uuid)) sseClients.set(uuid, new Set());
  sseClients.get(uuid).add(res);
  const hb = setInterval(() => res.write(": heartbeat\n\n"), 20000);
  req.on("close", () => {
    clearInterval(hb);
    const clients = sseClients.get(uuid);
    if (clients) { clients.delete(res); if (clients.size === 0) sseClients.delete(uuid); }
  });
});

// ── PAYLOAD GET ───────────────────────────────────────────
app.get("/api/payload/:uuid", async (req, res) => {
  try {
    const detail = await xumm.payload.get(req.params.uuid);
    res.json(detail);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── BALANCE ───────────────────────────────────────────────
app.get("/api/balance/:address", async (req, res) => {
  try {
    if (!xrplClient?.isConnected()) await xrplClient.connect();
    const bal = await xrplClient.getXrpBalance(req.params.address);
    res.json({ balance: parseFloat(bal).toFixed(2) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── SESSION INFO ──────────────────────────────────────────
app.get("/api/session/:address", (req, res) => {
  const session = sessions.get(req.params.address);
  if (!session) return res.status(404).json({ error: "Not found" });
  res.json({ ...session, address: req.params.address });
});

// ── SOCKET.IO ─────────────────────────────────────────────
io.on("connection", (socket) => {
  socket.emit("leaderboard", getLeaderboard());
  socket.on("disconnect", () => {});
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => console.log(`VML server running on :${PORT}`));
