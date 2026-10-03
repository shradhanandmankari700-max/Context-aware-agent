import { config } from "dotenv";
import path from "node:path";

export function loadBackendEnvironment(): void {
  const invocationDirectory = process.env.INIT_CWD ?? process.cwd();
  config({ path: path.resolve(invocationDirectory, ".env") });
  config({ path: path.resolve(process.cwd(), "..", ".env") });
  config();
}
