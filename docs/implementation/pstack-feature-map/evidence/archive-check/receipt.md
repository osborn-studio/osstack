# Independent raw archive verification

Status: **passed**. All **789** manifest members were checked against the tar stream and original scratch: **660 regular files**, **125 directories**, **4 symlinks**, **5,239,883 regular-file bytes**.

Compared exact membership (no duplicates/missing/extras), type, mode, file size/SHA-256 and symlink target/target-byte size. Symlinks were never dereferenced. Tar directory/link payload sizes are zero; original directory stat sizes are filesystem metadata. Symlink sizes in the manifest match original lstat and target-byte length, while tar header sizes remain zero.

Archive SHA-256: `ae8ff3fbaf43af9f40f31f90939f3cb76c76ebc5c59e06b8688589d82f631c2d`
Manifest SHA-256: `024c4ea062da9b635712470cded1d3bf7f3239938e0bc41da1866a9cc373990b`

The archive/manifest hashes remained unchanged after verification; original tree type/mode/size/identity/mtime/ctime/link-target snapshots remained unchanged. Detailed checks are in member-checks.json and the machine receipt is receipt.json; verify-archive.py is retained for reproduction.

This checks byte/member consistency, not producer authenticity or the truth of every underlying test claim. No extraction, product, model, old packet, live test, or shared-file modification was performed. This report lives outside the frozen source tree.
