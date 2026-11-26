#!/usr/bin/env node
// Install wizard: checks prerequisites, writes .env and starts Budget Crew.
// Zero dependencies, so it runs from a fresh clone: `node scripts/install.mjs` (`--yes` takes every default).
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const envPath = join(root, ".env");
const args = new Set(process.argv.slice(2));
const auto = args.has("--yes") || args.has("-y") || !process.stdin.isTTY;
const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (text) => color ? `\x1b[${code}m${text}\x1b[0m` : text;
const bold = paint(1), dim = paint(2), red = paint(31), green = paint(32), cyan = paint(36);

if (args.has("--help") || args.has("-h")) {
  console.log(`Usage: node scripts/install.mjs [--yes]

Walks through setup and starts Budget Crew:
  Docker mode   app + Centrifugo in containers, http://localhost:3000 (recommended)
  Node mode     API and Vite dev server on this machine, Centrifugo in Docker

--yes  non-interactive: Docker mode, offline stub crew, keep an existing .env`);
  process.exit(0);
}

const rl = auto ? null : createInterface({ input: process.stdin, output: process.stdout });
let step = 0;
const heading = (title) => console.log(`\n${cyan(`[${++step}]`)} ${bold(title)}`);
const ok = (text) => console.log(`  ${green("✓")} ${text}`);
const note = (text) => console.log(`  ${dim(text)}`);

function fail(message, hint) {
  console.error(`\n${red("✗")} ${message}`);
  if (hint) console.error(`  ${hint}`);
  rl?.close();
  process.exit(1);
}

// Ctrl+C rejects a pending question; leave quietly instead of printing a stack trace.
function aborted(error) {
  if (error?.code !== "ABORT_ERR") throw error;
  process.stderr.write("\nAborted.\n");
  process.exit(130);
}

async function ask(question, fallback = "") {
  if (!rl) return fallback;
  const answer = (await rl.question(`  ${question}${fallback ? dim(` [${fallback}]`) : ""}: `).catch(aborted)).trim();
  return answer || fallback;
}

async function choose(question, options, fallback = 1) {
  if (!rl) return fallback;
  console.log(`  ${question}`);
  options.forEach((option, index) => console.log(`    ${index + 1}) ${option}`));
  for (;;) {
    const answer = Number(await ask("Choose", String(fallback)));
    if (Number.isInteger(answer) && answer >= 1 && answer <= options.length) return answer;
  }
}

async function confirm(question, fallback) {
  const answer = (await ask(`${question} (y/n)`, fallback ? "y" : "n")).toLowerCase();
  return answer.startsWith("y");
}

// Typed characters are not echoed: API keys stay off the screen and out of scrollback.
async function secret(question) {
  if (!rl) return "";
  const answer = rl.question(`  ${question}: `); // prints the prompt synchronously
  const write = process.stdout.write;
  process.stdout.write = () => true;
  try {
    return (await answer.catch(aborted)).trim();
  } finally {
    process.stdout.write = write;
    process.stdout.write("\n");
  }
}

function run(command, commandArgs, options = {}) {
  return spawnSync(command, commandArgs, { cwd: root, encoding: "utf8", ...options });
}

function has(command, commandArgs = ["--version"]) {
  const result = run(command, commandArgs, { stdio: "pipe" });
  return result.status === 0 ? result.stdout.trim() : null;
}

function exec(command, commandArgs, env) {
  console.log(`  ${dim("$")} ${command} ${commandArgs.join(" ")}`);
  const result = run(command, commandArgs, { stdio: "inherit", env: { ...process.env, ...env } });
  if (result.status !== 0) fail(`\`${command} ${commandArgs.join(" ")}\` failed (exit ${result.status ?? result.signal}).`, "Fix the error above and run the wizard again.");
}

function portFree(port) {
  return new Promise((resolve) => {
    const server = createServer().once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

async function freePort(preferred) {
  for (let port = preferred; port < preferred + 50; port++) if (await portFree(port)) return port;
  fail(`No free port near ${preferred}.`);
}

async function waitForHealth(url, seconds) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
    } catch { /* not listening yet */ }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return null;
}

function readEnv() {
  if (!existsSync(envPath)) return null;
  const values = {};
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (match) values[match[1]] = match[2].replace(/^(["'])(.*)\1$/, "$2");
  }
  return values;
}

console.log(bold("\nBudget Crew install wizard"));
note("Synthetic data only. Re-run any time; Ctrl+C aborts without changes until .env is written.");

// 1. Prerequisites
heading("Checking prerequisites");
const nodeMajor = Number(process.versions.node.split(".")[0]);
const dockerVersion = has("docker", ["--version"]);
const composeVersion = dockerVersion && has("docker", ["compose", "version", "--short"]);
const dockerRunning = composeVersion && run("docker", ["info"], { stdio: "pipe" }).status === 0;
const pnpmVersion = has("pnpm");
const hostReady = nodeMajor >= 24 && (pnpmVersion || has("corepack"));
console.log(`  Node ${process.versions.node} ${nodeMajor >= 24 ? green("✓") : dim("(Node mode needs 24+)")}`);
console.log(`  Docker ${dockerVersion ? `${composeVersion ? `compose ${composeVersion}` : red("without the compose plugin")}${dockerRunning ? ` ${green("✓")}` : composeVersion ? ` ${red("daemon not reachable")}` : ""}` : red("not found")}`);
console.log(`  pnpm ${pnpmVersion ?? dim(has("corepack") ? "not found, corepack will provide it" : "not found")}`);
if (!dockerRunning) {
  fail("Docker with Compose v2 is required (Centrifugo runs in a container in both modes).",
    "Install Docker Desktop or Docker Engine (https://docs.docker.com/get-docker/), start it and retry.");
}

// 2. Mode
heading("How to run");
const mode = await choose("Where should Budget Crew run?", [
  `Docker: app and Centrifugo in containers ${dim("(recommended, nothing else to install)")}`,
  `Node: API and Vite dev server on this machine, Centrifugo in Docker ${dim("(for development; Node 24 + pnpm)")}`,
]) === 1 ? "docker" : "node";
if (mode === "node" && !hostReady) fail("Node mode needs Node 24+ and pnpm (or corepack).", "Install them or choose Docker mode.");
ok(mode === "docker" ? "Docker mode" : "Node mode");

// 3. Configuration
heading("Configuration (.env)");
const existing = readEnv();
let env = existing;
if (existing && await confirm(".env already exists. Keep it?", true)) {
  ok("Keeping the existing .env");
} else {
  const inference = await choose("Which crew should answer?", [
    `Offline stub ${dim("(deterministic answers, no key, no network)")}`,
    `Live OpenAI models ${dim("(gpt-6-luna, gpt-6.2-sol, gpt-6.1-terra; needs an API key)")}`,
  ]) === 1 ? "stub" : "live";
  env = { INFERENCE: inference, OPENAI_API_KEY: "", OPENAI_BASE_URL: "", MOZAIK_API_KEY: "", MOZAIK_PROJECT_ID: "" };
  if (inference === "live") {
    while (!env.OPENAI_API_KEY) env.OPENAI_API_KEY = await secret("OPENAI_API_KEY (input hidden)");
    env.OPENAI_BASE_URL = await ask(`OpenAI-compatible base URL ${dim("(empty = api.openai.com)")}`);
    if (env.OPENAI_BASE_URL && !URL.canParse(env.OPENAI_BASE_URL)) fail(`Not a URL: ${env.OPENAI_BASE_URL}`);
    if (await confirm("Send agent loops to Mozaik cloud telemetry?", false)) {
      env.MOZAIK_API_KEY = await secret("MOZAIK_API_KEY (input hidden)");
      env.MOZAIK_PROJECT_ID = await ask("MOZAIK_PROJECT_ID");
    }
  }
  env.CENTRIFUGO_API_KEY = randomBytes(24).toString("hex");
}

if (mode === "docker" && env.OPENAI_BASE_URL) {
  const url = new URL(env.OPENAI_BASE_URL);
  if (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    url.hostname = "host.docker.internal";
    env.OPENAI_BASE_URL = url.href.replace(/\/$/, "");
    note(`Containers cannot reach the host's localhost; using ${env.OPENAI_BASE_URL}`);
  }
}

// A previous run of this stack holds its own ports; stop it before checking what is free.
if (run("docker", ["compose", "ps", "-q"], { stdio: "pipe" }).stdout.trim()) {
  note("Stopping the previous Budget Crew containers");
  exec("docker", ["compose", "down"]);
}
// Ports: the browser port, the API port (Node mode) and Centrifugo's host port.
const appPort = Number(env.APP_PORT ?? 3000);
const centrifugoPort = Number(env.CENTRIFUGO_PORT ?? 8000);
env.APP_PORT = String(mode === "docker" && !(await portFree(appPort)) ? await freePort(appPort + 1) : appPort);
env.PORT = String(mode === "node" ? (await portFree(Number(env.PORT ?? 3000)) ? Number(env.PORT ?? 3000) : await freePort(3001)) : (env.PORT ?? 3000));
env.CENTRIFUGO_PORT = String(await portFree(centrifugoPort) ? centrifugoPort : await freePort(centrifugoPort + 1));
env.CENTRIFUGO_API_URL = `http://127.0.0.1:${env.CENTRIFUGO_PORT}/api`;
env.CENTRIFUGO_API_KEY ||= randomBytes(24).toString("hex");

const keys = ["INFERENCE", "OPENAI_API_KEY", "OPENAI_BASE_URL", "MOZAIK_API_KEY", "MOZAIK_PROJECT_ID",
  "CENTRIFUGO_API_KEY", "CENTRIFUGO_API_URL", "CENTRIFUGO_PORT", "APP_PORT", "PORT"];
const extra = Object.keys(env).filter((key) => !keys.includes(key));
writeFileSync(envPath, [
  "# Written by scripts/install.mjs. Never commit this file.",
  ...[...keys, ...extra].map((key) => `${key}=${env[key] ?? ""}`),
  "",
].join("\n"), { mode: 0o600 });
ok(`.env written: INFERENCE=${env.INFERENCE ?? "stub"}, Centrifugo on 127.0.0.1:${env.CENTRIFUGO_PORT}`);

// 4. Start
heading(mode === "docker" ? "Building and starting containers (first run takes a few minutes)" : "Installing, building and starting");
if (mode === "docker") {
  exec("docker", ["compose", "up", "-d", "--build", "--wait"]);
  const url = `http://localhost:${env.APP_PORT}`;
  const health = await waitForHealth(`${url}/api/health`, 60);
  if (!health) fail(`${url}/api/health did not answer.`, "Inspect `docker compose logs app proxy`.");
  ok(`Healthy: version ${health.version}, inference ${health.inference}`);
  console.log(`\n${bold("Budget Crew is running:")} ${cyan(`${url}/app`)}  ${dim(`(landing page ${url})`)}`);
  console.log(dim("  Logs: docker compose logs -f app   Stop: docker compose down   Reconfigure: node scripts/install.mjs\n"));
  rl?.close();
} else {
  const pnpm = pnpmVersion ? ["pnpm", []] : ["corepack", ["pnpm"]];
  const pnpmRun = (pnpmArgs) => exec(pnpm[0], [...pnpm[1], ...pnpmArgs]);
  pnpmRun(["install", "--frozen-lockfile"]);
  pnpmRun(["build"]);
  exec("docker", ["compose", "up", "-d", "--wait", "centrifugo"]);
  if (!(await portFree(5173))) fail("Port 5173 (Vite) is busy.", "Free it and run the wizard again.");
  rl?.close();
  const children = [
    spawn(pnpm[0], [...pnpm[1], "start"], { cwd: root, stdio: "inherit" }),
    spawn(pnpm[0], [...pnpm[1], "dev"], { cwd: root, stdio: "inherit", env: { ...process.env, PORT: env.PORT, CENTRIFUGO_PORT: env.CENTRIFUGO_PORT } }),
  ];
  const stop = () => { for (const child of children) child.kill("SIGTERM"); };
  process.on("SIGINT", stop).on("SIGTERM", stop);
  for (const child of children) child.on("exit", (code) => { if (code) { stop(); process.exitCode = code; } });
  const health = await waitForHealth(`http://127.0.0.1:${env.PORT}/api/health`, 60);
  if (!health) { stop(); fail("The API did not become healthy.", "See its output above."); }
  console.log(`\n${bold("Budget Crew is running:")} ${cyan("http://localhost:5173/app")}  ${dim(`(inference ${health.inference})`)}`);
  console.log(dim("  Ctrl+C stops the API and Vite; `docker compose down` stops Centrifugo.\n"));
}
