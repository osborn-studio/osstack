# Skills And Agent Registry

## Purpose

The registry makes execution choices explicit. Agents expose capabilities, auth modes, roles, and availability so routing can be explained later in reports and proof packs.

## Roles

- coding
- test-verify
- reviewer
- designer
- product/planning
- release/proof

## User-Facing Commands

- `osstack agent list`
- `osstack agent scorecard`
- `osstack config doctor`
- `osstack skills list`
- `osstack skills check`

## Product Rule

Every routed run should be explainable as: capability requested, candidates considered, selected agent, auth mode, role fit, and reason.

