# osb-project

Project initialization and context tools for OSBORN-style AI-assisted development.

## Commands

### osb-init

Initialize a project skeleton:

```bash
osb-init --type webapp --complexity standard
```

Generated project loop:

```text
docs → architecture → tasks → code → review → verify → test/build/deploy → changelog
```

## Later Phases

* osb-context: generate .agent/PROJECT_CONTEXT.md
* integration with ds-review
* integration with ds-verify
