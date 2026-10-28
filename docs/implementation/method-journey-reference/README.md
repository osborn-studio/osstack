# Exported skills-check journey reference

This slice connects the existing fixed two-case journey to the shared OSStack verification materials. It adds one concrete reference and links it from creation, maintenance and the feature-map template. It does not change the driver, runtime, exported entry names or host permissions.

The reference uses the actual target checkout and the wrapper's output-only interface. It separates healthy product exit 0 and expected missing-ref product exit 1 from driver exit 0. It describes failed evidence, scratch ownership and the limit of direct-child cleanup. Full audit records can contain fixture environment fields; this slice does not invent a filtered projection command.

Original sources are pinned to pstack commit `99b609a72323b70204eab407c622f436e858e112`:

- [Create verification, lines 25–40](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/create-verification-skill/SKILL.md#L25-L40): concrete launch/doctor/drive/evidence/cleanup instructions, a feature map, and actual proof before handoff.
- [Maintain verification, lines 25–35](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/maintain-verification-skill/SKILL.md#L25-L35): source coverage, actual driving, retained failed attempts and separate product/harness/document findings.

The baseline is `42dbdb0a8cf3be68bb41b7ac6e57990cb0cb092f`. Focused tests exercise the real exporter for both host layouts, follow links from all four entries, compare copied bytes and manifest hashes, reject a missing advertised journey, and feed the documented command arguments to the real wrapper parser. These are material and interface checks, not proof that a model selected or followed the method. Actual target execution is recorded separately from those checks.
