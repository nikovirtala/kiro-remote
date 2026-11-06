import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Load a JSON fixture from test/fixtures by file name. */
export function loadFixture<T = unknown>(name: string): T {
  const url = new URL(`./fixtures/${name}`, import.meta.url);
  return JSON.parse(readFileSync(fileURLToPath(url), "utf8")) as T;
}
