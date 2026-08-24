import { realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { applicationError } from "../../application/errors.ts";
import type { PathCanonicalizer } from "../../application/service.ts";

export class SystemPathCanonicalizer implements PathCanonicalizer {
  constructor(private readonly cwd: () => string = () => process.cwd()) {}

  canonicalizeRoot(value: string): string {
    if (!value) {
      throw applicationError("VALIDATION_ERROR", "Root path is required.", { field: "root", reason: "required" });
    }
    try {
      const root = realpathSync(resolve(this.cwd(), value));
      if (!statSync(root).isDirectory()) throw new Error("Root is not a directory.");
      return root;
    } catch {
      throw applicationError("VALIDATION_ERROR", "Root must be an existing directory.", { field: "root", reason: "must_be_existing_directory" });
    }
  }
}
