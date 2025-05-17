import WebSocket, { WebSocketServer } from "ws";
import axios from "axios";

type DensityUpdate = {
  symbol: string;
  percent: number;
  maxDensity: number;
  isHighDensity: boolean;
  price: number;
  volume24h: number;
  priceChange: number;
  side: string;
  timesMore: number;
};

const wss = new WebSocketServer({ port: 3001 });
const clients = new Set<WebSocket>();

wss.on("connection", (ws) => {
  console.log("Client connected");
  clients.add(ws);
  ws.on("close", () => clients.delete(ws));
});

async function getGrowingUsdtSymbols(): Promise<string[]> {
  const { data: exchangeInfo } = await axios.get(
    "https://fapi.binance.com/fapi/v1/exchangeInfo",
  );
  const usdtSymbols = exchangeInfo.symbols
    .filter(
      (s: any) => s.contractType === "PERPETUAL" && s.symbol.endsWith("USDT"),
    )
    .map((s: any) => s.symbol.toLowerCase());

  const { data: tickers } = await axios.get(
    "https://fapi.binance.com/fapi/v1/ticker/24hr",
  );

  // Hide if 24 volume less than 7Millions
  const filteredTickers = tickers
    .filter(
      (t: any) =>
        usdtSymbols.includes(t.symbol.toLowerCase()) &&
        parseFloat(t.quoteVolume) > 7_000_000,
    )
    .map((t: any) => t.symbol.toLowerCase());

  return filteredTickers;
}

let volume24hMap: Record<string, number> = {};
let priceChangePercent24hMap: Record<string, number> = {};

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
        priceChangePercent24hMap[r.symbol.toUpperCase()] = parseFloat(
          r.priceChangePercent,
        );
      }
    }
  } catch (e) {
    console.error("Volume update error:", e);
  }
}

function subscribeToBooks(
  symbols: string[],
  onDensityUpdate: (data: DensityUpdate) => void,
) {
  const streams = symbols.map((s) => `${s}@depth20@500ms`).join("/");
  const url = `wss://fstream.binance.com/stream?streams=${streams}`;

  const ws = new WebSocket(url);
  const maxDensityMap: Record<string, number> = {};

  ws.on("open", () => console.log("Book WS connected"));
  ws.on("close", () => console.log("Book WS closed"));
  ws.on("error", (err) => console.error("Book WS error:", err));

  ws.on("message", (msg) => {
    try {
      const parsed = JSON.parse(msg.toString());
      if (!parsed.data) return;

      const stream = parsed.stream;
      const symbol = stream.split("@")[0].toUpperCase();

      const bids: [string, string][] = parsed.data.b;
      const asks: [string, string][] = parsed.data.a;

      if ((!bids || bids.length === 0) && (!asks || asks.length === 0)) return;

      const bidDensities = bids.map(([price, qty]) => {
        const p = parseFloat(price);
        const q = parseFloat(qty);
        return { density: p * q, price: p, side: "bid" };
      });

      const askDensities = asks.map(([price, qty]) => {
        const p = parseFloat(price);
        const q = parseFloat(qty);
        return { density: p * q, price: p, side: "ask" };
      });

      const allDensities = [...bidDensities, ...askDensities];
      const maxEntry = allDensities.reduce(
        (max, cur) => (cur.density > max.density ? cur : max),
        { density: 0, price: 0, side: "bid" },
      );

      const MEDIUM = 25_000_000;
      const BIG = 50_000_000;

      const BIG_COEFFICIENT = 0.0007;
      const MEDIUM_COEFFICIENT = 0.0005;
      const LOW_COEFFICIENT = 0.02;

      const COEF = volume24hMap[symbol] > 50000000 ? 0.0007 : 0.002; // 0.07% for bib coins and 0.2% for other

        // const COEF =
        // volume24hMap[symbol] > BIG
        //   ? BIG_COEFFICIENT
        //   : volume24hMap[symbol] > MEDIUM
        //     ? MEDIUM_COEFFICIENT
        //     : LOW_COEFFICIENT;

      const isHighDensity =
        maxEntry.density > (volume24hMap[symbol] || 0) * COEF; // 0.5%
      const timesMore = maxEntry.density / ((volume24hMap[symbol] || 0) * COEF);

      maxDensityMap[symbol] = Math.max(
        maxDensityMap[symbol] || 0,
        maxEntry.density,
      );
      const percent = maxDensityMap[symbol]
        ? maxEntry.density / maxDensityMap[symbol]
        : 0;

      if (isHighDensity) {
        onDensityUpdate({
          symbol,
          percent,
          maxDensity: maxEntry.density,
          isHighDensity,
          price: maxEntry.price,
          volume24h: volume24hMap[symbol] || 0,
          priceChange: priceChangePercent24hMap[symbol] || 0,
          side: maxEntry.side, // 'bid' или 'ask'
          timesMore: isHighDensity ? +timesMore.toFixed(1) : 0,
        });
      }
    } catch (e) {
      console.error("Parse error:", e);
    }
  });
}

(async () => {
  const symbols = await getGrowingUsdtSymbols();

  await updateVolumes(symbols);
  setInterval(() => updateVolumes(symbols), 60_000);

  subscribeToBooks(symbols, (densityData) => {
    const json = JSON.stringify(densityData);
    clients.forEach((ws) => ws.readyState === WebSocket.OPEN && ws.send(json));
  });
})();
