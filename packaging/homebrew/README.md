# Homebrew formula template

`Formula/local-ci.rb.template` is the formula source for a Homebrew tap release.
During release, replace:

- `{{VERSION}}` with the package version without the leading `v`
- `{{MACOS_ARM64_SHA256}}` with the checksum from `local-ci-v<version>-macos-arm64.tar.gz.sha256`
- `{{MACOS_X64_SHA256}}` with the checksum from `local-ci-v<version>-macos-x64.tar.gz.sha256`

The formula installs the native `local-ci` binary into `bin` and includes a smoke test that runs `local-ci --help`.
