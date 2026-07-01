# Changelog

## Unreleased

### Changed (breaking: transaction naming output)

- `CoralogixTransactionSampler` now resolves the **full** route template for
  prefix-mounted (`app.use('/api', router)`) and arbitrarily nested Express routers.
  Previously such routes had the mount prefix dropped (e.g. `/users/:id`) or failed to
  resolve at all (falling back to the bare span name). They now resolve with the full
  prefix (e.g. `GET /api/deep/orders/:oid`).

  This changes the emitted transaction names for affected applications. Dashboards,
  alerts, and saved views keyed on the previous names must be updated. The TypeScript
  public API is unchanged.
