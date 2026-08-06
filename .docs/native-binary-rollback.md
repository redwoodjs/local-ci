# Native binary rollback

The npm launcher (`packages/cli/src/native-launcher.ts`) keeps using the TypeScript CLI by default until Rust workflow execution reaches full parity. Native execution can be tested explicitly with:

```bash
LOCAL_CI_FORCE_RUST=1 local-ci --help
```

If a native binary needs to be bypassed explicitly, set one of these environment variables:

```bash
LOCAL_CI_FORCE_TYPESCRIPT=1 local-ci run --all
# or
LOCAL_CI_FORCE_TS=1 local-ci run --all
```

This keeps `npx run-local-ci` usable while native parity is validated. Remove the variable to return to the default TypeScript path, or set `LOCAL_CI_FORCE_RUST=1` to test the native path.
