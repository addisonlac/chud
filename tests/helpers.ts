import { openDb } from "../src/db/db.js";
import { Repo } from "../src/db/repo.js";
import { SettingsStore, type Settings } from "../src/config/settings.js";

export function memRepo(): Repo {
  return new Repo(openDb(":memory:"));
}

export function testSettings(overrides: Partial<Settings> = {}): Settings {
  const repo = memRepo();
  const s = new SettingsStore(repo).get();
  return {
    ...s,
    groqApiKey: "",
    senderName: "Sam Rivera",
    senderCompany: "Rivera Studio",
    senderAddress: "1 Main St, Austin, TX 78701",
    senderProof: "Last month we took a candle store from 1.1% to 2.4% conversion in 6 weeks.",
    smtpHost: "smtp.test",
    smtpUser: "sam@rivera.studio",
    smtpPass: "x",
    fromEmail: "sam@rivera.studio",
    sendWindow: "00-24",
    dailyCap: 30,
    followupDays: [3, 4],
    ...overrides,
  };
}
