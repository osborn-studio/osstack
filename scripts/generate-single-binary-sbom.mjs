#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

const args = process.argv.slice(2);
const manifestPath = requiredFlag("--manifest");
const json = args.includes("--json");

const manifest = JSON.parse(await readFile(manifestPath, "utf-8"));
const binaryPath = manifest.binary?.path;
const checksumPath = manifest.checksum_path;
if (typeof binaryPath !== "string" || binaryPath.length === 0) {
  throw new Error("manifest.binary.path is required");
}
if (typeof checksumPath !== "string" || checksumPath.length === 0) {
  throw new Error("manifest.checksum_path is required");
}

const releaseDir = dirname(manifestPath);
const binaryName = manifest.binary?.name ?? basename(binaryPath);
const sbomPath = join(releaseDir, `${binaryName}.sbom.spdx.json`);
const binarySha256 = await sha256File(binaryPath);
const manifestSha256 = await sha256File(manifestPath);
const checksumSha256 = await sha256File(checksumPath);
const binaryStat = await stat(binaryPath);

const sbom = {
  spdxVersion: "SPDX-2.3",
  dataLicense: "CC0-1.0",
  SPDXID: "SPDXRef-DOCUMENT",
  name: `osstack-single-binary-${manifest.version}-${manifest.platform}-${manifest.arch}`,
  documentNamespace: `https://github.com/gilosbornhello/osstack/sbom/${randomUUID()}`,
  creationInfo: {
    created: new Date().toISOString(),
    creators: ["Tool: osstack generate-single-binary-sbom"],
  },
  packages: [
    {
      name: manifest.package ?? "@osstack/cli",
      SPDXID: "SPDXRef-Package-osstack-cli",
      versionInfo: manifest.version,
      downloadLocation: "NOASSERTION",
      filesAnalyzed: false,
      licenseConcluded: "MIT",
      licenseDeclared: "MIT",
      copyrightText: "NOASSERTION",
    },
  ],
  files: [
    {
      fileName: binaryName,
      SPDXID: "SPDXRef-File-osstack-binary",
      checksums: [{ algorithm: "SHA256", checksumValue: binarySha256 }],
      fileTypes: ["BINARY"],
      licenseConcluded: "NOASSERTION",
      copyrightText: "NOASSERTION",
      comment: `size_bytes=${binaryStat.size}; signed=${manifest.signing?.signed === true}; notarized=${manifest.signing?.notarized === true}`,
    },
    {
      fileName: basename(manifestPath),
      SPDXID: "SPDXRef-File-release-manifest",
      checksums: [{ algorithm: "SHA256", checksumValue: manifestSha256 }],
      fileTypes: ["TEXT"],
      licenseConcluded: "NOASSERTION",
      copyrightText: "NOASSERTION",
    },
    {
      fileName: basename(checksumPath),
      SPDXID: "SPDXRef-File-sha256sums",
      checksums: [{ algorithm: "SHA256", checksumValue: checksumSha256 }],
      fileTypes: ["TEXT"],
      licenseConcluded: "NOASSERTION",
      copyrightText: "NOASSERTION",
    },
  ],
  relationships: [
    {
      spdxElementId: "SPDXRef-Package-osstack-cli",
      relationshipType: "GENERATES",
      relatedSpdxElement: "SPDXRef-File-osstack-binary",
    },
    {
      spdxElementId: "SPDXRef-DOCUMENT",
      relationshipType: "DESCRIBES",
      relatedSpdxElement: "SPDXRef-Package-osstack-cli",
    },
  ],
};
await writeFile(sbomPath, `${JSON.stringify(sbom, null, 2)}\n`);

const summary = {
  ok: true,
  sbom_path: sbomPath,
  format: "SPDX-2.3",
  package: manifest.package ?? "@osstack/cli",
  version: manifest.version,
  binary_name: binaryName,
  binary_sha256: binarySha256,
  file_count: sbom.files.length,
};

if (json) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log(`sbom=${sbomPath}`);
  console.log(`format=${summary.format}`);
  console.log(`binary_sha256=${binarySha256}`);
}

async function sha256File(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function requiredFlag(name) {
  const value = flagValue(name);
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function flagValue(name) {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  return args[index + 1];
}
