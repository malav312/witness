#!/usr/bin/env node
// Runs the TypeScript CLI through tsx so there's no build step in phase 1.
import { register } from "tsx/esm/api";
register();
await import("../src/cli.ts");
