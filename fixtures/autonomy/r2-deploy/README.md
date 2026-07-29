# R2 deploy soak fixture

These executables model staging, production, health, and rollback locally. They
refuse to run unless `OSSTACK_SOAK_FIXTURE_ONLY=1` and
`OSSTACK_SOAK_FIXTURE_STATE` points to an explicit JSON state file.

They do not open sockets, invoke a shell, or contact GitHub or any deployment
target. They exist only for the deterministic autonomy soak test.
