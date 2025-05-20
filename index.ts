import express from "express";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";
import axios from "axios";
import cors from "cors";

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const PORT = 3001;

app.use(cors());

// Timeframes
const clients = new Map<WebSocket, { timeframe: "1m" | "3m" | "5m" | "15m" | "30m" | "1h" }>();

// Last timeframe data
const coinStateByTimeframe: Record<string, any> = {
  "1m": {},
  "3m": {},
  "5m": {},
  "15m": {},
  "30m": {},
  "1h": {},
};

async function getUSDTTradingPairs(): Promise<string[]> {
  const response = await axios.get(
    "https://api.binance.com/api/v3/exchangeInfo",
  );
  const allSymbols = response.data.symbols;
  const usdtPairs = allSymbols
    .filter((s: any) => s.symbol.endsWith("USDT") && s.status === "TRADING")
    .map((s: any) => s.symbol.toLowerCase());

  const { data: tickers } = await axios.get(
    "https://fapi.binance.com/fapi/v1/ticker/24hr",
  );

  // Only 24 volume > 7Millions
  const filteredTickers = tickers
    .filter(
      (t: any) =>
        usdtPairs.includes(t.symbol.toLowerCase()) &&
        parseFloat(t.quoteVolume) > 7_000_000,
    )
    .map((t: any) => t.symbol.toLowerCase());

  return filteredTickers;
}

let volume24hMap: Record<string, number> = {};

async function updateVolumes(symbols: string[]) {
  try {
    const results: any = await Promise.all(
        symbols.map((s) =>
            axios
                .get(
                    `https://fapi.binance.com/fapi/v1/ticker/24hr?symbol=${s.toUpperCase()}`,
                )
                .then((res) => res.data)
                .catch(() => null),
        ),
    );

    volume24hMap = {};
    for (const r of results) {
      if (r && r.symbol && r.quoteVolume) {
        volume24hMap[r.symbol.toUpperCase()] = parseFloat(r.quoteVolume);
      }
    }
  } catch (e) {
    console.error("Volume update error:", e);
  }
}


async function startBinanceWS(timeframe: "1m" | "3m" | "5m" | "15m" | "30m" | "1h") {
  const symbols = await getUSDTTradingPairs();

  await updateVolumes(symbols);
  setInterval(() => updateVolumes(symbols), 60_000);

  console.log(
    `✅ Tracking ${symbols.length} USDT pairs with timeframe ${timeframe}`,
  );

  const streams = symbols.map((s) => `${s}@kline_${timeframe}`).join("/");
  const ws = new WebSocket(
    `wss://stream.binance.com:9443/stream?streams=${streams}`,
  );

  ws.on("message", (data) => {
    try {
      const parsed = JSON.parse(data.toString());
      if (!parsed.data || !parsed.data.k) return;

      const k = parsed.data.k;
      const symbol = parsed.data.s;

      const open = parseFloat(k.o);
      const close = parseFloat(k.c);
      const change = ((close - open) / open) * 100;

      const result = {
        symbol,
        open,
        close,
        volume24h: volume24hMap[symbol] || 0,
        change: +change.toFixed(2),
        isHot: Math.abs(change) >= 1.5,
        direction: change > 0 ? "up" : "down",
      };

      coinStateByTimeframe[timeframe][symbol] = result;

      // Send data to all subscribed on timeframe clients
      wss.clients.forEach((client) => {
        if (
          client.readyState === WebSocket.OPEN &&
          clients.get(client)?.timeframe === timeframe
        ) {
          client.send(JSON.stringify([result]));
        }
      });
    } catch (e) {
      console.error("WS message handling error:", e);
    }
  });

  ws.on("error", (err) => {
    console.error(`Binance WS error (${timeframe}):`, err.message);
  });

  ws.on("close", () => {
    console.log(`Binance WS closed (${timeframe})`);
  });

  return ws;
}

let ws1m: WebSocket | null = null;
let ws3m: WebSocket | null = null;
let ws5m: WebSocket | null = null;
let ws15m: WebSocket | null = null;
let ws30m: WebSocket | null = null;
let ws1h: WebSocket | null = null;

startBinanceWS("1m").then((ws) => (ws1m = ws));
startBinanceWS("3m").then((ws) => (ws3m = ws));
startBinanceWS("5m").then((ws) => (ws5m = ws));
startBinanceWS("15m").then((ws) => (ws15m = ws));
startBinanceWS("30m").then((ws) => (ws30m = ws));
startBinanceWS("1h").then((ws) => (ws1h = ws));

wss.on("connection", (ws) => {
  console.log("Client connected");

  // Default 1m timeframe
  clients.set(ws, { timeframe: "1m" });

  const initialData = Object.values(coinStateByTimeframe["1m"]);
  if (initialData.length) {
    ws.send(JSON.stringify(initialData));
  }

  ws.on("message", (message) => {
    try {
      const data = JSON.parse(message.toString());
      if (
        data.action === "setTimeframe" &&
        ["1m", "3m", "5m", "15m", "30m", "1h"].includes(data.timeframe)
      ) {
        console.log(`Client requested timeframe change to ${data.timeframe}`);
        clients.set(ws, { timeframe: data.timeframe });

        const currentData = Object.values(coinStateByTimeframe[data.timeframe]);
        if (currentData.length) {
          ws.send(JSON.stringify(currentData));
        }
      }
    } catch (e) {
      console.error("Error processing client message:", e);
    }
  });

  ws.on("close", () => {
    console.log("Client disconnected");
    clients.delete(ws);
  });
});

server.listen(PORT, () => {
  console.log(`🚀 Server + WebSocket listening on http://localhost:${PORT}`);
});
