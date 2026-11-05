export interface ReleaseVersionInputs {
  packageJson: { version?: unknown };
  lockfile: { version?: unknown; packages?: Record<string, { version?: unknown }> };
  tag?: string;
  manifests?: Array<{
    manifest_version?: unknown;
    version?: unknown;
    version_name?: unknown;
  }>;
}

export function verifyReleaseVersions(inputs: ReleaseVersionInputs): string;
export function verifyAnnotatedTag(inputs: { cwd: string; tag?: string; commit?: string }): string;
export function main(args?: string[], cwd?: string): Promise<void>;
