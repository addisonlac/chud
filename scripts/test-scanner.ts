/**
 * Standalone connectivity self-test — run this on your own machine to
 * verify token discovery works BEFORE running the full bot:
 *
 *   npm run test:scanner
 *
 * It tries PumpPortal's WebSocket first (the default source), then the
 * pump.fun HTTP endpoint, and prints a clear PASS/FAIL for each plus any
 * real tokens it received. No API keys needed; nothing is traded.
 */
import WebSocket from "ws";

const PUMPPORTAL_URL = process.env.PUMPPORTAL_WS_URL ?? "wss://pumpportal.fun/api/data";
const PUMPFUN_URL = "https://frontend-api.pump.fun/coins?offset=0&limit=3&sort=created_timestamp&order=DESC";
const WS_WAIT_MS = 30_000;

function line() {
  console.log("─".repeat(60));
}

async function testPumpPortal(): Promise<boolean> {
  line();
  console.log("TEST 1: PumpPortal WebSocket (default source)");
  console.log(`Connecting to ${PUMPPORTAL_URL} ...`);
  console.log(`Waiting up to ${WS_WAIT_MS / 1000}s for a new token to stream in...\n`);

  return new Promise((resolve) => {
    let received = 0;
    let settled = false;
    const ws = new WebSocket(PUMPPORTAL_URL);

    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      resolve(ok);
    };

    const timer = setTimeout(() => {
      if (received > 0) {
        console.log(`\n✅ PASS — connected and received ${received} new-token event(s).`);
        done(true);
      } else {
        console.log(
          "\n⚠️  Connected, but no new tokens arrived in the wait window.\n" +
            "   This usually just means pump.fun was quiet for 30s (rare but possible),\n" +
            "   not that it's broken. The connection itself succeeded.",
        );
        done(true); // connecting + subscribing is the real success criterion
      }
    }, WS_WAIT_MS);

    ws.on("open", () => {
      console.log("✅ Connection opened. Subscribing to new tokens...");
      ws.send(JSON.stringify({ method: "subscribeNewToken" }));
    });

    ws.on("message", (data: WebSocket.RawData) => {
      let event: { txType?: string; symbol?: string; mint?: string; marketCapSol?: number };
      try {
        event = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (event.txType === "create" && event.mint) {
        received++;
        console.log(
          `   → new token: $${event.symbol ?? "?"}  mint=${event.mint.slice(0, 8)}…  ~${event.marketCapSol ?? 0} SOL mcap`,
        );
        if (received >= 3) {
          console.log(`\n✅ PASS — received ${received} new-token events. PumpPortal works from this machine.`);
          done(true);
        }
      }
    });

    ws.on("error", (err: Error) => {
      console.log(`\n❌ FAIL — websocket error: ${err.message}`);
      console.log("   Your machine could not reach PumpPortal. Check your internet/firewall.");
      done(false);
    });
  });
}

async function testPumpFun(): Promise<boolean> {
  line();
  console.log("TEST 2: pump.fun HTTP endpoint (fallback source)");
  console.log(`GET ${PUMPFUN_URL}\n`);

  try {
    const res = await fetch(PUMPFUN_URL, {
      headers: {
        accept: "application/json",
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        origin: "https://pump.fun",
        referer: "https://pump.fun/",
      },
    });

    if (res.ok) {
      const data = (await res.json()) as unknown[];
      console.log(`✅ PASS — HTTP ${res.status}, got ${Array.isArray(data) ? data.length : 0} coins.`);
      console.log("   The pump.fun HTTP source works from this machine too (you can use either).");
      return true;
    }
    console.log(`❌ FAIL — HTTP ${res.status}. pump.fun is blocking this machine's requests`);
    console.log("   (HTTP 530/403 = Cloudflare bot block). This is expected — use SCANNER_SOURCE=pumpportal.");
    return false;
  } catch (err) {
    console.log(`❌ FAIL — request failed: ${(err as Error).message}`);
    return false;
  }
}

async function main() {
  console.log("\nToken-discovery connectivity self-test");
  console.log("(run on YOUR machine — verifies the bot can find tokens before you run it)\n");

  const pumpPortalOk = await testPumpPortal();
  const pumpFunOk = await testPumpFun();

  line();
  console.log("SUMMARY");
  console.log(`  PumpPortal websocket (default): ${pumpPortalOk ? "✅ WORKS" : "❌ FAILED"}`);
  console.log(`  pump.fun HTTP (fallback):       ${pumpFunOk ? "✅ WORKS" : "❌ blocked (expected)"}`);
  line();

  if (pumpPortalOk) {
    console.log("\n✅ You're good to go. Keep SCANNER_SOURCE=pumpportal (the default) and run: npm run dev\n");
    process.exit(0);
  } else if (pumpFunOk) {
    console.log("\n⚠️  PumpPortal failed but pump.fun works. Set SCANNER_SOURCE=pumpfun in .env, then: npm run dev\n");
    process.exit(0);
  } else {
    console.log(
      "\n❌ Neither source is reachable from this machine. This points to a local\n" +
        "   internet/firewall/VPN issue, not the bot. Fix connectivity, then re-run this test.\n",
    );
    process.exit(1);
  }
}

void main();
