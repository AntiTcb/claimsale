/** Writes src/generated from src/templates (see compile.ts). Usage: node scripts/generate.ts */
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compileTemplates, generatedDir } from "./compile.ts";

mkdirSync(generatedDir, { recursive: true });
for (const file of readdirSync(generatedDir)) rmSync(join(generatedDir, file));
const files = compileTemplates();
for (const [name, code] of files) writeFileSync(join(generatedDir, name), code);
console.log(`Wrote ${files.size} files to src/generated`);
