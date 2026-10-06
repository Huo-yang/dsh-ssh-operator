# Testing

The canonical check is:

```powershell
pnpm run check
```

It validates documentation links, TypeScript sources, the inherited SSH unit suite, DSH bundle metadata, and both production bundles.

Real-host integration is intentionally not part of the default check because it requires a configured SSH alias and can modify a dedicated test directory. After installation, perform a passive smoke test first with `ssh_list_hosts`, `ssh_doctor`, and `ssh_probe`. Do not use transfer or process tools against an unknown host or path.
