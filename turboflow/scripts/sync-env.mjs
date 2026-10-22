// Copy the env files for one project into the places the tools read them.
//
//   node scripts/sync-env.mjs <project>
//
// <project> is a Firebase project id or alias: turboflow-test, test,
// turboflow-7b3ca, prod, or demo-turboflow (the emulator suite).
//
//   env/firebase/config.<set>.js  -> turboflow/public/firebase-config.js
//   env/functions/<project>.env   -> turboflow/functions/.env.<project>   (firebase-tools' deploy convention)
//   env/functions/local.env       -> turboflow/functions/.env.local       (emulator dev secrets)
//
// The targets are generated and gitignored; the sources in env/ are the only
// files to edit. Run automatically by npm run dev / build / emulate.
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", ".."); // repo root
const turbo = join(root, "turboflow");
const env = join(root, "env");

const WEB = {
  "turboflow-test": "test",
  test: "test",
  "demo-turboflow": "test", // the emulator: the app rewrites projectId to demo-turboflow on localhost
  "turboflow-7b3ca": "prod",
  prod: "prod",
};

const project = process.argv[2] ?? "turboflow-test";
const webSet = WEB[project];
if (!webSet) {
  console.error(`sync-env: unknown project "${project}" (known: ${Object.keys(WEB).join(", ")})`);
  process.exit(2);
}

// 1. the web config the page loads
const srcCfg = join(env, "firebase", `config.${webSet}.js`);
if (!existsSync(srcCfg)) {
  console.error(`sync-env: missing ${srcCfg}`);
  process.exit(2);
}
const dstCfg = join(turbo, "public", "firebase-config.js");
mkdirSync(dirname(dstCfg), { recursive: true });
copyFileSync(srcCfg, dstCfg);
console.log(`sync-env: env/firebase/config.${webSet}.js -> turboflow/public/firebase-config.js`);

// 2. this project's functions env (firebase-tools reads functions/.env.<project>)
const srcEnv = join(env, "functions", `${project}.env`);
const dstEnv = join(turbo, "functions", `.env.${project}`);
if (existsSync(srcEnv)) {
  copyFileSync(srcEnv, dstEnv);
  console.log(`sync-env: env/functions/${project}.env -> turboflow/functions/.env.${project}`);
} else if (existsSync(dstEnv)) {
  rmSync(dstEnv);
  console.log(`sync-env: no env/functions/${project}.env, removed turboflow/functions/.env.${project}`);
}

// 3. local dev secrets, for the emulator
const srcLocal = join(env, "functions", "local.env");
const dstLocal = join(turbo, "functions", ".env.local");
if (existsSync(srcLocal)) {
  copyFileSync(srcLocal, dstLocal);
  console.log("sync-env: env/functions/local.env -> turboflow/functions/.env.local");
}
